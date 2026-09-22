import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Server Supabase environment variables are missing');
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data: { user }, error } = await client.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
    const { data: profile, error: profileError } = await client.from('app_profiles')
      .select('role,active').eq('id', user.id).single();
    if (profileError || !profile?.active || profile.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ authorized: true });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Dashboard export authorization failed' });
  }
}
