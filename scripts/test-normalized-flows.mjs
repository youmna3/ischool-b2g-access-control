import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

globalThis.window = {};
eval(await readFile('normalized-db.js', 'utf8'));

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const db = new window.NormalizedDB(client);
const suffix = crypto.randomUUID();
const ids = {
  department: `adapter-test-department-${suffix}`,
  module: `adapter-test-module-${suffix}`,
  role: `adapter-test-role-${suffix}`,
  user: `adapter-test-user-${suffix}`,
  assignment: `adapter-test-assignment-${suffix}`,
  delegation: `adapter-test-delegation-${suffix}`,
  audit: `adapter-test-audit-${suffix}`
};
const departmentName = `Adapter test ${suffix}`;
const moduleName = `Adapter test module ${suffix}`;
const now = new Date().toISOString();

function check(value, message) {
  if (!value) throw new Error(message);
}

async function remove(table, column, value) {
  const { error } = await client.from(table).delete().eq(column, value);
  if (error) throw error;
}

try {
  await db.collection('departments').doc(ids.department).set({ name: departmentName, createdAt: now, archived: false });
  await db.collection('permissionsCatalog').doc(ids.module).set({ name: moduleName, actions: ['view', 'edit'], createdAt: now, updatedAt: now });
  await db.collection('roles').doc(ids.role).set({
    name: `Adapter test role ${suffix}`, scope: 'department', boundOrg: null,
    orgsAssigned: ['Adapter Org'], adminsInB2G: 0, activeAdminsInB2G: 0,
    adminsTotal: 0, createdAt: now, updatedAt: now, active: true,
    permissions: { [moduleName]: { read: true, write: false, other: ['approve'] } }
  });
  await db.collection('users').doc(ids.user).set({
    name: 'Adapter Test User', email: `${ids.user}@example.invalid`, primaryRole: 'Adapter test role',
    status: 'Active', department: departmentName, userType: 'User', teamLead: false,
    deptHead: false, homeOrg: 'Adapter Org', orgCount: 1, lastActivity: now,
    createdAt: now, deleted: false, deletedAt: null, deletedBy: null,
    roles: [{ id: ids.assignment, org: 'Adapter Org', roleName: 'Adapter test role', roleId: ids.role, status: 'active', addedAt: now, addedBy: 'adapter-test', removedAt: null, removedBy: null }],
    permOverrides: { [moduleName]: { read: true, write: false, extra: ['export'], removed: ['edit'] } }
  });
  await db.collection('delegations').doc(ids.delegation).set({
    department: departmentName, userId: ids.user, userName: 'Adapter Test User',
    userEmail: `${ids.user}@example.invalid`, scope: 'department', grantedBy: 'adapter-test',
    grantedAt: now, active: true, revokedAt: null, revokedBy: null
  });
  await db.collection('auditLog').doc(ids.audit).set({
    ts: now, actor: 'adapter-test', actorRole: 'admin', action: 'ADAPTER_TEST',
    targetUserId: ids.user, targetUserName: 'Adapter Test User', field: 'status',
    oldValue: 'Pending', newValue: 'Active', note: 'Temporary validation row', department: departmentName
  });

  await db.collection('users').doc(ids.user).update({
    status: 'Inactive', deleted: true, deletedAt: now, deletedBy: 'adapter-test',
    roles: [{ id: ids.assignment, org: 'Adapter Org', roleName: 'Adapter test role', roleId: ids.role, status: 'removed', addedAt: now, addedBy: 'adapter-test', removedAt: now, removedBy: 'adapter-test' }]
  });
  await db.collection('users').doc(ids.user).update({ status: 'Active', deleted: false, deletedAt: null, deletedBy: null });
  await db.collection('roles').doc(ids.role).update({
    orgsAssigned: ['Adapter Org', 'Adapter Org 2'],
    permissions: { [moduleName]: { read: true, write: true, other: ['approve', 'export'] } },
    updatedAt: now
  });
  await db.collection('permissionsCatalog').doc(ids.module).update({ actions: ['view', 'edit', 'export'], updatedAt: now });
  await db.collection('delegations').doc(ids.delegation).update({ active: false, revokedAt: now, revokedBy: 'adapter-test' });

  const [users, roles, catalog, delegations, audit] = await Promise.all([
    db.fetch('users'), db.fetch('roles'), db.fetch('permissionsCatalog'),
    db.fetch('delegations'), db.fetch('auditLog')
  ]);
  const user = users.find(row => row.id === ids.user)?.data;
  const role = roles.find(row => row.id === ids.role)?.data;
  const module = catalog.find(row => row.id === ids.module)?.data;
  const delegation = delegations.find(row => row.id === ids.delegation)?.data;
  check(user?.status === 'Active' && user.deleted === false, 'User update/restore failed.');
  check(user.roles[0]?.status === 'removed' && user.roles[0]?.removedBy === 'adapter-test', 'Role history update failed.');
  check(user.permOverrides[moduleName]?.extra?.includes('export') && user.permOverrides[moduleName]?.removed?.includes('edit'), 'Permission override round trip failed.');
  check(role?.orgsAssigned?.length === 2 && role.permissions[moduleName]?.write === true && role.permissions[moduleName]?.other?.includes('export'), 'Role permission update failed.');
  check(module?.actions?.includes('export'), 'Permission catalog update failed.');
  check(delegation?.active === false && delegation.revokedBy === 'adapter-test', 'Delegation revoke failed.');
  check(audit.some(row => row.id === ids.audit && row.data.oldValue === 'Pending' && row.data.newValue === 'Active'), 'Audit round trip failed.');

  await db.collection('permissionsCatalog').doc(ids.module).delete();
  check(!(await db.fetch('permissionsCatalog')).some(row => row.id === ids.module), 'Permission catalog archive failed.');

  console.log(JSON.stringify({
    result: 'passed',
    flows: ['department create', 'catalog create/update/archive', 'role create/update', 'user create/update/soft-delete/restore', 'role history', 'permission overrides', 'delegation grant/revoke', 'audit insert']
  }, null, 2));
} finally {
  db.destroy();
  await remove('audit_log', 'id', ids.audit);
  await remove('delegations', 'id', ids.delegation);
  await remove('directory_users', 'id', ids.user);
  await remove('roles', 'id', ids.role);
  await remove('permission_modules', 'id', ids.module);
  await remove('departments', 'id', ids.department);
}
