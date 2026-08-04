#!/usr/bin/env node
'use strict';
/**
 * Tests for Intercompany ▸ Reports ▸ Financials — every division's jobs in one
 * table — and the /api/executive/financials endpoint behind it.
 *
 * Run: node scripts/test-ic-financials.js
 *
 * Two things matter most here:
 *
 *   It must NOT reuse the executive portfolio. That one is a curated summary —
 *   capped at 12 projects, completed jobs dropped unless pinned, filtered by a
 *   job-number cutoff. Actual Profit is the profit on FINISHED jobs, so a feed
 *   that drops completed work reports it as zero forever.
 *
 *   The cost logic must stay in one place. Three copies across the division
 *   pages produced three bugs in this codebase, one of which made the profit
 *   column mean different things on different pages. A fourth copy in the
 *   intercompany page would be repeating that.
 */

const fs   = require('fs');
const path = require('path');
const root = p => path.resolve(__dirname, '..', p);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 0.01;

// ── The endpoint ────────────────────────────────────────────────────────────
console.log('\n══════════ api/executive/financials.js ══════════');
const fin    = require(root('api/executive/financials.js'));
const report = require(root('api/executive/report.js'));
const finSrc = fs.readFileSync(root('api/executive/financials.js'), 'utf8');

console.log('\n[it reuses the cost logic rather than copying it]');
for (const fn of ['readTurfProjects', 'readPavingProjects', 'readKiewitProjects', 'buildFinancials']) {
  assert(`report.js exports ${fn}`, typeof report[fn] === 'function');
}
assert('the endpoint requires report.js', /require\('\.\/report'\)/.test(finSrc));
assert('  and does not reimplement the projection',
  !/projForBidItem|running_item_cost|elapsed/.test(finSrc),
  'a second copy of the projection is how the division pages drifted apart');

console.log('\n[every division that runs jobs is covered]');
for (const d of ['turf', 'paving', 'kiewit']) {
  assert(`${d} is read`, new RegExp(`key: '${d}'`).test(finSrc));
}
assert('trucking, dust and quarry are not — they have no bids or contracts',
  !/'trucking'|'dust'|'quarry'/.test(finSrc));

console.log('\n[it is not the curated executive portfolio]');
assert('no 12-project cap', !/slice\(0, ?12\)/.test(finSrc));
assert('no executive job-number cutoff', !/projMeetsExecCutoff/.test(finSrc));
assert('completed jobs are kept, since Actual Profit is about them',
  /complete:\s*report\.projIsComplete/.test(finSrc)
  && !/!projIsComplete\(p\)/.test(finSrc));
assert('it is gated on intercompany access, not executive',
  /hasDivisionAccess\(payload, 'intercompany'\)/.test(finSrc));
assert('  and rejects a caller without it', /403/.test(finSrc));

