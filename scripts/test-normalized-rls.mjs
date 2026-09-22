import { createClient } from '@supabase/supabase-js';
import process from 'node:process';

const credentials = JSON.parse(process.env.TEST_CREDS_JSON || 'null');
if (!credentials?.admin || !credentials?.viewer) throw new Error('TEST_CREDS_JSON must contain admin and viewer credentials.');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options);
const browserClient = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, options);

let authUsers = [], page = 1;
while (true) {
  const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  authUsers.push(...data.users);
  if (!data.nextPage) break;
  page = data.nextPage;
}
const authByEmail = new Map(authUsers.filter(user => user.email).map(user => [user.email.toLowerCase(), user]));
const viewerAuth = authByEmail.get(credentials.viewer.email.toLowerCase());
if (!viewerAuth) throw new Error('Viewer Auth user not found.');
const { data: originalProfile, error: profileError } = await service.from('app_profiles').select('*').eq('id', viewerAuth.id).single();
if (profileError) throw profileError;
const { data: directory, error: directoryError } = await service.from('directory_users').select('id,email,department,status');
if (directoryError) throw directoryError;
const viewerDirectory = directory.find(user => user.email.toLowerCase() === credentials.viewer.email.toLowerCase());
if (!viewerDirectory?.department) throw new Error('Viewer directory record or department not found.');

const viewer = browserClient();
const { error: viewerLoginError } = await viewer.auth.signInWithPassword(credentials.viewer);
if (viewerLoginError) throw viewerLoginError;

try {
  let result = await viewer.from('directory_users').select('*', { count: 'exact', head: true });
  if (result.error) throw result.error;
  const viewerUsers = result.count;
  const expectedViewer = directory.filter(user => user.email.toLowerCase() === credentials.viewer.email.toLowerCase()).length;

  result = await viewer.from('roles').select('*', { count: 'exact', head: true });
  if (result.error) throw result.error;
  const viewerRoles = result.count;

  const blockedViewerWrite = await viewer.from('directory_users')
    .update({ status: viewerDirectory.status }).eq('id', viewerDirectory.id).select('id');
  if (blockedViewerWrite.error) throw blockedViewerWrite.error;

  const { error: promoteError } = await service.from('app_profiles')
    .update({ role: 'manager', department: viewerDirectory.department }).eq('id', viewerAuth.id);
  if (promoteError) throw promoteError;

  result = await viewer.from('directory_users').select('*', { count: 'exact', head: true });
  if (result.error) throw result.error;
  const managerUsers = result.count;
  const expectedManager = directory.filter(user => user.department === viewerDirectory.department).length;
  const outside = directory.find(user => user.department !== viewerDirectory.department);
  const blockedOutsideWrite = await viewer.from('directory_users')
    .update({ status: outside.status }).eq('id', outside.id).select('id');
  if (blockedOutsideWrite.error) throw blockedOutsideWrite.error;

  const admin = browserClient();
  const { error: adminLoginError } = await admin.auth.signInWithPassword(credentials.admin);
  if (adminLoginError) throw adminLoginError;
  result = await admin.from('directory_users').select('*', { count: 'exact', head: true });
  if (result.error) throw result.error;

  const checks = {
    viewer_user_scope: viewerUsers === expectedViewer,
    viewer_reference_access: viewerRoles >= 31,
    viewer_write_blocked: blockedViewerWrite.data.length === 0,
    manager_department_scope: managerUsers === expectedManager,
    manager_outside_write_blocked: blockedOutsideWrite.data.length === 0,
    admin_full_access: result.count === directory.length
  };
  console.log(JSON.stringify({ checks, counts: { viewerUsers, expectedViewer, viewerRoles, managerUsers, expectedManager, adminUsers: result.count } }, null, 2));
  if (Object.values(checks).some(value => !value)) throw new Error('One or more RLS smoke tests failed.');
} finally {
  await service.from('app_profiles').update({ role: originalProfile.role, department: originalProfile.department }).eq('id', viewerAuth.id);
}
