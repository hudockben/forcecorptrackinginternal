'use strict';

// GET /api/executive/report
//
// Cross-division roll-up for the Executive Division dashboard.
// Platform admins only.
//
// Wiring is incremental: the 4 hero KPIs (Active Projects, Revenue
// This Week, AR 30+ Days, Unbilled Intercompany) come from live SQL
// scoped to the caller's company_code. Division tiles, the project
// portfolio, and per-project detail are still mock until subsequent
// passes. Each hero query runs independently and falls back to '—'
// on failure so a single bad query can't blank the report.

const { neon }        = require('@neondatabase/serverless');
const { requireAuth } = require('../lib/auth');

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
  return '$' + v.toLocaleString('en-US');
}
// Format a cost-vs-bid variance as a signed pct ("+2.1%", "−0.4%").
// Returns { text, color } where color is 'green' for under bid (negative
// variance) and 'red' for over bid. Uses a true minus sign (U+2212) to
// match the existing UI style.
function fmtCostVsBid(booked, bid) {
  const b = Number(booked) || 0;
  const k = Number(bid)    || 0;
  if (k <= 0) return { text: '—', color: 'mute' };
  const variance = (b - k) / k;
  const pct = variance * 100;
  if (Math.abs(pct) < 0.1) return { text: 'on plan', color: 'mute' };
  const sign = pct > 0 ? '+' : '−';
  const txt = `${sign}${Math.abs(pct).toFixed(1)}%`;
  return { text: txt, color: pct > 0 ? 'red' : 'green' };
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

  const activeProjects = await safeRun('active_projects', async () => {
    const rows = await sql`
      SELECT COUNT(*)::int AS n
        FROM projects
       WHERE company_code = ${companyCode}
         AND LOWER(COALESCE(status, '')) NOT IN ('complete', 'closed')
    `;
    return rows[0]?.n ?? 0;
  });

  const revNow = await safeRun('revenue_this_week', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND sent_at >= ${weekStart}
         AND sent_at <  ${weekEnd}
    `;
    return rows[0]?.v ?? 0;
  });

  const revPrev = await safeRun('revenue_last_week', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND sent_at >= ${lastWeekStart}
         AND sent_at <  ${lastWeekEnd}
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
// name, accent, status, statusKind, kpis). Paving and Quarry are not
// wired here — their data shape is still in flux — so they fall through
// to mockReport() unchanged.

// Turf — financial-status focused: Active / Cost vs Bid / Projected / Profit.
// Each query is independent under safeRun so a single failing query
// (e.g., a missing column on a fresh DB) only blanks one KPI rather
// than the whole tile. Always returns a tile object — never null —
// so the front-end shows the new labels even if every query fails.
async function buildTurfTile(sql, companyCode /* , weekStart, weekEnd unused */) {
  // ── Active count (anything not Complete/Closed) ──────────────
  const active = await safeRun('turf.active', async () => {
    const r = await sql`
      SELECT COUNT(*)::int AS n
        FROM projects
       WHERE company_code = ${companyCode}
         AND LOWER(COALESCE(status, '')) NOT IN ('complete', 'closed')
    `;
    return r[0]?.n ?? 0;
  });

  // ── On Hold count (the closest "needs attention" signal in the
  //    home-page status taxonomy; replaces the previous At Risk
  //    count which referenced a status value that doesn't exist
  //    in the production data) ────────────────────────────────────
  const onHold = await safeRun('turf.on_hold', async () => {
    const r = await sql`
      SELECT COUNT(*)::int AS n
        FROM projects
       WHERE company_code = ${companyCode}
         AND LOWER(COALESCE(status, '')) = 'on hold'
    `;
    return r[0]?.n ?? 0;
  });

  // ── Per-project financials (bid, actual, projected) ──────────
  // Per-bid-item projection formula matches tracker.html's
  // projForBidItem() so the aggregate matches what users see on
  // the project pages.
  const financials = await safeRun('turf.financials', async () => {
    return await sql`
      WITH active_proj AS (
        SELECT id, contract_amount
          FROM projects
         WHERE company_code = ${companyCode}
           AND LOWER(COALESCE(status, '')) NOT IN ('complete', 'closed')
      ),
      bid_per_item AS (
        SELECT
          bi.project_id,
          bi.cost_code,
          COALESCE(bi.sub_code, '') AS sub_code,
          COALESCE(bi.quantity, 0) AS bid_qty,
          COALESCE(bi.quantity, 0) * COALESCE(bi.unit_cost, 0)::float AS bid_total,
          bi.start_date,
          bi.target_date
          FROM bid_items bi
         WHERE bi.company_code = ${companyCode}
           AND bi.project_id IN (SELECT id FROM active_proj)
      ),
      daily_per_match AS (
        SELECT
          project_id,
          cost_code,
          COALESCE(sub_code, '') AS sub_code,
          SUM(
            COALESCE(total_cost_override,
              COALESCE(labor_hours, 0) * COALESCE(rate, 0)
              + COALESCE(equip_hours, 0) * COALESCE(equip_unit_cost, 0)
              + COALESCE(material_cost, 0)
            )
          )::float                          AS actual,
          SUM(COALESCE(quantity, 0))::float AS rqty
          FROM daily_tracking
         WHERE company_code = ${companyCode}
           AND project_id IN (SELECT id FROM active_proj)
           AND project_id <> ''
         GROUP BY project_id, cost_code, COALESCE(sub_code, '')
      ),
      projected_per_item AS (
        SELECT
          bp.project_id,
          bp.bid_total,
          COALESCE(d.actual, 0) AS actual,
          CASE
            WHEN bp.start_date IS NOT NULL
             AND bp.target_date IS NOT NULL
             AND COALESCE(d.actual, 0) > 0
             AND CURRENT_DATE > bp.start_date
             AND bp.target_date > bp.start_date
            THEN GREATEST(
              d.actual,
              d.actual
                * EXTRACT(EPOCH FROM (bp.target_date - bp.start_date))
                / NULLIF(EXTRACT(EPOCH FROM (CURRENT_DATE - bp.start_date)), 0)
            )
            WHEN COALESCE(d.rqty, 0) > 0
            THEN (d.actual / d.rqty) * bp.bid_qty
            ELSE bp.bid_total
          END AS projected
        FROM bid_per_item bp
        LEFT JOIN daily_per_match d
               ON d.project_id = bp.project_id
              AND d.cost_code  = bp.cost_code
              AND d.sub_code   = bp.sub_code
      )
      SELECT
        COALESCE(SUM(ap.contract_amount), 0)::float AS contract_total,
        COALESCE((SELECT SUM(bid_total)::float FROM bid_per_item),       0) AS bid_total,
        COALESCE((SELECT SUM(actual)::float    FROM projected_per_item), 0) AS actual_total,
        COALESCE((SELECT SUM(projected)::float FROM projected_per_item), 0) AS projected_total
      FROM active_proj ap
    `;
  });

  const f = financials && financials[0] ? financials[0] : null;
  const totalContract  = f ? Number(f.contract_total)  || 0 : 0;
  const totalBid       = f ? Number(f.bid_total)       || 0 : 0;
  const totalActual    = f ? Number(f.actual_total)    || 0 : 0;
  const totalProjected = f ? Number(f.projected_total) || 0 : 0;

  // Cost vs Bid (aggregate)
  const cvbFmt = totalBid > 0
    ? fmtCostVsBid(totalActual, totalBid)
    : { text: '—', color: 'mute' };
  const cvbSub = totalBid > 0
    ? (cvbFmt.color === 'red'   ? 'Over bid'
      : cvbFmt.color === 'green' ? 'Under bid'
      : 'On plan')
    : undefined;

  // Profit
  let profitText = '—';
  let profitSub;
  if (totalContract > 0 && totalProjected > 0) {
    const profit = totalContract - totalProjected;
    if (Math.abs(profit) < 1) {
      profitText = '$0';
      profitSub  = 'Break-even';
    } else if (profit > 0) {
      profitText = fmtCurrency(profit);
      profitSub  = `${((profit / totalContract) * 100).toFixed(1)}% margin`;
    } else {
      profitText = `−${fmtCurrency(Math.abs(profit))}`;
      profitSub  = `${(Math.abs(profit / totalContract) * 100).toFixed(1)}% loss`;
    }
  }

  // Status pill — On Hold > Margin Risk > On Track
  let status, statusKind;
  if (onHold && onHold > 0) {
    status = `${onHold} On Hold`;
    statusKind = 'amber';
  } else if (totalContract > 0 && totalProjected > totalContract) {
    status = 'Margin Risk';
    statusKind = 'amber';
  } else {
    status = 'On Track';
    statusKind = 'green';
  }

  return {
    key: 'turf', name: 'Turf Management', accent: '#22c55e',
    status, statusKind,
    kpis: [
      {
        label: 'Active Projects',
        value: active != null ? String(active) : '—',
        sub:   (onHold && onHold > 0) ? `${onHold} on hold` : undefined,
      },
      {
        label: 'Cost vs Bid',
        value: cvbFmt.text,
        sub:   cvbSub,
      },
      {
        label: 'Projected',
        value: totalProjected > 0 ? fmtCurrency(totalProjected) : '—',
        sub:   totalContract > 0  ? `vs ${fmtCurrency(totalContract)} contract` : undefined,
      },
      {
        label: 'Profit',
        value: profitText,
        sub:   profitSub,
      },
    ].map(k => { if (k.sub === undefined) delete k.sub; return k; }),
  };
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
  // Revenue · This Week
  const revWk = await safeRun('dust.revenue_wk', async () => {
    const rows = await sql`
      SELECT
        COALESCE(SUM(
          COALESCE(v1_rate, 0)     * GREATEST(0, hrs)
          + COALESCE(v2_rate, 0)   * GREATEST(0, hrs)
          + COALESCE(gallons_ub, 0)
            * COALESCE((SELECT ub_rate::float FROM dust_settings WHERE company_code = ${companyCode}), 0)
        ), 0)::float AS v
      FROM (
        SELECT
          v1_rate, v2_rate, gallons_ub,
          CASE
            WHEN start_time ~ '^[0-9]{1,2}:[0-9]{2}'
             AND end_time   ~ '^[0-9]{1,2}:[0-9]{2}'
            THEN EXTRACT(EPOCH FROM (end_time::time - start_time::time)) / 3600.0
            ELSE 0
          END AS hrs
        FROM dust_control_entries
        WHERE company_code = ${companyCode}
          AND date >= ${weekStart}
          AND date <  ${weekEnd}
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
            * COALESCE((SELECT ub_rate::float FROM dust_settings WHERE company_code = ${companyCode}), 0)
        ), 0)::float AS v
      FROM (
        SELECT
          v1_rate, v2_rate, gallons_ub,
          CASE
            WHEN start_time ~ '^[0-9]{1,2}:[0-9]{2}'
             AND end_time   ~ '^[0-9]{1,2}:[0-9]{2}'
            THEN EXTRACT(EPOCH FROM (end_time::time - start_time::time)) / 3600.0
            ELSE 0
          END AS hrs
        FROM dust_control_entries
        WHERE company_code = ${companyCode}
          AND date >= date_trunc('month', CURRENT_DATE)
          AND date <  date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'
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

// ── Project portfolio (page 2) ───────────────────────────────────────
// Mirrors the per-project financial table shown on the turf & paving
// home pages: Project · Status · Progress · Contract · Bid · Actual ·
// Variance · Projected · Profit · Pinned.
//
// Per-bid-item projection formula matches tracker.html projForBidItem():
//   - if start/target dates set AND actual > 0 AND elapsed > 0
//       projected = max(actual, actual/elapsed × total_days)  (time scale)
//   - else if running_qty > 0
//       projected = (actual / running_qty) × bid_qty           (qty scale)
//   - else
//       projected = bid_total                                  (use bid)
//
// Then summed per project. progress %, variance, profit are derived
// from the totals in JS.
async function buildProjectsPortfolio(sql, companyCode) {
  const rows = await safeRun('projects.portfolio', async () => {
    return await sql`
      WITH target_projects AS (
        SELECT id, name, job_number, status,
               contract_amount, pinned, updated_at
          FROM projects
         WHERE company_code = ${companyCode}
           AND (LOWER(COALESCE(status, '')) NOT IN ('complete', 'closed')
                OR pinned = TRUE)
         ORDER BY pinned DESC NULLS LAST, updated_at DESC NULLS LAST
         LIMIT 12
      ),
      bid_per_item AS (
        SELECT
          bi.project_id,
          bi.cost_code,
          COALESCE(bi.sub_code, '')                                       AS sub_code,
          COALESCE(bi.quantity,  0)                                       AS bid_qty,
          COALESCE(bi.quantity,  0) * COALESCE(bi.unit_cost, 0)::float    AS bid_total,
          bi.start_date,
          bi.target_date
          FROM bid_items bi
         WHERE bi.company_code = ${companyCode}
           AND bi.project_id IN (SELECT id FROM target_projects)
      ),
      daily_per_match AS (
        SELECT
          project_id,
          cost_code,
          COALESCE(sub_code, '') AS sub_code,
          SUM(
            COALESCE(total_cost_override,
              COALESCE(labor_hours, 0) * COALESCE(rate, 0)
              + COALESCE(equip_hours, 0) * COALESCE(equip_unit_cost, 0)
              + COALESCE(material_cost, 0)
            )
          )::float                            AS actual,
          SUM(COALESCE(quantity, 0))::float   AS rqty
          FROM daily_tracking
         WHERE company_code = ${companyCode}
           AND project_id IN (SELECT id FROM target_projects)
           AND project_id <> ''
         GROUP BY project_id, cost_code, COALESCE(sub_code, '')
      ),
      projected_per_item AS (
        SELECT
          bp.project_id,
          bp.bid_total,
          COALESCE(d.actual, 0) AS actual,
          CASE
            WHEN bp.start_date IS NOT NULL
             AND bp.target_date IS NOT NULL
             AND COALESCE(d.actual, 0) > 0
             AND CURRENT_DATE > bp.start_date
             AND bp.target_date > bp.start_date
            THEN GREATEST(
              d.actual,
              d.actual
                * EXTRACT(EPOCH FROM (bp.target_date - bp.start_date))
                / NULLIF(EXTRACT(EPOCH FROM (CURRENT_DATE - bp.start_date)), 0)
            )
            WHEN COALESCE(d.rqty, 0) > 0
            THEN (d.actual / d.rqty) * bp.bid_qty
            ELSE bp.bid_total
          END AS projected
        FROM bid_per_item bp
        LEFT JOIN daily_per_match d
               ON d.project_id = bp.project_id
              AND d.cost_code  = bp.cost_code
              AND d.sub_code   = bp.sub_code
      ),
      project_totals AS (
        SELECT
          project_id,
          SUM(bid_total)::float AS bid,
          SUM(actual)::float    AS actual,
          SUM(projected)::float AS projected
          FROM projected_per_item
         GROUP BY project_id
      )
      SELECT
        tp.id,
        tp.name,
        tp.job_number,
        tp.status,
        tp.contract_amount::float          AS contract,
        tp.pinned,
        COALESCE(pt.bid,       0)::float   AS bid,
        COALESCE(pt.actual,    0)::float   AS actual,
        COALESCE(pt.projected, 0)::float   AS projected
      FROM target_projects tp
      LEFT JOIN project_totals pt ON pt.project_id = tp.id
      ORDER BY tp.pinned DESC NULLS LAST, tp.updated_at DESC NULLS LAST
    `;
  });

  if (!rows || !rows.length) return null;

  const pinnedCount = rows.filter(r => r.pinned).length;
  const recentCount = rows.length - pinnedCount;

  return {
    summary: {
      pinned: pinnedCount,
      recent: recentCount,
      total:  rows.length,
    },
    rows: rows.map(r => {
      const contract  = Number(r.contract)  || 0;
      const bid       = Number(r.bid)       || 0;
      const actual    = Number(r.actual)    || 0;
      const projected = Number(r.projected) || 0;

      const progressPct = bid > 0 ? Math.min(Math.round((actual / bid) * 100), 100) : 0;
      const variance    = bid - actual; // positive = under, negative = over
      const profit      = contract > 0 && projected > 0 ? contract - projected : null;
      const profitPct   = profit != null && contract > 0 ? (profit / contract) * 100 : null;

      return {
        name:        r.name || '(unnamed)',
        jobNumber:   r.job_number || '—',
        division:    'turf', // projects table is effectively turf-only today
        status:      r.status || 'In Progress',
        pinned:      Boolean(r.pinned),
        progressPct,
        contract,
        bid,
        actual,
        variance,
        projected,
        profit,
        profitPct,
      };
    }),
  };
}

// ── Per-project detail (page 3+) ─────────────────────────────────────
// Returns the top 6 active projects with full header info plus
// section blocks (bid items, weekly trucking activity). Quarry and
// dust sections are intentionally omitted until quarry data lands
// and dust gains a project linkage. Each per-project sub-query runs
// in parallel and is independently safe-wrapped.
async function buildProjectDetails(sql, companyCode) {
  const projects = await safeRun('details.list', async () => {
    return await sql`
      SELECT
        p.id,
        p.name,
        p.job_number,
        p.status,
        p.start_date::text       AS start_date,
        p.end_date::text         AS end_date,
        p.contract_amount::float AS contract_amount
      FROM projects p
      WHERE p.company_code = ${companyCode}
        AND LOWER(COALESCE(p.status, '')) NOT IN ('complete', 'closed')
      ORDER BY p.start_date ASC NULLS LAST, p.name ASC
      LIMIT 6
    `;
  });

  if (!projects || !projects.length) return null;

  const detailed = await Promise.all(projects.map(async (p) => {
    const [bidItems, weeks, booked] = await Promise.all([
      safeRun(`details.bid.${p.id}`, async () => {
        return await sql`
          SELECT cost_code, sub_code, description, quantity, unit, status
            FROM bid_items
           WHERE company_code = ${companyCode}
             AND project_id   = ${p.id}
           ORDER BY cost_code, sub_code
           LIMIT 8
        `;
      }),
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
            AND project_id   = ${p.id}
        `;
        return rows[0]?.booked ?? 0;
      }),
    ]);

    return buildDetailObject(p, bidItems, weeks, booked);
  }));

  return detailed.filter(Boolean);
}

function buildDetailObject(p, bidItems, weeks, booked) {
  const startMs = p.start_date ? new Date(p.start_date + 'T00:00:00Z').getTime() : null;
  const endMs   = p.end_date   ? new Date(p.end_date   + 'T00:00:00Z').getTime() : null;
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
    sections.bidItems = {
      color: '#22c55e',
      cols:  ['Item', 'Qty', 'Status'],
      rows:  bidItems.map(b => [
        b.description || b.cost_code || '—',
        b.quantity != null
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

  const status      = String(p.status || 'Active');
  const statusColor =
    status === 'On Hold' ? 'mute' :
    status === 'At Risk' ? 'amber' :
    'green';

  return {
    name:        p.name || '(unnamed)',
    jobNumber:   p.job_number || '—',
    division:    'turf',
    status,
    statusColor,
    start:       fmtDate(p.start_date),
    target:      fmtDate(p.end_date),
    contract:    p.contract_amount != null ? fmtCurrency(p.contract_amount) : '—',
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
         AND source = 'dust'
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

// ── Paving tile ──────────────────────────────────────────────────────
// Paving projects live in JSONB blobs (one per project under
// fct_paving_project_<id>, with an index at fct_paving_projects_index)
// rather than the normalized `projects` table. Daily costs land in
// daily_tracking with division='paving' and project_id matching the
// blob's id. We pull the blobs, count active vs complete, sum bid totals
// from blob.bidItems, then aggregate actuals from daily_tracking and
// derive Cost vs Bid / Projected / Profit the same way buildTurfTile
// does so the two tiles read consistently.
//
// Status taxonomy (paving.html line 5526): 'Complete' | 'Active' |
// 'At Risk' | 'On Hold' | '' — anything not 'Complete' is active.
async function buildPavingTile(sql, companyCode) {
  const blobs = await safeRun('paving.blobs', async () => {
    const idxRow = await sql`
      SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_paving_projects_index`}
    `;
    const idx = idxRow[0]?.value;
    const ids = Array.isArray(idx) ? idx : (Array.isArray(idx?.ids) ? idx.ids : []);
    if (!ids.length) return [];

    const keys = ids.map(id => `${companyCode}:fct_paving_project_${id}`);
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    return rows.map(r => r.value).filter(v => v && typeof v === 'object');
  });
  const projects = Array.isArray(blobs) ? blobs : [];
  const isComplete = p => String(p['status'] || '').toLowerCase() === 'complete';
  const isOnHold   = p => String(p['status'] || '').toLowerCase() === 'on hold';
  const active     = projects.filter(p => !isComplete(p));
  const onHold     = active.filter(isOnHold).length;

  const num = v => {
    if (v == null || v === '') return 0;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const totalContract = active.reduce((s, p) => s + num(p['contract-amount'] || p['revised-amount']), 0);
  const totalBid      = active.reduce((s, p) => {
    const items = Array.isArray(p.bidItems) ? p.bidItems : [];
    return s + items.reduce((a, b) => a + num(b.quantity) * num(b.bid_item_cost || b.unit_cost), 0);
  }, 0);

  const activeIds = active.map(p => p.id).filter(Boolean);
  let totalActual = 0;
  if (activeIds.length) {
    const actualRows = await safeRun('paving.actuals', async () => {
      return await sql`
        SELECT COALESCE(SUM(
          COALESCE(total_cost_override,
            COALESCE(labor_hours, 0) * COALESCE(rate, 0)
            + COALESCE(equip_hours, 0) * COALESCE(equip_unit_cost, 0)
            + COALESCE(material_cost, 0)
          )
        ), 0)::float AS actual
        FROM daily_tracking
        WHERE company_code = ${companyCode}
          AND division     = 'paving'
          AND project_id   = ANY(${activeIds})
      `;
    });
    totalActual = actualRows && actualRows[0] ? Number(actualRows[0].actual) || 0 : 0;
  }

  // Projected: scale actuals by bid burn rate (matches turf logic at the
  // tile aggregate level — finer per-bid-item scaling isn't worth it here
  // since paving bid items don't carry start/target dates).
  const totalProjected = totalBid > 0 && totalActual > 0
    ? Math.max(totalActual, totalBid)
    : (totalBid > 0 ? totalBid : totalActual);

  const cvbFmt = totalBid > 0 ? fmtCostVsBid(totalActual, totalBid) : { text: '—', color: 'mute' };
  const cvbSub = totalBid > 0
    ? (cvbFmt.color === 'red'   ? 'Over bid'
      : cvbFmt.color === 'green' ? 'Under bid'
      : 'On plan')
    : undefined;

  let profitText = '—';
  let profitSub;
  if (totalContract > 0 && totalProjected > 0) {
    const profit = totalContract - totalProjected;
    if (Math.abs(profit) < 1) {
      profitText = '$0';
      profitSub  = 'Break-even';
    } else if (profit > 0) {
      profitText = fmtCurrency(profit);
      profitSub  = `${((profit / totalContract) * 100).toFixed(1)}% margin`;
    } else {
      profitText = `−${fmtCurrency(Math.abs(profit))}`;
      profitSub  = `${(Math.abs(profit / totalContract) * 100).toFixed(1)}% loss`;
    }
  }

  let status, statusKind;
  if (!projects.length) { status = 'No Projects'; statusKind = 'mute'; }
  else if (onHold > 0)  { status = `${onHold} On Hold`; statusKind = 'amber'; }
  else if (totalContract > 0 && totalProjected > totalContract) { status = 'Margin Risk'; statusKind = 'amber'; }
  else                  { status = 'On Track'; statusKind = 'green'; }

  return {
    key: 'paving', name: 'Paving', accent: '#60a5fa',
    status, statusKind,
    kpis: [
      {
        label: 'Active Projects',
        value: String(active.length),
        sub:   onHold > 0 ? `${onHold} on hold` : undefined,
      },
      { label: 'Cost vs Bid', value: cvbFmt.text, sub: cvbSub },
      {
        label: 'Projected',
        value: totalProjected > 0 ? fmtCurrency(totalProjected) : '—',
        sub:   totalContract > 0  ? `vs ${fmtCurrency(totalContract)} contract` : undefined,
      },
      { label: 'Profit', value: profitText, sub: profitSub },
    ].map(k => { if (k.sub === undefined) delete k.sub; return k; }),
  };
}

// ── Quarry tile ──────────────────────────────────────────────────────
// Quarry data lives entirely in JSONB blobs (no normalized tables yet):
//   fct_quarry_sales    → [{ date, locationName, productName, tons, pricePerTon, payment }]
//   fct_quarry_daily    → [{ date, locationName, hours, rate, ... }]
//   fct_quarry_crushing → [{ date, locationName, tons, ... }]
// We compute weekly revenue (sum tons*pricePerTon for the current Sun-anchored
// week) and monthly tons sold, plus the top product and active pit count.
async function buildQuarryTile(sql, companyCode, weekStart, weekEnd) {
  const blob = await safeRun('quarry.sales_blob', async () => {
    const r = await sql`
      SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_sales`}
    `;
    return r[0]?.value;
  });
  const sales = Array.isArray(blob) ? blob : [];

  const monthStartIso = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  })();

  const num = v => {
    if (v == null || v === '') return 0;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
  };

  let revenueWk = 0, tonsMo = 0;
  const productTons = new Map();
  const activePits  = new Set();
  for (const r of sales) {
    if (!r || typeof r !== 'object') continue;
    const date = typeof r.date === 'string' ? r.date : '';
    if (!date) continue;
    const tons  = num(r.tons);
    const price = num(r.pricePerTon);
    if (date >= weekStart && date < weekEnd) revenueWk += tons * price;
    if (date >= monthStartIso) {
      tonsMo += tons;
      const name = String(r.productName || '').trim();
      if (name) productTons.set(name, (productTons.get(name) || 0) + tons);
      const pit = String(r.locationName || '').trim();
      if (pit) activePits.add(pit);
    }
  }

  let topProduct = null, topProductTons = 0;
  for (const [name, t] of productTons) {
    if (t > topProductTons) { topProduct = name; topProductTons = t; }
  }

  const status = sales.length ? 'On Track' : 'No Data';
  const statusKind = sales.length ? 'green' : 'mute';

  return {
    key: 'quarry', name: 'Quarry', accent: '#f97316',
    status, statusKind,
    kpis: [
      { label: 'Revenue · Wk', value: revenueWk > 0 ? fmtCurrency(revenueWk) : '—' },
      { label: 'Tons · Mo',    value: tonsMo > 0 ? Math.round(tonsMo).toLocaleString('en-US') : '—' },
      topProduct
        ? { label: 'Top Product', value: topProduct, sub: `${Math.round(topProductTons).toLocaleString('en-US')} tons` }
        : { label: 'Top Product', value: '—' },
      { label: 'Active Pits',  value: activePits.size > 0 ? String(activePits.size) : '—' },
    ].map(k => { if (k.sub === undefined) delete k.sub; return k; }),
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
          // Mirrors the live Turf tile shape (Active / Cost vs Bid /
          // Projected / Profit) so the fallback layout still reads as
          // intended even when DB is unreachable.
          key: 'turf', name: 'Turf Management', accent: '#22c55e',
          status: 'On Track', statusKind: 'green',
          kpis: [
            { label: 'Active Projects', value: '—' },
            { label: 'Cost vs Bid',     value: '—' },
            { label: 'Projected',       value: '—' },
            { label: 'Profit',          value: '—' },
          ],
        },
        {
          key: 'paving', name: 'Paving', accent: '#60a5fa',
          status: '—', statusKind: 'mute',
          kpis: [
            { label: 'Active Projects', value: '—' },
            { label: 'Cost vs Bid',     value: '—' },
            { label: 'Projected',       value: '—' },
            { label: 'Profit',          value: '—' },
          ],
        },
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

    projects: {
      summary: { pinned: 0, recent: 0, total: 0 },
      rows: [],
    },

    details: [],
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  if (!payload.isPlatformAdmin) {
    return res.status(403).json({ error: 'Executive report is platform admin only' });
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

    // All six division tiles are wired live. A failed builder leaves the
    // mock '—' placeholder for that tile (rather than overwriting it with
    // null) so the grid layout stays intact.
    const liveTiles = await Promise.all([
      buildTurfTile(sql, company, weekStart, weekEnd).catch(e => {
        console.error('[executive/report] turf tile failed:', e.message); return null;
      }),
      buildPavingTile(sql, company).catch(e => {
        console.error('[executive/report] paving tile failed:', e.message); return null;
      }),
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
    const [turfLive, pavingLive, truckingLive, dustLive, quarryLive, icLive] = liveTiles;

    report.snapshot.divisions = report.snapshot.divisions.map(tile => {
      if (tile.key === 'turf'         && turfLive)     return turfLive;
      if (tile.key === 'paving'       && pavingLive)   return pavingLive;
      if (tile.key === 'trucking'     && truckingLive) return truckingLive;
      if (tile.key === 'dust'         && dustLive)     return dustLive;
      if (tile.key === 'quarry'       && quarryLive)   return quarryLive;
      if (tile.key === 'intercompany' && icLive)       return icLive;
      return tile;
    });

    // Active project portfolio (page 2) and per-project detail (page 3+).
    // The builders return null on error or when there are no active
    // projects — both cases leave the mock's empty placeholders, which
    // now contain no fake project entries.
    const [livePortfolio, liveDetails] = await Promise.all([
      buildProjectsPortfolio(sql, company).catch(err => {
        console.error('[executive/report] portfolio build failed:', err.message); return null;
      }),
      buildProjectDetails(sql, company).catch(err => {
        console.error('[executive/report] details build failed:', err.message); return null;
      }),
    ]);
    if (livePortfolio && Array.isArray(livePortfolio.rows)) {
      report.projects = livePortfolio;
    }
    if (Array.isArray(liveDetails)) {
      report.details = liveDetails;
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
