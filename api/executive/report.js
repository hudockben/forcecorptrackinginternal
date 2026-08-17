'use strict';

// GET /api/executive/report
//
// Cross-division roll-up for the Executive Division dashboard.
// Access: platform admins, or any user whose divisionRoles.executive
// is not 'no_access' (gated by hasDivisionAccess below).
//
// Wiring is incremental: the 4 hero KPIs (Active Projects, Revenue
// This Week, AR 30+ Days, Unbilled Intercompany) come from live SQL
// scoped to the caller's company_code. Division tiles, the project
// portfolio, and per-project detail are still mock until subsequent
// passes. Each hero query runs independently and falls back to '—'
// on failure so a single bad query can't blank the report.

const { neon }                          = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const { DUST_IC_SOURCES } = require('../lib/ic-sources');

// "Active" mirrors tracker.html's isDone() inverse: anything whose
// status is NOT 'complete' or 'closed' (case-insensitive) counts as
// active — including null/empty, 'Bidding', 'Awarded', 'In Progress',
// 'Substantially Complete', 'On Hold'. The home page status dropdown
// (tracker.html line 7050) is the source of truth for valid values.
// SQL fragments inline `NOT IN ('complete', 'closed')` after a
// LOWER(COALESCE(status, '')) so binding never relies on Postgres
// array support.

// ── Date / formatting helpers ────────────────────────────────────────────
function startOfWeekISO(d) {
  // Sunday-anchored week, returned as YYYY-MM-DD
  const day = d.getDay();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
  return start.toISOString().slice(0, 10);
}
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function fmtCurrency(n) {
  const v = Math.round(Number(n) || 0);
  // Prefix the minus before the $ ("−$1,234" not "$-1,234") so loss values
  // read cleanly on KPI tiles. Uses U+2212 rather than a hyphen.
  if (v < 0) return '−$' + Math.abs(v).toLocaleString('en-US');
  return '$' + v.toLocaleString('en-US');
}
function fmtRevenueDelta(curr, prev) {
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  const diff = c - p;
  if (Math.abs(diff) < 1) return { delta: 'flat', deltaDir: 'flat' };
  const sign = diff > 0 ? '+' : '−';
  const abs  = Math.abs(diff);
  const txt  = abs >= 1000
    ? `${sign}$${Math.round(abs / 1000)}k vs last week`
    : `${sign}$${Math.round(abs).toLocaleString('en-US')} vs last week`;
  return { delta: txt, deltaDir: diff > 0 ? 'up' : 'down' };
}

// ── Blob readers ─────────────────────────────────────────────────────
// The Turf and Paving home pages persist their project state to
// app_data JSONB blobs (one per project, keyed by
// "{companyCode}:{prefix}{projectId}", with a lightweight index at
// "{companyCode}:{indexKey}"). The legacy single-array blob at
// "{companyCode}:fct_projects" / "fct_paving_projects" is also still
// written as a backup. The normalized `projects` table is incomplete:
// syncProjects only writes id/name/job_number/start_date/pinned (no
// status, no contract_amount, no end_date), so reading from there
// would leave the executive tile blank for any company whose schema
// pre-dates those columns. Reading the blob is what the home pages do
// and is therefore the only source guaranteed to match what the user
// sees on screen.
async function readProjectBlobs(sql, companyCode, indexKey, projKeyPrefix, legacyArrayKey) {
  const idxRow = await sql`
    SELECT value FROM app_data WHERE key = ${`${companyCode}:${indexKey}`}
  `;
  const idx = idxRow[0]?.value;
  const ids = Array.isArray(idx)
    ? idx
    : (idx && Array.isArray(idx.ids) ? idx.ids : []);

  if (ids.length) {
    const keys = ids.map(id => `${companyCode}:${projKeyPrefix}${id}`);
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    const byKey = new Map(rows.map(r => [r.key, r.value]));
    // Preserve index order (pinned-first / most-recent-first depending on
    // how the home page maintains it) so the executive surfaces the same
    // ordering users see in the tracker.
    return ids
      .map(id => byKey.get(`${companyCode}:${projKeyPrefix}${id}`))
      .filter(v => v && typeof v === 'object');
  }

  if (legacyArrayKey) {
    const r = await sql`
      SELECT value FROM app_data WHERE key = ${`${companyCode}:${legacyArrayKey}`}
    `;
    const v = r[0]?.value;
    return Array.isArray(v) ? v.filter(p => p && typeof p === 'object') : [];
  }
  return [];
}

const readTurfProjects   = (sql, cc) => readProjectBlobs(sql, cc, 'fct_projects_index',        'fct_project_',        'fct_projects');
const readPavingProjects = (sql, cc) => readProjectBlobs(sql, cc, 'fct_paving_projects_index', 'fct_paving_project_', 'fct_paving_projects');
const readKiewitProjects = (sql, cc) => readProjectBlobs(sql, cc, 'fct_kiewit_projects_index', 'fct_kiewit_project_', 'fct_kiewit_projects');

// The divisions that run jobs: each has projects, bid items and a contract
// value, and each has a home page whose layout this report mirrors. Trucking,
// Dust and Quarry have no jobs, so they are not in here.
const PROJECT_DIVISIONS = [
  { key: 'turf',   name: 'Turf Management', accent: '#22c55e', read: readTurfProjects   },
  { key: 'paving', name: 'Paving',          accent: '#60a5fa', read: readPavingProjects },
  { key: 'kiewit', name: 'Kiewit Pinetree', accent: '#a78bfa', read: readKiewitProjects },
];

