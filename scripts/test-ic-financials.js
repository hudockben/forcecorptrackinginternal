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

// ── Filters ─────────────────────────────────────────────────────────────────
// Run the page's own filter and summary functions, so these check behaviour
// rather than that the source mentions the right words.
console.log('\n[filters]');
const icFns = (() => {
  const grab = name => {
    const start = ic.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in intercompany.html`);
    let depth = 0;
    for (let j = ic.indexOf('{', start); j < ic.length; j++) {
      if (ic[j] === '{') depth++;
      else if (ic[j] === '}' && --depth === 0) return ic.slice(start, j + 1);
    }
    throw new Error(`${name} is not closed`);
  };
  const code = ['_icFilteredRows', '_icSummarise', 'icSetFilter', 'icClearFilters', 'icToggleStatus'].map(grab).join('\n\n');
  return new Function(`
    let _icFin = null, _icFilters = { division: '', statuses: null, q: '' };
    const _icAnyFilter = () => !!(_icFilters.division || _icFilters.statuses || (_icFilters.q || '').trim());
    function _renderIcFinancialsBody() {}
    function _renderIcFinancials() {}
    ${code}
    return {
      load: d => { _icFin = d; },
      set: (k, v) => icSetFilter(k, v),
      toggleStatus: v => icToggleStatus(v),
      statuses: () => _icFilters.statuses ? [..._icFilters.statuses] : null,
      pickStatuses: v => { _icFilters.statuses = v ? new Set(v) : null; },
      clear: () => icClearFilters(),
      rows: () => _icFilteredRows(),
      summarise: _icSummarise,
      any: () => _icAnyFilter(),
    };`)();
})();

const R = (o) => ({
  name: o.name, jobNumber: o.job, division: o.division, divisionName: o.division,
  status: o.status, inProgress: o.status === 'In Progress', complete: o.status === 'Complete',
  contract: o.contract, bid: o.bid, actual: o.actual, projected: o.projected,
  variance: o.bid - o.actual,
  profit: o.contract ? o.contract - o.projected : null,
  actProfit: (o.contract && o.actual) ? o.contract - o.actual : null,
});
const FEED = {
  rows: [
    R({ name: 'Franklin Regional Tennis Court', job: '26049', division: 'turf',   status: 'In Progress', contract: 479312, bid: 375931, actual: 353615, projected: 402408 }),
    R({ name: 'Moon Township',                  job: '26004', division: 'turf',   status: 'Awarded',     contract: 3426006, bid: 2708243, actual: 97921, projected: 2719835 }),
    R({ name: 'Atwood Borough',                 job: '26040', division: 'paving', status: 'In Progress', contract: 123894, bid: 106616, actual: 51390, projected: 84285 }),
    R({ name: 'Acquisition Costs',              job: '',      division: 'kiewit', status: 'In Progress', contract: 4100000, bid: 5191999, actual: 0, projected: 5191999 }),
    R({ name: 'Old Finished Job',               job: '25001', division: 'turf',   status: 'Complete',    contract: 200000, bid: 180000, actual: 170000, projected: 170000 }),
  ],
  divisions: [
    { key: 'turf', name: 'Turf', jobs: 3 },
    { key: 'paving', name: 'Paving', jobs: 1 },
    { key: 'kiewit', name: 'Kiewit', jobs: 1 },
  ],
};
icFns.load(FEED);

assert('unfiltered, every job is in', icFns.rows().length === 5);
assert('  and no filter is reported active', icFns.any() === false);
icFns.set('division', 'turf');
assert('filtering by division keeps only that division',
  icFns.rows().length === 3 && icFns.rows().every(r => r.division === 'turf'));
icFns.pickStatuses(['In Progress']);
assert('  division and status compose',
  icFns.rows().length === 1 && icFns.rows()[0].name.startsWith('Franklin'));
icFns.clear();
assert('clearing restores everything', icFns.rows().length === 5 && icFns.any() === false);
icFns.set('q', 'atwood');
assert('search matches a job name, case-insensitively',
  icFns.rows().length === 1 && icFns.rows()[0].division === 'paving');
icFns.set('q', '26049');
assert('  and a job number', icFns.rows().length === 1);
icFns.set('q', 'zzzz');
assert('  a search matching nothing returns nothing, not everything', icFns.rows().length === 0);
icFns.clear();

console.log('\n[more than one status at once]');
icFns.clear();
icFns.pickStatuses(['In Progress', 'Complete']);
assert('two statuses keep the jobs in either',
  icFns.rows().length === 4 && !icFns.rows().some(r => r.status === 'Awarded'),
  `${icFns.rows().length} rows`);
icFns.pickStatuses(['Awarded']);
assert('  narrowing to one keeps only that one',
  icFns.rows().length === 1 && icFns.rows()[0].name === 'Moon Township');
// Toggling is how the chips work: on a full set, the first click removes one.
icFns.clear();
icFns.toggleStatus('Awarded');
assert('toggling a chip off from "all" excludes just that status',
  icFns.rows().length === 4 && !icFns.rows().some(r => r.status === 'Awarded'),
  JSON.stringify(icFns.statuses()));
icFns.toggleStatus('Awarded');
assert('  toggling it back on stores no filter rather than a set of everything',
  icFns.statuses() === null && icFns.rows().length === 5 && icFns.any() === false,
  'or the bar reads as filtered while excluding nothing');
icFns.clear();

console.log('\n[the figures follow the filters]');
// Filtering to Kiewit leaves the one job that is bid above its contract.
icFns.set('division', 'kiewit');
const kiewit = icFns.summarise(icFns.rows());
assert('a filtered summary covers only the filtered rows',
  kiewit.activeProjects === 1 && near(kiewit.contract, 4100000), JSON.stringify(kiewit));
assert('  and its projected profit is the loss on that job',
  near(kiewit.projProfit, -1091999), `got ${kiewit.projProfit}`);
assert('  with no completed job, actual profit is unknown rather than zero',
  kiewit.actProfit === null);
icFns.clear();
const all = icFns.summarise(icFns.rows());
assert('unfiltered, Awarded work stays out of the live figures',
  all.activeProjects === 3 && !near(all.contract, 4100000 + 479312 + 123894 + 3426006),
  `got ${all.activeProjects} active`);
assert('  and the completed job supplies the actual profit',
  near(all.actProfit, 30000), `got ${all.actProfit}`);

console.log('\n[the page wires them up]');
assert('the summary is recomputed from the filtered rows, not the server totals',
  /const t = _icSummarise\(rows\);/.test(ic) && !/const t = _icFin\.totals/.test(ic));
assert('  the division rows too', /shownDivs\.map\(divRow\)/.test(ic));
assert('an empty result says whether a filter caused it',
  /_icAnyFilter\(\)[\s\S]{0,120}No matches/.test(ic));
assert('typing does not rebuild the filter bar under the caret',
  /function icSetFilter[\s\S]{0,220}_renderIcFinancialsBody\(\);/.test(ic)
  && !/function icSetFilter[\s\S]{0,220}_renderIcFinancialsFilters\(\)/.test(ic));
assert('the filter bar is hidden when printing',
  /@media print \{ \.ic-fin-filters \{ display: none/.test(ic));

console.log('\n[the status chips]');
assert('statuses are chips, not a single-pick dropdown',
  /class="ic-chip/.test(ic) && /onclick="icToggleStatus\(/.test(ic)
  && !/icSetFilter\('status'/.test(ic));
assert('  a picked chip is visibly on', /\.ic-chip\.on \{/.test(ic));
assert('  a blank status is still listed and reachable',
  /\(blank\)/.test(ic) && /r\.status \|\| ''/.test(ic));
assert('no filter key that no longer exists is read',
  !/_icFilters\.status\b/.test(ic));

console.log('\n[export and print]');
assert('the export ships the filtered rows, not the whole feed',
  /function exportIcFinancialsCSV\(\) \{\s*\n\s*const rows = _icFilteredRows\(\);/.test(ic)
  && /rows\.forEach\(r => lines\.push\(\[/.test(ic));
assert('  and totals them from the same set', /const t = _icSummarise\(rows\);\s*\n\s*lines\.push/.test(ic));
assert('print refuses when the filters leave nothing',
  /function printIcFinancials\(\) \{\s*\n\s*if \(!_icFilteredRows\(\)\.length\) return;/.test(ic));
assert('Excel export exists', /function exportIcFinancialsCSV/.test(ic));
assert('  values go out unformatted so Excel can total them',
  /Number\(v\)\.toFixed\(2\)/.test(ic) && /\\ufeff/.test(ic));
assert('  and a figure that does not apply is blank, not zero',
  /const n = v => \(v === null \|\| v === undefined\) \? '' :/.test(ic));
assert('print exists and hides the chrome',
  /function printIcFinancials/.test(ic) && /@media print[\s\S]{0,240}rpt-toolbar[^}]*display: none/.test(ic));
// printIcFinancials() is a plain window.print(), so the print stylesheet alone
// decides which report reaches the paper. It used to un-hide the Job Summary
// panel by ID, which printed that report whichever sub-tab was on screen —
// the Financials button produced the wrong report entirely.
assert('  and prints the open sub-tab, not a hardcoded one',
  /\.rpt-sub-panel\.active \{ display: block !important/.test(ic)
  && !/#rpt-job-summary \{ display: block !important/.test(ic),
  'the print rules name a panel by ID instead of following .active');

console.log('\n[it is styled for the dark page it sits on]');
// The page is dark (--bg #0a0a0f, --text #e0e0e0). Hardcoded light colours
// here rendered near-black text and a white zebra stripe on a dark table.
const block = ic.slice(ic.indexOf('/* ── Intercompany Financials report'),
                       ic.indexOf('.rpt-sub-panel { display: none; }'));
const screenCss = block.slice(0, block.indexOf('@media print'));
assert('no hardcoded hex colours outside the print rules',
  !/#[0-9a-fA-F]{3,6}/.test(screenCss),
  (screenCss.match(/#[0-9a-fA-F]{3,6}/g) || []).join(', '));
assert('  it uses the page\'s own theme variables',
  /color: var\(--text\)/.test(screenCss) && /color: var\(--muted\)/.test(screenCss)
  && /border-bottom: 1px solid var\(--border\)/.test(screenCss));
assert('  profit and loss use the theme green and red',
  /\.ic-pos \{ color: var\(--green\); \}/.test(screenCss)
  && /\.ic-neg \{ color: var\(--red\); \}/.test(screenCss));
assert('  the zebra stripe is a tint, not a pale fill',
  /nth-child\(even\) td \{ background: rgba\(255,255,255,0\.0\d\)/.test(screenCss),
  'a light stripe on a dark table reads as a different table');
// Paper is white whatever the screen is.
const printCss = block.slice(block.indexOf('@media print'));
assert('printing inverts to dark-on-white rather than sending a dark page',
  /body \{ background: #fff !important; color: #111 !important; \}/.test(printCss));
assert('  and the figures stay legible on paper',
  /\.ic-fin-table td \{ color: #111 !important/.test(printCss)
  && /\.ic-pos \{ color: #15803d !important/.test(printCss));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
