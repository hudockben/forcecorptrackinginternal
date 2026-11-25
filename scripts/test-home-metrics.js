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
 *   Total GP Earned to Date describes EVERY job with a contract and spend,
 *   whatever its status. Each job earns its contract in proportion to the
 *   work in place (cost to date over projected cost), so the figure means the
 *   same thing on a live job as on a finished one. It covered completed jobs
 *   only while it was contract minus cost-to-date — that set the whole
 *   contract against part of the cost, and over live work would have posted
 *   most of every contract as profit before the work was built.
 *
 * The last block checks the two figures that have left the strip: the weekly
 * daily-entry count, dropped, and the pending-PO count, which moved to the
 * Purchase Orders tab and is exercised there.
 *
 * The aggregation is lifted out of renderHomeTab() and run over fixtures, so
 * these check the arithmetic rather than the markup around it.
 *
 * Turf (tracker.html) and Paving (paving.html) no longer carry that strip.
 * Their Home tab splits every won job into three stages — Completed, In
 * Progress, Awarded — each with its own totals and the same figures year by
 * year. The rules above carry over stage by stage: spend and variance are
 * shown for live and finished work but never for awarded work, and the old
 * book figures are the In Progress and Awarded sections added together. The
 * second block checks those sections, and the year each job counts under.
 */

const fs   = require('fs');
const path = require('path');

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
// Kiewit still opens on the eight-figure strip; Turf and Paving break the
// same figures out by stage and year.
const STRIP_FILES = ['kiewit-pinetree.html'];
const STAGE_FILES = ['tracker.html', 'paving.html'];

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

  // Counts projections per job: projecting is the expensive part of the loop.
  const projCalls = {};
  const out = new Function('projectsList', 'dailyRowCost', 'projIsDone', 'projectedCostForProject', 'fmt',
    `${contractHelperCode(src)}
     ${extractFunction(src, 'gpEarnedToDate')}
     ${block}
     return { ipCount, ipContract, ipBid, ipActual, ipProfit, ipProfitBase,
              awCount, awContract, awBid, awProfit, awProfitBase,
              bookCount, bookContract, bookBid, bookProfit, bookProfitBase,
              gpEarned, gpCount, gpDone, ipVariance, ipPct };`
  )(
    projects,
    r => r.cost || 0,
    p => ['complete', 'closed'].includes((p && p['status'] || '').toLowerCase()),
    p => { projCalls[p.id] = (projCalls[p.id] || 0) + 1; return p._projected; },
    (n, d = 2) => Number(n).toFixed(d),
  );
  return { ...out, projCalls };
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
  // Completed — counted in GP Earned to Date, at contract minus final cost.
  job({ id: 'd', name: 'Done A', status: 'Complete', contract: 200000, bid: 180000, actual: 170000, projected: 170000 }),
  job({ id: 'e', name: 'Done B', status: 'Complete', contract: 100000, bid: 95000, actual: 110000, projected: 110000 }),
  // Awarded — the future half of the book. Its 5,555 of spend is deliberate:
  // a job that has started charging should have been moved to In Progress, and
  // the burn figures must not quietly absorb it while its status says otherwise.
  job({ id: 'g', name: 'Awarded',  status: 'Awarded',  contract: 777777, bid: 666666, actual: 5555, projected: 666666 }),
  // Awarded with no contract: its budget counts, its margin cannot.
  job({ id: 'i', name: 'Awarded Unpriced', status: 'Awarded', contract: 0, bid: 50000, actual: 0, projected: 50000 }),
  // Neither live, awarded nor complete — out of every figure but GP Earned to
  // Date, which is earned on the work in place whatever the status says.
  job({ id: 'f', name: 'Bidding',  status: 'Bidding',  contract: 999999, bid: 888888, actual: 7777, projected: 888888 }),
  job({ id: 'h', name: 'On Hold',  status: 'On Hold',  contract: 555555, bid: 444444, actual: 3333, projected: 444444 }),
];

// Named lookups — the fixtures above are re-ordered as the strip grows, and the
// "nothing to report" cases below must not silently start testing another job.
const byId = id => JOBS.find(j => j.id === id);

