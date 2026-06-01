'use strict';
/**
 * Dust Other Billing audit logger.
 *
 * The Other Billing grid is stored as a JSON blob in app_data, so unlike
 * dust_control_entries there is no per-row schema we can diff via SQL.
 * Instead we read the previous blob value before writing the new one,
 * compare row-by-row, and emit INSERT / UPDATE / DELETE entries into the
 * shared dust_control_audit_log table tagged with source = 'other-billing'.
 *
 * Called from /api/data/[key].js when the key is dust_other_billing_rows.
 */

const OB_AUDIT_FIELDS = [
  'date',
  'inv_number',
  'driver',
  'truck_number',
  'trailer_number',
  'customer',
  'destination',
  'state',
  'material',
  'gallons_bags',
  'mu',
  'price_per_unit',
  'trucking_hrs',
  'trucking_rate',
  'comments',
];

const NUM_FIELDS = new Set(['gallons_bags', 'price_per_unit', 'trucking_hrs', 'trucking_rate']);

function _norm(field, v) {
  if (v == null) return '';
  if (NUM_FIELDS.has(field)) {
    const f = parseFloat(v);
    return isNaN(f) ? '' : String(f);
  }
  return String(v);
}

function _diffRow(oldRow, newRow) {
  const changes = {};
  for (const f of OB_AUDIT_FIELDS) {
    const a = _norm(f, oldRow ? oldRow[f] : '');
    const b = _norm(f, newRow ? newRow[f] : '');
    if (a !== b) changes[f] = { from: a, to: b };
  }
  return changes;
}

function _rowSnapshot(r) {
  if (!r) return null;
  const out = {};
  for (const f of OB_AUDIT_FIELDS) out[f] = _norm(f, r[f]);
  return out;
}

let _ensured = false;
async function _ensureTable(sql) {
  if (_ensured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS dust_control_audit_log (
      id            BIGSERIAL PRIMARY KEY,
      company_code  TEXT        NOT NULL,
      row_id        TEXT        NOT NULL,
      action        TEXT        NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
      user_id       INTEGER,
      username      TEXT,
      changes       JSONB,
      snapshot      JSONB,
      source        TEXT        NOT NULL DEFAULT 'tracking',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE dust_control_audit_log ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tracking'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_company_src ON dust_control_audit_log(company_code, source, created_at DESC)`;
  _ensured = true;
}

async function _writeAudit(sql, payload, action, rowId, changes, snapshot) {
  try {
    await sql`
      INSERT INTO dust_control_audit_log
        (company_code, row_id, action, user_id, username, changes, snapshot, source)
      VALUES
        (${payload.companyCode}, ${rowId}, ${action},
         ${payload.userId || null}, ${payload.username || null},
         ${changes ? JSON.stringify(changes) : null}::jsonb,
         ${snapshot ? JSON.stringify(snapshot) : null}::jsonb,
         'other-billing')
    `;
  } catch (err) {
    console.error('[dust-ob-audit] write failed:', err.message);
  }
}

/**
 * Diff an old blob against the incoming blob and emit audit entries.
 * Both args are arrays (or null/undefined). Errors are non-fatal.
 */
async function auditObChanges(sql, payload, oldList, newList) {
  if (!payload || !payload.companyCode) return;
  try {
    await _ensureTable(sql);
  } catch (err) {
    console.error('[dust-ob-audit] ensure table failed:', err.message);
    return;
  }

  const oldArr = Array.isArray(oldList) ? oldList : [];
  const newArr = Array.isArray(newList) ? newList : [];

  const oldMap = new Map();
  oldArr.forEach(r => { if (r && r.id) oldMap.set(r.id, r); });
  const newIds = new Set(newArr.map(r => r && r.id).filter(Boolean));

  // DELETEs — rows in old but not in new
  for (const [id, oldRow] of oldMap) {
    if (!newIds.has(id)) {
      await _writeAudit(sql, payload, 'DELETE', id, null, _rowSnapshot(oldRow));
    }
  }

  // INSERTs (no old) and UPDATEs (changed fields)
  for (const r of newArr) {
    if (!r || !r.id) continue;
    const oldRow = oldMap.get(r.id);
    if (!oldRow) {
      await _writeAudit(sql, payload, 'INSERT', r.id, null, _rowSnapshot(r));
    } else {
      const changes = _diffRow(oldRow, r);
      if (Object.keys(changes).length > 0) {
        await _writeAudit(sql, payload, 'UPDATE', r.id, changes, null);
      }
    }
  }
}

module.exports = { auditObChanges, OB_AUDIT_FIELDS };
