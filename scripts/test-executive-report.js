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
    id: 'p6',
    'project-name': 'Done Project', 'job-number': '26020', 'status': 'Complete',
    'contract-amount': '200000', 'start-date': '2025-01-01', 'end-date': '2025-12-01',
    pinned: false, bidItems: [],
  },
];

// Turf daily_tracking actuals — only Adams TWP LL has costs; the executive
// query groups by project_id + cost_code + sub_code.
const FAKE_TURF_DAILY = [
  { project_id: 'p3', cost_code: '02', sub_code: 'a', actual:  5000, rqty: 70 },
  { project_id: 'p3', cost_code: '02', sub_code: 'b', actual:  2500, rqty: 30 },
  { project_id: 'p3', cost_code: '03', sub_code: '',  actual: 98289.27, rqty: 1 },
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

// Quarry sales blob: mix of this-week + this-month entries.
const todayIso = new Date().toISOString().slice(0, 10);
const FAKE_QUARRY_SALES = [
  { date: todayIso, locationName: 'Pit 1 — Altoona',       productName: '#57 Limestone', tons: 25, pricePerTon: 18 },
  { date: todayIso, locationName: 'Pit 3 — Hollidaysburg', productName: '2A Modified',   tons: 15, pricePerTon: 22 },
  { date: todayIso, locationName: 'Pit 1 — Altoona',       productName: '#57 Limestone', tons: 10, pricePerTon: 18 },
];

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
    if (key === `${COMPANY}:fct_quarry_sales`) {
      return Promise.resolve([{ value: FAKE_QUARRY_SALES }]);
    }
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
    const src = division === 'paving' ? FAKE_PAVING_DAILY : FAKE_TURF_DAILY;
    return Promise.resolve(src.filter(d => ids.has(d.project_id)));
  }

  // weekly trucking per project (details)
  if (lower.includes("date_trunc('week', date)")) {
    return Promise.resolve([]);
  }

  // booked cost per project (single row) — details.booked uses scoped division
  if (lower.includes('total_cost_override') && lower.includes('as booked')) {
    const division = values[1];
    const projId = values[2];
    const src = division === 'paving' ? FAKE_PAVING_DAILY : FAKE_TURF_DAILY;
    const booked = src.filter(d => d.project_id === projId).reduce((s, d) => s + d.actual, 0);
    return Promise.resolve([{ booked }]);
  }

  // Other-division queries (trucking / dust / IC / etc.) — return zeros
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
  exports: { requireAuth: () => ({ companyCode: COMPANY, isPlatformAdmin: true }) },
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

  console.log('\nhero KPIs:');
  for (const k of payload.snapshot.hero) {
    console.log(`  ${k.label.padEnd(28)} = ${String(k.value).padEnd(14)} ${k.delta || ''}`);
  }

  console.log('\ndivision tiles:');
  for (const t of payload.snapshot.divisions) {
    console.log(`  ${t.name.padEnd(24)} status=${t.status}`);
    for (const k of t.kpis) {
      console.log(`     ${k.label.padEnd(22)} = ${String(k.value).padEnd(14)} ${k.sub || ''}`);
    }
  }

  console.log('\nprojects portfolio:');
  console.log('  summary:', JSON.stringify(payload.projects?.summary || {}));
  for (const p of (payload.projects?.rows || [])) {
    console.log(`  ${(p.name || '').padEnd(36)} div=${p.division.padEnd(7)} status=${(p.status||'').padEnd(14)} bid=${p.bid} actual=${p.actual} projected=${p.projected} pinned=${p.pinned} progress=${p.progressPct}%`);
  }

  console.log('\nproject details:', payload.details?.length || 0, 'projects');
  for (const d of (payload.details || [])) {
    console.log(`  ${d.name.padEnd(36)} div=${d.division.padEnd(7)} contract=${d.contract} booked=${d.bookedCost} pct=${d.pctComplete} sections=${Object.keys(d.sections || {}).join(',')}`);
  }

  console.log('\n──── ASSERTIONS ────');
  let failed = 0;
  const fail = m => { console.error('  FAIL: ' + m); failed++; };
  const pass = m => console.log('  OK:   ' + m);

  // Hero Active Projects = active turf (5: p1..p5) + active paving (1: pv1) = 6
  const heroActive = payload.snapshot.hero.find(k => k.label === 'Active Projects');
  if (!heroActive)               fail('hero Active Projects KPI missing');
  else if (heroActive.value !== '6') fail(`hero Active Projects = ${heroActive.value} (expected 6)`);
  else                           pass(`hero Active Projects = ${heroActive.value}`);

  const turf = payload.snapshot.divisions.find(d => d.key === 'turf');
  if (!turf) fail('turf tile missing');
  else {
    const active = turf.kpis.find(k => k.label === 'Active Projects');
    if (!active || active.value !== '5') fail(`turf Active Projects = ${active && active.value} (expected 5)`);
    else pass(`turf tile shows 5 active (Done Project filtered)`);

    const cvb = turf.kpis.find(k => k.label === 'Cost vs Bid');
    if (!cvb || cvb.value === '—') fail('turf Cost vs Bid is — (financials not wired)');
    else pass(`turf Cost vs Bid = ${cvb.value}`);
  }

  const paving = payload.snapshot.divisions.find(d => d.key === 'paving');
  if (!paving) fail('paving tile missing');
  else {
    const active = paving.kpis.find(k => k.label === 'Active Projects');
    if (!active || active.value !== '1') fail(`paving Active Projects = ${active && active.value} (expected 1)`);
    else pass(`paving tile shows 1 active project (pv2 filtered)`);
    const cvb = paving.kpis.find(k => k.label === 'Cost vs Bid');
    // bid = 1000*75 + 500*50 = $100k, actual = $30k + $12k = $42k → -58.0%
    if (!cvb || cvb.value !== '−58.0%') fail(`paving Cost vs Bid = ${cvb && cvb.value} (expected −58.0%)`);
    else pass(`paving Cost vs Bid = ${cvb.value}`);
  }

  const quarry = payload.snapshot.divisions.find(d => d.key === 'quarry');
  if (!quarry) fail('quarry tile missing');
  else {
    const rev = quarry.kpis.find(k => k.label === 'Profit · Wk');
    if (!rev || rev.value === '—') fail('quarry Profit · Wk is — (sales blob not read)');
    else pass(`quarry Profit · Wk = ${rev.value}`);
    const top = quarry.kpis.find(k => k.label === 'Top Product');
    if (!top || top.value !== '#57 Limestone') fail(`quarry Top Product = ${top && top.value} (expected #57 Limestone)`);
    else pass(`quarry Top Product = #57 Limestone`);
  }

  // Portfolio: 5 active turf + 1 active paving (Done Project filtered, pv2 too)
  if (!payload.projects?.rows?.length) fail('projects portfolio is empty');
  else pass(`projects portfolio has ${payload.projects.rows.length} rows (turf+paving roll-up)`);
  const portfolioTurf   = (payload.projects?.rows || []).filter(r => r.division === 'turf').length;
  const portfolioPaving = (payload.projects?.rows || []).filter(r => r.division === 'paving').length;
  if (portfolioTurf < 1)   fail(`portfolio missing turf projects (got ${portfolioTurf})`);
  else                     pass(`portfolio includes ${portfolioTurf} turf projects`);
  if (portfolioPaving < 1) fail(`portfolio missing paving projects (got ${portfolioPaving})`);
  else                     pass(`portfolio includes ${portfolioPaving} paving project(s)`);

  // Details should NOT contain mock entries from old fallback
  const mockNames = (payload.details || []).filter(d => /Riverbend|Cedar Park/.test(d.name)).map(d => d.name);
  if (mockNames.length) fail('project details still includes mock entries: ' + mockNames.join(', '));
  else pass('project details has no mock entries');

  if (failed) {
    console.error('\n❌ ' + failed + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('\n✅ all assertions passed');
})().catch(err => { console.error('\nThrew:', err); process.exit(1); });
