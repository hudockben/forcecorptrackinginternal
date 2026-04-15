'use strict';
/**
 * GET /api/purchase-orders  — all POs with their delivery lines
 * PUT /api/purchase-orders  — full sync: { purchaseOrders: [...] }
 *
 * Primary source: purchase_orders + po_deliveries normalized tables.
 * Fallback:       app_data JSON blob (fct_purchase_orders) when tables are
 *                 empty, transparently migrating data on first read.
 *
 * Frontend PO shape:
 *   { id, po_number, date_created, project_id, cost_code, sub_code, title,
 *     supplier, status, notes,
 *     lines: [{ id, invoice_num, date, qty, unit_cost, tax, employee, po_row_id }] }
 *
 * DB shape (purchase_orders + po_deliveries with extra columns added via ALTER TABLE):
 *   purchase_orders: id, po_num (=po_number), title, supplier, cost_code,
 *                    sub_code, project_id, status, notes, date_created
 *   po_deliveries:   line_id (=lines[].id), invoice_num, delivery_date (=date),
 *                    units_delivered (=qty), unit_cost, tax, employee, po_row_id
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
      const poRows = await sql`
        SELECT * FROM purchase_orders
        WHERE  company_code = ${companyCode}
        ORDER  BY created_at ASC
      `;

      if (poRows.length > 0) {
        const poIds = poRows.map(r => r.id);
        const dlRows = await sql`
          SELECT * FROM po_deliveries
          WHERE  po_id = ANY(${poIds})
          ORDER  BY po_id, created_at ASC
        `;

        // Group deliveries by PO
        const linesByPO = {};
        for (const d of dlRows) {
          if (!linesByPO[d.po_id]) linesByPO[d.po_id] = [];
          linesByPO[d.po_id].push({
            id:          d.line_id      || String(d.id),
            invoice_num: d.invoice_num  || '',
            date:        safeDate(d.delivery_date) || '',
            qty:         d.units_delivered != null ? String(d.units_delivered) : '',
            unit_cost:   d.unit_cost       != null ? String(d.unit_cost)       : '',
            tax:         d.tax             != null ? String(d.tax)             : '',
            employee:    d.employee        || '',
            po_row_id:   d.po_row_id       || null,
          });
        }

        const purchaseOrders = poRows.map(r => ({
          id:                    r.id,
          po_number:             r.po_num          || '',
          date_created:          safeDate(r.date_created) || '',
          project_id:            r.project_id      || '',
          cost_code:             r.cost_code        || '',
          sub_code:              r.sub_code         || '',
          title:                 r.title            || '',
          supplier:              r.supplier         || '',
          status:                r.status           || 'pending',
          notes:                 r.notes            || '',
          status_changed_at:     r.status_changed_at ? String(r.status_changed_at) : undefined,
          status_changed_by:     r.status_changed_by || undefined,
          lines:                 linesByPO[r.id]    || [],
        }));

        return res.json({ purchaseOrders });
      }

      // ── Fallback: read from JSON blob ──────────────────────────────────
      const blobRows = await sql`
        SELECT value FROM app_data WHERE key = ${companyCode + ':fct_purchase_orders'}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];

      if (list.length > 0) {
        // Migrate blob into normalized tables — awaited so it completes
        // before the response is sent (serverless functions freeze on return).
        try { await _migratePOBlob(sql, companyCode, list); }
        catch (err) { console.error('[purchase-orders] blob migration failed:', err.message); }
      }

      return res.json({ purchaseOrders: list });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { purchaseOrders } = req.body || {};
      if (!Array.isArray(purchaseOrders)) {
        return res.status(400).json({ error: 'purchaseOrders array required' });
      }

      // Always write to JSON blob first — this is the source of truth.
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${companyCode + ':fct_purchase_orders'}, ${JSON.stringify(purchaseOrders)}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;

      // Mirror to normalized tables (fire-and-forget: FK errors must not block the save)
      _migratePOBlob(sql, companyCode, purchaseOrders).catch(err =>
        console.error('[purchase-orders] normalize failed:', err.message)
      );

      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[purchase-orders]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

async function _migratePOBlob(sql, companyCode, list) {
  const incomingIds = list.map(p => p && p.id).filter(Boolean);

  // Remove POs not in the incoming list
  if (incomingIds.length) {
    await sql`
      DELETE FROM purchase_orders
      WHERE company_code = ${companyCode} AND id <> ALL(${incomingIds})
    `;
  } else {
    await sql`DELETE FROM purchase_orders WHERE company_code = ${companyCode}`;
    return;
  }

  for (const po of list) {
    if (!po || !po.id) continue;

    // Upsert the PO header row
    await sql`
      INSERT INTO purchase_orders (
        id, company_code, po_num, title, supplier, project_id,
        cost_code, sub_code, status, notes,
        date_created, status_changed_at, status_changed_by, updated_at
      ) VALUES (
        ${po.id}, ${companyCode},
        ${po.po_number      || ''},
        ${po.title          || null},
        ${po.supplier       || null},
        ${po.project_id     || null},
        ${po.cost_code      || null},
        ${po.sub_code       || null},
        ${po.status         || 'pending'},
        ${po.notes          || null},
        ${safeDate(po.date_created)},
        ${po.status_changed_at || null},
        ${po.status_changed_by || null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        po_num             = EXCLUDED.po_num,
        title              = EXCLUDED.title,
        supplier           = EXCLUDED.supplier,
        project_id         = EXCLUDED.project_id,
        cost_code          = EXCLUDED.cost_code,
        sub_code           = EXCLUDED.sub_code,
        status             = EXCLUDED.status,
        notes              = EXCLUDED.notes,
        date_created       = EXCLUDED.date_created,
        status_changed_at  = EXCLUDED.status_changed_at,
        status_changed_by  = EXCLUDED.status_changed_by,
        updated_at         = NOW()
    `;

    // Delete old delivery lines for this PO then reinsert
    await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;

    const lines = Array.isArray(po.lines) ? po.lines : [];
    for (const line of lines) {
      if (!line) continue;
      const qty  = safeFloat(line.qty)       ?? 0;
      const uc   = safeFloat(line.unit_cost) ?? 0;
      const tax  = safeFloat(line.tax)       ?? 0;
      await sql`
        INSERT INTO po_deliveries (
          po_id, company_code,
          line_id, invoice_num, delivery_date,
          units_delivered, unit_cost, delivery_cost,
          tax, employee, po_row_id
        ) VALUES (
          ${po.id}, ${companyCode},
          ${line.id        || null},
          ${line.invoice_num || null},
          ${safeDate(line.date)},
          ${qty}, ${uc}, ${qty * uc},
          ${tax},
          ${line.employee  || null},
          ${line.po_row_id || null}
        )
      `;
    }
  }
}
