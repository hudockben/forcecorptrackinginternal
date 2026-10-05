#!/usr/bin/env node
'use strict';
/**
 * Intercompany → Reports → Job Summary — the Lowboy / Tri Axle columns
 *
 * Run: node scripts/test-job-summary-truck-columns.js
 *
 * The two truck columns read "—" on every job. Only rows tagged job_class
 * "Trucking" (the Trucking tab's own rows) were ever sorted into them, and a
 * haul approved through payroll carries the driver's job class instead — so a
 * "Triaxle Dump" or "Lowboy" on a job was filed under Equipment. A Trucking
 * row whose truck was neither was dropped from the total altogether.
 *
 * Two layers:
 *   1. The rule — jsTruckColumn over the names a roster actually holds,
 *      including the turf machines that merely contain "tri".
 *   2. The report — the real runJobSummaryReport, run in a vm against stubbed
 *      endpoints, read back off the table it renders.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const SRC = fs.readFileSync(path.resolve(__dirname, '../intercompany.html'), 'utf8');
const lift = name => requireFn(SRC, name, 'intercompany.html');

// ─────────────────────────────────────────────────────────────────────
// 1) The rule
// ─────────────────────────────────────────────────────────────────────
console.log('\n[rule — which column a machine lands in]');

const ruleCtx = vm.createContext({});
vm.runInContext(lift('jsTruckColumn'), ruleCtx);
const col = (name, trucking) => ruleCtx.jsTruckColumn(name, trucking);

for (const [name, want] of [
  ['Triaxle Dump',    'triAxle'],
  ['Triaxle Dump 12', 'triAxle'],
  ['Tri-Axle',        'triAxle'],
  ['Tri Axle',        'triAxle'],
  ['TriAxle',         'triAxle'],
  ['Lowboy',          'lowboy'],
  ['LOWBOY 9',        'lowboy'],
  ['Low Boy',         'lowboy'],
  ['Low-Boy Trailer', 'lowboy'],
]) {
  assert(`any row: "${name}" → ${want}`, col(name, false) === want, col(name, false));
}

// The reason the strict match exists: these are turf machines, not trucks.
for (const name of ['Toro Triplex', 'Line Striper', 'Electric Box', 'Trimmer', 'Skid Steer', '', null]) {
  assert(`any row: ${JSON.stringify(name)} stays Equipment`, col(name, false) === '', col(name, false));
}

// A Trucking-tagged row keeps the loose match it always had, so nothing that
// already sorted into a truck column moves out of it.
assert('Trucking row: "Tri Dump" still reads as a tri-axle', col('Tri Dump', true) === 'triAxle');
assert('Trucking row: "Lowboy 4" still reads as a lowboy',  col('Lowboy 4', true) === 'lowboy');
assert('Trucking row: "Quad Axle" names neither column',     col('Quad Axle', true) === '');

// ─────────────────────────────────────────────────────────────────────
// 2) The report
// ─────────────────────────────────────────────────────────────────────
console.log('\n[report — a payroll-approved haul shows in its truck column]');

const START = '2026-09-16', END = '2026-09-30';

const projects = [
  { id: 'p1', 'project-name': 'Franklin Regional Softball', 'job-number': '26049' },
  { id: 'p2', 'project-name': 'Orchard Hills',              'job-number': '26091' },
];

const turfRows = [
  // Approved off a driver's timesheet: his own job class, labour priced at $0
  // because the truck's rate already carries him.
  { id: 't1', _projectId: 'p1', date: '2026-09-20', job_class: 'Truck Driver', field_type: 'Haul — To/From Site',
    rate: '0', labor_hours: '8', equipment: 'Triaxle Dump', equip_unit_cost: '121', equip_hours: '8' },
  { id: 't2', _projectId: 'p1', date: '2026-09-21', job_class: 'Operator',
    rate: '0', labor_hours: '4', equipment: 'Lowboy', equip_unit_cost: '150', equip_hours: '4' },
  // Turf machines whose names happen to hold "tri".
  { id: 't3', _projectId: 'p1', date: '2026-09-22', job_class: 'Laborer',
    rate: '25', labor_hours: '8', equipment: 'Toro Triplex', equip_unit_cost: '40', equip_hours: '5' },
  { id: 't4', _projectId: 'p1', date: '2026-09-22', job_class: 'Laborer',
    rate: '0', labor_hours: '0', equipment: 'Line Striper', equip_unit_cost: '10', equip_hours: '2' },
  // The Trucking tab's own rows, as they have always been written.
  { id: 't5', _projectId: 'p1', date: '2026-09-23', job_class: 'Trucking',
    rate: '0', labor_hours: '0', equipment: 'Tri Dump', equip_unit_cost: '100', equip_hours: '1' },
  { id: 't6', _projectId: 'p1', date: '2026-09-23', job_class: 'Trucking',
    rate: '0', labor_hours: '0', equipment: 'Quad Axle', equip_unit_cost: '90', equip_hours: '2' },
  // Outside the window — must not count.
  { id: 't7', _projectId: 'p1', date: '2026-10-01', job_class: 'Truck Driver',
    rate: '0', labor_hours: '8', equipment: 'Triaxle Dump', equip_unit_cost: '121', equip_hours: '8' },
];
const turfTrucking = [
  // A Trucking-tab entry with no daily-row mirror.
  { id: 'tr1', project_id: 'p1', date: '2026-09-24', truck_type: 'Lowboy 4', rate: '140', hours: '3' },
];
const pavingRows = [
  { id: 'v1', _projectId: 'p2', date: '2026-09-25', job_class: 'CDL Driver',
    rate: '0', labor_hours: '10', equipment: 'Tri-Axle 12', equip_unit_cost: '110', equip_hours: '10' },
];

const ok = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
function fetchStub(url) {
  const u = String(url);
  if (u.startsWith('/api/projects'))          return ok({ projects });
  if (u.startsWith('/api/data/fct_projects')) return ok({ value: [] });
  if (u.startsWith('/api/data/fct_inventory'))return ok({ value: [] });
  if (u.startsWith('/api/data/_batch'))       return ok({ values: {} });
  if (u.startsWith('/api/daily-rows')) {
    if (u.includes('division=paving')) return ok({ rows: pavingRows });
    if (u.includes('division=kiewit')) return ok({ rows: [] });
    return ok({ rows: turfRows });
  }
  if (u.startsWith('/api/trucking')) {
    if (u.includes('division=paving')) return ok({ truckingEntries: [] });
    if (u.includes('division=kiewit')) return ok({ truckingEntries: [] });
    return ok({ truckingEntries: turfTrucking });
  }
  throw new Error('unexpected fetch ' + u);
}

const el = () => ({ value: '', innerHTML: '', textContent: '', disabled: false, style: {} });
const els = { jsStartDate: el(), jsEndDate: el(), jsSummaryBody: el(), jsReportInfo: el(), jsPdfBtn: el() };
els.jsStartDate.value = START;
els.jsEndDate.value   = END;

const ctx = vm.createContext({
  API_BASE: '/api',
  token: 'test',
  fetch: fetchStub,
  console,
  document: {
    getElementById: id => els[id] || null,
    querySelector:  () => el(),
  },
});
vm.runInContext([
  "const fmt$ = v => '$' + v.toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');",
  'let _jsHasRun = false;',
  lift('escT'),
  lift('jsTruckColumn'),
  lift('jsAddMachineCost'),
  'let _jsReport = null;',
  lift('jsClearExport'),
  // fnSource lifts from `function`, so the async keyword has to be put back.
  'async ' + lift('runJobSummaryReport'),
].join('\n'), ctx);

(async () => {
  await ctx.runJobSummaryReport();
  const html = els.jsSummaryBody.innerHTML;
  assert('the report rendered a table', html.includes('<table'), html.slice(0, 200));

  // One project row → its cells, by the header's order.
  const HEAD = ['project', 'range', 'labor', 'equip', 'lowboy', 'tri', 'total', 'hours'];
  function rowFor(name) {
    const tr = html.split('<tr').find(t => t.includes(name));
    if (!tr) return null;
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
    return Object.fromEntries(HEAD.map((k, i) => [k, cells[i]]));
  }

  const fr = rowFor('Franklin Regional Softball');
  assert('Franklin Regional Softball has a row', !!fr);
  if (fr) {
    // 8 h × $121 approved off a timesheet, plus the Trucking tab's $100.
    assert('Tri Axle carries the approved triaxle haul', fr.tri === '$1,068.00', fr.tri);
    // 4 h × $150 approved off a timesheet, plus 3 h × $140 off the Trucking tab.
    assert('Lowboy carries the approved lowboy haul', fr.lowboy === '$1,020.00', fr.lowboy);
    // Triplex $200 + Striper $20 + the quad-axle's $180, which used to vanish.
    assert('Equipment keeps the turf machines and picks up the quad-axle', fr.equip === '$400.00', fr.equip);
    assert('Labor is unchanged', fr.labor === '$200.00', fr.labor);
    assert('Total is every column added up', fr.total === '$2,688.00', fr.total);
    assert('Hours are unchanged, and the October haul is not in them', fr.hours === '20.0 hrs', fr.hours);
  }

  const oh = rowFor('Orchard Hills');
  assert('Orchard Hills has a row', !!oh);
  if (oh) {
    assert('a paving haul shows in Tri Axle too', oh.tri === '$1,100.00', oh.tri);
    assert('…and not in Equipment', oh.equip === '$0.00', oh.equip);
  }

  const foot = (html.match(/<tfoot>[\s\S]*<\/tfoot>/) || [''])[0];
  const footCells = [...foot.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
  assert('the totals row sums Lowboy', footCells[4] === '$1,020.00', footCells[4]);
  assert('the totals row sums Tri Axle', footCells[5] === '$2,168.00', footCells[5]);
  assert('the totals row sums the whole report', footCells[6] === '$3,788.00', footCells[6]);

  console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
