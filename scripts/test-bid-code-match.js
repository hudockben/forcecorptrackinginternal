#!/usr/bin/env node
'use strict';
/**
 * Daily costs land on their bid line however the code was spaced, capitalised
 * or dashed.
 *
 * Run: node scripts/test-bid-code-match.js
 *
 * The bid view matched a job row to a bid line by comparing cost code and sub
 * code exactly. A row booked to "Walkway - Wearing Course" missed a bid line
 * saved as "Walkway - Wearing Course " (the timesheet split's code list trims
 * every name, the bid line kept its space), so it counted against no line, and
 * the ⚠ off-bid badge listed codes that looked identical to the ones on the
 * bid. Codes now match as they read on screen (_codeKey): capitals, spaces at
 * either end or doubled up, non-breaking spaces, zero-width characters, and
 * which dash or quote was typed make no difference. A code that reads
 * differently is still off-bid, and two spellings of one off-bid code are one
 * entry.
 *
 * The same job is run through every page's own functions, Custom Reports'
 * engine (its own restated math, no page helpers) and the Executive report,
 * and all of them have to tell the same story. The fixture is modelled on the
 * Franklin Regional bid that showed $7,679.75 off-bid against sub codes
 * plainly listed on it.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
const section = t => console.log(`\n${t}`);
const near = (a, b, eps = 1e-6) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps;
const J = v => JSON.parse(JSON.stringify(v));   // out of the vm's realm

const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const LIFT = ['calcDaily', 'dailyRowCost', '_codeKey', '_bidLineMatcher', 'actualForBidItem', 'runningQtyForBidItem',
  'cumulativeHoursForBidItem', 'laborerCountForBidItem', '_rowIsWorkDay', '_workDaysForItems', '_bidMaterialSources',
  '_rowMaterialInCost', '_dailySortDate', '_bidMaterialEntry', 'materialForBidItem', 'offBidForProject',
  '_offBidElsewhere', 'projIsDone', 'projForBidItem', 'projectedCostForProject'];
// Paving counts equipment run on a Labor row on its Equipment line, and adds a
// job's lines up off one walk of its rows.
const PAVING_OWN = ['_bidEachCostPiece', '_bidCodeTotals'];

function page(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const line = start => { const i = src.indexOf(start); if (i < 0) throw new Error(`${start} not in ${file}`); return src.slice(i, src.indexOf('\n', i)); };
  const ctx = vm.createContext({ console });
  vm.runInContext([
    line('const HAUL_FIELD_TYPE_RE ='),
    'var pvPreview = { active: false, rate: 0 };',
    'var projectsList = [], purchaseOrders = [], inventoryEntries = [];',
    'function getProj(id) { return projectsList.find(p => p.id === id); }',
    'function getAllDailyRows() { return projectsList.reduce((a, p) => a.concat(p.dailyRows || []), []); }',
    'function bidItemComplete(b) { return !!b.is_complete; }',
    ...LIFT.concat(PAVING_OWN.filter(n => src.includes(`function ${n}(`))).map(n => requireFn(src, n, file)),
    'function setProjects(list) { projectsList = list; }',
  ].join('\n'), ctx, { filename: file });
  return ctx;
}

// ── The job ──────────────────────────────────────────────────────────────
const SBP = 'Site Bituminous Paving';
const NBSP = '\u00A0', EN = '\u2013', ZW = '\u200B';
function job() {
  return {
    id: 'fr', 'project-name': 'Franklin Regional Multi', 'job-number': '26049', status: 'In Progress',
    bidItems: [
      { id: 'b1', cost_code: SBP, sub_code: 'Walkway - 2A Stone Base',  unit: 'SF', quantity: '3262', unit_cost: '2.5' },
      // Saved with a trailing space, as a bid line can be; every row below
      // carries it trimmed.
      { id: 'b2', cost_code: SBP, sub_code: 'Walkway - Wearing Course ', unit: 'SY', quantity: '362',  unit_cost: '35.5' },
      { id: 'b3', cost_code: SBP, sub_code: 'Parking lot repair prep',  unit: '',   quantity: '0',    unit_cost: '0' },
      { id: 'b4', cost_code: SBP, sub_code: 'Walkway Excavation',       unit: 'SY', quantity: '3262', unit_cost: '0' },
    ],
    dailyRows: [
      { id: 'r1', date: '2026-07-20', cost_code: SBP, sub_code: 'Walkway - 2A Stone Base', employee: 'Ann', rate: '40', labor_hours: '8', quantity: '1000' },
      { id: 'r2', date: '2026-07-21', cost_code: SBP, sub_code: `Walkway ${EN} 2A Stone Base`, employee: 'Bo', rate: '40', labor_hours: '4', quantity: '500' },
      { id: 'r3', date: '2026-07-22', cost_code: SBP, sub_code: 'Walkway - Wearing Course', employee: 'Ann', rate: '45', labor_hours: '10', quantity: '100' },
      { id: 'r4', date: '2026-07-22', cost_code: SBP, sub_code: `walkway - wearing${ZW} course`, employee: 'Cy', rate: '45', labor_hours: '2', quantity: '20' },
      { id: 'r5', date: '2026-07-23', cost_code: SBP + NBSP, sub_code: 'Parking lot repair prep', employee: 'Bo', rate: '39', labor_hours: '6' },
      { id: 'r6', date: '2026-07-23', cost_code: SBP, sub_code: 'Parking  lot repair prep', material: 'Stone', material_cost: '702' },
      // Really off the bid: a sub code it doesn't have, spelled two ways...
      { id: 'r7', date: '2026-07-24', cost_code: SBP, sub_code: 'Walkway Patch', employee: 'Ann', rate: '40', labor_hours: '3' },
      { id: 'r8', date: '2026-07-24', cost_code: SBP, sub_code: 'walkway patch ', employee: 'Bo', rate: '40', labor_hours: '1' },
      // ...and one it has, under another cost code.
      { id: 'r9', date: '2026-07-25', cost_code: 'Site Concrete', sub_code: 'Walkway Excavation', employee: 'Cy', rate: '50', labor_hours: '2' },
    ],
  };
}
// Each line's figures, worked out by hand from the rows above.
const WANT = {
  b1: { actual: 480, qty: 1500, hrs: 12, crew: 2, days: 2, mat: 0 },   // r1 + r2 (en dash)
  b2: { actual: 540, qty: 120,  hrs: 12, crew: 2, days: 1, mat: 0 },   // r3 (trimmed) + r4 (case, zero-width)
  b3: { actual: 936, qty: 0,    hrs: 6,  crew: 1, days: 1, mat: 702 }, // r5 (NBSP cost code) + r6 (double space)
  b4: { actual: 0,   qty: 0,    hrs: 0,  crew: 0, days: 0, mat: 0 },   // r9 is under Site Concrete
};
const ALL_ACTUAL = 480 + 540 + 936 + 160 + 100;
const OFF_BID    = 160 + 100;
// No dates on any line, so each projects off its quantity burn, floored at its
// actual (projForBidItem): b1 480/1500*3262, b2 540/120*362, b3 its actual, b4
// its $0 bid. Off-bid spend adds on top.
const PROJECTED  = 480 / 1500 * 3262 + 540 / 120 * 362 + 936 + 0 + OFF_BID;

// ── 1. The rule ──────────────────────────────────────────────────────────
section('_codeKey: the same code, however it was typed');
for (const file of PAGES) {
  const t = page(file);
  const k = t._codeKey;
  const same = ['Walkway - Wearing Course', 'Walkway - Wearing Course ', '  Walkway - Wearing Course', 'Walkway  -  Wearing Course',
    `Walkway${NBSP}- Wearing Course`, `Walkway ${EN} Wearing Course`, 'Walkway \u2014 Wearing Course', 'Walkway \u2212 Wearing Course',
    'WALKWAY - wearing course', `Walkway - Wear${ZW}ing Course`, 'Walkway - Wearing Course\uFEFF', 'Walkway\t-\tWearing Course'];
  const differs = ['Walkway-Wearing Course', 'Walkway - Wearing Course.', 'Walkway - Wearing', 'Walkway Wearing Course'];
  assert(`${file}: spacing, capitals, dashes and invisible characters don't matter`,
    same.every(s => k(s) === k(same[0])), same.filter(s => k(s) !== k(same[0])).map(JSON.stringify).join(', '));
  assert(`${file}: a code that reads differently is a different code`,
    differs.every(s => k(s) !== k(same[0])), differs.filter(s => k(s) === k(same[0])).join(', '));
  assert(`${file}: curly and straight quotes are one code`, k('Owner\u2019s Allowance') === k("Owner's Allowance")
    && k('12\u201D Pipe') === k('12" Pipe'));
  assert(`${file}: blank is blank, a number reads as its digits`,
    k('') === '' && k(null) === '' && k(undefined) === '' && k('   ') === '' && k(101) === k('101'));

  const m = t._bidLineMatcher;
  assert(`${file}: a cost-code-only line takes the code under any sub code, however it is spelled`,
    m({ cost_code: SBP, sub_code: '' })(`site bituminous paving${NBSP}`, 'Anything') && !m({ cost_code: SBP, sub_code: '' })('Site Concrete', 'Anything'));
  assert(`${file}: a sub-code-only line takes the sub code under any cost code`,
    m({ cost_code: '', sub_code: 'Mobilization' })('Whatever', ' mobilization') && !m({ cost_code: '', sub_code: 'Mobilization' })('Whatever', 'Demob'));
  assert(`${file}: a line with neither code takes nothing`, !m({ cost_code: '', sub_code: '' })('', '') && !m({})('x', 'y'));
  assert(`${file}: a code saved as spaces is not made a wildcard`,
    !m({ cost_code: '  ', sub_code: 'Base' })('Site Concrete', 'Base') && m({ cost_code: '  ', sub_code: 'Base' })('', 'Base'));
}

// ── 2. The pages ─────────────────────────────────────────────────────────
for (const file of PAGES) {
  section(`${file}: every row lands on the line it was booked to`);
  const t = page(file);
  const p = job();
  t.setProjects([p]);
  const bad = [];
  p.bidItems.forEach(b => {
    const w = WANT[b.id];
    const got = {
      actual: t.actualForBidItem(b, p.id), qty: t.runningQtyForBidItem(b, p.id), hrs: t.cumulativeHoursForBidItem(b, p.id),
      crew: t.laborerCountForBidItem(b, p.id), days: t._workDaysForItems([b], p.id).length, mat: t.materialForBidItem(b, p.id).total,
    };
    Object.keys(w).forEach(f => { if (!near(got[f], w[f])) bad.push(`${b.id}.${f}: ${got[f]} vs ${w[f]}`); });
  });
  assert('actual, running qty, hours, laborers, days and material per line', !bad.length, bad.join('; '));

  const off = J(t.offBidForProject(p));
  assert('only the codes the bid really lacks are off-bid', near(off.total, OFF_BID), off.total);
  assert('…two spellings of one missing code are one entry, under the first spelling met',
    off.codes.length === 2 && off.codes[0].sub_code === 'Walkway Patch' && near(off.codes[0].actual, 160)
      && off.codes[1].cost_code === 'Site Concrete' && near(off.codes[1].actual, 100), JSON.stringify(off.codes));
  assert('…and a sub code on the bid under another cost code says where',
    t._offBidElsewhere(p.id, off.codes[1]) === ` (on the bid under ${SBP})` && t._offBidElsewhere(p.id, off.codes[0]) === '',
    JSON.stringify(off.codes.map(c => t._offBidElsewhere(p.id, c))));
  assert('nothing is lost or counted twice: the lines and off-bid add up to every row',
    near(p.bidItems.reduce((s, b) => s + t.actualForBidItem(b, p.id), 0) + off.total, ALL_ACTUAL));
  assert('projected cost: each line\'s projection plus the off-bid spend', near(t.projectedCostForProject(p), PROJECTED, 1e-6),
    `${t.projectedCostForProject(p)} vs ${PROJECTED}`);

  if (file === 'paving.html') {
    const totals = t._bidCodeTotals(p);
    assert('paving: the one-walk totals are the per-line walk\'s own, to the bit',
      p.bidItems.every(b => t.actualForBidItem(b, p.id, totals) === t.actualForBidItem(b, p.id)
        && t.runningQtyForBidItem(b, p.id, totals) === t.runningQtyForBidItem(b, p.id)));
  }
}

// ── 3. Paving's equipment split, across spellings ────────────────────────
section('paving.html: equipment on a Labor row finds its Equipment line however the codes are spelled');
function splitJob() {
  return {
    id: 'sp', 'project-name': 'Split', status: 'In Progress',
    bidItems: [
      { id: 'L', cost_code: 'Paving', sub_code: 'Paving - Labor',     unit: 'SY', quantity: '1000', unit_cost: '3' },
      { id: 'E', cost_code: 'Paving', sub_code: 'Paving - Equipment', unit: 'SY', quantity: '1000', unit_cost: '2' },
    ],
    dailyRows: [
      // Trailing space on the cost code, lower case and an en dash on the sub code.
      { id: 's1', date: '2026-08-03', cost_code: 'Paving ', sub_code: `paving ${EN} labor`, employee: 'Ann', rate: '40', labor_hours: '8',
        equipment: 'Paver', equip_unit_cost: '100', equip_hours: '8', quantity: '400' },
      { id: 's2', date: '2026-08-04', cost_code: 'Paving', sub_code: 'Paving - Labor', employee: 'Bo', rate: '40', labor_hours: '8',
        equipment: 'Paver', equip_unit_cost: '100', equip_hours: '8', quantity: '400' },
    ],
  };
}
{
  const t = page('paving.html');
  const p = splitJob();
  t.setProjects([p]);
  const [L, E] = p.bidItems;
  assert('the wages stay on Labor, the machine moves to Equipment, for both rows',
    near(t.actualForBidItem(L, p.id), 640) && near(t.actualForBidItem(E, p.id), 1600),
    `${t.actualForBidItem(L, p.id)} / ${t.actualForBidItem(E, p.id)}`);
  assert('…the quantity, hours and crew stay on Labor', t.runningQtyForBidItem(L, p.id) === 800
    && t.cumulativeHoursForBidItem(L, p.id) === 16 && t.laborerCountForBidItem(L, p.id) === 2 && t.runningQtyForBidItem(E, p.id) === 0);
  assert('…nothing is off-bid', t.offBidForProject(p).total === 0);
  const totals = t._bidCodeTotals(p);
  assert('…and the one-walk totals agree', t.actualForBidItem(L, p.id, totals) === t.actualForBidItem(L, p.id)
    && t.actualForBidItem(E, p.id, totals) === t.actualForBidItem(E, p.id));
}

// ── 4. The Executive report ──────────────────────────────────────────────
// The query groups daily_tracking by the codes as stored; the report matches
// the groups to bid lines.
function groupRows(projectId, rows) {
  const n = v => parseFloat(v) || 0;
  const g = new Map();
  rows.forEach(r => {
    const eq = n(r.equip_total_override) || n(r.equip_hours) * n(r.equip_unit_cost);
    const cost = n(r.total_cost) || (n(r.labor_hours) * n(r.rate) + eq + n(r.material_cost));
    const k = (r.cost_code || '') + '\u0000' + (r.sub_code || '');
    const e = g.get(k) || { project_id: projectId, cost_code: r.cost_code || '', sub_code: r.sub_code || '',
      actual: 0, range_actual: 0, range_rows: 0, rqty: 0, equip_actual: 0 };
    e.actual += cost; e.rqty += n(r.quantity); e.equip_actual += Math.max(0, Math.min(eq, cost));
    g.set(k, e);
  });
  return [...g.values()];
}
const fakeSql = rows => (strings) =>
  Promise.resolve(strings.join('?').toLowerCase().includes('from daily_tracking') ? rows : []);

(async () => {
  const report = require(path.join(ROOT, 'api/executive/report.js'));
  for (const division of ['turf', 'paving', 'kiewit']) {
    section(`Executive report (${division}): the same lines, the same off-bid`);
    const p = job();
    const fin = (await report.buildFinancials(fakeSql(groupRows(p.id, p.dailyRows)), 'C', division, [p])).perProject.get(p.id);
    assert('actual is every row', near(fin.actual, ALL_ACTUAL), fin.actual);
    assert('off-bid is only what the bid lacks', near(fin.offBid, OFF_BID), fin.offBid);
    assert('…one entry per code, two spellings of one code merged',
      fin.offBidCodes.length === 2 && fin.offBidCodes[0].sub_code === 'Walkway Patch' && near(fin.offBidCodes[0].actual, 160),
      JSON.stringify(fin.offBidCodes));
    assert('projected cost matches the page', near(fin.projected, PROJECTED, 1e-6), `${fin.projected} vs ${PROJECTED}`);
  }
  {
    section('Executive report (paving): the equipment split across spellings');
    const p = splitJob();
    const t = page('paving.html');
    t.setProjects([p]);
    const fin = (await report.buildFinancials(fakeSql(groupRows(p.id, p.dailyRows)), 'C', 'paving', [p])).perProject.get(p.id);
    assert('nothing off-bid, and the projection is the page\'s',
      fin.offBid === 0 && near(fin.projected, t.projectedCostForProject(p), 1e-6), `${fin.offBid} / ${fin.projected} vs ${t.projectedCostForProject(p)}`);
    const moved = report.pavingEquipToEquipLine(
      [{ cost_code: 'Paving ', sub_code: `paving ${EN} labor`, actual: 1120, rangeActual: 0, rangeRows: 1, rqty: 400, equipActual: 800 }],
      [{ cost_code: 'Paving', sub_code: 'Paving - Labor' }, { cost_code: 'Paving', sub_code: 'Paving - Equipment' }]);
    assert('pavingEquipToEquipLine moves the machine off a differently spelled Labor group',
      moved.length === 2 && near(moved[0].actual, 320) && moved[1].sub_code === 'Paving - Equipment' && near(moved[1].actual, 800),
      JSON.stringify(moved));
  }

  // ── 5. Custom Reports, on its own math ─────────────────────────────────
  section('Custom Reports engine (no page helpers): the same figures per bid item');
  {
    const ctx = vm.createContext({ console });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'custom-reports-engine.js'), 'utf8'), ctx, { filename: 'custom-reports-engine.js' });
    const E = ctx.FCTReportEngine;
    const p = job();
    const bp = E.newSection('bid_progress');
    bp.columns = E.CATALOG.bid_progress.columns.map(c => c.key);
    const sk = E.newSection('summary_kpis');
    sk.columns = E.CATALOG.summary_kpis.columns.map(c => c.key);
    const def = E.normalizeDefinition({ title: 'Codes', includeInternal: true, sections: [bp, sk] });
    const cfg = {
      division: 'turf', divisionLabel: 'Turf', areaUnit: 'SF',
      perm: { role: 'admin', canSeeCosts: true, canSeeFinancials: true, canShare: true },
      getProjects: () => [p], getPurchaseOrders: () => [], getTruckingEntries: () => [],
    };
    const rc = E.makeContext(def, cfg, { pickedIds: [p.id], today: '2026-11-12', now: new Date(2026, 10, 12, 12) });
    const rows = J(E.buildSectionData(def.sections[0], def, rc).blocks[0].groups.flatMap(g => g.rows.map(r => r.cells)));
    const bad = [];
    p.bidItems.forEach((b, i) => {
      const w = WANT[b.id], r = rows[i] || {};
      [['actual_cost', w.actual], ['installed_to_date', w.qty], ['labor_hours', w.hrs], ['crew_size', w.crew], ['days_worked', w.days]]
        .forEach(([k, v]) => { if (!near(Number(r[k]) || 0, v)) bad.push(`${b.id}.${k}: ${r[k]} vs ${v}`); });
    });
    assert('actual, installed, hours, crew and days per bid item', rows.length === 4 && !bad.length, bad.join('; ') || rows.length);
    const kpi = J(E.buildSectionData(def.sections[1], def, rc).blocks[0].groups[0].rows[0].cells);
    assert('summary: actual is every row, projected adds only the real off-bid spend',
      near(kpi.actual_cost, ALL_ACTUAL) && near(kpi.projected_cost, PROJECTED, 1e-6), `${kpi.actual_cost} / ${kpi.projected_cost} vs ${PROJECTED}`);
  }

  console.log(`\n${failed ? '❌' : '✅'}  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
