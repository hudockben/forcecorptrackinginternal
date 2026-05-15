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

    // is_supervisor is intentionally NOT in the UPDATE SET — that flag is managed
    // globally via divisions.html "Manage Supervisors" and must survive every
    // sync of the per-division employee list blob.
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
// Delete-then-reinsert so removed items propagate and no duplicates accumulate.
// Frontend inventory entries use rubber_type/bags_produced; map to table columns.
// ─────────────────────────────────────────────────────────────────────────────
async function syncInventory(sql, companyCode, value) {
  const list = Array.isArray(value) ? value
    : (value && Array.isArray(value.items) ? value.items : []);

  // Wipe stale rows before reinserting so deletes and edits are reflected.
  await sql`DELETE FROM inventory_items WHERE company_code = ${companyCode}`;

  let inventory_items = 0;
  for (const item of list) {
    if (!item) continue;
    // rubber_type is the field name used by the inventory tab; fall back to
    // infill_type / type for any legacy data that used the old field names.
    const infillType = item.rubber_type || item.infill_type || item.infillType || item.type || 'Unknown';
    // bags_produced is the primary quantity field for inventory entries.
    const qty = safeFloat(item.bags_produced ?? item.quantity) ?? 0;

    await sql`
      INSERT INTO inventory_items (
        company_code, project_id, infill_type, location,
        quantity, unit, unit_cost, notes, date_added, updated_at
      ) VALUES (
        ${companyCode},
        ${item.project_id || item.projectId || null},
        ${infillType},
        ${item.location || null},
        ${qty},
        ${item.unit || null},
        ${safeFloat(item.unit_cost ?? item.unitCost) ?? null},
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
// COST ROWS  (fct_cost_rows → cost_items)
// Delete-then-reinsert by company so edits/deletes propagate.
// ─────────────────────────────────────────────────────────────────────────────
async function syncCostRows(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  await sql`DELETE FROM cost_items WHERE company_code = ${companyCode}`;

  let cost_items = 0;
  for (const row of list) {
    if (!row) continue;
    await sql`
      INSERT INTO cost_items (
        company_code, cost_code, sub_code, quantity, bid_item_cost, status,
        description, updated_at
      ) VALUES (
        ${companyCode},
        ${row.cost_code || row.costCode || ''},
        ${row.sub_code  || row.subCode  || null},
        ${safeFloat(row.quantity)      ?? 0},
        ${safeFloat(row.bid_item_cost ?? row.bidItemCost) ?? 0},
        ${row.status || 'Active'},
        ${row.description || null},
        NOW()
      )
    `;
    cost_items++;
  }

  return { cost_items };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRUCKING ENTRIES  (fct_trucking → trucking_entries)
// Upsert by app-provided UUID id.
// ─────────────────────────────────────────────────────────────────────────────
async function syncTrucking(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  // Delete rows that are no longer in the blob (handles deletions).
  const ids = list.map(t => t && t.id).filter(Boolean);
  if (ids.length) {
    await sql`
      DELETE FROM trucking_entries
      WHERE company_code = ${companyCode}
        AND id <> ALL(${ids})
    `;
  } else {
    await sql`DELETE FROM trucking_entries WHERE company_code = ${companyCode}`;
  }

  let trucking_entries = 0;
  for (const t of list) {
    if (!t || !t.id) continue;
    await sql`
      INSERT INTO trucking_entries (
        id, company_code, tr_number, driver, truck_type, project_id,
        date, material_hauled, loads, rate, hours, status, notes,
        cost_code, sub_code, updated_at
      ) VALUES (
        ${t.id}, ${companyCode},
        ${t.tr_number  || t.trNumber  || null},
        ${t.driver     || null},
        ${t.truck_type || t.truckType || null},
        ${t.project_id || t.projectId || null},
        ${safeDate(t.date)},
        ${t.material_hauled || t.materialHauled || null},
        ${safeFloat(t.loads)  ?? null},
        ${safeFloat(t.rate)   ?? null},
        ${safeFloat(t.hours)  ?? null},
        ${t.status || 'pending'},
        ${t.notes  || null},
        ${t.cost_code || t.costCode || null},
        ${t.sub_code  || t.subCode  || null},
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
    trucking_entries++;
  }

  return { trucking_entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCALE MANUAL ENTRIES  (fct_scale_manual → scale_manual_entries)
// Upsert by app-provided UUID id.
// ─────────────────────────────────────────────────────────────────────────────
async function syncScaleManual(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  const ids = list.map(e => e && e.id).filter(Boolean);
  if (ids.length) {
    await sql`
      DELETE FROM scale_manual_entries
      WHERE company_code = ${companyCode}
        AND id <> ALL(${ids})
    `;
  } else {
    await sql`DELETE FROM scale_manual_entries WHERE company_code = ${companyCode}`;
  }

  let scale_manual_entries = 0;
  for (const e of list) {
    if (!e || !e.id) continue;
    await sql`
      INSERT INTO scale_manual_entries (
        id, company_code, label, cost_code, sub_code,
        run_qty, total_cost, labor_hrs, equip_hrs,
        bid_qty, bid_unit_cost, created_at
      ) VALUES (
        ${e.id}, ${companyCode},
        ${e.label     || null},
        ${e.cost_code || e.costCode || null},
        ${e.sub_code  || e.subCode  || null},
        ${safeFloat(e.run_qty)       ?? null},
        ${safeFloat(e.total_cost)    ?? null},
        ${safeFloat(e.labor_hrs)     ?? null},
        ${safeFloat(e.equip_hrs)     ?? null},
        ${safeFloat(e.bid_qty)       ?? null},
        ${safeFloat(e.bid_unit_cost) ?? null},
        ${safeDate(e.created_at) || null}
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
    scale_manual_entries++;
  }

  return { scale_manual_entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERCOMPANY COMPANIES  (fct_intercompany_companies → intercompany_companies)
// Upsert by app-provided id; delete rows no longer in the list.
// ─────────────────────────────────────────────────────────────────────────────
async function syncIntercompanyCompanies(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  const ids = list.map(c => c && c.id).filter(Boolean);
  if (ids.length) {
    await sql`
      DELETE FROM intercompany_companies
      WHERE company_code = ${companyCode}
        AND id <> ALL(${ids})
    `;
  } else {
    await sql`DELETE FROM intercompany_companies WHERE company_code = ${companyCode}`;
  }

  let intercompany_companies = 0;
  for (const c of list) {
    if (!c || !c.id) continue;
    const divisions = Array.isArray(c.divisions) ? c.divisions : [];
    await sql`
      INSERT INTO intercompany_companies (id, company_code, name, divisions, notes, updated_at)
      VALUES (${c.id}, ${companyCode}, ${c.name || ''}, ${divisions}, ${c.notes || null}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name       = EXCLUDED.name,
        divisions  = EXCLUDED.divisions,
        notes      = EXCLUDED.notes,
        updated_at = NOW()
    `;
    intercompany_companies++;
  }

  return { intercompany_companies };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERCOMPANY BILLING ENTRIES  (fct_intercompany_billing_entries → intercompany_billing_entries)
// Upsert by app-provided id; delete rows no longer in the list.
// Handles both trucking entries (haul_fee, task_number, driver …) and
// dust entries (location, company_man, gallons_ub …).
// ─────────────────────────────────────────────────────────────────────────────
async function syncIntercompanyBillingEntries(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  const ids = list.map(e => e && e.id).filter(Boolean);
  if (ids.length) {
    await sql`
      DELETE FROM intercompany_billing_entries
      WHERE company_code = ${companyCode}
        AND id <> ALL(${ids})
    `;
  } else {
    await sql`DELETE FROM intercompany_billing_entries WHERE company_code = ${companyCode}`;
  }

  let intercompany_billing_entries = 0;
  for (const e of list) {
    if (!e || !e.id) continue;
    await sql`
      INSERT INTO intercompany_billing_entries (
        id, company_code, source, source_id, company_id, company_name,
        actual_date, total_hours, total, sent_at, sent_by,
        task_number, driver, unit, actual_start, actual_end,
        haul_fee, customer, description, division, notes,
        qb_invoice, invoiced_date, invoice_sent_date, invoice_status, date_paid,
        location, company_man,
        vehicle1, v1_unit, v1_rate, v1_total,
        vehicle2, v2_unit, v2_rate, v2_total,
        gallons_ub, ub_total, inv_number, inv_status,
        updated_at
      ) VALUES (
        ${e.id}, ${companyCode},
        ${e.source || 'trucking'}, ${e.source_id || null},
        ${e.company_id || null}, ${e.company_name || null},
        ${safeDate(e.actual_date)},
        ${safeFloat(e.total_hours) ?? null},
        ${safeFloat(e.total)       ?? null},
        ${e.sent_at ? new Date(e.sent_at).toISOString() : null},
        ${e.sent_by || null},
        ${e.task_number || null}, ${e.driver || null}, ${e.unit || null},
        ${e.actual_start || null}, ${e.actual_end || null},
        ${safeFloat(e.haul_fee)    ?? null},
        ${e.customer || null}, ${e.description || null},
        ${e.division || null}, ${e.notes || null},
        ${e.qb_invoice || null},
        ${safeDate(e.invoiced_date)},
        ${safeDate(e.invoice_sent_date)},
        ${e.invoice_status || null},
        ${safeDate(e.date_paid)},
        ${e.location || null}, ${e.company_man || null},
        ${e.vehicle1 || null}, ${e.v1_unit || null},
        ${safeFloat(e.v1_rate) ?? null}, ${safeFloat(e.v1_total) ?? null},
        ${e.vehicle2 || null}, ${e.v2_unit || null},
        ${safeFloat(e.v2_rate) ?? null}, ${safeFloat(e.v2_total) ?? null},
        ${safeFloat(e.gallons_ub) ?? null}, ${safeFloat(e.ub_total) ?? null},
        ${e.inv_number || null}, ${e.inv_status || null},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        source            = EXCLUDED.source,
        source_id         = EXCLUDED.source_id,
        company_id        = EXCLUDED.company_id,
        company_name      = EXCLUDED.company_name,
        actual_date       = EXCLUDED.actual_date,
        total_hours       = EXCLUDED.total_hours,
        total             = EXCLUDED.total,
        sent_at           = EXCLUDED.sent_at,
        sent_by           = EXCLUDED.sent_by,
        task_number       = EXCLUDED.task_number,
        driver            = EXCLUDED.driver,
        unit              = EXCLUDED.unit,
        actual_start      = EXCLUDED.actual_start,
        actual_end        = EXCLUDED.actual_end,
        haul_fee          = EXCLUDED.haul_fee,
        customer          = EXCLUDED.customer,
        description       = EXCLUDED.description,
        division          = EXCLUDED.division,
        notes             = EXCLUDED.notes,
        qb_invoice        = EXCLUDED.qb_invoice,
        invoiced_date     = EXCLUDED.invoiced_date,
        invoice_sent_date = EXCLUDED.invoice_sent_date,
        invoice_status    = EXCLUDED.invoice_status,
        date_paid         = EXCLUDED.date_paid,
        location          = EXCLUDED.location,
        company_man       = EXCLUDED.company_man,
        vehicle1          = EXCLUDED.vehicle1,
        v1_unit           = EXCLUDED.v1_unit,
        v1_rate           = EXCLUDED.v1_rate,
        v1_total          = EXCLUDED.v1_total,
        vehicle2          = EXCLUDED.vehicle2,
        v2_unit           = EXCLUDED.v2_unit,
        v2_rate           = EXCLUDED.v2_rate,
        v2_total          = EXCLUDED.v2_total,
        gallons_ub        = EXCLUDED.gallons_ub,
        ub_total          = EXCLUDED.ub_total,
        inv_number        = EXCLUDED.inv_number,
        inv_status        = EXCLUDED.inv_status,
        updated_at        = NOW()
    `;
    intercompany_billing_entries++;
  }

  return { intercompany_billing_entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUARRY LISTS  (fct_quarry_lists → quarry_{locations,products,customers,employees,equipment,tasks})
// Blob shape: { location: [...], product: [...], customer: [...],
//               employees: [...], equipment: [...], tasks: [...] }
// Each item: { id, name, rate? }
// Delete-then-reinsert by company so removals propagate.
// ─────────────────────────────────────────────────────────────────────────────
async function syncQuarryLists(sql, companyCode, value) {
  const lists = (value && typeof value === 'object') ? value : {};

  const buckets = [
    { key: 'location',  table: 'quarry_locations', hasRate: false },
    { key: 'product',   table: 'quarry_products',  hasRate: false },
    { key: 'customer',  table: 'quarry_customers', hasRate: false },
    { key: 'employees', table: 'quarry_employees', hasRate: true  },
    { key: 'equipment', table: 'quarry_equipment', hasRate: false },
    { key: 'tasks',     table: 'quarry_tasks',     hasRate: false },
  ];

  const stats = {
    quarry_locations: 0, quarry_products: 0, quarry_customers: 0,
    quarry_employees: 0, quarry_equipment: 0, quarry_tasks: 0,
  };

  for (const b of buckets) {
    const items = Array.isArray(lists[b.key]) ? lists[b.key] : [];
    const ids = items.map(it => it && it.id).filter(Boolean);

    // Defense in depth: if an empty list slips through, refuse to wipe the
    // mirror table for this bucket. The blob is the source of truth so
    // leaving the mirror intact preserves a recovery option.
    if (ids.length === 0) continue;

    // Wipe rows no longer in the list
    if (b.table === 'quarry_locations') {
      await sql`DELETE FROM quarry_locations WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;
    } else if (b.table === 'quarry_products') {
      await sql`DELETE FROM quarry_products WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;
    } else if (b.table === 'quarry_customers') {
      await sql`DELETE FROM quarry_customers WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;
    } else if (b.table === 'quarry_employees') {
      await sql`DELETE FROM quarry_employees WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;
    } else if (b.table === 'quarry_equipment') {
      await sql`DELETE FROM quarry_equipment WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;
    } else if (b.table === 'quarry_tasks') {
      await sql`DELETE FROM quarry_tasks WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.id || !it.name) continue;

      if (b.table === 'quarry_locations') {
        await sql`
          INSERT INTO quarry_locations (id, company_code, name, sort_order, updated_at)
          VALUES (${it.id}, ${companyCode}, ${it.name}, ${i}, NOW())
          ON CONFLICT (company_code, id) DO UPDATE SET
            name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, updated_at = NOW()
        `;
      } else if (b.table === 'quarry_products') {
        await sql`
          INSERT INTO quarry_products (id, company_code, name, sort_order, updated_at)
          VALUES (${it.id}, ${companyCode}, ${it.name}, ${i}, NOW())
          ON CONFLICT (company_code, id) DO UPDATE SET
            name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, updated_at = NOW()
        `;
      } else if (b.table === 'quarry_customers') {
        await sql`
          INSERT INTO quarry_customers (id, company_code, name, sort_order, updated_at)
          VALUES (${it.id}, ${companyCode}, ${it.name}, ${i}, NOW())
          ON CONFLICT (company_code, id) DO UPDATE SET
            name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, updated_at = NOW()
        `;
      } else if (b.table === 'quarry_employees') {
        await sql`
          INSERT INTO quarry_employees (id, company_code, name, rate, sort_order, updated_at)
          VALUES (${it.id}, ${companyCode}, ${it.name}, ${safeFloat(it.rate)}, ${i}, NOW())
          ON CONFLICT (company_code, id) DO UPDATE SET
            name = EXCLUDED.name, rate = EXCLUDED.rate,
            sort_order = EXCLUDED.sort_order, updated_at = NOW()
        `;
      } else if (b.table === 'quarry_equipment') {
        await sql`
          INSERT INTO quarry_equipment (id, company_code, name, sort_order, updated_at)
          VALUES (${it.id}, ${companyCode}, ${it.name}, ${i}, NOW())
          ON CONFLICT (company_code, id) DO UPDATE SET
            name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, updated_at = NOW()
        `;
      } else if (b.table === 'quarry_tasks') {
        await sql`
          INSERT INTO quarry_tasks (id, company_code, name, sort_order, updated_at)
          VALUES (${it.id}, ${companyCode}, ${it.name}, ${i}, NOW())
          ON CONFLICT (company_code, id) DO UPDATE SET
            name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, updated_at = NOW()
        `;
      }
      stats[b.table]++;
    }
  }

  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUARRY DAILY  (fct_quarry_daily → quarry_daily_entries)
// Computed totals (labor_cost, fuel_cost, total_cost) are stored on each
// row so SQL reports can read them directly. Recomputed from base fields
// to avoid drift if the UI ever sends stale derived values.
// ─────────────────────────────────────────────────────────────────────────────
async function syncQuarryDaily(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  const ids = list.map(r => r && r.id).filter(Boolean);
  // Defense in depth: if an empty list slips through, refuse to wipe the
  // mirror table. The blob is the source of truth — leave this intact so
  // recovery is possible if the blob itself was corrupted.
  if (ids.length === 0) return { quarry_daily_entries: 0 };
  await sql`DELETE FROM quarry_daily_entries WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;

  let quarry_daily_entries = 0;
  for (const r of list) {
    if (!r || !r.id) continue;

    const hours        = safeFloat(r.hours);
    const rate         = safeFloat(r.rate);
    const fuelGallons  = safeFloat(r.fuelGallons);
    const ppg          = safeFloat(r.ppg);
    const laborCost    = (hours != null && rate != null) ? hours * rate : null;
    const fuelCost     = (fuelGallons != null && ppg != null) ? fuelGallons * ppg : null;
    const totalCost    = (laborCost != null || fuelCost != null)
      ? (laborCost || 0) + (fuelCost || 0)
      : null;

    await sql`
      INSERT INTO quarry_daily_entries (
        id, company_code, date, location_id, location_name,
        employee_id, employee_name, equipment_id, equipment_name,
        task_id, task_name, hours, rate, fuel_gallons, ppg,
        labor_cost, fuel_cost, total_cost, updated_at
      ) VALUES (
        ${r.id}, ${companyCode}, ${safeDate(r.date)},
        ${r.locationId || null}, ${r.locationName || null},
        ${r.employeeId || null}, ${r.employeeName || null},
        ${r.equipmentId || null}, ${r.equipmentName || null},
        ${r.taskId || null}, ${r.taskName || null},
        ${hours}, ${rate}, ${fuelGallons}, ${ppg},
        ${laborCost}, ${fuelCost}, ${totalCost},
        NOW()
      )
      ON CONFLICT (company_code, id) DO UPDATE SET
        date           = EXCLUDED.date,
        location_id    = EXCLUDED.location_id,
        location_name  = EXCLUDED.location_name,
        employee_id    = EXCLUDED.employee_id,
        employee_name  = EXCLUDED.employee_name,
        equipment_id   = EXCLUDED.equipment_id,
        equipment_name = EXCLUDED.equipment_name,
        task_id        = EXCLUDED.task_id,
        task_name      = EXCLUDED.task_name,
        hours          = EXCLUDED.hours,
        rate           = EXCLUDED.rate,
        fuel_gallons   = EXCLUDED.fuel_gallons,
        ppg            = EXCLUDED.ppg,
        labor_cost     = EXCLUDED.labor_cost,
        fuel_cost      = EXCLUDED.fuel_cost,
        total_cost     = EXCLUDED.total_cost,
        updated_at     = NOW()
    `;
    quarry_daily_entries++;
  }

  return { quarry_daily_entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUARRY CRUSHING  (fct_quarry_crushing → quarry_crushing_entries)
// Stored computed fields: total_payroll, total_fuel, estimated_tons,
// tons_per_hour, total_cost, cost_per_ton.
// ─────────────────────────────────────────────────────────────────────────────
async function syncQuarryCrushing(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  const ids = list.map(r => r && r.id).filter(Boolean);
  // Defense in depth — see syncQuarryDaily.
  if (ids.length === 0) return { quarry_crushing_entries: 0 };
  await sql`DELETE FROM quarry_crushing_entries WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;

  let quarry_crushing_entries = 0;
  for (const r of list) {
    if (!r || !r.id) continue;

    const hourlyRate     = safeFloat(r.hourlyRate);
    const hours          = safeFloat(r.hours);
    const hoursCrushing  = safeFloat(r.hoursCrushing);
    const fuelGallons    = safeFloat(r.fuelGallons);
    const fuelCost       = safeFloat(r.fuelCost);
    const loadsToCrusher = safeFloat(r.loadsToCrusher);
    const tonsPerLoad    = safeFloat(r.tonsPerLoad);

    const totalPayroll   = (hours != null && hourlyRate != null) ? hours * hourlyRate : null;
    const totalFuel      = fuelCost;
    const estimatedTons  = (loadsToCrusher != null && tonsPerLoad != null) ? loadsToCrusher * tonsPerLoad : null;
    const tonsPerHour    = (estimatedTons != null && hoursCrushing != null && hoursCrushing > 0)
      ? estimatedTons / hoursCrushing
      : null;
    const totalCost      = (totalPayroll != null || totalFuel != null)
      ? (totalPayroll || 0) + (totalFuel || 0)
      : null;
    const costPerTon     = (totalCost != null && estimatedTons != null && estimatedTons > 0)
      ? totalCost / estimatedTons
      : null;

    await sql`
      INSERT INTO quarry_crushing_entries (
        id, company_code, date, location_id, location_name,
        employee_id, employee_name, hourly_rate, hours, hours_crushing,
        fuel_gallons, fuel_cost, loads_to_crusher, tons_per_load, comments,
        total_payroll, total_fuel, estimated_tons, tons_per_hour,
        total_cost, cost_per_ton, updated_at
      ) VALUES (
        ${r.id}, ${companyCode}, ${safeDate(r.date)},
        ${r.locationId || null}, ${r.locationName || null},
        ${r.employeeId || null}, ${r.employeeName || null},
        ${hourlyRate}, ${hours}, ${hoursCrushing},
        ${fuelGallons}, ${fuelCost}, ${loadsToCrusher}, ${tonsPerLoad},
        ${r.comments || null},
        ${totalPayroll}, ${totalFuel}, ${estimatedTons}, ${tonsPerHour},
        ${totalCost}, ${costPerTon}, NOW()
      )
      ON CONFLICT (company_code, id) DO UPDATE SET
        date             = EXCLUDED.date,
        location_id      = EXCLUDED.location_id,
        location_name    = EXCLUDED.location_name,
        employee_id      = EXCLUDED.employee_id,
        employee_name    = EXCLUDED.employee_name,
        hourly_rate      = EXCLUDED.hourly_rate,
        hours            = EXCLUDED.hours,
        hours_crushing   = EXCLUDED.hours_crushing,
        fuel_gallons     = EXCLUDED.fuel_gallons,
        fuel_cost        = EXCLUDED.fuel_cost,
        loads_to_crusher = EXCLUDED.loads_to_crusher,
        tons_per_load    = EXCLUDED.tons_per_load,
        comments         = EXCLUDED.comments,
        total_payroll    = EXCLUDED.total_payroll,
        total_fuel       = EXCLUDED.total_fuel,
        estimated_tons   = EXCLUDED.estimated_tons,
        tons_per_hour    = EXCLUDED.tons_per_hour,
        total_cost       = EXCLUDED.total_cost,
        cost_per_ton     = EXCLUDED.cost_per_ton,
        updated_at       = NOW()
    `;
    quarry_crushing_entries++;
  }

  return { quarry_crushing_entries };
}

// ─────────────────────────────────────────────────────────────────────────────
// QUARRY SALES  (fct_quarry_sales → quarry_sales_entries)
// Stored computed field: total = tons * price_per_ton.
// ─────────────────────────────────────────────────────────────────────────────
async function syncQuarrySales(sql, companyCode, value) {
  const list = Array.isArray(value) ? value : [];

  const ids = list.map(r => r && r.id).filter(Boolean);
  // Defense in depth — see syncQuarryDaily.
  if (ids.length === 0) return { quarry_sales_entries: 0 };
  await sql`DELETE FROM quarry_sales_entries WHERE company_code = ${companyCode} AND id <> ALL(${ids})`;

  let quarry_sales_entries = 0;
  for (const r of list) {
    if (!r || !r.id) continue;

    const tons        = safeFloat(r.tons);
    const pricePerTon = safeFloat(r.pricePerTon);
    const total       = (tons != null && pricePerTon != null) ? tons * pricePerTon : null;

    await sql`
      INSERT INTO quarry_sales_entries (
        id, company_code, date, location_id, location_name,
        employee_id, employee_name, customer_id, customer_name,
        product_id, product_name, tons, price_per_ton, payment, total,
        updated_at
      ) VALUES (
        ${r.id}, ${companyCode}, ${safeDate(r.date)},
        ${r.locationId || null}, ${r.locationName || null},
        ${r.employeeId || null}, ${r.employeeName || null},
        ${r.customerId || null}, ${r.customerName || null},
        ${r.productId  || null}, ${r.productName  || null},
        ${tons}, ${pricePerTon}, ${r.payment || null}, ${total},
        NOW()
      )
      ON CONFLICT (company_code, id) DO UPDATE SET
        date           = EXCLUDED.date,
        location_id    = EXCLUDED.location_id,
        location_name  = EXCLUDED.location_name,
        employee_id    = EXCLUDED.employee_id,
        employee_name  = EXCLUDED.employee_name,
        customer_id    = EXCLUDED.customer_id,
        customer_name  = EXCLUDED.customer_name,
        product_id     = EXCLUDED.product_id,
        product_name   = EXCLUDED.product_name,
        tons           = EXCLUDED.tons,
        price_per_ton  = EXCLUDED.price_per_ton,
        payment        = EXCLUDED.payment,
        total          = EXCLUDED.total,
        updated_at     = NOW()
    `;
    quarry_sales_entries++;
  }

  return { quarry_sales_entries };
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

  if (key === 'fct_cost_rows') {
    return syncCostRows(sql, companyCode, value);
  }

  if (key === 'fct_trucking') {
    return syncTrucking(sql, companyCode, value);
  }

  if (key === 'fct_scale_manual') {
    return syncScaleManual(sql, companyCode, value);
  }

  if (key === 'fct_intercompany_companies') {
    return syncIntercompanyCompanies(sql, companyCode, value);
  }

  if (key === 'fct_intercompany_billing_entries') {
    return syncIntercompanyBillingEntries(sql, companyCode, value);
  }

  if (key === 'fct_quarry_lists') {
    return syncQuarryLists(sql, companyCode, value);
  }

  if (key === 'fct_quarry_daily') {
    return syncQuarryDaily(sql, companyCode, value);
  }

  if (key === 'fct_quarry_crushing') {
    return syncQuarryCrushing(sql, companyCode, value);
  }

  if (key === 'fct_quarry_sales') {
    return syncQuarrySales(sql, companyCode, value);
  }

  return {};
}

module.exports = {
  syncProjects, syncLists, syncPurchaseOrders, syncInventory,
  syncCostRows, syncTrucking, syncScaleManual,
  syncIntercompanyCompanies, syncIntercompanyBillingEntries,
  syncQuarryLists, syncQuarryDaily, syncQuarryCrushing, syncQuarrySales,
  syncForKey,
};
