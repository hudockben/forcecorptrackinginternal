'use strict';

// GET /api/executive/report
//
// Cross-division roll-up for the Executive Division dashboard.
// Platform admins only.
//
// First cut: returns mock JSON in the response shape the front-end
// renders against. The shape is what we'll commit to before wiring
// real SQL in a follow-up — division KPI tiles, the active project
// portfolio with cross-division activity overlays, and per-project
// detail blocks.

const { requireAuth } = require('../lib/auth');

function mockReport() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),

    snapshot: {
      hero: [
        { label: 'Active Projects',       value: '14',       delta: '+2 vs last week',   deltaDir: 'up'   },
        { label: 'Revenue · This Week',   value: '$284,510', delta: '+8.4%',             deltaDir: 'up'   },
        { label: 'AR · 30+ Days',         value: '$92,840',  delta: '+$12k vs last week', deltaDir: 'down' },
        { label: 'Unbilled Intercompany', value: '$48,210',  delta: 'flat',              deltaDir: 'flat' },
      ],

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

module.exports = (req, res) => {
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

  return res.json(mockReport());
};
