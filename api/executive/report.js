'use strict';

// GET /api/executive/report
//
// Cross-division roll-up for the Executive Division dashboard.
// Access: platform admins, or any user whose divisionRoles.executive
// is not 'no_access' (gated by hasDivisionAccess below).
//
// The report is one section per division, each built from live SQL
// scoped to the caller's company_code. Every section builds
// independently and falls back to its mock shape on failure, so a
// single bad query can't blank the whole report.

const { neon }                          = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const {
  quarryMetrics,
  INV_RATE_WINDOW_DAYS: QUARRY_RATE_WINDOW_DAYS,
} = require('../lib/quarry-metrics');
const {
  dustMetrics,
  INVOICE_ERA_START_YEAR,
  OVERDUE_AFTER_DAYS: DUST_OVERDUE_DAYS,
} = require('../lib/dust-metrics');
const { payrollMetrics } = require('../lib/payroll-metrics');
const { truckingMetrics } = require('../lib/trucking-metrics');
const { icMetrics } = require('../lib/ic-metrics');
const {
  TRUCK_DIVISION_BLOB,
  entryIdFromTruckRowId,
  findStaleTruckRows,
} = require('../lib/truck-injected');
// The per-leg half of the same staleness check: which dust hauls the dust
// office bills off its own grid, and so posts nothing to Truck Tracking.
const { dustBilledLegs } = require('../lib/dust-injected');

const DUST_INVOICE_ERA_START = `${INVOICE_ERA_START_YEAR}-01-01`;

// "Active" mirrors tracker.html's isDone() inverse: anything whose
// status is NOT 'complete' or 'closed' (case-insensitive) counts as
// active — including null/empty, 'Bidding', 'Awarded', 'In Progress',
// 'Substantially Complete', 'On Hold'. The home page status dropdown
// (tracker.html line 7050) is the source of truth for valid values.
// SQL fragments inline `NOT IN ('complete', 'closed')` after a
// LOWER(COALESCE(status, '')) so binding never relies on Postgres
// array support.

