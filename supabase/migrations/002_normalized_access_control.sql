-- Additive normalization of the iSchool B2G access-control data.
-- The legacy public.documents table is intentionally preserved.

alter table public.app_profiles
  add column if not exists must_change_password boolean not null default false,
  add column if not exists temporary_password_set_at timestamptz,
  add column if not exists temporary_password_set_by uuid references auth.users(id) on delete set null,
  add column if not exists password_changed_at timestamptz;

create table if not exists public.departments (
  id text primary key,
  name text not null unique,
  source_created_at timestamptz,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.directory_users (
  id text primary key,
  name text not null,
  email text not null,
  primary_role text,
  status text not null default 'Active',
  department text references public.departments(name) on update cascade,
  user_type text,
  team_lead boolean not null default false,
  dept_head boolean not null default false,
  home_org text,
  org_count integer not null default 0,
  last_activity timestamptz,
  source_created_at timestamptz,
  deleted boolean not null default false,
  deleted_at timestamptz,
  deleted_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists directory_users_email_idx on public.directory_users(lower(email));
create index if not exists directory_users_department_idx on public.directory_users(department);

create table if not exists public.roles (
  id text primary key,
  name text not null,
  scope text,
  bound_org text,
  admins_in_b2g integer not null default 0,
  active_admins_in_b2g integer not null default 0,
  admins_total integer not null default 0,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.role_organizations (
  role_id text not null references public.roles(id) on delete cascade,
  organization text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, organization)
);

create table if not exists public.user_role_assignments (
  id text primary key,
  user_id text not null references public.directory_users(id) on delete cascade,
  role_id text not null references public.roles(id),
  organization text not null,
  role_name_snapshot text not null,
  status text not null default 'active',
  added_at timestamptz,
  added_by text,
  removed_at timestamptz,
  removed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists user_role_assignments_user_idx on public.user_role_assignments(user_id);
create index if not exists user_role_assignments_role_idx on public.user_role_assignments(role_id);

create table if not exists public.permission_modules (
  id text primary key,
  name text not null unique,
  in_catalog boolean not null default true,
  archived boolean not null default false,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.permission_catalog_actions (
  module_id text not null references public.permission_modules(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now(),
  primary key (module_id, action)
);

create table if not exists public.role_permissions (
  role_id text not null references public.roles(id) on delete cascade,
  module_id text not null references public.permission_modules(id),
  can_read boolean not null default false,
  can_write boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (role_id, module_id)
);

create table if not exists public.role_permission_actions (
  role_id text not null,
  module_id text not null,
  action text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, module_id, action),
  foreign key (role_id, module_id) references public.role_permissions(role_id, module_id) on delete cascade
);

create table if not exists public.user_permission_overrides (
  user_id text not null references public.directory_users(id) on delete cascade,
  module_id text not null references public.permission_modules(id),
  read_override boolean,
  write_override boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, module_id)
);

create table if not exists public.user_permission_override_actions (
  user_id text not null,
  module_id text not null,
  action text not null,
  mode text not null check (mode in ('grant','revoke')),
  created_at timestamptz not null default now(),
  primary key (user_id, module_id, action, mode),
  foreign key (user_id, module_id) references public.user_permission_overrides(user_id, module_id) on delete cascade
);

create table if not exists public.delegations (
  id text primary key,
  department text not null references public.departments(name) on update cascade,
  user_id text references public.directory_users(id),
  user_name_snapshot text not null,
  user_email_snapshot text,
  scope text not null default 'department',
  granted_by text,
  granted_at timestamptz,
  active boolean not null default true,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists delegations_department_idx on public.delegations(department);

create table if not exists public.audit_log (
  id text primary key,
  timestamp timestamptz not null default now(),
  actor text not null,
  actor_role text,
  action text not null,
  target_user_id text,
  target_user_name text,
  field text,
  old_value jsonb,
  new_value jsonb,
  note text,
  department text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_timestamp_idx on public.audit_log(timestamp desc);
create index if not exists audit_log_department_idx on public.audit_log(department);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'departments','directory_users','roles','user_role_assignments','permission_modules',
    'role_permissions','user_permission_overrides','delegations'
  ] loop
    execute format('drop trigger if exists %I_touch_updated_at on public.%I', table_name, table_name);
    execute format('create trigger %I_touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()', table_name, table_name);
  end loop;
end $$;

create or replace function public.can_access_directory_user(target_user_id text, require_write boolean default false)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.current_profile_role()
    when 'admin' then true
    when 'manager' then exists (
      select 1 from public.directory_users u
      where u.id = target_user_id and u.department = public.current_profile_department()
    )
    when 'viewer' then not require_write and exists (
      select 1 from public.directory_users u
      where u.id = target_user_id and lower(u.email) = lower(coalesce(auth.jwt()->>'email',''))
    )
    else false
  end
$$;

alter table public.departments enable row level security;
alter table public.directory_users enable row level security;
alter table public.roles enable row level security;
alter table public.role_organizations enable row level security;
alter table public.user_role_assignments enable row level security;
alter table public.permission_modules enable row level security;
alter table public.permission_catalog_actions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.role_permission_actions enable row level security;
alter table public.user_permission_overrides enable row level security;
alter table public.user_permission_override_actions enable row level security;
alter table public.delegations enable row level security;
alter table public.audit_log enable row level security;

-- Reference data: every active application account can read; only admins mutate.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'departments','roles','role_organizations','permission_modules',
    'permission_catalog_actions','role_permissions','role_permission_actions'
  ] loop
    execute format('drop policy if exists %I_read on public.%I', table_name, table_name);
    execute format('create policy %I_read on public.%I for select to authenticated using (public.current_profile_role() is not null)', table_name, table_name);
    execute format('drop policy if exists %I_admin_write on public.%I', table_name, table_name);
    execute format('create policy %I_admin_write on public.%I for all to authenticated using (public.current_profile_role() = ''admin'') with check (public.current_profile_role() = ''admin'')', table_name, table_name);
  end loop;
end $$;

drop policy if exists directory_users_read on public.directory_users;
create policy directory_users_read on public.directory_users for select to authenticated using (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and department = public.current_profile_department())
  or (public.current_profile_role() = 'viewer' and lower(email) = lower(coalesce(auth.jwt()->>'email','')))
);
drop policy if exists directory_users_insert on public.directory_users;
create policy directory_users_insert on public.directory_users for insert to authenticated with check (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and department = public.current_profile_department())
);
drop policy if exists directory_users_update on public.directory_users;
create policy directory_users_update on public.directory_users for update to authenticated using (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and department = public.current_profile_department())
) with check (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and department = public.current_profile_department())
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'user_role_assignments','user_permission_overrides','user_permission_override_actions'
  ] loop
    execute format('drop policy if exists %I_read on public.%I', table_name, table_name);
    execute format('create policy %I_read on public.%I for select to authenticated using (public.can_access_directory_user(user_id, false))', table_name, table_name);
    execute format('drop policy if exists %I_write on public.%I', table_name, table_name);
    execute format('create policy %I_write on public.%I for all to authenticated using (public.can_access_directory_user(user_id, true)) with check (public.can_access_directory_user(user_id, true))', table_name, table_name);
  end loop;
