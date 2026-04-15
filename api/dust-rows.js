'use strict';
/**
 * GET /api/dust-rows  — all dust control entries for the company
 * PUT /api/dust-rows  — full sync: { dustRows: [...] }
 *
 * Primary source: dust_control_entries normalized table.
 * Fallback:       app_data JSON blob (dust_rows) when table is empty,
 *                 which transparently migrates existing data on first read.
 *
 * Computed fields (v1Total, ubTotal, invTotal) are derived in the
 * frontend from stored values + the per-company ub_rate setting.
 * They are not stored in the DB to avoid drift.
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

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
    date:         safeDate(r.date)         || '',
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
    inv_sent:     safeDate(r.inv_sent)     || '',
    inv_received: safeDate(r.inv_received) || '',
    inv_status:   r.inv_status   || '',
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
      const tableRows = await sql`
        SELECT * FROM dust_control_entries
        WHERE  company_code = ${companyCode}
        ORDER  BY date ASC, created_at ASC
      `;

      if (tableRows.length > 0) {
        return res.json({ dustRows: tableRows.map(dbToRow) });
      }

      // ── Fallback: read from JSON blob (migrates data on first read) ──
      const blobRows = await sql`
        SELECT value FROM app_data WHERE key = ${companyCode + ':dust_rows'}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];

      if (list.length > 0) {
        // Awaited so migration completes before response (serverless freeze-on-return)
        try { await _migrateDustBlob(sql, companyCode, list); }
        catch (err) { console.error('[dust-rows] blob migration failed:', err.message); }
      }

      return res.json({ dustRows: list });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { dustRows } = req.body || {};
      if (!Array.isArray(dustRows)) {
        return res.status(400).json({ error: 'dustRows array required' });
      }

      // Always write to JSON blob first — this is the source of truth.
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${companyCode + ':dust_rows'}, ${JSON.stringify(dustRows)}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;

      // Mirror to normalized table (fire-and-forget: FK errors must not block the save)
      _migrateDustBlob(sql, companyCode, dustRows).catch(err =>
        console.error('[dust-rows] normalize failed:', err.message)
      );

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[dust-rows]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

async function _migrateDustBlob(sql, companyCode, list) {
  const ids = list.map(r => r && r.id).filter(Boolean);

  // Delete rows removed from the list
  if (ids.length) {
    await sql`
      DELETE FROM dust_control_entries
      WHERE company_code = ${companyCode} AND id <> ALL(${ids})
    `;
  } else {
    await sql`DELETE FROM dust_control_entries WHERE company_code = ${companyCode}`;
    return;
  }

  for (const r of list) {
    if (!r || !r.id) continue;
    await sql`
      INSERT INTO dust_control_entries (
        id, company_code,
        date, start_time, end_time,
        company, company_man, location, state,
        vehicle1, v1_unit, v1_rate,
        vehicle2, v2_unit, v2_rate,
        gallons_ub,
        inv_number, inv_sent, inv_received, inv_status,
        updated_at
      ) VALUES (
        ${r.id}, ${companyCode},
        ${safeDate(r.date)}, ${r.start_time || null}, ${r.end_time || null},
        ${r.company || null}, ${r.company_man || null}, ${r.location || null}, ${r.state || null},
        ${r.vehicle1 || null}, ${r.v1_unit || null}, ${safeFloat(r.v1_rate) ?? null},
        ${r.vehicle2 || null}, ${r.v2_unit || null}, ${safeFloat(r.v2_rate) ?? null},
        ${safeFloat(r.gallons_ub) ?? null},
        ${r.inv_number || null}, ${safeDate(r.inv_sent)}, ${safeDate(r.inv_received)}, ${r.inv_status || null},
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
        updated_at   = NOW()
    `;
  }
}
