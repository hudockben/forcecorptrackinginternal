'use strict';
/**
 * Local test for /api/executive/report.
 * Mocks DB and auth, runs the handler against fake-but-realistic data
 * shaped like the user's production blobs (dashed-key fields, mixed
 * statuses, pinned flags, On Hold, Complete, etc.), captures every SQL
 * string, and asserts the response shape.
 *
 * Run:  node scripts/test-executive-report.js
 */

const path = require('path');

const COMPANY = 'TEST_CO';
const queries = [];

// Turf project blobs — shape that tracker.html persists (dashed keys for
// the fields, bidItems with cost_code / sub_code / quantity / unit_cost).
const FAKE_TURF = [
  {
    id: 'p1',
    'project-name':    'Franklin Regional Tennis Court',
    'job-number':      '26049',
    'status':          'In Progress',
    'contract-amount': '479312.32',
    'start-date':      '2026-03-01',
    'end-date':        '2026-09-15',
    'client':          'Franklin Regional SD',
    'pm':              'George Oakes',
    prevailing_wage:   true,
    pinned:            true,
    bidItems: [
      { id: 'bi-p1-01', cost_code: '01', sub_code: '',  quantity: 1, unit_cost: 375931.05, description: 'Sitework', unit: 'LS', status: 'Active' },
    ],
  },
  {
    id: 'p2',
    'project-name': 'Hildebrand', 'job-number': '26045', 'status': 'In Progress',
    'contract-amount': '', 'start-date': '2026-02-15', 'end-date': '2026-08-01',
    pinned: true, bidItems: [],
  },
  {
    id: 'p3',
    'project-name': 'Adams TWP LL', 'job-number': '26034', 'status': 'In Progress',
    'contract-amount': '190086.60', 'start-date': '2026-01-15', 'end-date': '2026-06-15',
    pinned: true,
    bidItems: [
      { id: 'bi-p3-02a', cost_code: '02', sub_code: 'a', quantity: 100, unit_cost: 1000,    description: 'Excavation', unit: 'CY', status: 'Active' },
      { id: 'bi-p3-02b', cost_code: '02', sub_code: 'b', quantity: 50,  unit_cost: 500,     description: 'Backfill',   unit: 'CY', status: 'Active' },
      { id: 'bi-p3-03',  cost_code: '03', sub_code: '',  quantity: 1,   unit_cost: 26641.89, description: 'Misc',      unit: 'LS', status: 'Active' },
    ],
  },
  {
    id: 'p4',
    'project-name': 'Empty Status Project', 'job-number': '26040', 'status': '',
    'contract-amount': '100000', 'start-date': '2026-04-01', 'end-date': '2026-12-01',
    pinned: false, bidItems: [],
  },
  {
    id: 'p5',
    'project-name': 'On Hold Project', 'job-number': '26050', 'status': 'On Hold',
    'contract-amount': '50000', 'start-date': '2026-03-01', 'end-date': '2026-07-01',
    pinned: false, bidItems: [],
  },
  {
    // Finished with spend behind it — the only shape that can contribute to
    // Total Actual Profit (contract $200k − actual $150k = $50k).
    id: 'p6',
    'project-name': 'Done Project', 'job-number': '26020', 'status': 'Complete',
    'contract-amount': '200000', 'start-date': '2025-01-01', 'end-date': '2025-12-01',
    pinned: false,
    bidItems: [
      { id: 'bi-p6-01', cost_code: '09', sub_code: '', quantity: 1, unit_cost: 160000, description: 'Build', unit: 'LS', status: 'Active' },
    ],
  },
  {
    // Won, not started: feeds Awarded Backlog. Its bid line carries a change
    // order, so its bid budget is (100 + 20) × $500 = $60,000, not $50,000.
    id: 'p7',
    'project-name': 'Juniata College Baseball', 'job-number': '26053', 'status': 'Awarded',
    'contract-amount': '75000', 'start-date': '2026-06-01', 'end-date': '2026-11-01',
    'pm': 'Allen Strick',
    pinned: false,
    bidItems: [
      {
        id: 'bi-p7-01', cost_code: '05', sub_code: '', quantity: 100, unit_cost: 500,
        description: 'Field', unit: 'SY', status: 'Active',
        change_orders: [{ id: 'co-1', date: '2026-06-15', qty_delta: 20, note: 'added infield' }],
      },
    ],
  },
];

// Turf daily_tracking actuals — only Adams TWP LL has costs; the executive
// query groups by project_id + cost_code + sub_code.
const FAKE_TURF_DAILY = [
  { project_id: 'p3', cost_code: '02', sub_code: 'a', actual:  5000, rqty: 70 },
  { project_id: 'p3', cost_code: '02', sub_code: 'b', actual:  2500, rqty: 30 },
  { project_id: 'p3', cost_code: '03', sub_code: '',  actual: 98289.27, rqty: 1 },
  { project_id: 'p6', cost_code: '09', sub_code: '',  actual: 150000, rqty: 1 },
];

// Two paving projects in app_data blob storage. pv1 active w/ bid + actual,
// pv2 marked Complete so it's filtered out.
const FAKE_PAVING = [
  {
    id: 'pv1', 'project-name': 'Main St Mill & Overlay', 'job-number': 'P-26001',
    status: 'Active', 'contract-amount': '420000',
    bidItems: [
      { id: 'bi-pv1-01', cost_code: '01', sub_code: '', quantity: 1000, bid_item_cost: 75 },
      { id: 'bi-pv1-02', cost_code: '02', sub_code: '', quantity: 500,  bid_item_cost: 50 },
    ],
  },
  {
    id: 'pv2', 'project-name': 'Closed Lot', 'job-number': 'P-26002',
    status: 'Complete', 'contract-amount': '90000', bidItems: [],
  },
];
// Paving actuals — single bid item match to verify the GROUP BY return shape.
const FAKE_PAVING_DAILY = [
  { project_id: 'pv1', cost_code: '01', sub_code: '', actual: 30000, rqty: 600 },
  { project_id: 'pv1', cost_code: '02', sub_code: '', actual: 12000, rqty: 200 },
];

// One kiewit project so the third portfolio section has live numbers.
const FAKE_KIEWIT = [
  {
    id: 'kw1', 'project-name': 'Pinetree Pads 12–18', 'job-number': '26061',
    status: 'In Progress', 'contract-amount': '310000', 'pm': 'Allen Strick',
    pinned: true,
    bidItems: [
      { id: 'bi-kw1-01', cost_code: '01', sub_code: '', quantity: 18, unit_cost: 10000 },
    ],
  },
];
const FAKE_KIEWIT_DAILY = [
  { project_id: 'kw1', cost_code: '01', sub_code: '', actual: 90000, rqty: 9 },
];

