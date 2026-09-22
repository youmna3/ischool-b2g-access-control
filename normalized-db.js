(function () {
  const TABLES = {
    users: ['directory_users', 'user_role_assignments', 'user_permission_overrides', 'user_permission_override_actions'],
    roles: ['roles', 'role_organizations', 'role_permissions', 'role_permission_actions', 'permission_modules'],
    departments: ['departments'],
    delegations: ['delegations'],
    auditLog: ['audit_log'],
    permissionsCatalog: ['permission_modules', 'permission_catalog_actions']
  };

  function fail(error) { if (error) throw error; }
  function snapshot(rows) { return { docs: rows.map(row => ({ id: row.id, data: () => row.data })) }; }
  function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || crypto.randomUUID(); }

  async function selectAll(client, table) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await client.from(table).select('*').range(from, from + 999);
      fail(error); rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }

  async function moduleMaps(client) {
    const modules = await selectAll(client, 'permission_modules');
    return {
      byId: new Map(modules.map(module => [module.id, module])),
      byName: new Map(modules.map(module => [module.name, module]))
    };
  }

  class NormalizedDB {
    constructor(client) { this.client = client; this.channels = []; }
    collection(name) { return new NormalizedCollection(this, name); }
    destroy() { this.channels.forEach(channel => this.client.removeChannel(channel)); this.channels = []; }

    async fetch(name) {
      if (name === 'users') return this.fetchUsers();
      if (name === 'roles') return this.fetchRoles();
      if (name === 'departments') return (await selectAll(this.client, 'departments')).filter(row => !row.archived).map(row => ({ id: row.id, data: {
        name: row.name, createdAt: row.source_created_at || row.created_at, archived: row.archived
      }}));
      if (name === 'delegations') return (await selectAll(this.client, 'delegations')).map(row => ({ id: row.id, data: {
        department: row.department, userId: row.user_id, userName: row.user_name_snapshot,
        userEmail: row.user_email_snapshot, scope: row.scope, grantedBy: row.granted_by,
        grantedAt: row.granted_at, active: row.active, revokedAt: row.revoked_at, revokedBy: row.revoked_by
      }}));
      if (name === 'auditLog') return (await selectAll(this.client, 'audit_log')).map(row => ({ id: row.id, data: {
        ts: row.timestamp, actor: row.actor, actorRole: row.actor_role, action: row.action,
        targetUserId: row.target_user_id, targetUserName: row.target_user_name, field: row.field,
        oldValue: row.old_value, newValue: row.new_value, note: row.note, department: row.department
      }}));
      if (name === 'permissionsCatalog') return this.fetchCatalog();
      throw new Error(`Unknown normalized collection: ${name}`);
    }

    async fetchUsers() {
      const [users, assignments, overrides, overrideActions, maps] = await Promise.all([
        selectAll(this.client, 'directory_users'), selectAll(this.client, 'user_role_assignments'),
        selectAll(this.client, 'user_permission_overrides'), selectAll(this.client, 'user_permission_override_actions'),
        moduleMaps(this.client)
      ]);
      const assignmentsByUser = new Map();
      assignments.forEach(row => {
        if (!assignmentsByUser.has(row.user_id)) assignmentsByUser.set(row.user_id, []);
        assignmentsByUser.get(row.user_id).push({
          id: row.id, org: row.organization, roleName: row.role_name_snapshot, roleId: row.role_id,
          status: row.status, addedAt: row.added_at, addedBy: row.added_by,
          removedAt: row.removed_at, removedBy: row.removed_by
        });
      });
      const actionsByOverride = new Map();
      overrideActions.forEach(row => {
        const key = `${row.user_id}\u0000${row.module_id}`;
        if (!actionsByOverride.has(key)) actionsByOverride.set(key, { extra: [], removed: [] });
        actionsByOverride.get(key)[row.mode === 'grant' ? 'extra' : 'removed'].push(row.action);
      });
      const overridesByUser = new Map();
      overrides.forEach(row => {
        const module = maps.byId.get(row.module_id); if (!module) return;
        if (!overridesByUser.has(row.user_id)) overridesByUser.set(row.user_id, {});
        const actions = actionsByOverride.get(`${row.user_id}\u0000${row.module_id}`) || { extra: [], removed: [] };
        const value = { extra: actions.extra, removed: actions.removed };
        if (row.read_override !== null) value.read = row.read_override;
        if (row.write_override !== null) value.write = row.write_override;
        overridesByUser.get(row.user_id)[module.name] = value;
      });
      return users.map(row => ({ id: row.id, data: {
        name: row.name, email: row.email, primaryRole: row.primary_role, status: row.status,
        department: row.department, userType: row.user_type, teamLead: row.team_lead,
        deptHead: row.dept_head, homeOrg: row.home_org, orgCount: row.org_count,
        lastActivity: row.last_activity, createdAt: row.source_created_at,
        deleted: row.deleted, deletedAt: row.deleted_at, deletedBy: row.deleted_by,
        roles: (assignmentsByUser.get(row.id) || []).sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || ''))),
        permOverrides: overridesByUser.get(row.id) || {}
      }}));
    }

    async fetchRoles() {
      const [roles, organizations, permissions, actions, maps] = await Promise.all([
        selectAll(this.client, 'roles'), selectAll(this.client, 'role_organizations'),
        selectAll(this.client, 'role_permissions'), selectAll(this.client, 'role_permission_actions'),
        moduleMaps(this.client)
      ]);
      const orgsByRole = new Map();
      organizations.forEach(row => { if (!orgsByRole.has(row.role_id)) orgsByRole.set(row.role_id, []); orgsByRole.get(row.role_id).push(row.organization); });
      const actionsByPermission = new Map();
      actions.forEach(row => { const key = `${row.role_id}\u0000${row.module_id}`; if (!actionsByPermission.has(key)) actionsByPermission.set(key, []); actionsByPermission.get(key).push(row.action); });
      const permissionsByRole = new Map();
      permissions.forEach(row => {
        const module = maps.byId.get(row.module_id); if (!module) return;
        if (!permissionsByRole.has(row.role_id)) permissionsByRole.set(row.role_id, {});
        permissionsByRole.get(row.role_id)[module.name] = {
          read: row.can_read, write: row.can_write,
          other: actionsByPermission.get(`${row.role_id}\u0000${row.module_id}`) || []
        };
      });
      return roles.map(row => ({ id: row.id, data: {
        name: row.name, scope: row.scope, boundOrg: row.bound_org,
        orgsAssigned: orgsByRole.get(row.id) || [], adminsInB2G: row.admins_in_b2g,
        activeAdminsInB2G: row.active_admins_in_b2g, adminsTotal: row.admins_total,
        createdAt: row.source_created_at || row.created_at,
        updatedAt: row.source_updated_at || row.updated_at, active: row.active,
        permissions: permissionsByRole.get(row.id) || {}
      }}));
    }

    async fetchCatalog() {
      const [modules, actions] = await Promise.all([selectAll(this.client, 'permission_modules'), selectAll(this.client, 'permission_catalog_actions')]);
      const actionsByModule = new Map();
      actions.forEach(row => { if (!actionsByModule.has(row.module_id)) actionsByModule.set(row.module_id, []); actionsByModule.get(row.module_id).push(row.action); });
      return modules.filter(row => row.in_catalog && !row.archived).map(row => ({ id: row.id, data: {
        name: row.name, actions: actionsByModule.get(row.id) || [],
        createdAt: row.source_created_at || row.created_at, updatedAt: row.source_updated_at || row.updated_at
      }}));
    }
  }

  class NormalizedCollection {
    constructor(db, name) { this.db = db; this.name = name; this.max = 1000; this.sort = null; }
    limit(value) { this.max = value; return this; }
    orderBy(field, direction = 'asc') { this.sort = { field, direction }; return this; }
    doc(id) { return new NormalizedDocument(this.db, this.name, id); }
    async add(data) { const id = crypto.randomUUID(); await this.doc(id).set(data); return { id }; }
    async fetch() {
      let rows = await this.db.fetch(this.name);
      if (this.sort) rows.sort((a, b) => String(a.data[this.sort.field] || '').localeCompare(String(b.data[this.sort.field] || '')) * (this.sort.direction === 'desc' ? -1 : 1));
      return snapshot(rows.slice(0, this.max));
    }
    onSnapshot(next, reject) {
      let timer;
      const load = () => { clearTimeout(timer); timer = setTimeout(() => this.fetch().then(next).catch(reject || console.error), 40); };
      load();
      let channel = this.db.client.channel(`normalized:${this.name}:${crypto.randomUUID()}`);
      (TABLES[this.name] || []).forEach(table => { channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, load); });
      channel.subscribe(); this.db.channels.push(channel);
      return () => this.db.client.removeChannel(channel);
    }
  }

  class NormalizedDocument {
    constructor(db, collection, id) { this.db = db; this.collection = collection; this.id = id; }
    async set(data) {
      const client = this.db.client;
      if (this.collection === 'users') {
        const { error } = await client.from('directory_users').upsert({ id: this.id, ...userScalars(data) }); fail(error);
        if (data.roles) await syncUserRoles(client, this.id, data.roles);
        if (data.permOverrides) await syncOverrides(client, this.id, data.permOverrides);
      } else if (this.collection === 'roles') {
        const { error } = await client.from('roles').upsert({ id: this.id, ...roleScalars(data) }); fail(error);
        if (data.orgsAssigned) await syncRoleOrganizations(client, this.id, data.orgsAssigned);
        if (data.permissions) await syncRolePermissions(client, this.id, data.permissions);
      } else if (this.collection === 'departments') {
        const { error } = await client.from('departments').upsert({ id: this.id, name: data.name, source_created_at: data.createdAt || null, archived: !!data.archived }); fail(error);
      } else if (this.collection === 'permissionsCatalog') {
        const { error } = await client.from('permission_modules').upsert({ id: this.id, name: data.name, in_catalog: true, archived: false, source_created_at: data.createdAt || null, source_updated_at: data.updatedAt || null }); fail(error);
        await syncCatalogActions(client, this.id, data.actions || []);
      } else if (this.collection === 'delegations') {
        const { error } = await client.from('delegations').upsert({ id: this.id, ...delegationScalars(data) }); fail(error);
      } else if (this.collection === 'auditLog') {
        const { error } = await client.from('audit_log').upsert({ id: this.id, ...auditScalars(data) }); fail(error);
      }
    }
    async update(patch) {
      const client = this.db.client;
      if (this.collection === 'users') {
        const scalar = userScalars(patch, true); if (Object.keys(scalar).length) { const { error } = await client.from('directory_users').update(scalar).eq('id', this.id); fail(error); }
        if (patch.roles) await syncUserRoles(client, this.id, patch.roles);
        if (patch.permOverrides) await syncOverrides(client, this.id, patch.permOverrides);
      } else if (this.collection === 'roles') {
        const scalar = roleScalars(patch, true); if (Object.keys(scalar).length) { const { error } = await client.from('roles').update(scalar).eq('id', this.id); fail(error); }
        if (patch.orgsAssigned) await syncRoleOrganizations(client, this.id, patch.orgsAssigned);
        if (patch.permissions) await syncRolePermissions(client, this.id, patch.permissions);
      } else if (this.collection === 'departments') {
        const values = {}; if ('name' in patch) values.name = patch.name; if ('archived' in patch) values.archived = patch.archived;
        const { error } = await client.from('departments').update(values).eq('id', this.id); fail(error);
      } else if (this.collection === 'permissionsCatalog') {
        if ('actions' in patch) await syncCatalogActions(client, this.id, patch.actions);
        const values = {}; if ('name' in patch) values.name = patch.name; if ('updatedAt' in patch) values.source_updated_at = patch.updatedAt;
        if (Object.keys(values).length) { const { error } = await client.from('permission_modules').update(values).eq('id', this.id); fail(error); }
      } else if (this.collection === 'delegations') {
        const { error } = await client.from('delegations').update(delegationScalars(patch, true)).eq('id', this.id); fail(error);
      } else if (this.collection === 'auditLog') {
        const { error } = await client.from('audit_log').update(auditScalars(patch, true)).eq('id', this.id); fail(error);
      }
    }
    async delete() {
      if (this.collection === 'permissionsCatalog') {
        const { error } = await this.db.client.from('permission_modules').update({ archived: true, in_catalog: false }).eq('id', this.id); fail(error); return;
      }
      throw new Error(`Hard delete is disabled for ${this.collection}.`);
    }
  }

  function mapped(source, mapping, partial) {
    const result = {};
    Object.entries(mapping).forEach(([from, to]) => { if (!partial || Object.prototype.hasOwnProperty.call(source, from)) result[to] = source[from] ?? null; });
    return result;
  }
  function userScalars(data, partial = false) { return mapped(data, {
    name: 'name', email: 'email', primaryRole: 'primary_role', status: 'status', department: 'department', userType: 'user_type',
    teamLead: 'team_lead', deptHead: 'dept_head', homeOrg: 'home_org', orgCount: 'org_count', lastActivity: 'last_activity',
    createdAt: 'source_created_at', deleted: 'deleted', deletedAt: 'deleted_at', deletedBy: 'deleted_by'
  }, partial); }
  function roleScalars(data, partial = false) { return mapped(data, {
    name: 'name', scope: 'scope', boundOrg: 'bound_org', adminsInB2G: 'admins_in_b2g', activeAdminsInB2G: 'active_admins_in_b2g',
    adminsTotal: 'admins_total', createdAt: 'source_created_at', updatedAt: 'source_updated_at', active: 'active'
  }, partial); }
  function delegationScalars(data, partial = false) { return mapped(data, {
    department: 'department', userId: 'user_id', userName: 'user_name_snapshot', userEmail: 'user_email_snapshot', scope: 'scope',
    grantedBy: 'granted_by', grantedAt: 'granted_at', active: 'active', revokedAt: 'revoked_at', revokedBy: 'revoked_by'
  }, partial); }
  function auditScalars(data, partial = false) { return mapped(data, {
    ts: 'timestamp', actor: 'actor', actorRole: 'actor_role', action: 'action', targetUserId: 'target_user_id',
    targetUserName: 'target_user_name', field: 'field', oldValue: 'old_value', newValue: 'new_value', note: 'note', department: 'department'
  }, partial); }

  async function syncUserRoles(client, userId, roles) {
    const rows = roles.map((role, index) => ({
      id: role.id || `${userId}:${crypto.randomUUID()}:${index}`, user_id: userId, role_id: String(role.roleId),
      organization: role.org, role_name_snapshot: role.roleName, status: role.status || 'active',
      added_at: role.addedAt || null, added_by: role.addedBy || null,
      removed_at: role.removedAt || null, removed_by: role.removedBy || null
    }));
    if (rows.length) { const { error } = await client.from('user_role_assignments').upsert(rows, { onConflict: 'id' }); fail(error); }
  }
  async function ensureModules(client, names) {
    const maps = await moduleMaps(client); const created = [];
    names.forEach(name => { if (!maps.byName.has(name)) { const id = `legacy-${slug(name)}-${crypto.randomUUID().slice(0, 8)}`; maps.byName.set(name, { id, name }); created.push({ id, name, in_catalog: false, archived: false }); } });
    if (created.length) { const { error } = await client.from('permission_modules').insert(created); fail(error); }
    return maps.byName;
  }
  async function syncOverrides(client, userId, overrides) {
    let response = await client.from('user_permission_overrides').delete().eq('user_id', userId); fail(response.error);
    const entries = Object.entries(overrides || {}); if (!entries.length) return;
    const modules = await ensureModules(client, entries.map(([name]) => name));
    const baseRows = entries.map(([name, value]) => ({ user_id: userId, module_id: modules.get(name).id, read_override: value.read ?? null, write_override: value.write ?? null }));
    response = await client.from('user_permission_overrides').insert(baseRows); fail(response.error);
    const actionRows = entries.flatMap(([name, value]) => [
      ...(value.extra || []).map(action => ({ user_id: userId, module_id: modules.get(name).id, action, mode: 'grant' })),
      ...(value.removed || []).map(action => ({ user_id: userId, module_id: modules.get(name).id, action, mode: 'revoke' }))
    ]);
    if (actionRows.length) { response = await client.from('user_permission_override_actions').insert(actionRows); fail(response.error); }
  }
  async function syncRoleOrganizations(client, roleId, organizations) {
    let response = await client.from('role_organizations').delete().eq('role_id', roleId); fail(response.error);
    if (organizations.length) { response = await client.from('role_organizations').insert(organizations.map(organization => ({ role_id: roleId, organization }))); fail(response.error); }
  }
  async function syncRolePermissions(client, roleId, permissions) {
    let response = await client.from('role_permissions').delete().eq('role_id', roleId); fail(response.error);
    const entries = Object.entries(permissions || {}); if (!entries.length) return;
    const modules = await ensureModules(client, entries.map(([name]) => name));
    const baseRows = entries.map(([name, value]) => ({ role_id: roleId, module_id: modules.get(name).id, can_read: !!value.read, can_write: !!value.write }));
    response = await client.from('role_permissions').insert(baseRows); fail(response.error);
    const actionRows = entries.flatMap(([name, value]) => (value.other || []).map(action => ({ role_id: roleId, module_id: modules.get(name).id, action })));
    if (actionRows.length) { response = await client.from('role_permission_actions').insert(actionRows); fail(response.error); }
  }
  async function syncCatalogActions(client, moduleId, actions) {
    let response = await client.from('permission_catalog_actions').delete().eq('module_id', moduleId); fail(response.error);
    if (actions.length) { response = await client.from('permission_catalog_actions').insert([...new Set(actions)].map(action => ({ module_id: moduleId, action }))); fail(response.error); }
  }

  window.NormalizedDB = NormalizedDB;
})();