// Rubber inventory blob — same shape as the home page's `inventoryEntries`.
// Entries with project_id are treated as "used by a project", entries without
// project_id are stock-add (produced). Mirrors tracker.html ~line 3756.
async function readInventoryEntries(sql, companyCode) {
  const rows = await sql`
    SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_inventory`}
  `;
  const v = rows[0]?.value;
  return Array.isArray(v) ? v.filter(e => e && typeof e === 'object') : [];
}

// Project-shape helpers (turf and paving blobs share the same dashed-key
// naming convention — 'project-name', 'job-number', 'contract-amount',
// 'start-date', 'end-date'/'target-completion'). Paving uses 'Complete'/'Active';
// turf uses tracker.html's status taxonomy ('In Progress', 'Complete',
// 'Closed', 'On Hold', 'Bidding', 'Awarded', 'Substantially Complete'),
// matching home page isDone() inverse.
const projName = p => String(p['project-name'] || p.name || '').trim() || 'Untitled';
const projJob  = p => String(p['job-number']   || p.job_number || '').trim();
const projStatus = p => String(p['status'] || p.status || '').trim();
const projIsComplete = p => ['complete','closed'].includes(projStatus(p).toLowerCase());

// Executive rollup cutoff: legacy / preloaded projects have job numbers
// below this threshold. Real production projects start at Saint Edmunds
// (job # 25019), so excluding anything below that keeps the rollup honest.
const EXEC_MIN_JOB_NUMBER = 25019;
function projJobInt(p) {
  // Concatenate every digit (handles "2026-0220", "26-022-0", "26 0220",
  // "JOB-260220", etc.) instead of just the leading run. Job numbers in
  // tracker.html are free-text (placeholder "e.g. 2025-014") so hyphens
  // are expected.
  const digits = String(projJob(p) || '').replace(/\D/g, '');
  return digits ? parseInt(digits, 10) : NaN;
}
// Per-project opt-out toggle set in tracker.html / paving.html
// ("Executive Report" select on the project info card).
const projExcludedFromExec = p =>
  p && (p['exclude-from-executive'] === true || p.exclude_from_executive === true);

const projMeetsExecCutoff = p => {
  if (projExcludedFromExec(p)) return false;
  const n = projJobInt(p);
  return Number.isFinite(n) && n >= EXEC_MIN_JOB_NUMBER;
};
const projStartDate  = p => p['start-date'] || p.start_date || null;
const projEndDate    = p => p['end-date']   || p.end_date   || p['target-completion'] || p.target_completion || null;
const projPinned     = p => p.pinned === true;
const projClient     = p => String(p['client'] || p.client || '').trim();
const projPm         = p => String(p['pm']     || p.pm     || '').trim();

function projNum(v) {
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
// Read order mirrors tracker.html / paving.html (line 3911 / 3773):
// revised contract amount > original contract amount > contract value.
// `contract-value` is the field shown in the project header info card,
// which many users fill in without ever opening the secondary
// "Contract & Financials" panel that holds contract-amount / revised-amount.
const projContract = p => projNum(
  p['revised-amount']  || p.revised_amount  ||
  p['contract-amount'] || p.contract_amount ||
  p['contract-value']  || p.contract_value
);

// Bid totals per project. Each bid item carries quantity + unit_cost
// (paving uses bid_item_cost as an alias). Returns the total bid dollars
// AND a per-(cost_code, sub_code) breakdown for finer projection scaling
// when daily actuals are joined back.
//
// Quantity is the EFFECTIVE quantity — the bid quantity plus every change
// order booked against the line. The division pages have always read it that
// way (their _effQty helper), so leaving change orders out here reported a
// smaller bid budget than the page the number came from.
function projBidLines(p) {
  const items = Array.isArray(p.bidItems) ? p.bidItems : [];
  const coQty = b => (Array.isArray(b.change_orders) ? b.change_orders : [])
    .reduce((s, co) => s + projNum(co && co.qty_delta), 0);
  return items.map(b => ({
    cost_code: String(b.cost_code || b.costCode || ''),
    sub_code:  String(b.sub_code  || b.subCode  || ''),
    quantity:  projNum(b.quantity) + coQty(b),
    unit_cost: projNum(b.unit_cost ?? b.unitCost ?? b.bid_item_cost ?? b.bidItemCost),
    start_date:  b.start_date  || b.startDate  || null,
    target_date: b.target_date || b.targetDate || null,
    description: b.description || '',
    unit:        b.unit || '',
    status:      b.status || 'Active',
    // Drives the projection: a completed line's actual IS its final cost. Only
    // the Schedule-tab flag travels in the blob — the division pages also treat
    // a sub code as done when the Construction Schedule says so, which lives in
    // a separate key this rollup does not read.
    is_complete: !!(b.is_complete || b.isComplete),
  }));
}
const projBidTotal = p => projBidLines(p).reduce((s, b) => s + b.quantity * b.unit_cost, 0);

// Each KPI runs independently; one failure must not poison the response.
async function safeRun(label, fn) {
  try { return await fn(); }
  catch (err) {
    console.error(`[executive/report] ${label} failed:`, err.message);
    return null;
  }
}

// Smoke-test the live SQL surface area when ?debug=1 is set. Returns
// pass/fail per probe with a sample row so we can see what's happening
// without server logs. Read-only — runs simple queries that don't touch
// the main report.
async function runDiagnostics(sql, companyCode) {
  const probes = [
    {
      label: 'projects.count_all',
      fn: async () => {
        const r = await sql`SELECT COUNT(*)::int AS n FROM projects WHERE company_code = ${companyCode}`;
        return { count: r[0]?.n };
      },
    },
    {
      label: 'projects.count_active',
      fn: async () => {
        const r = await sql`
          SELECT COUNT(*)::int AS n
            FROM projects
           WHERE company_code = ${companyCode}
             AND LOWER(COALESCE(status, '')) NOT IN ('complete', 'closed')
        `;
        return { count: r[0]?.n };
      },
    },
    {
      label: 'projects.distinct_statuses',
      fn: async () => {
        const r = await sql`
          SELECT COALESCE(status, '<null>') AS status, COUNT(*)::int AS n
            FROM projects
           WHERE company_code = ${companyCode}
           GROUP BY status
           ORDER BY n DESC
           LIMIT 20
        `;
        return { statuses: r };
      },
    },
    {
      label: 'projects.sample_columns',
      fn: async () => {
        // Confirm the columns the report relies on actually exist.
        const r = await sql`
          SELECT id, name, job_number, status, contract_amount,
                 start_date, end_date, pinned, updated_at
            FROM projects
           WHERE company_code = ${companyCode}
           ORDER BY updated_at DESC NULLS LAST
           LIMIT 1
        `;
        return { sample: r[0] || null };
      },
    },
    {
      label: 'projects.pinned_count',
      fn: async () => {
        const r = await sql`SELECT COUNT(*)::int AS n FROM projects WHERE company_code = ${companyCode} AND pinned = TRUE`;
        return { count: r[0]?.n };
      },
    },
    {
      label: 'bid_items.count',
      fn: async () => {
        const r = await sql`SELECT COUNT(*)::int AS n FROM bid_items WHERE company_code = ${companyCode}`;
        return { count: r[0]?.n };
      },
    },
    {
      label: 'daily_tracking.count',
      fn: async () => {
        const r = await sql`SELECT COUNT(*)::int AS n FROM daily_tracking WHERE company_code = ${companyCode}`;
        return { count: r[0]?.n };
      },
    },
  ];

  const out = [];
  for (const p of probes) {
    try {
      const data = await p.fn();
      out.push({ label: p.label, ok: true, ...data });
    } catch (err) {
      out.push({ label: p.label, ok: false, error: err.message, code: err.code });
    }
  }
  return out;
}

// Live hero KPIs scoped to the platform admin's primary companyCode.
async function buildHero(sql, companyCode) {
  const today          = new Date();
  const weekStart      = startOfWeekISO(today);
  const weekEnd        = addDaysISO(weekStart, 7);
  const lastWeekStart  = addDaysISO(weekStart, -7);
  const lastWeekEnd    = weekStart;

  // Active projects = every job-running division's blobs whose status isn't
  // Complete/Closed. Each division's blobs are read in parallel and the active
  // counts summed, so the hero KPI mirrors what users see across the home pages.
  const activeProjects = await safeRun('active_projects', async () => {
    const perDivision = await Promise.all(PROJECT_DIVISIONS.map(d =>
      d.read(sql, companyCode).catch(() => [])
    ));
    return perDivision.reduce((n, list) =>
      n + list.filter(p => projMeetsExecCutoff(p) && !projIsComplete(p)).length, 0);
  });

  // Bucketed by actual_date — the date the work was performed — not by
  // sent_at, which only records when a row was mirrored into Intercompany.
  // Those diverge whenever someone enters last month's work today, and a
  // division switching to auto-sync restamps its whole backlog with sent_at =
  // now, which under the old query landed every historical row in "this week".
  // actual_date is also what buildDustTile and the other division tiles use,
  // so the hero KPI now agrees with the tiles beneath it.
  const revNow = await safeRun('revenue_this_week', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND actual_date >= ${weekStart}
         AND actual_date <  ${weekEnd}
    `;
    return rows[0]?.v ?? 0;
  });

  const revPrev = await safeRun('revenue_last_week', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND actual_date >= ${lastWeekStart}
         AND actual_date <  ${lastWeekEnd}
    `;
    return rows[0]?.v ?? 0;
  });

  const ar30 = await safeRun('ar_30', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND invoice_sent_date IS NOT NULL
         AND invoice_sent_date < (CURRENT_DATE - INTERVAL '30 days')
         AND date_paid IS NULL
         AND (invoice_status IS NULL OR LOWER(invoice_status) NOT LIKE 'paid%')
    `;
    return rows[0]?.v ?? 0;
  });

  const unbilledIc = await safeRun('unbilled_ic', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND (qb_invoice IS NULL OR TRIM(qb_invoice) = '')
    `;
    return rows[0]?.v ?? 0;
  });

  const revDelta = (revNow != null && revPrev != null)
    ? fmtRevenueDelta(revNow, revPrev)
    : { delta: '—', deltaDir: 'flat' };

  return [
    {
      label:    'Active Projects',
      value:    activeProjects != null ? String(activeProjects) : '—',
      delta:    'Excludes Complete / Closed',
      deltaDir: 'flat',
    },
    {
      label:    'Revenue · This Week',
      value:    revNow != null ? fmtCurrency(revNow) : '—',
      delta:    revDelta.delta,
      deltaDir: revDelta.deltaDir,
    },
    {
      label:    'AR · 30+ Days',
      value:    ar30 != null ? fmtCurrency(ar30) : '—',
      delta:    'Outstanding past 30d',
      deltaDir: 'flat',
    },
    {
      label:    'Unbilled Intercompany',
      value:    unbilledIc != null ? fmtCurrency(unbilledIc) : '—',
      delta:    'Sent · no QB invoice',
      deltaDir: 'flat',
    },
  ];
}

// ── Division tile builders ────────────────────────────────────────────
// Each builder returns the full tile object the front-end expects (key,
// name, accent, status, statusKind, kpis). Project-driven tiles (Turf,
// Paving) read their state from JSONB blobs and join actuals from
// daily_tracking by project_id + division. The other tiles
// (Trucking / Dust / IC) read from their own normalized tables.

// Aggregate per-bid-item projection that mirrors tracker.html's
// projForBidItem(): if the item has start/target dates and any actuals,
// scale by elapsed-vs-total time; else if a running quantity exists,
// scale by qty burn rate; else fall back to the bid total. Inputs:
//   projects: array of blob objects (already filtered to "active")
//   division: 'turf' | 'paving' — used to scope daily_tracking
async function buildFinancials(sql, companyCode, division, projects) {
  const ids = projects.map(p => p.id).filter(Boolean);
  // Daily cost groups (cost_code/sub_code) per project. The per-row cost mirrors
  // tracker.html's dailyRowCost/calcDaily EXACTLY so the Executive reconciles
  // with the home page: total_cost_override (if non-zero) wins, else
  // labor*rate + (equip_total_override || equip_hours*equip_unit_cost) + material.
  // NULLIF(...,0) reproduces calcDaily's `override || computed` short-circuit;
  // the previous formula ignored equip_total_override and understated actuals.
  const groupsByProject = new Map();
  if (ids.length) {
    const rows = await sql`
      SELECT
        project_id,
        cost_code,
        COALESCE(sub_code, '') AS sub_code,
        SUM(
          COALESCE(NULLIF(total_cost_override, 0),
            COALESCE(labor_hours, 0) * COALESCE(rate, 0)
            + COALESCE(NULLIF(equip_total_override, 0),
                       COALESCE(equip_hours, 0) * COALESCE(equip_unit_cost, 0))
            + COALESCE(material_cost, 0)
          )
        )::float                           AS actual,
        SUM(COALESCE(quantity, 0))::float  AS rqty
      FROM daily_tracking
      WHERE company_code = ${companyCode}
        AND division     = ${division}
        AND project_id   = ANY(${ids})
      GROUP BY project_id, cost_code, COALESCE(sub_code, '')
    `;
    for (const r of rows) {
      const list = groupsByProject.get(r.project_id) || [];
      list.push({
        cost_code: r.cost_code || '',
        sub_code:  r.sub_code  || '',
        actual:    Number(r.actual) || 0,
        rqty:      Number(r.rqty)   || 0,
      });
      groupsByProject.set(r.project_id, list);
    }
  }

  const today = Date.now();
  const perProject = new Map();
  let contract_total = 0, bid_total = 0, actual_total = 0, projected_total = 0;

  // Wildcard match — mirrors tracker.html actualForBidItem(): a bid line matches
  // a daily group when the line's cost_code is blank OR equal AND its sub_code
  // is blank OR equal. A blank bid sub_code therefore catches every sub_code
  // under that cost code (the home page treats it as a wildcard, so we must too
  // or on-bid spend gets falsely flagged as off-bid).
  const lineMatchesGroup = (b, g) =>
    (b.cost_code ? g.cost_code === b.cost_code : true) &&
    (b.sub_code  ? g.sub_code  === b.sub_code  : true);
  // tracker skips bid lines with neither code (actualForBidItem returns 0).
  const lineHasKey = b => !!(b.cost_code || b.sub_code);

  for (const p of projects) {
    contract_total += projContract(p);
    const groups   = groupsByProject.get(p.id) || [];
    const bidLines = projBidLines(p);

    // Project actual = every daily group (matches the home page's all-rows sum).
    // Off-bid spend is included here, then surfaced separately below, so the
    // headline figure never silently drops money.
    const actual = groups.reduce((s, g) => s + g.actual, 0);

    // Per-bid-item projection — mirrors projectedCostForProject(): scale each
    // bid item by its own wildcard-matched actuals/quantities.
    let bid = 0, projected = 0;
    const projDone = projIsComplete(p);
    for (const b of bidLines) {
      const itemBid = b.quantity * b.unit_cost;
      bid += itemBid;

      let a = 0, rq = 0;
      if (lineHasKey(b)) {
        for (const g of groups) {
          if (lineMatchesGroup(b, g)) { a += g.actual; rq += g.rqty; }
        }
      }

      // Mirrors projForBidItem(): spend already booked is a floor, so no branch
      // may project a line below its own actual cost.
      let proj;
      const startMs  = b.start_date  ? new Date(b.start_date  + 'T00:00:00Z').getTime() : null;
      const targetMs = b.target_date ? new Date(b.target_date + 'T00:00:00Z').getTime() : null;
      if (!(a > 0)) {
        proj = itemBid;
      } else if (projDone || b.is_complete) {
        proj = a;
      } else if (startMs != null && targetMs != null && today > startMs && targetMs > startMs) {
        const total   = targetMs - startMs;
        const elapsed = today - startMs;
        proj = Math.max(a, a * (total / elapsed));
      } else if (rq > 0 && b.quantity > 0) {
        // rq > quantity means the line overran its bid qty; scaling back down to
        // the bid qty would project less than we have spent, hence the floor.
        proj = Math.max(a, (a / rq) * b.quantity);
      } else {
        proj = Math.max(a, itemBid);
      }
      projected += proj;
    }

    // Off-bid: daily groups that match NO bid line (wildcard-aware). They are
    // included in `actual` above but attributed to no bid item. Flag them with
    // the offending codes + amounts. By construction actual === on-bid + offBid.
    let offBid = 0;
    const offBidCodes = [];
    for (const g of groups) {
      if (bidLines.some(b => lineHasKey(b) && lineMatchesGroup(b, g))) continue;
      offBid += g.actual;
      offBidCodes.push({ cost_code: g.cost_code, sub_code: g.sub_code, actual: g.actual });
    }
    offBidCodes.sort((a, b) => b.actual - a.actual);

    // A finished project cost what it cost. Otherwise off-bid spend belongs to
    // no bid line's projection, so it adds ON TOP of the line sum — and the
    // result still may not undercut what has already gone out the door.
    projected = projDone ? actual : Math.max(projected + offBid, actual);

    bid_total       += bid;
    actual_total    += actual;
    projected_total += projected;
    perProject.set(p.id, { contract: projContract(p), bid, actual, projected, offBid, offBidCodes });
  }
  return { contract_total, bid_total, actual_total, projected_total, perProject };
}

async function buildTruckingTile(sql, companyCode, weekStart, weekEnd) {
  const activeHauls = await safeRun('trucking.active_hauls', async () => {
    const rows = await sql`
      SELECT COUNT(DISTINCT project_id)::int AS n
        FROM trucking_entries
       WHERE company_code = ${companyCode}
         AND project_id IS NOT NULL
         AND date >= (CURRENT_DATE - INTERVAL '7 days')
    `;
    return rows[0]?.n ?? 0;
  });
  const loadsWk = await safeRun('trucking.loads_wk', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(loads), 0)::float AS v
        FROM trucking_entries
       WHERE company_code = ${companyCode}
         AND date >= ${weekStart}
         AND date <  ${weekEnd}
    `;
    return rows[0]?.v ?? 0;
  });
  const invoicedWk = await safeRun('trucking.invoiced_wk', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(haul_fee), 0)::float AS v
        FROM truck_division_entries
       WHERE company_code = ${companyCode}
         AND invoice_sent_date >= ${weekStart}
         AND invoice_sent_date <  ${weekEnd}
    `;
    return rows[0]?.v ?? 0;
  });
  const unbilled = await safeRun('trucking.unbilled', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(haul_fee), 0)::float AS amt,
             COUNT(*)::int                     AS n
        FROM truck_division_entries
       WHERE company_code = ${companyCode}
         AND invoice_sent_date IS NULL
    `;
    return { amt: rows[0]?.amt ?? 0, n: rows[0]?.n ?? 0 };
  });

  return {
    key: 'trucking', name: 'Trucking', accent: '#ef4444',
    status: 'On Track', statusKind: 'green',
    kpis: [
      { label: 'Active Hauls',  value: activeHauls != null ? String(activeHauls)             : '—' },
      { label: 'Loads · Wk',    value: loadsWk     != null ? Math.round(loadsWk).toLocaleString('en-US') : '—' },
      { label: 'Invoiced · Wk', value: invoicedWk  != null ? fmtCurrency(invoicedWk)         : '—' },
      {
        label: 'Unbilled',
        value: unbilled?.amt != null ? fmtCurrency(unbilled.amt) : '—',
        sub:   unbilled?.n   ? `${unbilled.n} entries` : null,
      },
    ].map(k => { if (k.sub == null) delete k.sub; return k; }),
  };
}

