'use strict';
/**
 * GET    /api/purchase-orders?division=turf          — all POs for a division
 * PUT    /api/purchase-orders?division=turf          — full sync: { purchaseOrders: [...] }
 * POST   /api/purchase-orders?division=turf          — upsert ONE: { purchaseOrder: {...} }
 * DELETE /api/purchase-orders?division=turf&id=X     — remove ONE
 *
 * GET and PUT are what the division tabs have always used: each page owns its
 * division's list and rewrites the whole thing.
 *
 * POST and DELETE exist for central purchasing (purchase-orders.html), which
 * writes into turf, paving and kiewit and so must never rewrite a list it does
 * not own — a full PUT from it would erase whatever that division's own tab had
 * saved since it loaded. They touch one order, under a compare-and-set, and
 * reconcile that order's job cost rows server-side. See api/lib/po-sync.js.
 *
 * Read and single-order write resolve access through canAccessPODivision, so a
 * purchasing user reaches the source divisions' lists. The full-list PUT keeps
 * the plain division check: only a division's own people may replace its list.
 *
 * The `division` query param defaults to 'turf' for backward compatibility.
 * Each division's POs are stored separately in both the normalized table
 * (purchase_orders.division column) and the blob
 * (app_data key = companyCode:fct_purchase_orders:<division>).
 *
 * Frontend PO shape:
 *   { id, po_number, date_created, project_id, cost_code, sub_code, title,
 *     supplier, status, notes,
 *     lines: [{ id, invoice_num, date, qty, unit_cost, tax, tax_pct, employee,
 *              po_row_id }] }
 *
 * `tax_pct` is what the user types (a percentage of qty × unit_cost); `tax` is
 * the dollar amount it works out to, kept in sync by the frontend. Only `tax`
 * is mirrored to po_deliveries — the JSON blob carries `tax_pct` and is the
 * source of truth on read, so the normalized fallback below losing it is fine:
 * the frontend re-derives the percentage from the dollar amount.
 */
const { neon } = require('@neondatabase/serverless');
const {
  requireAuth,
  requireDivision,
  normalizeDivision,
  canAccessPODivision,
} = require('./lib/auth');
const poSync = require('./lib/po-sync');

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

/**
 * Which access check this request gets.
 *
 * The full-list PUT stays on requireDivision: replacing a division's entire
 * purchase-order list is something only that division's own people may do, and
 * widening it would hand central purchasing a way to wipe paving's list in one
 * call. Everything else — reading, and the single-order writes purchasing makes
 * — goes through canAccessPODivision.
 *
 * The turf default is kept for GET and PUT because tracker.html has always
 * relied on it. A single-order write has to name its division: purchasing is
 * the only caller, and one that guessed would file the order against the wrong
 * division's jobs.
 */
