'use strict';

/**
 * Shared helpers that write JSON blob data into normalized tables.
 * Called both from api/data/[key].js (live write-through) and
 * api/admin/sync-db.js (full manual resync).
 *
 * All functions are safe to call repeatedly — upserts throughout.
 * Errors are thrown so callers can decide whether to surface or swallow them.
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// PROJECTS + BID ITEMS
// value: array of project objects OR a single project object
// ─────────────────────────────────────────────────────────────────────────────
async function syncProjects(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : (value && value.id ? [value] : []);
  let projects = 0, bid_items = 0;

  for (const p of list) {
    if (!p || !p.id) continue;

    await sql`
      INSERT INTO projects (id, company_code, name, job_number, start_date, target_completion, pinned, updated_at)
      VALUES (
        ${p.id}, ${companyCode},
        ${p['project-name'] || p.name || 'Untitled'},
        ${p['job-number']   || p.job_number || null},
        ${safeDate(p['start-date']          || p.start_date)},
        ${safeDate(p['target-completion']   || p.target_completion)},
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
    projects++;

    const bidItems = Array.isArray(p.bidItems) ? p.bidItems : [];
    for (const item of bidItems) {
      if (!item || !item.id) continue;
      await sql`
        INSERT INTO bid_items (
          id, project_id, company_code, cost_code, sub_code, description,
          quantity, unit, unit_cost, status, target_date, updated_at
        ) VALUES (
          ${item.id}, ${p.id}, ${companyCode},
          ${item.cost_code   || item.costCode   || ''},
          ${item.sub_code    || item.subCode    || null},
          ${item.description || null},
          ${safeFloat(item.quantity)                           ?? 0},
          ${item.unit || null},
          ${safeFloat(item.unit_cost ?? item.unitCost)         ?? 0},
          ${item.status || 'Active'},
          ${safeDate(item.target_date || item.targetDate)},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE SET
          cost_code   = EXCLUDED.cost_code,
          sub_code    = EXCLUDED.sub_code,
          description = EXCLUDED.description,
          quantity    = EXCLUDED.quantity,
          unit        = EXCLUDED.unit,
          unit_cost   = EXCLUDED.unit_cost,
          status      = EXCLUDED.status,
          target_date = EXCLUDED.target_date,
          updated_at  = NOW()
      `;
      bid_items++;
    }
  }

  return { projects, bid_items };
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTS  (employees, equipment, suppliers — all from fct_lists blob)
// ─────────────────────────────────────────────────────────────────────────────
async function syncLists(sql, companyCode, lists) {
  if (!lists || typeof lists !== 'object') return { employees: 0, equipment: 0, suppliers: 0 };
  let employees = 0, equipment = 0, suppliers = 0;

  // Employees
  const employeeList = Array.isArray(lists.employees) ? lists.employees : [];
  for (let i = 0; i < employeeList.length; i++) {
    const e = employeeList[i];
    if (!e) continue;
    const name      = typeof e === 'string' ? e : (e.name || e.value || '');
    if (!name) continue;
    const jobClass  = typeof e === 'object' ? (e.job_class  || e.jobClass  || null) : null;
    const rate      = typeof e === 'object' ? safeFloat(e.rate)                     : null;
    const pwRate    = typeof e === 'object' ? safeFloat(e.pw_rate    ?? e.pwRate)   : null;
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
    employees++;
  }

  // Equipment
  const equipList = Array.isArray(lists.equipment)
    ? lists.equipment
    : (Array.isArray(lists.equipmentList) ? lists.equipmentList : []);

  for (let i = 0; i < equipList.length; i++) {
    const eq = equipList[i];
    if (!eq) continue;
    const name     = typeof eq === 'string' ? eq : (eq.name || '');
    if (!name) continue;
    const unitCost = typeof eq === 'object' ? (safeFloat(eq.unit_cost ?? eq.unitCost) ?? 0) : 0;

    await sql`
      INSERT INTO equipment_list (name, unit_cost, sort_order, company_code, updated_at)
      VALUES (${name}, ${unitCost}, ${i}, ${companyCode}, NOW())
      ON CONFLICT (company_code, name) DO UPDATE SET
        unit_cost  = EXCLUDED.unit_cost,
        sort_order = EXCLUDED.sort_order,
        updated_at = NOW()
    `;
    equipment++;
  }

  // Suppliers
  const supplierList = Array.isArray(lists.suppliers) ? lists.suppliers : [];
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
    suppliers++;
  }

  return { employees, equipment, suppliers };
}

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ORDERS + DELIVERIES
// Deliveries: delete-then-reinsert per PO to avoid duplicates (they have no UUID).
// ─────────────────────────────────────────────────────────────────────────────
async function syncPurchaseOrders(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];
  let purchase_orders = 0, po_deliveries = 0;

  for (const po of list) {
    if (!po || !po.id) continue;

    const deliveries = Array.isArray(po.deliveries) ? po.deliveries : [];

    // Derive status
    let poStatus = po.status || 'Open';
    if (!po.status) {
      const totalDelivered = deliveries.reduce(
        (sum, d) => sum + (safeFloat(d.units_delivered ?? d.unitsDelivered) ?? 0), 0
      );
      const totalUnits = safeFloat(po.total_units ?? po.totalUnits) ?? 0;
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
    purchase_orders++;

    // Delete existing deliveries then reinsert (deliveries have no stable UUID)
    await sql`DELETE FROM po_deliveries WHERE po_id = ${po.id} AND company_code = ${companyCode}`;

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
      po_deliveries++;
    }
  }

  return { purchase_orders, po_deliveries };
}

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY
// ─────────────────────────────────────────────────────────────────────────────
async function syncInventory(sql, companyCode, value) {
  const list = Array.isArray(value) ? value
    : (value && Array.isArray(value.items) ? value.items : []);
  let inventory_items = 0;

  for (const item of list) {
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
    inventory_items++;
  }

  return { inventory_items };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE DISPATCHER
// Given a bare key (no company prefix) and its value, runs the right sync(s).
// Returns a stats object (may be empty if the key doesn't map to any table).
// ─────────────────────────────────────────────────────────────────────────────
async function syncForKey(sql, companyCode, key, value) {
  if (!value) return {};

  // Individual project blob: fct_project_{uuid}
  if (/^fct_project_[a-zA-Z0-9_-]+$/.test(key)) {
    return syncProjects(sql, companyCode, value);
  }

  // Full projects array or index
  if (key === 'fct_projects' || key === 'fct_projects_index') {
    return syncProjects(sql, companyCode, value);
  }

  if (key === 'fct_lists') {
    return syncLists(sql, companyCode, value);
  }

  if (key === 'fct_purchase_orders') {
    return syncPurchaseOrders(sql, companyCode, value);
  }

  if (key === 'fct_inventory') {
    return syncInventory(sql, companyCode, value);
  }

  return {};
}

module.exports = { syncProjects, syncLists, syncPurchaseOrders, syncInventory, syncForKey };