for (const file of STRIP_FILES) {
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

  console.log('\n[Total GP Earned to Date covers the work in place]');
  // Each job earns contract × (actual ÷ projected), less actual:
  //   Live A   500,000 × 150/420 − 150,000      =  28,571.43
  //   Live B   300,000 × 100/240 − 100,000      =  25,000.00
  //   Done A   200,000 − 170,000                =  30,000.00
  //   Done B   100,000 − 110,000                = −10,000.00
  //   Awarded  777,777 × 5,555/666,666 − 5,555  =     925.83
  //   Bidding  999,999 × 7,777/888,888 − 7,777  =     972.12
  //   On Hold  555,555 × 3,333/444,444 − 3,333  =     833.25
  // The two jobs with no contract earn nothing, and the awarded one with no
  // spend has earned nothing yet.
  assert('sums the gross profit each job has earned so far',
    near(m.gpEarned, 76302.64), `got ${m.gpEarned}`);
  assert('  a live job earns its share, not contract minus spend',
    !near(m.gpEarned, 76302.64 - 28571.43 + (500000 - 150000)));
  assert('  a completed job that lost money pulls it down', m.gpEarned < 76302.64 + 10000);
  assert('  it counts the jobs behind it', m.gpCount === 7, `got ${m.gpCount}`);
  assert('  and how many of those are finished', m.gpDone === 2, `got ${m.gpDone}`);
  assert('each job is projected at most once, however many figures read it',
    Object.values(m.projCalls).every(n => n === 1), JSON.stringify(m.projCalls));
  assert('  and a job with no contract, which no figure here can read, is never projected',
    !m.projCalls.c && !m.projCalls.i, JSON.stringify(m.projCalls));

  console.log('\n[nothing to report]');
  const empty = aggregate(file, []);
  assert('no projects gives zeroes, not NaN',
    empty.ipCount === 0 && empty.ipContract === 0 && empty.ipVariance === 0
    && empty.gpEarned === 0 && empty.gpCount === 0 && empty.ipPct === 0);
  assert('  and the awarded and book totals come back zero too',
    empty.awCount === 0 && empty.awContract === 0 && empty.awBid === 0
    && empty.bookCount === 0 && empty.bookContract === 0 && empty.bookProfit === 0
    && empty.bookProfitBase === 0);
  const noneLive = aggregate(file, [byId('d'), byId('f')]);
  assert('with nothing in progress the live figures are zero',
    noneLive.ipCount === 0 && noneLive.ipBid === 0 && noneLive.ipProfit === 0);
  assert('  while work already in place still reports what it earned',
    near(noneLive.gpEarned, 30000 + 972.12) && noneLive.gpDone === 1, `got ${noneLive.gpEarned}`);
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

// ── Turf and Paving: jobs by stage and year ─────────────────────────────────
// The same lift-and-run, over the stage aggregation that replaced the strip's.
function aggregateStages(file, projects) {
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const home = extractFunction(src, 'renderHomeTab');
  const from = home.indexOf('  const homeStageOf');
  const to   = home.indexOf('  const allDaily');
  if (from < 0 || to < 0) throw new Error(`stage aggregation block not found in ${file}`);
  const projCalls = {};
  const out = new Function('projectsList', 'dailyRowCost', 'projIsDone', 'projectedCostForProject', 'fmt',
    `${contractHelperCode(src)}
     ${extractFunction(src, 'gpEarnedToDate')}
     ${extractFunction(src, '_dailySortDate')}
     ${extractFunction(src, '_homeJobYear')}
     ${home.slice(from, to)}
     return { stageTotals, stageYears };`
  )(
    projects,
    r => r.cost || 0,
    p => ['complete', 'closed'].includes((p && p['status'] || '').toLowerCase()),
    p => { projCalls[p.id] = (projCalls[p.id] || 0) + 1; return p._projected; },
    (n, d = 2) => Number(n).toFixed(d),
  );
  return { ...out, projCalls };
}

function jobYear(file) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  return new Function(`${extractFunction(src, '_dailySortDate')}
    ${extractFunction(src, '_homeJobYear')}
    return _homeJobYear;`)();
}