// Dust — simplified to revenue-focused per executive feedback.
// Revenue is computed canonically from dust_control_entries:
//   v1_rate × hours + v2_rate × hours + gallons_ub × dust_settings.ub_rate
// Hours are derived from start_time/end_time (HH:MM strings); rows with
// malformed times contribute 0 hours to the rate fees but their gallons
// still count toward the UB fee. GREATEST(0, ...) guards against
// overnight time wraparound producing negative intervals.
async function buildDustTile(sql, companyCode, weekStart, weekEnd) {
  // Per-customer UB $/gal override column may not exist on older DBs; the
  // dust-config endpoint adds it lazily, but the report can run first. Ensure
  // it so the revenue joins below can reference dust_companies.ub_rate.
  await safeRun('dust.ensure_ub_col', () =>
    sql`ALTER TABLE IF EXISTS dust_companies ADD COLUMN IF NOT EXISTS ub_rate NUMERIC(10,4)`);

  // Revenue · This Week
  const revWk = await safeRun('dust.revenue_wk', async () => {
    const rows = await sql`
      SELECT
        COALESCE(SUM(
          COALESCE(v1_rate, 0)     * GREATEST(0, hrs)
          + COALESCE(v2_rate, 0)   * GREATEST(0, hrs)
          + COALESCE(gallons_ub, 0)
            * COALESCE(co_ub_rate, (SELECT ub_rate::float FROM dust_settings WHERE company_code = ${companyCode}), 0)
        ), 0)::float AS v
      FROM (
        SELECT
          d.v1_rate, d.v2_rate, d.gallons_ub,
          c.ub_rate::float AS co_ub_rate,
          CASE
            WHEN d.start_time ~ '^[0-9]{1,2}:[0-9]{2}'
             AND d.end_time   ~ '^[0-9]{1,2}:[0-9]{2}'
            THEN EXTRACT(EPOCH FROM (d.end_time::time - d.start_time::time)) / 3600.0
            ELSE 0
          END AS hrs
        FROM dust_control_entries d
        LEFT JOIN dust_companies c
          ON c.company_code = d.company_code AND c.name = d.company
        WHERE d.company_code = ${companyCode}
          AND d.date >= ${weekStart}
          AND d.date <  ${weekEnd}
      ) e
    `;
    return rows[0]?.v ?? 0;
  });

  // Revenue · This Month (calendar month, not last 30 days)
  const revMo = await safeRun('dust.revenue_mo', async () => {
    const rows = await sql`
      SELECT
        COALESCE(SUM(
          COALESCE(v1_rate, 0)     * GREATEST(0, hrs)
          + COALESCE(v2_rate, 0)   * GREATEST(0, hrs)
          + COALESCE(gallons_ub, 0)
            * COALESCE(co_ub_rate, (SELECT ub_rate::float FROM dust_settings WHERE company_code = ${companyCode}), 0)
        ), 0)::float AS v
      FROM (
        SELECT
          d.v1_rate, d.v2_rate, d.gallons_ub,
          c.ub_rate::float AS co_ub_rate,
          CASE
            WHEN d.start_time ~ '^[0-9]{1,2}:[0-9]{2}'
             AND d.end_time   ~ '^[0-9]{1,2}:[0-9]{2}'
            THEN EXTRACT(EPOCH FROM (d.end_time::time - d.start_time::time)) / 3600.0
            ELSE 0
          END AS hrs
        FROM dust_control_entries d
        LEFT JOIN dust_companies c
          ON c.company_code = d.company_code AND c.name = d.company
        WHERE d.company_code = ${companyCode}
          AND d.date >= date_trunc('month', CURRENT_DATE)
          AND d.date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
      ) e
    `;
    return rows[0]?.v ?? 0;
  });

  // Activity context
  const gallonsWk = await safeRun('dust.gallons_wk', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(gallons_ub), 0)::float AS v
        FROM dust_control_entries
       WHERE company_code = ${companyCode}
         AND date >= ${weekStart}
         AND date <  ${weekEnd}
    `;
    return rows[0]?.v ?? 0;
  });
  const activeRoutes = await safeRun('dust.active_routes', async () => {
    const rows = await sql`
      SELECT COUNT(DISTINCT company)::int AS n
        FROM dust_control_entries
       WHERE company_code = ${companyCode}
         AND date >= (CURRENT_DATE - INTERVAL '30 days')
         AND company IS NOT NULL
         AND TRIM(company) <> ''
    `;
    return rows[0]?.n ?? 0;
  });

  return {
    key: 'dust', name: 'Dust Control', accent: '#fbbf24',
    status: 'On Track', statusKind: 'green',
    kpis: [
      { label: 'Revenue · Wk',  value: revWk        != null ? fmtCurrency(revWk) : '—' },
      { label: 'Revenue · Mo',  value: revMo        != null ? fmtCurrency(revMo) : '—' },
      { label: 'Gallons · Wk',  value: gallonsWk    != null ? Math.round(gallonsWk).toLocaleString('en-US') : '—' },
      { label: 'Active Routes', value: activeRoutes != null ? String(activeRoutes) : '—' },
    ],
  };
}

// ── Per-division project portfolios (page 2+) ────────────────────────
// One block per job-running division, shaped like that division's own home
// page: the metric strip across the top, then the project table beneath it
// (pinned first, then the most recent). The layout is copied deliberately —
// an executive reading a figure here should find the identical figure on the
// division page it came from, with no translation in between.
//
// Everything the division owns feeds the metric strip. The table shows the
// same six rows the home page shows, with the rest reported as a count.

// tracker.html / paving.html / kiewit-pinetree.html each cap the home tab at
// six projects (MAX_CARDS), and their tables list those same six.
const MAX_PORTFOLIO_ROWS = 6;

const pct1 = n => `${(Number(n) || 0).toLocaleString('en-US', {
  minimumFractionDigits: 1, maximumFractionDigits: 1,
})}%`;

// Bid-item statuses drive the home table's Status cell: a line flagged At Risk
// or On Hold outranks the project's own status there, because it is the thing
// that needs someone to look at it.
function bidStatusCounts(p) {
  const items = Array.isArray(p.bidItems) ? p.bidItems : [];
  let atRisk = 0, onHold = 0;
  for (const b of items) {
    if (!b) continue;
    if      (b.status === 'At Risk') atRisk++;
    else if (b.status === 'On Hold') onHold++;
  }
  return { atRisk, onHold };
}

// Days to the target completion date. null for a finished job (its deadline
// stopped mattering) or one with no end date recorded.
function daysLeftFor(p) {
  const end = projEndDate(p);
  if (!end || projIsComplete(p)) return null;
  const endMs = new Date(String(end) + 'T00:00:00Z').getTime();
  if (!Number.isFinite(endMs)) return null;
  return Math.ceil((endMs - Date.now()) / 86400000);
}

function portfolioRow(p, fin) {
  const f         = fin || { bid: 0, actual: 0, projected: 0, offBid: 0, offBidCodes: [] };
  const contract  = projContract(p);
  const bid       = Number(f.bid)       || 0;
  const actual    = Number(f.actual)    || 0;
  const projected = Number(f.projected) || 0;
  const { atRisk, onHold } = bidStatusCounts(p);

  // Progress is spend against budget, so it tracks the same three bands the
  // division pages use: at or over budget is red, the last 15% is amber.
  const burn = bid > 0 ? actual / bid : null;
  const progressTone = burn == null ? 'mute' : burn >= 1 ? 'red' : burn >= 0.85 ? 'amber' : 'green';
  const projectedTone = bid <= 0        ? 'mute'
                      : projected > bid        ? 'red'
                      : projected > bid * 0.85 ? 'amber'
                      : 'green';

  // A job with no contract value has no revenue to subtract a cost from, so
  // its profit is unknown rather than zero. Actual Profit additionally needs
  // real spend behind it — contract minus nothing would post an untouched job
  // as pure margin.
  const profit    = contract > 0 && projected > 0 ? contract - projected : null;
  const actProfit = contract > 0 && actual    > 0 ? contract - actual    : null;

  return {
    id:          p.id,
    name:        projName(p),
    jobNumber:   projJob(p) || '',
    client:      projClient(p),
    pm:          projPm(p),
    status:      projStatus(p),
    atRisk,
    onHold,
    daysLeft:    daysLeftFor(p),
    pinned:      projPinned(p),
    progressPct: burn == null ? 0 : Math.min(Math.round(burn * 100), 100),
    progressTone,
    projectedTone,
    contract,
    bid,
    actual,
    variance:    bid - actual,
    projected,
    profit,
    profitPct:    profit    != null && contract > 0 ? (profit    / contract) * 100 : null,
    actProfit,
    actProfitPct: actProfit != null && contract > 0 ? (actProfit / contract) * 100 : null,
    offBid:      Number(f.offBid) || 0,
    offBidCodes: Array.isArray(f.offBidCodes) ? f.offBidCodes : [],
  };
}

// The metric strip, in the division pages' own words. The split between "in
// progress" and "awarded" is theirs too and it matters: an awarded job carries
// a contract and a budget but has spent nothing against either, so folding it
// into Actual Spend or Variance would report the company further under budget
// every time it won work. Actual Profit is what finished work returned, so it
// covers completed jobs only.
function portfolioMetrics(rows, totalProjects) {
  const live = rows.filter(r => r.status === 'In Progress');
  const awd  = rows.filter(r => r.status === 'Awarded');
  const done = rows.filter(r => r.complete && r.actProfit != null);
  const sum  = (list, k) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);

  const ipContract = sum(live, 'contract');
  const ipBid      = sum(live, 'bid');
  const ipActual   = sum(live, 'actual');
  const awContract = sum(awd,  'contract');
  const awBid      = sum(awd,  'bid');

  const ipVariance = ipBid - ipActual;
  const burnPct    = ipBid > 0 ? (ipActual / ipBid) * 100 : 0;
  const spendTone  = burnPct >= 100 ? 'red' : burnPct >= 85 ? 'amber' : 'green';

  // Only jobs carrying a contract can contribute a profit figure, and the
  // margin percentage has to be read against those same jobs' contracts.
  const withContract   = [...live, ...awd].filter(r => r.profit != null);
  const bookProfit     = sum(withContract, 'profit');
  const bookProfitBase = sum(withContract, 'contract');
  const doneProfit     = sum(done, 'actProfit');

  const bookCount    = live.length + awd.length;
  const bookContract = ipContract + awContract;

  return [
    {
      label: 'Active Projects',
      value: String(bookCount),
      sub:   awd.length
        ? `${live.length} in progress · ${awd.length} awarded`
        : `in progress of ${totalProjects}`,
      tone: 'blue',
    },
    {
      label: 'Total Contract Value',
      value: fmtCurrency(bookContract),
      sub:   awd.length ? 'in progress + awarded' : 'in progress jobs',
      tone:  'blue',
    },
    {
      label: 'Awarded Backlog',
      value: fmtCurrency(awContract),
      sub:   awd.length
        ? `${awd.length} awarded job${awd.length === 1 ? '' : 's'} not started`
        : 'nothing awarded',
      tone: awContract ? 'awarded' : 'plain',
    },
    {
      label: 'Total Bid Budget',
      value: fmtCurrency(ipBid + awBid),
      sub:   awd.length ? 'in progress + awarded' : 'in progress jobs',
      tone:  'green',
    },
    {
      label: 'Total Actual Spend',
      value: fmtCurrency(ipActual),
      sub:   `${pct1(burnPct)} of in-progress budget`,
      tone:  spendTone,
    },
    {
      label: 'Total Variance',
      value: fmtCurrency(ipVariance),
      sub:   `${ipVariance >= 0 ? 'under' : 'over'} budget · in progress`,
      tone:  ipVariance >= 0 ? 'green' : 'red',
    },
    {
      label: 'Total Projected Profit',
      value: fmtCurrency(bookProfit),
      sub:   bookProfitBase
        ? `${pct1((bookProfit / bookProfitBase) * 100)} margin`
        : (awd.length ? 'in progress + awarded' : 'in progress jobs'),
      tone:  bookProfit >= 0 ? 'green' : 'red',
    },
    {
      label: 'Total Actual Profit',
      value: fmtCurrency(doneProfit),
      sub:   `${done.length} completed job${done.length === 1 ? '' : 's'}`,
      tone:  doneProfit >= 0 ? 'green' : 'red',
    },
  ];
}

async function buildDivisionPortfolio(sql, companyCode, div) {
  const all = (await div.read(sql, companyCode)).filter(projMeetsExecCutoff);

  // One grouped query covers the whole division, so the strip can be built
  // from every project rather than just the six on show.
  const fin = all.length
    ? await buildFinancials(sql, companyCode, div.key, all)
    : null;
  const finFor = p => (fin && fin.perProject.get(p.id)) || null;

  const allRows = all.map(p => {
    const row = portfolioRow(p, finFor(p));
    row.complete = projIsComplete(p);
    return row;
  });

  // Row order mirrors the home pages: pinned first (most recently pinned
  // first), then the most recent unpinned, six in total.
  const pinned   = allRows.filter(r => r.pinned).slice().reverse().slice(0, MAX_PORTFOLIO_ROWS);
  const unpinned = allRows.filter(r => !r.pinned).slice().reverse()
    .slice(0, MAX_PORTFOLIO_ROWS - pinned.length);
  const rows     = [...pinned, ...unpinned];
  const hidden   = Math.max(0, allRows.filter(r => !r.pinned).length - unpinned.length);

  const onHoldProjects = allRows.filter(r => r.status === 'On Hold').length;
  const live           = allRows.filter(r => r.status === 'In Progress' || r.status === 'Awarded');
  const overContract   = live.filter(r => r.profit != null && r.profit < 0).length;

  let status, statusKind;
  if      (!allRows.length)    { status = 'No Projects';   statusKind = 'mute';  }
  else if (overContract > 0)   { status = 'Margin Risk';   statusKind = 'amber'; }
  else if (onHoldProjects > 0) { status = `${onHoldProjects} On Hold`; statusKind = 'amber'; }
  else                         { status = 'On Track';      statusKind = 'green'; }

  return {
    key:     div.key,
    name:    div.name,
    accent:  div.accent,
    status,
    statusKind,
    metrics: portfolioMetrics(allRows, allRows.length),
    rows,
    shown:   rows.length,
    pinned:  pinned.length,
    recent:  unpinned.length,
    hidden,
    total:   allRows.length,
  };
}

// A division whose blobs can't be read is reported as an errored division
// rather than dropped, so a missing index reads as "couldn't load" instead of
// silently looking like a division with no work.
function buildDivisionPortfolios(sql, companyCode) {
  return Promise.all(PROJECT_DIVISIONS.map(div =>
    buildDivisionPortfolio(sql, companyCode, div).catch(err => {
      console.error(`[executive/report] ${div.key} portfolio failed:`, err.message);
      return {
        key: div.key, name: div.name, accent: div.accent,
        status: 'Unavailable', statusKind: 'mute',
        metrics: [], rows: [],
        shown: 0, pinned: 0, recent: 0, hidden: 0, total: 0,
        error: true,
      };
    })
  ));
}

// ── Per-project detail (page 3+) ─────────────────────────────────────
// Returns the top 6 active projects with full header info plus
// section blocks (bid items, weekly trucking activity). Quarry and
// dust sections are intentionally omitted until quarry data lands
// and dust gains a project linkage. Each per-project sub-query runs
// in parallel and is independently safe-wrapped.
// Per-project detail (page 3+): top 6 active across every job-running
// division by earliest start date. Bid items come from the blob, booked cost +
// weekly trucking come from the normalized tables joined by project_id.
async function buildProjectDetails(sql, companyCode) {
  const perDivision = await Promise.all(PROJECT_DIVISIONS.map(async d => ({
    division: d.key,
    blobs:    await d.read(sql, companyCode).catch(() => []),
  })));

  const tagged = perDivision
   .flatMap(({ division, blobs }) => blobs.map(p => ({ p, division })))
   .filter(({ p }) => projMeetsExecCutoff(p) && !projIsComplete(p))
   .sort((a, b) => {
     const sa = projStartDate(a.p) || '';
     const sb = projStartDate(b.p) || '';
     // empty start dates sort last
     if (!sa && !sb) return projName(a.p).localeCompare(projName(b.p));
     if (!sa) return 1;
     if (!sb) return -1;
     return sa.localeCompare(sb);
   })
   .slice(0, 6);

  if (!tagged.length) return [];

  return Promise.all(tagged.map(async ({ p, division }) => {
    const [weeks, booked] = await Promise.all([
      safeRun(`details.weeks.${p.id}`, async () => {
        return await sql`
          SELECT
            date_trunc('week', date)::date::text                                AS week_start,
            COALESCE(SUM(loads),  0)::float                                     AS loads,
            COALESCE(SUM(hours),  0)::float                                     AS hours,
            COALESCE(SUM(COALESCE(loads,0) * COALESCE(rate,0)), 0)::float       AS dollars
          FROM trucking_entries
          WHERE company_code = ${companyCode}
            AND project_id   = ${p.id}
          GROUP BY date_trunc('week', date)
          ORDER BY week_start DESC
          LIMIT 4
        `;
      }),
      safeRun(`details.booked.${p.id}`, async () => {
        const rows = await sql`
          SELECT
            COALESCE(SUM(
              COALESCE(total_cost_override,
                COALESCE(labor_hours, 0) * COALESCE(rate, 0)
                + COALESCE(equip_hours, 0) * COALESCE(equip_unit_cost, 0)
                + COALESCE(material_cost, 0)
              )
            ), 0)::float AS booked
          FROM daily_tracking
          WHERE company_code = ${companyCode}
            AND division     = ${division}
            AND project_id   = ${p.id}
        `;
        return rows[0]?.booked ?? 0;
      }),
    ]);

    return buildDetailObject(p, division, projBidLines(p), weeks, booked);
  }));
}

function buildDetailObject(p, division, bidItems, weeks, booked) {
  const start = projStartDate(p);
  const end   = projEndDate(p);
  const startMs = start ? new Date(start + 'T00:00:00Z').getTime() : null;
  const endMs   = end   ? new Date(end   + 'T00:00:00Z').getTime() : null;
  const todayMs = Date.now();

  let pctComplete = '—';
  if (startMs != null && endMs != null && endMs > startMs) {
    const elapsed = Math.max(0, Math.min(todayMs, endMs) - startMs);
    pctComplete = Math.round((elapsed / (endMs - startMs)) * 100) + '%';
  }

  const fmtDate = iso =>
    iso
      ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

  const sections = {};

  if (Array.isArray(bidItems) && bidItems.length) {
    const accent = (PROJECT_DIVISIONS.find(d => d.key === division) || {}).accent || '#22c55e';
    sections.bidItems = {
      color: accent,
      cols:  ['Item', 'Qty', 'Status'],
      rows:  bidItems.slice(0, 8).map(b => [
        b.description || b.cost_code || '—',
        b.quantity > 0
          ? `${Number(b.quantity).toLocaleString('en-US')} ${b.unit || ''}`.trim()
          : '—',
        b.status || 'Active',
      ]),
    };
  }

  if (Array.isArray(weeks) && weeks.length) {
    const sorted       = [...weeks].sort((a, b) => String(a.week_start).localeCompare(String(b.week_start)));
    const totalLoads   = sorted.reduce((s, w) => s + (Number(w.loads)   || 0), 0);
    const totalHours   = sorted.reduce((s, w) => s + (Number(w.hours)   || 0), 0);
    const totalDollars = sorted.reduce((s, w) => s + (Number(w.dollars) || 0), 0);
    const fmtWeek = iso =>
      new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    sections.trucking = {
      color: '#ef4444',
      cols:  ['Week', 'Loads', 'Hours', '$'],
      rows: [
        ...sorted.map(w => [
          fmtWeek(w.week_start),
          Math.round(Number(w.loads) || 0).toLocaleString('en-US'),
          Math.round(Number(w.hours) || 0).toLocaleString('en-US'),
          fmtCurrency(w.dollars),
        ]),
        [
          'Total to date',
          Math.round(totalLoads).toLocaleString('en-US'),
          Math.round(totalHours).toLocaleString('en-US'),
          fmtCurrency(totalDollars),
        ],
      ],
    };
  }

  const status = projStatus(p) || 'Active';
  const statusColor =
    status === 'On Hold' ? 'mute' :
    status === 'At Risk' ? 'amber' :
    'green';

  const contract = projContract(p);
  return {
    name:        projName(p),
    jobNumber:   projJob(p) || '—',
    division,
    status,
    statusColor,
    start:       fmtDate(start),
    target:      fmtDate(end),
    contract:    contract > 0 ? fmtCurrency(contract) : '—',
    bookedCost:  booked != null ? fmtCurrency(booked) : '—',
    pctComplete,
    sections,
  };
}

async function buildIntercompanyTile(sql, companyCode) {
  const unbilledTrucking = await safeRun('ic.unbilled_trucking', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND source = 'trucking'
         AND (qb_invoice IS NULL OR TRIM(qb_invoice) = '')
    `;
    return rows[0]?.v ?? 0;
  });
  const unbilledDust = await safeRun('ic.unbilled_dust', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         -- Dust Control bills from several tabs, each under its own source
         -- tag. Listing them by hand here is what twice left this figure short
         -- of the tile's own AR and top-customer numbers, which filter on
         -- nothing and so count every one. The list now lives in one place.
         AND source = ANY(${DUST_IC_SOURCES})
         AND (qb_invoice IS NULL OR TRIM(qb_invoice) = '')
    `;
    return rows[0]?.v ?? 0;
  });
  const ar30 = await safeRun('ic.ar_30', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND invoice_sent_date IS NOT NULL
         AND invoice_sent_date < (CURRENT_DATE - INTERVAL '30 days')
         AND date_paid IS NULL
         AND (invoice_status IS NULL OR LOWER(invoice_status) NOT LIKE 'paid%')
    `;
    return rows[0]?.v ?? 0;
  });
  const top = await safeRun('ic.top_customer', async () => {
    const rows = await sql`
      SELECT company_name, COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND date_paid IS NULL
         AND company_name IS NOT NULL
         AND TRIM(company_name) <> ''
       GROUP BY company_name
       ORDER BY v DESC
       LIMIT 1
    `;
    return rows[0] || null;
  });

  return {
    key: 'intercompany', name: 'Intercompany Billing', accent: '#a78bfa',
    status: ar30 > 0 ? 'Aging' : 'On Track',
    statusKind: ar30 > 0 ? 'amber' : 'green',
    kpis: [
      { label: 'Unbilled · Trucking', value: unbilledTrucking != null ? fmtCurrency(unbilledTrucking) : '—' },
      { label: 'Unbilled · Dust',     value: unbilledDust     != null ? fmtCurrency(unbilledDust)     : '—' },
      { label: 'AR 30+ Days',         value: ar30             != null ? fmtCurrency(ar30)             : '—' },
      top && top.company_name ? {
        label: 'Top Customer',
        value: String(top.company_name),
        sub:   `${fmtCurrency(top.v)} outstanding`,
        small: true,
      } : { label: 'Top Customer', value: '—' },
    ],
  };
}

