import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import process from 'node:process';

globalThis.window = {};
eval(await readFile('normalized-db.js', 'utf8'));
eval(await readFile('dashboard-export.js', 'utf8'));

const expectedColumns = {
  summary: ['User ID','Full Name','Email Address','Primary System Role','B2G Sub-Role / Permissions','Assigned Organization(s) / Intakes','Org → Sub-Role pairs','Account Status','Department','User Type','Team Lead Flag','Department Head Flag','Primary/Home Organization','B2G Auto-Enrolment Flags','B2G Org Count','Why In Scope','Effective Permissions (B2G)','Admin-Level Permissions','System Role Permissions','B2G Org Role Permissions','Last Activity','Created At'],
  detail: ['User ID','Full Name','Email Address','Primary System Role','B2G Sub-Role / Permissions','Assigned Organization / Intake','Account Status','Department','Org Role Permissions','Effective Permissions (this org)','Assigned At','Last Activity'],
  roles: ['Role ID','Role Name','Role Scope','Bound Organization','Permission Scope Count','Read-Only Scopes','Write Scopes','Permissions','B2G Orgs Where Assigned','B2G Assignments','Admins In B2G','Active Admins In B2G','Admins Total (all units)','Primary System Role Of','Created At','Updated At'],
  rolePermissions: ['Role ID','Role Name','Role Scope','Permission Scope','Read','Write','Other Actions'],
  assignments: ['Role ID','Role Name','Role Scope','B2G Organization / Intake','Admins Assigned','Active Admins Assigned']
};
assert.deepEqual(window.ISchoolDashboardExport.columns, expectedColumns, 'Export column names/order differ from the reference.');

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const db = new window.NormalizedDB(client);
const data = await window.ISchoolDashboardExport.loadLiveExportData(db);
const models = window.ISchoolDashboardExport.buildDashboardExportModels(data);
const activeAssignments = data.users.flatMap(user => (user.roles || []).filter(role => role.status === 'active'));
const homeOnlyUsers = data.users.filter(user => !(user.roles || []).some(role => role.status === 'active') && user.homeOrg);
const rolePermissionCount = data.roles.reduce((count, role) => count + Object.keys(role.permissions || {}).length, 0);

assert.equal(models.summary.length, data.users.length, 'Summary must contain one row per live directory user.');
assert.equal(models.detail.length, activeAssignments.length + homeOnlyUsers.length, 'Detail expansion differs from the active assignment/home-org scope.');
assert.equal(models.roles.length, data.roles.length, 'Roles sheet must contain all live roles.');
assert.equal(models.rolePermissions.length, rolePermissionCount, 'Role × Permission must contain every live role permission.');
assert.equal(new Set(models.summary.map(row => String(row['User ID']))).size, data.users.length, 'Directory records were collapsed.');
assert(models.summary.every(row => Object.keys(row).join('\0') === expectedColumns.summary.join('\0')), 'Summary column order differs.');
assert(models.detail.every(row => Object.keys(row).join('\0') === expectedColumns.detail.join('\0')), 'Detail column order differs.');
assert(models.roles.every(row => Object.keys(row).join('\0') === expectedColumns.roles.join('\0')), 'Roles column order differs.');
assert(models.rolePermissions.every(row => Object.keys(row).join('\0') === expectedColumns.rolePermissions.join('\0')), 'Role permission column order differs.');
assert(models.assignments.every(row => Object.keys(row).join('\0') === expectedColumns.assignments.join('\0')), 'Role assignment column order differs.');

const synthetic = window.ISchoolDashboardExport.buildDashboardExportModels({
  roles: [
    { id: 'admin', name: 'Admin', permissions: { Reports: { read: true, write: false, other: ['approve'] } }, orgsAssigned: [] },
    { id: 'worker', name: 'Worker', permissions: { Reports: { read: false, write: true, other: [] } }, orgsAssigned: ['Org'] }
  ],
  users: [{
    id: 'user', name: 'User', email: 'user@example.invalid', primaryRole: 'Worker', userType: 'Admin',
    status: 'Active', department: 'Test', teamLead: false, deptHead: false, homeOrg: null,
    roles: [{ roleId: 'worker', roleName: 'Worker', org: 'Org', status: 'active', addedAt: '2026-01-01T00:00:00Z' }],
    permOverrides: { Reports: { extra: ['export'], removed: ['approve'] } }
  }]
});
const effective = synthetic.summary[0]['Effective Permissions (B2G)'];
assert(effective.includes('read') && effective.includes('write') && effective.includes('export'), 'Effective permissions do not merge admin/system/org/override grants.');
assert(!effective.includes('approve'), 'Explicitly removed override action remains in effective permissions.');

class FakeSheet {
  constructor(name, options) { this.name = name; this.options = options; this.rows = []; this._columns = []; }
  set columns(value) { this._columns = value; }
  get columns() { return this._columns; }
  addRow(row) { this.rows.push(row); }
  getRow() { return {}; }
  eachRow() {}
  getColumn(key) { return this._columns.find(column => column.key === key) || {}; }
}
class FakeWorkbook {
  constructor() { this.worksheets = []; }
  addWorksheet(name, options) { const sheet = new FakeSheet(name, options); this.worksheets.push(sheet); return sheet; }
}
const ExcelJS = { Workbook: FakeWorkbook };
const auditWorkbook = window.ISchoolDashboardExport.buildUserAccessAuditWorkbook(models, ExcelJS);
const roleWorkbook = window.ISchoolDashboardExport.buildRolePermissionsWorkbook(models, ExcelJS);
assert.deepEqual(auditWorkbook.worksheets.map(sheet => sheet.name), ['Summary', 'Detail (per org)']);
assert.deepEqual(roleWorkbook.worksheets.map(sheet => sheet.name), ['Roles', 'Role × Permission', 'Assignments (role × org)']);

const exportedKeys = JSON.stringify([...Object.keys(models.summary[0] || {}), ...Object.keys(models.roles[0] || {})]).toLowerCase();
assert(!exportedKeys.includes('password') && !exportedKeys.includes('token') && !exportedKeys.includes('service_role'), 'Sensitive authentication fields are present.');

console.log(JSON.stringify({
  result: 'passed',
  live: {
    summary_rows: models.summary.length,
    detail_rows: models.detail.length,
    roles_rows: models.roles.length,
    role_permission_rows: models.rolePermissions.length,
    role_organization_rows: models.assignments.length
  },
  workbooks: {
    user_access_audit: auditWorkbook.worksheets.map(sheet => sheet.name),
    role_permissions: roleWorkbook.worksheets.map(sheet => sheet.name)
  }
}, null, 2));
