-- iSchool B2G Access Control: Supabase schema and authorization policies
-- Run with `supabase db push`, or paste into the Supabase SQL editor once.

create extension if not exists pgcrypto;

create table if not exists public.app_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null default 'viewer' check (role in ('admin','manager','viewer')),
  department text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.documents (
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

create index if not exists documents_collection_idx on public.documents(collection);
create index if not exists documents_department_idx on public.documents((data->>'department'));
create index if not exists documents_email_idx on public.documents((lower(data->>'email')));

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists documents_touch_updated_at on public.documents;
create trigger documents_touch_updated_at before update on public.documents
for each row execute function public.touch_updated_at();

drop trigger if exists profiles_touch_updated_at on public.app_profiles;
create trigger profiles_touch_updated_at before update on public.app_profiles
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_profiles (id, display_name, role, active)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)), 'viewer', true)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_auth_user();

create or replace function public.current_profile_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.app_profiles where id = auth.uid() and active = true
$$;

create or replace function public.current_profile_department()
returns text language sql stable security definer set search_path = public as $$
  select department from public.app_profiles where id = auth.uid() and active = true
$$;

alter table public.app_profiles enable row level security;
alter table public.documents enable row level security;

drop policy if exists profiles_read_self on public.app_profiles;
create policy profiles_read_self on public.app_profiles for select to authenticated
using (id = auth.uid());

drop policy if exists documents_read on public.documents;
create policy documents_read on public.documents for select to authenticated using (
  public.current_profile_role() = 'admin'
  or (
    public.current_profile_role() = 'manager' and (
      collection in ('roles','departments','permissionsCatalog')
      or (collection = 'users' and data->>'department' = public.current_profile_department())
      or (collection = 'delegations' and data->>'department' = public.current_profile_department())
      or (collection = 'auditLog' and data->>'department' = public.current_profile_department())
    )
  )
  or (
    public.current_profile_role() = 'viewer' and (
      collection in ('roles','departments','permissionsCatalog')
      or (collection = 'users' and lower(data->>'email') = lower(coalesce(auth.jwt()->>'email','')))
    )
  )
);

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated with check (
  public.current_profile_role() = 'admin'
  or (
    public.current_profile_role() = 'manager' and (
      (collection = 'users' and data->>'department' = public.current_profile_department())
      or (collection = 'auditLog' and data->>'department' = public.current_profile_department())
    )
  )
);

drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated
using (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and collection = 'users' and data->>'department' = public.current_profile_department())
)
with check (
  public.current_profile_role() = 'admin'
  or (public.current_profile_role() = 'manager' and collection = 'users' and data->>'department' = public.current_profile_department())
);

drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated
using (public.current_profile_role() = 'admin');

grant select on public.app_profiles to authenticated;
grant select, insert, update, delete on public.documents to authenticated;

-- Realtime powers live updates between open admin sessions.
do $$ begin
  alter publication supabase_realtime add table public.documents;
exception when duplicate_object then null;
end $$;