// Rubber inventory summary — one row per rubber type with produced / used /
// in_stock / lbs_total. Mirrors the home page's per-type aggregation so the
// executive PDF surfaces the same numbers users see on the tracker.
async function buildRubberInventory(sql, companyCode) {
  const entries = await readInventoryEntries(sql, companyCode);
  const byType = new Map();
  for (const e of entries) {
    const rt = String(e.rubber_type || '').trim() || '(unspecified)';
    if (!byType.has(rt)) byType.set(rt, { produced: 0, used: 0, lbs_total: 0 });
    const row  = byType.get(rt);
    const bags = Number(e.bags_produced) || 0;
    if (e.project_id) {
      row.used += bags;
    } else {
      row.produced += bags;
      row.lbs_total += Number(e.total_poundage) || 0;
    }
  }
  return [...byType.entries()]
    // Push TOTES (non-rubber containers) to the end so the rubber types
    // line up next to each other on the home page / exec PDF.
    .sort(([a], [b]) => Number(/tote/i.test(a)) - Number(/tote/i.test(b)))
    .map(([rubber_type, v]) => ({
      rubber_type,
      produced:  v.produced,
      used:      v.used,
      in_stock:  v.produced - v.used,
      lbs_total: v.lbs_total,
    }));
}

// ── Quarry tile ──────────────────────────────────────────────────────
// Quarry data lives entirely in JSONB blobs (no normalized tables yet):
//   fct_quarry_sales    → [{ date, locationName, productName, tons, pricePerTon, payment }]
//   fct_quarry_daily    → [{ date, locationName, hours, rate, fuelGallons, ppg }]
//   fct_quarry_crushing → [{ date, locationName, hourlyRate, hours, fuelGallons, fuelCost, ... }]
// We compute weekly PROFIT (sales revenue − daily labor/fuel costs − crushing
// payroll/fuel costs, all scoped to the current Sun-anchored week) and
// monthly tons sold, plus the top product and active pit count.
async function buildQuarryTile(sql, companyCode, weekStart, weekEnd) {
  const [salesBlob, dailyBlob, crushBlob, fixedBlob, royaltyBlob, listsBlob] = await Promise.all([
    safeRun('quarry.sales_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_sales`}`;
      return r[0]?.value;
    }),
    safeRun('quarry.daily_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_daily`}`;
      return r[0]?.value;
    }),
    safeRun('quarry.crush_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_crushing`}`;
      return r[0]?.value;
    }),
    safeRun('quarry.fixed_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_monthly_fixed`}`;
      return r[0]?.value;
    }),
    safeRun('quarry.royalty_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_royalty`}`;
      return r[0]?.value;
    }),
    safeRun('quarry.lists_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_lists`}`;
      return r[0]?.value;
    }),
  ]);
  const sales = Array.isArray(salesBlob) ? salesBlob : [];
  const daily = Array.isArray(dailyBlob) ? dailyBlob : [];
  const crush = Array.isArray(crushBlob) ? crushBlob : [];
  const fixed = (fixedBlob && typeof fixedBlob === 'object' && !Array.isArray(fixedBlob)) ? fixedBlob : {};
  // Royalty owners per pit: { pit: [ { name, rate, floor } ] }. Each owner is
  // paid the greater of (rate% of the sale) or ($floor per ton), stacked, on
  // royalty-flagged products only. Legacy blobs stored a bare number per pit.
  const royalty = (royaltyBlob && typeof royaltyBlob === 'object' && !Array.isArray(royaltyBlob)) ? royaltyBlob : {};
  const royaltyOwnersFor = loc => {
    const v = royalty[loc];
    if (Array.isArray(v)) return v;
    const n = Number(v);
    return (Number.isFinite(n) && n > 0) ? [{ rate: n, floor: 0 }] : [];
  };
  // Royalty $ owed on one sale, summed across the pit's owners.
  const royaltyForSale = (loc, tons, price) => {
    const t = Number(tons); if (!Number.isFinite(t) || t <= 0) return 0;
    const p = Number(price);
    // No price → no sale value → no royalty (don't let the floor charge
    // against $0 revenue on an incomplete row).
    if (!Number.isFinite(p) || p <= 0) return 0;
    let total = 0;
    for (const o of royaltyOwnersFor(loc)) {
      const rate = Number(o && o.rate) || 0;
      const floor = Number(o && o.floor) || 0;
      total += Math.max(p * rate / 100, floor) * t;
    }
    return total;
  };
  // Royalties apply only to material flagged as royalty-bearing in Manage
  // Lists → Product (rock/aggregate), not every product — mirror the Quarry
  // page so this tile isn't inflated by non-royalty sales (fill, millings…).
  const lists = (listsBlob && typeof listsBlob === 'object' && !Array.isArray(listsBlob)) ? listsBlob : {};
  const royaltyProductIds = new Set(), royaltyProductNames = new Set();
  (Array.isArray(lists.product) ? lists.product : []).forEach(p => {
    if (!p || !p.royalty) return;
    if (p.id != null && p.id !== '') royaltyProductIds.add(String(p.id));
    const nm = String(p.name || '').trim().toLowerCase();
    if (nm) royaltyProductNames.add(nm);
  });
  const rowHasRoyalty = r => {
    if (r.productId != null && r.productId !== '' && royaltyProductIds.has(String(r.productId))) return true;
    const nm = String(r.productName || '').trim().toLowerCase();
    return nm !== '' && royaltyProductNames.has(nm);
  };

  const now           = new Date();
  const monthStartIso = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const yearPrefix    = String(now.getFullYear());

  const num = v => {
    if (v == null || v === '') return 0;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
  };

  // Week scoped: revenue from sales, costs from daily + crushing.
  // Profit formula mirrors quarry.html's per-row calcs:
  //   daily row    cost = hours*rate + fuelGallons*ppg
  //   crushing row cost = hourlyRate*hours + fuelGallons*fuelCost
  // Year scoped (current year): blended price/cost per ton + monthly
  // throughput feed the break-even indicator further down.
  let revenueWk = 0, costWk = 0, tonsMo = 0, revenueMo = 0, varCostMo = 0, royaltyCostMo = 0;
  let revenueYr = 0, tonsSoldYr = 0, varCostYr = 0, tonsCrushedYr = 0, royaltyCostYr = 0;
  const productTons = new Map();
  const activePits  = new Set();
  // Per-pit set of 'YYYY-MM' months with activity this year (sales ∪ crush),
  // used to scope each pit's monthly-fixed average the same way the Quarry
  // page's By-Location table does, so the tile matches "All Pits".
  const activeMonthsByPit = new Map();
  const addActiveMonth = (pit, date) => {
    const name = String(pit || '').trim();
    if (!name || date.slice(0, 4) !== yearPrefix) return;
    let set = activeMonthsByPit.get(name);
    if (!set) { set = new Set(); activeMonthsByPit.set(name, set); }
    set.add(date.slice(0, 7));
  };
  for (const r of sales) {
    if (!r || typeof r !== 'object') continue;
    const date = typeof r.date === 'string' ? r.date : '';
    if (!date) continue;
    const tons  = num(r.tons);
    const price = num(r.pricePerTon);
    if (date >= weekStart && date < weekEnd) revenueWk += tons * price;
    // Royalty stacks each owner (% of sale or $/ton floor), rock only.
    const rowRoyalty = rowHasRoyalty(r) ? royaltyForSale(r.locationName, tons, price) : 0;
    if (date >= monthStartIso) {
      tonsMo += tons;
      revenueMo += tons * price;
      royaltyCostMo += rowRoyalty;
      const name = String(r.productName || '').trim();
      if (name) productTons.set(name, (productTons.get(name) || 0) + tons);
      const pit = String(r.locationName || '').trim();
      if (pit) activePits.add(pit);
    }
    if (date.slice(0, 4) === yearPrefix) {
      revenueYr += tons * price;
      tonsSoldYr += tons;
      royaltyCostYr += rowRoyalty;
      addActiveMonth(r.locationName, date);
    }
  }
  for (const r of daily) {
    if (!r || typeof r !== 'object') continue;
    const date = typeof r.date === 'string' ? r.date : '';
    if (!date) continue;
    // Daily labor feeds the weekly profit only — variable cost/ton and
    // break-even use crushing cost only.
    const cost = num(r.hours) * num(r.rate) + num(r.fuelGallons) * num(r.ppg);
    if (date >= weekStart && date < weekEnd) costWk += cost;
  }
  for (const r of crush) {
    if (!r || typeof r !== 'object') continue;
    const date = typeof r.date === 'string' ? r.date : '';
    if (!date) continue;
    const cost = num(r.hourlyRate) * num(r.hours) + num(r.fuelGallons) * num(r.fuelCost);
    if (date >= weekStart && date < weekEnd) costWk += cost;
    if (date >= monthStartIso) varCostMo += cost;
    if (date.slice(0, 4) === yearPrefix) {
      varCostYr += cost;
      tonsCrushedYr += num(r.loadsToCrusher) * num(r.tonsPerLoad);
      addActiveMonth(r.locationName, date);
    }
  }
  const profitWk = revenueWk - costWk;

  let topProduct = null, topProductTons = 0;
  for (const [name, t] of productTons) {
    if (t > topProductTons) { topProduct = name; topProductTons = t; }
  }

  // ── Break-even (current month, cost-coverage) ──
  // Mirrors the Quarry page: the sales needed to cover THIS month's actual
  // labor + fuel plus fixed overhead. Variable cost/ton and contribution stay
  // year-blended so the per-ton economics — and the cost ≥ price guard — read
  // steady. Monthly fixed mirrors the By-Location "All Pits" figure: the
  // SUM of each pit's monthly fixed (a true company total), where each pit's
  // figure is scoped to the months it had activity this year (matching what
  // the Quarry page shows). fct_quarry_monthly_fixed is nested
  // { scope: { 'YYYY-MM': amount } }; pit scopes exclude 'all' and no-location.
  let monthlyFixedTotal = 0;
  {
    const pitAvgs = Object.keys(fixed)
      .filter(s => s && s !== 'all' && s !== '— No location —')
      .map(s => {
        const months = (fixed[s] && typeof fixed[s] === 'object') ? fixed[s] : {};
        // Scope to the pit's active months this year (the months the Quarry
        // page actually shows), so stale entries for other months/years don't
        // drag the average down. Fall back to the all-time average only when
        // the pit had no activity this year.
        const active = activeMonthsByPit.get(s);
        let vals;
        if (active && active.size) {
          vals = [];
          active.forEach(mk => { const v = num(months[mk]); if (v > 0) vals.push(v); });
        } else {
          vals = Object.keys(months).map(k => num(months[k])).filter(v => v > 0);
        }
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      })
      .filter(v => v > 0);
    // Sum the per-pit figures: the company owes every pit's fixed cost.
    monthlyFixedTotal = pitAvgs.reduce((a, b) => a + b, 0);
  }
  const tonsBasisYr     = tonsCrushedYr > 0 ? tonsCrushedYr : tonsSoldYr;
  const avgPrice        = tonsSoldYr  > 0 ? revenueYr / tonsSoldYr : null;
  const varCostPerTon   = tonsBasisYr > 0 ? varCostYr / tonsBasisYr : null;  // crushing only
  const royaltyPerTonYr = tonsSoldYr  > 0 ? royaltyCostYr / tonsSoldYr : 0;   // royalty is % of sales
  const contribution    = (avgPrice != null && varCostPerTon != null) ? avgPrice - royaltyPerTonYr - varCostPerTon : null;

  // Current month: blended price falls back to the year's when this month
  // hasn't booked sales yet. Full monthly fixed is applied (it's owed
  // regardless). Royalty (% of sales) comes off the price; break-even covers
  // crushing + fixed at the net-of-royalty price.
  const priceMo         = tonsMo > 0 ? revenueMo / tonsMo : avgPrice;
  const effRateMo       = revenueMo > 0 ? royaltyCostMo / revenueMo : 0;
  const netPriceMo      = priceMo != null ? priceMo * (1 - effRateMo) : null;
  const totalCostMo     = varCostMo + monthlyFixedTotal;
  const breakEvenTonsMo = (netPriceMo != null && netPriceMo > 0) ? totalCostMo / netPriceMo : null;
  const tonsShortMo     = breakEvenTonsMo != null ? Math.max(0, breakEvenTonsMo - tonsMo) : null;

  // Status pill reflects this month's break-even when we can judge it,
  // otherwise falls back to the prior On Track / No Data behavior.
  let status, statusKind;
  if (!sales.length) {
    status = 'No Data'; statusKind = 'mute';
  } else if (contribution != null && contribution <= 0) {
    status = 'No Break-Even'; statusKind = 'red';
  } else if (monthlyFixedTotal > 0 && breakEvenTonsMo != null && breakEvenTonsMo > 0) {
    if (tonsMo >= breakEvenTonsMo) { status = 'Above B/E'; statusKind = 'green'; }
    else { status = 'Below B/E'; statusKind = 'red'; }
  } else {
    status = 'On Track'; statusKind = 'green';
  }

  const round = n => Math.round(n).toLocaleString('en-US');

  // Break-even KPI = this month's cost-coverage target (tons), with how
  // many more tons it takes to cover the month.
  let beKpi;
  if (contribution != null && contribution <= 0) {
    beKpi = { label: 'Break-Even · Mo', value: 'None', small: true, sub: 'cost ≥ price/ton' };
  } else if (monthlyFixedTotal > 0 && breakEvenTonsMo != null) {
    beKpi = { label: 'Break-Even · Mo', value: `${round(breakEvenTonsMo)} t`,
              sub: tonsShortMo > 0 ? `${round(tonsShortMo)} t to go` : 'covered ✓' };
  } else if (monthlyFixedTotal <= 0) {
    beKpi = { label: 'Break-Even · Mo', value: 'Set costs', small: true, sub: 'on Quarry page' };
  } else {
    beKpi = { label: 'Break-Even · Mo', value: '—', sub: 'needs sales data' };
  }
  const marginKpi = {
    label: 'Margin / Ton',
    value: contribution != null ? fmtCurrency(contribution) : '—',
    sub: (avgPrice != null && varCostPerTon != null)
      ? `price ${fmtCurrency(avgPrice)} · cost ${fmtCurrency(varCostPerTon)}` : undefined,
  };

  return {
    key: 'quarry', name: 'Quarry', accent: '#f97316',
    status, statusKind,
    kpis: [
      // Show the profit value whenever the week saw any activity (sales OR
      // costs). A pit that ran daily/crushing hours without recording sales
      // is a real loss week worth surfacing rather than masking with '—'.
      { label: 'Profit · Wk',  value: (revenueWk > 0 || costWk > 0) ? fmtCurrency(profitWk) : '—' },
      { label: 'Tons · Mo',    value: tonsMo > 0 ? round(tonsMo) : '—' },
      topProduct
        ? { label: 'Top Product', value: topProduct, sub: `${round(topProductTons)} tons` }
        : { label: 'Top Product', value: '—' },
      { label: 'Active Pits',  value: activePits.size > 0 ? String(activePits.size) : '—' },
      beKpi,
      marginKpi,
    ].map(k => {
      if (k.sub === undefined || k.sub === null) delete k.sub;
      if (k.small === undefined) delete k.small;
      return k;
    }),
  };
}

