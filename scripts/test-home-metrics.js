#!/usr/bin/env node
'use strict';
/**
 * Tests for the Home tab summary strip.
 *
 * Run: node scripts/test-home-metrics.js
 *
 * Eight figures, and which jobs each one describes is the whole point:
 *
 *   Active Projects, Total Contract Value, Awarded Backlog, Total Bid Budget
 *   and Total Projected Profit describe the live BOOK — jobs IN PROGRESS plus
 *   jobs AWARDED and not yet started. Bidding, On Hold and finished work are
 *   out. This is what the company is committed to: the work under way and the
 *   work in front of it.
 *
 *   Total Actual Spend and Total Variance describe jobs that are IN PROGRESS
 *   alone. An awarded job carries a budget it has spent nothing against, so
 *   folding it in would report the company further under budget every time it
 *   won a job — these two exist to watch live work burn its budget.
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
              awCount, awContract, awBid, awProfit, awProfitBase,
              bookCount, bookContract, bookBid, bookProfit, bookProfitBase,
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
  // Awarded — the future half of the book. Its 5,555 of spend is deliberate:
  // a job that has started charging should have been moved to In Progress, and
  // the burn figures must not quietly absorb it while its status says otherwise.
  job({ id: 'g', name: 'Awarded',  status: 'Awarded',  contract: 777777, bid: 666666, actual: 5555, projected: 666666 }),
  // Awarded with no contract: its budget counts, its margin cannot.
  job({ id: 'i', name: 'Awarded Unpriced', status: 'Awarded', contract: 0, bid: 50000, actual: 0, projected: 50000 }),
  // Neither live, awarded nor complete — out of every figure.
  job({ id: 'f', name: 'Bidding',  status: 'Bidding',  contract: 999999, bid: 888888, actual: 7777, projected: 888888 }),
  job({ id: 'h', name: 'On Hold',  status: 'On Hold',  contract: 555555, bid: 444444, actual: 3333, projected: 444444 }),
];

// Named lookups — the fixtures above are re-ordered as the strip grows, and the
// "nothing to report" cases below must not silently start testing another job.
const byId = id => JOBS.find(j => j.id === id);

for (const file of FILES) {
  console.log(`\n══════════ ${file} ══════════`);
  const m = aggregate(file, JOBS);

  console.log('\n[the in-progress half of the book]');
  assert('counts the in-progress jobs', m.ipCount === 3, `got ${m.ipCount}`);
  assert('  Bidding and On Hold are in neither half', m.ipCount + m.awCount === 5,
    `got ${m.ipCount} + ${m.awCount}`);
  assert('sums in-progress contracts', near(m.ipContract, 800000), `got ${m.ipContract}`);
  assert('sums in-progress bids', near(m.ipBid, 740000), `got ${m.ipBid}`);

  console.log('\n[the awarded half — work won and not started]');
  assert('counts the awarded jobs', m.awCount === 2, `got ${m.awCount}`);
  assert('sums awarded contracts — the backlog figure',
    near(m.awContract, 777777), `got ${m.awContract}`);
  assert('  an awarded job with no contract adds nothing to it',
    !near(m.awContract, 777777 + 50000));
  assert('sums awarded bids', near(m.awBid, 716666), `got ${m.awBid}`);
  assert('  including the one with no contract, which still has a budget',
    m.awBid > m.awContract - 111111);

  console.log('\n[Active Projects, Contract Value and Bid Budget cover both halves]');
  assert('Active Projects counts in progress plus awarded',
    m.bookCount === 5, `got ${m.bookCount}`);
  assert('  which is more than the in-progress count alone', m.bookCount > m.ipCount);
  assert('Total Contract Value sums both halves',
    near(m.bookContract, 1577777), `got ${m.bookContract}`);
  assert('Total Bid Budget sums both halves',
    near(m.bookBid, 1456666), `got ${m.bookBid}`);

  console.log('\n[Actual Spend and Variance stay on live work]');
  assert('Total Actual Spend sums in-progress spend only',
    near(m.ipActual, 270000), `got ${m.ipActual}`);
  assert('  spend booked against an awarded job is not swept in',
    !near(m.ipActual, 270000 + 5555));
  assert('Total Variance is in-progress bid budget minus in-progress spend',
    near(m.ipVariance, 470000), `got ${m.ipVariance}`);
  assert('  and reads positive while under budget', m.ipVariance > 0);
  // The whole reason the two halves are kept apart: 716,666 of untouched
  // awarded budget would land here as money saved on work nobody has started.
  assert('  winning work does not make the company look further under budget',
    !near(m.ipVariance, 470000 + 716666));
  assert('  and the spend percentage is measured against the live budget',
    near(m.ipPct, 270000 / 740000 * 100), `got ${m.ipPct}`);

  console.log('\n[Total Projected Profit]');
  // In progress: (500,000 − 420,000) + (300,000 − 240,000). Awarded: 777,777 −
  // 666,666, the margin the job was bid at. Neither unpriced job contributes:
  // no contract means no revenue to subtract its cost from.
  assert('sums contract minus projected across in-progress jobs',
    near(m.ipProfit, 140000), `got ${m.ipProfit}`);
  assert('  a job with no contract does not drag it down',
    m.ipProfit > 0 && !near(m.ipProfit, 140000 - 90000));
  assert('  and its percentage base is only the jobs that contributed',
    near(m.ipProfitBase, 800000), `got ${m.ipProfitBase}`);
  assert('adds the margin awarded work was bid at',
    near(m.awProfit, 111111), `got ${m.awProfit}`);
  assert('  an awarded job with no contract does not drag it down either',
    !near(m.awProfit, 111111 - 50000));
  assert('  and its base is only the awarded jobs that contributed',
    near(m.awProfitBase, 777777), `got ${m.awProfitBase}`);
  assert('and the headline figure is both halves together',
    near(m.bookProfit, 251111), `got ${m.bookProfit}`);
  assert('  over a margin base of both halves together',
    near(m.bookProfitBase, 1577777), `got ${m.bookProfitBase}`);

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
  assert('  and the awarded and book totals come back zero too',
    empty.awCount === 0 && empty.awContract === 0 && empty.awBid === 0
    && empty.bookCount === 0 && empty.bookContract === 0 && empty.bookProfit === 0
    && empty.bookProfitBase === 0);
  const noneLive = aggregate(file, [byId('d'), byId('f')]);
  assert('with nothing in progress the live figures are zero',
    noneLive.ipCount === 0 && noneLive.ipBid === 0 && noneLive.ipProfit === 0);
  assert('  while completed work still reports its profit',
    near(noneLive.doneActProfit, 30000), `got ${noneLive.doneActProfit}`);
  // A division between jobs — everything won, nothing started — still has a
  // book worth reporting, and no live work to measure a burn against.
  const awaitingStart = aggregate(file, [byId('g'), byId('i')]);
  assert('with only awarded work the book still reports it',
    awaitingStart.bookCount === 2 && near(awaitingStart.bookContract, 777777)
    && near(awaitingStart.bookBid, 716666) && near(awaitingStart.bookProfit, 111111),
    `got ${awaitingStart.bookCount} / ${awaitingStart.bookContract} / ${awaitingStart.bookBid}`);
  assert('  while the burn figures stay flat rather than inventing a variance',
    awaitingStart.ipActual === 0 && awaitingStart.ipVariance === 0
    && awaitingStart.ipPct === 0);
}

// The labels the figures sit under, and the one they replaced.
console.log('\n══════════ labels ══════════');
const LABELS = ['Active Projects', 'Total Contract Value', 'Awarded Backlog', 'Total Bid Budget',
                'Total Actual Spend', 'Total Variance', 'Total Projected Profit', 'Total Actual Profit'];

// Which total each card is wired to. The arithmetic tests above prove the
// totals are right; these prove the right one reaches the screen, which is the
// half a rename or a copy-paste breaks silently.
const WIRING = [
  ['Active Projects reads the book count',            '>${bookCount}<'],
  ['Total Contract Value reads the book contract',    '$${fmt(bookContract, 0)}'],
  ['Awarded Backlog reads the awarded contracts',     '$${fmt(awContract, 0)}'],
  ['Total Bid Budget reads the book budget',          '$${fmt(bookBid, 0)}'],
  ['Total Actual Spend still reads in-progress spend', '$${fmt(ipActual, 0)}'],
  ['Total Variance still reads the in-progress variance', '${money0(ipVariance)}'],
  ['Total Projected Profit reads the book profit',    '${money0(bookProfit)}'],
];
for (const file of FILES) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  console.log(`\n[${file}]`);
  for (const l of LABELS) {
    assert(`${l} is on the strip`, src.includes(`<span class="home-metric-label">${l}</span>`));
  }
  for (const [label, wire] of WIRING) {
    assert(`  ${label}`, src.includes(wire), `no card reads ${wire}`);
  }
  // The subtitle carrying the scope is the only thing on screen saying which
  // jobs a figure covers, so a widened figure must not keep the old wording.
  assert('  and the spend subtitle names the budget it is a percentage of',
    src.includes('${fmtPct(ipPct)} of in-progress budget')
    && !src.includes('${fmtPct(ipPct)} of bid budget'));
  assert('  while the variance subtitle says it is live work only',
    src.includes("${ipVariance >= 0 ? 'under' : 'over'} budget · in progress"));

  // The old subtitle counted bid ITEMS with an Active status, so 55 projects
  // reported 149 active. There is no project status called Active at all.
  // The cards do not fit one flex row on most screens, and the values are
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
  // still projected a cost for every project to compute them. thisWeek joined
  // them when the daily-entry count came off the strip.
  const home = extractFunction(src, 'renderHomeTab');
  for (const dead of ['totalBid', 'totalActual', 'totalProjected', 'overallPct', 'overClass', 'ipProjected', 'thisWeek']) {
    assert(`  ${dead} is gone rather than computed and ignored`, !new RegExp(`\\b${dead}\\b`).test(home));
  }
  // Scoped to the aggregation loop — the projects table below it projects
  // costs too, legitimately, for its own rows.
  const agg = home.slice(home.indexOf('  let ipCount = 0'), home.indexOf('  const allDaily'));
  assert('  the aggregation projects a cost only where one is read',
    (agg.match(/projectedCostForProject\(/g) || []).length === 2
    && /if \(projContract\) \{ ipProfit \+= projContract - projectedCostForProject\(p\)/.test(agg)
    && /if \(projContract\) \{ awProfit \+= projContract - projectedCostForProject\(p\)/.test(agg),
    `${(agg.match(/projectedCostForProject\(/g) || []).length} calls in the loop`);

  // The strip is a financial summary. A count of the week's daily entries
  // measured how much got typed in, not how the work is going, and it held a
  // card every week nothing was at risk — the two figures shared one slot.
  assert('the weekly daily-entry count is off the strip',
    !/home-metric-sub">daily entries</.test(home) && !/'This Week'/.test(home));
  assert('  and At Risk, which shared its card, takes a slot only when it has one',
    /const atRiskHTML = atRiskCt === 0 \? '' :/.test(home)
    && /home-metric-label">At Risk<\/span>/.test(home));

  assert('the old bid-item "N active" subtitle is gone',
    !/home-metric-sub">\$\{statusCounts\.Active \|\| 0\} active/.test(src));
  assert('  and Active Projects counts projects whose status is In Progress',
    /if \(\(p\['status'\] \|\| ''\) === 'In Progress'\) \{\s*\n\s*ipCount\+\+;/.test(src));
  // Awarded is its own branch of the same chain, so a job counted there can
  // never also land in the in-progress totals.
  assert('  plus the ones whose status is Awarded, on their own branch',
    /\} else if \(\(p\['status'\] \|\| ''\) === 'Awarded'\) \{/.test(agg)
    && /\n\s*awCount\+\+;/.test(agg));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
