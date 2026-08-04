#!/usr/bin/env node
'use strict';
/**
 * Tests for the Bid Line Items vs Actuals "Projected Cost" column.
 *
 * Run: node scripts/test-projected-cost.js
 *
 * Projected Cost is the estimate of what a bid line will have cost when it is
 * finished. Two things used to go wrong with it, both of which understated the
 * number the estimators price the next job from:
 *
 *   1. The cell was blanked whenever the line carried no bid dollars
 *      (`bidTot ? '$'+fmt(proj) : '—'`). Lines that are tracked but not bid —
 *      Mobilization, Travel, Hauling, E&S — showed "—" in the column while
 *      their projection was silently included in the group, footer and header
 *      totals. The money was in the total with no row to explain it.
 *
 *   2. The projection could land BELOW the line's own actual cost:
 *        · no running quantity  → fell back to the bid total, so a line with
 *          $695.75 spent against a $0 bid projected $0;
 *        · running qty > bid qty → `(actual / rqty) * bidQty` scales the spend
 *          back DOWN to the bid quantity, so #3 Delivered (41.95 tons logged
 *          against 1 bid ton, $665.50 spent) projected $15.86;
 *        · a line marked ✓ Complete was still extrapolated instead of being
 *          settled at its actual.
 *
 * Money already spent is a floor, never an estimate. Every branch is now
 * floored at the line's actual cost, and the column shows a projection
 * whenever there is one.
 *
 * The fixtures below are the real rows from the Franklin Regional Tennis Court
 * job, so the expectations are checkable against the screen.
 */

const fs   = require('fs');
const path = require('path');

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 0.01;

// Pull the real functions out of the page and evaluate them, so these are
// behavioural assertions rather than assertions about the source text.
function loadProjFor(file) {
  const src   = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const start = src.indexOf('function projForBidItem(');
  if (start < 0) throw new Error(`projForBidItem not found in ${file}`);
  const end = src.indexOf('\nfunction projectedCostForProject(', start);
  if (end < 0) throw new Error(`projectedCostForProject not found after projForBidItem in ${file}`);
  return new Function(`${src.slice(start, end)}; return projForBidItem;`)();
}

// Lift one top-level function out of the page by brace-matching its body.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

// The whole projection block with its data lookups injected, so the footer
// total can be checked against the rows it is supposed to sum. offBidForProject
// comes along for the ride so the real wildcard matching is under test too.
const PROJECTION_FNS = ['offBidForProject', 'projIsDone', 'projForBidItem', 'projectedCostForProject'];
function loadProjectionBlock(file, stubs) {
  const src   = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const block = PROJECTION_FNS.map(n => extractFunction(src, n)).join('\n\n');
  return new Function('actualForBidItem', 'runningQtyForBidItem', 'bidItemComplete', 'dailyRowCost', 'getProj',
    `${block}
     return { projIsDone, projForBidItem, projectedCostForProject, offBidForProject };`
  )(stubs.actualForBidItem, stubs.runningQtyForBidItem, stubs.bidItemComplete, stubs.dailyRowCost,
    () => { throw new Error('getProj should not be reached — the project object is passed directly'); });
}