end $$;

drop policy if exists delegations_read on public.delegations;
create policy delegations_read on public.delegations for select to authenticated using (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and department = public.current_profile_department())
);
drop policy if exists delegations_admin_write on public.delegations;
create policy delegations_admin_write on public.delegations for all to authenticated
using (public.current_profile_role() = 'admin') with check (public.current_profile_role() = 'admin');

drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log for select to authenticated using (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and department = public.current_profile_department())
);
drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log for insert to authenticated with check (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and department = public.current_profile_department())
);

grant select, insert, update on public.directory_users to authenticated;
grant select on public.departments, public.roles, public.role_organizations, public.permission_modules,
  public.permission_catalog_actions, public.role_permissions, public.role_permission_actions to authenticated;
grant insert, update, delete on public.departments, public.roles, public.role_organizations,
  public.permission_modules, public.permission_catalog_actions, public.role_permissions,
  public.role_permission_actions to authenticated;
grant select, insert, update, delete on public.user_role_assignments,
  public.user_permission_overrides, public.user_permission_override_actions to authenticated;
grant select, insert, update on public.delegations to authenticated;
grant select, insert on public.audit_log to authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'departments','directory_users','roles','role_organizations','user_role_assignments',
    'permission_modules','permission_catalog_actions','role_permissions','role_permission_actions',
    'user_permission_overrides','user_permission_override_actions','delegations','audit_log','app_profiles'
  ] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
