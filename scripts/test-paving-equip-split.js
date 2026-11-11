#!/usr/bin/env node
'use strict';
/**
 * Paving — equipment run on a Labor line is costed to the Equipment line.
 *
 * Run: node scripts/test-paving-equip-split.js
 *
 * Paving bids a cost code's equipment on a line of its own — "1 1/2" 9.5MM
 * Overlay - Equipment" beside "… - Labor" — but an approved timesheet puts the
 * man and the machine he ran on ONE job row, under the sub code he booked his
 * time to: the Labor line. On Sheetz Parking Lot (#26058) that left Aaron
 * Todd's Weiler — $765 of it — inside Labor's Actual Cost, and the Equipment
 * line reading $0 against its bid.
 *
 * Now, wherever a job row's cost is counted against a bid line, a Labor row's
 * equipment goes to the Equipment line of its cost code. The row is left as
 * approved — Daily Tracking shows it unchanged — and the cost code's and the
 * job's totals never move.
 *
 * Layers:
 *   1. Behavioural — paving.html's own helpers, lifted: the per-line actual,
 *      the material tag beside it, off-bid spend, projected cost, and the
 *      past-average benchmark, on the job from the request and its edge cases.
 *   2. Executive — api/executive/report.js projects each paving line off the
 *      same split, and reconciles with the page; Turf is untouched.
 *   3. Structural — every report that prints a line's Actual Cost reads it
 *      through actualForBidItem(); Turf and Kiewit keep their own rule.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 0.005;
const section = t => console.log(`\n[${t}]`);

const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'paving.html'), 'utf8');
const line = (src, startsWith) => {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error(`${startsWith} not found`);
  return src.slice(i, src.indexOf('\n', i));
};

// ── The page, lifted ────────────────────────────────────────────────────────
const LIFT = ['calcDaily', 'dailyRowCost', '_bidEachCostPiece', 'actualForBidItem', 'runningQtyForBidItem',
  'cumulativeHoursForBidItem', 'laborerCountForBidItem', '_rowMaterialInCost', 'materialForBidItem',
  '_bidMaterialEntry', '_dailySortDate', 'offBidForProject', 'projIsDone', 'projForBidItem',
  'projectedCostForProject', '_projSubAggBids', 'buildProjectSubCodeAgg', 'computeSizeAwarePastAvg'];

function page() {
  const ctx = vm.createContext({ console });
  vm.runInContext([
    line(SRC, 'const HAUL_FIELD_TYPE_RE ='),
    'let pvPreview = { active: false, rate: 0 };',
    'let projectsList = [];',
    'let scaleManualEntries = [];',
    'let _projSubAggCache = null;',
    'let _projSubAggCacheRowCount = -1;',
    'let _projSubAggBidSig = null;',
    'let _projSubAggCacheBids = null;',
    'function getProj(id) { return projectsList.find(p => p.id === id); }',
    'function getAllDailyRows() { return projectsList.reduce((a, p) => a.concat(p.dailyRows || []), []); }',
    'function bidItemComplete(b) { return !!b.is_complete; }',
    ...LIFT.map(n => requireFn(SRC, n, 'paving.html')),
    // Counts every row the page prices, so a test can say which rows a figure
    // had to look at.
    'let _priced = 0;',
    'const _realDailyRowCost = dailyRowCost;',
    'dailyRowCost = function (r) { _priced++; return _realDailyRowCost(r); };',
    `this.__t = {
       set(list) { projectsList = list; _projSubAggCache = null; _projSubAggCacheRowCount = -1; },
       pv(active, rate) { pvPreview = { active, rate }; },
       priced() { const n = _priced; _priced = 0; return n; },
       ${LIFT.map(n => `${n}`).join(', ')}
     };`,
  ].join('\n'), ctx);
  return ctx.__t;
}
const t = page();

// ── The job from the request ────────────────────────────────────────────────
// Sheetz Parking Lot, 11/06/2026: the 1 1/2" 9.5MM Overlay crew. Aaron Todd's
// labor row carries the Weiler (9 hr × $85 = $765); his travel row carries the
// pickup (0.5 hr × $35 = $17.50). The material came in on a PO row.
const CC   = '1 1/2" 9.5MM Overlay';
const LAB  = '1 1/2" 9.5MM Overlay - Labor';
const EQP  = '1 1/2" 9.5MM Overlay - Equipment';
const TRV  = '1 1/2" 9.5MM Overlay - Travel';
const TRK  = '1 1/2" 9.5MM Overlay - Trucking';
const MAT  = '1 1/2" 9.5MM Overlay - Material';
const SUP  = '4 1/2" 25MM Superpave';

function job(over = {}) {
  return Object.assign({
    id: 'p26058', 'project-name': 'Shadco - Sheetz Parking Lot', 'job-number': '26058', status: 'Active',
    bidItems: [
      { id: 'b1', cost_code: CC, sub_code: LAB, unit: 'SY',  quantity: '3523', unit_cost: '1.20' },
      { id: 'b2', cost_code: CC, sub_code: EQP, unit: 'LS',  quantity: '1',    unit_cost: '2500' },
      { id: 'b3', cost_code: CC, sub_code: TRV, unit: 'HR',  quantity: '20',   unit_cost: '64.90' },
      { id: 'b4', cost_code: CC, sub_code: TRK, unit: 'HR',  quantity: '40',   unit_cost: '110' },
      { id: 'b5', cost_code: CC, sub_code: MAT, unit: 'TON', quantity: '440',  unit_cost: '62' },
    ],
    dailyRows: [
      { id: 'r1', date: '2026-11-06', cost_code: CC, sub_code: MAT, field_type: '', employee: 'Purchase Order',
        material: '9.5MM', supplier: 'Lindy', material_cost: '15997.86', quantity: '' },
      { id: 'r2', date: '2026-11-06', cost_code: CC, sub_code: TRV, field_type: 'Travel', employee: 'Aaron Todd',
        job_class: 'Salary', rate: '55', labor_hours: '0.5', equipment: 'Pickup', equip_unit_cost: '35', equip_hours: '0.5' },
      { id: 'r3', date: '2026-11-06', cost_code: CC, sub_code: LAB, employee: 'Aaron Todd', job_class: 'Salary',
        rate: '55', labor_hours: '10.75', equipment: 'Weiler driveway paver', equip_unit_cost: '85', equip_hours: '9',
        quantity: '3523' },
      { id: 'r4', date: '2026-11-06', cost_code: CC, sub_code: TRV, field_type: 'Travel', employee: 'Lucas Mower',
        job_class: 'Hourly', rate: '45', labor_hours: '0.5' },
      { id: 'r5', date: '2026-11-06', cost_code: CC, sub_code: LAB, employee: 'Lucas Mower', job_class: 'Hourly',
        rate: '45', labor_hours: '10.5' },
      { id: 'r6', date: '2026-11-06', cost_code: CC, sub_code: LAB, employee: 'Collin Kelley', job_class: 'Hourly',
        rate: '45', labor_hours: '10.75' },
    ],
  }, over);
}
const line$ = (p, sc, cc = CC) => t.actualForBidItem(p.bidItems.find(b => b.sub_code === sc && b.cost_code === cc), p.id);
const rowsTotal = p => p.dailyRows.reduce((s, r) => s + t.dailyRowCost(r), 0);
const WAGES = 591.25 + 472.5 + 483.75;   // Aaron, Lucas, Collin on Labor

// ── 1. The machine moves; nothing else does ─────────────────────────────────
section('the Weiler is costed to the Equipment line');
{
  const p = job(); t.set([p]);
  const before = JSON.stringify(p.dailyRows);
  assert('Labor carries the three wages and no machine', near(line$(p, LAB), WAGES), line$(p, LAB));
  assert('Equipment carries the Weiler: 9 hr × $85 = $765', near(line$(p, EQP), 765), line$(p, EQP));
  assert('Travel keeps its pickup — travel rows are not Labor', near(line$(p, TRV), 27.5 + 17.5 + 22.5), line$(p, TRV));
  assert('Material is untouched', near(line$(p, MAT), 15997.86));
  assert('Trucking, with nothing booked, reads $0', line$(p, TRK) === 0);
  const sum = p.bidItems.reduce((s, b) => s + t.actualForBidItem(b, p.id), 0);
  assert('the cost code\'s lines still add up to every row\'s cost — nothing gained or lost', near(sum, rowsTotal(p)), `${sum} vs ${rowsTotal(p)}`);
  assert('the job rows themselves are not touched (Daily Tracking shows them as approved)', JSON.stringify(p.dailyRows) === before);
  assert('Labor\'s running unit cost is the wage per SY', near(line$(p, LAB) / t.runningQtyForBidItem(p.bidItems[0], p.id), WAGES / 3523));
  assert('…its hours stay on Labor', t.cumulativeHoursForBidItem(p.bidItems[0], p.id) === 32);
  assert('…and so do its laborers', t.laborerCountForBidItem(p.bidItems[0], p.id) === 3);
  assert('the Equipment line gets no hours or laborers from the split', t.cumulativeHoursForBidItem(p.bidItems[1], p.id) === 0
    && t.laborerCountForBidItem(p.bidItems[1], p.id) === 0);
}

section('travel keeps its pickup, wherever it was booked');
{
  // Payroll stamps a split row "Travel" when the man ticked it as travel, even
  // when he left it on the Labor sub code. The pickup stays with the travel.
  const p = job(); t.set([p]);
  p.dailyRows.push({ id: 'tv', date: '2026-11-06', cost_code: CC, sub_code: LAB, field_type: 'Travel', employee: 'Collin Kelley',
    rate: '45', labor_hours: '0.5', equipment: 'Pickup', equip_unit_cost: '35', equip_hours: '0.5' });
  assert('a Travel-stamped row on the Labor sub code is not split: its pickup stays on Labor with it',
    near(line$(p, LAB), WAGES + 22.5 + 17.5) && near(line$(p, EQP), 765), `${line$(p, LAB)} / ${line$(p, EQP)}`);
  p.dailyRows[p.dailyRows.length - 1].field_type = ' travel ';
  assert('…whatever the case or spacing of the stamp', near(line$(p, EQP), 765));

  const q = job({ bidItems: [
    { id: 'a', cost_code: CC, sub_code: 'Labor - Travel', unit: 'HR', quantity: '1', unit_cost: '1' },
    { id: 'b', cost_code: CC, sub_code: EQP, unit: 'LS', quantity: '1', unit_cost: '1' }] });
  q.dailyRows = [{ id: 'lt', date: '2026-11-06', cost_code: CC, sub_code: 'Labor - Travel', rate: '45', labor_hours: '1',
    equip_unit_cost: '35', equip_hours: '1' }];
  t.set([q]);
  assert('a "Labor - Travel" sub code is travel, and keeps its pickup', near(t.actualForBidItem(q.bidItems[0], q.id), 80)
    && t.actualForBidItem(q.bidItems[1], q.id) === 0);

  const c = job({ bidItems: [
    { id: 'a', cost_code: 'Travel Overlay', sub_code: 'Travel Overlay - Labor', unit: 'HR', quantity: '1', unit_cost: '1' },
    { id: 'b', cost_code: 'Travel Overlay', sub_code: 'Travel Overlay - Equipment', unit: 'LS', quantity: '1', unit_cost: '1' }] });
  c.dailyRows = [{ id: 'ct', date: '2026-11-06', cost_code: 'Travel Overlay', sub_code: 'Travel Overlay - Labor', rate: '45',
    labor_hours: '1', equip_unit_cost: '35', equip_hours: '1' }];
  t.set([c]);
  assert('"travel" in the cost code makes it travel too', near(t.actualForBidItem(c.bidItems[0], c.id), 80)
    && t.actualForBidItem(c.bidItems[1], c.id) === 0);

  // Spelled the way the Executive report's query spells it, so the two agree
  // on every row: ASCII spaces only, and a word edge is anything but an ASCII
  // letter, digit or underscore. scripts/test-paving-equip-split-sql.js holds
  // Postgres to the same answers.
  const one = (sub, ft) => {
    const j = job({ bidItems: [{ id: 'a', cost_code: CC, sub_code: sub, unit: 'HR', quantity: '1', unit_cost: '1' },
                               { id: 'b', cost_code: CC, sub_code: EQP, unit: 'LS', quantity: '1', unit_cost: '1' }] });
    j.dailyRows = [{ id: 'o', date: '2026-11-06', cost_code: CC, sub_code: sub, field_type: ft, rate: '45', labor_hours: '1',
      equip_unit_cost: '35', equip_hours: '1' }];
    t.set([j]);
    return t.actualForBidItem(j.bidItems[1], j.id);    // what reached Equipment
  };
  assert('a no-break space or a newline around the stamp is not travel — the row splits',
    one(LAB, 'Travel\u00a0') === 35 && one(LAB, 'Travel\n') === 35);
  assert('"travel" after a non-ASCII letter is still a word ("Labor éTravel" keeps its pickup)', one('Labor éTravel', '') === 0);
  assert('…but not inside a longer word ("Labor - Travelers" splits)', one('Labor - Travelers', '') === 35);
}

section('only when there is an Equipment line to take it');
{
  const p = job(); p.bidItems = p.bidItems.filter(b => b.sub_code !== EQP); t.set([p]);
  assert('no Equipment line on the bid: the Weiler stays on Labor', near(line$(p, LAB), WAGES + 765));

  const q = job();
  q.bidItems = q.bidItems.filter(b => b.sub_code !== EQP)
    .concat([{ id: 'b9', cost_code: SUP, sub_code: '4 1/2" 25MM Overlay- Equipment', unit: 'LS', quantity: '1', unit_cost: '3683.68' }]);
  t.set([q]);
  assert('another cost code\'s Equipment line does not take it', near(line$(q, LAB), WAGES + 765)
    && t.actualForBidItem(q.bidItems.find(b => b.cost_code === SUP), q.id) === 0);

  const r = job(); r.dailyRows.push({ id: 'x', date: '2026-11-07', cost_code: SUP, sub_code: '4 1/2" 25MM Overlay- Labor',
    employee: 'Aaron Todd', rate: '55', labor_hours: '8', equip_unit_cost: '85', equip_hours: '8' });
  t.set([r]);
  assert('a Labor row on a cost code with no Equipment line keeps its machine (and off-bid it stays whole)',
    near(t.offBidForProject(r).total, 8 * 55 + 8 * 85), t.offBidForProject(r).total);
}

section('the names are read the way people type them');
{
  const p = job({
    bidItems: [
      { id: 'a', cost_code: CC, sub_code: '1 1/2" 9.5MM Overlay- LABOUR', unit: 'SY', quantity: '3523', unit_cost: '1.2' },
      { id: 'b', cost_code: CC, sub_code: '1 1/2" 9.5MM Overlay - Equip.', unit: 'LS', quantity: '1', unit_cost: '2500' },
    ],
  });
  p.dailyRows.forEach(r => { if (r.sub_code === LAB) r.sub_code = '1 1/2" 9.5MM Overlay- LABOUR'; });
  t.set([p]);
  assert('"LABOUR" and "Equip." — any case, either spelling', near(t.actualForBidItem(p.bidItems[1], p.id), 765)
    && near(t.actualForBidItem(p.bidItems[0], p.id), WAGES));

  const q = job({
    bidItems: [
      { id: 'a', cost_code: CC, sub_code: 'Labor & Equipment', unit: 'SY', quantity: '1', unit_cost: '1' },
      { id: 'b', cost_code: CC, sub_code: EQP, unit: 'LS', quantity: '1', unit_cost: '1' },
    ],
  });
  q.dailyRows.forEach(r => { if (r.sub_code === LAB) r.sub_code = 'Labor & Equipment'; });
  t.set([q]);
  assert('a "Labor & Equipment" line already carries its machine — it is never split',
    near(t.actualForBidItem(q.bidItems[0], q.id), WAGES + 765) && t.actualForBidItem(q.bidItems[1], q.id) === 0);

  const first = job({
    bidItems: [
      { id: 'a', cost_code: CC, sub_code: 'Labor & Equipment', unit: 'SY', quantity: '1', unit_cost: '1' },
      { id: 'b', cost_code: CC, sub_code: LAB, unit: 'SY', quantity: '3523', unit_cost: '1.2' },
      { id: 'c', cost_code: CC, sub_code: EQP, unit: 'LS', quantity: '1', unit_cost: '1' },
    ],
  });
  t.set([first]);
  assert('…nor is it ever the Equipment line, even listed first: the Weiler goes to the real one',
    near(t.actualForBidItem(first.bidItems[2], first.id), 765) && t.actualForBidItem(first.bidItems[0], first.id) === 0);

  const w = job({ bidItems: [{ id: 'a', cost_code: CC, sub_code: 'Laborer Equipment', unit: 'LS', quantity: '1', unit_cost: '1' }] });
  w.dailyRows.push({ id: 'y', date: '2026-11-06', cost_code: CC, sub_code: 'Laborers', rate: '10', labor_hours: '1', equip_unit_cost: '5', equip_hours: '1' });
  t.set([w]);
  assert('"Laborers" is not a Labor line, and "Laborer Equipment" still is an Equipment one: it takes the Weiler, not the $5',
    near(t.actualForBidItem(w.bidItems[0], w.id), 765), t.actualForBidItem(w.bidItems[0], w.id));

  const two = job();
  two.bidItems.push({ id: 'b6', cost_code: CC, sub_code: '1 1/2" 9.5MM Overlay - Equipment Rental', unit: 'LS', quantity: '1', unit_cost: '1' });
  t.set([two]);
  assert('two Equipment lines under one cost code: the first on the bid takes it',
    near(line$(two, EQP), 765) && t.actualForBidItem(two.bidItems[5], two.id) === 0);
}

section('a row priced by an imported Total Cost');
{
  const p = job(); t.set([p]);
  const aaron = p.dailyRows.find(r => r.id === 'r3');
  aaron.total_cost = '500';            // a spreadsheet total smaller than the machine alone
  assert('only what the total has room for moves: Equipment takes $500…', near(line$(p, EQP), 500), line$(p, EQP));
  assert('…and Labor is never driven below the other wages', near(line$(p, LAB), 472.5 + 483.75), line$(p, LAB));
  assert('the lines still add up to the rows', near(p.bidItems.reduce((s, b) => s + t.actualForBidItem(b, p.id), 0), rowsTotal(p)));
  delete aaron.total_cost;
  p.dailyRows.find(r => r.id === 'r5').equip_total_override = '-50';   // a machine credit on Lucas's row
  assert('an equipment credit is not moved — only a positive equipment cost is',
    near(line$(p, LAB), WAGES - 50) && near(line$(p, EQP), 765), `${line$(p, LAB)} / ${line$(p, EQP)}`);
}

section('material on a Labor row stays on Labor');
{
  const p = job(); t.set([p]);
  p.dailyRows.find(r => r.id === 'r5').material_cost = '120';   // tack coat typed onto Lucas's row
  const m = t.materialForBidItem(p.bidItems[0], p.id, { po: new Map(), inv: new Map() });
  assert('Labor gains the $120 of material', near(line$(p, LAB), WAGES + 120));
  assert('…and the Material tag says $120, within the Actual Cost beside it', m.total === 120 && m.total <= line$(p, LAB));
  assert('Equipment still carries only the Weiler', near(line$(p, EQP), 765));
}

section('the prevailing-wage preview');
{
  const p = job(); t.set([p]); t.pv(true, 70);
  assert('reprices Labor\'s wages and leaves the machine on Equipment',
    near(line$(p, LAB), (10.75 + 10.5 + 10.75) * 70) && near(line$(p, EQP), 765));
  t.pv(false, 0);
}

section('a move never counts the machine more times than where it was booked');
{
  // Bid lines overlap: a line with only a cost code takes every row under it.
  // Beside an Equipment line, with no Labor line, the Labor row is counted
  // once (on the cost-code line) and the Equipment sub code twice — moving the
  // machine there would add it to the job again.
  const lines = list => list.map((b, i) => Object.assign({ id: 'w' + i, unit: 'LS', quantity: '1', unit_cost: '1', is_complete: true }, b));
  const p = job({ bidItems: lines([{ cost_code: CC, sub_code: '' }, { cost_code: CC, sub_code: EQP }]) });
  t.set([p]);
  assert('a cost-code-only line beside Equipment, no Labor line: the cost-code line takes every row',
    near(t.actualForBidItem(p.bidItems[0], p.id), rowsTotal(p)));
  assert('…and the machine stays with it rather than being counted again on Equipment',
    t.actualForBidItem(p.bidItems[1], p.id) === 0, t.actualForBidItem(p.bidItems[1], p.id));
  assert('…so a finished job still projects what it cost', near(t.projectedCostForProject(p), rowsTotal(p)),
    `${t.projectedCostForProject(p)} vs ${rowsTotal(p)}`);

  // "+ Sub Code" leaves a blank line under the cost code until it is filled
  // in. Beside Labor and Equipment the Labor row and Equipment are both taken
  // twice already, so the split goes on, and the overlap counts what it did.
  const q = job({ bidItems: lines([{ cost_code: CC, sub_code: '' }, { cost_code: CC, sub_code: LAB }, { cost_code: CC, sub_code: EQP }]) });
  q.dailyRows = q.dailyRows.filter(r => r.sub_code === LAB);
  t.set([q]);
  const sum = q.bidItems.reduce((s, b) => s + t.actualForBidItem(b, q.id), 0);
  assert('a blank "+ Sub Code" line beside Labor and Equipment does not stop the split',
    near(t.actualForBidItem(q.bidItems[1], q.id), WAGES) && near(t.actualForBidItem(q.bidItems[2], q.id), 765));
  assert('…and the lines add up to what they did before the split (the blank line\'s overlap, no more)',
    near(sum, 2 * rowsTotal(q)), `${sum} vs ${2 * rowsTotal(q)}`);

  // The other way about: two lines share the Labor row (a sub-code-only one
  // beside the full one), one takes Equipment. Splitting counts the machine
  // once, on Equipment, instead of on both Labor lines — so it goes ahead.
  const d = job({ bidItems: lines([{ cost_code: CC, sub_code: LAB }, { cost_code: '', sub_code: LAB }, { cost_code: CC, sub_code: EQP }]) });
  d.dailyRows = d.dailyRows.filter(x => x.sub_code === LAB);
  t.set([d]);
  assert('two lines sharing the Labor row, one Equipment line: each Labor line is the wages, Equipment the machine, once',
    near(t.actualForBidItem(d.bidItems[0], d.id), WAGES) && near(t.actualForBidItem(d.bidItems[1], d.id), WAGES)
      && near(t.actualForBidItem(d.bidItems[2], d.id), 765));

  const r = job({ bidItems: lines([{ cost_code: '', sub_code: LAB }, { cost_code: CC, sub_code: EQP }]) });
  r.dailyRows = r.dailyRows.filter(x => x.sub_code === LAB);
  t.set([r]);
  assert('a Labor line with only a sub code splits as a full one does',
    near(t.actualForBidItem(r.bidItems[0], r.id), WAGES) && near(t.actualForBidItem(r.bidItems[1], r.id), 765));
}

// ── Off-bid and projected cost ──────────────────────────────────────────────
section('off-bid spend');
{
  const p = job(); t.set([p]);
  assert('every piece is on a bid line: nothing off-bid', t.offBidForProject(p).total === 0);
  const q = job(); q.bidItems = q.bidItems.filter(b => b.sub_code !== LAB); t.set([q]);
  const ob = t.offBidForProject(q);
  assert('Labor not on the bid: only the wages are off-bid — the Weiler is on its Equipment line',
    near(ob.total, WAGES) && ob.codes.length === 1 && ob.codes[0].sub_code === LAB, JSON.stringify(ob));
  const onBid = q.bidItems.reduce((s, b) => s + t.actualForBidItem(b, q.id), 0);
  assert('…so on-bid plus off-bid is still every row', near(onBid + ob.total, rowsTotal(q)));
}

section('projected cost');
{
  const p = job(); p.bidItems.forEach(b => { b.is_complete = true; }); t.set([p]);
  assert('every line complete: projected is what the job cost', near(t.projectedCostForProject(p), rowsTotal(p)));
  const q = job(); q.bidItems[0].quantity = '7046'; t.set([q]);   // Labor half done
  const labProj = t.projForBidItem(q.bidItems[0], line$(q, LAB), 3523, 7046, 7046 * 1.2, false);
  assert('a half-done Labor line projects its wages, not wages and machine, across the rest',
    near(labProj, WAGES * 2), labProj);
}

// ── Past average ────────────────────────────────────────────────────────────
section('the Past Avg UC benchmark');
{
  const p = job(), past = job({ id: 'p25001', 'project-name': 'Last year\'s lot' });
  t.set([p, past]);
  const agg = t.buildProjectSubCodeAgg();
  const lab = agg[CC + '||' + LAB].find(x => x.projId === 'p25001');
  assert('a past job\'s Labor carries a split cost without its machine', near(lab.splitCost, WAGES), lab.splitCost);
  assert('…beside the whole-row cost every other reader still uses', near(lab.totalCost, WAGES + 765) && near(lab.monthly['2026-11'].cost, WAGES + 765));
  assert('…while its quantity, hours and machine-hours stay on Labor', lab.runQty === 3523 && lab.laborHrs === 32 && lab.equipHrs === 9);
  assert('an Equipment line with no rows of its own gets no entry — it has no quantity to cost over', !agg[CC + '||' + EQP]);
  const split = t.computeSizeAwarePastAvg(3523, CC, LAB, 'p26058', true);
  assert('the Bid Items page\'s Past Avg UC (split) is wage per SY — the measure of its Running Unit Cost',
    near(split.histUC, WAGES / 3523), split && split.histUC);
  const whole = t.computeSizeAwarePastAvg(3523, CC, LAB, 'p26058');
  assert('Sub Code Performance and the Production Rate view, which cost whole rows, still get a whole-row benchmark',
    near(whole.histUC, (WAGES + 765) / 3523), whole && whole.histUC);

}

// The cache is keyed on row counts; the split also moves with bid lines. An
// edit to a bid line arrives as an event — a task of its own — so the check
// waits a tick between the two, as the page would.
async function pastAvgFollowsBidLines() {
  section('the Past Avg cache follows bid-line edits');
  const p = job(), q = job({ id: 'p25002' });
  q.bidItems = q.bidItems.filter(b => b.sub_code !== EQP);
  t.set([p, q]);
  const tick = () => new Promise(r => setTimeout(r, 0));
  await tick();
  assert('a past job with no Equipment line keeps its machine on Labor',
    near(t.computeSizeAwarePastAvg(3523, CC, LAB, 'p26058', true).histUC, (WAGES + 765) / 3523));
  const lookups = [];
  for (let i = 0; i < 5; i++) lookups.push(t.computeSizeAwarePastAvg(3523, CC, LAB, 'p26058', true).histUC);
  assert('…and every lookup in the same render reads the same cached figure', lookups.every(v => v === lookups[0]));
  await tick();
  q.bidItems.push({ id: 'b2', cost_code: CC, sub_code: EQP, unit: 'LS', quantity: '1', unit_cost: '2500' });
  assert('adding its Equipment line refreshes the benchmark — no row was added, so the row count alone would not',
    near(t.computeSizeAwarePastAvg(3523, CC, LAB, 'p26058', true).histUC, WAGES / 3523));
}

section('a line prices only the rows that can land on it');
{
  // actualForBidItem() runs once per bid line over every row of the job, so a
  // row neither piece of which can land on the line must not be priced.
  const p = job(); t.set([p]); t.priced();
  line$(p, LAB);
  assert('the Labor line prices only the three Labor rows', t.priced() === 3);
  line$(p, TRV);
  assert('the Travel line prices only the two travel rows', t.priced() === 2);
  line$(p, EQP);
  assert('the Equipment line prices the Labor rows, whose machines can move to it, and nothing else', t.priced() === 3);
  line$(p, MAT);
  assert('the Material line prices only the PO row', t.priced() === 1);
}

section('whole-row totals are the same sum they always were');
{
  // Sub Code Performance, the Daily Production Rate view and Scale of Economy
  // read totalCost and the monthly cost: they must be the rows' costs added in
  // row order, as before the split — not the split pieces added back together,
  // which floating point can land a hair away from it.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const dec = () => (Math.floor(rnd() * 100000) / 100).toFixed(2);
  const p = job({ id: 'pf' });
  p.dailyRows = Array.from({ length: 400 }, (_, i) => ({ id: 'f' + i, date: '2026-1' + (i % 2) + '-0' + (1 + i % 9),
    cost_code: CC, sub_code: [LAB, LAB, TRV, MAT][i % 4], rate: dec(), labor_hours: (rnd() * 12).toFixed(2),
    equip_unit_cost: dec(), equip_hours: (rnd() * 9).toFixed(2), material_cost: i % 5 ? '' : dec(), quantity: dec() }));
  t.set([p]);
  const agg = t.buildProjectSubCodeAgg();
  const exact = [LAB, TRV, MAT].every(sc => {
    const rows = p.dailyRows.filter(r => r.sub_code === sc);
    const e = agg[CC + '||' + sc][0];
    const want = rows.reduce((s, r) => s + t.dailyRowCost(r), 0);
    const months = {};
    rows.forEach(r => { const mo = r.date.slice(0, 7); months[mo] = (months[mo] || 0) + t.dailyRowCost(r); });
    return e.totalCost === want && Object.keys(months).every(mo => e.monthly[mo].cost === months[mo]);
  });
  assert('totalCost and the monthly cost equal the row-order sums exactly (===), split rows included', exact);
  const lab = agg[CC + '||' + LAB][0];
  assert('…while Labor\'s split cost leaves the machines out', lab.splitCost < lab.totalCost);
}

// ── 2. Executive ────────────────────────────────────────────────────────────
section('Executive report');
const report = require(path.join(ROOT, 'api/executive/report.js'));
{
  // The daily_tracking query, worked the way Postgres would on these rows.
  const groupRows = (projectId, rows) => {
    const g = new Map();
    rows.forEach(r => {
      const n = v => parseFloat(v) || 0;
      const eq = n(r.equip_total_override) || n(r.equip_hours) * n(r.equip_unit_cost);
      const cost = n(r.total_cost) || (n(r.labor_hours) * n(r.rate) + eq + n(r.material_cost));
      const k = (r.cost_code || '') + '\u0000' + (r.sub_code || '');
      const e = g.get(k) || { project_id: projectId, cost_code: r.cost_code || '', sub_code: r.sub_code || '',
        actual: 0, range_actual: 0, range_rows: 0, rqty: 0, equip_actual: 0 };
      // Travel rows are left out of equip_actual: the pickup stays with the travel.
      const word = /(^|[^a-z0-9_])travel([^a-z0-9_]|$)/i;
      const travel = /^ *travel *$/i.test(r.field_type || '') || word.test(r.sub_code || '') || word.test(r.cost_code || '');
      e.actual += cost; e.rqty += n(r.quantity); if (!travel) e.equip_actual += Math.max(0, Math.min(eq, cost));
      g.set(k, e);
    });
    return [...g.values()];
  };
  let sqlSeen = '', dailyValues = null;
  const fakeSql = rows => (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').toLowerCase();
    sqlSeen += q;
    if (q.includes('from daily_tracking')) dailyValues = values;
    return Promise.resolve(q.includes('from daily_tracking') ? rows : []);
  };

  const run = async () => {
    const p = job(); p.bidItems[0].quantity = '7046'; t.set([p]);
    const fin = await report.buildFinancials(fakeSql(groupRows(p.id, p.dailyRows)), 'C', 'paving', [p]);
    const pp  = fin.perProject.get(p.id);
    assert('the query sums each group\'s equipment, capped at the row\'s cost',
      /least\(equip_cost, row_cost\)/.test(sqlSeen) && /as equip_actual/.test(sqlSeen));
    assert('paving: the projected cost matches the Bid Items page', near(pp.projected, t.projectedCostForProject(p)),
      `${pp.projected} vs ${t.projectedCostForProject(p)}`);
    assert('…and the actual is every row, unchanged', near(pp.actual, rowsTotal(p)));
    assert('…and nothing reads off-bid', pp.offBid === 0);
    assert('travel rows are filtered out of the equipment sum, by field type and by code',
      /filter \(where not is_travel\)/.test(sqlSeen) && /coalesce\(field_type, ''\) ~\*/.test(sqlSeen)
      && dailyValues.includes('^ *travel *$') && dailyValues.includes('(^|[^a-z0-9_])travel([^a-z0-9_]|$)'),
      JSON.stringify(dailyValues));
    assert('…with company, division and job ids still the first three parameters',
      dailyValues[0] === 'C' && dailyValues[1] === 'paving' && Array.isArray(dailyValues[2]));

    const tv = job(); tv.bidItems[0].quantity = '7046';
    tv.dailyRows.push({ id: 'tv', date: '2026-11-06', cost_code: CC, sub_code: LAB, field_type: 'Travel', employee: 'Collin Kelley',
      rate: '45', labor_hours: '0.5', equipment: 'Pickup', equip_unit_cost: '35', equip_hours: '0.5' });
    t.set([tv]);
    const ftv = (await report.buildFinancials(fakeSql(groupRows(tv.id, tv.dailyRows)), 'C', 'paving', [tv])).perProject.get(tv.id);
    assert('a Travel-stamped Labor row: the Executive projection still matches the page',
      near(ftv.projected, t.projectedCostForProject(tv)), `${ftv.projected} vs ${t.projectedCostForProject(tv)}`);

    const q = job(); q.bidItems = q.bidItems.filter(b => b.sub_code !== LAB); t.set([q]);
    const fq = (await report.buildFinancials(fakeSql(groupRows(q.id, q.dailyRows)), 'C', 'paving', [q])).perProject.get(q.id);
    assert('paving off-bid matches the page: the wages only', near(fq.offBid, t.offBidForProject(q).total) && near(fq.offBid, WAGES), fq.offBid);

    const turf = await report.buildFinancials(fakeSql(groupRows(q.id, q.dailyRows)), 'C', 'turf', [q]);
    assert('turf is untouched: the whole Labor group is off-bid there', near(turf.perProject.get(q.id).offBid, WAGES + 765));

    const groups = [{ cost_code: CC, sub_code: LAB, actual: 2312.5, rangeActual: 9, rangeRows: 3, rqty: 3523, equipActual: 765 }];
    const before = JSON.stringify(groups);
    const moved = report.pavingEquipToEquipLine(groups, [{ cost_code: CC, sub_code: EQP }]);
    assert('pavingEquipToEquipLine adds the Equipment group when the line had no rows',
      moved.length === 2 && near(moved[0].actual, 1547.5) && moved[1].sub_code === EQP && near(moved[1].actual, 765)
      && moved[1].rqty === 0);
    assert('…leaves the windowed figures and quantity where they were', moved[0].rangeActual === 9 && moved[0].rqty === 3523);
    assert('…and does not touch what it was given', JSON.stringify(groups) === before);
    assert('no Equipment line: the groups come back as they were',
      report.pavingEquipToEquipLine(groups, [{ cost_code: CC, sub_code: LAB }]) === groups);
  };
  run().then(pastAvgFollowsBidLines).then(finish, e => { failed++; console.error(e); finish(); });
}