// Franklin Regional Tennis Court, as shown in the bid table. `now` is pinned so
// the elapsed-vs-planned branch is deterministic.
// Midnight, so a window that is exactly half elapsed measures as exactly half.
const NOW = new Date('2026-08-04T00:00:00Z');
const ROWS = [
  // label, bidQty, unitCost, actual, rqty, start, target, complete, expected, expectShown
  ['Concrete Curb 12inch',  386,    43.26, 33071.00, 386,   '2026-06-12', '2026-07-14', true,  33071.00, true],
  ['Concrete Curb 30inch',  386,    125,   35855.96, 384,   '2026-06-23', '2026-07-14', true,  35855.96, true],
  ['Tennis Netting System', 5,      3650,   8193.00, 5,     '2026-07-08', '2026-07-08', true,   8193.00, true],
  ['Surface Coatings',      3521,   13.42,     0.00, 0,     null,         null,         false, 47251.82, true],
  ['4x10 Single Drive Gate',4,      825,       0.00, 0,     null,         null,         false,  3300.00, true],
  ['10 Fence',              771.32, 101.3,  4653.00, 771.32,'2026-05-15', '2026-05-18', true,   4653.00, true],
  // Tracked but never bid — these are the rows that showed "—".
  ['Construction Fence',    545,    0,      3168.00, 545,   '2026-05-20', '2026-05-20', true,   3168.00, true],
  ['Mobilization',          43.5,   0,      6261.75, 44.5,  null,         null,         true,   6261.75, true],
  ['Travel',                285.5,  0,     18951.00, 285.5, null,         null,         true,  18951.00, true],
  ['Silt Sock 12inch',      847,    0,      5663.00, 847,   '2026-05-18', '2026-07-09', true,   5663.00, true],
  ['Topsoil Delivered',     1,      0,       695.75, 0,     '2026-05-19', '2026-05-19', false,   695.75, true],
  ['#3 Delivered',          1,      0,       665.50, 41.95, null,         '2026-05-19', true,    665.50, true],
  ['Concrete Delivered',    1,      0,       242.00, 0,     null,         '2026-07-02', false,   242.00, true],
  ['#2A Delivered',         126.3,  0,      2213.75, 126.33,'2026-06-10', '2026-06-29', true,   2213.75, true],
];

// The display gate the table applies to the computed projection.
const shown = (bidTot, proj) => !!(bidTot || proj);

