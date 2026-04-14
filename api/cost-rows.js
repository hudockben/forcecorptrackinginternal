'use strict';
/**
 * GET /api/cost-rows  — all cost tracking rows for the company
 * PUT /api/cost-rows  — full sync: { costRows: [...] }
 *
 * Cost rows use a client-generated numeric id (Date.now() + Math.random())
 * that isn't suitable as a DB primary key. We store it in app_id and use
 * delete-then-reinsert so the DB serial id stays stable per session.
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
        SELECT app_id AS id, cost_code, sub_code, quantity, bid_item_cost, status, description
        FROM   cost_items
        WHERE  company_code = ${companyCode}
        ORDER  BY id ASC
      `;
      // Return numeric id if it was stored as a number, otherwise keep as-is
      const result = rows.map(r => ({
        id:            r.id != null ? Number(r.id) || r.id : undefined,
        cost_code:     r.cost_code     || '',
        sub_code:      r.sub_code      || '',
        quantity:      r.quantity      != null ? String(r.quantity)      : '',
        bid_item_cost: r.bid_item_cost != null ? String(r.bid_item_cost) : '',
        status:        r.status        || 'Active',
        description:   r.description   || '',
      }));
      return res.json({ costRows: result });
    }

    // ── PUT (full replace) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { costRows } = req.body || {};
      if (!Array.isArray(costRows)) {
        return res.status(400).json({ error: 'costRows array required' });
      }

      // Full delete-then-reinsert: cost rows have no stable UUID
      await sql`DELETE FROM cost_items WHERE company_code = ${companyCode}`;

      for (const row of costRows) {
        if (!row) continue;
        await sql`
          INSERT INTO cost_items (
            company_code, app_id, cost_code, sub_code,
            quantity, bid_item_cost, status, description, updated_at
          ) VALUES (
            ${companyCode},
            ${row.id != null ? String(row.id) : null},
            ${row.cost_code     || ''},
            ${row.sub_code      || null},
            ${safeFloat(row.quantity)      ?? 0},
            ${safeFloat(row.bid_item_cost) ?? 0},
            ${row.status      || 'Active'},
            ${row.description || null},
            NOW()
          )
        `;
      }

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[cost-rows]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