// The strip's fixtures, dated, plus a substantially complete job. Unless the
// fixture says how its cost splits across its days (costs), every daily row
// carries the job's whole cost on its first date; the rest are $0, there only
// to set the span of dates the job was worked.
const dated = (o) => {
  const j = job(o);
  j['start-date'] = o.start || '';
  j['end-date']   = o.end || '';
  if (o.days) j.dailyRows = o.days.map((d, i) => ({ date: d, cost: o.costs ? o.costs[i] : i === 0 ? o.actual : 0 }));
  return j;
};
const STAGED = [
  // In progress: A started 2026; B was set to start in 2026 but its first
  // daily entry is 2025, and the work done wins over the plan; the unpriced
  // one has undated rows only, so it reads its Start Date.
  dated({ id: 'a', name: 'Live A', status: 'In Progress', contract: 500000, bid: 400000, actual: 150000, projected: 420000,
          days: ['2026-04-02', '2026-06-10'] }),
  dated({ id: 'b', name: 'Live B', status: 'In Progress', contract: 300000, bid: 250000, actual: 100000, projected: 240000,
          start: '2026-03-01', days: ['2025-10-01', '2026-05-01'], costs: [60000, 40000] }),
  dated({ id: 'c', name: 'Live Unpriced', status: 'In Progress', contract: 0, bid: 90000, actual: 20000, projected: 90000,
          start: '2026-05-01' }),
  // Completed: A finished in 2025 by its last entry, whatever its plan said;
  // B has no dated rows and reads its Projected Completion.
  dated({ id: 'd', name: 'Done A', status: 'Complete', contract: 200000, bid: 180000, actual: 170000, projected: 170000,
          end: '2026-06-01', days: ['2025-05-01', '2025-08-30'] }),
  dated({ id: 'e', name: 'Done B', status: 'Complete', contract: 100000, bid: 95000, actual: 110000, projected: 110000,
          end: '2026-07-01' }),
  // Field work done, last costs still landing: it sits with Completed, at its
  // projected profit.
  dated({ id: 's', name: 'Nearly Done', status: 'Substantially Complete', contract: 400000, bid: 350000, actual: 300000,
          projected: 340000, days: ['2026-06-01', '2026-10-15'] }),
  // Awarded: one scheduled for 2027 (with early spend that must stay out of
  // live burn), one with no dates at all.
  dated({ id: 'g', name: 'Awarded', status: 'Awarded', contract: 777777, bid: 666666, actual: 5555, projected: 666666,
          start: '2027-04-01', end: '2027-09-01' }),
  dated({ id: 'i', name: 'Awarded Unpriced', status: 'Awarded', contract: 0, bid: 50000, actual: 0, projected: 50000 }),
  // In no stage.
  dated({ id: 'f', name: 'Bidding', status: 'Bidding', contract: 999999, bid: 888888, actual: 7777, projected: 888888,
          start: '2026-01-01' }),
  dated({ id: 'h', name: 'On Hold', status: 'On Hold', contract: 555555, bid: 444444, actual: 3333, projected: 444444,
          start: '2026-01-01' }),
];

