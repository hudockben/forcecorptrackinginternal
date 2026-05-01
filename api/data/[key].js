'use strict';

const { neon }        = require('@neondatabase/serverless');
const { syncForKey }  = require('../lib/sync-normalized');
const { requireAuth, hasDivisionAccess, divisionForKey, isSharedKey } = require('../lib/auth');

const ALLOWED_KEYS = ['fct_projects', 'fct_projects_index', 'fct_lists', 'fct_cost_rows', 'fct_purchase_orders', 'fct_presence', 'fct_trucking', 'fct_inventory', 'fct_scale_manual', 'fct_soe_units', 'fct_truck_division', 'fct_truck_division_lists'];
function isAllowedKey(k) {
  return ALLOWED_KEYS.includes(k)
    || /^fct_project_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_trend_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_crm_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_lucius_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_intercompany[_a-zA-Z0-9-]*$/.test(k)
    || /^dust_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_paving_[a-zA-Z0-9_-]+$/.test(k);
}

/**
 * Returns true if the JWT payload is permitted to read/write this blob key.
 * Maps key prefix → division and verifies divisionRoles[division] != 'no_access'.
 * Shared keys (presence/heartbeat) are accessible to any authenticated user.
 * Keys without a division-specific prefix (turf-default) require turf access.
 */
function isKeyAllowedForUser(key, payload) {
  if (isSharedKey(key)) return true;
  const division = divisionForKey(key) || 'turf';
  return hasDivisionAccess(payload, division);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const key = req.query.key;
  const sql = neon(process.env.DATABASE_URL);

  // ── Batch GET: fetch multiple keys in one query ──
  if (key === '_batch' && req.method === 'GET') {
    const keysParam = req.query.keys;
    if (!keysParam) return res.status(400).json({ error: 'keys query param required (comma-separated)' });
    // Filter to keys that are both syntactically allowed AND permitted for this user's divisions.
    // Silently dropping keys the user can't access (rather than 403) keeps batch reads
    // resilient when a UI batch list happens to include cross-division keys.
    const keys = keysParam.split(',').filter(k => isAllowedKey(k) && isKeyAllowedForUser(k, payload));
    if (!keys.length) return res.json({ values: {} });
    const scopedKeys = keys.map(k => `${payload.companyCode}:${k}`);
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${scopedKeys})`;
    const prefix = payload.companyCode + ':';
    const result = {};
    rows.forEach(r => { result[r.key.replace(prefix, '')] = r.value; });
    return res.json({ values: result });
  }

  if (!isAllowedKey(key)) {
    return res.status(400).json({ error: `Unknown key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}, fct_project_*, fct_trend_*` });
  }

  if (!isKeyAllowedForUser(key, payload)) {
    return res.status(403).json({ error: 'You do not have access to this division\'s data' });
  }

  // Namespace the DB key by company so each company's data is isolated
  const scopedKey = `${payload.companyCode}:${key}`;

  if (req.method === 'GET') {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
    return res.json({ value: rows.length ? rows[0].value : null });
  }

  if (req.method === 'PUT') {
    const { value } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: '`value` field is required in request body' });
    }
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${scopedKey}, ${JSON.stringify(value)}, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    // Mirror into normalized tables — awaited before response so serverless doesn't kill it.
    try { await syncForKey(sql, payload.companyCode, key, value); }
    catch (err) { console.error('[sync-normalized] PUT', key, err.message); }
    return res.json({ ok: true });
  }

  // ── PATCH — merge fields into existing JSONB blob (partial update) ──
  if (req.method === 'PATCH') {
    const { fields } = req.body;
    if (!fields || typeof fields !== 'object') {
      return res.status(400).json({ error: '`fields` object required in body' });
    }
    // Use JSONB concatenation operator to merge fields into existing value,
    // then return the merged result so we can sync the full updated value.
    const updated = await sql`
      UPDATE app_data
      SET value = COALESCE(value, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb,
          updated_at = NOW()
      WHERE key = ${scopedKey}
      RETURNING value
    `;
    // Mirror merged value into normalized tables — awaited before response.
    if (updated.length) {
      try { await syncForKey(sql, payload.companyCode, key, updated[0].value); }
      catch (err) { console.error('[sync-normalized] PATCH', key, err.message); }
    }
    return res.json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
