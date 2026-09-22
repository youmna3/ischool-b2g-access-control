(function () {
  const SUMMARY_COLUMNS = [
    'User ID', 'Full Name', 'Email Address', 'Primary System Role', 'B2G Sub-Role / Permissions',
    'Assigned Organization(s) / Intakes', 'Org → Sub-Role pairs', 'Account Status', 'Department',
    'User Type', 'Team Lead Flag', 'Department Head Flag', 'Primary/Home Organization',
    'B2G Auto-Enrolment Flags', 'B2G Org Count', 'Why In Scope', 'Effective Permissions (B2G)',
    'Admin-Level Permissions', 'System Role Permissions', 'B2G Org Role Permissions', 'Last Activity', 'Created At'
  ];
  const DETAIL_COLUMNS = [
    'User ID', 'Full Name', 'Email Address', 'Primary System Role', 'B2G Sub-Role / Permissions',
    'Assigned Organization / Intake', 'Account Status', 'Department', 'Org Role Permissions',
    'Effective Permissions (this org)', 'Assigned At', 'Last Activity'
  ];
  const ROLES_COLUMNS = [
    'Role ID', 'Role Name', 'Role Scope', 'Bound Organization', 'Permission Scope Count',
    'Read-Only Scopes', 'Write Scopes', 'Permissions', 'B2G Orgs Where Assigned', 'B2G Assignments',
    'Admins In B2G', 'Active Admins In B2G', 'Admins Total (all units)', 'Primary System Role Of',
    'Created At', 'Updated At'
  ];
  const ROLE_PERMISSION_COLUMNS = [
    'Role ID', 'Role Name', 'Role Scope', 'Permission Scope', 'Read', 'Write', 'Other Actions'
  ];
  const ASSIGNMENT_COLUMNS = [
    'Role ID', 'Role Name', 'Role Scope', 'B2G Organization / Intake', 'Admins Assigned', 'Active Admins Assigned'
  ];

  function unique(values) {
    return [...new Set(values.filter(value => value !== null && value !== undefined && value !== ''))];
  }

  function permissionMapFromRole(role) {
    const result = {};
    Object.entries(role?.permissions || {}).forEach(([module, permission]) => {
      result[module] = {
        read: !!permission.read,
        write: !!permission.write,
        other: new Set(permission.other || [])
      };
    });
    return result;
  }

  function mergePermissionMaps(...maps) {
    const result = {};
    maps.forEach(map => Object.entries(map || {}).forEach(([module, permission]) => {
      if (!result[module]) result[module] = { read: false, write: false, other: new Set() };
      result[module].read = result[module].read || !!permission.read;
      result[module].write = result[module].write || !!permission.write;
      [...(permission.other || [])].forEach(action => result[module].other.add(action));
    }));
    return result;
  }

  function applyOverrides(base, overrides) {
    const result = mergePermissionMaps(base);
    Object.entries(overrides || {}).forEach(([module, override]) => {
      if (!result[module]) result[module] = { read: false, write: false, other: new Set() };
      if (override.read !== undefined) result[module].read = !!override.read;
      if (override.write !== undefined) result[module].write = !!override.write;
      (override.extra || []).forEach(action => result[module].other.add(action));
      (override.removed || []).forEach(action => result[module].other.delete(action));
    });
    return result;
  }

  function formatPermissions(map) {
    return Object.keys(map || {}).sort((a, b) => a.localeCompare(b)).map(module => {
      const permission = map[module];
      const actions = [];
      if (permission.read) actions.push('read');
      if (permission.write) actions.push('write');
      [...(permission.other || [])].sort((a, b) => a.localeCompare(b)).forEach(action => actions.push(action));
      return `${module}: ${actions.length ? actions.join(', ') : '(no actions)'}`;
    }).join(' | ');
  }

  function displayDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000');
  }

  function roleLookup(roles) {
    return {
      byId: new Map(roles.map(role => [String(role.id), role])),
      byName: new Map(roles.map(role => [String(role.name || '').trim().toLowerCase(), role]))
    };
  }

  function userPermissionParts(user, lookup, assignments) {
    const adminRole = lookup.byName.get(String(user.userType || '').trim().toLowerCase());
    const systemRole = lookup.byName.get(String(user.primaryRole || '').trim().toLowerCase());
    const orgRoles = unique(assignments.map(assignment => String(assignment.roleId))).map(id => lookup.byId.get(id)).filter(Boolean);
    const admin = permissionMapFromRole(adminRole);
    const system = permissionMapFromRole(systemRole);
    const org = mergePermissionMaps(...orgRoles.map(permissionMapFromRole));
    return { admin, system, org, effective: applyOverrides(mergePermissionMaps(admin, system, org), user.permOverrides) };
  }

  function buildDashboardExportModels({ users, roles }) {
    const lookup = roleLookup(roles);
    const activeAssignmentsByRole = new Map();
    const allAssignmentsByRole = new Map();
    const usersById = new Map(users.map(user => [String(user.id), user]));

    users.forEach(user => (user.roles || []).forEach(assignment => {
      const roleId = String(assignment.roleId);
      if (!allAssignmentsByRole.has(roleId)) allAssignmentsByRole.set(roleId, []);
      allAssignmentsByRole.get(roleId).push({ user, assignment });
      if (assignment.status === 'active') {
        if (!activeAssignmentsByRole.has(roleId)) activeAssignmentsByRole.set(roleId, []);
        activeAssignmentsByRole.get(roleId).push({ user, assignment });
      }
    }));

    const summary = [];
    const detail = [];
    users.forEach(user => {
      const assignments = (user.roles || []).filter(assignment => assignment.status === 'active');
      const organizations = unique(assignments.map(assignment => assignment.org)).sort((a, b) => a.localeCompare(b));
      const subRoles = unique(assignments.map(assignment => assignment.roleName)).sort((a, b) => a.localeCompare(b));
      const pairs = assignments.slice().sort((a, b) => String(a.org).localeCompare(String(b.org)) || String(a.roleName).localeCompare(String(b.roleName)));
      const parts = userPermissionParts(user, lookup, assignments);
      const why = [];
      if (assignments.length) why.push('org membership');
      if (user.homeOrg) why.push('home org');
      const accountStatus = user.deleted ? 'Deleted' : (user.status || '');

      summary.push({
        'User ID': user.id,
        'Full Name': user.name || '',
        'Email Address': user.email || '',
        'Primary System Role': user.primaryRole || '',
        'B2G Sub-Role / Permissions': subRoles.join(' | '),
        'Assigned Organization(s) / Intakes': organizations.join(' | '),
        'Org → Sub-Role pairs': pairs.map(assignment => `${assignment.org} → ${assignment.roleName}`).join(' | '),
        'Account Status': accountStatus,
        'Department': user.department || '',
        'User Type': user.userType || '',
        'Team Lead Flag': user.teamLead ? 'Yes' : 'No',
        'Department Head Flag': user.deptHead ? 'Yes' : 'No',
        'Primary/Home Organization': user.homeOrg || '(none)',
        'B2G Auto-Enrolment Flags': '',
        'B2G Org Count': organizations.length,
        'Why In Scope': why.join(', '),
        'Effective Permissions (B2G)': formatPermissions(parts.effective),
        'Admin-Level Permissions': formatPermissions(parts.admin),
        'System Role Permissions': formatPermissions(parts.system),
        'B2G Org Role Permissions': formatPermissions(parts.org),
        'Last Activity': displayDate(user.lastActivity),
        'Created At': displayDate(user.createdAt)
      });

      const detailAssignments = assignments.length ? assignments : (user.homeOrg ? [{ org: user.homeOrg, roleName: '', roleId: null, addedAt: null }] : []);
      detailAssignments.forEach(assignment => {
        const assignmentRole = assignment.roleId ? lookup.byId.get(String(assignment.roleId)) : null;
        const orgPermissions = permissionMapFromRole(assignmentRole);
        const effective = applyOverrides(mergePermissionMaps(parts.admin, parts.system, orgPermissions), user.permOverrides);
        detail.push({
          'User ID': user.id,
          'Full Name': user.name || '',
          'Email Address': user.email || '',
          'Primary System Role': user.primaryRole || '',
          'B2G Sub-Role / Permissions': assignment.roleName || '(none)',
          'Assigned Organization / Intake': assignment.org || '',
          'Account Status': accountStatus,
          'Department': user.department || '',
          'Org Role Permissions': formatPermissions(orgPermissions),
          'Effective Permissions (this org)': formatPermissions(effective),
          'Assigned At': displayDate(assignment.addedAt),
          'Last Activity': displayDate(user.lastActivity)
        });
      });
    });

    const roleRows = [];
    const rolePermissionRows = [];
    const assignmentRows = [];
    roles.forEach(role => {
      const permissionEntries = Object.entries(role.permissions || {});
      const activeRoleAssignments = activeAssignmentsByRole.get(String(role.id)) || [];
      const allRoleAssignments = allAssignmentsByRole.get(String(role.id)) || [];
      const explicitOrganizations = role.orgsAssigned || [];
      const organizations = unique([...explicitOrganizations, ...activeRoleAssignments.map(row => row.assignment.org)]).sort((a, b) => a.localeCompare(b));
      const assignedUserIds = unique(activeRoleAssignments.map(row => String(row.user.id)));
      const activeUserIds = unique(activeRoleAssignments.filter(row => !row.user.deleted && row.user.status === 'Active').map(row => String(row.user.id)));
      const primaryUsers = users.filter(user => String(user.primaryRole || '').trim().toLowerCase() === String(role.name || '').trim().toLowerCase());
      const totalUserIds = unique([...allRoleAssignments.map(row => String(row.user.id)), ...primaryUsers.map(user => String(user.id))]);

      roleRows.push({
        'Role ID': role.id,
        'Role Name': role.name || '',
        'Role Scope': role.scope || '',
        'Bound Organization': role.boundOrg || '(none)',
        'Permission Scope Count': permissionEntries.length,
        'Read-Only Scopes': permissionEntries.filter(([, permission]) => permission.read && !permission.write).length,
        'Write Scopes': permissionEntries.filter(([, permission]) => permission.write).length,
        'Permissions': formatPermissions(permissionMapFromRole(role)),
        'B2G Orgs Where Assigned': organizations.join(' | '),
        'B2G Assignments': activeRoleAssignments.length,
        'Admins In B2G': assignedUserIds.length,
        'Active Admins In B2G': activeUserIds.length,
        'Admins Total (all units)': totalUserIds.length,
        'Primary System Role Of': primaryUsers.length,
        'Created At': displayDate(role.createdAt),
        'Updated At': displayDate(role.updatedAt)
      });

      permissionEntries.sort(([a], [b]) => a.localeCompare(b)).forEach(([module, permission]) => {
        rolePermissionRows.push({
          'Role ID': role.id,
          'Role Name': role.name || '',
          'Role Scope': role.scope || '',
          'Permission Scope': module,
          'Read': permission.read ? 'Yes' : 'No',
          'Write': permission.write ? 'Yes' : 'No',
          'Other Actions': (permission.other || []).slice().sort((a, b) => a.localeCompare(b)).join(', ')
        });
      });

      organizations.forEach(organization => {
        const rows = activeRoleAssignments.filter(row => row.assignment.org === organization);
        assignmentRows.push({
          'Role ID': role.id,
          'Role Name': role.name || '',
          'Role Scope': role.scope || '',
          'B2G Organization / Intake': organization,
          'Admins Assigned': unique(rows.map(row => String(row.user.id))).length,
          'Active Admins Assigned': unique(rows.filter(row => !row.user.deleted && row.user.status === 'Active').map(row => String(row.user.id))).length
        });
      });
    });

    const byName = (a, b) => String(a['Full Name'] || a['Role Name'] || '').localeCompare(String(b['Full Name'] || b['Role Name'] || ''));
    return {
      summary: summary.sort(byName),
      detail: detail.sort((a, b) => byName(a, b) || String(a['Assigned Organization / Intake']).localeCompare(String(b['Assigned Organization / Intake']))),
      roles: roleRows.sort(byName),
      rolePermissions: rolePermissionRows.sort((a, b) => String(a['Role Name']).localeCompare(String(b['Role Name'])) || String(a['Permission Scope']).localeCompare(String(b['Permission Scope']))),
      assignments: assignmentRows.sort((a, b) => String(a['Role Name']).localeCompare(String(b['Role Name'])) || String(a['B2G Organization / Intake']).localeCompare(String(b['B2G Organization / Intake']))),
      sourceCounts: { users: users.length, roles: roles.length, directoryUsersById: usersById.size }
    };
  }

  function addWorksheet(workbook, name, columns, rows, longColumns) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns.map(header => ({ header, key: header, width: Math.min(60, Math.max(12, header.length + 2)) }));
    rows.forEach(row => sheet.addRow(row));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF056FEC' } };
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    header.height = 30;
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.alignment = { vertical: 'top' };
    });
    longColumns.forEach(columnName => {
      const column = sheet.getColumn(columnName);
      column.width = 60;
      column.alignment = { vertical: 'top', wrapText: true };
    });
    return sheet;
  }

  function buildUserAccessAuditWorkbook(models, ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'iSchool B2G Access Control';
    addWorksheet(workbook, 'Summary', SUMMARY_COLUMNS, models.summary, [
      'B2G Sub-Role / Permissions', 'Assigned Organization(s) / Intakes', 'Org → Sub-Role pairs',
      'Effective Permissions (B2G)', 'Admin-Level Permissions', 'System Role Permissions', 'B2G Org Role Permissions'
    ]);
    addWorksheet(workbook, 'Detail (per org)', DETAIL_COLUMNS, models.detail, [
      'Org Role Permissions', 'Effective Permissions (this org)'
    ]);
    return workbook;
  }

  function buildRolePermissionsWorkbook(models, ExcelJS) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'iSchool B2G Access Control';
    addWorksheet(workbook, 'Roles', ROLES_COLUMNS, models.roles, ['Permissions', 'B2G Orgs Where Assigned']);
    addWorksheet(workbook, 'Role × Permission', ROLE_PERMISSION_COLUMNS, models.rolePermissions, ['Other Actions']);
    addWorksheet(workbook, 'Assignments (role × org)', ASSIGNMENT_COLUMNS, models.assignments, []);
    return workbook;
  }

  async function loadLiveExportData(db) {
    const [userRows, roleRows] = await Promise.all([db.fetch('users'), db.fetch('roles')]);
    return {
      users: userRows.map(row => ({ id: row.id, ...row.data })),
      roles: roleRows.map(row => ({ id: row.id, ...row.data }))
    };
  }

  async function exportDashboardSheets({ db, profile, downloads, ExcelJS, authorize }) {
    if (!profile || profile.role !== 'admin') throw new Error('Administrator access required.');
    if (!db || !downloads || !ExcelJS) throw new Error('Dashboard export is not available.');
    if (typeof authorize !== 'function') throw new Error('Dashboard export authorization is unavailable.');
    await authorize();
    const data = await loadLiveExportData(db);
    const models = buildDashboardExportModels(data);
    const date = new Date().toISOString().slice(0, 10);
    const auditWorkbook = buildUserAccessAuditWorkbook(models, ExcelJS);
    const rolesWorkbook = buildRolePermissionsWorkbook(models, ExcelJS);
    const [auditBuffer, rolesBuffer] = await Promise.all([
      auditWorkbook.xlsx.writeBuffer(), rolesWorkbook.xlsx.writeBuffer()
    ]);
    await downloads.save({
      filename: `b2g_user_access_audit_${date}.xlsx`,
      data: new Blob([auditBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    await downloads.save({
      filename: `b2g_role_permissions_${date}.xlsx`,
      data: new Blob([rolesBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    });
    return models;
  }

  window.ISchoolDashboardExport = {
    columns: {
      summary: SUMMARY_COLUMNS,
      detail: DETAIL_COLUMNS,
      roles: ROLES_COLUMNS,
      rolePermissions: ROLE_PERMISSION_COLUMNS,
      assignments: ASSIGNMENT_COLUMNS
    },
    loadLiveExportData,
    buildDashboardExportModels,
    buildUserAccessAuditWorkbook,
    buildRolePermissionsWorkbook,
    exportDashboardSheets
  };
})();