console.log('\n[a division failing does not blank the rest]');
assert('each division read is caught individually',
  /catch \(err\) \{[\s\S]{0,180}return \{ division: d, projects: \[\], fin: null, error: true \}/.test(finSrc));

// summarise() is the arithmetic the report leans on, so drive it directly.
console.log('\n[the summary splits live work from finished work]');
const summarise = (() => {
  const start = finSrc.indexOf('function summarise(');
  let depth = 0;
  for (let j = finSrc.indexOf('{', start); j < finSrc.length; j++) {
    if (finSrc[j] === '{') depth++;
    else if (finSrc[j] === '}' && --depth === 0) {
      return new Function(`${finSrc.slice(start, j + 1)}; return summarise;`)();
    }
  }
})();
const row = o => ({
  inProgress: o.status === 'In Progress', complete: o.status === 'Complete',
  contract: o.contract, bid: o.bid, actual: o.actual, projected: o.projected,
  profit: o.contract ? o.contract - o.projected : null,
  actProfit: (o.contract && o.actual) ? o.contract - o.actual : null,
});
const SAMPLE = [
  row({ status: 'In Progress', contract: 500000, bid: 400000, actual: 150000, projected: 420000 }),
  row({ status: 'In Progress', contract: 300000, bid: 250000, actual: 100000, projected: 240000 }),
  row({ status: 'In Progress', contract: 0,      bid: 90000,  actual: 20000,  projected: 90000  }),
  row({ status: 'Complete',    contract: 200000, bid: 180000, actual: 170000, projected: 170000 }),
  row({ status: 'Complete',    contract: 100000, bid: 95000,  actual: 110000, projected: 110000 }),
  row({ status: 'Bidding',     contract: 999999, bid: 888888, actual: 7777,   projected: 888888 }),
];
const s = summarise(SAMPLE);
assert('Active Projects counts only In Progress', s.activeProjects === 3, `got ${s.activeProjects}`);
assert('  Bidding is excluded', s.activeProjects !== 4);
assert('Contract Value sums live jobs', near(s.contract, 800000), `got ${s.contract}`);
assert('Bid Budget sums live jobs', near(s.bid, 740000), `got ${s.bid}`);
assert('Actual Spend sums live jobs', near(s.actual, 270000), `got ${s.actual}`);
assert('Variance is bid minus actual', near(s.variance, 470000), `got ${s.variance}`);
assert('Projected Profit skips the job with no contract',
  near(s.projProfit, 140000), `got ${s.projProfit}`);
assert('  and bases its percentage only on jobs that contributed',
  near(s.projProfitBase, 800000), `got ${s.projProfitBase}`);
assert('Actual Profit covers completed jobs only',
  near(s.actProfit, 20000), `got ${s.actProfit}`);
assert('  and a completed job that lost money pulls it down', s.actProfit < 30000);
assert('  counting them', s.completedJobs === 2, `got ${s.completedJobs}`);
const none = summarise([]);
assert('nothing to report gives nulls for profit, not zero',
  none.activeProjects === 0 && none.projProfit === null && none.actProfit === null,
  'zero profit is a claim; unknown profit is not');

// ── The page ────────────────────────────────────────────────────────────────
console.log('\n══════════ intercompany.html ══════════');
const ic = fs.readFileSync(root('intercompany.html'), 'utf8');

console.log('\n[it sits under Reports, as asked]');
assert('a Financials subtab button exists',
  /data-sub="financials" onclick="switchRptSubTab\('financials'\)"/.test(ic));
assert('  inside the Reports tab', ic.indexOf('data-sub="financials"') > ic.indexOf('id="tab-reports"'));
assert('  with a panel switchRptSubTab can reach', /id="rpt-financials"/.test(ic));
assert('  and it is not under Analytics',
  ic.indexOf('data-sub="financials"') > ic.indexOf('id="tab-analytics"')
  ? ic.indexOf('id="rpt-financials"') > ic.indexOf('id="tab-reports"') : true);

console.log('\n[it reads the shared endpoint]');
assert('it fetches /executive/financials', /\/executive\/financials/.test(ic));
assert('  with the bearer token', /executive\/financials[\s\S]{0,160}Bearer/.test(ic));
assert('  and does not compute costs itself',
  !/projForBidItem|projectedCostForProject|offBidForProject/.test(ic),
  'the whole point of the endpoint');

console.log('\n[what it shows]');
for (const h of ['Contract Value', 'Bid Budget', 'Actual Spend', 'Variance', 'Projected Profit', 'Actual Profit']) {
  assert(`the division summary carries ${h}`, ic.includes(`>${h}</th>`));
}
assert('every job is listed with its division',
  /<th>Job Name<\/th><th>Job #<\/th><th>Division<\/th><th>Status<\/th>/.test(ic));
assert('the basis of each profit is stated on the page',
  /Actual Profit covers\s*\n?\s*<strong>completed<\/strong> jobs/.test(ic));
assert('a failed division is marked rather than silently dropped',
  /\(unavailable\)/.test(ic));

console.log('\n[export and print]');
assert('Excel export exists', /function exportIcFinancialsCSV/.test(ic));
assert('  values go out unformatted so Excel can total them',
  /Number\(v\)\.toFixed\(2\)/.test(ic) && /\\ufeff/.test(ic));
assert('  and a figure that does not apply is blank, not zero',
  /const n = v => \(v === null \|\| v === undefined\) \? '' :/.test(ic));
assert('print exists and hides the chrome',
  /function printIcFinancials/.test(ic) && /@media print[\s\S]{0,200}rpt-toolbar \{ display: none/.test(ic));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
