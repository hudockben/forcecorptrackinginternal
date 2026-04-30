'use strict';
/**
 * GET /api/trucking?division=turf  — all trucking entries for a division
 * PUT /api/trucking?division=turf  — full sync: { truckingEntries: [...] }
 *
 * `division` defaults to 'turf' for backward compatibility.
 * Primary source: trucking_entries normalized table (filtered by division).
 * Fallback:       app_data JSON blob (fct_trucking:<division>) when table is empty.
 */
const { neon }            = require('@neondatabase/serverless');
const { requireDivision } = require('./lib/auth');

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

/** Map a DB trucking_entries row → frontend truckingEntry object */
function dbToTR(r) {
  return {
    id:              r.id,
    tr_number:       r.tr_number       || '',
    driver:          r.driver          || '',
    truck_type:      r.truck_type      || '',
    project_id:      r.project_id      || '',
    date:            safeDate(r.date) || '',
    material_hauled: r.material_hauled || '',
    loads:           r.loads  != null ? String(r.loads)  : '',
    rate:            r.rate   != null ? String(r.rate)   : '',
    hours:           r.hours  != null ? String(r.hours)  : '',
    status:          r.status          || 'pending',
    notes:           r.notes           || '',
    cost_code:       r.cost_code       || '',
    sub_code:        r.sub_code        || '',
    status_changed_at: r.status_changed_at ? String(r.status_changed_at) : undefined,
    status_changed_by: r.status_changed_by || undefined,
    tr_row_id:       r.tr_row_id       || undefined,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = requireDivision(req, res);
  if (!guard) return;
  const { payload, division } = guard;

  const { companyCode } = payload;
  const blobKey  = `${companyCode}:fct_trucking:${division}`;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // JSON blob is the source of truth — PUT always awaits a write to it.
      const blobRows = await sql`
        SELECT value FROM app_data WHERE key = ${blobKey}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];

      if (list.length > 0) {
        return res.json({ truckingEntries: list });
      }

      // ── Fallback: normalized table filtered by division ──
      const rows = await sql`
        SELECT * FROM trucking_entries
        WHERE  company_code = ${companyCode} AND division = ${division}
        ORDER  BY created_at ASC
      `;

      return res.json({ truckingEntries: rows.map(dbToTR) });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { truckingEntries } = req.body || {};
      if (!Array.isArray(truckingEntries)) {
        return res.status(400).json({ error: 'truckingEntries array required' });
      }

      // Always write to the division-specific JSON blob first — source of truth.
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${blobKey}, ${JSON.stringify(truckingEntries)}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;

      // Mirror to normalized table — awaited before response so serverless doesn't kill it.
      try { await _syncTrucking(sql, companyCode, division, truckingEntries); }
      catch (err) { console.error('[trucking] normalize failed:', err.message); }

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[trucking]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

async function _syncTrucking(sql, companyCode, division, list) {
  const ids = list.map(t => t && t.id).filter(Boolean);

  if (ids.length) {
    await sql`
      DELETE FROM trucking_entries
      WHERE company_code = ${companyCode} AND division = ${division}
        AND id <> ALL(${ids})
    `;
  } else {
    await sql`
      DELETE FROM trucking_entries
      WHERE company_code = ${companyCode} AND division = ${division}
    `;
    return;
  }

  for (const t of list) {
    if (!t || !t.id) continue;
    await sql`
      INSERT INTO trucking_entries (
        id, company_code, division, tr_number, driver, truck_type, project_id,
        date, material_hauled, loads, rate, hours, status, notes,
        cost_code, sub_code, tr_row_id, status_changed_at, status_changed_by, updated_at
      ) VALUES (
        ${t.id}, ${companyCode}, ${division},
        ${t.tr_number        || null},
        ${t.driver           || null},
        ${t.truck_type       || null},
        ${t.project_id       || null},
        ${safeDate(t.date)},
        ${t.material_hauled  || null},
        ${safeFloat(t.loads)  ?? null},
        ${safeFloat(t.rate)   ?? null},
        ${safeFloat(t.hours)  ?? null},
        ${t.status || 'pending'},
        ${t.notes  || null},
        ${t.cost_code || null},
        ${t.sub_code  || null},
        ${t.tr_row_id || null},
        ${t.status_changed_at || null},
        ${t.status_changed_by || null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        division           = EXCLUDED.division,
        tr_number          = EXCLUDED.tr_number,
        driver             = EXCLUDED.driver,
        truck_type         = EXCLUDED.truck_type,
        project_id         = EXCLUDED.project_id,
        date               = EXCLUDED.date,
        material_hauled    = EXCLUDED.material_hauled,
        loads              = EXCLUDED.loads,
        rate               = EXCLUDED.rate,
        hours              = EXCLUDED.hours,
        status             = EXCLUDED.status,
        notes              = EXCLUDED.notes,
        cost_code          = EXCLUDED.cost_code,
        sub_code           = EXCLUDED.sub_code,
        tr_row_id          = EXCLUDED.tr_row_id,
        status_changed_at  = EXCLUDED.status_changed_at,
        status_changed_by  = EXCLUDED.status_changed_by,
        updated_at         = NOW()
    `;
  }
}
