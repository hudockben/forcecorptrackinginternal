'use strict';
/**
 * GET /api/dust-rows  — all dust control entries for the company
 * PUT /api/dust-rows  — upsert rows: { dustRows: [...], deletedIds?: [...] }
 *
 * If `deletedIds` is provided in the payload, only those rows are deleted
 * (safe partial-update mode used by current frontend).
 * If `deletedIds` is omitted, falls back to legacy full-sync behavior
 * (deletes any row whose id is not in `dustRows`) for backwards
 * compatibility with older clients and the one-time blob migration.
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
// Rows payroll injected when it approved a dust customer haul. This tab does not
// own them: it may fill in the invoice sub-row and nothing else, it may not
// delete them, and a stale save must not resurrect one payroll has withdrawn.
// See the header of lib/dust-injected.js.
const {
  isInjectedDustRowId,
  mergeInjectedDustRows,
  sweepInjectedDustRows,
} = require('./lib/dust-injected');

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
      source        TEXT        NOT NULL DEFAULT 'tracking',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE dust_control_audit_log ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tracking'`;
  await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_company     ON dust_control_audit_log(company_code, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_row         ON dust_control_audit_log(row_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_dust_audit_company_src ON dust_control_audit_log(company_code, source, created_at DESC)`;
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
        (company_code, row_id, action, user_id, username, changes, snapshot, source)
      VALUES
        (${companyCode}, ${rowId}, ${action},
         ${payload?.userId || null}, ${payload?.username || null},
         ${changes ? JSON.stringify(changes) : null}::jsonb,
         ${snapshot ? JSON.stringify(snapshot) : null}::jsonb,
         'tracking')
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
        -- Never rebuild a payroll-injected row. This recovery exists for rows
        -- lost to a blob overwrite, where a surviving billing entry is the only
        -- copy left. An injected row's absence means the opposite: payroll
        -- un-approved or deleted the timesheet entry behind it, and recreating
        -- it would resurrect withdrawn work under an id the tab won't let anyone
        -- delete. Their billing entries are swept with the row (deleteDustRows),
        -- so this is a belt-and-braces guard against one that outlived it.
        AND ib.source_id NOT LIKE 'tsd-%'
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

      // Self-healing on read: a payroll row whose timesheet entry was deleted,
      // un-approved or edited onto another division is one nobody can remove —
      // the tab refuses to delete payroll rows, and payroll can only un-approve
      // an entry that still exists. Costs one indexed lookup, and only when
      // injected rows are actually present.
      const answer = async rows => {
        const { rows: live } = await sweepInjectedDustRows(sql, companyCode, rows.map(dbToRow));
        return res.json({ dustRows: live });
      };

      // Whether the legacy blob still needs importing is a question about rows
      // this tab OWNS, not about rows in the table. Payroll can now put the
      // first row into a table that has never been migrated, and gating on "any
      // row at all" would stand that one row up as proof the import had already
      // happened — stranding the office's entire history in the blob forever,
      // with the tab showing a single injected row where a thousand belong.
      if (tableRows.some(r => !isInjectedDustRowId(r.id))) {
        return answer(tableRows);
      }

      // ── One-time migration from legacy JSON blob ──────────────────────
      const blobRows = await sql`
        SELECT value FROM app_data WHERE key = ${companyCode + ':dust_rows'}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];

      if (list.length === 0) return answer(tableRows);

      try {
        // Skip audit for the one-time blob migration to avoid noise, and pass an
        // empty deletedIds so it runs in partial-update mode: the default
        // full-sync would take "the blob is the whole truth" literally and
        // delete every payroll row already sitting in the table.
        await _upsertDustRows(sql, companyCode, list, null, { skipAudit: true, deletedIds: [] });
        // Blob data is now in the table — remove the legacy key
        await sql`DELETE FROM app_data WHERE key = ${companyCode + ':dust_rows'}`;
      } catch (err) {
        console.error('[dust-rows] blob migration failed:', err.message);
        // The import did not land, so answer from the blob as before rather than
        // reporting the table's lone payroll row as the company's dust history.
        return res.json({ dustRows: list });
      }

      // Re-read so the answer carries the migrated rows AND any payroll rows
      // that were already in the table.
      const migrated = await sql`
        SELECT * FROM dust_control_entries
        WHERE  company_code = ${companyCode}
        ORDER  BY date ASC, created_at ASC
      `;
      return answer(migrated);
    }

    // ── PUT (upsert + explicit deletes) ───────────────────────────────────
    if (req.method === 'PUT') {
      const { dustRows, deletedIds } = req.body || {};
      if (!Array.isArray(dustRows)) {
        return res.status(400).json({ error: 'dustRows array required' });
      }

      // When the client passes `deletedIds`, run in safe partial-update mode:
      // only the explicitly listed ids are removed. Otherwise fall back to the
      // legacy full-sync behavior so older clients continue to work.
      //
      // Either way an injected row is never deletable from here. The tab already
      // hides its delete button, so a listed id is a stale client or a hand-made
      // request; honouring it would strip cost off an approved timesheet with
      // nothing in payroll to show for it.
      const askedDeletes = Array.isArray(deletedIds) ? deletedIds.filter(Boolean) : null;
      const safeDeletes  = askedDeletes ? askedDeletes.filter(id => !isInjectedDustRowId(id)) : null;
      if (askedDeletes && safeDeletes.length !== askedDeletes.length) {
        console.warn(
          `[dust-rows] refused ${askedDeletes.length - safeDeletes.length} delete(s) of payroll-injected row(s) for ${companyCode} — un-approve the timesheet entry instead`
        );
      }
      const opts = safeDeletes ? { deletedIds: safeDeletes } : undefined;

      // A save that carries no rows and asks for no deletes means "do nothing".
      // _upsertDustRows has always had that safety net, keyed on its list being
      // empty — but the guard below adds the server's own injected rows back, so
      // an empty save would arrive there looking non-empty and fall through to
      // the legacy full-sync DELETE, taking out every MANUAL row in the company.
      // The net therefore has to be judged on what the CLIENT sent, here, before
      // anything is merged into it.
      if (dustRows.length === 0 && (!safeDeletes || safeDeletes.length === 0)) {
        return res.json({ ok: true });
      }

      const guarded = await _guardInjectedRows(sql, companyCode, dustRows);
      await _upsertDustRows(sql, companyCode, guarded.rows, payload, opts);

      // `withdrawn` names the payroll rows this save carried that no longer
      // exist. The tab has to forget them before it reconciles Intercompany off
      // its own copy — see _guardInjectedRows.
      return res.json({ ok: true, withdrawn: guarded.withdrawn });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[dust-rows]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

/**
 * Reconcile one whole-list save from the tab against the payroll rows the server
 * currently holds, and return the list to actually write.
 *
 * The tab PUTs every row it has, and its copy of a payroll row is always the
 * stale one — it was read before the approval that is about to land on top of
 * it. Without this, the tab's next debounced save after any cell edit would:
 *   - drop a row payroll injected while the page was open (the hours never reach
 *     the tab or the invoice, and nobody can add the row back by hand), or
 *   - put back a row payroll un-approved, re-billing withdrawn work.
 *
 * So the payroll columns are taken from the SERVER's copy and the invoice
 * sub-row (DUST_TAB_FIELDS) is replayed from the incoming one — the same rule,
 * for the same reason, that injected-blob-guard.js applies to the blob-backed
 * division tabs and daily-rows.js to turf/paving.
 */