// ── Quarry blobs ──
// Two pits with round numbers so every derived figure can be checked by hand.
// Altoona: 35 tons sold at $18 = $630; McGees: 15 t at $22 = $330.
const todayIso  = new Date().toISOString().slice(0, 10);
const thisMonth = todayIso.slice(0, 7);
const FAKE_QUARRY_SALES = [
  { date: todayIso, locationName: 'Pit 1 — Altoona',       productName: '#57 Limestone', tons: 25, pricePerTon: 18 },
  { date: todayIso, locationName: 'Pit 3 — Hollidaysburg', productName: '2A Modified',   tons: 15, pricePerTon: 22 },
  { date: todayIso, locationName: 'Pit 1 — Altoona',       productName: '#57 Limestone', tons: 10, pricePerTon: 18 },
];
// Daily: Altoona 10h × $50 = $500 labour, 20 gal × $4 = $80 fuel → $580.
const FAKE_QUARRY_DAILY = [
  { date: todayIso, locationName: 'Pit 1 — Altoona', hours: 10, rate: 50, fuelGallons: 20, ppg: 4 },
];
// Crushing: Altoona 8h × $90 = $720 payroll, 30 gal × $5 = $150 fuel → $870,
// and 10 loads × 20 t = 200 tons to the crusher over 8 crushing hours.
const FAKE_QUARRY_CRUSH = [
  {
    date: todayIso, locationName: 'Pit 1 — Altoona',
    hourlyRate: 90, hours: 8, fuelGallons: 30, fuelCost: 5,
    loadsToCrusher: 10, tonsPerLoad: 20, hoursCrushing: 8,
  },
];
// Opening count of 100 tons at Altoona, taken before the rows above.
const FAKE_QUARRY_INVENTORY = {
  basis: 'final',
  openings: [{ locationName: 'Pit 1 — Altoona', productName: '#57 Limestone', tons: 100, asOf: '2026-01-01' }],
  adjustments: [],
};
// 10% jaws→screen loss at Altoona: 200 tons crushed → 180 sellable.
const FAKE_QUARRY_LOSS = { 'Pit 1 — Altoona': 10 };
const FAKE_QUARRY_FIXED = { 'Pit 1 — Altoona': { [thisMonth]: 1000 } };
const FAKE_QUARRY_ROYALTY = { 'Pit 1 — Altoona': [{ name: 'Landowner', rate: 10, floor: 0 }] };
const FAKE_QUARRY_LISTS = { product: [{ id: 'pr1', name: '#57 Limestone', royalty: true }] };

// ── Dust Control rows ──
// Three jobs: two for Acme (one paid, one long overdue), one for Borough.
// Acme has its own UB rate of $2/gal; Borough falls back to the $1.50 default.
const FAKE_DUST_ROWS = [
  {
    date: `${todayIso.slice(0, 4)}-03-02`, company: 'Acme Aggregates', location: 'Route 22', state: 'PA',
    start_time: '07:00', end_time: '15:00',          // 8 hours
    v1_rate: 100, v2_rate: 50, gallons_ub: 500,      // 8×150 = 1200 + 500×2 = 1000 → $2,200
    inv_sent: `${todayIso.slice(0, 4)}-03-05`, inv_received: `${todayIso.slice(0, 4)}-03-20`, inv_status: 'paid',
  },
  {
    date: `${todayIso.slice(0, 4)}-03-09`, company: 'Acme Aggregates', location: 'Route 22', state: 'PA',
    start_time: '08:00', end_time: '12:00',          // 4 hours
    v1_rate: 100, v2_rate: 0, gallons_ub: 200,       // 4×100 = 400 + 200×2 = 400 → $800
    inv_sent: null, inv_received: null, inv_status: null,
  },
  {
    date: `${todayIso.slice(0, 4)}-04-01`, company: 'Cresson Borough', location: 'Main St', state: 'WV',
    start_time: '22:00', end_time: '02:00',          // overnight: 4 hours
    v1_rate: 80, v2_rate: 0, gallons_ub: 100,       // 4×80 = 320 + 100×1.5 = 150 → $470
    inv_sent: null, inv_received: null, inv_status: null,
  },
];
const FAKE_DUST_COMPANIES = [{ name: 'Acme Aggregates', ub_rate: 2 }];
const FAKE_DUST_UB_RATE = 1.5;

// ── Trucking: the fct_truck_division blob, the source the page reads ──
// Revenue is total_hours × haul_fee, so these are exact:
//   Kiewit  8h × $120 = $960 (paid) + 6h × $120 = $720 (invoiced, unpaid)
//   Hanson  4h × $110 = $440 (not invoiced)
// Total 18 hours, $2,120, over 3 hauls in 2026.
const FAKE_TRUCK_DIVISION = [
  {
    id: 'td1', actual_date: '2026-03-04', task_number: 'T-1', driver: 'R. Kelso', unit: '304',
    customer: 'Kiewit', total_hours: 8, haul_fee: 120,
    invoice_sent_date: '2026-03-10', date_paid: '2026-03-25',
  },
  {
    id: 'td2', actual_date: '2026-03-11', task_number: 'T-2', driver: 'R. Kelso', unit: '307',
    customer: 'Kiewit', total_hours: 6, haul_fee: 120,
    invoice_sent_date: '2026-03-20', date_paid: null,
  },
  {
    id: 'td3', actual_date: '2026-04-02', task_number: 'T-3', driver: 'D. Yost', unit: '304',
    customer: 'Hanson', total_hours: 4, haul_fee: 110,
    invoice_sent_date: null, date_paid: null,
  },
  // Prior year, so it feeds only the year-over-year comparison: 10h × $100.
  { id: 'td0', actual_date: '2025-06-01', driver: 'R. Kelso', unit: '304',
    customer: 'Kiewit', total_hours: 10, haul_fee: 100 },
];

// ── Intercompany: the fct_intercompany_billing_entries blob ──
// The truck rate is $130/hr from the rates blob; dust bills v1 + v2 + gallons at
// the customer's UB rate ($2 for Acme via dust_companies).
//   ic1 trucking  8h × $130 = $1,040 IC, $960 customer   (paid)
//   ic2 trucking  6h × $130 =   $780 IC, $720 customer   (sent, unpaid)
//   ic3 dust      $1,200 + $0 + 500 gal × $2 = $2,200 IC (not invoiced)
//   ic4 flat-total dust-other-billing → its own total, $450 (paid)
// ic2dup re-sends ic2 with a later sent_at, so the dedup must drop the original
// rather than bill the hours twice.
const FAKE_IC_BILLING = [
  {
    id: 'ic1', source: 'trucking', source_id: 'td1', company_name: 'Kiewit',
    actual_date: '2026-03-04', actual_start: '06:00', total_hours: 8, total: 960,
    sent_at: '2026-03-05T10:00:00Z',
    invoice_sent_date: '2026-03-10', payment_received_date: '2026-03-25',
  },
  {
    id: 'ic2', source: 'trucking', source_id: 'td2', company_name: 'Kiewit',
    actual_date: '2026-03-11', actual_start: '06:00', total_hours: 6, total: 720,
    sent_at: '2026-03-12T10:00:00Z',
    invoice_sent_date: '2026-03-20', payment_received_date: null,
  },
  {
    // Same (source, source_id) as ic2 — a re-send. Deduped away.
    id: 'ic2dup', source: 'trucking', source_id: 'td2', company_name: 'Kiewit',
    actual_date: '2026-03-11', actual_start: '06:00', total_hours: 6, total: 720,
    sent_at: '2026-03-13T10:00:00Z',
    invoice_sent_date: '2026-03-20', payment_received_date: null,
  },
  {
    id: 'ic3', source: 'dust', source_id: 'dust-1', company_name: 'Acme Aggregates',
    actual_date: '2026-03-02', location: 'Route 22', vehicle1: 'DT-1',
    total_hours: 8, total: 2200, v1_total: 1200, v2_total: 0, gallons_ub: 500,
    sent_at: '2026-03-03T10:00:00Z',
    invoice_sent_date: null, payment_received_date: null,
  },
  {
    id: 'ic4', source: 'dust-other-billing', company_name: 'Acme Aggregates',
    actual_date: '2026-05-01', total: 450, total_hours: 0,
    invoice_sent_date: '2026-05-05', payment_received_date: '2026-05-20',
  },
];
const FAKE_IC_RATES = { truck: 130 };

