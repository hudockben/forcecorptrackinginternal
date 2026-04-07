'use strict';

/**
 * POST /api/admin/sync-db
 * Reads all JSON blob data from app_data and populates the normalized tables:
 *   projects, bid_items, employees, equipment_list, suppliers,
 *   purchase_orders, po_deliveries, inventory_items
 *
 * Requires: Authorization: Bearer <JWT>  (admin or level3 role)
 * Optional body: { companyCode: "ACME" }  — defaults to caller's company
 *
 * Safe to run repeatedly: all inserts use ON CONFLICT DO UPDATE.
 */

const { neon } = require('@neondatabase/serverless');
const jwt      = require('jsonwebtoken');

function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

function safeFloat(v) {
  if (v === null || v === undefined || v === '') return null;
  const f = parseFloat(v);
  return isNaN(f) ? null : f;
}

function safeDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return s.length === 10 ? s : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: 'Unauthorized' });
  if (!['admin', 'level3'].includes(payload.role)) {
    return res.status(403).json({ error: 'Forbidden — admin or level3 required' });
  }

  const companyCode = (req.body && req.body.companyCode)
    ? String(req.body.companyCode).toUpperCase()
    : payload.companyCode;

  const sql = neon(process.env.DATABASE_URL);
  const stats = {
    projects: 0, bid_items: 0, employees: 0, equipment: 0,
    suppliers: 0, purchase_orders: 0, po_deliveries: 0, inventory_items: 0
  };

  try {
    // ── 1. Load all relevant JSON blobs in one query ──────────────────────
    const keys = [
      `${companyCode}:fct_projects`,
      `${companyCode}:fct_lists`,
      `${companyCode}:fct_purchase_orders`,
      `${companyCode}:fct_inventory`,
    ];
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    const blobs = {};
    rows.forEach(r => { blobs[r.key] = r.value; });

    const prefix = companyCode + ':';
    const projects      = blobs[`${prefix}fct_projects`]       || [];
    const lists         = blobs[`${prefix}fct_lists`]          || {};
    const purchaseOrders= blobs[`${prefix}fct_purchase_orders`]|| [];
    const inventory     = blobs[`${prefix}fct_inventory`]      || [];

    // ── 2. Projects + Bid Items ───────────────────────────────────────────
    for (const p of (Array.isArray(projects) ? projects : [])) {
      if (!p || !p.id) continue;

      await sql`
        INSERT INTO projects (id, company_code, name, job_number, start_date, target_completion, pinned, updated_at)
        VALUES (
          ${p.id}, ${companyCode},
          ${p['project-name'] || p.name || 'Untitled'},
          ${p['job-number']   || p.job_number || null},
          ${safeDate(p['start-date'] || p.start_date)},
          ${safeDate(p['target-completion'] || p.target_completion)},
          ${p.pinned === true},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          name              = EXCLUDED.name,
          job_number        = EXCLUDED.job_number,
          start_date        = EXCLUDED.start_date,
          target_completion = EXCLUDED.target_completion,
          pinned            = EXCLUDED.pinned,
          updated_at        = NOW()
      `;
      stats.projects++;

      // Bid items embedded in the project
      const bidItems = Array.isArray(p.bidItems) ? p.bidItems : [];
      for (const item of bidItems) {
        if (!item || !item.id) continue;
        await sql`
          INSERT INTO bid_items (
            id, project_id, company_code, cost_code, sub_code, description,
            quantity, unit, unit_cost, status, target_date, updated_at
          ) VALUES (
            ${item.id}, ${p.id}, ${companyCode},
            ${item.cost_code || item.costCode || ''},
            ${item.sub_code  || item.subCode  || null},
            ${item.description || null},
            ${safeFloat(item.quantity) ?? 0},
            ${item.unit || null},
            ${safeFloat(item.unit_cost ?? item.unitCost) ?? 0},
            ${item.status || 'Active'},
            ${safeDate(item.target_date || item.targetDate)},
            NOW()
          )
          ON CONFLICT (id) DO UPDATE SET
            cost_code    = EXCLUDED.cost_code,
            sub_code     = EXCLUDED.sub_code,
            description  = EXCLUDED.description,
            quantity     = EXCLUDED.quantity,
            unit         = EXCLUDED.unit,
            unit_cost    = EXCLUDED.unit_cost,
            status       = EXCLUDED.status,
            target_date  = EXCLUDED.target_date,
            updated_at   = NOW()
        `;
        stats.bid_items++;
      }
    }

    // ── 3. Employees ──────────────────────────────────────────────────────
    const employeeList = Array.isArray(lists.employees)
      ? lists.employees
      : (Array.isArray(lists.employees) ? lists.employees : []);

    // fct_lists.employees can be an array of strings or objects
    for (let i = 0; i < employeeList.length; i++) {
      const e = employeeList[i];
      if (!e) continue;
      const name      = typeof e === 'string' ? e : (e.name || e.value || '');
      if (!name) continue;
      const jobClass  = typeof e === 'object' ? (e.job_class || e.jobClass || null) : null;
      const rate      = typeof e === 'object' ? safeFloat(e.rate)        : null;
      const pwRate    = typeof e === 'object' ? safeFloat(e.pw_rate    ?? e.pwRate)    : null;
      const nonPwRate = typeof e === 'object' ? safeFloat(e.non_pw_rate ?? e.nonPwRate): null;

      await sql`
        INSERT INTO employees (company_code, name, job_class, rate, pw_rate, non_pw_rate, sort_order, updated_at)
        VALUES (${companyCode}, ${name}, ${jobClass}, ${rate}, ${pwRate}, ${nonPwRate}, ${i}, NOW())
        ON CONFLICT (company_code, name) DO UPDATE SET
          job_class   = EXCLUDED.job_class,
          rate        = EXCLUDED.rate,
          pw_rate     = EXCLUDED.pw_rate,
          non_pw_rate = EXCLUDED.non_pw_rate,
          sort_order  = EXCLUDED.sort_order,
          updated_at  = NOW()
      `;
      stats.employees++;
    }

    // ── 4. Equipment List ─────────────────────────────────────────────────
    const equipList = Array.isArray(lists.equipment)
      ? lists.equipment
      : (Array.isArray(lists.equipmentList) ? lists.equipmentList : []);

    for (let i = 0; i < equipList.length; i++) {
      const eq = equipList[i];
      if (!eq) continue;
      const name     = typeof eq === 'string' ? eq : (eq.name || '');
      if (!name) continue;
      const unitCost = typeof eq === 'object' ? safeFloat(eq.unit_cost ?? eq.unitCost) ?? 0 : 0;

      await sql`
        INSERT INTO equipment_list (name, unit_cost, sort_order, company_code, updated_at)
        VALUES (${name}, ${unitCost}, ${i}, ${companyCode}, NOW())
        ON CONFLICT (name) DO UPDATE SET
          unit_cost    = EXCLUDED.unit_cost,
          sort_order   = EXCLUDED.sort_order,
          company_code = EXCLUDED.company_code,
          updated_at   = NOW()
      `;
      stats.equipment++;
    }

    // ── 5. Suppliers ──────────────────────────────────────────────────────
    const supplierList = Array.isArray(lists.suppliers)
      ? lists.suppliers
      : [];

    for (let i = 0; i < supplierList.length; i++) {
      const s = supplierList[i];
      if (!s) continue;
      const name = typeof s === 'string' ? s : (s.name || s.value || '');
      if (!name) continue;

      await sql`
        INSERT INTO suppliers (company_code, name, sort_order)
        VALUES (${companyCode}, ${name}, ${i})
        ON CONFLICT (company_code, name) DO UPDATE SET
          sort_order = EXCLUDED.sort_order
      `;
      stats.suppliers++;
    }

    // ── 6. Purchase Orders + Deliveries ───────────────────────────────────
    for (const po of (Array.isArray(purchaseOrders) ? purchaseOrders : [])) {
      if (!po || !po.id) continue;

      // Derive status from deliveries if not set
      let poStatus = po.status || 'Open';
      const deliveries = Array.isArray(po.deliveries) ? po.deliveries : [];
      if (!po.status) {
        const totalDelivered = deliveries.reduce((sum, d) => sum + (safeFloat(d.units_delivered ?? d.unitsDelivered) ?? 0), 0);
        const totalUnits     = safeFloat(po.total_units ?? po.totalUnits) ?? 0;
        if (totalDelivered >= totalUnits && totalUnits > 0) poStatus = 'Complete';
        else if (totalDelivered > 0) poStatus = 'Partial';
      }

      await sql`
        INSERT INTO purchase_orders (
          id, company_code, project_id, po_num, supplier, material,
          cost_code, sub_code, total_units, unit_cost, total_cost, status, notes, updated_at
        ) VALUES (
          ${po.id}, ${companyCode},
          ${po.project_id || po.projectId || null},
          ${po.po_num || po.poNum || ''},
          ${po.supplier || null},
          ${po.material || null},
          ${po.cost_code || po.costCode || null},
          ${po.sub_code  || po.subCode  || null},
          ${safeFloat(po.total_units  ?? po.totalUnits)  ?? 0},
          ${safeFloat(po.unit_cost    ?? po.unitCost)    ?? 0},
          ${safeFloat(po.total_cost   ?? po.totalCost)   ?? 0},
          ${poStatus}, ${po.notes || null}, NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          project_id  = EXCLUDED.project_id,
          po_num      = EXCLUDED.po_num,
          supplier    = EXCLUDED.supplier,
          material    = EXCLUDED.material,
          cost_code   = EXCLUDED.cost_code,
          sub_code    = EXCLUDED.sub_code,
          total_units = EXCLUDED.total_units,
          unit_cost   = EXCLUDED.unit_cost,
          total_cost  = EXCLUDED.total_cost,
          status      = EXCLUDED.status,
          notes       = EXCLUDED.notes,
          updated_at  = NOW()
      `;
      stats.purchase_orders++;

      for (const d of deliveries) {
        if (!d) continue;
        const unitsDelivered = safeFloat(d.units_delivered ?? d.unitsDelivered) ?? 0;
        const unitCost       = safeFloat(d.unit_cost       ?? d.unitCost)       ?? 0;
        const delivCost      = safeFloat(d.delivery_cost   ?? d.deliveryCost)   ?? (unitsDelivered * unitCost);

        await sql`
          INSERT INTO po_deliveries (po_id, company_code, delivery_date, units_delivered, unit_cost, delivery_cost, notes)
          VALUES (
            ${po.id}, ${companyCode},
            ${safeDate(d.date || d.delivery_date || d.deliveryDate)},
            ${unitsDelivered}, ${unitCost}, ${delivCost},
            ${d.notes || null}
          )
        `;
        stats.po_deliveries++;
      }
    }

    // ── 7. Inventory Items ────────────────────────────────────────────────
    const invArray = Array.isArray(inventory) ? inventory
      : (inventory && Array.isArray(inventory.items) ? inventory.items : []);

    for (const item of invArray) {
      if (!item) continue;
      const infillType = item.infill_type || item.infillType || item.type || 'Unknown';

      await sql`
        INSERT INTO inventory_items (
          company_code, project_id, infill_type, location,
          quantity, unit, unit_cost, notes, date_added, updated_at
        ) VALUES (
          ${companyCode},
          ${item.project_id || item.projectId || null},
          ${infillType},
          ${item.location || null},
          ${safeFloat(item.quantity) ?? 0},
          ${item.unit || null},
          ${safeFloat(item.unit_cost ?? item.unitCost)},
          ${item.notes || null},
          ${safeDate(item.date || item.date_added || item.dateAdded)},
          NOW()
        )
      `;
      stats.inventory_items++;
    }

    return res.json({ ok: true, companyCode, stats });

  } catch (err) {
    console.error('[sync-db] error:', err.message);
    return res.status(500).json({ error: 'Sync failed', detail: err.message });
  }
};
