'use strict';
/**
 * GET /api/purchase-orders  — all POs with their delivery lines
 * PUT /api/purchase-orders  — full sync: { purchaseOrders: [...] }
 *
 * Field mapping (frontend → DB):
 *   po.po_number       → purchase_orders.po_num
 *   po.title           → purchase_orders.material
 *   po.date_created    → purchase_orders.date_created
 *   po.lines[].id      → po_deliveries.line_id
 *   po.lines[].qty     → po_deliveries.units_delivered
 *   po.lines[].date    → po_deliveries.delivery_date
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
      // Fetch POs and their delivery lines in two queries then stitch together
      const pos = await sql`
        SELECT id, po_num, material AS title, supplier, status, date_created,
               project_id, cost_code, sub_code, notes,
               status_changed_at, status_changed_by,
               total_units, unit_cost, total_cost, created_at
        FROM   purchase_orders
        WHERE  company_code = ${companyCode}
        ORDER  BY created_at DESC
      `;

      if (!pos.length) return res.json({ purchaseOrders: [] });

      const poIds = pos.map(p => p.id);
      const lines = await sql`
        SELECT po_id, line_id AS id, invoice_num, delivery_date AS date,
               units_delivered AS qty, unit_cost, tax, employee, po_row_id, id AS _seq
        FROM   po_deliveries
        WHERE  po_id = ANY(${poIds})
        ORDER  BY po_id, _seq ASC
      `;

      // Group lines by po_id
      const linesByPo = {};
      for (const l of lines) {
        if (!linesByPo[l.po_id]) linesByPo[l.po_id] = [];
        const { po_id, _seq, ...rest } = l;
        // Return date as plain string, qty/unit_cost as numbers matching frontend
        rest.date     = rest.date ? String(rest.date).slice(0, 10) : '';
        rest.qty      = rest.qty      != null ? String(rest.qty)      : '';
        rest.unit_cost = rest.unit_cost != null ? String(rest.unit_cost) : '';
        rest.tax       = rest.tax      != null ? String(rest.tax)      : '';
        linesByPo[l.po_id].push(rest);
      }

      const result = pos.map(po => ({
        id:               po.id,
        po_number:        po.po_num,
        title:            po.title     || '',
        supplier:         po.supplier  || '',
        status:           po.status    || 'pending',
        date_created:     po.date_created ? String(po.date_created).slice(0, 10) : '',
        project_id:       po.project_id   || '',
        cost_code:        po.cost_code    || '',
        sub_code:         po.sub_code     || '',
        notes:            po.notes        || '',
        status_changed_at: po.status_changed_at || null,
        status_changed_by: po.status_changed_by || '',
        lines:            linesByPo[po.id] || [],
      }));

      return res.json({ purchaseOrders: result });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { purchaseOrders } = req.body || {};
      if (!Array.isArray(purchaseOrders)) {
        return res.status(400).json({ error: 'purchaseOrders array required' });
      }

      // Remove POs that were deleted from the frontend list
      const incomingIds = purchaseOrders.map(p => p.id).filter(Boolean);
      if (incomingIds.length) {
        await sql`
          DELETE FROM purchase_orders
          WHERE company_code = ${companyCode} AND id <> ALL(${incomingIds})
        `;
      } else {
        await sql`DELETE FROM purchase_orders WHERE company_code = ${companyCode}`;
      }

      for (const po of purchaseOrders) {
        if (!po || !po.id) continue;

        const lines = Array.isArray(po.lines) ? po.lines : [];

        // Compute totals from lines
        let totalUnits = 0, totalCost = 0;
        for (const l of lines) {
          const q = parseFloat(l.qty)       || 0;
          const u = parseFloat(l.unit_cost) || 0;
          const t = parseFloat(l.tax)       || 0;
          totalUnits += q;
          totalCost  += (q * u) + t;
        }

        await sql`
          INSERT INTO purchase_orders (
            id, company_code, po_num, material, supplier, status,
            date_created, project_id, cost_code, sub_code, notes,
            status_changed_at, status_changed_by,
            total_units, total_cost, updated_at
          ) VALUES (
            ${po.id}, ${companyCode},
            ${po.po_number  || ''},
            ${po.title      || null},
            ${po.supplier   || null},
            ${po.status     || 'pending'},
            ${safeDate(po.date_created)},
            ${po.project_id || null},
            ${po.cost_code  || null},
            ${po.sub_code   || null},
            ${po.notes      || null},
            ${po.status_changed_at || null},
            ${po.status_changed_by || null},
            ${totalUnits}, ${totalCost}, NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            po_num            = EXCLUDED.po_num,
            material          = EXCLUDED.material,
            supplier          = EXCLUDED.supplier,
            status            = EXCLUDED.status,
            date_created      = EXCLUDED.date_created,
            project_id        = EXCLUDED.project_id,
            cost_code         = EXCLUDED.cost_code,
            sub_code          = EXCLUDED.sub_code,
            notes             = EXCLUDED.notes,
            status_changed_at = EXCLUDED.status_changed_at,
            status_changed_by = EXCLUDED.status_changed_by,
            total_units       = EXCLUDED.total_units,
            total_cost        = EXCLUDED.total_cost,
            updated_at        = NOW()
        `;

        // Replace delivery lines for this PO
        await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;
        for (const l of lines) {
          if (!l) continue;
          const qty      = safeFloat(l.qty);
          const unitCost = safeFloat(l.unit_cost);
          const tax      = safeFloat(l.tax) ?? 0;
          const delivCost = ((qty ?? 0) * (unitCost ?? 0)) + tax;
          await sql`
            INSERT INTO po_deliveries (
              po_id, company_code, line_id, invoice_num,
              delivery_date, units_delivered, unit_cost, delivery_cost,
              tax, employee, po_row_id
            ) VALUES (
              ${po.id}, ${companyCode},
              ${l.id   || null},
              ${l.invoice_num || null},
              ${safeDate(l.date)},
              ${qty      ?? 0},
              ${unitCost ?? 0},
              ${delivCost},
              ${tax},
              ${l.employee  || null},
              ${l.po_row_id || null}
            )
          `;
        }
      }

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[purchase-orders]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