// ── Payroll pay-period summary ───────────────────────────────────────
// Aggregates submitted + approved timesheet_entries into a per-employee
// total-hours roll-up for the current biweekly pay period. The period
// is anchored on the same Sun May 10, 2026 end-date the payroll page
// uses (payroll.html ~line 1259), so cycles roll forward by 14 days and
// always match the "Current Biweekly" button on the payroll review screen.
function biweeklyPayPeriod(today) {
  const DAY_MS = 86400 * 1000;
  // Anchor: Sun May 10, 2026 — the last day of its cycle. Stored as a
  // UTC midnight so day math is safe across DST boundaries.
  const anchor = new Date(Date.UTC(2026, 4, 10));
  const t = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const daysSinceAnchor = Math.round((t - anchor) / DAY_MS);
  const n = Math.ceil(daysSinceAnchor / 14);
  const end = new Date(anchor); end.setUTCDate(anchor.getUTCDate() + 14 * n);
  const start = new Date(end);  start.setUTCDate(end.getUTCDate() - 13);
  return {
    startIso: start.toISOString().slice(0, 10),
    endIso:   end.toISOString().slice(0, 10),
  };
}

async function buildPayrollSummary(sql, companyCode) {
  const { startIso, endIso } = biweeklyPayPeriod(new Date());

  const rows = await safeRun('payroll.summary', async () => {
    return await sql`
      SELECT
        user_id,
        username,
        COUNT(*) FILTER (WHERE entry_type = 'daily')::int                                     AS daily_entries,
        COUNT(DISTINCT work_date) FILTER (WHERE entry_type = 'daily')::int                    AS days_worked,
        COUNT(*) FILTER (WHERE entry_type = 'time_off')::int                                  AS time_off_entries,
        COALESCE(SUM(computed_hours), 0)::float                                               AS work_hours,
        COALESCE(SUM(travel_hours),   0)::float                                               AS travel_hours,
        COALESCE(SUM(COALESCE(computed_hours, 0) + COALESCE(travel_hours, 0)), 0)::float      AS total_hours,
        COUNT(*) FILTER (WHERE status = 'submitted')::int                                     AS submitted_count,
        COUNT(*) FILTER (WHERE status = 'approved')::int                                      AS approved_count
      FROM timesheet_entries
      WHERE company_code = ${companyCode}
        AND status IN ('submitted', 'approved')
        AND work_date >= ${startIso}::date
        AND work_date <= ${endIso}::date
      GROUP BY user_id, username
      ORDER BY username ASC
    `;
  });

  const employees = (rows || []).map(r => ({
    userId:          r.user_id,
    username:        r.username || '—',
    daysWorked:      r.days_worked     || 0,
    workHours:       Number(r.work_hours)   || 0,
    travelHours:     Number(r.travel_hours) || 0,
    totalHours:      Number(r.total_hours)  || 0,
    timeOffEntries:  r.time_off_entries || 0,
    submittedCount:  r.submitted_count  || 0,
    approvedCount:   r.approved_count   || 0,
  }));

  const totals = employees.reduce((acc, e) => ({
    employees:    acc.employees + 1,
    workHours:    acc.workHours + e.workHours,
    travelHours:  acc.travelHours + e.travelHours,
    totalHours:   acc.totalHours + e.totalHours,
    daysWorked:   acc.daysWorked + e.daysWorked,
  }), { employees: 0, workHours: 0, travelHours: 0, totalHours: 0, daysWorked: 0 });

  return {
    periodStart: startIso,
    periodEnd:   endIso,
    employees,
    totals,
  };
}

