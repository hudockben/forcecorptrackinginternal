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
const LIFT = ['calcDaily', 'dailyRowCost', '_bidEachCostPiece', '_bidCodeTotals', 'actualForBidItem', 'runningQtyForBidItem',
  'cumulativeHoursForBidItem', 'laborerCountForBidItem', '_rowMaterialInCost', 'materialForBidItem',
  '_bidMaterialEntry', '_dailySortDate', 'offBidForProject', 'projIsDone', 'projForBidItem',
  'projectedCostForProject', 'buildProjectSubCodeAgg', 'computeSizeAwarePastAvg'];

function page() {
  const ctx = vm.createContext({ console });
  vm.runInContext([
    line(SRC, 'const HAUL_FIELD_TYPE_RE ='),
    'let pvPreview = { active: false, rate: 0 };',
    'let projectsList = [];',
    'let scaleManualEntries = [];',
    'let _projSubAggCache = null;',
    'let _projSubAggCacheRowCount = -1;',
    'function getProj(id) { return projectsList.find(p => p.id === id); }',
    'function getAllDailyRows() { return projectsList.reduce((a, p) => a.concat(p.dailyRows || []), []); }',
    'function bidItemComplete(b) { return !!b.is_complete; }',
    ...LIFT.map(n => requireFn(SRC, n, 'paving.html')),
    `this.__t = {
       set(list) { projectsList = list; _projSubAggCache = null; _projSubAggCacheRowCount = -1; },
       pv(active, rate) { pvPreview = { active, rate }; },
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

section('a bid line with only a cost code still takes the whole row');
{
  const p = job({ bidItems: [{ id: 'w', cost_code: CC, sub_code: '', unit: 'LS', quantity: '1', unit_cost: '1' },
                             { id: 'e', cost_code: CC, sub_code: EQP, unit: 'LS', quantity: '1', unit_cost: '1' }] });
  t.set([p]);
  assert('both halves land under the cost code', near(t.actualForBidItem(p.bidItems[0], p.id), rowsTotal(p)));
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

section('projected cost reads every line off one walk of the job');
{
  // projectedCostForProject adds the pieces up once (_bidCodeTotals) instead of
  // walking the job's rows once per line. Each line's figure has to be the one
  // the walk gives it — exactly, not to the cent — through the split, travel,
  // an imported total, the PV preview and every wildcard a line can carry.
  const tv = job();
  tv.dailyRows.push({ id: 'tv', date: '2026-11-06', cost_code: CC, sub_code: LAB, field_type: 'Travel', employee: 'Collin Kelley',
    rate: '45', labor_hours: '0.5', equipment: 'Pickup', equip_unit_cost: '35', equip_hours: '0.5' });
  const imp = job();
  imp.dailyRows.find(r => r.id === 'r3').total_cost = '500';
  const wild = job();
  wild.bidItems.push(
    { id: 'w1', cost_code: CC,  sub_code: '',  unit: 'LS', quantity: '1', unit_cost: '1' },   // the whole cost code
    { id: 'w2', cost_code: '',  sub_code: EQP, unit: 'LS', quantity: '1', unit_cost: '1' },   // the sub code, under any code
    { id: 'w3', cost_code: '',  sub_code: '',  unit: 'LS', quantity: '1', unit_cost: '1' },   // nothing
    { id: 'w4', cost_code: SUP, sub_code: LAB, unit: 'LS', quantity: '1', unit_cost: '1' });
  wild.dailyRows.push(
    { id: 'z1', date: '2026-11-07', cost_code: SUP, sub_code: EQP, rate: '10', labor_hours: '2', quantity: '7' },
    // No Equipment line under SUP: this row's machine stays on its Labor line.
    { id: 'z2', date: '2026-11-07', cost_code: SUP, sub_code: LAB, rate: '10', labor_hours: '1', equip_unit_cost: '5', equip_hours: '1', quantity: '3' });
  const cases = [['the job', job(), false], ['a Travel-stamped Labor row', tv, false], ['an imported total', imp, false],
    ['the PV preview', job(), true], ['every wildcard', wild, false]];
  for (const [label, p, pv] of cases) {
    t.set([p]); t.pv(pv, pv ? 70 : 0);
    const totals = t._bidCodeTotals(p);
    const off = p.bidItems.filter(b => t.actualForBidItem(b, p.id, totals) !== t.actualForBidItem(b, p.id)
      || t.runningQtyForBidItem(b, p.id, totals) !== t.runningQtyForBidItem(b, p.id)).map(b => b.id);
    assert(`${label}: every line's actual and quantity are the walk's own`, off.length === 0, off.join(', '));
    t.pv(false, 0);
  }
  t.set([wild]);
  assert('…the wildcards read what they should: the whole code, the sub code under both codes, nothing, the pair',
    near(t.actualForBidItem(wild.bidItems[5], wild.id), rowsTotal(job()))
      && near(t.actualForBidItem(wild.bidItems[6], wild.id), 765 + 20) && t.runningQtyForBidItem(wild.bidItems[6], wild.id) === 7
      && t.actualForBidItem(wild.bidItems[7], wild.id) === 0
      && near(t.actualForBidItem(wild.bidItems[8], wild.id), 15) && t.runningQtyForBidItem(wild.bidItems[8], wild.id) === 3,
    wild.bidItems.slice(5).map(b => t.actualForBidItem(b, wild.id)).join(' / '));
  // And the job's projected cost is the line-by-line sum, one walk per line.
  const byLine = wild.bidItems.reduce((s, b) => {
    const q = parseFloat(b.quantity) || 0;
    return s + t.projForBidItem(b, t.actualForBidItem(b, wild.id), t.runningQtyForBidItem(b, wild.id), q,
      q * (parseFloat(b.unit_cost) || 0), !!b.is_complete);
  }, 0);
  const want = Math.max(byLine + t.offBidForProject(wild).total, rowsTotal(wild));
  assert('the projected cost is what walking it one line at a time gives', t.projectedCostForProject(wild) === want,
    `${t.projectedCostForProject(wild)} vs ${want}`);
}

// ── Past average ────────────────────────────────────────────────────────────
section('the Past Avg UC benchmark');
{
  const p = job(), past = job({ id: 'p25001', 'project-name': 'Last year\'s lot' });
  t.set([p, past]);
  const agg = t.buildProjectSubCodeAgg();
  const lab = agg[CC + '||' + LAB].find(x => x.projId === 'p25001');
  const eqp = agg[CC + '||' + EQP].find(x => x.projId === 'p25001');
  assert('a past job\'s Labor cost leaves out its machine', near(lab.totalCost, WAGES), lab.totalCost);
  assert('…its monthly cost too', near(lab.monthly['2026-11'].cost, WAGES));
  assert('…while its quantity, hours and machine-hours stay on Labor', lab.runQty === 3523 && lab.laborHrs === 32 && lab.equipHrs === 9);
  assert('the machine\'s cost lands on the past job\'s Equipment line', near(eqp.totalCost, 765) && eqp.runQty === 0);
  const pa = t.computeSizeAwarePastAvg(3523, CC, LAB, 'p26058');
  assert('Labor\'s Past Avg UC is wage per SY — the same measure as its Running Unit Cost', near(pa.histUC, WAGES / 3523), pa && pa.histUC);
  const job$ = Object.values(agg).flat().filter(x => x.projId === 'p25001').reduce((s, x) => s + x.totalCost, 0);
  assert('the past job\'s total is unchanged', near(job$, rowsTotal(past)));
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
      const travel = /^\s*travel\s*$/i.test(r.field_type || '') || /\btravel\b/i.test(r.sub_code || '')
        || /\btravel\b/i.test(r.cost_code || '');
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
      && dailyValues.includes('^\\s*travel\\s*$') && dailyValues.includes('\\mtravel\\M'),
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
  run().then(finish, e => { failed++; console.error(e); finish(); });
}

// ── 3. Structural ───────────────────────────────────────────────────────────
function structural() {
  section('every bid report reads the split');
  const body = name => requireFn(SRC, name, 'paving.html');
  assert('Bid Line Items vs Actuals reads each line through actualForBidItem', /actualForBidItem\(b, projId\)/.test(body('renderBidTable')));
  assert('…and so does the Job Summary report', /actualForBidItem\(b, projId\)/.test(body('exportJobSummary')));
  assert('…and the bid PDF', /actualForBidItem\(b, projId\)/.test(body('exportBidPDF')));
  assert('…and the bid XLSX', /actualForBidItem\(b, projId\)/.test(fs.readFileSync(path.join(ROOT, 'bid-xlsx.js'), 'utf8')));
  // Every line off one walk of the job's rows, which reads the same pieces.
  assert('…and the projected cost', /actualForBidItem\(b, p\.id, totals\)/.test(body('projectedCostForProject'))
    && /const totals = _bidCodeTotals\(p\);/.test(body('projectedCostForProject'))
    && /_bidEachCostPiece\(p, rows,/.test(body('_bidCodeTotals')));
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
