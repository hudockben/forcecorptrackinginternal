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

async function buildTurfTile(sql, companyCode, weekStart, weekEnd) {
  const active = await safeRun('turf.active', async () => {
    const rows = await sql`
      SELECT COUNT(*)::int AS n
        FROM projects
       WHERE company_code = ${companyCode}
         AND status IN ('Active', 'At Risk', 'On Hold')
    `;
    return rows[0]?.n ?? 0;
  });
  const atRisk = await safeRun('turf.at_risk', async () => {
    const rows = await sql`
      SELECT COUNT(*)::int AS n
        FROM projects
       WHERE company_code = ${companyCode}
         AND status = 'At Risk'
    `;
    return rows[0]?.n ?? 0;
  });
  const laborHrs = await safeRun('turf.labor_hrs', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(labor_hours), 0)::float AS v
        FROM daily_tracking
       WHERE company_code = ${companyCode}
         AND division = 'turf'
         AND date >= ${weekStart}
         AND date <  ${weekEnd}
    `;
    return rows[0]?.v ?? 0;
  });
  const equipHrs = await safeRun('turf.equip_hrs', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(equip_hours), 0)::float AS v
        FROM daily_tracking
       WHERE company_code = ${companyCode}
         AND division = 'turf'
         AND date >= ${weekStart}
         AND date <  ${weekEnd}
    `;
    return rows[0]?.v ?? 0;
  });

  return {
    key: 'turf', name: 'Turf Management', accent: '#22c55e',
    status: atRisk > 0 ? `${atRisk} At Risk` : 'On Track',
    statusKind: atRisk > 0 ? 'amber' : 'green',
    kpis: [
      {
        label: 'Active Projects',
        value: active != null ? String(active) : '—',
        sub:   atRisk > 0 ? `${atRisk} at risk` : null,
      },
      { label: 'Labor Hrs · Wk',  value: laborHrs != null ? String(Math.round(laborHrs))  : '—' },
      { label: 'Equipment Hrs',   value: equipHrs != null ? String(Math.round(equipHrs))  : '—' },
      { label: 'Cost vs Bid',     value: '—', sub: 'pending wiring' },
    ].filter(k => !(k.sub === null)).map(k => { if (k.sub === null) delete k.sub; return k; }),
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

async function buildDustTile(sql, companyCode, weekStart, weekEnd) {
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
  const ar60 = await safeRun('dust.ar_60', async () => {
    const rows = await sql`
      SELECT COALESCE(SUM(total), 0)::float AS v
        FROM intercompany_billing_entries
       WHERE company_code = ${companyCode}
         AND source = 'dust'
         AND invoice_sent_date IS NOT NULL
         AND invoice_sent_date < (CURRENT_DATE - INTERVAL '60 days')
         AND date_paid IS NULL
         AND (invoice_status IS NULL OR LOWER(invoice_status) NOT LIKE 'paid%')
    `;
    return rows[0]?.v ?? 0;
  });
  const cmPending = await safeRun('dust.cm_pending', async () => {
    const rows = await sql`
      SELECT COUNT(*)::int AS n
        FROM dust_control_entries
       WHERE company_code = ${companyCode}
         AND date >= (CURRENT_DATE - INTERVAL '30 days')
         AND (cm_approval IS NULL OR TRIM(cm_approval) = '')
    `;
    return rows[0]?.n ?? 0;
  });

  return {
    key: 'dust', name: 'Dust Control', accent: '#fbbf24',
    status: cmPending > 0 ? `${cmPending} CM Pending` : 'On Track',
    statusKind: cmPending > 0 ? 'amber' : 'green',
    kpis: [
      { label: 'Active Routes',       value: activeRoutes != null ? String(activeRoutes) : '—' },
      { label: 'Gallons · Wk',        value: gallonsWk    != null ? Math.round(gallonsWk).toLocaleString('en-US') : '—' },
      { label: 'AR · 60+ Days',       value: ar60         != null ? fmtCurrency(ar60)    : '—' },
      { label: 'CM Approval Pending', value: cmPending    != null ? String(cmPending)    : '—' },
    ],
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
          key: 'paving', name: 'Paving', accent: '#60a5fa',
          status: '1 At Risk', statusKind: 'amber',
          kpis: [
            { label: 'Active Projects',  value: '4',     sub: '1 on hold' },
            { label: 'Tons Placed · Wk', value: '1,840' },
            { label: 'Material $/ton',   value: '$78.40', sub: 'vs $76 budget' },
            { label: 'Schedule Var',     value: '+3 days' },
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

    projects: [
      {
        name: 'Riverbend Industrial Park',
        jobNumber: 'P-2406',
        division: 'paving',
        status: 'Active',
        bar: { leftPct: 12, widthPct: 55, kind: 'paving', progressPct: 32, todayPct: 44 },
        icons: [
          { kind: 't', leftPct: 22 },
          { kind: 'q', leftPct: 35 },
        ],
        mini: [
          { label: '% Complete',  value: '58%' },
          { label: 'Trucking $',  value: '$24,600' },
          { label: 'Quarry tons', value: '920' },
          { label: 'Cost vs Bid', value: '−1.2%', color: 'green' },
        ],
      },
      {
        name: 'Maple Heights Resurface',
        jobNumber: 'P-2411',
        division: 'paving',
        status: 'At Risk',
        bar: { leftPct: 28, widthPct: 30, kind: 'atrisk', progressPct: 12, todayPct: 44 },
        icons: [{ kind: 't', leftPct: 33 }],
        mini: [
          { label: '% Complete',  value: '40%' },
          { label: 'Trucking $',  value: '$8,200' },
          { label: 'Quarry tons', value: '280' },
          { label: 'Cost vs Bid', value: '+6.8%', color: 'red' },
        ],
      },
      {
        name: 'Brookline Commons Lot',
        jobNumber: 'P-2418',
        division: 'paving',
        status: 'Active',
        bar: { leftPct: 38, widthPct: 40, kind: 'paving', progressPct: 8, todayPct: 44 },
        icons: [{ kind: 'd', leftPct: 41 }],
        mini: [
          { label: '% Complete',  value: '15%' },
          { label: 'Trucking $',  value: '$3,400' },
          { label: 'Dust passes', value: '2' },
          { label: 'Cost vs Bid', value: 'on plan', color: 'mute' },
        ],
      },
      {
        name: 'Cedar Park Athletics — Sod & Drainage',
        jobNumber: 'T-2403',
        division: 'turf',
        status: 'Active',
        bar: { leftPct: 5, widthPct: 60, kind: 'turf', progressPct: 38, todayPct: 44 },
        icons: [{ kind: 't', leftPct: 18 }],
        mini: [
          { label: '% Complete',  value: '63%' },
          { label: 'Trucking $',  value: '$11,800' },
          { label: 'Labor hrs',   value: '684' },
          { label: 'Cost vs Bid', value: '−0.4%', color: 'green' },
        ],
      },
      {
        name: 'Westgate Logistics Phase 2',
        jobNumber: 'P-2421',
        division: 'paving',
        status: 'On Hold',
        bar: { leftPct: 50, widthPct: 35, kind: 'hold', progressPct: 0, todayPct: 44 },
        icons: [],
        mini: [
          { label: '% Complete',  value: '0%' },
          { label: 'Trucking $',  value: '$0' },
          { label: 'Hold reason', value: 'Permit' },
          { label: 'Cost vs Bid', value: '—', color: 'mute' },
        ],
      },
    ],

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
  }

  report.generatedAt = new Date().toISOString();
  return res.json(report);
};