async function _guardInjectedRows(sql, companyCode, incoming) {
  const list = Array.isArray(incoming) ? incoming : [];
  const serverRows = await sql`
    SELECT * FROM dust_control_entries
    WHERE company_code = ${companyCode} AND id LIKE 'tsd-%'
  `;
  // Nothing injected on either side — the common case, and a no-op.
  if (!serverRows.length && !list.some(r => r && isInjectedDustRowId(r.id))) {
    return { rows: list, withdrawn: [] };
  }

  const merged = mergeInjectedDustRows(serverRows.map(dbToRow), list);
  const inIds  = new Set(list.filter(r => r && isInjectedDustRowId(r.id)).map(r => String(r.id)));
  const srvIds = new Set(serverRows.map(r => String(r.id)));
  let restored = 0;
  // Payroll rows the SAVE still carried that the server no longer has: payroll
  // un-approved or deleted the entry while this tab had the page open. Dropping
  // them from the write is only half the job — the tab's in-memory copy still
  // holds them, and its Intercompany reconciler runs off that copy straight
  // after this call, re-creating a billing entry for a row that no longer
  // exists. Nothing would ever remove that entry again: the sweep only looks at
  // rows, and the IC-recovery path deliberately skips injected ids. So the
  // withdrawn ids go back to the client, which drops them before reconciling.
  const withdrawn = [...inIds].filter(id => !srvIds.has(id));
  for (const id of srvIds) if (!inIds.has(id)) restored++;
  if (restored || withdrawn.length) {
    console.warn(
      `[dust-rows] ${companyCode}: kept ${restored} payroll row(s) the save omitted, ` +
      `ignored ${withdrawn.length} the save carried that payroll no longer has`
    );
  }
  return { rows: merged, withdrawn };
}

