'use strict';

const { neon }        = require('@neondatabase/serverless');
const { syncForKey }  = require('../lib/sync-normalized');
const {
  requireAuth,
  hasDivisionAccess,
  hasAnyDivisionAccess,
  divisionForKey,
  isSharedKey,
  isCrossDivisionKey,
  isIcQuarryReadOnlyGet,
  CROSS_DIVISION_CONTRIBUTORS,
} = require('../lib/auth');

const ALLOWED_KEYS = ['fct_projects', 'fct_projects_index', 'fct_lists', 'fct_cost_rows', 'fct_purchase_orders', 'fct_presence', 'fct_trucking', 'fct_inventory', 'fct_scale_manual', 'fct_soe_units', 'fct_truck_division', 'fct_truck_division_lists'];
// The only prefixes /api/data/_keys will enumerate. Keeping this to the three
// project-blob prefixes is what stops it becoming a general key scanner.
const KEY_SCAN_PREFIXES = ['fct_project_', 'fct_paving_project_', 'fct_kiewit_project_'];

function isAllowedKey(k) {
  return ALLOWED_KEYS.includes(k)
    || /^fct_project_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_trend_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_crm_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_lucius_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_intercompany[_a-zA-Z0-9-]*$/.test(k)
    || /^dust_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_paving_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_kiewit_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_quarry_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_scheduler[_a-zA-Z0-9-]*$/.test(k)
    || /^fct_conschedule_[a-zA-Z0-9_-]+$/.test(k);
}

/**
 * Returns true if the JWT payload is permitted to read/write this blob key.
 * Maps key prefix → division and verifies divisionRoles[division] != 'no_access'.
 * Shared keys (presence/heartbeat) are accessible to any authenticated user.
 * Keys without a division-specific prefix (turf-default) require turf access.
 */
function isKeyAllowedForUser(key, payload) {
  if (isSharedKey(key)) return true;
  // Cross-division blobs (e.g. fct_intercompany_billing_entries) aggregate
  // rows from multiple source divisions. Source-division users have to be
  // able to read+write them so "Send to Intercompany" actually persists,
  // even if the user has no intercompany role.
  if (isCrossDivisionKey(key)) {
    return hasAnyDivisionAccess(payload, CROSS_DIVISION_CONTRIBUTORS);
  }
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

  // GET /api/data/_keys?prefix=fct_paving_project_
  //   → { prefix, ids: ['abc', 'def', ...] }
  //
  // Lists the project ids this company has stored under one project-blob
  // prefix. Used by the client's project recovery pass, which previously
  // asked /api/projects for ids — that reads the normalized table, which only
  // ever receives turf projects, so paving and kiewit recovered nothing.
  //
  // Deliberately NOT a general key scanner: the prefix must be one of the
  // three project prefixes, so this cannot be turned into an enumeration of
  // auth, config or any other blob. Returns ids only; the caller fetches the
  // blobs it actually wants through _batch.
  if (key === '_keys' && req.method === 'GET') {
    const prefix = String(req.query.prefix || '');
    if (!KEY_SCAN_PREFIXES.includes(prefix)) {
      return res.status(400).json({ error: `prefix must be one of: ${KEY_SCAN_PREFIXES.join(', ')}` });
    }
    // Division access is decided by the prefix itself; the suffix is a project
    // id and carries no authorization meaning.
    if (!isKeyAllowedForUser(prefix + 'x', payload)) {
      return res.status(403).json({ error: 'You do not have access to this division\'s data' });
    }
    const scoped = `${payload.companyCode}:${prefix}`;
    // LEFT(...)= rather than LIKE: in SQL LIKE an underscore matches any single
    // character, so 'fct_project_%' also matches 'fct_projects_index' and any
    // other near-miss key. Comparing a fixed-length slice has no wildcards.
    // value IS NOT NULL skips tombstones: deleting a project stores null under
    // its key rather than removing the row, so a null here means "deleted",
    // not "lost". Callers can therefore treat every id returned as a project
    // that should exist.
    const rows = await sql`
      SELECT key FROM app_data
      WHERE LEFT(key, ${scoped.length}) = ${scoped} AND value IS NOT NULL
    `;
    const ids = rows
      .map(r => r.key.slice(scoped.length))
      .filter(id => /^[a-zA-Z0-9_-]+$/.test(id));
    return res.json({ prefix, ids });
  }

  if (!isAllowedKey(key)) {
    return res.status(400).json({ error: `Unknown key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}, fct_project_*, fct_trend_*` });
  }

  if (!isKeyAllowedForUser(key, payload)) {
    // Read-only escape hatch: intercompany users can GET the quarry daily and
    // crushing blobs so the IC Quarry sub-tab can render labor hours (both are
    // auto-pulled into the per-location IC rollup) without granting them
    // broader quarry-division access.
    if (!isIcQuarryReadOnlyGet(key, payload, req.method)) {
      return res.status(403).json({ error: 'You do not have access to this division\'s data' });
    }
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

    // Dust Control Other Billing audit: capture previous blob so we can
    // diff it against the incoming one after the upsert lands. Reused
    // below for the bulk-wipe protection check so we only read once.
    let _prevValue = null;
    let _prevValueLoaded = false;
    async function _loadPrev() {
      if (_prevValueLoaded) return _prevValue;
      try {
        const prev = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
        _prevValue = prev.length ? prev[0].value : null;
      } catch (err) {
        console.error('[data] read prev failed:', err.message);
      }
      _prevValueLoaded = true;
      return _prevValue;
    }

    let _obOldValue = null;
    if (key === 'dust_other_billing_rows') {
      _obOldValue = await _loadPrev();
    }

    // Bulk-wipe protection: refuse to overwrite a non-trivial existing
    // array blob with an empty array. This is the single catastrophic
    // failure mode for all the division blobs (paving cost rows, POs,
    // trucking, quarry daily/crushing/sales, dust other billing, etc.) —
    // a frontend race or stale poll that submits `[]` would silently
    // wipe everything. Single-row deletes still work because the count==1
    // case is allowed. Pass `?force=1` to override for genuine wipes.
    if (Array.isArray(value) && value.length === 0 && req.query.force !== '1') {
      const prev = await _loadPrev();
      if (Array.isArray(prev) && prev.length > 1) {
        console.warn(`[data] refused empty-array PUT for ${scopedKey}: ${prev.length} items would have been wiped`);
        return res.status(409).json({
          error: 'Refusing to wipe data',
          detail: `Cannot replace ${prev.length} items in "${key}" with an empty array. Pass ?force=1 to override.`,
        });
      }
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

    // Emit audit entries for the Dust Other Billing tab.
    if (key === 'dust_other_billing_rows') {
      try {
        const { auditObChanges } = require('../lib/dust-ob-audit');
        await auditObChanges(sql, payload, _obOldValue, value);
      } catch (err) { console.error('[dust-ob-audit] PUT', err.message); }
    }

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
