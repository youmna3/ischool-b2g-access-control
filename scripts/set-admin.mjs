import { createClient } from '@supabase/supabase-js';
import process from 'node:process';

const [emailArgument, temporaryPassword] = process.argv.slice(2);
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
}

if (!emailArgument || !temporaryPassword || temporaryPassword.length < 8) {
  throw new Error('Usage: node --env-file=.env scripts/set-admin.mjs <email> "<temporary-password-of-at-least-8-characters>"');
}

const email = emailArgument.trim().toLowerCase();
const client = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function findAuthUserByEmail(targetEmail) {
  let page = 1;

  while (true) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;

    const match = data.users.find(user => user.email?.toLowerCase() === targetEmail);
    if (match) return match;
    if (!data.nextPage) return null;
    page = data.nextPage;
  }
}

let user = await findAuthUserByEmail(email);

if (user) {
  const { data, error } = await client.auth.admin.updateUserById(user.id, {
    password: temporaryPassword,
    email_confirm: true,
    ban_duration: 'none'
  });
  if (error) throw error;
  user = data.user;
} else {
  const displayName = email.split('@')[0];
  const { data, error } = await client.auth.admin.createUser({
    email,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { display_name: displayName }
  });
  if (error) throw error;
  user = data.user;
}

const { data: existingProfile, error: profileReadError } = await client
  .from('app_profiles')
  .select('display_name')
  .eq('id', user.id)
  .maybeSingle();

if (profileReadError) throw profileReadError;

const displayName = existingProfile?.display_name
  || user.user_metadata?.display_name
  || email.split('@')[0];

const { error: profileWriteError } = await client.from('app_profiles').upsert({
  id: user.id,
  display_name: displayName,
  role: 'admin',
  department: null,
  active: true,
  must_change_password: true,
  temporary_password_set_at: new Date().toISOString(),
  temporary_password_set_by: null,
  password_changed_at: null,
  updated_at: new Date().toISOString()
});

if (profileWriteError) throw profileWriteError;

console.log(`Administrator access restored for ${email}.`);