function _guardFor(req, res) {
  if (req.method === 'PUT') return requireDivision(req, res);

  const payload = requireAuth(req, res);
  if (!payload) return null;

  const raw = (req.query && req.query.division) || (req.body && req.body.division) || null;
  const division = normalizeDivision(raw);
  if (!division) {
    if (req.method !== 'GET') {
      res.status(400).json({ error: 'division query param is required' });
      return null;
    }
    if (!canAccessPODivision(payload, 'turf')) {
      res.status(403).json({ error: 'You do not have access to this division' });
      return null;
    }
    return { payload, division: 'turf' };
  }
  if (!canAccessPODivision(payload, division)) {
    res.status(403).json({ error: 'You do not have access to this division' });
    return null;
  }
  return { payload, division };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = _guardFor(req, res);
  if (!guard) return;
  const { payload, division } = guard;

  const { companyCode } = payload;
  const blobKey  = `${companyCode}:fct_purchase_orders:${division}`;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // The JSON blob is the source of truth (PUT always awaits a write to it).
      const blobRows = await sql`
        SELECT value FROM app_data WHERE key = ${blobKey}
      `;
      const blob = blobRows.length ? blobRows[0].value : null;
      const list = Array.isArray(blob) ? blob : [];

      if (list.length > 0) {
        return res.json({ purchaseOrders: list });
      }

      // ── Fallback: read from normalized table filtered by division ─────
      const poRows = await sql`
        SELECT * FROM purchase_orders
        WHERE  company_code = ${companyCode} AND division = ${division}
        ORDER  BY created_at ASC
      `;

      if (poRows.length === 0) {
        return res.json({ purchaseOrders: [] });
      }

      const poIds = poRows.map(r => r.id);
      const dlRows = await sql`
        SELECT * FROM po_deliveries
        WHERE  po_id = ANY(${poIds})
        ORDER  BY po_id, created_at ASC
      `;

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
        id:                r.id,
        po_number:         r.po_num          || '',
        date_created:      safeDate(r.date_created) || '',
        project_id:        r.project_id      || '',
        cost_code:         r.cost_code       || '',
        sub_code:          r.sub_code        || '',
        title:             r.title           || '',
        supplier:          r.supplier        || '',
        status:            r.status          || 'pending',
        notes:             r.notes           || '',
        origin:            r.origin          || undefined,
        status_changed_at: r.status_changed_at ? String(r.status_changed_at) : undefined,
        status_changed_by: r.status_changed_by || undefined,
        lines:             linesByPO[r.id]   || [],
      }));

      return res.json({ purchaseOrders });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { purchaseOrders } = req.body || {};
      if (!Array.isArray(purchaseOrders)) {
        return res.status(400).json({ error: 'purchaseOrders array required' });
      }

      // Bulk-wipe protection: empty incoming list against an existing
      // non-trivial blob is almost always a client bug. Single-row deletes
      // still work. Override with ?force=1 for genuine wipes.
      if (purchaseOrders.length === 0 && req.query.force !== '1') {
        const existing = await sql`SELECT value FROM app_data WHERE key = ${blobKey}`;
        const existingArr = Array.isArray(existing[0]?.value) ? existing[0].value : null;
        if (existingArr && existingArr.length > 1) {
          console.warn(`[purchase-orders] refused empty PUT: would have wiped ${existingArr.length} POs for ${blobKey}`);
          return res.status(409).json({
            error: 'Refusing to wipe purchase orders',
            detail: `Cannot replace ${existingArr.length} POs with an empty list. Pass ?force=1 to override.`,
          });
        }
      }

      // Always write to the division-specific JSON blob first — source of truth.
      await sql`
        INSERT INTO app_data (key, value, updated_at)
        VALUES (${blobKey}, ${JSON.stringify(purchaseOrders)}::jsonb, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;

      // Mirror to normalized table (awaited so serverless doesn't kill it).
      try { await _syncPOs(sql, companyCode, division, purchaseOrders); }
      catch (err) { console.error('[purchase-orders] normalize failed:', err.message); }

      return res.json({ ok: true });
    }

    // ── POST (upsert one) ─────────────────────────────────────────────────
    // What central purchasing saves with. One order, merged into this
    // division's list under a compare-and-set, with its job cost rows
    // reconciled in the same call.
    if (req.method === 'POST') {
      const po = (req.body || {}).purchaseOrder;
      if (!po || typeof po !== 'object' || Array.isArray(po)) {
        return res.status(400).json({ error: 'purchaseOrder object required' });
      }
      if (!po.id) {
        return res.status(400).json({ error: 'purchaseOrder.id is required' });
      }
      if (po.lines != null && !Array.isArray(po.lines)) {
        return res.status(400).json({ error: 'purchaseOrder.lines must be an array' });
      }

      // The division the order was stored under before this save. Purchasing
      // sends it when someone re-ties an order to a different division, so the
      // order moves lists instead of existing in two at once.
      const from = normalizeDivision(req.query.from);
      if (req.query.from && !from) {
        return res.status(400).json({ error: 'Unknown `from` division' });
      }
      if (from && from !== division && !canAccessPODivision(payload, from)) {
        return res.status(403).json({ error: 'You do not have access to the division this order is moving from' });
      }

      const result = await poSync.upsertPO(sql, {
        companyCode,
        division,
        po: { ...po, lines: Array.isArray(po.lines) ? po.lines : [] },
        from,
      });
      if (!result.ok) {
        return res.status(409).json({
          error: 'Purchase order not saved',
          detail: 'Someone else is editing this division\'s purchase orders right now. Try again.',
        });
      }
      // The saved order goes back because syncPOCostRows mints po_row_id on any
      // line that did not have one. A client that kept its own copy instead
      // would create a second cost row for that line on the next save.
      //
      // staleCopy means the order saved but the division it moved FROM still
      // lists it. The client keeps its record of where the order was last
      // stored so the next save repeats the move — see savePO in
      // purchase-orders.html.
      return res.json({
        ok: true,
        purchaseOrder: result.purchaseOrder,
        rows: result.rows,
        staleCopy: Boolean(result.staleCopy),
      });
    }

    // ── DELETE (one) ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id query param is required' });

      const result = await poSync.removePO(sql, { companyCode, division, poId: id });
      if (!result.ok) {
        return res.status(409).json({
          error: 'Purchase order not deleted',
          detail: 'Someone else is editing this division\'s purchase orders right now. Try again.',
        });
      }
      return res.json({ ok: true, found: result.found, rowsRemoved: result.rowsRemoved });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[purchase-orders]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

async function _syncPOs(sql, companyCode, division, list) {
  const incomingIds = list.map(p => p && p.id).filter(Boolean);

  // Defense in depth: even if an empty list slips past the upstream guard,
  // refuse to wipe the mirror table — leaves a recovery option intact.
  if (incomingIds.length === 0) return;

  // Remove POs for this division that are no longer in the list
  await sql`
    DELETE FROM purchase_orders
    WHERE company_code = ${companyCode} AND division = ${division}
      AND id <> ALL(${incomingIds})
  `;

  for (const po of list) {
    if (!po || !po.id) continue;

    await sql`
      INSERT INTO purchase_orders (
        id, company_code, division, po_num, title, supplier, project_id,
        cost_code, sub_code, status, notes, origin,
        date_created, status_changed_at, status_changed_by, updated_at
      ) VALUES (
        ${po.id}, ${companyCode}, ${division},
        ${po.po_number      || ''},
        ${po.title          || null},
        ${po.supplier       || null},
        ${po.project_id     || null},
        ${po.cost_code      || null},
        ${po.sub_code       || null},
        ${po.status         || 'pending'},
        ${po.notes          || null},
        ${po.origin         || null},
        ${safeDate(po.date_created)},
        ${po.status_changed_at || null},
        ${po.status_changed_by || null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        division           = EXCLUDED.division,
        po_num             = EXCLUDED.po_num,
        title              = EXCLUDED.title,
        supplier           = EXCLUDED.supplier,
        project_id         = EXCLUDED.project_id,
        cost_code          = EXCLUDED.cost_code,
        sub_code           = EXCLUDED.sub_code,
        status             = EXCLUDED.status,
        notes              = EXCLUDED.notes,
        origin             = EXCLUDED.origin,
        date_created       = EXCLUDED.date_created,
        status_changed_at  = EXCLUDED.status_changed_at,
        status_changed_by  = EXCLUDED.status_changed_by,
        updated_at         = NOW()
    `;

    // Bulk-wipe protection for delivery records: only wipe-and-reinsert
    // when we actually have lines to write back. If lines is empty against
    // a PO with multiple existing deliveries, that's almost always a bug
    // (PO was edited without loading its full lines) and would silently
    // destroy the user's delivery history. The count==1 case still wipes
    // so a genuine "delete last delivery" still works.
    const lines = Array.isArray(po.lines) ? po.lines : [];
    if (lines.length > 0) {
      await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;
    } else {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM po_deliveries
        WHERE po_id = ${po.id} AND company_code = ${companyCode}
      `;
      if (count > 1) {
        console.warn(`[purchase-orders] refused empty lines for PO ${po.id}: ${count} deliveries would have been wiped`);
      } else if (count === 1) {
        await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;
      }
    }
    for (const line of lines) {
      if (!line) continue;
      const qty = safeFloat(line.qty)       ?? 0;
      const uc  = safeFloat(line.unit_cost) ?? 0;
      const tax = safeFloat(line.tax)       ?? 0;
      await sql`
        INSERT INTO po_deliveries (
          po_id, company_code,
          line_id, invoice_num, delivery_date,
          units_delivered, unit_cost, delivery_cost,
          tax, employee, po_row_id
        ) VALUES (
          ${po.id}, ${companyCode},
          ${line.id          || null},
          ${line.invoice_num || null},
          ${safeDate(line.date)},
          ${qty}, ${uc}, ${qty * uc},
          ${tax},
          ${line.employee    || null},
          ${line.po_row_id   || null}
        )
      `;
    }
  }
}
