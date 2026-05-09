'use strict';
/**
 * Local test for /api/executive/report.
 * Mocks DB and auth, runs the handler against fake-but-realistic data
 * shaped like the user's production (status='In Progress', pinned=true,
 * empty status, On Hold, Complete, etc.), captures every SQL string,
 * and asserts the response shape.
 *
 * Run:  node scripts/test-executive-report.js
 */

const path = require('path');
const fs   = require('fs');

const COMPANY = 'TEST_CO';
const queries = [];

const FAKE_PROJECTS = [
  { id: 'p1', name: 'Franklin Regional Tennis Court', job_number: '26049', status: 'In Progress', contract_amount: 479312.32, start_date: '2026-03-01', end_date: '2026-09-15', pinned: true,  updated_at: '2026-05-01T00:00:00Z' },
  { id: 'p2', name: 'Hildebrand',                     job_number: '26045', status: 'In Progress', contract_amount: null,      start_date: '2026-02-15', end_date: '2026-08-01', pinned: true,  updated_at: '2026-05-02T00:00:00Z' },
  { id: 'p3', name: 'Adams TWP LL',                   job_number: '26034', status: 'In Progress', contract_amount: 190086.60, start_date: '2026-01-15', end_date: '2026-06-15', pinned: true,  updated_at: '2026-05-03T00:00:00Z' },
  { id: 'p4', name: 'Empty Status Project',           job_number: '26040', status: '',            contract_amount: 100000,    start_date: '2026-04-01', end_date: '2026-12-01', pinned: false, updated_at: '2026-05-04T00:00:00Z' },
  { id: 'p5', name: 'On Hold Project',                job_number: '26050', status: 'On Hold',     contract_amount: 50000,     start_date: '2026-03-01', end_date: '2026-07-01', pinned: false, updated_at: '2026-05-05T00:00:00Z' },
  { id: 'p6', name: 'Done Project',                   job_number: '26020', status: 'Complete',    contract_amount: 200000,    start_date: '2025-01-01', end_date: '2025-12-01', pinned: false, updated_at: '2025-12-15T00:00:00Z' },
];
const FAKE_BID_ITEMS = [
  { project_id: 'p1', cost_code: '01', sub_code: '',  quantity: 1,   unit_cost: 375931.05, start_date: null, target_date: null, description: 'Sitework',   unit: 'LS', status: 'Active' },
  { project_id: 'p3', cost_code: '02', sub_code: 'a', quantity: 100, unit_cost: 1000,      start_date: null, target_date: null, description: 'Excavation', unit: 'CY', status: 'Active' },
  { project_id: 'p3', cost_code: '02', sub_code: 'b', quantity: 50,  unit_cost: 500,       start_date: null, target_date: null, description: 'Backfill',   unit: 'CY', status: 'Active' },
  { project_id: 'p3', cost_code: '03', sub_code: '',  quantity: 1,   unit_cost: 26641.89,  start_date: null, target_date: null, description: 'Misc',       unit: 'LS', status: 'Active' },
];
const FAKE_DAILY = [
  { project_id: 'p3', cost_code: '02', sub_code: 'a', labor_hours: 100, rate: 50, equip_hours: 0, equip_unit_cost: 0, material_cost: 0,        quantity: 70, total_cost_override: null },
  { project_id: 'p3', cost_code: '02', sub_code: 'b', labor_hours: 50,  rate: 50, equip_hours: 0, equip_unit_cost: 0, material_cost: 0,        quantity: 30, total_cost_override: null },
  { project_id: 'p3', cost_code: '03', sub_code: '',  labor_hours: 0,   rate: 0,  equip_hours: 0, equip_unit_cost: 0, material_cost: 98289.27, quantity: 1,  total_cost_override: null },
];

const isDone = s => ['complete','closed'].includes(String(s || '').toLowerCase());
const calcDailyCost = d => d.total_cost_override ?? (d.labor_hours * d.rate + d.equip_hours * d.equip_unit_cost + d.material_cost);