for (const file of STAGE_FILES) {
  console.log(`\n══════════ ${file} — jobs by stage & year ══════════`);
  const { stageTotals: T, stageYears: Y, projCalls } = aggregateStages(file, STAGED);

  console.log('\n[every won job lands in exactly one stage]');
  assert('three in progress, three completed, two awarded',
    T.ip.jobs === 3 && T.done.jobs === 3 && T.aw.jobs === 2, `got ${T.ip.jobs} / ${T.done.jobs} / ${T.aw.jobs}`);
  assert('  Bidding and On Hold are in none of them',
    !['ip', 'done', 'aw'].some(k => T[k].list.some(j => j.name === 'Bidding' || j.name === 'On Hold')));
  assert('  and are never projected', !projCalls.f && !projCalls.h, JSON.stringify(projCalls));
  assert('Substantially Complete counts with Completed, and is flagged',
    T.done.list.some(j => j.name === 'Nearly Done' && j.subst) && T.done.subst === 1);

  console.log('\n[In Progress carries the live figures]');
  assert('contract', near(T.ip.contract, 800000), `got ${T.ip.contract}`);
  assert('bid budget', near(T.ip.bid, 740000), `got ${T.ip.bid}`);
  assert('actual spend — live work only', near(T.ip.actual, 270000), `got ${T.ip.actual}`);
  assert('  spend booked against an awarded job is not swept in', !near(T.ip.actual, 270000 + 5555));
  assert('projected profit, from the jobs with a contract', near(T.ip.profit, 140000) && near(T.ip.profitBase, 800000),
    `got ${T.ip.profit} over ${T.ip.profitBase}`);
  // Live A 500,000 × 150/420 − 150,000 = 28,571.43; Live B 300,000 × 100/240 − 100,000 = 25,000.
  assert('GP earned to date on the work in place', near(T.ip.gp, 53571.43) && T.ip.gpJobs === 2, `got ${T.ip.gp}`);
  assert('  the unpriced job is counted but carries no contract', T.ip.noContract === 1);

  console.log('\n[Completed carries what the jobs closed at]');
  assert('contract', near(T.done.contract, 700000), `got ${T.done.contract}`);
  assert('bid budget', near(T.done.bid, 625000), `got ${T.done.bid}`);
  assert('actual cost', near(T.done.actual, 580000), `got ${T.done.actual}`);
  // 200,000 − 170,000, plus 100,000 − 110,000, plus 400,000 − 340,000 projected.
  assert('GP: contract less final cost, projected for the substantially complete job',
    near(T.done.profit, 80000), `got ${T.done.profit}`);

  console.log('\n[Awarded carries the backlog]');
  assert('backlog is the awarded contracts', near(T.aw.contract, 777777), `got ${T.aw.contract}`);
  assert('bid budget includes the unpriced job', near(T.aw.bid, 716666), `got ${T.aw.bid}`);
  assert('projected profit is the margin it was bid at', near(T.aw.profit, 111111) && near(T.aw.profitBase, 777777));
  assert('  and nothing on it is counted as earned', T.aw.gp === 0 && T.aw.gpJobs === 0);

  console.log('\n[the old strip figures are the In Progress and Awarded sections added]');
  assert('Total Contract Value', near(T.ip.contract + T.aw.contract, 1577777));
  assert('Total Bid Budget', near(T.ip.bid + T.aw.bid, 1456666));
  assert('Total Projected Profit', near(T.ip.profit + T.aw.profit, 251111));

  console.log('\n[each stage breaks down by year]');
  assert('In Progress: 2026 holds A and the unpriced job, 2025 holds B (its first entry beats its plan)',
    Y.ip['2026']?.jobs === 2 && Y.ip['2025']?.jobs === 1 && Y.ip['2025']?.list[0].name === 'Live B',
    JSON.stringify(Object.keys(Y.ip)));
  assert('Completed: 2025 by A\'s last entry, 2026 for B\'s plan and the nearly-done job',
    Y.done['2025']?.list.map(j => j.name).join() === 'Done A' && Y.done['2026']?.jobs === 2,
    JSON.stringify(Object.keys(Y.done)));
  assert('Awarded: 2027 by its Start Date, and a job with no dates under ""',
    Y.aw['2027']?.jobs === 1 && Y.aw['']?.list.map(j => j.name).join() === 'Awarded Unpriced',
    JSON.stringify(Object.keys(Y.aw)));
  for (const k of ['ip', 'done', 'aw']) {
    const sum = f => Object.values(Y[k]).reduce((s, c) => s + c[f], 0);
    assert(`  ${k}: the years add up to the stage totals`,
      ['jobs', 'contract', 'bid', 'actual', 'profit', 'profitBase', 'gp', 'gpJobs', 'subst', 'noContract']
        .every(f => near(sum(f), T[k][f])));
  }
  assert('each job is projected at most once', Object.values(projCalls).every(n => n === 1), JSON.stringify(projCalls));
  assert('  and a job no figure can read — no contract — never is', !projCalls.c && !projCalls.i, JSON.stringify(projCalls));

  // The hover breakdown lists these records, so a figure can only show what
  // it really added up if every bucket's records sum to the bucket.
  console.log('\n[every figure keeps the jobs it was summed from]');
  const FIGS = ['contract', 'bid', 'actual', 'profit', 'profitBase', 'gp', 'gpJobs'];
  for (const k of ['ip', 'done', 'aw']) {
    const buckets = [['all years', T[k]], ...Object.entries(Y[k])];
    assert(`  ${k}: each bucket's job records add up to its figures`,
      buckets.every(([, c]) => c.list.length === c.jobs
        && FIGS.every(f => near(c.list.reduce((s, j) => s + j[f], 0), c[f]))),
      buckets.map(([y, c]) => `${y}: ${c.list.length}/${c.jobs}`).join(', '));
  }
  const rec = id => T.ip.list.concat(T.done.list, T.aw.list).find(j => j.id === id);
  assert('a year row and its stage total share the same record', Y.ip['2025'].list[0] === rec('b'));
  assert('a record says which date put it in its year',
    rec('b').basis.year === '2025' && rec('b').basis.from === 'first daily entry' && rec('b').basis.date === '2025-10-01'
    && rec('e').basis.from === 'Projected Completion' && rec('g').basis.from === 'Start Date'
    && rec('i').basis.year === '' && rec('i').basis.from === '', JSON.stringify(rec('b').basis));
  assert('  and how its cost splits across the years its entries are dated in',
    near(rec('b').actualByYear['2025'], 60000) && near(rec('b').actualByYear['2026'], 40000)
    && Object.keys(rec('b').actualByYear).length === 2, JSON.stringify(rec('b').actualByYear));
  assert('  undated entries split out under "", still part of the cost',
    near(rec('c').actualByYear[''], 20000) && near(rec('c').actual, 20000), JSON.stringify(rec('c').actualByYear));
  assert('  the projected cost behind its profit, only where it has a contract',
    near(rec('a').cost, 420000) && rec('c').cost === null && rec('i').cost === null && near(rec('e').cost, 110000));
  // Live A: 150/420 complete, so it has earned 500,000 × 150/420 = 178,571.43.
  assert('  and the earned share behind its GP, only on live work with a contract and spend',
    near(rec('a').earned.pct, 150 / 420) && near(rec('a').earned.earned, 178571.43) && near(rec('a').earned.gp, rec('a').gp)
    && rec('c').earned === null && rec('g').earned === null && rec('d').earned === null);
  const co = aggregateStages(file, [dated({ id: 'co', name: 'With COs', status: 'In Progress', contract: 20000,
    bid: 0, actual: 0, days: ['2026-05-01'] })].map(j => ({ ...j,
    bidItems: [{ quantity: 10, unit_cost: 1000, change_orders: [{ qty_delta: 2 }, { qty_delta: -1 }] }] })));
  assert('  and its bid lines apart from what change orders added',
    near(co.stageTotals.ip.list[0].bidLines, 10000) && near(co.stageTotals.ip.list[0].bid, 11000),
    JSON.stringify({ lines: co.stageTotals.ip.list[0].bidLines, bid: co.stageTotals.ip.list[0].bid }));

  console.log('\n[the year a job counts under]');
  const basisOf = jobYear(file);
  const yr = (p, stage) => basisOf(p, stage).year;
  const rows = (...ds) => ds.map(date => ({ date }));
  assert('Completed reads its last daily entry over its plan',
    yr({ dailyRows: rows('2025-03-01', '2026-01-10'), 'end-date': '2025-12-01' }, 'done') === '2026');
  assert('  then its Projected Completion, then its Start Date',
    yr({ 'end-date': '2024-11-01', 'start-date': '2023-05-01' }, 'done') === '2024'
    && yr({ 'start-date': '2023-05-01' }, 'done') === '2023');
  assert('In Progress reads its first daily entry over its plan',
    yr({ dailyRows: rows('2026-05-01', '2025-10-03'), 'start-date': '2026-04-01' }, 'ip') === '2025');
  assert('  then its Start Date, then its Projected Completion',
    yr({ 'start-date': '2026-04-01', 'end-date': '2027-01-01' }, 'ip') === '2026'
    && yr({ 'end-date': '2027-01-01' }, 'ip') === '2027');
  assert('Awarded reads its Start Date, then its Projected Completion',
    yr({ 'start-date': '2027-03-01', 'end-date': '2028-08-01' }, 'aw') === '2027'
    && yr({ 'end-date': '2028-08-01' }, 'aw') === '2028');
  assert('an imported M/D/YYYY entry still reads', yr({ dailyRows: rows('10/3/2025') }, 'ip') === '2025');
  assert('a blank daily date is skipped, not read as today',
    yr({ dailyRows: rows('', '2024-06-01') }, 'done') === '2024');
  assert('no dates at all gives ""', yr({}, 'aw') === '' && yr({ dailyRows: rows('') }, 'done') === '');
  const b1 = basisOf({ dailyRows: rows('10/3/2025', '2026-02-01'), 'start-date': '2026-04-01' }, 'ip');
  assert('it names the date it read, in ISO form',
    b1.from === 'first daily entry' && b1.date === '2025-10-03', JSON.stringify(b1));
  const b2 = basisOf({ 'end-date': '2027-08-01' }, 'aw');
  assert('  whichever date that was', b2.from === 'Projected Completion' && b2.date === '2027-08-01', JSON.stringify(b2));

  console.log('\n[nothing to report]');
  const empty = aggregateStages(file, []);
  assert('no projects gives empty stages, not NaN',
    ['ip', 'done', 'aw'].every(k => empty.stageTotals[k].jobs === 0 && empty.stageTotals[k].contract === 0
      && Object.keys(empty.stageYears[k]).length === 0));
}

