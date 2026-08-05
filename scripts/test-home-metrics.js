#!/usr/bin/env node
'use strict';
/**
 * Tests for the Home tab summary strip.
 *
 * Run: node scripts/test-home-metrics.js
 *
 * Seven figures, and which jobs each one describes is the whole point:
 *
 *   Active Projects, Total Contract Value, Total Bid Budget, Total Actual
 *   Spend, Total Variance and Total Projected Profit all describe jobs that
 *   are IN PROGRESS. Bidding, Awarded, On Hold and finished work are out.
 *
 *   Total Actual Profit describes COMPLETED jobs instead. Realised profit only
 *   means anything once a job is done; totalling it over live work would
 *   report a margin against costs that have not finished landing.
 *
 * The aggregation is lifted out of renderHomeTab() and run over fixtures, so
 * these check the arithmetic rather than the markup around it.
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

// paving.html routes every contract read through projectContract(), which
// folds in contract change orders; the other division files still inline the
// fallback chain. Pull the real helpers in where they exist so this exercises
// production code either way.
const CONTRACT_HELPERS = ['contractCOs', 'contractCOTotal', 'originalContract', 'revisedContract', 'projectContract'];
function contractHelperCode(src) {
  if (!src.includes('function projectContract(')) {
    return `function projectContract(p) { return parseFloat(p['revised-amount']) || parseFloat(p['contract-amount']) || parseFloat(p['contract-value']) || 0; }`;
  }
  return CONTRACT_HELPERS.map(n => extractFunction(src, n)).join('\n');
}

// The strip's aggregation lives inside renderHomeTab, between the totals
// declaration and the derived percentages. Lift that span and run it.
function aggregate(file, projects) {
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const home = extractFunction(src, 'renderHomeTab');
  const from = home.indexOf('  let ipCount = 0');
  // Stops before getAllDailyRows() and the PO counts, which are unrelated to
  // the money figures and would need stubbing for nothing.
  const to   = home.indexOf('  const allDaily');
  if (from < 0 || to < 0) throw new Error(`aggregation block not found in ${file}`);
  const block = home.slice(from, to);

  return new Function('projectsList', 'dailyRowCost', 'projIsDone', 'projectedCostForProject', 'fmt',
    `${contractHelperCode(src)}
     ${block}
     return { ipCount, ipContract, ipBid, ipActual, ipProfit, ipProfitBase,
              doneActProfit, doneCount, ipVariance, ipPct };`
  )(
    projects,
    r => r.cost || 0,
    p => ['complete', 'closed'].includes((p && p['status'] || '').toLowerCase()),
    p => p._projected,
    (n, d = 2) => Number(n).toFixed(d),
  );
}

// _projected is supplied directly so these tests check the strip's arithmetic,
// not the projection engine, which test-projected-cost.js already covers.
const job = (o) => ({
  id: o.id, 'project-name': o.name, status: o.status, 'contract-amount': o.contract,
  bidItems: [{ quantity: 1, unit_cost: o.bid }],
  dailyRows: [{ cost: o.actual }],
  _projected: o.projected === undefined ? o.bid : o.projected,
});

const JOBS = [
  // In progress — these drive the first six figures.
  job({ id: 'a', name: 'Live A', status: 'In Progress', contract: 500000, bid: 400000, actual: 150000, projected: 420000 }),
  job({ id: 'b', name: 'Live B', status: 'In Progress', contract: 300000, bid: 250000, actual: 100000, projected: 240000 }),
  // In progress with no contract: costs count, profit cannot.
  job({ id: 'c', name: 'Live Unpriced', status: 'In Progress', contract: 0, bid: 90000, actual: 20000, projected: 90000 }),
  // Completed — drives Actual Profit only.
  job({ id: 'd', name: 'Done A', status: 'Complete', contract: 200000, bid: 180000, actual: 170000, projected: 170000 }),
  job({ id: 'e', name: 'Done B', status: 'Complete', contract: 100000, bid: 95000, actual: 110000, projected: 110000 }),
  // Not in progress and not complete — out of every figure.
  job({ id: 'f', name: 'Bidding',  status: 'Bidding',  contract: 999999, bid: 888888, actual: 7777, projected: 888888 }),
  job({ id: 'g', name: 'Awarded',  status: 'Awarded',  contract: 777777, bid: 666666, actual: 5555, projected: 666666 }),
  job({ id: 'h', name: 'On Hold',  status: 'On Hold',  contract: 555555, bid: 444444, actual: 3333, projected: 444444 }),
];

for (const file of FILES) {
  console.log(`\n══════════ ${file} ══════════`);
  const m = aggregate(file, JOBS);

  console.log('\n[the first six figures cover work in progress]');
  assert('Active Projects counts in-progress jobs only', m.ipCount === 3, `got ${m.ipCount}`);
  assert('  Bidding, Awarded and On Hold are not counted as active', m.ipCount !== 6);
  assert('Total Contract Value sums in-progress contracts',
    near(m.ipContract, 800000), `got ${m.ipContract}`);
  assert('Total Bid Budget sums in-progress bids',
    near(m.ipBid, 740000), `got ${m.ipBid}`);
  assert('Total Actual Spend sums in-progress spend',
    near(m.ipActual, 270000), `got ${m.ipActual}`);
  assert('Total Variance is bid budget minus actual spend',
    near(m.ipVariance, 470000), `got ${m.ipVariance}`);
  assert('  and reads positive while under budget', m.ipVariance > 0);

  console.log('\n[Total Projected Profit]');
  // (500,000 − 420,000) + (300,000 − 240,000). The unpriced job contributes
  // nothing: no contract means no revenue to subtract its cost from.
  assert('sums contract minus projected across in-progress jobs',
    near(m.ipProfit, 140000), `got ${m.ipProfit}`);
  assert('  a job with no contract does not drag it down',
    m.ipProfit > 0 && !near(m.ipProfit, 140000 - 90000));
  assert('  and its percentage base is only the jobs that contributed',
    near(m.ipProfitBase, 800000), `got ${m.ipProfitBase}`);

  console.log('\n[Total Actual Profit covers finished work]');
  // (200,000 − 170,000) + (100,000 − 110,000) = 30,000 − 10,000.
  assert('sums contract minus actual across completed jobs',
    near(m.doneActProfit, 20000), `got ${m.doneActProfit}`);
  assert('  a completed job that lost money pulls it down', m.doneActProfit < 30000);
  assert('  and it counts the completed jobs', m.doneCount === 2, `got ${m.doneCount}`);
  assert('  in-progress jobs are not in it',
    !near(m.doneActProfit, 20000 + (500000 - 150000)));

  console.log('\n[nothing to report]');
  const empty = aggregate(file, []);
  assert('no projects gives zeroes, not NaN',
    empty.ipCount === 0 && empty.ipContract === 0 && empty.ipVariance === 0
    && empty.doneActProfit === 0 && empty.ipPct === 0);
  const noneLive = aggregate(file, [JOBS[3], JOBS[5]]);
  assert('with nothing in progress the live figures are zero',
    noneLive.ipCount === 0 && noneLive.ipBid === 0 && noneLive.ipProfit === 0);
  assert('  while completed work still reports its profit',
    near(noneLive.doneActProfit, 30000), `got ${noneLive.doneActProfit}`);
}

// The labels the figures sit under, and the one they replaced.
console.log('\n══════════ labels ══════════');
const LABELS = ['Active Projects', 'Total Contract Value', 'Total Bid Budget', 'Total Actual Spend',
                'Total Variance', 'Total Projected Profit', 'Total Actual Profit'];
for (const file of FILES) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  console.log(`\n[${file}]`);
  for (const l of LABELS) {
    assert(`${l} is on the strip`, src.includes(`<span class="home-metric-label">${l}</span>`));
  }
  // The old subtitle counted bid ITEMS with an Active status, so 55 projects
  // reported 149 active. There is no project status called Active at all.
  // Nine cards do not fit one flex row on most screens, and the values are
  // nowrap + ellipsis over min-width:0 — without wrapping the money gets cut
  // off mid-number, which on a financial strip reads as a different figure.
  const strip = src.slice(src.indexOf('.home-metric-strip {'), src.indexOf('.home-metric-label {'));
  assert('the strip wraps rather than squeezing the figures',
    /\.home-metric-strip\s*\{[^}]*flex-wrap:\s*wrap/.test(strip), strip.slice(0, 160));
  assert('  and each card keeps a readable width',
    /\.home-metric-item\s*\{[^}]*flex:\s*1 1 \d+px/.test(strip));
  const cards = (src.match(/<div class="home-metric-item/g) || []).length;
  assert(`  ${cards} cards are on the strip`, cards >= LABELS.length);

  // The old portfolio-wide totals fed nothing after the rebuild, but the loop
  // still projected a cost for every project to compute them.
  const home = extractFunction(src, 'renderHomeTab');
  for (const dead of ['totalBid', 'totalActual', 'totalProjected', 'overallPct', 'overClass', 'ipProjected']) {
    assert(`  ${dead} is gone rather than computed and ignored`, !new RegExp(`\\b${dead}\\b`).test(home));
  }
  // Scoped to the aggregation loop — the projects table below it projects
  // costs too, legitimately, for its own rows.
  const agg = home.slice(home.indexOf('  let ipCount = 0'), home.indexOf('  const allDaily'));
  assert('  the aggregation projects a cost only where one is read',
    (agg.match(/projectedCostForProject\(/g) || []).length === 1
    && /if \(projContract\) \{ ipProfit \+= projContract - projectedCostForProject\(p\)/.test(agg),
    `${(agg.match(/projectedCostForProject\(/g) || []).length} calls in the loop`);

  assert('the old bid-item "N active" subtitle is gone',
    !/home-metric-sub">\$\{statusCounts\.Active \|\| 0\} active/.test(src));
  assert('  and Active Projects counts projects whose status is In Progress',
    /if \(\(p\['status'\] \|\| ''\) === 'In Progress'\) \{\s*\n\s*ipCount\+\+;/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
