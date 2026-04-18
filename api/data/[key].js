'use strict';

const { neon }        = require('@neondatabase/serverless');
const jwt             = require('jsonwebtoken');
const { syncForKey }  = require('../lib/sync-normalized');

const ALLOWED_KEYS = ['fct_projects', 'fct_projects_index', 'fct_lists', 'fct_cost_rows', 'fct_purchase_orders', 'fct_presence', 'fct_trucking', 'fct_inventory', 'fct_scale_manual', 'fct_soe_units', 'fct_truck_division', 'fct_truck_division_lists'];
function isAllowedKey(k) {
  return ALLOWED_KEYS.includes(k)
    || /^fct_project_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_trend_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_crm_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_lucius_[a-zA-Z0-9_-]+$/.test(k)
    || /^dust_[a-zA-Z0-9_-]+$/.test(k);
}

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = verifyToken(req);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized — please log in' });
  }

  const key = req.query.key;
  const sql = neon(process.env.DATABASE_URL);

  // ── Batch GET: fetch multiple keys in one query ──
  if (key === '_batch' && req.method === 'GET') {
    const keysParam = req.query.keys;
    if (!keysParam) return res.status(400).json({ error: 'keys query param required (comma-separated)' });
    const keys = keysParam.split(',').filter(k => isAllowedKey(k));
    if (!keys.length) return res.status(400).json({ error: 'No valid keys provided' });
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
    // Write-through: mirror into normalized tables (fire-and-forget on error
    // so a sync hiccup never breaks the primary save).
    syncForKey(sql, payload.companyCode, key, value).catch(err =>
      console.error('[sync-normalized] PUT', key, err.message)
    );
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
    // Write-through: mirror merged value into normalized tables.
    if (updated.length) {
      syncForKey(sql, payload.companyCode, key, updated[0].value).catch(err =>
        console.error('[sync-normalized] PATCH', key, err.message)
      );
    }
    return res.json({ ok: true });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
