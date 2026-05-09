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
         AND status IN ('Active', 'At Risk', 'On Hold')
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
      delta:    'Active / At Risk / On Hold',
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
// Pulls each active project's contract, bid, booked, and dates in one query
// and aggregates in JS so the projected-cost extrapolation is easy to read.
//
// Projected cost per project (time-based extrapolation):
//   - if not started yet     → use bid (or contract) as the best estimate
//   - if past target end     → use booked (project ran over its window)
//   - otherwise              → booked / pct_time_elapsed
//
// Profit = SUM(contract) − SUM(projected) across all active projects.
async function buildTurfTile(sql, companyCode /* , weekStart, weekEnd unused */) {
  const rows = await safeRun('turf.projects_financials', async () => {
    return await sql`
      SELECT
        p.id,
        p.status,
        p.contract_amount::float AS contract_amount,
        p.start_date::text       AS start_date,
        p.end_date::text         AS end_date,
        COALESCE(b.bid_total,    0)::float AS bid_total,
        COALESCE(c.booked_total, 0)::float AS booked_total
      FROM projects p
      LEFT JOIN (
        SELECT project_id,
               SUM(COALESCE(quantity, 0) * COALESCE(unit_cost, 0))::float AS bid_total
          FROM bid_items
         WHERE company_code = ${companyCode}
         GROUP BY project_id
      ) b ON b.project_id = p.id
      LEFT JOIN (
        SELECT project_id,
               SUM(
                 COALESCE(total_cost_override,
                   COALESCE(labor_hours, 0) * COALESCE(rate, 0)
                   + COALESCE(equip_hours, 0) * COALESCE(equip_unit_cost, 0)
                   + COALESCE(material_cost, 0)
                 )
               )::float AS booked_total
          FROM daily_tracking
         WHERE company_code = ${companyCode}
           AND project_id IS NOT NULL
           AND project_id <> ''
         GROUP BY project_id
      ) c ON c.project_id = p.id
      WHERE p.company_code = ${companyCode}
        AND p.status IN ('Active', 'At Risk', 'On Hold')
    `;
  });

  if (!rows) return null; // total fail — caller falls back to mock

  const todayMs = Date.now();
  let active = 0;
  let atRisk = 0;
  let totalContract  = 0;
  let totalBid       = 0;
  let totalBooked    = 0;
  let totalProjected = 0;

  for (const r of rows) {
    active += 1;
    if (r.status === 'At Risk') atRisk += 1;

    const contract = Number(r.contract_amount) || 0;
    const bid      = Number(r.bid_total)       || 0;
    const booked   = Number(r.booked_total)    || 0;

    totalContract += contract;
    totalBid      += bid;
    totalBooked   += booked;

    const startMs = r.start_date ? new Date(r.start_date + 'T00:00:00Z').getTime() : null;
    const endMs   = r.end_date   ? new Date(r.end_date   + 'T00:00:00Z').getTime() : null;

    let projected;
    if (startMs && endMs && endMs > startMs) {
      if (todayMs <= startMs) {
        projected = bid > 0 ? bid : contract;
      } else if (todayMs >= endMs) {
        projected = booked > 0 ? booked : (bid || contract);
      } else {
        const pctTime = (todayMs - startMs) / (endMs - startMs);
        projected = pctTime > 0 && booked > 0 ? booked / pctTime : (bid || contract);
      }
    } else {
      projected = bid > 0 ? bid : contract;
    }
    totalProjected += projected;
  }

  // Cost vs Bid (aggregate)
  const cvbFmt = totalBid > 0
    ? fmtCostVsBid(totalBooked, totalBid)
    : { text: '—', color: 'mute' };
  const cvbSub = totalBid > 0
    ? (cvbFmt.color === 'red'   ? 'Over bid'
      : cvbFmt.color === 'green' ? 'Under bid'
      : 'On plan')
    : undefined;

  // Profit text
  let profitText = '—';
  let profitSub  = undefined;
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

  // Status pill: amber if any At Risk OR projected loss, otherwise green.
  let status, statusKind;
  if (atRisk > 0) {
    status = `${atRisk} At Risk`;
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
        value: String(active),
        sub:   atRisk > 0 ? `${atRisk} at risk` : undefined,
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
           AND (status IN ('Active', 'At Risk', 'On Hold', 'In Progress')
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
        AND p.status IN ('Active', 'At Risk', 'On Hold')
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
          key: 'turf', name: 'Turf Management', accent: '#22c55e',
          status: 'On Track', statusKind: 'green',
          kpis: [
            { label: 'Active Projects', value: '5',    sub: '1 at risk' },
            { label: 'Cost vs Bid',     value: '+2.1%', sub: 'Slightly over' },
            { label: 'Labor Hrs · Wk',  value: '412' },
            { label: 'Equipment Hrs',   value: '186' },
          ],
        },
        {
          // Mirrors the live Turf tile shape (Active / Cost vs Bid /
          // Projected / Profit) so the row pairs visually. Wired up
          // when paving project data normalizes out of its JSONB blob.
          key: 'paving', name: 'Paving', accent: '#60a5fa',
          status: 'Data Pending', statusKind: 'mute',
          kpis: [
            { label: 'Active Projects', value: '—', sub: 'awaiting normalization' },
            { label: 'Cost vs Bid',     value: '—' },
            { label: 'Projected',       value: '—' },
            { label: 'Profit',          value: '—' },
          ],
        },
        {
          key: 'trucking', name: 'Trucking', accent: '#ef4444',
          status: 'On Track', statusKind: 'green',
          kpis: [
            { label: 'Active Hauls',  value: '28' },
            { label: 'Loads · Wk',    value: '312' },
            { label: 'Invoiced · Wk', value: '$74,200' },
            { label: 'Unbilled',      value: '$18,400', sub: '12 entries' },
          ],
        },
        {
          key: 'dust', name: 'Dust Control', accent: '#fbbf24',
          status: 'On Track', statusKind: 'green',
          kpis: [
            { label: 'Active Routes',        value: '9' },
            { label: 'Gallons · Wk',         value: '42,180' },
            { label: 'AR · 60+ Days',        value: '$8,420' },
            { label: 'CM Approval Pending',  value: '3' },
          ],
        },
        {
          key: 'quarry', name: 'Quarry', accent: '#f97316',
          status: 'Data Loading', statusKind: 'mute',
          kpis: [
            { label: 'Inventory · Top SKU', value: '— ton', sub: 'awaiting upload' },
            { label: 'Production · Wk',     value: '—' },
            { label: 'Avg $/ton',           value: '—' },
            { label: 'Active Pits',         value: '—' },
          ],
        },
        {
          key: 'intercompany', name: 'Intercompany Billing', accent: '#a78bfa',
          status: 'Aging', statusKind: 'amber',
          kpis: [
            { label: 'Unbilled · Trucking', value: '$28,400' },
            { label: 'Unbilled · Dust',     value: '$19,810' },
            { label: 'AR 30+ Days',         value: '$92,840' },
            { label: 'Top Customer',        value: 'Acme Aggregates', sub: '$31,200 outstanding', small: true },
          ],
        },
      ],
    },

    projects: {
      summary: { pinned: 0, recent: 0, total: 0 },
      rows: [],
    },

    details: [
      {
        name: 'Riverbend Industrial Park',
        jobNumber: 'P-2406',
        division: 'paving',
        status: 'Active',
        statusColor: 'green',
        start: 'Feb 14, 2026',
        target: 'Jul 30, 2026',
        contract: '$842,000',
        bookedCost: '$486,210',
        pctComplete: '58%',
        sections: {
          bidItems: {
            color: '#60a5fa',
            cols: ['Item', 'Qty', '% Done'],
            rows: [
              ['Mill & Overlay', '12,400 SY', '72%'],
              ['Base Repair',    '3,200 SY',  '48%'],
              ['Striping',       '8,100 LF',  '12%'],
              ['Concrete Curb',  '1,840 LF',  '88%'],
            ],
          },
          trucking: {
            color: '#ef4444',
            cols: ['Week', 'Loads', 'Hours', '$'],
            rows: [
              ['Apr 27',        '42',  '68',  '$5,840'],
              ['May 4',         '38',  '61',  '$5,210'],
              ['Total to date', '186', '298', '$24,600'],
            ],
          },
          quarry: {
            color: '#f97316',
            cols: ['Material', 'Source Pit', 'Tons'],
            rows: [
              ['#57 Limestone', 'Pit 3 — Hollidaysburg', '540'],
              ['2A Modified',   'Pit 1 — Altoona',       '280'],
              ['Surge',         'Pit 3 — Hollidaysburg', '100'],
            ],
          },
          dust: {
            color: '#fbbf24',
            cols: ['Date', 'Location', 'Gallons'],
            rows: [
              ['Apr 18',        'Haul road N', '2,100'],
              ['Apr 30',        'Haul road N', '1,950'],
              ['Total to date', '',            '4,050'],
            ],
          },
        },
      },
      {
        name: 'Cedar Park Athletics — Sod & Drainage',
        jobNumber: 'T-2403',
        division: 'turf',
        status: 'Active',
        statusColor: 'green',
        start: 'Jan 22, 2026',
        target: 'Jun 12, 2026',
        contract: '$318,400',
        bookedCost: '$198,720',
        pctComplete: '63%',
        sections: {
          bidItems: {
            color: '#22c55e',
            cols: ['Item', 'Qty', '% Done'],
            rows: [
              ['Sod Installation', '42,000 SF', '81%'],
              ['French Drain',     '680 LF',    '95%'],
              ['Topsoil',          '340 CY',    '52%'],
            ],
          },
          trucking: {
            color: '#ef4444',
            cols: ['Week', 'Loads', '$'],
            rows: [
              ['Apr 27',        '22', '$2,840'],
              ['May 4',         '18', '$2,310'],
              ['Total to date', '94', '$11,800'],
            ],
          },
        },
      },
    ],
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

    // Division tiles: turf, trucking, dust, intercompany are wired live.
    // Paving and quarry preserve their mock entries (data shape pending).
    const liveTiles = await Promise.all([
      buildTurfTile(sql, company, weekStart, weekEnd).catch(e => {
        console.error('[executive/report] turf tile failed:', e.message);
        return null;
      }),
      buildTruckingTile(sql, company, weekStart, weekEnd).catch(e => {
        console.error('[executive/report] trucking tile failed:', e.message);
        return null;
      }),
      buildDustTile(sql, company, weekStart, weekEnd).catch(e => {
        console.error('[executive/report] dust tile failed:', e.message);
        return null;
      }),
      buildIntercompanyTile(sql, company).catch(e => {
        console.error('[executive/report] intercompany tile failed:', e.message);
        return null;
      }),
    ]);
    const [turfLive, truckingLive, dustLive, icLive] = liveTiles;

    // Replace tiles in place, preserving order & any failed tile's mock.
    report.snapshot.divisions = report.snapshot.divisions.map(tile => {
      if (tile.key === 'turf'         && turfLive)     return turfLive;
      if (tile.key === 'trucking'     && truckingLive) return truckingLive;
      if (tile.key === 'dust'         && dustLive)     return dustLive;
      if (tile.key === 'intercompany' && icLive)       return icLive;
      return tile;
    });

    // Active project portfolio (page 2) and per-project detail (page 3+).
    // Both run in parallel; either falling back to mock on error keeps
    // the page rendering even if one query has issues.
    const [livePortfolio, liveDetails] = await Promise.all([
      buildProjectsPortfolio(sql, company).catch(err => {
        console.error('[executive/report] portfolio build failed:', err.message);
        return null;
      }),
      buildProjectDetails(sql, company).catch(err => {
        console.error('[executive/report] details build failed:', err.message);
        return null;
      }),
    ]);
    if (livePortfolio && Array.isArray(livePortfolio.rows) && livePortfolio.rows.length) {
      report.projects = livePortfolio;
    }
    if (Array.isArray(liveDetails) && liveDetails.length) {
      report.details = liveDetails;
    }
  }

  report.generatedAt = new Date().toISOString();
  return res.json(report);
};
