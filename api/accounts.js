import { createClient } from '@supabase/supabase-js';

const allowedRoles = new Set(['admin', 'manager', 'viewer']);

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Server Supabase environment variables are missing');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function requireAdmin(req, client) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const { data: profile } = await client.from('app_profiles').select('role,active').eq('id', user.id).single();
  if (!profile?.active || profile.role !== 'admin') throw Object.assign(new Error('Administrator access required'), { status: 403 });
  return user;
}

export default async function handler(req, res) {
  try {
    const client = adminClient();
    const actor = await requireAdmin(req, client);

    if (req.method === 'GET') {
      const [{ data: listed, error }, { data: profiles, error: profileError }] = await Promise.all([
        client.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        client.from('app_profiles').select('*')
      ]);
      if (error) throw error;
      if (profileError) throw profileError;
      const profileById = Object.fromEntries((profiles || []).map(p => [p.id, p]));
      const accounts = listed.users.map(u => ({
        id: u.id, email: u.email, last_sign_in_at: u.last_sign_in_at, created_at: u.created_at,
        display_name: profileById[u.id]?.display_name || u.user_metadata?.display_name || '',
        role: profileById[u.id]?.role || 'viewer', department: profileById[u.id]?.department || null,
        active: profileById[u.id]?.active ?? false
      }));
      return res.status(200).json({ accounts });
    }

    if (req.method === 'POST') {
      const { email, password, display_name, role = 'viewer', department = null } = req.body || {};
      if (!email || !password || password.length < 8 || !display_name) return res.status(400).json({ error: 'Name, email, and an 8+ character password are required' });
      if (!allowedRoles.has(role)) return res.status(400).json({ error: 'Invalid role' });
      const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name } });
      if (error) throw error;
      const { error: profileError } = await client.from('app_profiles').upsert({ id: data.user.id, display_name, role, department: department || null, active: true, updated_at: new Date().toISOString() });
      if (profileError) throw profileError;
      return res.status(201).json({ id: data.user.id });
    }

    if (req.method === 'PATCH') {
      const { id, role, department, active, display_name } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Account id is required' });
      if (role !== undefined && !allowedRoles.has(role)) return res.status(400).json({ error: 'Invalid role' });
      if (id === actor.id && (active === false || (role && role !== 'admin'))) return res.status(400).json({ error: 'You cannot remove your own administrator access' });
      const patch = { updated_at: new Date().toISOString() };
      if (role !== undefined) patch.role = role;
      if (department !== undefined) patch.department = department || null;
      if (active !== undefined) patch.active = !!active;
      if (display_name !== undefined) patch.display_name = display_name;
      const { error } = await client.from('app_profiles').update(patch).eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
  }
}