for (const file of FILES) {
  console.log(`\n══════════ ${file} ══════════`);
  const projForBidItem = loadProjFor(file);

  // Freeze the clock for the elapsed-vs-planned branch.
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(NOW); }
  };

  try {
    console.log('\n[every line projects at least what it has already cost]');
    for (const [label, bidQty, uc, actual, rqty, start, target, done, expected] of ROWS) {
      const bidTot = bidQty * uc;
      const b = { start_date: start, target_date: target };
      const proj = projForBidItem(b, actual, rqty, bidQty, bidTot, done);
      assert(`${label} projects $${expected.toFixed(2)}`, near(proj, expected), `got $${proj.toFixed(2)}`);
      assert(`  never below its $${actual.toFixed(2)} actual`, proj >= actual - 0.01, `got $${proj.toFixed(2)}`);
    }

    console.log('\n[the column shows a projection whenever there is one]');
    for (const [label, bidQty, uc, actual, rqty, start, target, done, , expectShown] of ROWS) {
      const bidTot = bidQty * uc;
      const proj = projForBidItem({ start_date: start, target_date: target }, actual, rqty, bidQty, bidTot, done);
      assert(`${label} renders a value, not "—"`, shown(bidTot, proj) === expectShown);
    }
    // A line with neither a bid nor any spend genuinely has nothing to project.
    assert('an empty line still renders "—"',
      shown(0, projForBidItem({}, 0, 0, 0, 0, false)) === false);

    console.log('\n[the specific regressions stay fixed]');
    // Overrun: 41.95 tons logged against a 1-ton bid, $665.50 spent.
    assert('a qty overrun no longer scales the spend back down',
      near(projForBidItem({}, 665.50, 41.95, 1, 0, false), 665.50),
      `got $${projForBidItem({}, 665.50, 41.95, 1, 0, false).toFixed(2)}`);
    // No running qty, real spend, real bid, and spend has passed the bid.
    assert('spend past the bid projects the spend, not the bid',
      near(projForBidItem({}, 5000, 0, 10, 3000, false), 5000));
    // No running qty, real spend, spend still under the bid.
    assert('spend under the bid still projects the bid',
      near(projForBidItem({}, 1000, 0, 10, 3000, false), 3000));
    // Nothing spent yet — the bid is the only estimate available.
    assert('an un-started line projects its bid',
      near(projForBidItem({}, 0, 0, 3521, 47251.82, false), 47251.82));
    // Completion settles the line at its actual instead of extrapolating.
    assert('a ✓ Complete line settles at its actual',
      near(projForBidItem({ start_date: '2026-06-01', target_date: '2026-12-31' }, 8193, 5, 5, 18250, true), 8193));
    assert('  the same line un-completed still extrapolates upward',
      projForBidItem({ start_date: '2026-06-01', target_date: '2026-12-31' }, 8193, 5, 5, 18250, false) > 8193);
    // A completed line with nothing logged must not collapse to $0.
    assert('a complete line with no spend falls back to its bid',
      near(projForBidItem({}, 0, 0, 4, 3300, true), 3300));

    console.log('\n[a line with quantity logged but no cost yet]');
    // Used to project $0 — (0 / rqty) * bidQty — burying a bid line that has
    // simply not had its costs keyed in yet. The bid is the honest estimate.
    assert('projects its bid, not $0',
      near(projForBidItem({}, 0, 250, 500, 40000, false), 40000),
      `got $${projForBidItem({}, 0, 250, 500, 40000, false).toFixed(2)}`);
    assert('  and still $0 when the line carries no bid either',
      near(projForBidItem({}, 0, 250, 500, 0, false), 0));

    console.log('\n[in-progress extrapolation is untouched]');
    // Half the quantity down at $100/unit → projects the full 100 units.
    assert('a half-done line still scales up by qty burn rate',
      near(projForBidItem({}, 5000, 50, 100, 9000, false), 10000));
    // Half the schedule elapsed → projects double the spend.
    assert('a half-elapsed line still scales up by time',
      near(projForBidItem({ start_date: '2026-07-05', target_date: '2026-09-03' }, 5000, 0, 0, 0, false), 10000));

    // ── The footer must equal the rows it sits under ─────────────────────────
    // The original complaint was a total that counted money no row showed. The
    // footer runs projectedCostForProject() while the rows run projForBidItem()
    // line by line; if those two ever disagree the table stops adding up.
    console.log('\n[the footer reconciles with the rows]');
    const bidItems = ROWS.map(([label, bidQty, uc, actual, rqty, start, target, done], i) => ({
      id: 'b' + i, cost_code: 'CC', sub_code: 'S' + i,
      quantity: bidQty, unit_cost: uc,
      start_date: start, target_date: target,
      _actual: actual, _rqty: rqty, _done: done,
    }));
    const lineActual = bidItems.reduce((s, b) => s + b._actual, 0);
    const mod = loadProjectionBlock(file, {
      actualForBidItem:     b => b._actual,
      runningQtyForBidItem: b => b._rqty,
      bidItemComplete:      b => b._done,
      dailyRowCost:         r => r.cost,
    });
    // A daily row carrying a bid line's own codes is on-bid, so no off-bid spend.
    const onBidRow  = { cost_code: 'CC', sub_code: 'S0', cost: lineActual };
    const onBidOnly = { id: 'p1', status: 'Active', bidItems, dailyRows: [onBidRow] };
    const rowSum = bidItems.reduce((s, b) =>
      s + mod.projForBidItem(b, b._actual, b._rqty, b.quantity, b.quantity * b.unit_cost, b._done), 0);
    assert('the project total is exactly the sum of the row projections',
      near(mod.projectedCostForProject(onBidOnly), rowSum),
      `footer $${mod.projectedCostForProject(onBidOnly).toFixed(2)} vs rows $${rowSum.toFixed(2)}`);
    assert('  and that total covers every row it shows',
      mod.projectedCostForProject(onBidOnly) >= lineActual);

    // Daily rows whose codes match no bid line are real money the per-line sum
    // cannot see, so they add ON TOP of it. Taking max(sumLines, actual) instead
    // silently drops them whenever un-started bid work is the larger number —
    // here $50k of off-bid spend hid behind $50,551.82 of un-started bid work.
    const offBidRow = { cost_code: 'ZZZ', sub_code: 'NOMATCH', cost: 50000 };
    const withOffBid = { ...onBidOnly, dailyRows: [onBidRow, offBidRow] };
    assert('off-bid spend adds to the project total, it does not just floor it',
      near(mod.projectedCostForProject(withOffBid), rowSum + 50000),
      `got $${mod.projectedCostForProject(withOffBid).toFixed(2)}, expected $${(rowSum + 50000).toFixed(2)}`);
    assert('  only unmatched codes count as off-bid',
      near(mod.offBidForProject(withOffBid).total, 50000),
      `got $${mod.offBidForProject(withOffBid).total.toFixed(2)}`);
    assert('  the total still covers total actual when off-bid spend dominates',
      mod.projectedCostForProject({ ...onBidOnly, dailyRows: [onBidRow, { ...offBidRow, cost: 900000 }] })
        >= lineActual + 900000 - 0.01);

    console.log('\n[a finished project cost what it cost]');
    for (const status of ['Complete', 'complete', 'Closed', 'closed']) {
      const donePrj = { ...onBidOnly, status, dailyRows: [{ cost: 12345 }] };
      assert(`status "${status}" projects its actual`,
        near(mod.projectedCostForProject(donePrj), 12345));
    }
    assert('an in-flight project does NOT collapse to its actual',
      mod.projectedCostForProject({ ...onBidOnly, status: 'Active' }) > 0
      && !near(mod.projectedCostForProject({ ...onBidOnly, status: 'Active', dailyRows: [{ cost: 1 }] }), 1));
  } finally {
    global.Date = RealDate;
  }
}

