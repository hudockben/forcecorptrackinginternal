'use strict';
/**
 * GET    /api/projects           — all projects with nested bidItems (no dailyRows)
 * PUT    /api/projects           — full sync: { projects: [...] }
 * PUT    /api/projects?id=X      — sync a single project (debounced saves)
 * DELETE /api/projects?id=X      — delete project + cascade (bid_items, daily_tracking)
 *
 * Frontend uses kebab-case keys ('project-name', 'job-number', etc.).
 * This file maps those to/from snake_case DB columns.
 */
const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return s.length === 10 ? s : null;
}

// Map a frontend project object → DB column values
function projToDb(p, companyCode, sortOrder) {
  return {
    id:                  p.id,
    company_code:        companyCode,
    name:                p['project-name']    || '',
    job_number:          p['job-number']      || null,
    status:              p.status             || null,
    contract_type:       p['contract-type']   || null,
    client:              p.client             || null,
    gc:                  p.gc                 || null,
    pm:                  p.pm                 || null,
    superintendent:      p['super']           || null,
    estimator:           p.estimator          || null,
    client_contact:      p['client-contact']  || null,
    address:             p.address            || null,
    city_state:          p['city-state']      || null,
    start_date:          safeDate(p['start-date']),
    end_date:            safeDate(p['end-date'] || p['target-completion']),
    contract_days:       p['contract-days']   || null,
    contract_amount:     p['contract-amount'] || null,
    revised_amount:      p['revised-amount']  || null,
    retention:           p.retention          || null,
    scope:               p.scope              || null,
    notes:               p.notes              || null,
    sqft:                p.sqft               || null,
    prevailing_wage:     p.prevailing_wage    === true,
    assigned_employees:  JSON.stringify(Array.isArray(p.assigned_employees) ? p.assigned_employees : []),
    assigned_equipment:  JSON.stringify(Array.isArray(p.assigned_equipment)  ? p.assigned_equipment  : []),
    pinned:              p.pinned             === true,
    sort_order:          typeof sortOrder === 'number' ? sortOrder : 0,
  };
}

// Map a DB row → frontend project object (kebab-case keys)
function dbToProj(r, bidItems) {
  return {
    id:                  r.id,
    'project-name':      r.name              || '',
    'job-number':        r.job_number        || '',
    status:              r.status            || '',
    'contract-type':     r.contract_type     || '',
    client:              r.client            || '',
    gc:                  r.gc                || '',
    pm:                  r.pm                || '',
    super:               r.superintendent    || '',
    estimator:           r.estimator         || '',
    'client-contact':    r.client_contact    || '',
    address:             r.address           || '',
    'city-state':        r.city_state        || '',
    'start-date':        safeDate(r.start_date)  || '',
    'end-date':          safeDate(r.end_date)    || '',
    'contract-days':     r.contract_days     || '',
    'contract-amount':   r.contract_amount   || '',
    'revised-amount':    r.revised_amount    || '',
    retention:           r.retention         || '',
    scope:               r.scope             || '',
    notes:               r.notes             || '',
    sqft:                r.sqft              || '',
    prevailing_wage:     r.prevailing_wage   === true,
    assigned_employees:  Array.isArray(r.assigned_employees)  ? r.assigned_employees  : [],
    assigned_equipment:  Array.isArray(r.assigned_equipment)   ? r.assigned_equipment   : [],
    pinned:              r.pinned            === true,
    bidItems:            bidItems            || [],
    // dailyRows intentionally omitted — loaded separately via /api/daily-rows
  };
}

// Map a frontend bid item → DB column values
function bidToDb(bi, projectId, companyCode) {
  return {
    id:             bi.id,
    project_id:     projectId,
    company_code:   companyCode,
    cost_code:      bi.cost_code    || '',
    sub_code:       bi.sub_code     || null,
    description:    bi.description  || null,
    quantity:       parseFloat(bi.quantity)  || 0,
    unit:           bi.unit         || null,
    unit_cost:      parseFloat(bi.unit_cost) || 0,
    status:         bi.status       || 'Active',
    target_date:    safeDate(bi.target_date || bi.targetDate),
    start_date:     safeDate(bi.start_date),
    is_complete:    bi.is_complete  === true,
    change_orders:  JSON.stringify(Array.isArray(bi.change_orders) ? bi.change_orders : []),
  };
}

