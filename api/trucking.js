'use strict';
/**
 * GET /api/trucking  — all trucking entries for the company
 * PUT /api/trucking  — full sync: { truckingEntries: [...] }
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

module.exports = async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, tr_number, driver, truck_type, project_id,
               date, material_hauled, loads, rate, hours,
               status, notes, cost_code, sub_code
        FROM   trucking_entries
        WHERE  company_code = ${companyCode}
        ORDER  BY date DESC, created_at DESC
      `;
      // Normalise numeric fields to strings to match frontend expectation
      const result = rows.map(r => ({
        ...r,
        date:  r.date  ? String(r.date).slice(0, 10) : '',
        loads: r.loads != null ? String(r.loads) : '',
        rate:  r.rate  != null ? String(r.rate)  : '',
        hours: r.hours != null ? String(r.hours) : '',
      }));
      return res.json({ truckingEntries: result });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { truckingEntries } = req.body || {};
      if (!Array.isArray(truckingEntries)) {
        return res.status(400).json({ error: 'truckingEntries array required' });
      }

      // Delete rows removed from the frontend list
      const incomingIds = truckingEntries.map(t => t && t.id).filter(Boolean);
      if (incomingIds.length) {
        await sql`
          DELETE FROM trucking_entries
          WHERE company_code = ${companyCode} AND id <> ALL(${incomingIds})
        `;
      } else {
        await sql`DELETE FROM trucking_entries WHERE company_code = ${companyCode}`;
      }

      // Upsert each entry
      for (const t of truckingEntries) {
        if (!t || !t.id) continue;
        await sql`
          INSERT INTO trucking_entries (
            id, company_code, tr_number, driver, truck_type, project_id,
            date, material_hauled, loads, rate, hours,
            status, notes, cost_code, sub_code, updated_at
          ) VALUES (
            ${t.id}, ${companyCode},
            ${t.tr_number       || null},
            ${t.driver          || null},
            ${t.truck_type      || null},
            ${t.project_id      || null},
            ${safeDate(t.date)},
            ${t.material_hauled || null},
            ${safeFloat(t.loads)},
            ${safeFloat(t.rate)},
            ${safeFloat(t.hours)},
            ${t.status || 'pending'},
            ${t.notes  || null},
            ${t.cost_code || null},
            ${t.sub_code  || null},
            NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            tr_number       = EXCLUDED.tr_number,
            driver          = EXCLUDED.driver,
            truck_type      = EXCLUDED.truck_type,
            project_id      = EXCLUDED.project_id,
            date            = EXCLUDED.date,
            material_hauled = EXCLUDED.material_hauled,
            loads           = EXCLUDED.loads,
            rate            = EXCLUDED.rate,
            hours           = EXCLUDED.hours,
            status          = EXCLUDED.status,
            notes           = EXCLUDED.notes,
            cost_code       = EXCLUDED.cost_code,
            sub_code        = EXCLUDED.sub_code,
            updated_at      = NOW()
        `;
      }

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[trucking]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
