'use strict';
/**
 * GET /api/scale-manual  — all scale-of-economy manual entries
 * PUT /api/scale-manual  — full sync: { scaleManualEntries: [...] }
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

function safeFloat(v) {
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
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
        SELECT id, label, cost_code, sub_code,
               run_qty, total_cost, labor_hrs, equip_hrs,
               bid_qty, bid_unit_cost, created_at
        FROM   scale_manual_entries
        WHERE  company_code = ${companyCode}
        ORDER  BY created_at DESC
      `;
      const result = rows.map(r => ({
        ...r,
        created_at: r.created_at instanceof Date
          ? r.created_at.toISOString().slice(0, 10)
          : (r.created_at ? String(r.created_at).slice(0, 10) : ''),
      }));
      return res.json({ scaleManualEntries: result });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { scaleManualEntries } = req.body || {};
      if (!Array.isArray(scaleManualEntries)) {
        return res.status(400).json({ error: 'scaleManualEntries array required' });
      }

      // Delete removed entries
      const incomingIds = scaleManualEntries.map(e => e && e.id).filter(Boolean);
      if (incomingIds.length) {
        await sql`
          DELETE FROM scale_manual_entries
          WHERE company_code = ${companyCode} AND id <> ALL(${incomingIds})
        `;
      } else {
        await sql`DELETE FROM scale_manual_entries WHERE company_code = ${companyCode}`;
      }

      // Upsert each entry
      for (const e of scaleManualEntries) {
        if (!e || !e.id) continue;
        await sql`
          INSERT INTO scale_manual_entries (
            id, company_code, label, cost_code, sub_code,
            run_qty, total_cost, labor_hrs, equip_hrs,
            bid_qty, bid_unit_cost, created_at
          ) VALUES (
            ${e.id}, ${companyCode},
            ${e.label     || null},
            ${e.cost_code || null},
            ${e.sub_code  || null},
            ${safeFloat(e.run_qty)},
            ${safeFloat(e.total_cost)},
            ${safeFloat(e.labor_hrs)},
            ${safeFloat(e.equip_hrs)},
            ${safeFloat(e.bid_qty)},
            ${safeFloat(e.bid_unit_cost)},
            ${e.created_at ? String(e.created_at).slice(0, 10) : null}
          )
          ON CONFLICT (id) DO UPDATE SET
            label         = EXCLUDED.label,
            cost_code     = EXCLUDED.cost_code,
            sub_code      = EXCLUDED.sub_code,
            run_qty       = EXCLUDED.run_qty,
            total_cost    = EXCLUDED.total_cost,
            labor_hrs     = EXCLUDED.labor_hrs,
            equip_hrs     = EXCLUDED.equip_hrs,
            bid_qty       = EXCLUDED.bid_qty,
            bid_unit_cost = EXCLUDED.bid_unit_cost
        `;
      }

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[scale-manual]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
