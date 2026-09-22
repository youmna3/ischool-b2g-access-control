import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
}

const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const outputPath = path.resolve('exports', `seed-user-temporary-passwords-${timestamp}.xlsx`);
const seedDirectory = path.resolve('data', 'seed', 'users');
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function withRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await operation();
      if (result.error) throw result.error;
      return result.data;
    } catch (error) {
      lastError = error;
      const retryable = error?.status === 429 || error?.status >= 500;
      if (!retryable || attempt === 4) throw error;
      await sleep(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

async function listAllAuthUsers() {
  const users = [];
  let page = 1;
  while (true) {
    const data = await withRetry(() => client.auth.admin.listUsers({ page, perPage: 1000 }));
    users.push(...data.users);
    if (!data.nextPage) return users;
    page = data.nextPage;
  }
}

function temporaryPassword() {
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}

const seedFiles = (await readdir(seedDirectory)).filter(file => file.endsWith('.json')).sort();
const seedRows = await Promise.all(seedFiles.map(async file => {
  const data = JSON.parse(await readFile(path.join(seedDirectory, file), 'utf8'));
  return {
    source_id: String(data.id ?? path.basename(file, '.json')),
    name: String(data.name || '').trim(),
    email: String(data.email || '').trim().toLowerCase(),
    department: data.department || null
  };
}));

const invalidRows = seedRows
  .filter(row => !emailPattern.test(row.email))
  .map(row => ({ ...row, reason: row.email ? 'Invalid email address' : 'Missing email address' }));
const groupedByEmail = new Map();
for (const row of seedRows.filter(item => emailPattern.test(item.email))) {
  if (!groupedByEmail.has(row.email)) groupedByEmail.set(row.email, []);
  groupedByEmail.get(row.email).push(row);
}

const duplicateRows = [...groupedByEmail.entries()]
  .filter(([, rows]) => rows.length > 1)
  .flatMap(([email, rows]) => rows.map(row => ({ ...row, duplicate_email: email })));

const [authUsers, profileResult] = await Promise.all([
  listAllAuthUsers(),
  client.from('app_profiles').select('*').range(0, 9999)
]);
if (profileResult.error) throw profileResult.error;

const authByEmail = new Map(authUsers.filter(user => user.email).map(user => [user.email.toLowerCase(), user]));
const profileById = new Map((profileResult.data || []).map(profile => [profile.id, profile]));
const entries = [...groupedByEmail.entries()];
const results = new Array(entries.length);
let nextIndex = 0;
let completed = 0;

async function provision(index) {
  const [email, sourceRows] = entries[index];
  const password = temporaryPassword();
  const source = sourceRows[0];
  let authUser = authByEmail.get(email);
  let action;
  let authChanged = false;

  try {
    if (authUser) {
      const data = await withRetry(() => client.auth.admin.updateUserById(authUser.id, {
        password,
        email_confirm: true,
        ban_duration: 'none'
      }));
      authUser = data.user;
      action = 'Password reset';
    } else {
      const data = await withRetry(() => client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: source.name || email.split('@')[0] }
      }));
      authUser = data.user;
      action = 'Created';
    }
    authChanged = true;

    const existingProfile = profileById.get(authUser.id);
    const profile = {
      id: authUser.id,
      display_name: existingProfile?.display_name || source.name || authUser.user_metadata?.display_name || email.split('@')[0],
      role: existingProfile?.role || 'viewer',
      department: existingProfile?.department || null,
      active: true,
      must_change_password: true,
      temporary_password_set_at: new Date().toISOString(),
      temporary_password_set_by: null,
      password_changed_at: null,
      updated_at: new Date().toISOString()
    };
    await withRetry(() => client.from('app_profiles').upsert(profile));

    results[index] = {
      source_ids: sourceRows.map(row => row.source_id).join(', '),
      seed_record_count: sourceRows.length,
      name: source.name,
      email,
      temporary_password: password,
      auth_user_id: authUser.id,
      auth_action: action,
      role: profile.role,
      department: profile.department || '',
      active: true,
      status: 'Ready'
    };
  } catch (error) {
    results[index] = {
      source_ids: sourceRows.map(row => row.source_id).join(', '),
      seed_record_count: sourceRows.length,
      name: source.name,
      email,
      temporary_password: authChanged ? password : '',
      auth_user_id: authUser?.id || '',
      auth_action: action || 'Failed before Auth update',
      role: '',
      department: '',
      active: false,
      status: `ERROR: ${error.message}`
    };
  } finally {
    completed += 1;
    if (completed % 25 === 0 || completed === entries.length) {
      console.log(`Provisioned ${completed}/${entries.length} unique emails`);
    }
  }
}

async function worker() {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= entries.length) return;
    await provision(index);
  }
}

await Promise.all(Array.from({ length: 5 }, () => worker()));
await mkdir(path.dirname(outputPath), { recursive: true });

const workbookPayload = {
  generated_at: new Date().toISOString(),
  credentials: results,
  duplicates: duplicateRows,
  invalid: invalidRows
};
const writerPath = path.resolve('scripts', 'write-credentials-workbook.py');
const writer = spawnSync('python', [writerPath, outputPath], {
  input: JSON.stringify(workbookPayload),
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024
});
if (writer.status !== 0) throw new Error(writer.stderr || 'Excel workbook generation failed.');

const ready = results.filter(row => row.status === 'Ready').length;
const failed = results.length - ready;
console.log(`Completed: ${ready} ready, ${failed} failed, ${invalidRows.length} invalid seed rows.`);
console.log(`Credentials workbook: ${outputPath}`);