function fakeSql(strings, ...values) {
  let q = strings[0];
  values.forEach((v, i) => { q += `$${i + 1}` + strings[i + 1]; });
  const compact = q.replace(/\s+/g, ' ').trim();
  queries.push({ sql: compact, values });
  const lower = compact.toLowerCase();

  // Hero / turf active count: COUNT(*) FROM projects WHERE NOT done
  if (lower.includes('select count(*)::int as n') && lower.includes('from projects')) {
    if (lower.includes("'on hold'")) {
      return Promise.resolve([{ n: FAKE_PROJECTS.filter(p => (p.status || '').toLowerCase() === 'on hold').length }]);
    }
    if (lower.includes("'at risk'")) {
      return Promise.resolve([{ n: 0 }]);
    }
    return Promise.resolve([{ n: FAKE_PROJECTS.filter(p => !isDone(p.status)).length }]);
  }

  // Turf financials CTE
  if (lower.includes('with active_proj as') && lower.includes('contract_total')) {
    const active = FAKE_PROJECTS.filter(p => !isDone(p.status));
    const contract_total = active.reduce((s, p) => s + (p.contract_amount || 0), 0);
    const activeIds = new Set(active.map(p => p.id));
    const bid_total      = FAKE_BID_ITEMS.filter(b => activeIds.has(b.project_id)).reduce((s, b) => s + b.quantity * b.unit_cost, 0);
    const actual_total   = FAKE_DAILY.filter(d => activeIds.has(d.project_id)).reduce((s, d) => s + calcDailyCost(d), 0);
    const projected_total = bid_total; // simplification
    return Promise.resolve([{ contract_total, bid_total, actual_total, projected_total }]);
  }

  // Project portfolio CTE
  if (lower.includes('with target_projects as')) {
    const eligible = FAKE_PROJECTS.filter(p => p.pinned || !isDone(p.status))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at.localeCompare(a.updated_at))
      .slice(0, 12);
    return Promise.resolve(eligible.map(p => {
      const bid    = FAKE_BID_ITEMS.filter(b => b.project_id === p.id).reduce((s, b) => s + b.quantity * b.unit_cost, 0);
      const actual = FAKE_DAILY.filter(d => d.project_id === p.id).reduce((s, d) => s + calcDailyCost(d), 0);
      return {
        id: p.id, name: p.name, job_number: p.job_number, status: p.status,
        contract: p.contract_amount, pinned: p.pinned,
        bid, actual, projected: bid > 0 ? bid : 0,
      };
    }));
  }

  // Project details list (top 6 active)
  if (lower.includes('p.contract_amount::float') && lower.includes('limit 6')) {
    return Promise.resolve(FAKE_PROJECTS.filter(p => !isDone(p.status)).slice(0, 6).map(p => ({
      id: p.id, name: p.name, job_number: p.job_number, status: p.status,
      start_date: p.start_date, end_date: p.end_date, contract_amount: p.contract_amount,
    })));
  }

  // bid_items per project for details
  if (lower.startsWith('select cost_code, sub_code') && lower.includes('from bid_items')) {
    const projId = values[1];
    return Promise.resolve(FAKE_BID_ITEMS.filter(b => b.project_id === projId));
  }

  // weekly trucking per project
  if (lower.includes("date_trunc('week', date)")) {
    return Promise.resolve([]);
  }

  // booked cost per project (single row)
  if (lower.includes('total_cost_override') && lower.includes('as booked') && !lower.includes('booked_total')) {
    const projId = values[1];
    const booked = FAKE_DAILY.filter(d => d.project_id === projId).reduce((s, d) => s + calcDailyCost(d), 0);
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
    console.log(`  ${(p.name || '').padEnd(36)} status=${(p.status||'').padEnd(14)} bid=${p.bid} actual=${p.actual} projected=${p.projected} pinned=${p.pinned} progress=${p.progressPct}%`);
  }

  console.log('\nproject details:', payload.details?.length || 0, 'projects');
  for (const d of (payload.details || [])) {
    console.log(`  ${d.name.padEnd(36)} contract=${d.contract} booked=${d.bookedCost} pct=${d.pctComplete} sections=${Object.keys(d.sections || {}).join(',')}`);
  }

  console.log('\n──── ASSERTIONS ────');
  let failed = 0;
  const fail = m => { console.error('  FAIL: ' + m); failed++; };
  const pass = m => console.log('  OK:   ' + m);

  const heroActive = payload.snapshot.hero.find(k => k.label === 'Active Projects');
  if (!heroActive)               fail('hero Active Projects KPI missing');
  else if (heroActive.value === '—') fail("hero Active Projects shows '—' (status filter wrong)");
  else                           pass(`hero Active Projects = ${heroActive.value}`);

  const turf = payload.snapshot.divisions.find(d => d.key === 'turf');
  if (!turf) fail('turf tile missing');
  else {
    const dashes = turf.kpis.filter(k => k.value === '—').length;
    if (dashes === turf.kpis.length) fail(`turf tile is ALL dashes (${dashes}/${turf.kpis.length})`);
    else pass(`turf tile has ${turf.kpis.length - dashes} live values out of ${turf.kpis.length}`);
  }

  if (!payload.projects?.rows?.length) fail('projects portfolio is empty');
  else pass(`projects portfolio has ${payload.projects.rows.length} rows`);

  const mockNames = (payload.details || []).filter(d => /Riverbend|Cedar Park/.test(d.name)).map(d => d.name);
  if (mockNames.length) fail('project details still includes mock entries: ' + mockNames.join(', '));
  else pass('project details has no mock entries');

  if (failed) {
    console.error('\n❌ ' + failed + ' assertion(s) failed');
    process.exit(1);
  }
  console.log('\n✅ all assertions passed');
})().catch(err => { console.error('\nThrew:', err); process.exit(1); });