/**
 * Upsert a list of dust rows into dust_control_entries.
 *
 * Two delete modes:
 *  - opts.deletedIds (preferred): only the listed ids are removed.
 *    Rows present in the DB but missing from `list` are left alone.
 *    This prevents data loss when the client's in-memory state is
 *    out of sync (concurrent edits, polling races, partial loads).
 *  - legacy (no deletedIds): full-sync — removes any DB row whose id
 *    is not in `list`. Kept for backwards compatibility.
 *
 * Writes audit entries by diffing the incoming list against the
 * current DB state — INSERT for new ids, UPDATE for changed fields,
 * DELETE for removed ids. Unchanged rows are not logged.
 */
async function _upsertDustRows(sql, companyCode, list, payload, opts) {
  const skipAudit       = !!(opts && opts.skipAudit);
  const explicitDeletes = !!(opts && Array.isArray(opts.deletedIds));
  const deletedIds      = explicitDeletes ? opts.deletedIds : [];
  const ids = list.map(r => r && r.id).filter(Boolean);

  // Nothing to do — no upserts and no explicit deletes.
  if (ids.length === 0 && (!explicitDeletes || deletedIds.length === 0)) return;

  // Snapshot existing DB state for diffing
  const existingRows = skipAudit ? [] : await sql`
    SELECT * FROM dust_control_entries WHERE company_code = ${companyCode}
  `;
  const existingMap = new Map();
  for (const r of existingRows) existingMap.set(r.id, dbToRow(r));

  // Determine which ids will actually be deleted
  const deleted = [];
  if (explicitDeletes) {
    // Safe mode: only delete what the client explicitly asked to delete,
    // and never delete an id that's also in the upsert list (defensive).
    const incomingIds = new Set(ids);
    for (const id of deletedIds) {
      if (!id || incomingIds.has(id)) continue;
      const row = existingMap.get(id);
      if (row) deleted.push({ id, row });
    }
    if (deleted.length > 0) {
      const delIds = deleted.map(d => d.id);
      await sql`
        DELETE FROM dust_control_entries
        WHERE company_code = ${companyCode} AND id = ANY(${delIds})
      `;
    }
  } else {
    // Legacy full-sync mode
    const incomingIds = new Set(ids);
    for (const [id, row] of existingMap) {
      if (!incomingIds.has(id)) deleted.push({ id, row });
    }
    await sql`
      DELETE FROM dust_control_entries
      WHERE company_code = ${companyCode} AND id <> ALL(${ids})
    `;
  }

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
