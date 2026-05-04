'use strict';
/**
 * GET /api/dust-rows  — all dust control entries for the company
 * PUT /api/dust-rows  — full sync: { dustRows: [...] }
 *
 * Source of truth: dust_control_entries normalized table.
 * Legacy migration: on first GET, if the table is empty, reads the
 *   app_data blob (dust_rows key) and migrates it into the table,
 *   then deletes the blob. One-time per company.
 *
 * Computed fields (v1Total, ubTotal, invTotal) are derived in the
 * frontend from stored values + the per-company ub_rate setting.
 * They are not stored in the DB to avoid drift.
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

// Idempotent guard so ALTER TABLE only runs once per cold-start
let _columnsEnsured = false;
async function ensureColumns(sql) {
  if (_columnsEnsured) return;
  await sql`ALTER TABLE dust_control_entries ADD COLUMN IF NOT EXISTS cm_approval  TEXT`;
  await sql`ALTER TABLE dust_control_entries ADD COLUMN IF NOT EXISTS inv_location TEXT`;
  _columnsEnsured = true;
}

let _auditEnsured = false;
async function ensureAuditTable(sql) {
  if (_auditEnsured) return;
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
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_company ON dust_control_audit_log(company_code, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_row     ON dust_control_audit_log(row_id)`;
  _auditEnsured = true;
}

// Fields tracked for change-detection in audit log
const AUDIT_FIELDS = [
  'date','start_time','end_time',
  'company','company_man','location','state',
  'vehicle1','v1_unit','v1_rate',
  'vehicle2','v2_unit','v2_rate',
  'gallons_ub',
  'inv_number','inv_sent','inv_received','inv_status',
  'cm_approval','inv_location',
];

function _normForCompare(field, v) {
  if (v == null) return '';
  if (field === 'date' || field === 'inv_sent' || field === 'inv_received') {
    return safeDate(v) || '';
  }
  if (field === 'v1_rate' || field === 'v2_rate' || field === 'gallons_ub') {
    const f = parseFloat(v);
    return isNaN(f) ? '' : String(f);
  }
  return String(v);
}

function _diffRow(oldRow, newRow) {
  const changes = {};
  for (const f of AUDIT_FIELDS) {
    const a = _normForCompare(f, oldRow ? oldRow[f] : '');
    const b = _normForCompare(f, newRow ? newRow[f] : '');
    if (a !== b) changes[f] = { from: a, to: b };
  }
  return changes;
}

function _rowSnapshot(r) {
  if (!r) return null;
  const out = {};
  for (const f of AUDIT_FIELDS) out[f] = _normForCompare(f, r[f]);
  return out;
}

async function _writeAudit(sql, companyCode, payload, action, rowId, changes, snapshot) {
  try {
    await sql`
      INSERT INTO dust_control_audit_log
        (company_code, row_id, action, user_id, username, changes, snapshot)
      VALUES
        (${companyCode}, ${rowId}, ${action},
         ${payload?.userId || null}, ${payload?.username || null},
         ${changes ? JSON.stringify(changes) : null}::jsonb,
         ${snapshot ? JSON.stringify(snapshot) : null}::jsonb)
    `;
  } catch (err) {
    console.error('[dust-rows] audit write failed (non-fatal):', err.message);
  }
}

// One-time recovery: re-insert dust rows that were lost but exist in IC billing.
// Runs once per cold-start; a no-op when nothing is missing.
let _recoveryRun = false;
async function recoverFromIcBilling(sql, companyCode) {
  if (_recoveryRun) return;
  _recoveryRun = true;
  try {
    const missing = await sql`
      SELECT
        ib.source_id         AS id,
        ib.company_name      AS company,
        ib.actual_date       AS date,
        ib.actual_start      AS start_time,
        ib.actual_end        AS end_time,
        ib.company_man,
        ib.location,
        ib.vehicle1, ib.v1_unit, ib.v1_rate,
        ib.vehicle2, ib.v2_unit, ib.v2_rate,
        ib.gallons_ub,
        ib.inv_number, ib.inv_status
      FROM intercompany_billing_entries ib
      WHERE ib.company_code = ${companyCode}
        AND ib.source       = 'dust'
        AND ib.source_id    IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM dust_control_entries dc
          WHERE dc.id = ib.source_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM dust_control_entries dc
          WHERE dc.company_code = ${companyCode}
            AND dc.date         = ib.actual_date
            AND dc.company      = ib.company_name
            AND (
              (COALESCE(ib.actual_start,'') <> '' AND dc.start_time = ib.actual_start)
              OR (COALESCE(ib.actual_start,'') =  '' AND COALESCE(dc.location,'') = COALESCE(ib.location,''))
            )
        )
    `;
    for (const r of missing) {
      await sql`
        INSERT INTO dust_control_entries (
          id, company_code,
          date, start_time, end_time,
          company, company_man, location,
          vehicle1, v1_unit, v1_rate,
          vehicle2, v2_unit, v2_rate,
          gallons_ub, inv_number, inv_status,
          updated_at
        ) VALUES (
          ${r.id}, ${companyCode},
          ${r.date}, ${r.start_time || null}, ${r.end_time || null},
          ${r.company || null}, ${r.company_man || null}, ${r.location || null},
          ${r.vehicle1 || null}, ${r.v1_unit || null}, ${safeFloat(r.v1_rate) ?? null},
          ${r.vehicle2 || null}, ${r.v2_unit || null}, ${safeFloat(r.v2_rate) ?? null},
          ${safeFloat(r.gallons_ub) ?? null}, ${r.inv_number || null}, ${r.inv_status || null},
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;
    }
    if (missing.length > 0) {
      console.log(`[dust-rows] recovered ${missing.length} row(s) from IC billing for ${companyCode}`);
    }
  } catch (err) {
    console.error('[dust-rows] IC billing recovery error (non-fatal):', err.message);
  }
}

function safeFloat(v) {
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return s.length === 10 ? s : null;
}

/** Map a DB dust_control_entries row → frontend row object */
function dbToRow(r) {
  return {
    id:           r.id,
    date:         safeDate(r.date)           || '',
    start_time:   r.start_time   || '',
    end_time:     r.end_time     || '',
    company:      r.company      || '',
    company_man:  r.company_man  || '',
    location:     r.location     || '',
    state:        r.state        || '',
    vehicle1:     r.vehicle1     || '',
    v1_unit:      r.v1_unit      || '',
    v1_rate:      r.v1_rate   != null ? String(r.v1_rate)   : '',
    vehicle2:     r.vehicle2     || '',
    v2_unit:      r.v2_unit      || '',
    v2_rate:      r.v2_rate   != null ? String(r.v2_rate)   : '',
    gallons_ub:   r.gallons_ub != null ? String(r.gallons_ub) : '',
    inv_number:   r.inv_number   || '',
    inv_sent:     safeDate(r.inv_sent)       || '',
    inv_received: safeDate(r.inv_received)   || '',
    inv_status:   r.inv_status   || '',
    cm_approval:  r.cm_approval  || '',
    inv_location: r.inv_location || '',
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    await ensureColumns(sql);
    await ensureAuditTable(sql);
    await recoverFromIcBilling(sql, companyCode);

    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const tableRows = await sql`
        SELECT * FROM dust_control_entries
        WHERE  company_code = ${companyCode}
        ORDER  BY date ASC, created_at ASC
      `;

      if (tableRows.length > 0) {
        return res.json({ dustRows: tableRows.map(dbToRow) });
      }

      // ── One-time migration from legacy JSON blob ──────────────────────
      const blobRows = await sql`
        SELECT value FROM app_data WHERE key = ${companyCode + ':dust_rows'}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];

      if (list.length > 0) {
        try {
          // Skip audit for one-time blob migration to avoid noise
          await _upsertDustRows(sql, companyCode, list, null, { skipAudit: true });
          // Blob data is now in the table — remove the legacy key
          await sql`DELETE FROM app_data WHERE key = ${companyCode + ':dust_rows'}`;
        } catch (err) {
          console.error('[dust-rows] blob migration failed:', err.message);
        }
      }

      return res.json({ dustRows: list });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { dustRows } = req.body || {};
      if (!Array.isArray(dustRows)) {
        return res.status(400).json({ error: 'dustRows array required' });
      }

      await _upsertDustRows(sql, companyCode, dustRows, payload);

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[dust-rows]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

/**
 * Upsert a list of dust rows into dust_control_entries and delete any
 * rows for this company that are no longer in the list.
 *
 * Writes audit entries by diffing the incoming list against the
 * current DB state — INSERT for new ids, UPDATE for changed fields,
 * DELETE for removed ids. Unchanged rows are not logged.
 */
async function _upsertDustRows(sql, companyCode, list, payload, opts) {
  const skipAudit = !!(opts && opts.skipAudit);
  const ids = list.map(r => r && r.id).filter(Boolean);

  // Refuse to delete everything when the client sends an empty list —
  // this prevents accidental wipes if the browser had an empty rows state.
  if (ids.length === 0) return;

  // Snapshot existing DB state for diffing
  const existingRows = skipAudit ? [] : await sql`
    SELECT * FROM dust_control_entries WHERE company_code = ${companyCode}
  `;
  const existingMap = new Map();
  for (const r of existingRows) existingMap.set(r.id, dbToRow(r));

  // Find rows that will be deleted
  const incomingIds = new Set(ids);
  const deleted = [];
  for (const [id, row] of existingMap) {
    if (!incomingIds.has(id)) deleted.push({ id, row });
  }

  await sql`
    DELETE FROM dust_control_entries
    WHERE company_code = ${companyCode} AND id <> ALL(${ids})
  `;

  if (!skipAudit) {
    for (const d of deleted) {
      await _writeAudit(sql, companyCode, payload, 'DELETE', d.id, null, _rowSnapshot(d.row));
    }
  }

  for (const r of list) {
    if (!r || !r.id) continue;

    const oldRow = existingMap.get(r.id) || null;

    await sql`
      INSERT INTO dust_control_entries (
        id, company_code,
        date, start_time, end_time,
        company, company_man, location, state,
        vehicle1, v1_unit, v1_rate,
        vehicle2, v2_unit, v2_rate,
        gallons_ub,
        inv_number, inv_sent, inv_received, inv_status,
        cm_approval, inv_location,
        updated_at
      ) VALUES (
        ${r.id}, ${companyCode},
        ${safeDate(r.date)}, ${r.start_time || null}, ${r.end_time || null},
        ${r.company || null}, ${r.company_man || null}, ${r.location || null}, ${r.state || null},
        ${r.vehicle1 || null}, ${r.v1_unit || null}, ${safeFloat(r.v1_rate) ?? null},
        ${r.vehicle2 || null}, ${r.v2_unit || null}, ${safeFloat(r.v2_rate) ?? null},
        ${safeFloat(r.gallons_ub) ?? null},
        ${r.inv_number || null}, ${safeDate(r.inv_sent)}, ${safeDate(r.inv_received)}, ${r.inv_status || null},
        ${r.cm_approval || null}, ${r.inv_location || null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        date         = EXCLUDED.date,
        start_time   = EXCLUDED.start_time,
        end_time     = EXCLUDED.end_time,
        company      = EXCLUDED.company,
        company_man  = EXCLUDED.company_man,
        location     = EXCLUDED.location,
        state        = EXCLUDED.state,
        vehicle1     = EXCLUDED.vehicle1,
        v1_unit      = EXCLUDED.v1_unit,
        v1_rate      = EXCLUDED.v1_rate,
        vehicle2     = EXCLUDED.vehicle2,
        v2_unit      = EXCLUDED.v2_unit,
        v2_rate      = EXCLUDED.v2_rate,
        gallons_ub   = EXCLUDED.gallons_ub,
        inv_number   = EXCLUDED.inv_number,
        inv_sent     = EXCLUDED.inv_sent,
        inv_received = EXCLUDED.inv_received,
        inv_status   = EXCLUDED.inv_status,
        cm_approval  = EXCLUDED.cm_approval,
        inv_location = EXCLUDED.inv_location,
        updated_at   = NOW()
    `;

    if (skipAudit) continue;

    if (!oldRow) {
      await _writeAudit(sql, companyCode, payload, 'INSERT', r.id, null, _rowSnapshot(r));
    } else {
      const changes = _diffRow(oldRow, r);
      if (Object.keys(changes).length > 0) {
        await _writeAudit(sql, companyCode, payload, 'UPDATE', r.id, changes, null);
      }
    }
  }
}