// ── 3. Structural ───────────────────────────────────────────────────────────
function structural() {
  section('every bid report reads the split');
  const body = name => requireFn(SRC, name, 'paving.html');
  assert('Bid Line Items vs Actuals reads each line through actualForBidItem', /actualForBidItem\(b, projId\)/.test(body('renderBidTable')));
  assert('…and so does the Job Summary report', /actualForBidItem\(b, projId\)/.test(body('exportJobSummary')));
  assert('…and the bid PDF', /actualForBidItem\(b, projId\)/.test(body('exportBidPDF')));
  assert('…and the bid XLSX', /actualForBidItem\(b, projId\)/.test(fs.readFileSync(path.join(ROOT, 'bid-xlsx.js'), 'utf8')));
  assert('…and the projected cost', /actualForBidItem\(b, p\.id\)/.test(body('projectedCostForProject')));
  // Custom Reports work out each line's figures in custom-reports-engine.js;
  // the page hands it the split itself (behaviour: test-custom-reports-engine.js).
  assert('…and Custom Reports are handed the split itself',
    /helpers:\s*\{[\s\S]*\bbidEachCostPiece:\s*_bidEachCostPiece\b[\s\S]*\}/.test(body('_crEngineCfg'))
      && /\bbidEachCostPiece\b/.test(fs.readFileSync(path.join(ROOT, 'custom-reports-engine.js'), 'utf8')));
  assert('Daily Tracking\'s own totals are still the rows as entered',
    /const c = calcDaily\(row\);[\s\S]*lcost \+= c\.labor_cost;[\s\S]*ecost \+= c\.equip_total;/.test(body('renderDailyTotals')));
  for (const f of ['tracker.html', 'kiewit-pinetree.html']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert(`${f} keeps its own rule — paving only`, !s.includes('_bidEachCostPiece') && /return s \+ dailyRowCost\(r\);/.test(requireFn(s, 'actualForBidItem', f)));
  }
}

function finish() {
  structural();
  console.log(`\n${failed ? '❌' : '✅'}  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