// The labels the figures sit under, and the one they replaced.
console.log('\n══════════ labels ══════════');
const LABELS = ['Active Projects', 'Total Contract Value', 'Awarded Backlog', 'Total Bid Budget',
                'Total Actual Spend', 'Total Variance', 'Total Projected Profit', 'Total GP Earned to Date'];

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
  ['Total GP Earned to Date reads the earned total',  '${money0(gpEarned)}'],
];
// What each Turf / Paving stage shows on its totals strip.
const STAGE_TILES = {
  done: ['Completed Jobs', 'Contract Value', 'Bid Budget', 'Actual Cost', 'Variance', 'Gross Profit'],
  ip:   ['Jobs In Progress', 'Contract Value', 'Bid Budget', 'Actual Spend', 'Variance', 'Projected Profit',
         'GP Earned to Date'],
  aw:   ['Awarded Jobs', 'Awarded Backlog', 'Bid Budget', 'Projected Profit'],
};

for (const file of FILES) {
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const home = extractFunction(src, 'renderHomeTab');
  console.log(`\n[${file}]`);

  if (STRIP_FILES.includes(file)) {
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
    const cards = (src.match(/<div class="home-metric-item/g) || []).length;
    assert(`  ${cards} cards are on the strip`, cards >= LABELS.length);

    // Scoped to the aggregation loop — the projects table below it projects
    // costs too, legitimately, for its own rows.
    const agg = home.slice(home.indexOf('  let ipCount = 0'), home.indexOf('  const allDaily'));
    // Three figures read a projection now, so it is memoised per job rather
    // than called at each — the behaviour is pinned by projCalls above.
    assert('  the aggregation projects through one memoised call',
      (agg.match(/projectedCostForProject\(/g) || []).length === 1
      && /if \(projContract\) \{ ipProfit \+= projContract - projCost\(\)/.test(agg)
      && /if \(projContract\) \{ awProfit \+= projContract - projCost\(\)/.test(agg)
      && /gpEarnedToDate\(projContract, projActual, projCost\(\)\)/.test(agg),
      `${(agg.match(/projectedCostForProject\(/g) || []).length} calls in the loop`);

    // The strip is a financial summary. A count of the week's daily entries
    // measured how much got typed in, not how the work is going, and it held a
    // card every week nothing was at risk — the two figures shared one slot.
    assert('  At Risk, which shared its card with the weekly count, takes a slot only when it has one',
      /const atRiskHTML = atRiskCt === 0 \? '' :/.test(home)
      && /home-metric-label">At Risk<\/span>/.test(home));

    assert('  Active Projects counts projects whose status is In Progress',
      /if \(\(p\['status'\] \|\| ''\) === 'In Progress'\) \{\s*\n\s*ipCount\+\+;/.test(src));
    // Awarded is its own branch of the same chain, so a job counted there can
    // never also land in the in-progress totals.
    assert('  plus the ones whose status is Awarded, on their own branch',
      /\} else if \(\(p\['status'\] \|\| ''\) === 'Awarded'\) \{/.test(agg)
      && /\n\s*awCount\+\+;/.test(agg));
  } else {
    // Turf and Paving: the single strip is gone, and its figures sit in the
    // stage sections, each drawn on the same shared strip component.
    assert('the eight-figure strip is gone', !src.includes('<div class="home-metric-strip">'));
    for (const l of LABELS.filter(l => l !== 'Awarded Backlog')) {
      assert(`  "${l}" with it`, !home.includes(`>${l}</span>`) && !home.includes(`label: '${l}'`));
    }
    const stageDef = k => {
      const from = home.indexOf(`{ key: '${k}',`);
      const next = ['done', 'ip', 'aw'].map(o => home.indexOf(`{ key: '${o}',`)).filter(i => i > from);
      return from < 0 ? '' : home.slice(from, next.length ? Math.min(...next) : home.indexOf('const tileHTML'));
    };
    for (const [k, labels] of Object.entries(STAGE_TILES)) {
      const def = stageDef(k);
      assert(`${k} totals: ${labels.join(', ')}`, labels.every(l => def.includes(`label: '${l}'`)),
        labels.filter(l => !def.includes(`label: '${l}'`)).join(', '));
    }
    // The strip kept spend and variance off awarded work for a reason that
    // still holds: an untouched budget reads as money saved.
    const aw = stageDef('aw');
    assert('  and Awarded shows no spend, variance or earned GP, by year or in total',
      aw && !/\['(actual|pct|variance|gp)',/.test(aw) && !/label: '(Actual|Variance|GP Earned)/.test(aw));
    assert('each stage draws its totals on the shared strip component',
      home.includes('class="home-metric-strip stage-strip"')
      && home.includes('<span class="home-metric-label">${x.label}</span>'));
    // Every figure names its stage, year and field, which is what the hover
    // breakdown is built from — the totals tiles with '*' for all years.
    assert('every tile carries the figure its breakdown lists',
      home.includes('data-sb="${st.key}|*|${x.f}"')
      && (home.match(/\{ f: '(jobs|contract|bid|actual|variance|profit|gp)',/g) || []).length === 17);
    assert('  and so does every cell of every year row, the year included',
      home.includes('<td data-sb="${st.key}|${y}|year">${y || \'No date\'}</td>')
      && home.includes('<td data-sb="${st.key}|${y}|${k}">${CELL[k](c)}</td>'));
    assert('  the plain-text row tooltip it replaced is gone', !home.includes('stageRowTip'));
    assert('  the breakdown is rebuilt on every draw, and a pinned one follows its figure',
      home.includes('_homeStageTipBuild = (key, full) =>')
      && /`;\n  _stageTipAfterRender\(\);\n  loadDeadlines\(\);/.test(home));
    const tipCode = home.slice(home.indexOf('// ── How each figure was compiled'), home.indexOf('// ── Status bar widths'));
    assert('  job names reach it escaped', tipCode.includes('_cbEsc(j.name)') && !/\$\{j\.name\}/.test(tipCode));

    const agg = home.slice(home.indexOf('  const homeStageOf'), home.indexOf('  const allDaily'));
    assert('  the aggregation projects through one memoised call',
      (agg.match(/projectedCostForProject\(/g) || []).length === 1
      && agg.includes('if (projContract) { cost = projCost(); job.profit = projContract - cost;')
      && agg.includes('gpEarnedToDate(projContract, projActual, projCost())'),
      `${(agg.match(/projectedCostForProject\(/g) || []).length} calls in the loop`);
    for (const dead of ['ipCount', 'ipContract', 'ipBid', 'ipActual', 'ipProfit', 'ipProfitBase', 'awCount',
                        'awContract', 'awBid', 'awProfit', 'awProfitBase', 'bookCount', 'bookContract', 'bookBid',
                        'bookProfit', 'bookProfitBase', 'ipVariance', 'ipPct', 'ipOverClass', 'gpCount', 'gpDone']) {
      assert(`  the strip's ${dead} is gone with it`, !new RegExp(`\\b${dead}\\b`).test(home));
    }
    // At Risk counts bid items across every job, so it belongs to no stage.
    assert('At Risk rides on the section heading, and only when it has one',
      /const atRiskHTML = atRiskCt === 0 \? '' :/.test(home)
      && home.includes('Jobs by Stage &amp; Year${atRiskHTML}'));
  }

  // The strip component itself is still in use on every page.
  // The cards do not fit one flex row on most screens, and the values are
  // nowrap + ellipsis over min-width:0 — without wrapping the money gets cut
  // off mid-number, which on a financial strip reads as a different figure.
  const strip = src.slice(src.indexOf('.home-metric-strip {'), src.indexOf('.home-metric-label {'));
  assert('the strip wraps rather than squeezing the figures',
    /\.home-metric-strip\s*\{[^}]*flex-wrap:\s*wrap/.test(strip), strip.slice(0, 160));
  assert('  and each card keeps a readable width',
    /\.home-metric-item\s*\{[^}]*flex:\s*1 1 \d+px/.test(strip));

  // The old portfolio-wide totals fed nothing after the rebuild, but the loop
  // still projected a cost for every project to compute them. thisWeek and
  // openPOs joined them when their two cards left the strip.
  for (const dead of ['totalBid', 'totalActual', 'totalProjected', 'overallPct', 'overClass',
                      'ipProjected', 'thisWeek', 'openPOs']) {
    assert(`  ${dead} is gone rather than computed and ignored`, !new RegExp(`\\b${dead}\\b`).test(home));
  }
  assert('the weekly daily-entry count is off the Home tab',
    !/home-metric-sub">daily entries</.test(home) && !/'This Week'/.test(home));

  // Open POs counted a queue that lives two tabs away, and its card was the
  // only clickable one on the strip — a card that navigated rather than
  // reported. The count moved to the queue; the hover rule went with it.
  assert('the pending-PO count is off the strip',
    !/home-metric-label">Open POs</.test(src));
  assert('  and it turns up on the Purchase Orders tab instead',
    /\$\{pendingPOs\} pending approval/.test(extractFunction(src, 'renderPOTab')));
  assert('  with no clickable-card rule left over',
    !/home-metric-item\.clickable/.test(src));

  // The old subtitle counted bid ITEMS with an Active status, so 55 projects
  // reported 149 active. There is no project status called Active at all.
  assert('the old bid-item "N active" subtitle is gone',
    !/home-metric-sub">\$\{statusCounts\.Active \|\| 0\} active/.test(src));
}

// ── Where the pending-PO count went ──────────────────────────────────────────
// On the strip it was a number that navigated: clicking it jumped to the
// Purchase Orders tab and replaced poFilters wholesale. On the tab it is the
// number and the filter at once, so it has to leave the tab's other filters
// standing — including on the way back out.
console.log('\n══════════ the pending-PO chip ══════════');
function poChip(file, filters) {
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const code = extractFunction(src, 'poPendingOnly') + '\n' + extractFunction(src, 'togglePOPending');
  return new Function('poFilters', 'poPage', 'renderPOTab',
    `${code}\nreturn { only: poPendingOnly, toggle: togglePOPending };`
  )(filters, 0, () => {});
}

for (const file of FILES) {
  console.log(`\n[${file}]`);
  // A filter on another column, to prove the chip does not clear the board.
  const filters = { supplier: new Set(['Acme']) };
  const chip = poChip(file, filters);

  assert('reads as off while no status filter is set', !chip.only());
  chip.toggle();
  assert('clicking it narrows the table to the pending orders',
    chip.only() && filters.status.has('pending') && filters.status.size === 1);
  assert('  without disturbing the other column filters', filters.supplier.has('Acme'));
  chip.toggle();
  assert('clicking it again widens the table back',
    !chip.only() && !('status' in filters));
  assert('  and still leaves the other column filters standing', filters.supplier.has('Acme'));

  // Clear Filters was the only way back before, and it took the search and
  // every other column filter with it.
  filters.status = new Set(['pending', 'approved']);
  assert('a status filter wider than pending does not read as the pending view',
    !chip.only());
  chip.toggle();
  assert('  and clicking from there narrows to pending rather than clearing',
    chip.only() && filters.status.size === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