// ── Timesheet entries for the payroll section ──
// p1 (Franklin Regional Tennis Court) is flagged prevailing wage below; p3 is
// not, and the dust job has no prevailing-wage concept at all.
//   Strick: 8h work + 1h travel on the prevailing job (approved)
//         + 6h work + 0.5h travel on a non-prevailing job (approved)
//   Oakes:  4h work + 2h travel on the prevailing job (submitted → pending)
//         + a submitted time-off day and an approved one
const FAKE_TIMESHEET = [
  {
    user_id: 1, username: 'A. Strick', entry_type: 'daily', status: 'approved',
    division: 'turf', job_id: 'p1', work_date: '2026-08-10',
    computed_hours: 8, travel_hours: 1, travel_to_site_hours: 0.5, travel_to_shop_hours: 0.5,
  },
  {
    user_id: 1, username: 'A. Strick', entry_type: 'daily', status: 'approved',
    division: 'turf', job_id: 'p3', work_date: '2026-08-11',
    computed_hours: 6, travel_hours: 0.5, travel_to_site_hours: 0.5, travel_to_shop_hours: 0,
  },
  {
    user_id: 2, username: 'G. Oakes', entry_type: 'daily', status: 'submitted',
    division: 'turf', job_id: 'p1', work_date: '2026-08-10',
    computed_hours: 4, travel_hours: 2, travel_to_site_hours: 1, travel_to_shop_hours: 1,
  },
  {
    // Two entries on one date must still count as one day worked.
    user_id: 2, username: 'G. Oakes', entry_type: 'daily', status: 'submitted',
    division: 'dust', job_id: 'Acme Aggregates', work_date: '2026-08-10',
    computed_hours: 2, travel_hours: 0, travel_to_site_hours: 0, travel_to_shop_hours: 0,
  },
  { user_id: 2, username: 'G. Oakes', entry_type: 'time_off', status: 'submitted', work_date: '2026-08-12' },
  { user_id: 2, username: 'G. Oakes', entry_type: 'time_off', status: 'approved',  work_date: '2026-08-13' },
];

const DAILY_BY_DIVISION = {
  turf:   FAKE_TURF_DAILY,
  paving: FAKE_PAVING_DAILY,
  kiewit: FAKE_KIEWIT_DAILY,
};

function fakeSql(strings, ...values) {
  let q = strings[0];
  values.forEach((v, i) => { q += `$${i + 1}` + strings[i + 1]; });
  const compact = q.replace(/\s+/g, ' ').trim();
  queries.push({ sql: compact, values });
  const lower = compact.toLowerCase();

  // app_data SELECT value WHERE key = $1
  if (lower.startsWith('select value from app_data where key =')) {
    const key = values[0];
    if (key === `${COMPANY}:fct_projects_index`) {
      return Promise.resolve([{ value: { ids: FAKE_TURF.map(p => p.id) } }]);
    }
    if (key === `${COMPANY}:fct_paving_projects_index`) {
      return Promise.resolve([{ value: { ids: FAKE_PAVING.map(p => p.id) } }]);
    }
    if (key === `${COMPANY}:fct_kiewit_projects_index`) {
      return Promise.resolve([{ value: { ids: FAKE_KIEWIT.map(p => p.id) } }]);
    }
    if (key === `${COMPANY}:fct_truck_division`) {
      return Promise.resolve([{ value: FAKE_TRUCK_DIVISION }]);
    }
    if (key === `${COMPANY}:fct_intercompany_billing_entries`) {
      return Promise.resolve([{ value: FAKE_IC_BILLING }]);
    }
    if (key === `${COMPANY}:fct_intercompany_rates`) {
      return Promise.resolve([{ value: FAKE_IC_RATES }]);
    }
    const QUARRY_BLOBS = {
      [`${COMPANY}:fct_quarry_sales`]:         FAKE_QUARRY_SALES,
      [`${COMPANY}:fct_quarry_daily`]:         FAKE_QUARRY_DAILY,
      [`${COMPANY}:fct_quarry_crushing`]:      FAKE_QUARRY_CRUSH,
      [`${COMPANY}:fct_quarry_inventory`]:     FAKE_QUARRY_INVENTORY,
      [`${COMPANY}:fct_quarry_loss_pct`]:      FAKE_QUARRY_LOSS,
      [`${COMPANY}:fct_quarry_monthly_fixed`]: FAKE_QUARRY_FIXED,
      [`${COMPANY}:fct_quarry_royalty`]:       FAKE_QUARRY_ROYALTY,
      [`${COMPANY}:fct_quarry_lists`]:         FAKE_QUARRY_LISTS,
    };
    if (key in QUARRY_BLOBS) return Promise.resolve([{ value: QUARRY_BLOBS[key] }]);
    return Promise.resolve([]);
  }

  // app_data batch fetch — match keys against turf or paving blob prefix
  if (lower.startsWith('select key, value from app_data where key = any')) {
    const keys = values[0];
    const rows = [];
    for (const k of (Array.isArray(keys) ? keys : [])) {
      let m = String(k).match(/^[^:]+:fct_project_(.+)$/);
      if (m) {
        const proj = FAKE_TURF.find(p => p.id === m[1]);
        if (proj) { rows.push({ key: k, value: proj }); continue; }
      }
      m = String(k).match(/^[^:]+:fct_paving_project_(.+)$/);
      if (m) {
        const proj = FAKE_PAVING.find(p => p.id === m[1]);
        if (proj) { rows.push({ key: k, value: proj }); continue; }
      }
      m = String(k).match(/^[^:]+:fct_kiewit_project_(.+)$/);
      if (m) {
        const proj = FAKE_KIEWIT.find(p => p.id === m[1]);
        if (proj) rows.push({ key: k, value: proj });
      }
    }
    return Promise.resolve(rows);
  }

  // daily_tracking aggregate by project_id/cost_code/sub_code,
  // scoped by division. Used by buildFinancials for both turf and paving.
  if (lower.includes('from daily_tracking')
      && lower.includes('group by project_id, cost_code')) {
    const division = values[1];
    const ids = Array.isArray(values[2]) ? new Set(values[2]) : new Set();
    const src = DAILY_BY_DIVISION[division] || [];
    return Promise.resolve(src.filter(d => ids.has(d.project_id)));
  }

  // Payroll: the executive report reads the entries and aggregates in JS, the
  // same way payroll.html's Reports tab does.
  if (lower.includes('from timesheet_entries')) {
    return Promise.resolve(FAKE_TIMESHEET.map(e => ({ ...e })));
  }

  // weekly trucking per project (details)
  if (lower.includes("date_trunc('week', date)")) {
    return Promise.resolve([]);
  }

  // booked cost per project (single row) — details.booked uses scoped division
  if (lower.includes('total_cost_override') && lower.includes('as booked')) {
    const division = values[1];
    const projId = values[2];
    const src = DAILY_BY_DIVISION[division] || [];
    const booked = src.filter(d => d.project_id === projId).reduce((s, d) => s + d.actual, 0);
    return Promise.resolve([{ booked }]);
  }

  // Dust Control: the executive report reads the rows and does the money in JS,
  // the same way dust.html does.
  if (lower.includes('from dust_control_entries')) {
    return Promise.resolve(FAKE_DUST_ROWS);
  }
  if (lower.includes('from dust_companies')) {
    return Promise.resolve(FAKE_DUST_COMPANIES);
  }
  if (lower.includes('from dust_settings')) {
    return Promise.resolve([{ v: FAKE_DUST_UB_RATE }]);
  }

  // Other-division queries (trucking / IC / etc.) — return zeros
  return Promise.resolve([{ n: 0, v: 0, amt: 0 }]);
}