// Mock fallback — used only if the entire hero build throws.
function mockHero() {
  return [
    { label: 'Active Projects',       value: '—', delta: '—', deltaDir: 'flat' },
    { label: 'Revenue · This Week',   value: '—', delta: '—', deltaDir: 'flat' },
    { label: 'AR · 30+ Days',         value: '—', delta: '—', deltaDir: 'flat' },
    { label: 'Unbilled Intercompany', value: '—', delta: '—', deltaDir: 'flat' },
  ];
}

function mockReport() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),

    snapshot: {
      hero: mockHero(),

      divisions: [
        {
          key: 'trucking', name: 'Trucking', accent: '#ef4444',
          status: '—', statusKind: 'mute',
          kpis: [
            { label: 'Active Hauls',  value: '—' },
            { label: 'Loads · Wk',    value: '—' },
            { label: 'Invoiced · Wk', value: '—' },
            { label: 'Unbilled',      value: '—' },
          ],
        },
        {
          key: 'dust', name: 'Dust Control', accent: '#fbbf24',
          status: '—', statusKind: 'mute',
          kpis: [
            { label: 'Revenue · Wk',  value: '—' },
            { label: 'Revenue · Mo',  value: '—' },
            { label: 'Gallons · Wk',  value: '—' },
            { label: 'Active Routes', value: '—' },
          ],
        },
        {
          key: 'quarry', name: 'Quarry', accent: '#f97316',
          status: '—', statusKind: 'mute',
          kpis: [
            { label: 'Revenue · Wk', value: '—' },
            { label: 'Tons · Mo',    value: '—' },
            { label: 'Top Product',  value: '—' },
            { label: 'Active Pits',  value: '—' },
          ],
        },
        {
          key: 'intercompany', name: 'Intercompany Billing', accent: '#a78bfa',
          status: '—', statusKind: 'mute',
          kpis: [
            { label: 'Unbilled · Trucking', value: '—' },
            { label: 'Unbilled · Dust',     value: '—' },
            { label: 'AR 30+ Days',         value: '—' },
            { label: 'Top Customer',        value: '—' },
          ],
        },
      ],
    },

    // One entry per job-running division, each carrying that division's
    // metric strip + project table. Empty until the live build fills them in.
    portfolios: PROJECT_DIVISIONS.map(d => ({
      key: d.key, name: d.name, accent: d.accent,
      status: '—', statusKind: 'mute',
      metrics: [], rows: [],
      shown: 0, pinned: 0, recent: 0, hidden: 0, total: 0,
    })),

    details: [],

    payroll: {
      periodStart: null,
      periodEnd:   null,
      employees:   [],
      totals:      { employees: 0, workHours: 0, travelHours: 0, totalHours: 0, daysWorked: 0 },
    },
  };
}

