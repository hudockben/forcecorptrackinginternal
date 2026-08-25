'use strict';
/**
 * GET /api/driver/logins  → { users: [{ id, username }], map: { username: driverName } }
 * PUT /api/driver/logins    { map: { username: driverName } }
 *
 * The username → driver-name link the driver app resolves identity through.
 *
 * It exists because the two halves of the system name people differently: the
 * Scheduler works in the trucking office's own driver list ("Kirk, Dan", which
 * is what the board and the printed dispatch sheets are written against),
 * while a login is a username. Nothing in the schema joins them — the fuel
 * workflow sidesteps the same gap by identifying people by username alone,
 * which is how office usernames ended up in the drivers list in the first
 * place. So the office states the link, once, and everything else reads it.
 *
 * The company's usernames come back with it so the office picks from a list
 * rather than typing one: a typo here is silent — the driver signs in and sees
 * an empty schedule with nothing to explain why.
 *
 * Trucking access only. Drivers never call this; /api/driver/schedule resolves
 * their name server-side and hands back only their own hauls.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');

const LOGINS_KEY = 'fct_trucking_driver_logins';
const MAX_PAIRS  = 500;
const MAX_LEN    = 200;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (!hasDivisionAccess(payload, 'trucking')) {
    return res.status(403).json({ error: 'You do not have access to this division\'s data' });
  }

  const { companyCode } = payload;
  const scoped = companyCode + ':' + LOGINS_KEY;
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      const [blobRows, userRows] = await Promise.all([
        sql`SELECT value FROM app_data WHERE key = ${scoped}`,
        // LOWER() in the sort key so "andy" and "Andy" can't land at opposite
        // ends of the list — usernames are created by hand and their casing
        // wanders. Same reason api/fuel-employees.js sorts this way.
        sql`SELECT id, username FROM users
             WHERE company_code = ${companyCode}
             ORDER BY LOWER(username) ASC`,
      ]);
      const blob = blobRows && blobRows[0] && blobRows[0].value;
      const map  = blob && typeof blob === 'object' && blob.map && typeof blob.map === 'object' ? blob.map : {};
      return res.json({
        map,
        users: (userRows || []).map(r => ({ id: Number(r.id), username: r.username })),
      });
    }

    if (req.method === 'PUT') {
      const raw = (req.body || {}).map;
      if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
        return res.status(400).json({ error: 'map must be an object of username → driver name' });
      }
      const entries = Object.entries(raw);
      if (entries.length > MAX_PAIRS) {
        return res.status(400).json({ error: `Too many links (max ${MAX_PAIRS})` });
      }
      const clean = {};
      for (const [u, d] of entries) {
        const un = String(u || '').trim().slice(0, MAX_LEN);
        const dn = String(d == null ? '' : d).trim().slice(0, MAX_LEN);
        // An empty driver is how the office unlinks a login; drop the pair
        // rather than storing a link to nobody.
        if (!un || !dn) continue;
        clean[un] = dn;
      }
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${scoped}, ${JSON.stringify({ version: 1, map: clean })}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
      return res.json({ ok: true, count: Object.keys(clean).length });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[driver/logins]', err.message);
    return res.status(500).json({ error: 'Could not load driver logins' });
  }
};
