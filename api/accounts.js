import { createClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';

const allowedRoles = new Set(['admin', 'manager', 'viewer']);

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Server Supabase environment variables are missing');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function requireUser(req, client) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const { data: { user }, error } = await client.auth.getUser(token);
  if (error || !user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const { data: profile } = await client.from('app_profiles').select('*').eq('id', user.id).single();
  if (!profile?.active) throw Object.assign(new Error('Account is inactive'), { status: 403 });
  return { user, profile };
}

async function requireAdmin(req, client) {
  const { user, profile } = await requireUser(req, client);
  if (!profile?.active || profile.role !== 'admin') throw Object.assign(new Error('Administrator access required'), { status: 403 });
  return { user, profile };
}

function generateTemporaryPassword() {
  return `${randomBytes(18).toString('base64url')}Aa1!`;
}

async function writePasswordAudit(client, { actor, action, targetId, targetName, department = null }) {
  const { error } = await client.from('audit_log').insert({
    id: randomUUID(), timestamp: new Date().toISOString(),
    actor: actor.profile.display_name || actor.user.email,
    actor_role: actor.profile.role, action,
    target_user_id: targetId, target_user_name: targetName,
    field: 'password', old_value: null, new_value: null,
    note: action === 'PASSWORD_TEMPORARILY_RESET'
      ? 'A new temporary password was set. The password value was not logged.'
      : 'The account password was changed. The password value was not logged.',
    department
  });
  if (error) throw error;
}

export default async function handler(req, res) {
  try {
    const client = adminClient();

    if (req.method === 'PUT') {
      const actor = await requireUser(req, client);
      const { password } = req.body || {};
      if (!password || password.length < 8) return res.status(400).json({ error: 'A password of at least 8 characters is required' });
      const { error: passwordError } = await client.auth.admin.updateUserById(actor.user.id, { password });
      if (passwordError) throw passwordError;
      const changedAt = new Date().toISOString();
      const { error: profileError } = await client.from('app_profiles').update({
        must_change_password: false, password_changed_at: changedAt, updated_at: changedAt
      }).eq('id', actor.user.id);
      if (profileError) throw profileError;
      await writePasswordAudit(client, { actor, action: 'PASSWORD_CHANGED', targetId: actor.user.id, targetName: actor.profile.display_name, department: actor.profile.department });
      return res.status(200).json({ ok: true });
    }

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
        active: profileById[u.id]?.active ?? false,
        must_change_password: profileById[u.id]?.must_change_password ?? false,
        temporary_password_set_at: profileById[u.id]?.temporary_password_set_at || null,
        temporary_password_set_by: profileById[u.id]?.temporary_password_set_by || null,
        password_changed_at: profileById[u.id]?.password_changed_at || null
      }));
      return res.status(200).json({ accounts });
    }

    if (req.method === 'POST') {
      const { email, password: suppliedPassword, display_name, role = 'viewer', department = null } = req.body || {};
      const password = suppliedPassword || generateTemporaryPassword();
      if (!email || password.length < 8 || !display_name) return res.status(400).json({ error: 'Name, email, and an 8+ character temporary password are required' });
      if (!allowedRoles.has(role)) return res.status(400).json({ error: 'Invalid role' });
      const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name } });
      if (error) throw error;
      const now = new Date().toISOString();
      const { error: profileError } = await client.from('app_profiles').upsert({
        id: data.user.id, display_name, role, department: department || null, active: true,
        must_change_password: true, temporary_password_set_at: now,
        temporary_password_set_by: actor.user.id, password_changed_at: null, updated_at: now
      });
      if (profileError) throw profileError;
      await writePasswordAudit(client, { actor, action: 'PASSWORD_TEMPORARILY_SET', targetId: data.user.id, targetName: display_name, department: department || null });
      return res.status(201).json({ id: data.user.id, temporary_password: password });
    }

    if (req.method === 'PATCH') {
      const { id, role, department, active, display_name, reset_password, password: suppliedPassword } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Account id is required' });
      if (role !== undefined && !allowedRoles.has(role)) return res.status(400).json({ error: 'Invalid role' });
      if (id === actor.user.id && (active === false || (role && role !== 'admin'))) return res.status(400).json({ error: 'You cannot remove your own administrator access' });
      const patch = { updated_at: new Date().toISOString() };
      if (role !== undefined) patch.role = role;
      if (department !== undefined) patch.department = department || null;
      if (active !== undefined) patch.active = !!active;
      if (display_name !== undefined) patch.display_name = display_name;
      let temporaryPassword = null;
      if (reset_password) {
        temporaryPassword = suppliedPassword || generateTemporaryPassword();
        if (temporaryPassword.length < 8) return res.status(400).json({ error: 'Temporary password must be at least 8 characters' });
        const { error: passwordError } = await client.auth.admin.updateUserById(id, {
          password: temporaryPassword, email_confirm: true, ban_duration: 'none'
        });
        if (passwordError) throw passwordError;
        patch.must_change_password = true;
        patch.temporary_password_set_at = new Date().toISOString();
        patch.temporary_password_set_by = actor.user.id;
        patch.password_changed_at = null;
      }
      const { error } = await client.from('app_profiles').update(patch).eq('id', id);
      if (error) throw error;
      if (reset_password) {
        const { data: target } = await client.from('app_profiles').select('display_name,department').eq('id', id).single();
        await writePasswordAudit(client, { actor, action: 'PASSWORD_TEMPORARILY_RESET', targetId: id, targetName: target?.display_name || display_name || id, department: target?.department || null });
      }
      return res.status(200).json({ ok: true, ...(temporaryPassword ? { temporary_password: temporaryPassword } : {}) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
  }
}