/* The intercompany Financials report reuses this module's cost logic rather
   than growing a second copy of it. Attached to the handler export so the
   endpoint keeps its default shape. */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  if (!hasDivisionAccess(payload, 'executive')) {
    return res.status(403).json({ error: 'You do not have access to the Executive Division' });
  }

  const report = mockReport();
  const debug  = req.query?.debug === '1' || req.query?.debug === 'true';
  const diag   = debug ? [] : null;

  // Live KPIs scoped to the caller's primary companyCode. Each builder
  // wraps its own queries in safeRun() so a single failure degrades to
  // '—' rather than blanking the report. If the entire build throws —
  // DB unreachable, missing config — we keep the mock placeholders.
  if (payload.companyCode && process.env.DATABASE_URL) {
    const sql       = neon(process.env.DATABASE_URL);
    const company   = payload.companyCode;
    const weekStart = startOfWeekISO(new Date());
    const weekEnd   = addDaysISO(weekStart, 7);

    try {
      report.snapshot.hero = await buildHero(sql, company);
    } catch (err) {
      console.error('[executive/report] hero build failed:', err.message);
    }

    // The non-project division tiles are wired live. A failed builder leaves
    // the mock '—' placeholder for that tile (rather than overwriting it with
    // null) so the grid layout stays intact. Turf / Paving / Kiewit have no
    // tile: they get a full portfolio section each, further down.
    const liveTiles = await Promise.all([
      buildTruckingTile(sql, company, weekStart, weekEnd).catch(e => {
        console.error('[executive/report] trucking tile failed:', e.message); return null;
      }),
      buildDustTile(sql, company, weekStart, weekEnd).catch(e => {
        console.error('[executive/report] dust tile failed:', e.message); return null;
      }),
      buildQuarryTile(sql, company, weekStart, weekEnd).catch(e => {
        console.error('[executive/report] quarry tile failed:', e.message); return null;
      }),
      buildIntercompanyTile(sql, company).catch(e => {
        console.error('[executive/report] intercompany tile failed:', e.message); return null;
      }),
    ]);
    const [truckingLive, dustLive, quarryLive, icLive] = liveTiles;

    report.snapshot.divisions = report.snapshot.divisions.map(tile => {
      if (tile.key === 'trucking'     && truckingLive) return truckingLive;
      if (tile.key === 'dust'         && dustLive)     return dustLive;
      if (tile.key === 'quarry'       && quarryLive)   return quarryLive;
      if (tile.key === 'intercompany' && icLive)       return icLive;
      return tile;
    });

    // Per-division project portfolios (page 2+) and per-project detail. The
    // builders return null on error or when there are no active projects —
    // both cases leave the mock's empty placeholders, which now contain no
    // fake project entries.
    const [livePortfolios, liveDetails, liveInventory, livePayroll] = await Promise.all([
      buildDivisionPortfolios(sql, company).catch(err => {
        console.error('[executive/report] portfolios build failed:', err.message); return null;
      }),
      buildProjectDetails(sql, company).catch(err => {
        console.error('[executive/report] details build failed:', err.message); return null;
      }),
      buildRubberInventory(sql, company).catch(err => {
        console.error('[executive/report] inventory build failed:', err.message); return null;
      }),
      buildPayrollSummary(sql, company).catch(err => {
        console.error('[executive/report] payroll summary failed:', err.message); return null;
      }),
    ]);
    if (Array.isArray(livePortfolios) && livePortfolios.length) {
      report.portfolios = livePortfolios;
    }
    if (Array.isArray(liveDetails)) {
      report.details = liveDetails;
    }
    if (Array.isArray(liveInventory)) {
      report.inventory = liveInventory;
    }
    if (livePayroll && Array.isArray(livePayroll.employees)) {
      report.payroll = livePayroll;
    }

    // Diagnostics — only when ?debug=1. Helps identify missing
    // columns, status mismatches, empty tables, etc. without server
    // logs. Returned as report._diag.
    if (debug) {
      report._diag = await runDiagnostics(sql, company);
    }
  }

  report.generatedAt = new Date().toISOString();
  return res.json(report);
};

module.exports.readTurfProjects   = readTurfProjects;
module.exports.readPavingProjects = readPavingProjects;
module.exports.readKiewitProjects = readKiewitProjects;
module.exports.buildFinancials    = buildFinancials;
module.exports.projName           = projName;
module.exports.projJob            = projJob;
module.exports.projStatus         = projStatus;
module.exports.projContract       = projContract;
module.exports.projIsComplete     = projIsComplete;
