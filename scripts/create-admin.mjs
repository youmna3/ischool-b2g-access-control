import { createClient } from '@supabase/supabase-js';
import process from 'node:process';

const [email, password, displayName = 'System Administrator'] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
if (!email || !password || password.length < 8) throw new Error('Usage: npm run create-admin -- admin@example.com "strong-password" "Admin Name"');

const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
let user;
const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: displayName } });
if (error) {
  const { data: listed, error: listError } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw listError;
  user = listed.users.find(item => item.email?.toLowerCase() === email.toLowerCase());
  if (!user) throw error;
  const { error: updateError } = await client.auth.admin.updateUserById(user.id, { password, user_metadata: { display_name: displayName } });
  if (updateError) throw updateError;
} else user = data.user;

const { error: profileError } = await client.from('app_profiles').upsert({ id: user.id, display_name: displayName, role: 'admin', active: true, updated_at: new Date().toISOString() });
if (profileError) throw profileError;
console.log(`Administrator ready: ${email}`);
