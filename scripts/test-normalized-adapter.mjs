import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import process from 'node:process';

globalThis.window = {};
eval(await readFile('normalized-db.js', 'utf8'));
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new window.NormalizedDB(client);
const collections = ['users', 'roles', 'departments', 'permissionsCatalog', 'delegations', 'auditLog'];

function instant(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value ?? null;
}
function entitiesById(rows) {
  return rows
    .map(({ id, data }) => ({ id: String(id), data: ordered(data) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const expected = {};
for (const name of collections) {
  const { data, error } = await client.from('documents').select('id,data').eq('collection', name).range(0, 9999);
  if (error) throw error;
  expected[name] = data;
}
const actual = Object.fromEntries(await Promise.all(collections.map(async name => [name, await db.fetch(name)])));

const expectedUsers = expected.users.map(({ id, data }) => ({ id, data: {
  name: data.name, email: data.email, primaryRole: data.primaryRole ?? null, status: data.status,
  department: data.department ?? null, userType: data.userType ?? null, teamLead: !!data.teamLead,
  deptHead: !!data.deptHead, homeOrg: data.homeOrg ?? null, orgCount: Number(data.orgCount || 0),
  lastActivity: instant(data.lastActivity), createdAt: instant(data.createdAt), deleted: !!data.deleted,
  deletedAt: instant(data.deletedAt), deletedBy: data.deletedBy ?? null,
  roles: (data.roles || []).map(role => ({
    org: role.org, roleName: role.roleName, roleId: String(role.roleId), status: role.status || 'active',
    addedAt: instant(role.addedAt), addedBy: role.addedBy ?? null,
    removedAt: instant(role.removedAt), removedBy: role.removedBy ?? null
  })),
  permOverrides: data.permOverrides || {}
}}));
const actualUsers = actual.users.map(({ id, data }) => ({ id, data: {
  ...data, lastActivity: instant(data.lastActivity), createdAt: instant(data.createdAt), deletedAt: instant(data.deletedAt),
  roles: (data.roles || []).map(({ id: assignmentId, ...role }) => ({ ...role, addedAt: instant(role.addedAt), removedAt: instant(role.removedAt) }))
}}));

const expectedRoles = expected.roles.map(({ id, data }) => ({ id, data: {
  name: data.name, scope: data.scope ?? null, boundOrg: data.boundOrg ?? null,
  orgsAssigned: data.orgsAssigned || [], adminsInB2G: Number(data.adminsInB2G || 0),
  activeAdminsInB2G: Number(data.activeAdminsInB2G || 0), adminsTotal: Number(data.adminsTotal || 0),
  createdAt: instant(data.createdAt), updatedAt: instant(data.updatedAt), active: data.active !== false,
  permissions: data.permissions || {}
}}));
const actualRoles = actual.roles.map(({ id, data }) => ({ id, data: { ...data, createdAt: instant(data.createdAt), updatedAt: instant(data.updatedAt) } }));

const expectedDepartments = expected.departments.filter(({ data }) => !data.archived).map(({ id, data }) => ({ id, data: { name: data.name, createdAt: instant(data.createdAt), archived: !!data.archived } }));
const actualDepartments = actual.departments.map(({ id, data }) => ({ id, data: { ...data, createdAt: instant(data.createdAt) } }));
const expectedCatalog = expected.permissionsCatalog.map(({ id, data }) => ({ id, data: { name: data.name, actions: data.actions || [], createdAt: instant(data.createdAt), updatedAt: instant(data.updatedAt) } }));
const actualCatalog = actual.permissionsCatalog.map(({ id, data }) => ({ id, data: { ...data, createdAt: instant(data.createdAt), updatedAt: instant(data.updatedAt) } }));
const expectedDelegations = expected.delegations.map(({ id, data }) => ({ id, data: {
  department: data.department, userId: data.userId ?? null, userName: data.userName,
  userEmail: data.userEmail ?? null, scope: data.scope || 'department', grantedBy: data.grantedBy ?? null,
  grantedAt: instant(data.grantedAt), active: data.active !== false,
  revokedAt: instant(data.revokedAt), revokedBy: data.revokedBy ?? null
}}));
const actualDelegations = actual.delegations.map(({ id, data }) => ({ id, data: { ...data, grantedAt: instant(data.grantedAt), revokedAt: instant(data.revokedAt) } }));
const expectedAudit = expected.auditLog.map(({ id, data }) => ({ id, data: {
  ts: instant(data.ts), actor: data.actor, actorRole: data.actorRole ?? null, action: data.action,
  targetUserId: data.targetUserId ?? null, targetUserName: data.targetUserName ?? null,
  field: data.field ?? null, oldValue: data.oldValue ?? null, newValue: data.newValue ?? null,
  note: data.note ?? null, department: data.department ?? null
}}));
const actualAudit = actual.auditLog.map(({ id, data }) => ({ id, data: { ...data, ts: instant(data.ts) } }));

for (const [name, before, after] of [
  ['users', expectedUsers, actualUsers], ['roles', expectedRoles, actualRoles],
  ['departments', expectedDepartments, actualDepartments], ['permissionsCatalog', expectedCatalog, actualCatalog],
  ['delegations', expectedDelegations, actualDelegations], ['auditLog', expectedAudit, actualAudit]
]) {
  const expectedById = entitiesById(before);
  const actualById = entitiesById(after);
  if (expectedById.length !== actualById.length) {
    throw new Error(`${name} count differs: expected ${expectedById.length}, actual ${actualById.length}`);
  }
  for (let index = 0; index < expectedById.length; index += 1) {
    const expectedRow = expectedById[index];
    const actualRow = actualById[index];
    if (expectedRow.id !== actualRow.id) {
      throw new Error(`${name} ID differs at index ${index}: expected ${expectedRow.id}, actual ${actualRow.id}`);
    }
    if (!isDeepStrictEqual(actualRow.data, expectedRow.data)) {
      throw new Error(`${name}/${expectedRow.id} normalized adapter output differs from live documents\nexpected=${JSON.stringify(expectedRow.data)}\nactual=${JSON.stringify(actualRow.data)}`);
    }
  }
}

console.log(JSON.stringify({
  field_reconciliation: 'passed',
  counts: Object.fromEntries(collections.map(name => [name, actual[name].length]))
}, null, 2));
