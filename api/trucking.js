'use strict';
/**
 * GET /api/trucking  — all trucking entries for the company
 * PUT /api/trucking  — full sync: { truckingEntries: [...] }
 *
 * Primary source: trucking_entries normalized table.
 * Fallback:       app_data JSON blob (fct_trucking) when table is empty,
 *                 which transparently migrates existing data on first read.
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

function safeFloat(v) {
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

function safeDate(v) {
  if (!v) return null;
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
    date:            r.date ? String(r.date).slice(0, 10) : '',
    material_hauled: r.material_hauled || '',
    loads:           r.loads  != null ? String(r.loads)  : '',
    rate:            r.rate   != null ? String(r.rate)   : '',
    hours:           r.hours  != null ? String(r.hours)  : '',
    status:          r.status          || 'pending',
    notes:           r.notes           || '',
    cost_code:       r.cost_code       || '',
    sub_code:        r.sub_code        || '',
    // Status audit fields
    status_changed_at: r.status_changed_at ? String(r.status_changed_at) : undefined,
    status_changed_by: r.status_changed_by || undefined,
    // Daily-row link
    tr_row_id:       r.tr_row_id       || undefined,
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
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT * FROM trucking_entries
        WHERE  company_code = ${companyCode}
        ORDER  BY created_at ASC
      `;

      if (rows.length > 0) {
        return res.json({ truckingEntries: rows.map(dbToTR) });
      }

      // ── Fallback: read from JSON blob (migrates data on first read) ──
      const blobRows = await sql`
        SELECT value FROM app_data WHERE key = ${companyCode + ':fct_trucking'}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];

      if (list.length > 0) {
        // Migrate blob data into normalized table — awaited so it completes
        // before the response is sent (serverless functions freeze on return).
        try { await _migrateTruckingBlob(sql, companyCode, list); }
        catch (err) { console.error('[trucking] blob migration failed:', err.message); }
      }

      return res.json({ truckingEntries: list });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { truckingEntries } = req.body || {};
      if (!Array.isArray(truckingEntries)) {
        return res.status(400).json({ error: 'truckingEntries array required' });
      }

      // Always write to JSON blob first — this is the source of truth.
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${companyCode + ':fct_trucking'}, ${JSON.stringify(truckingEntries)}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;

      // Mirror to normalized table (fire-and-forget: FK errors must not block the save)
      _migrateTruckingBlob(sql, companyCode, truckingEntries).catch(err =>
        console.error('[trucking] normalize failed:', err.message)
      );

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[trucking]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

async function _migrateTruckingBlob(sql, companyCode, list) {
  const ids = list.map(t => t && t.id).filter(Boolean);

  // Delete removed entries
  if (ids.length) {
    await sql`
      DELETE FROM trucking_entries
      WHERE company_code = ${companyCode} AND id <> ALL(${ids})
    `;
  } else {
    await sql`DELETE FROM trucking_entries WHERE company_code = ${companyCode}`;
    return;
  }

  for (const t of list) {
    if (!t || !t.id) continue;
    await sql`
      INSERT INTO trucking_entries (
        id, company_code, tr_number, driver, truck_type, project_id,
        date, material_hauled, loads, rate, hours, status, notes,
        cost_code, sub_code, tr_row_id, status_changed_at, status_changed_by, updated_at
      ) VALUES (
        ${t.id}, ${companyCode},
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
