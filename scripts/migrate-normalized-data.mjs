import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import process from 'node:process';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');

const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const dryRun = process.argv.includes('--dry-run');
const expectedCore = { users: 444, roles: 31, departments: 8, permissionsCatalog: 43, delegations: 1, auditLog: 2 };

async function readCollection(collection) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from('documents').select('id,data').eq('collection', collection).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function insertMissing(table, rows, onConflict) {
  for (let offset = 0; offset < rows.length; offset += 500) {
    const { error } = await client.from(table).upsert(rows.slice(offset, offset + 500), {
      onConflict,
      ignoreDuplicates: true
    });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function exactCount(table, configure = query => query) {
  const { count, error } = await configure(client.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw error;
  return count;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'module';
}

function legacyModuleId(name, usedIds) {
  const base = `legacy-${slug(name)}`;
  if (!usedIds.has(base)) return base;
  return `${base}-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

function jsonValue(value) {
  return value === undefined ? null : value;
}

const collectionNames = Object.keys(expectedCore);
const source = Object.fromEntries(await Promise.all(collectionNames.map(async name => [name, await readCollection(name)])));

for (const [name, expected] of Object.entries(expectedCore)) {
  if (source[name].length !== expected) {
    throw new Error(`Source validation failed: documents/${name} expected ${expected}, found ${source[name].length}. No normalized rows were written.`);
  }
}

const roleIds = new Set(source.roles.map(row => row.id));
const brokenRoleReferences = source.users.flatMap(row => (row.data.roles || [])
  .filter(assignment => !roleIds.has(String(assignment.roleId)))
  .map(assignment => ({ user_id: row.id, role_id: assignment.roleId })));
if (brokenRoleReferences.length) {
  throw new Error(`Source validation failed: ${brokenRoleReferences.length} user role assignments reference missing roles.`);
}

const departments = source.departments.map(({ id, data }) => ({
  id, name: data.name, source_created_at: data.createdAt || null, archived: !!data.archived
}));
const departmentNames = new Set(departments.map(row => row.name));
const unknownDepartments = source.users.filter(row => row.data.department && !departmentNames.has(row.data.department));
if (unknownDepartments.length) throw new Error(`Source validation failed: ${unknownDepartments.length} users reference unknown departments.`);

const directoryUsers = source.users.map(({ id, data }) => ({
  id, name: data.name, email: data.email, primary_role: data.primaryRole || null,
  status: data.status || 'Active', department: data.department || null, user_type: data.userType || null,
  team_lead: !!data.teamLead, dept_head: !!data.deptHead, home_org: data.homeOrg || null,
  org_count: Number(data.orgCount || 0), last_activity: data.lastActivity || null,
  source_created_at: data.createdAt || null, deleted: !!data.deleted,
  deleted_at: data.deletedAt || null, deleted_by: data.deletedBy || null
}));
const roles = source.roles.map(({ id, data }) => ({
  id, name: data.name, scope: data.scope || null, bound_org: data.boundOrg || null,
  admins_in_b2g: Number(data.adminsInB2G || 0), active_admins_in_b2g: Number(data.activeAdminsInB2G || 0),
  admins_total: Number(data.adminsTotal || 0), source_created_at: data.createdAt || null,
  source_updated_at: data.updatedAt || null, active: data.active !== false
}));
const roleOrganizations = source.roles.flatMap(({ id, data }) => (data.orgsAssigned || []).map(organization => ({ role_id: id, organization })));
const userRoleAssignments = source.users.flatMap(({ id: userId, data }) => (data.roles || []).map((assignment, index) => ({
  id: `legacy:${userId}:${index}`, user_id: userId, role_id: String(assignment.roleId),
  organization: assignment.org, role_name_snapshot: assignment.roleName,
  status: assignment.status || 'active', added_at: assignment.addedAt || null,
  added_by: assignment.addedBy || null, removed_at: assignment.removedAt || null,
  removed_by: assignment.removedBy || null
})));

const catalogNameToId = new Map(source.permissionsCatalog.map(row => [row.data.name, row.id]));
const usedModuleNames = new Set(source.roles.flatMap(row => Object.keys(row.data.permissions || {})));
for (const row of source.users) Object.keys(row.data.permOverrides || {}).forEach(name => usedModuleNames.add(name));
const usedModuleIds = new Set(source.permissionsCatalog.map(row => row.id));
const moduleNameToId = new Map(catalogNameToId);
for (const name of [...usedModuleNames].sort()) {
  if (moduleNameToId.has(name)) continue;
  const id = legacyModuleId(name, usedModuleIds);
  usedModuleIds.add(id);
  moduleNameToId.set(name, id);
}
const permissionModules = [
  ...source.permissionsCatalog.map(({ id, data }) => ({
    id, name: data.name, in_catalog: true, archived: false,
    source_created_at: data.createdAt || null, source_updated_at: data.updatedAt || null
  })),
  ...[...usedModuleNames].filter(name => !catalogNameToId.has(name)).map(name => ({
    id: moduleNameToId.get(name), name, in_catalog: false, archived: false,
    source_created_at: null, source_updated_at: null
  }))
];
const catalogActions = source.permissionsCatalog.flatMap(({ data }) => (data.actions || []).map(action => ({
  module_id: moduleNameToId.get(data.name), action
})));
const rolePermissions = source.roles.flatMap(({ id: roleId, data }) => Object.entries(data.permissions || {}).map(([name, permission]) => ({
  role_id: roleId, module_id: moduleNameToId.get(name), can_read: !!permission.read, can_write: !!permission.write
})));
const rolePermissionActions = source.roles.flatMap(({ id: roleId, data }) => Object.entries(data.permissions || {}).flatMap(([name, permission]) =>
  (permission.other || []).map(action => ({ role_id: roleId, module_id: moduleNameToId.get(name), action }))));
const userPermissionOverrides = source.users.flatMap(({ id: userId, data }) => Object.entries(data.permOverrides || {}).map(([name, override]) => ({
  user_id: userId, module_id: moduleNameToId.get(name),
  read_override: override.read === undefined ? null : !!override.read,
  write_override: override.write === undefined ? null : !!override.write
})));
const userPermissionOverrideActions = source.users.flatMap(({ id: userId, data }) => Object.entries(data.permOverrides || {}).flatMap(([name, override]) => [
  ...(override.extra || []).map(action => ({ user_id: userId, module_id: moduleNameToId.get(name), action, mode: 'grant' })),
  ...(override.removed || []).map(action => ({ user_id: userId, module_id: moduleNameToId.get(name), action, mode: 'revoke' }))
]));
const delegations = source.delegations.map(({ id, data }) => ({
  id, department: data.department, user_id: data.userId || null,
  user_name_snapshot: data.userName, user_email_snapshot: data.userEmail || null,
  scope: data.scope || 'department', granted_by: data.grantedBy || null,
  granted_at: data.grantedAt || null, active: data.active !== false,
  revoked_at: data.revokedAt || null, revoked_by: data.revokedBy || null
}));
const auditLog = source.auditLog.map(({ id, data }) => ({
  id, timestamp: data.ts, actor: data.actor, actor_role: data.actorRole || null,
  action: data.action, target_user_id: data.targetUserId || null,
  target_user_name: data.targetUserName || null, field: data.field || null,
  old_value: jsonValue(data.oldValue), new_value: jsonValue(data.newValue),
  note: data.note || null, department: data.department || null
}));

if (dryRun) {
  const groups = new Map();
  for (const user of directoryUsers) groups.set(user.email.toLowerCase(), [...(groups.get(user.email.toLowerCase()) || []), user.id]);
  console.log(JSON.stringify({
    dry_run: true,
    source_counts: {
      directory_users: directoryUsers.length, roles: roles.length, departments: departments.length,
      catalog_permission_modules: source.permissionsCatalog.length, total_permission_modules: permissionModules.length,
      legacy_role_modules_outside_catalog: permissionModules.length - source.permissionsCatalog.length,
      role_organizations: roleOrganizations.length, user_role_assignments: userRoleAssignments.length,
      permission_catalog_actions: catalogActions.length, role_permissions: rolePermissions.length,
      role_permission_actions: rolePermissionActions.length, user_permission_overrides: userPermissionOverrides.length,
      user_permission_override_actions: userPermissionOverrideActions.length,
      delegations: delegations.length, audit_log: auditLog.length
    },
    duplicate_emails: [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([email, ids]) => ({ email, ids }))
  }, null, 2));
  process.exit(0);
}

await insertMissing('departments', departments, 'id');
await insertMissing('roles', roles, 'id');
await insertMissing('permission_modules', permissionModules, 'id');
await insertMissing('directory_users', directoryUsers, 'id');
await insertMissing('role_organizations', roleOrganizations, 'role_id,organization');
await insertMissing('user_role_assignments', userRoleAssignments, 'id');
await insertMissing('permission_catalog_actions', catalogActions, 'module_id,action');
await insertMissing('role_permissions', rolePermissions, 'role_id,module_id');
await insertMissing('role_permission_actions', rolePermissionActions, 'role_id,module_id,action');
await insertMissing('user_permission_overrides', userPermissionOverrides, 'user_id,module_id');
await insertMissing('user_permission_override_actions', userPermissionOverrideActions, 'user_id,module_id,action,mode');
await insertMissing('delegations', delegations, 'id');
await insertMissing('audit_log', auditLog, 'id');

const expected = {
  directory_users: directoryUsers.length,
  roles: roles.length,
  departments: departments.length,
  catalog_permission_modules: source.permissionsCatalog.length,
  total_permission_modules: permissionModules.length,
  role_organizations: roleOrganizations.length,
  user_role_assignments: userRoleAssignments.length,
  permission_catalog_actions: catalogActions.length,
  role_permissions: rolePermissions.length,
  role_permission_actions: rolePermissionActions.length,
  user_permission_overrides: userPermissionOverrides.length,
  user_permission_override_actions: userPermissionOverrideActions.length,
  delegations: delegations.length,
  audit_log: auditLog.length
};
const actual = {
  directory_users: await exactCount('directory_users'),
  roles: await exactCount('roles'),
  departments: await exactCount('departments'),
  catalog_permission_modules: await exactCount('permission_modules', query => query.eq('in_catalog', true)),
  total_permission_modules: await exactCount('permission_modules'),
  role_organizations: await exactCount('role_organizations'),
  user_role_assignments: await exactCount('user_role_assignments'),
  permission_catalog_actions: await exactCount('permission_catalog_actions'),
  role_permissions: await exactCount('role_permissions'),
  role_permission_actions: await exactCount('role_permission_actions'),
  user_permission_overrides: await exactCount('user_permission_overrides'),
  user_permission_override_actions: await exactCount('user_permission_override_actions'),
  delegations: await exactCount('delegations'),
  audit_log: await exactCount('audit_log')
};
const mismatches = Object.keys(expected).filter(keyName => expected[keyName] !== actual[keyName]);
const emailGroups = new Map();
for (const user of directoryUsers) emailGroups.set(user.email.toLowerCase(), [...(emailGroups.get(user.email.toLowerCase()) || []), user.id]);
const duplicateEmails = [...emailGroups.entries()].filter(([, ids]) => ids.length > 1).map(([email, ids]) => ({ email, ids }));

console.log(JSON.stringify({ expected, actual, duplicate_emails: duplicateEmails }, null, 2));
if (mismatches.length) throw new Error(`Normalized migration validation failed for: ${mismatches.join(', ')}. The legacy documents table was not modified.`);
console.log('Normalized migration validation passed. Legacy documents remain untouched.');