// Map a DB bid item row → frontend bid item object
function dbToBid(r) {
  return {
    id:            r.id,
    cost_code:     r.cost_code    || '',
    sub_code:      r.sub_code     || '',
    description:   r.description  || '',
    quantity:      r.quantity     != null ? String(r.quantity)   : '',
    unit:          r.unit         || '',
    unit_cost:     r.unit_cost    != null ? String(r.unit_cost)  : '',
    status:        r.status       || 'Active',
    target_date:   safeDate(r.target_date)  || '',
    start_date:    safeDate(r.start_date)   || '',
    is_complete:   r.is_complete  === true,
    change_orders: Array.isArray(r.change_orders) ? r.change_orders : [],
  };
}

async function upsertProject(sql, p, companyCode, sortOrder) {
  const d = projToDb(p, companyCode, sortOrder);
  await sql`
    INSERT INTO projects (
      id, company_code, name, job_number, status, contract_type,
      client, gc, pm, superintendent, estimator, client_contact,
      address, city_state, start_date, end_date,
      contract_days, contract_amount, revised_amount, retention,
      scope, notes, sqft, prevailing_wage,
      assigned_employees, assigned_equipment,
      pinned, sort_order, updated_at
    ) VALUES (
      ${d.id}, ${d.company_code}, ${d.name}, ${d.job_number}, ${d.status}, ${d.contract_type},
      ${d.client}, ${d.gc}, ${d.pm}, ${d.superintendent}, ${d.estimator}, ${d.client_contact},
      ${d.address}, ${d.city_state}, ${d.start_date}, ${d.end_date},
      ${d.contract_days}, ${d.contract_amount}, ${d.revised_amount}, ${d.retention},
      ${d.scope}, ${d.notes}, ${d.sqft}, ${d.prevailing_wage},
      ${d.assigned_employees}::jsonb, ${d.assigned_equipment}::jsonb,
      ${d.pinned}, ${d.sort_order}, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name               = EXCLUDED.name,
      job_number         = EXCLUDED.job_number,
      status             = EXCLUDED.status,
      contract_type      = EXCLUDED.contract_type,
      client             = EXCLUDED.client,
      gc                 = EXCLUDED.gc,
      pm                 = EXCLUDED.pm,
      superintendent     = EXCLUDED.superintendent,
      estimator          = EXCLUDED.estimator,
      client_contact     = EXCLUDED.client_contact,
      address            = EXCLUDED.address,
      city_state         = EXCLUDED.city_state,
      start_date         = EXCLUDED.start_date,
      end_date           = EXCLUDED.end_date,
      contract_days      = EXCLUDED.contract_days,
      contract_amount    = EXCLUDED.contract_amount,
      revised_amount     = EXCLUDED.revised_amount,
      retention          = EXCLUDED.retention,
      scope              = EXCLUDED.scope,
      notes              = EXCLUDED.notes,
      sqft               = EXCLUDED.sqft,
      prevailing_wage    = EXCLUDED.prevailing_wage,
      assigned_employees = EXCLUDED.assigned_employees,
      assigned_equipment = EXCLUDED.assigned_equipment,
      pinned             = EXCLUDED.pinned,
      sort_order         = EXCLUDED.sort_order,
      updated_at         = NOW()
  `;

  // Sync bid items: delete removed, upsert kept/new.
  const bidItems = Array.isArray(p.bidItems) ? p.bidItems : [];
  const incomingBidIds = bidItems.map(b => b.id).filter(Boolean);
  if (incomingBidIds.length) {
    await sql`
      DELETE FROM bid_items WHERE project_id = ${p.id} AND id <> ALL(${incomingBidIds})
    `;
  } else {
    // Bulk-wipe protection: an empty incoming list against a project with
    // multiple existing bid items is almost always a stale-state bug
    // (race, partial load) and would silently destroy line items.
    // Single-row deletes still work — the count==1 case still wipes,
    // which is the normal "delete last row" flow.
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM bid_items WHERE project_id = ${p.id}
    `;
    if (count > 1) {
      console.warn(`[projects] refused empty bidItems for project ${p.id}: ${count} would have been wiped`);
    } else {
      await sql`DELETE FROM bid_items WHERE project_id = ${p.id}`;
    }
  }
  for (const bi of bidItems) {
    if (!bi || !bi.id) continue;
    const b = bidToDb(bi, p.id, companyCode);
    await sql`
      INSERT INTO bid_items (
        id, project_id, company_code, cost_code, sub_code, description,
        quantity, unit, unit_cost, status, target_date, start_date,
        is_complete, change_orders, updated_at
      ) VALUES (
        ${b.id}, ${b.project_id}, ${b.company_code},
        ${b.cost_code}, ${b.sub_code}, ${b.description},
        ${b.quantity}, ${b.unit}, ${b.unit_cost},
        ${b.status}, ${b.target_date}, ${b.start_date},
        ${b.is_complete}, ${b.change_orders}::jsonb, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        cost_code     = EXCLUDED.cost_code,
        sub_code      = EXCLUDED.sub_code,
        description   = EXCLUDED.description,
        quantity      = EXCLUDED.quantity,
        unit          = EXCLUDED.unit,
        unit_cost     = EXCLUDED.unit_cost,
        status        = EXCLUDED.status,
        target_date   = EXCLUDED.target_date,
        start_date    = EXCLUDED.start_date,
        is_complete   = EXCLUDED.is_complete,
        change_orders = EXCLUDED.change_orders,
        updated_at    = NOW()
    `;
  }
}

module.exports = async (req, res) => {
  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET ──────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const projRows = await sql`
        SELECT * FROM projects
        WHERE  company_code = ${companyCode}
        ORDER  BY sort_order ASC, created_at ASC
      `;
      if (!projRows.length) return res.json({ projects: [] });

      const projIds = projRows.map(r => r.id);
      const bidRows = await sql`
        SELECT * FROM bid_items
        WHERE  project_id = ANY(${projIds})
        ORDER  BY project_id, created_at ASC
      `;

      // Group bid items by project
      const bidsByProj = {};
      for (const b of bidRows) {
        if (!bidsByProj[b.project_id]) bidsByProj[b.project_id] = [];
        bidsByProj[b.project_id].push(dbToBid(b));
      }

      const projects = projRows.map(r => dbToProj(r, bidsByProj[r.id] || []));
      return res.json({ projects });
    }

    // ── PUT (single project, debounced) ───────────────────────────────────
    if (req.method === 'PUT' && req.query.id) {
      const p = req.body;
      if (!p || p.id !== req.query.id) {
        return res.status(400).json({ error: 'project object with matching id required' });
      }
      // Determine sort order from existing position in DB
      const [existing] = await sql`
        SELECT sort_order FROM projects WHERE id = ${p.id} AND company_code = ${companyCode}
      `;
      await upsertProject(sql, p, companyCode, existing?.sort_order ?? 0);
      return res.json({ ok: true });
    }

    // ── PUT (full sync) ───────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const { projects } = req.body || {};
      if (!Array.isArray(projects)) {
        return res.status(400).json({ error: 'projects array required' });
      }

      // Delete projects removed from the list
      const incomingIds = projects.map(p => p && p.id).filter(Boolean);
      if (incomingIds.length) {
        await sql`
          DELETE FROM projects
          WHERE company_code = ${companyCode} AND id <> ALL(${incomingIds})
        `;
      } else {
        await sql`DELETE FROM projects WHERE company_code = ${companyCode}`;
      }

      // Upsert each project + its bid items
      for (let i = 0; i < projects.length; i++) {
        const p = projects[i];
        if (!p || !p.id) continue;
        await upsertProject(sql, p, companyCode, i);
      }
      return res.json({ ok: true });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      // bid_items cascade via FK; daily_tracking rows need explicit delete
      await sql`DELETE FROM daily_tracking WHERE project_id = ${id} AND company_code = ${companyCode}`;
      await sql`DELETE FROM projects       WHERE id = ${id}          AND company_code = ${companyCode}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[projects]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