// ── Construction-schedule completion ────────────────────────────────────────
// Completion is no longer cosmetic: it settles a line's projection at its
// actual. tracker and kiewit both derive it from their Construction Schedule,
// so both have to read that schedule the same way. paving has no construction
// schedule at all — its completion is the Schedule-tab flag alone.
console.log('\n══════════ construction-schedule completion ══════════');
for (const file of ['tracker.html', 'kiewit-pinetree.html']) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const mod = new Function(
    `${extractFunction(src, '_bidCsKey')}
     ${extractFunction(src, '_csCompletionSet')}
     return { _csCompletionSet, _bidCsKey };`)();
  const set = rows => mod._csCompletionSet({ rows });
  const has = (s, cc, sc) => s.has(mod._bidCsKey(cc, sc));

  console.log(`\n[${file}]`);
  assert('a sub code whose only task is Complete counts as done',
    has(set([{ kind: 'task', code: 'CC', subcode: 'S1', status: 'Complete' }]), 'CC', 'S1'));
  assert('100% counts as done even without the status',
    has(set([{ kind: 'task', code: 'CC', subcode: 'S1', status: 'In Progress', pct: 100 }]), 'CC', 'S1'));
  assert('a half-finished second task keeps the sub code open',
    !has(set([
      { kind: 'task', code: 'CC', subcode: 'S1', status: 'Complete' },
      { kind: 'task', code: 'CC', subcode: 'S1', status: 'In Progress', pct: 40 },
    ]), 'CC', 'S1'));
  assert('  order does not matter',
    !has(set([
      { kind: 'task', code: 'CC', subcode: 'S1', status: 'In Progress', pct: 40 },
      { kind: 'task', code: 'CC', subcode: 'S1', status: 'Complete' },
    ]), 'CC', 'S1'));
  assert('matching ignores case and surrounding space',
    has(set([{ kind: 'task', code: ' cc ', subcode: ' s1 ', status: 'Complete' }]), 'CC', 'S1'));
  assert('non-task rows are ignored',
    set([{ kind: 'milestone', code: 'CC', subcode: 'S1', status: 'Complete' }]).size === 0);
  assert('tasks with no sub code are ignored',
    set([{ kind: 'task', code: 'CC', subcode: '', status: 'Complete' }]).size === 0);
  assert('a missing or empty schedule yields no completions',
    mod._csCompletionSet(null).size === 0 && set([]).size === 0);
}

// The wiring itself: a schedule that is never loaded leaves completion cold,
// which is what made the home page and the bid view disagree.
console.log('\n[the completion cache is actually populated]');
for (const file of ['tracker.html', 'kiewit-pinetree.html']) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  assert(`${file} warms every project's completion in one batch`,
    /async function _loadAllBidCsCompletion\(\)/.test(src) && /apiBatchGet\(ids\.map\(_csKey\)\)/.test(src));
  assert(`  ${file} calls it during init`, /await _loadAllBidCsCompletion\(\);/.test(src));
  assert(`  ${file} refreshes it when a bid view opens`, /_loadBidCsCompletion\(projId\);/.test(src));
}
{
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'paving.html'), 'utf8');
  assert('paving has no construction schedule, so nothing to warm',
    !/conschedule/.test(src) && !/_loadAllBidCsCompletion/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