// ── Inject mocks via require.cache before requiring the handler ──
const neonPath = require.resolve('@neondatabase/serverless');
require.cache[neonPath] = {
  id: neonPath, filename: neonPath, loaded: true,
  exports: { neon: () => fakeSql },
};
const authPath = path.resolve(__dirname, '../api/lib/auth.js');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    requireAuth: () => ({ companyCode: COMPANY, isPlatformAdmin: true }),
    // report.js also gates on hasDivisionAccess(payload, 'executive'); mirror the
    // real "platform admins always pass" rule for the mocked admin payload.
    hasDivisionAccess: (payload) => Boolean(payload && payload.isPlatformAdmin),
  },
};

process.env.DATABASE_URL = 'postgres://user:pass@localhost/db';

const handler = require('../api/executive/report.js');

const req = { method: 'GET', headers: { authorization: 'Bearer fake' }, query: {} };
let statusCode = 200;
let payload = null;
const res = {
  setHeader() {},
  status(c) { statusCode = c; return this; },
  json(b)   { payload = b;   return this; },
  end()     { return this; },
};

(async () => {
  await handler(req, res);

  console.log('\n──── SQL queries emitted (' + queries.length + ') ────');
  queries.forEach((q, i) => {
    console.log(`\n[${i + 1}] ${q.sql.slice(0, 220)}${q.sql.length > 220 ? '…' : ''}`);
    if (q.values.length) console.log('    values:', q.values.map(v => Array.isArray(v) ? `[${v.length}]${JSON.stringify(v)}` : v));
  });

  console.log('\n──── RESPONSE ────  status=' + statusCode);
  if (!payload) { console.error('NO PAYLOAD'); process.exit(1); }

  // Opt-in dump so the executive front end can be rendered against a real
  // payload: EXEC_REPORT_JSON=/tmp/report.json node scripts/test-executive-report.js
  if (process.env.EXEC_REPORT_JSON) {
    require('fs').writeFileSync(process.env.EXEC_REPORT_JSON, JSON.stringify(payload, null, 2));
    console.log('wrote payload to ' + process.env.EXEC_REPORT_JSON);
  }


  console.log('\ndivision portfolios:');
  for (const d of (payload.portfolios || [])) {
    console.log(`\n  ${d.name} — status=${d.status} (${d.shown} of ${d.total} shown, ${d.hidden} more)`);
    for (const m of (d.metrics || [])) {
      console.log(`     ${m.label.padEnd(22)} = ${String(m.value).padEnd(14)} ${m.sub || ''}`);
    }
    for (const r of (d.rows || [])) {
      console.log(`     · ${(r.name || '').padEnd(30)} ${(r.status||'').padEnd(12)} bid=${r.bid} actual=${r.actual} proj=${r.projected} profit=${r.profit} actProfit=${r.actProfit} pinned=${r.pinned} ${r.progressPct}%`);
    }
  }


  if (payload.quarry) {
    console.log(`\nquarry — status=${payload.quarry.status} (${payload.quarry.entryCount} entries, ${payload.quarry.year})`);
    for (const m of (payload.quarry.metrics || [])) {
      console.log(`     ${m.label.padEnd(20)} = ${String(m.value).padEnd(22)} ${m.sub || ''}`);
    }
    for (const r of [...(payload.quarry.rows || []), payload.quarry.total].filter(Boolean)) {
      console.log(`     · ${(r.name || '').padEnd(26)} sales=${r.sales} cost=${r.cost} margin=${r.margin} tonsSold=${r.tonsSold} crushed=${r.tonsCrushed} loss=${r.lossPct} final=${r.finalScreenTons}`);
    }
  }
  if (payload.dust) {
    console.log(`\ndust — status=${payload.dust.status} (${payload.dust.year})`);
    for (const m of (payload.dust.metrics || [])) {
      console.log(`     ${m.label.padEnd(20)} = ${String(m.value).padEnd(22)} ${m.sub || ''}`);
    }
    for (const r of (payload.dust.rows || [])) {
      console.log(`     · ${(r.name || '').padEnd(20)} visits=${r.visits} gal=${r.gallons} hrs=${r.hours} rev=${r.revenue} overdue=${r.overdue} unpaid=${r.unpaid} paid=${r.paid}`);
    }
  }

  const logSection = (key, extra) => {
    const d = payload[key];
    if (!d) return;
    console.log(`\n${key} — status=${d.status} ${extra ? extra(d) : ''}`);
    for (const m of (d.metrics || [])) {
      console.log(`     ${m.label.padEnd(24)} = ${String(m.value).padEnd(14)} ${m.sub || ''}`);
    }
    for (const r of [...(d.rows || []), d.total].filter(Boolean)) {
      console.log('     · ' + Object.entries(r)
        .filter(([k, v]) => !['name', 'meta', 'isTotal'].includes(k) && typeof v !== 'object')
        .map(([k, v]) => `${k}=${v}`).join(' ') + `   [${r.name}]`);
    }
  };
  logSection('trucking',     d => `(${d.entryCount} entries, ${d.year})`);
  logSection('intercompany', d => `(${d.entryCount} entries, ${d.year}, ${d.duplicates} dup, $${d.truckRate}/hr)`);

  if (payload.payroll) {
    const pr = payload.payroll;
    console.log(`\npayroll — status=${pr.status} (${pr.periodStart} → ${pr.periodEnd})`);
    for (const m of (pr.metrics || [])) {
      console.log(`     ${m.label.padEnd(16)} = ${String(m.value).padEnd(10)} ${m.sub || ''}`);
    }
    for (const r of [...(pr.rows || []), pr.total].filter(Boolean)) {
      console.log(`     · ${(r.name || '').padEnd(24)} work=${r.workHours} travel=${r.travelHours} (site ${r.travelToSite}/shop ${r.travelToShop}) total=${r.totalHours} pw=${r.pwHours} std=${r.stdHours} pending=${r.pendingHours} approved=${r.approvedHours} off=${r.pendingOff}/${r.approvedOff}`);
    }
  }

  console.log('\n──── ASSERTIONS ────');
  let failed = 0;
  const fail = m => { console.error('  FAIL: ' + m); failed++; };
  const pass = m => console.log('  OK:   ' + m);

  // The report is division sections only — the Company Snapshot that used to
  // head it is gone, so the payload carries no snapshot at all.
  if (payload.snapshot) {
    fail('the payload still carries a snapshot: ' + JSON.stringify(Object.keys(payload.snapshot)));
  } else pass('no snapshot in the payload — the report is division sections only');

  const portfolios = payload.portfolios || [];
  const byKey = k => portfolios.find(d => d.key === k);
  const metric = (d, label) => (d.metrics || []).find(m => m.label === label);

  for (const key of ['turf', 'paving', 'kiewit']) {
    if (!byKey(key)) fail(`${key} portfolio missing`);
  }
  if (portfolios.length === 3) pass('one portfolio per job-running division (turf, paving, kiewit)');

  const turf = byKey('turf');
  if (turf) {
    // Metric strip mirrors the division home strip: p1 + p2 + p3 in progress,
    // p7 awarded, p4 (blank status) and p5 (On Hold) are neither.
    const active = metric(turf, 'Active Projects');
    if (!active || active.value !== '4') fail(`turf Active Projects = ${active && active.value} (expected 4: 3 in progress + 1 awarded)`);
    else pass(`turf Active Projects = ${active.value} — ${active.sub}`);

    const backlog = metric(turf, 'Awarded Backlog');
    if (!backlog || backlog.value !== '$75,000') fail(`turf Awarded Backlog = ${backlog && backlog.value} (expected $75,000)`);
    else pass(`turf Awarded Backlog = ${backlog.value}`);

    // Completed Done Project: $200,000 contract − $150,000 spend.
    const actProfit = metric(turf, 'Total Actual Profit');
    if (!actProfit || actProfit.value !== '$50,000') fail(`turf Total Actual Profit = ${actProfit && actProfit.value} (expected $50,000)`);
    else pass(`turf Total Actual Profit = ${actProfit.value} — ${actProfit.sub}`);

    // Bid budget: p1 $375,931.05 + p3 $151,641.89 in progress, plus awarded
    // p7 at (100 + 20 change-order qty) × $500 = $60,000.
    const bidBudget = metric(turf, 'Total Bid Budget');
    if (!bidBudget || bidBudget.value !== '$587,573') fail(`turf Total Bid Budget = ${bidBudget && bidBudget.value} (expected $587,573 — includes the change order)`);
    else pass(`turf Total Bid Budget = ${bidBudget.value} (change-order qty counted)`);

    const co = (turf.rows || []).find(r => r.jobNumber === '26053');
    if (!co || Math.abs(co.bid - 60000) > 0.01) fail(`change-order row bid = ${co && co.bid} (expected 60000)`);
    else pass('change orders raise the row\'s bid budget (120 × $500)');

    // Six rows max, pinned first — same as the home page.
    if (turf.rows.length !== 6) fail(`turf shows ${turf.rows.length} rows (expected 6)`);
    else pass('turf shows 6 rows (the home page cap)');
    if (turf.total !== 7) fail(`turf total = ${turf.total} (expected 7 past the job-number cutoff)`);
    else pass(`turf covers ${turf.total} projects, ${turf.hidden} beyond the table`);
    const firstUnpinned = turf.rows.findIndex(r => !r.pinned);
    const pinnedAfter   = turf.rows.slice(firstUnpinned + 1).some(r => r.pinned);
    if (firstUnpinned !== -1 && pinnedAfter) fail('turf rows are not pinned-first');
    else pass('turf rows are pinned-first');

    const pmRow = (turf.rows || []).find(r => r.jobNumber === '26049');
    if (!pmRow || pmRow.pm !== 'George Oakes' || pmRow.client !== 'Franklin Regional SD') {
      fail(`turf row is missing PM / client (pm=${pmRow && pmRow.pm}, client=${pmRow && pmRow.client})`);
    } else pass('project rows carry PM + client for the name sub-line');
  }

  const paving = byKey('paving');
  if (paving) {
    const active = metric(paving, 'Active Projects');
    // pv1's status is 'Active', which is neither In Progress nor Awarded, so
    // the strip reports 0 the same way paving.html's own strip does.
    if (!active) fail('paving Active Projects metric missing');
    else pass(`paving Active Projects = ${active.value} — ${active.sub}`);
    const row = (paving.rows || []).find(r => r.jobNumber === 'P-26001');
    // bid = 1000×75 + 500×50 = $100k, actual = $30k + $12k = $42k
    if (!row || row.bid !== 100000 || row.actual !== 42000) {
      fail(`paving row bid/actual = ${row && row.bid}/${row && row.actual} (expected 100000/42000)`);
    } else pass(`paving row: bid $${row.bid}, actual $${row.actual}, ${row.progressPct}% burn`);
  }

  const kiewit = byKey('kiewit');
  if (kiewit) {
    if (!kiewit.rows.length) fail('kiewit portfolio has no rows (blobs not read)');
    else {
      const r = kiewit.rows[0];
      // bid = 18 × $10,000 = $180k, actual = $90k on 9 of 18 units, so the
      // qty-burn projection lands back on the full bid.
      if (r.bid !== 180000 || r.actual !== 90000) fail(`kiewit row bid/actual = ${r.bid}/${r.actual} (expected 180000/90000)`);
      else pass(`kiewit row: bid $${r.bid}, actual $${r.actual}, projected $${r.projected}`);
    }
  }

  // ── Quarry ──
  // Hand-checkable fixture: Altoona sells 35 t at $18 = $630 and McGees 15 t at
  // $22 = $330, so division sales are $960. Altoona's cost is $580 daily +
  // $870 crushing = $1,450, and it crushed 10 × 20 = 200 tons over 8 hours.
  const q = payload.quarry;
  const qMetric = label => (q && q.metrics || []).find(m => m.label === label);
  if (!q) fail('quarry section missing');
  else {
    const alt = (q.rows || []).find(r => /Altoona/.test(r.name));
    const mcg = (q.rows || []).find(r => /Hollidaysburg/.test(r.name));
    if (!alt || Math.abs(alt.sales - 630) > 0.01)  fail(`Altoona sales = ${alt && alt.sales} (expected 630)`);
    else pass(`quarry: Altoona sales $${alt.sales}`);
    if (!alt || Math.abs(alt.cost - 1450) > 0.01)  fail(`Altoona cost = ${alt && alt.cost} (expected 1450: $580 daily + $870 crushing)`);
    else pass(`quarry: Altoona cost $${alt.cost} (daily + crushing)`);
    if (!alt || Math.abs(alt.margin + 820) > 0.01) fail(`Altoona margin = ${alt && alt.margin} (expected −820)`);
    else pass(`quarry: Altoona margin $${alt.margin} — a loss, shown as one`);
    // Cost / Ton Sold = total cost ÷ tons sold; Cost / Ton = crushing ÷ crushed.
    if (!alt || Math.abs(alt.costPerTonSold - 1450 / 35) > 0.01) fail(`Altoona cost/ton sold = ${alt && alt.costPerTonSold}`);
    else pass(`quarry: cost/ton sold $${alt.costPerTonSold.toFixed(2)} = total cost ÷ tons sold`);
    if (!alt || Math.abs(alt.costPerTon - 870 / 200) > 0.01)     fail(`Altoona cost/ton (prod) = ${alt && alt.costPerTon} (expected 4.35)`);
    else pass(`quarry: cost/ton produced $${alt.costPerTon.toFixed(2)} = crushing ÷ tons crushed`);
    // 10% loss configured → 200 crushed becomes 180 sellable.
    if (!alt || alt.lossPct !== 10 || Math.abs(alt.finalScreenTons - 180) > 0.01) {
      fail(`Altoona loss/final = ${alt && alt.lossPct}% / ${alt && alt.finalScreenTons} (expected 10% / 180)`);
    } else pass(`quarry: 10% loss takes 200 tons crushed to ${alt.finalScreenTons} sellable`);
    // McGees has no loss figure entered, so it must read "—" not 0%.
    if (!mcg || mcg.lossPct !== null || mcg.finalScreenTons !== null) {
      fail(`McGees loss = ${mcg && mcg.lossPct} (expected null — no figure entered)`);
    } else pass('quarry: a pit with no loss figure reports null, never 0%');

    if (!q.total || Math.abs(q.total.sales - 960) > 0.01) fail(`quarry total sales = ${q.total && q.total.sales} (expected 960)`);
    else pass(`quarry: division total sales $${q.total.sales}`);

    // Stockpile: 100 t opening + 180 sellable crushed − 50 sold = 230.
    const onHand = qMetric('Tons On Hand');
    if (!onHand || onHand.value !== '230') fail(`quarry Tons On Hand = ${onHand && onHand.value} (expected 230)`);
    else pass(`quarry Tons On Hand = ${onHand.value} (100 opening + 180 crushed − 50 sold)`);

    // Break-even is each pit's own target summed, never the division's blended
    // contribution — that is the "no average of averages" rule the Quarry page
    // states, and it matters here. Altoona: price $18.00/t, royalty 10% of its
    // $630 of rock = $63 over 35 t = $1.80/t, crushing $870 over 200 t crushed
    // = $4.35/t → contribution $11.85, so $1,000 of fixed cost needs 84.39 t/mo.
    // McGees has no fixed cost, so it contributes 0. Selling 50 t/mo is short.
    const be = qMetric('Break-Even');
    if (!be) fail('quarry Break-Even metric missing');
    else pass(`quarry Break-Even = ${be.value} — ${be.sub}`);
    if (!be || be.value !== 'Below' || !/need 84\.39/.test(be.sub || '')) {
      fail(`quarry break-even = "${be && be.value}: ${be && be.sub}" (expected Below, need 84.39 t/mo)`);
    } else pass('quarry break-even sums the pits and takes royalty off the price first');
    const marginTon = qMetric('Margin / Ton');
    if (!marginTon || marginTon.value !== '−$9.80') {
      fail(`quarry Margin / Ton = ${marginTon && marginTon.value} (expected −$9.80 — cents matter on a per-ton figure)`);
    } else pass(`quarry Margin / Ton = ${marginTon.value} (price $19.20 − cost $29.00)`);

    if ((q.metrics || []).length !== 8) fail(`quarry has ${(q.metrics || []).length} metrics (expected the page's 8)`);
    else pass('quarry carries the Quarry page\'s 8 Home KPIs');
  }

  // ── Dust Control ──
  // Acme: $2,200 paid + $800 unpaid over 2 visits, 700 gallons, 12 hours.
  // Cresson: one overnight 4-hour visit at $470, 100 gallons at the $1.50
  // default rate. Division revenue $3,470 over 3 jobs.
  const dust = payload.dust;
  const dMetric = label => (dust && dust.metrics || []).find(m => m.label === label);
  if (!dust) fail('dust section missing');
  else {
    const acme = (dust.rows || []).find(r => /Acme/.test(r.name));
    const bor  = (dust.rows || []).find(r => /Cresson/.test(r.name));
    if (!acme || Math.abs(acme.revenue - 3000) > 0.01) fail(`Acme revenue = ${acme && acme.revenue} (expected 3000)`);
    else pass(`dust: Acme revenue $${acme.revenue} at its own $2/gal UB rate`);
    if (!acme || acme.visits !== 2 || Math.abs(acme.gallons - 700) > 0.01 || Math.abs(acme.hours - 12) > 0.01) {
      fail(`Acme visits/gallons/hours = ${acme && acme.visits}/${acme && acme.gallons}/${acme && acme.hours} (expected 2/700/12)`);
    } else pass(`dust: Acme ${acme.visits} visits, ${acme.gallons} gallons, ${acme.hours} hours`);
    if (!acme || Math.abs(acme.paid - 2200) > 0.01) fail(`Acme paid = ${acme && acme.paid} (expected 2200)`);
    else pass(`dust: Acme $${acme.paid} paid`);
    // The unpaid March job is well past 45 days, so it reads overdue.
    if (!acme || Math.abs(acme.overdue - 800) > 0.01) fail(`Acme overdue = ${acme && acme.overdue} (expected 800 — unpaid past 45 days)`);
    else pass(`dust: Acme $${acme.overdue} overdue (unpaid past 45 days)`);
    // A 22:00→02:00 shift is four hours, not minus twenty.
    if (!bor || Math.abs(bor.hours - 4) > 0.01) fail(`Cresson hours = ${bor && bor.hours} (expected 4 across midnight)`);
    else pass('dust: an overnight shift counts as 4 hours, not a negative span');
    if (!bor || Math.abs(bor.revenue - 470) > 0.01) fail(`Cresson revenue = ${bor && bor.revenue} (expected 470 at the $1.50 default)`);
    else pass(`dust: a customer with no rate override falls back to the division default`);

    const rev = dMetric('YTD Revenue');
    if (!rev || rev.value !== '$3,470.00') fail(`dust YTD Revenue = ${rev && rev.value} (expected $3,470.00)`);
    else pass(`dust YTD Revenue = ${rev.value} — ${rev.sub}`);
    const hours = dMetric('Service Hours YTD');
    if (!hours || hours.value !== '16.0') fail(`dust Service Hours = ${hours && hours.value} (expected 16.0)`);
    else pass(`dust Service Hours YTD = ${hours.value}`);
    const overdue = dMetric('Overdue');
    if (!overdue || overdue.value !== '$1,270.00') fail(`dust Overdue = ${overdue && overdue.value} (expected $1,270.00)`);
    else pass(`dust Overdue = ${overdue.value} — ${overdue.sub}`);

    if ((dust.metrics || []).length !== 8) fail(`dust has ${(dust.metrics || []).length} metrics (expected 8)`);
    else pass('dust carries the home dashboard\'s KPIs plus the invoice picture');
  }

  // ── Trucking ──
  // Revenue is total_hours × haul_fee: Kiewit 8×120 + 6×120 = $1,680 over 14 h,
  // Hanson 4×110 = $440 over 4 h. 2025 held one 10 h haul at $100 = $1,000.
  const tr = payload.trucking;
  const trMetric = label => (tr && tr.metrics || []).find(m => m.label === label);
  if (!tr) fail('trucking section missing');
  else {
    const kiewit = (tr.rows || []).find(r => r.name === 'Kiewit');
    const hanson = (tr.rows || []).find(r => r.name === 'Hanson');
    if (!kiewit || Math.abs(kiewit.revenue - 1680) > 0.01 || Math.abs(kiewit.hours - 14) > 0.01) {
      fail(`Kiewit revenue/hours = ${kiewit && kiewit.revenue}/${kiewit && kiewit.hours} (expected 1680/14)`);
    } else pass(`trucking: Kiewit $${kiewit.revenue} over ${kiewit.hours} h (hours × haul fee)`);
    if (!kiewit || Math.abs(kiewit.paid - 960) > 0.01 || Math.abs(kiewit.awaiting - 720) > 0.01) {
      fail(`Kiewit paid/awaiting = ${kiewit && kiewit.paid}/${kiewit && kiewit.awaiting} (expected 960/720)`);
    } else pass(`trucking: Kiewit $${kiewit.paid} paid, $${kiewit.awaiting} invoiced and unpaid`);
    if (!hanson || Math.abs(hanson.uninvoiced - 440) > 0.01) {
      fail(`Hanson uninvoiced = ${hanson && hanson.uninvoiced} (expected 440)`);
    } else pass(`trucking: Hanson's $${hanson.uninvoiced} has not been invoiced`);

    const rev = trMetric('Total Revenue');
    if (!rev || rev.value !== '$2,120.00') fail(`trucking Total Revenue = ${rev && rev.value} (expected $2,120.00)`);
    else pass(`trucking Total Revenue = ${rev.value} — ${rev.sub}`);
    // The page compares against the previous year with data, not "last year".
    if (!rev || !/\+112\.0% vs 2025/.test(rev.sub || '')) {
      fail(`trucking year-over-year = "${rev && rev.sub}" (expected +112.0% vs 2025)`);
    } else pass('trucking: revenue carries its year-over-year against the last year with data');
    const fee = trMetric('Avg Haul Fee');
    if (!fee || fee.value !== '$116.67') fail(`trucking Avg Haul Fee = ${fee && fee.value} (expected $116.67 — the mean rate, not revenue ÷ hours)`);
    else pass(`trucking Avg Haul Fee = ${fee.value}, the mean rate across entries`);
    if (tr.year !== '2026') fail(`trucking year = ${tr.year} (expected 2026)`);
    else pass(`trucking scopes to ${tr.year}, the latest year with entries`);
    if ((tr.metrics || []).length !== 8) fail(`trucking has ${(tr.metrics || []).length} metrics (expected 8)`);
    else pass('trucking carries the dashboard KPIs plus the Financials averages');
  }

  // ── Intercompany ──
  // Intercompany bills trucking at the rate in the rates blob ($130/hr here, not
  // the $121 default) and dust at v1 + v2 + gallons × the customer's UB rate.
  // ic2dup re-sends ic2, and must be collapsed rather than billed twice.
  const ic = payload.intercompany;
  const icMetric = label => (ic && ic.metrics || []).find(m => m.label === label);
  if (!ic) fail('intercompany section missing');
  else {
    if (ic.duplicates !== 1 || ic.entryCount !== 4) {
      fail(`intercompany saw ${ic.entryCount} entries / ${ic.duplicates} duplicates (expected 4 / 1)`);
    } else pass(`intercompany: the re-sent entry is collapsed — ${ic.entryCount} entries, ${ic.duplicates} duplicate dropped`);
    if (ic.truckRate !== 130) fail(`intercompany truck rate = ${ic.truckRate} (expected 130 from the rates blob, not the 121 default)`);
    else pass(`intercompany bills trucking at $${ic.truckRate}/hr from the saved rates blob`);

    const truckIc = icMetric('Trucking IC — YTD');
    if (!truckIc || truckIc.value !== '$1,820.00') fail(`Trucking IC = ${truckIc && truckIc.value} (expected $1,820.00 = 14 h × $130)`);
    else pass(`intercompany Trucking IC = ${truckIc.value} (14 h × $130, the duplicate not counted twice)`);
    const dustIc = icMetric('Dust Control IC — YTD');
    // 1200 + 0 + 500 gal × $2 (Acme's own rate) = 2200, plus a $450 flat total.
    if (!dustIc || dustIc.value !== '$2,650.00') fail(`Dust IC = ${dustIc && dustIc.value} (expected $2,650.00)`);
    else pass(`intercompany Dust IC = ${dustIc.value} — gallons at the customer's own UB rate, plus a flat-total row`);
    const custRev = icMetric('Customer Revenue — YTD');
    if (!custRev || custRev.value !== '$4,330.00') fail(`Customer Revenue = ${custRev && custRev.value} (expected $4,330.00)`);
    else pass(`intercompany Customer Revenue = ${custRev.value}, apart from the $4,470.00 billed between companies`);

    // Outstanding is the two halves added: uninvoiced work plus invoiced-unpaid.
    const outstanding = icMetric('Outstanding IC');
    if (!outstanding || outstanding.value !== '$2,980.00') fail(`Outstanding IC = ${outstanding && outstanding.value} (expected $2,980.00)`);
    else pass(`intercompany Outstanding = ${outstanding.value} = $2,200 uninvoiced + $780 unpaid`);
    const notInv = icMetric('Not Yet Invoiced');
    const await_ = icMetric('Awaiting Payment');
    if (!notInv || notInv.value !== '$2,200.00' || !await_ || await_.value !== '$780.00') {
      fail(`the two halves = ${notInv && notInv.value} / ${await_ && await_.value} (expected $2,200.00 / $780.00)`);
    } else pass('intercompany splits outstanding into not-yet-invoiced and awaiting-payment');

    const kiewitIc = (ic.rows || []).find(r => r.name === 'Kiewit');
    if (!kiewitIc || Math.abs(kiewitIc.ic - 1820) > 0.01 || Math.abs(kiewitIc.revenue - 1680) > 0.01) {
      fail(`Kiewit IC/revenue = ${kiewitIc && kiewitIc.ic}/${kiewitIc && kiewitIc.revenue} (expected 1820/1680)`);
    } else pass(`intercompany: Kiewit costs $${kiewitIc.ic} between companies against $${kiewitIc.revenue} billed out`);
    if (!ic.total || Math.abs(ic.total.ic - 4470) > 0.01) {
      fail(`intercompany total IC = ${ic.total && ic.total.ic} (expected 4470)`);
    } else pass(`intercompany: totals row carries $${ic.total.ic}`);
    if ((ic.metrics || []).length !== 8) fail(`intercompany has ${(ic.metrics || []).length} metrics (expected 8)`);
    else pass('intercompany carries the dashboard\'s six KPIs plus both halves of outstanding');

    // The roll-up is read off the deduped blob, not the mirror table — the
    // table keeps the duplicates the blob's loader drops and has no
    // payment_received_date, so it would report different money.
    const icSummary = ic.summary || {};
    if (!icSummary.aged || Math.abs(icSummary.aged.amount - 780) > 0.01) {
      fail(`intercompany aged AR = ${icSummary.aged && icSummary.aged.amount} (expected 780, the section's awaiting-payment figure)`);
    } else pass(`intercompany aged AR = $${icSummary.aged.amount} — the same invoice the section reports unpaid`);
    if (!icSummary.notInvoiced || Math.abs(icSummary.notInvoiced.amount - 2200) > 0.01) {
      fail(`intercompany not-invoiced = ${icSummary.notInvoiced && icSummary.notInvoiced.amount} (expected 2200)`);
    } else pass(`intercompany not-invoiced = $${icSummary.notInvoiced.amount} — the same entry the section reports uninvoiced`);
  }

  // ── Payroll ──
  // Strick: 8 + 1 travel on the prevailing job, 6 + 0.5 on a non-prevailing one,
  // both approved → 14 work, 1.5 travel, 15.5 total. Prevailing counts the work
  // hours on the prevailing job only (8), so standard is the other 7.5.
  // Oakes: 4 + 2 travel on the prevailing job plus 2 more on a dust job, both
  // submitted → 6 work, 2 travel, 8 total pending, prevailing 4, standard 4.
  const pr = payload.payroll;
  const pMetric = label => (pr && pr.metrics || []).find(m => m.label === label);
  if (!pr) fail('payroll section missing');
  else {
    const strick = (pr.rows || []).find(r => /Strick/.test(r.name));
    const oakes  = (pr.rows || []).find(r => /Oakes/.test(r.name));

    if (!strick || Math.abs(strick.workHours - 14) > 0.001 || Math.abs(strick.travelHours - 1.5) > 0.001) {
      fail(`Strick work/travel = ${strick && strick.workHours}/${strick && strick.travelHours} (expected 14/1.5)`);
    } else pass(`payroll: Strick ${strick.workHours} work + ${strick.travelHours} travel`);
    if (!strick || Math.abs(strick.travelToSite - 1) > 0.001 || Math.abs(strick.travelToShop - 0.5) > 0.001) {
      fail(`Strick travel legs = ${strick && strick.travelToSite}/${strick && strick.travelToShop} (expected 1/0.5)`);
    } else pass('payroll: the two travel legs are carried separately from their sum');

    // The heart of it: travel is never prevailing, so the prevailing job's 1h of
    // travel falls to standard along with the whole non-prevailing day.
    if (!strick || Math.abs(strick.pwHours - 8) > 0.001) {
      fail(`Strick prevailing = ${strick && strick.pwHours} (expected 8 — work on the prevailing job only)`);
    } else pass(`payroll: prevailing hours = ${strick.pwHours}, the work on the prevailing job`);
    if (!strick || Math.abs(strick.stdHours - 7.5) > 0.001) {
      fail(`Strick standard = ${strick && strick.stdHours} (expected 7.5 — its travel plus the whole non-prevailing day)`);
    } else pass(`payroll: standard hours = ${strick.stdHours}, including that job's travel`);
    if (!strick || Math.abs(strick.pwHours + strick.stdHours - strick.totalHours) > 0.001) {
      fail(`prevailing + standard = ${strick && (strick.pwHours + strick.stdHours)} but total = ${strick && strick.totalHours}`);
    } else pass('payroll: prevailing + standard add back up to the total');

    if (!strick || Math.abs(strick.approvedHours - 15.5) > 0.001 || strick.pendingHours !== 0) {
      fail(`Strick pending/approved = ${strick && strick.pendingHours}/${strick && strick.approvedHours} (expected 0/15.5)`);
    } else pass(`payroll: Strick is fully approved at ${strick.approvedHours} h`);
    if (!oakes || Math.abs(oakes.pendingHours - 8) > 0.001 || oakes.approvedHours !== 0) {
      fail(`Oakes pending/approved = ${oakes && oakes.pendingHours}/${oakes && oakes.approvedHours} (expected 8/0)`);
    } else pass(`payroll: Oakes has ${oakes.pendingHours} h awaiting approval`);
    if (!oakes || oakes.daysWorked !== 1) {
      fail(`Oakes days worked = ${oakes && oakes.daysWorked} (expected 1 — two entries on one date is one day)`);
    } else pass('payroll: two entries on one date count as one day worked');
    if (!oakes || oakes.pendingOff !== 1 || oakes.approvedOff !== 1) {
      fail(`Oakes time off = ${oakes && oakes.pendingOff}/${oakes && oakes.approvedOff} (expected 1/1)`);
    } else pass('payroll: time-off requests are counted, not folded into hours');
    // A dust job has no prevailing-wage concept, so its hours are standard.
    if (!oakes || Math.abs(oakes.pwHours - 4) > 0.001 || Math.abs(oakes.stdHours - 4) > 0.001) {
      fail(`Oakes prevailing/standard = ${oakes && oakes.pwHours}/${oakes && oakes.stdHours} (expected 4/4)`);
    } else pass('payroll: a division with no prevailing-wage concept is standard, not prevailing');

    const totalHrs = pMetric('Total Hours');
    if (!totalHrs || totalHrs.value !== '23.50') fail(`payroll Total Hours = ${totalHrs && totalHrs.value} (expected 23.50)`);
    else pass(`payroll Total Hours = ${totalHrs.value} — ${totalHrs.sub}`);
    const pending = pMetric('Pending Hrs');
    if (!pending || pending.value !== '8.00') fail(`payroll Pending Hrs = ${pending && pending.value} (expected 8.00)`);
    else pass(`payroll Pending Hrs = ${pending.value} — ${pending.sub}`);
    if (pr.status !== '8.00 h Pending') fail(`payroll status = "${pr.status}" (expected the pending hours)`);
    else pass(`payroll status pill reads "${pr.status}"`);
    if (!pr.total || Math.abs(pr.total.pwHours - 12) > 0.001) {
      fail(`payroll total prevailing = ${pr.total && pr.total.pwHours} (expected 12)`);
    } else pass(`payroll: totals row carries ${pr.total.pwHours} prevailing hours`);
    if ((pr.metrics || []).length !== 8) fail(`payroll has ${(pr.metrics || []).length} metrics (expected 8)`);
    else pass('payroll carries the Hours Report\'s totals as its strip');
    // The cycle the payroll page's "Current Biweekly" button selects: Mon → Sun,
    // fourteen days, anchored on Sun May 10 2026.
    const days = Math.round((new Date(pr.periodEnd) - new Date(pr.periodStart)) / 86400000);
    if (days !== 13) fail(`pay period spans ${days + 1} days (expected 14)`);
    else pass(`payroll covers the biweekly cycle ${pr.periodStart} → ${pr.periodEnd}`);
  }

  // Every division section must be able to stand on its own in the PDF.
  for (const d of portfolios) {
    if (!d.metrics || d.metrics.length !== 8) {
      fail(`${d.key} has ${d.metrics ? d.metrics.length : 0} metrics (expected the home strip's 8)`);
    }
  }
  if (portfolios.every(d => (d.metrics || []).length === 8)) {
    pass('every portfolio carries the home strip\'s 8 metrics');
  }

  // The per-project detail pages are gone — the division tables carry the
  // figures, and nothing should still be paying for the per-project queries
  // those pages needed.
  if ('details' in payload) fail('payload still carries per-project detail');
  else pass('no per-project detail in the payload');
  const perProjectQueries = queries.filter(q => /date_trunc\('week', date\)/.test(q.sql)).length;
  if (perProjectQueries) fail(`${perProjectQueries} per-project trucking queries still run`);
  else pass('the per-project trucking queries are no longer issued');

  if (failed) {
    console.error('\n❌ ' + failed + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('\n✅ all assertions passed');
})().catch(err => { console.error('\nThrew:', err); process.exit(1); });