// ── Date / formatting helpers ────────────────────────────────────────────
// Local calendar date, not UTC: the quarry stockpile balances "through today"
// and toISOString() would roll that to tomorrow for anyone west of UTC in the
// evening, quietly pulling a day of crushing into the pile.
function localDateIso(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December'];
// 'YYYY-MM' → 'August 2026'
function monthName(monthKey) {
  const m = String(monthKey || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(monthKey || '');
  const idx = Number(m[2]) - 1;
  return MONTH_NAMES[idx] ? `${MONTH_NAMES[idx]} ${m[1]}` : String(monthKey);
}

function fmtCurrency(n) {
  const v = Math.round(Number(n) || 0);
  // Prefix the minus before the $ ("−$1,234" not "$-1,234") so loss values
  // read cleanly on KPI tiles. Uses U+2212 rather than a hyphen.
  if (v < 0) return '−$' + Math.abs(v).toLocaleString('en-US');
  return '$' + v.toLocaleString('en-US');
}

// Money to the cent, matching quarry.html's formatMoney and dust.html's money.
// Per-ton economics need the cents: rounding $19.20/ton to $19 and $4.35 to $4
// turns a margin the pit lives on into a rounding artefact.
function fmtCurrency2(n) {
  const v = Number(n) || 0;
  const body = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return (v < 0 ? '−$' : '$') + body;
}

// Tons, matching quarry.html's formatTons: up to two decimals, none forced, so
// a round 230 tons reads as "230".
function fmtTons(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
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
//   range:    optional { start, end } 'YYYY-MM-DD' window. Adds a windowed
//             spend figure alongside the lifetime one; it does NOT narrow the
//             lifetime figures, because a bid budget and a projection describe
//             a whole job and mean nothing clipped to a month.
async function buildFinancials(sql, companyCode, division, projects, range) {
  const ids = projects.map(p => p.id).filter(Boolean);
  const rStart = (range && range.start) || null;
  const rEnd   = (range && range.end)   || null;
  // Daily cost groups (cost_code/sub_code) per project. The per-row cost mirrors
  // tracker.html's dailyRowCost/calcDaily EXACTLY so the Executive reconciles
  // with the home page: total_cost_override (if non-zero) wins, else
  // labor*rate + (equip_total_override || equip_hours*equip_unit_cost) + material.
  // NULLIF(...,0) reproduces calcDaily's `override || computed` short-circuit;
  // the previous formula ignored equip_total_override and understated actuals.
  //
  // The formula is written once, in the subquery, and aggregated twice — once
  // over everything and once over the window. Writing it out a second time for
  // the windowed sum is exactly how the per-division copies of this logic
  // drifted apart, so the two sums are held to one expression by construction.
  const groupsByProject = new Map();
  if (ids.length) {
    // Two CTEs rather than one nested SELECT, so the scoping predicates keep
    // their place as the first three bind parameters. Anything that reads this
    // query positionally — scripts/test-executive-report.js dispatches its fake
    // rows off values[1]/values[2] — breaks silently if company/division/ids
    // stop coming first, and a windowing change has no business moving them.
    const rows = await sql`
      WITH src AS (
        SELECT
          project_id,
          cost_code,
          COALESCE(sub_code, '') AS sub_code,
          COALESCE(NULLIF(total_cost_override, 0),
            COALESCE(labor_hours, 0) * COALESCE(rate, 0)
            + COALESCE(NULLIF(equip_total_override, 0),
                       COALESCE(equip_hours, 0) * COALESCE(equip_unit_cost, 0))
            + COALESCE(material_cost, 0)
          )                      AS row_cost,
          COALESCE(quantity, 0)  AS qty,
          date
        FROM daily_tracking
        WHERE company_code = ${companyCode}
          AND division     = ${division}
          AND project_id   = ANY(${ids})
      ), flagged AS (
        SELECT src.*,
               (${rStart}::date IS NULL OR date >= ${rStart}::date)
           AND (${rEnd}::date   IS NULL OR date <= ${rEnd}::date) AS in_range
        FROM src
      )
      SELECT
        project_id,
        cost_code,
        sub_code,
        SUM(row_cost)::float                                        AS actual,
        COALESCE(SUM(row_cost) FILTER (WHERE in_range), 0)::float    AS range_actual,
        (COUNT(*) FILTER (WHERE in_range))::int                      AS range_rows,
        SUM(qty)::float                                              AS rqty
      FROM flagged
      GROUP BY project_id, cost_code, sub_code
    `;
    for (const r of rows) {
      const list = groupsByProject.get(r.project_id) || [];
      list.push({
        cost_code:   r.cost_code || '',
        sub_code:    r.sub_code  || '',
        actual:      Number(r.actual)       || 0,
        rangeActual: Number(r.range_actual) || 0,
        rangeRows:   Number(r.range_rows)   || 0,
        rqty:        Number(r.rqty)         || 0,
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
    // Spend booked inside the window, and how many daily rows carried it — the
    // count is what tells "no work in this period" apart from "work that cost
    // nothing".
    const rangeActual = groups.reduce((s, g) => s + (g.rangeActual || 0), 0);
    const rangeRows   = groups.reduce((s, g) => s + (g.rangeRows   || 0), 0);

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
    perProject.set(p.id, { contract: projContract(p), bid, actual, projected, offBid, offBidCodes,
                           rangeActual, rangeRows });
  }
  return { contract_total, bid_total, actual_total, projected_total, perProject };
}

// ── Trucking ─────────────────────────────────────────────────────────
// The Trucking page reads its entries from the fct_truck_division blob rather
// than the normalized truck_division_entries table, because a save writes the
// blob synchronously and the table is synced fire-and-forget behind it. Reading
// the table here would show the report a version of the day that is seconds —
// occasionally minutes — behind what the division is looking at, so this reads
// the blob too, with the same scoped-then-legacy preference /api/truck-division
// uses, and falls back to the table only when the blob has nothing.
async function readTruckDivisionEntries(sql, companyCode) {
  const [scoped, legacy] = await Promise.all([
    safeRun('trucking.blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:${TRUCK_DIVISION_BLOB}`}`;
      return r[0]?.value;
    }),
    safeRun('trucking.blob_legacy', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${TRUCK_DIVISION_BLOB}`;
      return r[0]?.value;
    }),
  ]);

  const pick = v => (Array.isArray(v) ? v : null);
  const blobEntries = (pick(scoped) && pick(scoped).length ? pick(scoped) : pick(legacy)) || [];
  if (blobEntries.length) {
    // Injected rows whose timesheet entry was un-approved or deleted are hidden
    // on the page. Hide them here too — but only hide them. The page's loader
    // sweeps them from storage; a report has no business deleting anything, so
    // this uses the read-only half of that check.
    const stale = await safeRun('trucking.stale_injected', async () => {
      const entryIds = [...new Set(
        blobEntries.map(r => (r && typeof r === 'object') ? entryIdFromTruckRowId(r.id) : null)
                   .filter(id => id != null)
      )];
      if (!entryIds.length) return [];
      const rows = await sql`
        SELECT id, status, entry_type, division, job_id
          FROM timesheet_entries
         WHERE company_code = ${companyCode} AND id = ANY(${entryIds}::bigint[])
      `;
      const entriesById = new Map(rows.map(r => [Number(r.id), r]));
      // Which of these hauls the dust office bills off its own tracking grid.
      // Asked here for the same reason the tab asks it: a dust haul billed off
      // Dust Control Tracking posts no Truck Tracking row any more, and the
      // rows posted before that was true are retired on read. Without this the
      // report goes on counting them as trucking revenue until somebody opens
      // the Trucking tab — the same hauls the dust roll-up is already billing,
      // counted twice, with the total moving when a tab is loaded.
      const dustEntryIds = [...entriesById.values()]
        .filter(e => e && e.division === 'dust')
        .map(e => Number(e.id));
      const ubLegs = dustEntryIds.length
        ? await dustBilledLegs(sql, companyCode, dustEntryIds)
        : null;
      return findStaleTruckRows(blobEntries, entriesById, ubLegs);
    });
    if (stale && stale.length) {
      const staleSet = new Set(stale.map(String));
      return blobEntries.filter(r => !(r && staleSet.has(String(r.id))));
    }
    return blobEntries;
  }

  // No blob for this company — read the mirror table instead of reporting a
  // division with no work.
  const rows = await safeRun('trucking.table', () => sql`
    SELECT actual_date::text AS actual_date, driver, unit, customer, task_number,
           total_hours::float AS total_hours,
           haul_fee::float    AS haul_fee,
           invoice_sent_date::text AS invoice_sent_date,
           date_paid::text         AS date_paid
      FROM truck_division_entries
     WHERE company_code = ${companyCode}
  `);
  return rows || [];
}

async function buildTruckingPortfolio(sql, companyCode) {
  const entries = await readTruckDivisionEntries(sql, companyCode);
  const m = truckingMetrics({ entries, fallbackYear: new Date().getFullYear() });

  const money = fmtCurrency2;
  const hrs   = n => (Number(n) || 0).toFixed(1);
  const count = n => Math.round(Number(n) || 0).toLocaleString('en-US');

  // Year-over-year, in the page's words: a signed percentage against last year.
  const vsPrev = (curr, prev) => {
    if (!m.prevYear || !prev) return null;
    const pct = ((curr - prev) / prev) * 100;
    return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% vs ${m.prevYear}`;
  };

  let status, statusKind;
  if      (!m.entryCount)                       { status = 'No Activity'; statusKind = 'mute';  }
  else if (m.invoices.uninvoiced.count > 0)      { status = `${m.invoices.uninvoiced.count} To Invoice`; statusKind = 'amber'; }
  else if (m.invoices.awaiting.count > 0)        { status = `${m.invoices.awaiting.count} Awaiting Payment`; statusKind = 'amber'; }
  else                                          { status = 'On Track';    statusKind = 'green'; }

  return {
    key: 'trucking', name: 'Trucking', accent: '#ef4444',
    status, statusKind,
    year: m.year,
    entryCount: m.entryCount,
    metrics: [
      {
        label: 'Total Revenue', value: money(m.revenue), tone: 'amber',
        sub: vsPrev(m.revenue, m.prevRevenue)
          || `${count(m.entryCount)} entr${m.entryCount === 1 ? 'y' : 'ies'} this year`,
      },
      {
        label: 'Total Hours', value: hrs(m.hours), tone: 'blue',
        sub: vsPrev(m.hours, m.prevHours) || 'logged this year',
      },
      { label: 'Active Units',   value: count(m.activeUnits),   tone: 'plain', sub: 'units running' },
      { label: 'Active Drivers', value: count(m.activeDrivers), tone: 'plain', sub: 'drivers active' },
      {
        label: 'Avg Revenue / Entry', value: money(m.avgRevenuePerEntry), tone: 'green',
        sub: `${count(m.entryCount)} entr${m.entryCount === 1 ? 'y' : 'ies'}`,
      },
      { label: 'Avg Haul Fee', value: money(m.avgHaulFee), tone: 'plain', sub: 'per hour, averaged' },
      {
        label: 'To Invoice', value: money(m.invoices.uninvoiced.amount),
        tone: m.invoices.uninvoiced.amount > 0 ? 'amber' : 'green',
        sub: `${count(m.invoices.uninvoiced.count)} haul${m.invoices.uninvoiced.count === 1 ? '' : 's'} not yet sent`,
      },
      {
        label: 'Awaiting Payment', value: money(m.invoices.awaiting.amount),
        tone: m.invoices.awaiting.amount > 0 ? 'amber' : 'green',
        sub: `${money(m.invoices.paid.amount)} paid`,
      },
    ],
    rows: m.customers.map(c => ({
      name:        c.name,
      meta:        [
        c.units.length   ? `${c.units.length} unit${c.units.length === 1 ? '' : 's'}`     : '',
        c.drivers.length ? `${c.drivers.length} driver${c.drivers.length === 1 ? '' : 's'}` : '',
        c.lastHaul ? `last haul ${c.lastHaul}` : '',
      ].filter(Boolean).join(' · '),
      entries:     c.entries,
      hours:       c.hours,
      revenue:     c.revenue,
      avgHaulFee:  c.avgHaulFee,
      uninvoiced:  c.uninvoiced,
      awaiting:    c.awaiting,
      paid:        c.paid,
    })),
  };
}

// ── Dust Control ─────────────────────────────────────────────────────
// The division's home dashboard, read back: year-to-date service figures, the
// invoice picture from the invoice era forward, and its customers ranked by
// revenue. The row-level money is computed in JS by api/lib/dust-metrics so it
// comes out of the same formula dust.html uses.
/**
 * One of Dust Control's two blob-backed billing books, as an array.
 *
 * Returns [] for a book that genuinely has no rows and null for one that could
 * not be read — safeRun collapses both to null, and the difference matters more
 * here than anywhere else in this file: a book read as empty silently subtracts
 * its revenue from the division, and the smaller figure looks exactly like a
 * real one. dustMetrics takes null as "unavailable" and says so on the page
 * rather than quietly reporting less money than the division earned.
 *
 * A stored value that is not an array is treated as unreadable rather than
 * empty, for the same reason.
 */
async function readDustBook(sql, companyCode, key) {
  try {
    const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:${key}`}`;
    if (!r.length || r[0].value == null) return [];      // no rows yet — genuinely empty
    return Array.isArray(r[0].value) ? r[0].value : null; // malformed — do not count it as empty
  } catch (err) {
    console.error(`[executive/report] dust.${key} failed:`, err.message);
    return null;
  }
}

async function buildDustPortfolio(sql, companyCode) {
  // Per-customer UB $/gal override column may not exist on older DBs; the
  // dust-config endpoint adds it lazily, but the report can run first. Ensure it
  // so the customer rates below can be read.
  await safeRun('dust.ensure_ub_col', () =>
    sql`ALTER TABLE IF EXISTS dust_companies ADD COLUMN IF NOT EXISTS ub_rate NUMERIC(10,4)`);

  const yearStart = `${new Date().getFullYear()}-01-01`;
  // Two windows are needed and they only coincide while the current year IS the
  // first invoice year: the KPIs are year-to-date, the invoice overview runs
  // from the start of the invoice era. Fetch from whichever is earlier.
  const from = yearStart < DUST_INVOICE_ERA_START ? yearStart : DUST_INVOICE_ERA_START;

  const [rows, companies, ubRate, obRows, eesRows] = await Promise.all([
    safeRun('dust.rows', () => sql`
      SELECT date::text AS date, company, location, state,
             start_time, end_time,
             v1_rate::float  AS v1_rate,
             v2_rate::float  AS v2_rate,
             gallons_ub::float AS gallons_ub,
             inv_sent::text  AS inv_sent,
             inv_received::text AS inv_received,
             inv_status
        FROM dust_control_entries
       WHERE company_code = ${companyCode}
         AND date IS NOT NULL
         AND date >= ${from}::date
    `),
    safeRun('dust.companies', () => sql`
      SELECT name, ub_rate::float AS ub_rate
        FROM dust_companies
       WHERE company_code = ${companyCode}
    `),
    safeRun('dust.ub_rate', async () => {
      const r = await sql`SELECT ub_rate::float AS v FROM dust_settings WHERE company_code = ${companyCode}`;
      return r[0]?.v ?? 0;
    }),
    // The division's other two billing books. Payroll posts an approved haul
    // into exactly one of the three, so counting only the first understated
    // Dust Control by whatever the other two billed — which, since payroll
    // started injecting material hauls, is a growing number.
    readDustBook(sql, companyCode, 'dust_other_billing_rows'),
    readDustBook(sql, companyCode, 'dust_ees_other_rows'),
  ]);

  const m = dustMetrics({
    // NOT `rows || []`. safeRun answers null when the query threw, and
    // collapsing that to an empty list would report the division's largest book
    // as billing nothing — the smaller figure looking exactly like a real one,
    // which is the failure readDustBook exists to prevent. dustMetrics reads
    // null as "unavailable" and the section says so.
    rows,
    obRows,      // null when unreadable — see readDustBook
    eesRows,
    companies: companies || [],
    ubRate:    ubRate    || 0,
  });

  const money = fmtCurrency2;
  const count = n => Math.round(Number(n) || 0).toLocaleString('en-US');

  // Lines across all three books, not pad visits alone: a year spent entirely
  // on material deliveries has no tracking rows at all, and reading "No
  // Activity" over a division with revenue on screen is the exact failure this
  // change exists to fix.
  const totalLines = m.books.reduce((n, b) => n + b.lines, 0);
  // A book that could not be read is not a book with nothing in it. Say so
  // rather than let the strip below report a total that is missing a third of
  // itself and looks fine.
  const missing = m.books.filter(b => !b.available).map(b => b.label);

  let status, statusKind;
  if      (missing.length)                 { status = `${missing.length} Book${missing.length === 1 ? '' : 's'} Unavailable`; statusKind = 'red'; }
  else if (!totalLines)                    { status = 'No Activity'; statusKind = 'mute';  }
  else if (m.invoices.overdue.count > 0)   { status = `${m.invoices.overdue.count} Overdue`; statusKind = 'red'; }
  else if (m.invoices.needsSent.count > 0) { status = `${m.invoices.needsSent.count} To Invoice`; statusKind = 'amber'; }
  else                                     { status = 'On Track'; statusKind = 'green'; }

  return {
    key: 'dust', name: 'Dust Control', accent: '#fbbf24',
    status, statusKind,
    year: m.year,
    metrics: [
      {
        // All three billing books. The sub-caption names the split whenever
        // more than one contributes, because a blended total with no
        // composition is what let two of the three go unnoticed for so long.
        label: 'YTD Revenue', value: money(m.revenueYtd), tone: 'amber',
        sub: (m.revenue.other || m.revenue.ees)
          ? [
              `${money(m.revenue.tracking)} tracking`,
              m.revenue.other ? `${money(m.revenue.other)} other billing` : '',
              m.revenue.ees   ? `${money(m.revenue.ees)} EES` : '',
            ].filter(Boolean).join(' · ')
          : `${count(m.jobsYtd)} job${m.jobsYtd === 1 ? '' : 's'} in ${m.year}`,
      },
      {
        label: 'Jobs This Month', value: count(m.jobsThisMonth),
        tone: m.jobsThisMonth > 0 ? 'green' : 'mute',
        sub:  `${monthName(m.month)} · pad visits`,
      },
      {
        // UB applied, and only that. Other Billing's delivered quantity is a
        // different measure in a unit that varies row to row, so it rides
        // alongside in its own units rather than being added in.
        label: 'Gallons YTD', value: count(m.gallonsYtd), tone: 'blue',
        // books[1].volume, not a re-derivation: `count` rounds, and dust's own
        // formatter deliberately keeps two decimals so a part-bag is not
        // reported as a quantity nobody delivered.
        sub: m.deliveredQuantity.length
          ? `UB applied · plus ${(m.books.find(b => b.key === 'other') || {}).volume} delivered`
          : 'UB product applied',
      },
      {
        label: 'Active Customers', value: count(m.activeCustomers), tone: 'amber',
        sub: m.states.length
          ? `served across ${m.states.length} state${m.states.length === 1 ? '' : 's'}`
          : 'served this year',
      },
      {
        // Tracking revenue over tracking visits — the two halves have to come
        // off the same book or it is not an average of anything.
        label: 'Avg Rev / Job', value: money(m.avgRevenuePerJob), tone: 'green',
        sub: 'per pad visit · tracking',
      },
      {
        label: 'Service Hours YTD', value: m.hoursYtd.toFixed(1), tone: 'blue',
        sub: [
          'field hours · tracking',
          m.otherHoursYtd     ? `${m.otherHoursYtd.toFixed(1)} trucking` : '',
          m.eesHoursYtd.billable ? `${m.eesHoursYtd.billable.toFixed(1)} EES` : '',
        ].filter(Boolean).join(' · '),
      },
      {
        label: 'Overdue', value: money(m.invoices.overdue.amount),
        tone: m.invoices.overdue.amount > 0 ? 'red' : 'green',
        sub: `${count(m.invoices.overdue.count)} invoice${m.invoices.overdue.count === 1 ? '' : 's'} past ${DUST_OVERDUE_DAYS} days · tracking`,
      },
      {
        label: 'Unpaid / Pending', value: money(m.invoices.outstanding.amount),
        tone: m.invoices.outstanding.amount > 0 ? 'amber' : 'green',
        // Only Dust Control Tracking carries invoice dates, so only its rows
        // can be aged. Naming the money the other two books hold is the point:
        // read without it, this tile looks like the division's whole AR
        // picture, and it is not.
        sub: m.invoices.untracked.amount
          ? `${m.invoices.needsSent.count
              ? `${count(m.invoices.needsSent.count)} still to invoice`
              : `${count(m.invoices.outstanding.count)} awaiting payment`} · tracking; ${money(m.invoices.untracked.amount)} not AR-tracked`
          : (m.invoices.needsSent.count
              ? `${count(m.invoices.needsSent.count)} still to invoice · tracking`
              : `${count(m.invoices.outstanding.count)} awaiting payment · tracking`),
      },
    ],
    rows: m.customers.map(c => ({
      name:        c.name,
      meta:        c.states.length ? c.states.join(' · ') : '',
      lastVisit:   c.lastVisit,
      // Tracking's measures — a customer served only off Other Billing has no
      // pad visits, no UB gallons and no field hours, and showing zeroes there
      // is the honest answer rather than a gap.
      visits:      c.visits,
      gallons:     c.gallons,
      hours:       c.hours,
      // Revenue across all three books, with the split beside it so a customer
      // whose money is mostly untracked is visible as such.
      revenue:     c.revenue,
      revenueTracking: c.revenueTracking,
      revenueOther:    c.revenueOther,
      revenueEes:      c.revenueEes,
      avgPerVisit: c.avgPerVisit,
      overdue:     c.overdue,
      unpaid:      c.unpaid,
      paid:        c.paidAmt,
      // Billed, but on a book with no invoice state — so it will never appear
      // in Overdue, Unpaid or Paid however long it goes uncollected.
      untracked:   c.untracked,
    })),
    invoices: m.invoices,
    // Everything that could not honestly be folded into one number: what each
    // book billed and in what units, the money no AR process can see, and work
    // recorded with nobody's price on it. Rendered under the metric strip.
    books: m.books,
    unpriced: m.unpriced,
    coverage: m.coverage,
    unavailable: missing,
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

// ── Intercompany Billing ─────────────────────────────────────────────
// Reads the blob the Intercompany page reads, for two reasons. The page's
// payment_received_date and its per-source rates live only there — the mirror
// table has neither — and the blob's duplicates are collapsed on load, which the
// table's row-for-row sync keeps, so counting from the table over-reports.
async function buildIcPortfolio(sql, companyCode) {
  // Per-customer UB $/gal override column may not exist on older DBs.
  await safeRun('ic.ensure_ub_col', () =>
    sql`ALTER TABLE IF EXISTS dust_companies ADD COLUMN IF NOT EXISTS ub_rate NUMERIC(10,4)`);

  const [billingBlob, ratesBlob, dustUbRate, dustCompanies] = await Promise.all([
    safeRun('ic.billing_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_intercompany_billing_entries`}`;
      return r[0]?.value;
    }),
    safeRun('ic.rates_blob', async () => {
      const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_intercompany_rates`}`;
      return r[0]?.value;
    }),
    safeRun('ic.dust_ub_rate', async () => {
      const r = await sql`SELECT ub_rate::float AS v FROM dust_settings WHERE company_code = ${companyCode}`;
      return r[0]?.v ?? 0;
    }),
    safeRun('ic.dust_companies', () => sql`
      SELECT name, ub_rate::float AS ub_rate FROM dust_companies WHERE company_code = ${companyCode}
    `),
  ]);

  const m = icMetrics({
    entries:       Array.isArray(billingBlob) ? billingBlob : [],
    ratesBlob,
    dustUbRate:    dustUbRate || 0,
    dustCompanies: dustCompanies || [],
    year:          new Date().getFullYear(),
    asOfIso:       localDateIso(new Date()),
  });

  const money = fmtCurrency2;
  const hrs   = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  const count = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  const entryWord = n => `${count(n)} entr${n === 1 ? 'y' : 'ies'}`;

  let status, statusKind;
  if      (!m.entryCount)               { status = 'No Activity'; statusKind = 'mute';  }
  else if (m.notInvoiced.count > 0)     { status = `${m.notInvoiced.count} To Invoice`; statusKind = 'red'; }
  else if (m.awaitingPayment.count > 0) { status = `${m.awaitingPayment.count} Awaiting Payment`; statusKind = 'amber'; }
  else                                  { status = 'Settled';     statusKind = 'green'; }

  return {
    key: 'intercompany', name: 'Intercompany Billing', accent: '#a78bfa',
    status, statusKind,
    year: m.year,
    entryCount: m.entryCount,
    duplicates: m.duplicates,
    truckRate:  m.rates.truckRate,
    metrics: [
      { label: 'Total IC Revenue — YTD', value: money(m.totalIc), tone: 'plain', sub: entryWord(m.entryCount) },
      { label: 'Trucking IC — YTD',      value: money(m.truckIc), tone: 'red',   sub: `${entryWord(m.truckEntries)} at ${money(m.rates.truckRate)}/hr` },
      { label: 'Dust Control IC — YTD',  value: money(m.dustIc),  tone: 'amber', sub: entryWord(m.dustEntries) },
      { label: 'Total Hours — YTD',      value: hrs(m.totalHours), tone: 'blue', sub: 'across all divisions' },
      {
        label: 'Customer Revenue — YTD', value: money(m.customerRevenue), tone: 'green',
        sub: 'billed at customer rates',
      },
      {
        label: 'Outstanding IC', value: money(m.outstanding.amount),
        tone: m.outstanding.amount > 0 ? 'amber' : 'green',
        sub: `${count(m.outstanding.count)} action required`,
      },
      {
        label: 'Not Yet Invoiced', value: money(m.notInvoiced.amount),
        tone: m.notInvoiced.amount > 0 ? 'red' : 'green',
        sub: entryWord(m.notInvoiced.count),
      },
      {
        label: 'Awaiting Payment', value: money(m.awaitingPayment.amount),
        tone: m.awaitingPayment.amount > 0 ? 'amber' : 'green',
        sub: entryWord(m.awaitingPayment.count),
      },
    ],
    rows: m.companies.map(c => ({
      name:            c.name,
      meta:            entryWord(c.entries),
      hours:           c.hours,
      truckIc:         c.truckIc,
      dustIc:          c.dustIc,
      ic:              c.ic,
      revenue:         c.revenue,
      notInvoiced:     c.notInvoiced,
      awaitingPayment: c.awaitingPayment,
      paid:            c.paid,
    })),
    // Section-level roll-up of the same deduped list the rows come from, so a
    // consumer that wants the totals doesn't re-add the rows itself.
    summary: {
      aged:        m.aged,
      notInvoiced: m.notInvoiced,
      outstanding: m.outstanding,
    },
    total: {
      name:            'All Companies',
      meta:            entryWord(m.entryCount),
      hours:           m.totalHours,
      truckIc:         m.truckIc,
      dustIc:          m.dustIc,
      ic:              m.totalIc,
      revenue:         m.customerRevenue,
      notInvoiced:     m.notInvoiced.amount,
      awaitingPayment: m.awaitingPayment.amount,
      paid:            m.companies.reduce((s, c) => s + c.paid, 0),
      isTotal:         true,
    },
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

// ── Quarry ───────────────────────────────────────────────────────────
// Quarry state lives entirely in JSONB blobs (no normalized tables yet):
//   fct_quarry_sales         → [{ date, locationName, productName, tons, pricePerTon }]
//   fct_quarry_daily         → [{ date, locationName, hours, rate, fuelGallons, ppg }]
//   fct_quarry_crushing      → [{ date, locationName, hourlyRate, hours, fuelGallons,
//                                 fuelCost, loadsToCrusher, tonsPerLoad, hoursCrushing }]
//   fct_quarry_inventory     → { basis, openings: [...], adjustments: [...] }
//   fct_quarry_loss_pct      → { '<pit>': percent }
//   fct_quarry_monthly_fixed → { '<pit>': { 'YYYY-MM': amount } }
//   fct_quarry_royalty       → { '<pit>': [ { name, rate, floor } ] }
//   fct_quarry_lists         → { product: [ { id, name, royalty } ], … }
//
// All eight are read and handed to api/lib/quarry-metrics, which is a port of
// the Quarry page's own arithmetic — the report is meant to agree with the page
// down to the cent, and the only way to guarantee that is to run its formulas.
const QUARRY_BLOBS = {
  sales:        'fct_quarry_sales',
  daily:        'fct_quarry_daily',
  crush:        'fct_quarry_crushing',
  inventory:    'fct_quarry_inventory',
  lossPct:      'fct_quarry_loss_pct',
  monthlyFixed: 'fct_quarry_monthly_fixed',
  royalty:      'fct_quarry_royalty',
  lists:        'fct_quarry_lists',
};

async function buildQuarryPortfolio(sql, companyCode) {
  const names = Object.keys(QUARRY_BLOBS);
  const values = await Promise.all(names.map(n => safeRun(`quarry.${n}_blob`, async () => {
    const r = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:${QUARRY_BLOBS[n]}`}`;
    return r[0]?.value;
  })));
  const blob = {};
  names.forEach((n, i) => { blob[n] = values[i]; });

  // The Quarry Home tab defaults its Year filter to the current year, and its
  // stockpile balances through today for that year. Mirror both.
  const now  = new Date();
  const year = now.getFullYear();
  const m = quarryMetrics({
    sales:        blob.sales,
    daily:        blob.daily,
    crush:        blob.crush,
    inventory:    blob.inventory,
    lossPct:      blob.lossPct,
    monthlyFixed: blob.monthlyFixed,
    royalty:      blob.royalty,
    lists:        blob.lists,
    year,
    cutoff:       localDateIso(now),
  });

  const tons  = fmtTons;
  const money = fmtCurrency2;
  const haveTons = m.total.tonsSold > 0;
  const pits     = m.inventory.locations.length;

  let status, statusKind;
  const be = m.breakEven.status;
  if      (!m.entryCount)                { status = 'No Data';     statusKind = 'mute'; }
  else if (m.alert.tone === 'red')        { status = 'Stock Alert'; statusKind = 'red';  }
  else if (be.value === 'Below')          { status = 'Below B/E';   statusKind = 'red';  }
  else if (be.value === 'Above')          { status = 'Above B/E';   statusKind = 'green'; }
  else                                    { status = 'On Track';    statusKind = 'green'; }

  return {
    key: 'quarry', name: 'Quarry', accent: '#f97316',
    status, statusKind,
    year: m.year,
    entryCount: m.entryCount,
    metrics: [
      // Stockpile & flow — the page's first KPI row.
      {
        label: 'Tons On Hand', value: tons(m.inventory.total.onHand),
        tone: m.inventory.total.onHand < -0.005 ? 'red' : 'plain',
        sub: pits ? `${pits} location${pits === 1 ? '' : 's'} · as of ${m.cutoff}` : 'Set up Inventory to track the piles',
      },
      {
        label: 'Days of Supply',
        value: m.inventory.total.daysOfSupply !== null ? `${Math.round(m.inventory.total.daysOfSupply)} days` : '—',
        tone: 'plain',
        sub: m.inventory.total.dailyRate > 0
          ? `at ${tons(m.inventory.total.dailyRate)} tons/day sold`
          : `no sales in the last ${QUARRY_RATE_WINDOW_DAYS} days`,
      },
      {
        label: 'Net Change',
        value: (m.flow.net > 0 ? '+' : '') + tons(m.flow.net),
        tone: m.flow.net > 0.005 ? 'green' : m.flow.net < -0.005 ? 'red' : 'plain',
        sub: `${m.flow.month} · crushed ${tons(m.flow.produced)} · sold ${tons(m.flow.sold)}`,
      },
      { label: 'Needs Attention', value: m.alert.value, tone: m.alert.tone, sub: m.alert.sub },

      // Per-ton economics — the page's second KPI row.
      {
        label: 'Margin / Ton',
        value: haveTons ? money(m.total.avgPricePerTon - m.total.avgCostPerTonSold) : '—',
        tone: !haveTons ? 'plain'
          : (m.total.avgPricePerTon - m.total.avgCostPerTonSold) > 0 ? 'green' : 'red',
        sub: haveTons
          ? `${m.total.marginPct.toFixed(1)}% margin · ${money(m.total.grossMargin)} total`
          : 'no tons sold this year',
      },
      {
        label: 'Avg Price / Ton', value: haveTons ? money(m.total.avgPricePerTon) : '—', tone: 'blue',
        sub: haveTons
          ? `${tons(m.total.tonsSold)} tons across ${m.total.salesCount} sale${m.total.salesCount === 1 ? '' : 's'}`
          : 'sales ÷ tons sold',
      },
      {
        label: 'Cost / Ton', value: haveTons ? money(m.total.avgCostPerTonSold) : '—', tone: 'amber',
        sub: haveTons
          ? `daily ${money(m.total.dailyCost)} · crushing ${money(m.total.crushCost)}`
          : 'daily + crushing ÷ tons sold',
      },
      { label: 'Break-Even', value: be.value, tone: be.tone, sub: be.sub },
    ],
    // Ordered by margin, the way the Analytics tab's Performance by Location
    // table orders it — the pit losing money belongs at the top, not the one
    // selling the most.
    rows: m.locations.slice().sort((a, b) => b.grossMargin - a.grossMargin).map(e => ({
      name:            e.name,
      meta:            `${e.salesCount} sale${e.salesCount === 1 ? '' : 's'}`,
      sales:           e.totalSales,
      cost:            e.totalCost,
      margin:          e.grossMargin,
      marginPct:       e.totalSales > 0 ? e.marginPct : null,
      tonsSold:        e.tonsSold,
      costPerTonSold:  e.tonsSold > 0 ? e.avgCostPerTonSold : null,
      costPerTon:      e.tonsCrushed > 0 ? e.costPerTon : null,
      tonsCrushed:     e.tonsCrushed,
      // A pit with no loss figure entered shows a dash, not 0% — an unset
      // percentage must not read as a perfect screen.
      lossPct:         (e.tonsCrushed > 0 && e.hasLoss) ? e.lossPct : null,
      finalScreenTons: (e.tonsCrushed > 0 && e.hasLoss) ? e.finalScreenTons : null,
      hours:           e.totalHours,
    })),
    total: {
      name:            m.total.name,
      meta:            `${m.total.salesCount} sale${m.total.salesCount === 1 ? '' : 's'}`,
      sales:           m.total.totalSales,
      cost:            m.total.totalCost,
      margin:          m.total.grossMargin,
      marginPct:       m.total.totalSales > 0 ? m.total.marginPct : null,
      tonsSold:        m.total.tonsSold,
      costPerTonSold:  m.total.tonsSold > 0 ? m.total.avgCostPerTonSold : null,
      costPerTon:      m.total.tonsCrushed > 0 ? m.total.costPerTon : null,
      tonsCrushed:     m.total.tonsCrushed,
      lossPct:         (m.total.tonsCrushed > 0 && m.total.hasLoss) ? m.total.lossPct : null,
      finalScreenTons: (m.total.tonsCrushed > 0 && m.total.hasLoss) ? m.total.finalScreenTons : null,
      hours:           m.total.totalHours,
    },
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

// The prevailing-wage flag lives on the project blob, not the timesheet row, so
// resolving it needs one app_data read per batch. Same rule and same key scheme
// as attachPrevailingWage in api/timesheet-entries.js: only turf, paving and
// kiewit keep projects there, and the other divisions have no prevailing-wage
// concept at all.
//   true / false → read from the project blob (false when the blob is gone)
//   null         → division has no such concept, or no job is attached
const PW_PROJECT_PREFIX = {
  turf:   'fct_project_',
  paving: 'fct_paving_project_',
  kiewit: 'fct_kiewit_project_',
};

async function attachPrevailingWage(sql, companyCode, entries) {
  const keyFor = e => {
    const prefix = PW_PROJECT_PREFIX[e.division];
    return prefix && e.job_id ? `${companyCode}:${prefix}${e.job_id}` : null;
  };
  const keys = [...new Set(entries.map(keyFor).filter(Boolean))];

  const pwByKey = new Map();
  if (keys.length) {
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    for (const r of rows) {
      const blob = r.value;
      pwByKey.set(r.key, !!(blob && typeof blob === 'object' && blob.prevailing_wage === true));
    }
  }
  for (const e of entries) {
    const key = keyFor(e);
    e.prevailing_wage = key == null ? null : (pwByKey.has(key) ? pwByKey.get(key) : false);
  }
  return entries;
}

// The payroll section, shaped like the Payroll page's Reports tab: its Hours
// Report totals across the strip, then its per-employee table. Scoped to the
// current biweekly cycle, the same cycle the page's "Current Biweekly" button
// selects, so the two land on the same fortnight.
async function buildPayrollSummary(sql, companyCode) {
  const { startIso, endIso } = biweeklyPayPeriod(new Date());

  const rows = await safeRun('payroll.entries', () => sql`
    SELECT
      user_id, username, entry_type, status, division, job_id,
      work_date::text                    AS work_date,
      computed_hours::float              AS computed_hours,
      travel_hours::float                AS travel_hours,
      travel_to_site_hours::float        AS travel_to_site_hours,
      travel_to_shop_hours::float        AS travel_to_shop_hours
    FROM timesheet_entries
    WHERE company_code = ${companyCode}
      AND status IN ('submitted', 'approved')
      AND work_date >= ${startIso}::date
      AND work_date <= ${endIso}::date
  `);

  const entries = rows || [];
  // A failed lookup must not silently reclassify prevailing work as standard —
  // leave the flag null (the "no such concept" value) and let the figures show
  // everything as standard rather than inventing a split.
  await safeRun('payroll.prevailing_wage', () => attachPrevailingWage(sql, companyCode, entries));

  const m = payrollMetrics({ entries, periodStart: startIso, periodEnd: endIso });

  const hrs = n => (Number(n) || 0).toFixed(2);
  const t   = m.totals;

  let status, statusKind;
  if      (!t.employees)         { status = 'No Timesheets';  statusKind = 'mute';  }
  else if (t.pendingHours > 0.001) { status = `${hrs(t.pendingHours)} h Pending`; statusKind = 'amber'; }
  else                           { status = 'All Approved';   statusKind = 'green'; }

  return {
    key: 'payroll', name: 'Payroll', accent: '#22d3ee',
    status, statusKind,
    periodStart: m.periodStart,
    periodEnd:   m.periodEnd,
    metrics: [
      {
        label: 'Employees', value: String(t.employees), tone: 'blue',
        // Employee-days, not calendar days: each worker's distinct dates, added
        // across the crew. Two people on one date is two.
        sub: `${t.daysWorked} employee-day${t.daysWorked === 1 ? '' : 's'} logged`,
      },
      { label: 'Hours',        value: hrs(t.workHours),   tone: 'plain', sub: 'worked on the job' },
      { label: 'Travel',       value: hrs(t.travelHours), tone: 'mute',
        sub: `to site ${hrs(t.travelToSite)} · to shop ${hrs(t.travelToShop)}` },
      { label: 'Total Hours',  value: hrs(t.totalHours),  tone: 'green', sub: 'work + travel' },
      {
        label: 'Prevailing Hrs', value: hrs(t.pwHours), tone: 'amber',
        sub: 'work on prevailing-wage jobs',
      },
      {
        label: 'Standard Hrs', value: hrs(t.stdHours), tone: 'plain',
        sub: 'everything at the standard rate',
      },
      {
        label: 'Pending Hrs', value: hrs(t.pendingHours),
        tone: t.pendingHours > 0.001 ? 'amber' : 'green',
        sub: t.pendingOff ? `${t.pendingOff} time-off request${t.pendingOff === 1 ? '' : 's'} too` : 'awaiting approval',
      },
      {
        label: 'Approved Hrs', value: hrs(t.approvedHours), tone: 'green',
        sub: t.approvedOff ? `${t.approvedOff} time-off entr${t.approvedOff === 1 ? 'y' : 'ies'} too` : 'signed off',
      },
    ],
    rows: m.employees.map(e => ({
      name:          e.username,
      meta:          e.divisions.length ? e.divisions.join(' · ') : '',
      daysWorked:    e.daysWorked,
      workHours:     e.workHours,
      travelToSite:  e.travelToSite,
      travelToShop:  e.travelToShop,
      travelHours:   e.travelHours,
      totalHours:    e.totalHours,
      pwHours:       e.pwHours,
      stdHours:      e.stdHours,
      pendingHours:  e.pendingHours,
      approvedHours: e.approvedHours,
      pendingOff:    e.pendingOff,
      approvedOff:   e.approvedOff,
      hasPending:    e.hasPending,
    })),
    total: {
      name:          `Totals · ${t.employees} employee${t.employees === 1 ? '' : 's'}`,
      meta:          '',
      workHours:     t.workHours,
      travelToSite:  t.travelToSite,
      travelToShop:  t.travelToShop,
      travelHours:   t.travelHours,
      totalHours:    t.totalHours,
      pwHours:       t.pwHours,
      stdHours:      t.stdHours,
      pendingHours:  t.pendingHours,
      approvedHours: t.approvedHours,
      pendingOff:    t.pendingOff,
      approvedOff:   t.approvedOff,
      hasPending:    t.pendingHours > 0.001,
      isTotal:       true,
    },
  };
}

function mockReport() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),

    // One entry per job-running division, each carrying that division's
    // metric strip + project table. Empty until the live build fills them in.
    portfolios: PROJECT_DIVISIONS.map(d => ({
      key: d.key, name: d.name, accent: d.accent,
      status: '—', statusKind: 'mute',
      metrics: [], rows: [],
      shown: 0, pinned: 0, recent: 0, hidden: 0, total: 0,
    })),

    // Quarry and Dust Control each get their own section, shaped like their own
    // page rather than like a project table.
    quarry: {
      key: 'quarry', name: 'Quarry', accent: '#f97316',
      status: '—', statusKind: 'mute',
      metrics: [], rows: [], total: null,
    },
    dust: {
      key: 'dust', name: 'Dust Control', accent: '#fbbf24',
      status: '—', statusKind: 'mute',
      metrics: [], rows: [],
    },
    trucking: {
      key: 'trucking', name: 'Trucking', accent: '#ef4444',
      status: '—', statusKind: 'mute',
      metrics: [], rows: [],
    },
    intercompany: {
      key: 'intercompany', name: 'Intercompany Billing', accent: '#a78bfa',
      status: '—', statusKind: 'mute',
      metrics: [], rows: [], total: null,
    },

    payroll: {
      key: 'payroll', name: 'Payroll', accent: '#22d3ee',
      status: '—', statusKind: 'mute',
      periodStart: null, periodEnd: null,
      metrics: [], rows: [], total: null,
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
    const sql     = neon(process.env.DATABASE_URL);
    const company = payload.companyCode;

    // Division sections. The project divisions come as a set; every other
    // division builds its own, since none of them runs jobs and each mirrors a
    // different page. A builder that fails leaves the mock's empty placeholder,
    // so one bad division cannot blank the report.
    const [
      livePortfolios, liveQuarry, liveDust, liveTrucking, liveIc,
      liveInventory, livePayroll,
    ] = await Promise.all([
      buildDivisionPortfolios(sql, company).catch(err => {
        console.error('[executive/report] portfolios build failed:', err.message); return null;
      }),
      buildQuarryPortfolio(sql, company).catch(err => {
        console.error('[executive/report] quarry portfolio failed:', err.message); return null;
      }),
      buildDustPortfolio(sql, company).catch(err => {
        console.error('[executive/report] dust portfolio failed:', err.message); return null;
      }),
      buildTruckingPortfolio(sql, company).catch(err => {
        console.error('[executive/report] trucking portfolio failed:', err.message); return null;
      }),
      buildIcPortfolio(sql, company).catch(err => {
        console.error('[executive/report] intercompany portfolio failed:', err.message); return null;
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
    if (liveQuarry)   report.quarry      = liveQuarry;
    if (liveDust)     report.dust        = liveDust;
    if (liveTrucking) report.trucking    = liveTrucking;
    if (liveIc)       report.intercompany = liveIc;
    if (Array.isArray(liveInventory)) {
      report.inventory = liveInventory;
    }
    if (livePayroll && Array.isArray(livePayroll.rows)) {
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
