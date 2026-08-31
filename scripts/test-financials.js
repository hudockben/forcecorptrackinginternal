#!/usr/bin/env node
'use strict';
/**
 * Tests for the Analytics ▸ Financials subtab.
 *
 * Run: node scripts/test-financials.js
 *
 * One row per job: contract, bid, actual, projected, profit, status. The two
 * things worth pinning down are the ones a reader would otherwise have to take
 * on trust:
 *
 *   Profit is contract minus PROJECTED final cost, not minus cost-to-date.
 *   The rest of the app defines it that way (bid view header, PDF export, the
 *   Home projects table), and cost-to-date would flatter a half-spent job into
 *   looking twice as profitable as it will finish. Projected is shown on the
 *   row so the subtraction is visible rather than asserted.
 *
 *   A job with no contract amount has no revenue to subtract from, so its
 *   profit cell is "—" and it stays out of the profit total. Treating a blank
 *   contract as $0 would post the job's entire cost as a loss on a job that
 *   simply hasn't had its contract keyed in yet.
 *
 * The renderer is lifted out of each division page and run against a stub DOM,
 * so these assert on the HTML actually produced.
 */

const fs   = require('fs');
const path = require('path');

// The print path calls dwWrite(), which report-branding.js defines on window.
// The real module is loaded rather than stubbed: printFinancials() produces a
// document a person receives on paper, and a fake dwWrite would let this file
// and scripts/test-report-branding.js drift apart over what branding actually
// does to it. The IIFE only reads `window`, so a bare object is enough.
const BRANDING = (() => {
  const win = {};
  new Function('window', fs.readFileSync(path.resolve(__dirname, '..', 'report-branding.js'), 'utf8'))(win);
  if (typeof win.dwWrite !== 'function') throw new Error('report-branding.js no longer defines dwWrite');
  return win;
})();

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const FIN_HEADERS = ['Job Name', 'Job #', 'Status', 'Contract Value', 'Bid Budget', 'Actual', 'Projected Cost', 'Projected Profit', 'Actual Profit'];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

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

// The whole Financials block — filter state, table, export and print all live
// together — plus the real projection chain it depends on, over a stub DOM.
const CHAIN = ['offBidForProject', 'projIsDone', 'projForBidItem', 'projectedCostForProject', 'statusBadgeClass'];

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

function loadFinancials(file, projects) {
  const src   = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const start = src.indexOf('/* ── Financials ───');
  const end   = src.indexOf('function renderSubCodePerf');
  if (start < 0 || end < 0) throw new Error(`Financials block not found in ${file}`);
  const code = contractHelperCode(src) + '\n\n'
             + CHAIN.map(n => extractFunction(src, n)).join('\n\n') + '\n\n' + src.slice(start, end);

  const bar = { innerHTML: '' }, table = { innerHTML: '' };
  // rowCost counts how often the per-project cost walk runs, which is how the
  // cost of a re-render is measured below.
  const captured = { csv: null, print: '', alerts: [], download: null, rowCost: 0 };
  // Enough of the job-name dropdown for its real open/apply/clear to run.
  const dd = {
    panel:  { style: { display: 'none' } },
    list:   { innerHTML: '', querySelectorAll: () => dd.boxes },
    search: { value: '', oninput: null },
    all:    { checked: true, addEventListener() {} },
    boxes:  [],
  };

  const api = new Function(
    'projectsList', 'document', 'window', 'alert', 'Blob', 'URL',
    'dailyRowCost', 'fmt', 'esc',
    'actualForBidItem', 'runningQtyForBidItem', 'bidItemComplete', 'getProj',
    'dwWrite', 'dwBrand',
    `${code}
     return {
       renderFinancials, exportFinancialsCSV, printFinancials,
       setFilters: f => { finFilters = { q: f.q || '', statuses: f.statuses || null, names: f.names || null }; },
       pickNames: n => { finFilters.names = n ? new Set(n) : null; },
       picked: () => finFilters.names ? [...finFilters.names] : null,
       applyNames: applyFinFilter, clearNames: clearFinFilter,
       openNames: btn => openFinFilter('names', btn), openStatuses: btn => openFinFilter('statuses', btn),
       pickStatuses: v => { finFilters.statuses = v ? new Set(v) : null; },
       pickedStatuses: () => finFilters.statuses ? [...finFilters.statuses] : null,
       rows: _financialsRows, filtered: _financialsFiltered,
       totals: _financialsTotals, renderTable: _renderFinancialsTable,
     };`
  )(
    projects,
    {
      getElementById: id => ({
        'fin-content': bar,
        'fin-table': table,
        'fin-filter-dd': dd.panel,
        'finff-list': dd.list,
        'finff-search': dd.search,
        'finff-all': dd.all,
      }[id] || null),
      // The job-name checklist queries its boxes by class.
      querySelectorAll: sel => (sel === '.finff-val-cb' ? dd.boxes : []),
      createElement: () => ({ href: '', download: '', click() { captured.download = this.download; } }),
    },
    { open: () => ({ document: { write: (...chunks) => { captured.print += chunks.join(''); }, close() {} } }) },
    m => captured.alerts.push(m),
    function (parts) { captured.csv = parts.join(''); },
    { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    r => { captured.rowCost++; return r.cost || 0; },
    (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
    s => String(s || '').replace(/"/g, '&quot;'),
    (b, id) => (b._actual || 0),
    (b, id) => (b._rqty || 0),
    (b, id) => !!b._done,
    () => null,
    BRANDING.dwWrite, BRANDING.dwBrand,
  );

  return {
    ...api,
    captured,
    dd,
    // Stand the checklist up as if the user had ticked these boxes, so Apply's
    // real logic runs against it.
    tickBoxes: (names, ticked) => {
      dd.boxes = names.map(v => ({ value: v, checked: ticked.includes(v), addEventListener() {} }));
      dd.all.checked = dd.boxes.every(b => b.checked);
    },
    // What the user sees: filter bar plus the table it controls.
    html: () => bar.innerHTML + table.innerHTML,
  };
}

// Back-compat helper for the assertions that only care about rendered HTML.
function render(file, projects) {
  const f = loadFinancials(file, projects);
  f.renderFinancials();
  return f.html();
}

// A complete bid line projects at exactly its actual, which keeps the
// arithmetic in most expectations obvious. rqty/done are overridable so a job
// can be left mid-flight, where Projected Profit and Actual Profit diverge.
const job = (o) => ({
  id: o.id, 'project-name': o.name, 'job-number': o.job, status: o.status,
  'contract-amount': o.contract,
  bidItems: [{
    cost_code: 'CC', sub_code: 'S1', quantity: 1, unit_cost: o.bid,
    _actual: o.actual, _rqty: o.rqty === undefined ? 1 : o.rqty,
    _done: o.done === undefined ? true : o.done,
  }],
  dailyRows: [{ cost_code: 'CC', sub_code: 'S1', cost: o.actual }],
});

const JOBS = [
  job({ id: 'a', name: 'Franklin Regional Tennis Court', job: '1042', status: 'In Progress',   contract: 479312.32, bid: 375931.05, actual: 261562.30 }),
  job({ id: 'b', name: 'Saint Edmunds Field',            job: '1039', status: 'Complete', contract: 210000,    bid: 180000,    actual: 195000 }),
  job({ id: 'c', name: 'No Contract Yet',                job: '1044', status: 'In Progress',   contract: 0,         bid: 50000,     actual: 12000 }),
  // A quarter of the quantity down: projects to $400,000 against $100,000 spent,
  // so the two profit columns must not agree.
  job({ id: 'd', name: 'Half Built Job',                 job: '1001', status: 'In Progress',   contract: 1000000,   bid: 500000,    actual: 100000, rqty: 0.25, done: false }),
  // Contract signed, nothing spent — the case that would read as pure margin
  // if Actual Profit were contract minus zero.
  job({ id: 'e', name: 'Not Started Job',                job: '1002', status: 'In Progress',   contract: 800000,    bid: 600000,    actual: 0,      rqty: 0,    done: false }),
];

for (const file of FILES) {
  console.log(`\n══════════ ${file} ══════════`);
  const html = render(file, JOBS);
  const rowOf = name => {
    const i = html.indexOf(name);
    if (i < 0) return '';
    const start = html.lastIndexOf('<tr', i);
    return html.slice(start, html.indexOf('</tr>', i));
  };

  console.log('\n[every job is listed with the agreed column names]');
  assert('the header uses the agreed vocabulary',
    ['Job Name', 'Job #', 'Status', 'Contract Value', 'Bid Budget', 'Actual', 'Projected Cost', 'Projected Profit', 'Actual Profit']
      .every(h => html.includes(`>${h}</th>`)));
  assert('  the old names are gone',
    !/>Contract<\/th>|>Bid<\/th>|>Projected<\/th>|>Profit<\/th>/.test(html));
  assert('every job appears', JOBS.every(j => html.includes(j['project-name'])));
  assert('the count is shown in the heading', html.includes('(5 jobs)'));

  console.log('\n[a job in progress]');
  const a = rowOf('Franklin Regional Tennis Court');
  assert('shows its job number',      a.includes('1042'));
  assert('shows its status',          a.includes('In Progress'));
  assert('shows the contract amount', a.includes('$479,312.32'), a);
  assert('shows the bid amount',      a.includes('$375,931.05'));
  assert('shows the actual cost',     a.includes('$261,562.30'));
  // Complete line → projection settles at actual → profit = 479,312.32 - 261,562.30.
  assert('profit is contract minus projected, not minus bid',
    a.includes('$217,750.02'), a);
  assert('  and carries a margin percentage', /\(45\.4%\)/.test(a));

  console.log('\n[a finished job that went over]');
  const b = rowOf('Saint Edmunds Field');
  assert('a completed job costs what it cost', b.includes('$195,000.00'));
  assert('profit is $15,000 on a $210,000 contract', b.includes('$15,000.00'));

  console.log('\n[a job with no contract amount]');
  const c = rowOf('No Contract Yet');
  assert('its costs are still listed', c.includes('$12,000.00') && c.includes('$50,000.00'));
  assert('neither profit is a fabricated loss',
    !c.includes('-$12,000.00'), c);
  assert('the table says why it is excluded from the total',
    html.includes('no contract amount'));

  console.log('\n[the two profit columns are different numbers]');
  const d = rowOf('Half Built Job');
  assert('a quarter-built job projects $400,000', d.includes('$400,000.00'), d);
  assert('Projected Profit is contract minus projected ($600,000)', d.includes('$600,000.00'), d);
  assert('Actual Profit is contract minus spend to date ($900,000)', d.includes('$900,000.00'), d);

  console.log('\n[a signed job that has not started]');
  const e = rowOf('Not Started Job');
  assert('it still projects its bid', e.includes('$600,000.00'));
  assert('Projected Profit is contract minus bid ($200,000)', e.includes('$200,000.00'));
  assert('Actual Profit stays blank rather than posting the contract as margin',
    !e.includes('$800,000.00</span>') && !/\(100\.0%\)/.test(e), e);

  console.log('\n[totals]');
  assert('contract total sums every job',   html.includes('$2,489,312.32'));
  assert('actual total sums every job',     html.includes('$568,562.30'));
  assert('project cost total sums every job', html.includes('$1,468,562.30'));
  assert('Projected Profit total covers only jobs with a contract',
    html.includes('$1,032,750.02'), 'expected 217,750.02 + 15,000 + 600,000 + 200,000');
  assert('Actual Profit total covers only jobs with a contract AND spend',
    html.includes('$1,132,750.02'), 'expected 217,750.02 + 15,000 + 900,000');

  console.log('\n[ordering and behaviour]');
  assert('live jobs sort above finished ones',
    html.indexOf('Franklin Regional') < html.indexOf('Saint Edmunds'));
  assert('  newest job number first among live jobs',
    html.indexOf('No Contract Yet') < html.indexOf('Franklin Regional'));
  assert('rows open the project', html.includes(`goToProject('a')`));
  assert('both profit bases are stated on screen',
    /Projected Profit is contract value minus <strong>projected<\/strong> final cost/.test(html)
    && /Actual Profit is contract value minus cost <strong>spent so far<\/strong>/.test(html));

  console.log('\n[a total with nothing to total is unknown, not zero]');
  // Rendering "$0.00" in profit-green across a portfolio where no job carries
  // a contract asserts break-even on figures nobody has entered yet.
  const noneHtml = render(file, [
    job({ id: 'x', name: 'Unpriced One', job: '900', status: 'In Progress', contract: 0, bid: 1000, actual: 500 }),
    job({ id: 'y', name: 'Unpriced Two', job: '901', status: 'In Progress', contract: 0, bid: 2000, actual: 900 }),
  ]);
  const foot = noneHtml.slice(noneHtml.indexOf('<tfoot>'));
  assert('neither profit total claims $0.00 when no job has a contract',
    !/\$0\.00/.test(foot), foot);
  assert('  both dash instead', (foot.match(/—/g) || []).length >= 2);
  assert('  and the cost columns still total',
    foot.includes('$3,000.00') && foot.includes('$1,400.00'));
  // The spend-only exclusion is separate from the contract-only one.
  const noSpendHtml = render(file, [
    job({ id: 'z', name: 'Signed Not Started', job: '902', status: 'In Progress', contract: 500000, bid: 400000, actual: 0, rqty: 0, done: false }),
  ]);
  const noSpendFoot = noSpendHtml.slice(noSpendHtml.indexOf('<tfoot>'));
  assert('Projected Profit still totals when a job has a contract but no spend',
    noSpendFoot.includes('$100,000.00'), noSpendFoot);
  assert('  while Actual Profit dashes', /—/.test(noSpendFoot));

  console.log('\n[empty state]');
  assert('no projects renders an empty state, not a broken table',
    /No projects yet/.test(render(file, [])));
}

// Wiring: the subtab has to be reachable, and its financial figures should not
// be handed to the restricted roles by default.
console.log('\n══════════ wiring ══════════');
for (const file of FILES) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  console.log(`\n[${file}]`);
  assert('the Analytics menu offers Financials',
    /id="analytics-item-financials" onclick="analyticsSwitchTab\('financials'\)"/.test(src));
  assert('the panel exists', /<div class="tab-panel" id="tab-financials">/.test(src)
    && /id="fin-content"/.test(src));
  assert('switching to it renders', /if \(tab === 'financials'\) renderFinancials\(\);/.test(src));
  assert('restricted roles do not get it',
    /'financials'\]/.test(src) || /!perm\.visibleTabs\.has\('financials'\)/.test(src));
}

// ── Filters, Excel export and print ─────────────────────────────────────────
// The three have to agree: what you filter to is what you export and what you
// print. An export that quietly ships all 55 jobs when the screen shows 4 is
// the kind of thing nobody notices until it is in someone else's inbox.
console.log('\n══════════ filters, excel and print ══════════');
for (const file of FILES) {
  console.log(`\n[${file}]`);

  const withFilters = (f) => { const m = loadFinancials(file, JOBS); m.setFilters(f); m.renderFinancials(); return m; };

  console.log('  — status filter —');
  const done = withFilters({ q: '', statuses: new Set(['Complete']) });
  assert('filtering to Complete keeps only that job',
    done.html().includes('Saint Edmunds Field') && !done.html().includes('Franklin Regional Tennis Court'));
  assert('  the count shows the filtered share', done.html().includes('1 of 5 jobs'));
  assert('  totals cover the filtered rows, not all of them',
    done.html().includes('$210,000.00') && !done.html().includes('$2,489,312.32'), 'contract total should be just the one job');
  assert('  and the table says the totals are filtered',
    /Totals cover the filtered rows only/.test(done.html()));

  console.log('  — search box —');
  const searched = withFilters({ q: 'franklin' });
  assert('search matches on job name', searched.html().includes('Franklin Regional Tennis Court'));
  assert('  and excludes the rest', !searched.html().includes('Saint Edmunds Field'));
  assert('search matches on job number',
    withFilters({ q: '1039' }).html().includes('Saint Edmunds Field'));
  assert('search is case-insensitive',
    withFilters({ q: 'FRANKLIN' }).html().includes('Franklin Regional Tennis Court'));
  assert('a filter matching nothing says so instead of rendering an empty table',
    /No jobs match these filters/.test(withFilters({ q: 'zzzznope' }).html()));

  console.log('  — the unfiltered view is unchanged —');
  const plain = withFilters({ q: '' });
  assert('no filter shows every job and the plain count', plain.html().includes('(5 jobs)'));
  assert('  and does not claim the totals are filtered',
    !/Totals cover the filtered rows only/.test(plain.html()));
  assert('the status control is a multi-select checklist, not a single-pick dropdown',
    /data-fin-f="statuses"/.test(done.html()) && !/onchange="finSetFilter\('status'/.test(done.html()));

  console.log('  — job name filter —');
  // The Purchase Orders pattern: a checklist of job names. Picking narrows the
  // table, and the totals, export and printout follow it.
  const pick = loadFinancials(file, JOBS);
  pick.pickNames(['Franklin Regional Tennis Court', 'Saint Edmunds Field']);
  pick.renderFinancials();
  const pk = pick.html();
  assert('only the picked jobs are listed',
    pk.includes('Franklin Regional Tennis Court') && pk.includes('Saint Edmunds Field')
    && !pk.includes('Half Built Job') && !pk.includes('No Contract Yet'), pk.slice(0, 200));
  assert('  the heading counts them', pk.includes('2 of 5 jobs'));
  assert('  the filter button shows how many are picked', /Job Name \(2\)/.test(pk));
  assert('  and reads as active', /class="cfb finfb active"/.test(pk));
  assert('totals cover only the picked jobs',
    pk.includes('$689,312.32') && !pk.includes('$2,489,312.32'), 'expected 479,312.32 + 210,000');
  assert('  and the table says the totals are filtered',
    /Totals cover the filtered rows only/.test(pk));

  console.log('  — the filter drives export and print —');
  pick.exportFinancialsCSV();
  const pkCsv = pick.captured.csv.split('\r\n');
  assert('the export ships only the picked jobs', pkCsv.length === 4, pkCsv.length + ' lines');
  assert('  and totals them', pkCsv[3].startsWith('Totals,,,689312.32'));
  pick.printFinancials();
  assert('the printout carries only the picked jobs',
    pick.captured.print.includes('Saint Edmunds Field') && !pick.captured.print.includes('Half Built Job'));
  assert('  and names the pick on the page', /2 selected jobs/.test(pick.captured.print));

  console.log('  — no pick means every job —');
  const noPick = loadFinancials(file, JOBS);
  noPick.renderFinancials();
  assert('with nothing picked every job is listed', JOBS.every(j => noPick.html().includes(j['project-name'])));
  assert('  the button is not marked active', !/class="cfb finfb active"/.test(noPick.html()));
  assert('  and the button carries no count', /Job Name<\/button>|Job Name ▼/.test(noPick.html()));

  console.log('  — clearing the pick —');
  pick.clearNames();
  assert('clearing restores every job',
    pick.picked() === null && JOBS.every(j => pick.html().includes(j['project-name'])));

  console.log('  — more than one status at once —');
  const multi = loadFinancials(file, JOBS);
  multi.pickStatuses(['In Progress', 'Complete']);
  multi.renderFinancials();
  assert('two statuses keep the jobs in either',
    multi.filtered().length === JOBS.length, `${multi.filtered().length} of ${JOBS.length}`);
  multi.pickStatuses(['Complete']);
  multi.renderFinancials();
  assert('narrowing to one keeps only that one',
    multi.filtered().length === 1 && multi.filtered()[0].status === 'Complete');
  multi.pickStatuses(['Bidding', 'Awarded']);
  multi.renderFinancials();
  assert('statuses no job holds match nothing', multi.filtered().length === 0);
  assert('  and the table says so, rather than showing everything',
    /No jobs match these filters/.test(multi.html()));
  multi.pickStatuses(null);
  multi.renderFinancials();
  assert('no pick means every status', multi.filtered().length === JOBS.length);
  assert('  and the button carries the count when some are picked', (() => {
    const m2 = loadFinancials(file, JOBS);
    m2.pickStatuses(['In Progress', 'Complete']);
    m2.renderFinancials();
    return /Status \(2\)/.test(m2.html()) && /class="cfb finfb active" data-fin-f="statuses"/.test(m2.html());
  })());
  // A blank status has to stay reachable, or such a job can never be included.
  const blankJobs = JOBS.concat([job({ id: 'nostatus', name: 'No Status Job', job: '999', status: '', contract: 1000, bid: 900, actual: 800 })]);
  const blank = loadFinancials(file, blankJobs);
  blank.pickStatuses(['']);
  blank.renderFinancials();
  assert('a job with no status can still be picked',
    blank.filtered().length === 1 && blank.filtered()[0].name === 'No Status Job');
  blank.openStatuses({ getBoundingClientRect: () => ({ left: 0, bottom: 0 }) });
  assert('  and the checklist lists it as (blank)', /\(blank\)/.test(blank.dd.list.innerHTML));

  console.log('  — one dropdown, two fields —');
  const two = loadFinancials(file, JOBS);
  two.renderFinancials();
  two.openStatuses({ getBoundingClientRect: () => ({ left: 0, bottom: 0 }) });
  const statusList = two.dd.list.innerHTML;
  assert('opening Status lists statuses, not job names',
    statusList.includes('In Progress') && !statusList.includes('Half Built Job'));
  two.tickBoxes(['In Progress', 'Complete'], ['Complete']);
  two.applyNames();
  assert('  Apply commits to whichever field was opened',
    two.pickedStatuses() && two.pickedStatuses()[0] === 'Complete' && two.picked() === null,
    'the job-name filter must be untouched');
  two.openNames({ getBoundingClientRect: () => ({ left: 0, bottom: 0 }) });
  assert('opening Job Name lists job names again',
    two.dd.list.innerHTML.includes('Half Built Job'));

  console.log('  — the checklist itself —');
  const dd = loadFinancials(file, JOBS);
  dd.renderFinancials();
  dd.openNames({ getBoundingClientRect: () => ({ left: 10, bottom: 20 }) });
  assert('opening it lists every job name once',
    JOBS.every(j => dd.dd.list.innerHTML.includes(j['project-name'])));
  assert('  with a Select All row', dd.dd.list.innerHTML.includes('(Select All)'));
  assert('  and opens the panel', dd.dd.panel.style.display === 'flex');
  const names = JOBS.map(j => j['project-name']);
  dd.tickBoxes(names, ['Saint Edmunds Field']);
  dd.applyNames();
  assert('Apply commits just the ticked names',
    dd.picked().length === 1 && dd.picked()[0] === 'Saint Edmunds Field');
  assert('  and closes the panel', dd.dd.panel.style.display === 'none');
  assert('  and the table follows', dd.html().includes('Saint Edmunds Field') && !dd.html().includes('Half Built Job'));
  // Everything ticked excludes nothing, so it must clear rather than store a
  // set of every name — otherwise the button reads "filtered" while it is not.
  dd.tickBoxes(names, names);
  dd.applyNames();
  assert('ticking every name is stored as no filter at all', dd.picked() === null);
  assert('  so the button is not marked active', !/class="cfb finfb active"/.test(dd.html()));

  console.log('  — the pick composes with the other filters —');
  const both2 = loadFinancials(file, JOBS);
  both2.pickNames(['Franklin Regional Tennis Court', 'Saint Edmunds Field']);
  both2.setFilters({ q: '', statuses: new Set(['Complete']), names: both2.picked() ? new Set(both2.picked()) : null });
  both2.renderFinancials();
  assert('a picked job that fails the status filter drops out',
    both2.html().includes('Saint Edmunds Field') && !both2.html().includes('Franklin Regional Tennis Court'));

  console.log('  — status colours —');
  // There is no 'Active' status in this app. The set is Bidding / Awarded /
  // In Progress / Substantially Complete / Complete / On Hold, so a colour map
  // keyed on 'Active' left In Progress — the commonest status — rendered as
  // muted grey alongside everything else it failed to match.
  const statusHtml = render(file, ['Bidding', 'Awarded', 'In Progress', 'Substantially Complete', 'Complete', 'On Hold']
    .map((s, i) => job({ id: 's' + i, name: 'Job ' + s, job: String(900 + i), status: s, contract: 100, bid: 90, actual: 80 })));
  for (const [s, cls] of [['Bidding', 'badge-bidding'], ['Awarded', 'badge-awarded'], ['In Progress', 'badge-in-progress'],
                          ['Substantially Complete', 'badge-substantially'], ['Complete', 'badge-complete'], ['On Hold', 'badge-on-hold']]) {
    assert(`${s} gets its own colour`, statusHtml.includes(`proj-badge ${cls}">${s}<`), `expected ${cls}`);
  }
  assert('  no status falls through to the default badge',
    !statusHtml.includes('badge-default'));

  console.log('  — excel export —');
  const exp = withFilters({ q: '' });
  exp.exportFinancialsCSV();
  const csv = exp.captured.csv;
  const csvRows = csv.split('\r\n');
  assert('the export produces a CSV', !!csv);
  assert('  headers match the table', csvRows[0].replace(/^﻿/, '') === FIN_HEADERS.join(','));
  assert('  one row per job plus a header and a totals row', csvRows.length === JOBS.length + 2);
  assert('  numbers go out raw so Excel can total them',
    /,479312\.32,375931\.05,261562\.30,/.test(csv), csvRows[1]);
  assert('  no currency symbols or thousands separators to break the parse',
    !/[$]/.test(csv) && !/\d,\d\d\d\./.test(csv));
  assert('  a not-applicable profit is blank, not zero',
    csvRows.find(l => l.startsWith('No Contract Yet')).endsWith(',,'), csvRows.find(l => l.startsWith('No Contract Yet')));
  assert('  the last row totals', csvRows[csvRows.length - 1].startsWith('Totals,,,2489312.32'));
  assert('  a name containing a comma is quoted', (() => {
    const m = loadFinancials(file, [job({ id: 'q', name: 'Smith, Jones & Co', job: '1', status: 'In Progress', contract: 100, bid: 90, actual: 80 })]);
    m.renderFinancials(); m.exportFinancialsCSV();
    return m.captured.csv.includes('"Smith, Jones & Co"');
  })());
  assert('  the filename names the division and the date',
    /^financials-.*-\d{4}-\d{2}-\d{2}\.csv$/.test(exp.captured.download), exp.captured.download);
  // A cost the table shows as "—" must not export as 0.00. Zero and
  // not-entered are different claims, and the export is what gets summed.
  assert('  a cost the table dashes exports blank, not 0.00',
    csvRows.find(l => l.startsWith('No Contract Yet')).startsWith('No Contract Yet,1044,In Progress,,'),
    csvRows.find(l => l.startsWith('No Contract Yet')));
  assert('  but a genuine $0.00 profit still exports as 0.00', (() => {
    const m = loadFinancials(file, [job({ id: 'be', name: 'Break Even', job: '1', status: 'Complete', contract: 5000, bid: 5000, actual: 5000 })]);
    m.renderFinancials(); m.exportFinancialsCSV();
    return /,0\.00,0\.00\r?\n?/.test(m.captured.csv.split('\r\n')[1] + '\n');
  })(), 'break-even is a fact, not a blank');

  console.log('  — export follows the filter —');
  const expFiltered = withFilters({ q: '', statuses: new Set(['Complete']) });
  expFiltered.exportFinancialsCSV();
  const fcsv = expFiltered.captured.csv.split('\r\n');
  assert('a filtered export ships only the filtered rows', fcsv.length === 3, `${fcsv.length} lines`);
  assert('  and its totals match the filtered set', fcsv[2].startsWith('Totals,,,210000.00'));

  console.log('  — print view —');
  const pr = withFilters({ q: '' });
  pr.printFinancials();
  const doc = pr.captured.print;
  assert('the print view opens a document', !!doc && doc.includes('<!DOCTYPE html>'));
  // The reason this whole section could not run before: printFinancials goes
  // through dwWrite, so the harness has to supply the real report-branding.js
  // rather than a stub. Pinning the band here keeps that wiring load-bearing —
  // a fake dwWrite would satisfy every other assertion below and quietly send
  // an unbranded report to the printer.
  assert('  and it goes out branded, as the print path brands it',
    /data-dw-brand/.test(doc) && /DataWatch/.test(doc),
    'printFinancials writes through dwWrite');
  assert('  it prints itself on load', /window\.print\(\)/.test(doc));
  assert('  it carries every column', FIN_HEADERS.every(h => doc.includes(`>${h}</th>`)));
  assert('  every job is on it', JOBS.every(j => doc.includes(j['project-name'])));
  assert('  it totals', doc.includes('$2,489,312.32'));
  assert('  it prints on white, not the dark app theme', /background:\s*#fff/.test(doc));
  assert('  the division reads as a name, not a lowercase key',
    /<h2>Financials — [A-Z]/.test(doc), (doc.match(/<h2>[^<]*/) || [''])[0]);
  assert('  the header repeats across pages', /thead\s*\{\s*display:\s*table-header-group/.test(doc));
  const prF = withFilters({ q: '', statuses: new Set(['Complete']) });
  prF.printFinancials();
  assert('a filtered print names the filter on the page',
    /Status:\s*Complete/.test(prF.captured.print), 'so a printout cannot be mistaken for the full book');
  assert('  and prints only those rows',
    !prF.captured.print.includes('Franklin Regional Tennis Court'));

  console.log('  — nothing to export —');
  const none = withFilters({ q: 'zzzznope' });
  none.exportFinancialsCSV();
  none.printFinancials();
  assert('exporting an empty result warns instead of shipping an empty file',
    none.captured.csv === null && none.captured.alerts.length === 2, JSON.stringify(none.captured.alerts));
}

// A removed helper still called from somewhere is a runtime ReferenceError the
// page parses straight past — the export and print both threw that way once.
console.log('\n[nothing calls a helper that no longer exists]');
for (const file of FILES) {
  const src   = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const block = src.slice(src.indexOf('/* ── Financials ───'), src.indexOf('function renderSubCodePerf'));
  const declared = new Set([...block.matchAll(/function (\w+)\s*\(/g)].map(m => m[1]));
  const called   = new Set([...block.matchAll(/\b(_financials\w+|fin[A-Z]\w+)\s*\(/g)].map(m => m[1]));
  const missing  = [...called].filter(n => !declared.has(n));
  assert(`${file}: every Financials helper it calls is defined`,
    missing.length === 0, missing.join(', '));
  const stale = ['finSelected', '_financialsActive', 'finShowSelectedOnly', 'finToggleRow']
    .filter(n => block.includes(n));
  assert(`  and the removed row-selection code is gone`, stale.length === 0, stale.join(', '));
}

// The buttons have to exist on the page, not just the functions behind them.
console.log('\n[the controls are wired up]');
for (const file of FILES) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  assert(`${file} has a search box, status filter and clear`,
    /oninput="finSetFilter\('q', this\.value\)"/.test(src)
    && /data-fin-f="statuses"/.test(src)
    && /onclick="finClearFilters\(\)"/.test(src));
  assert(`  ${file} has Excel and Print buttons`,
    /onclick="exportFinancialsCSV\(\)"/.test(src) && /onclick="printFinancials\(\)"/.test(src));
  assert(`  ${file} has both checklists on one dropdown`,
    /data-fin-f="names"/.test(src) && /data-fin-f="statuses"/.test(src)
    && /id="fin-filter-dd"/.test(src)
    && /onclick="applyFinFilter\(\)"/.test(src) && /onclick="clearFinFilter\(\)"/.test(src));
  // A removed property still read from somewhere is a silent undefined, not an
  // error — finFilters.status survived a rename into the printout once.
  assert(`  ${file} reads no filter key that no longer exists`,
    !/finFilters\.status\b/.test(src) && !/openFinNameFilter|applyFinNameFilter|clearFinNameFilter/.test(src));
  assert(`  ${file} opens it on click and closes it on an outside click`,
    /e\.target\.closest\('\.finfb'\)/.test(src) && /!e\.target\.classList\.contains\('finfb'\)/.test(src));
}

// ── Home tab projects table ─────────────────────────────────────────────────
// Same figures, same names, and one more column than before. A header added
// without its matching cell (or vice versa) slides every column one to the
// left from that point on, which is silent and looks like wrong data.
console.log('\n══════════ home tab projects table ══════════');
for (const file of FILES) {
  const src   = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const thead = src.slice(src.indexOf('<table class="proj-table">'), src.indexOf('<tbody>${projectTableRows}'));
  const row   = src.slice(src.indexOf(`return \`<tr onclick="goToProject('\${p.id}')">`), src.indexOf('</tr>`;\n  }).join'));

  console.log(`\n[${file}]`);
  assert('the header uses the agreed vocabulary',
    ['Contract Value', 'Bid Budget', 'Projected Cost', 'Projected Profit', 'Actual Profit']
      .every(h => thead.includes(`>${h}</th>`)), thead);
  assert('  the old names are gone',
    !/>Contract<\/th>|>Bid<\/th>|>Projected<\/th>|>Profit<\/th>/.test(thead));
  assert('  Actual Profit sits after Projected Profit',
    thead.indexOf('Projected Profit') < thead.indexOf('Actual Profit'));
  const ths = (thead.match(/<th[ >]/g) || []).length;
  const tds = (row.match(/<td[ >]/g) || []).length;
  assert(`every header has a cell under it (${ths} headers, ${tds} cells)`, ths === tds);
  assert('the new cell renders the actual-profit figure',
    /\$\{actProfitTxt\}/.test(row) && /\$\{actProfitStyle\}/.test(row));
  // The formula lives here as well as in renderFinancials, so it can drift.
  // Both guards matter: no contract means no revenue to subtract from, and no
  // spend means a signed-but-unstarted job would post its contract as margin.
  assert('Actual Profit is contract minus actual, guarded on both',
    /const actProfit\s*=\s*\(contractVal && actual\)\s*\?\s*contractVal - actual\s*:\s*null;/.test(src));
  assert('  Projected Profit still subtracts projected, not actual',
    /const profit\s*=\s*contractVal \? contractVal - projCost : null;/.test(src));
}

// ── Status colours, everywhere status is shown ──────────────────────────────
// Colouring status by a value the app never writes is silently wrong: the cell
// still renders, just grey. Both spellings — the badge class and the plain
// text colour — have to cover the real set and agree with each other.
console.log('\n══════════ status colours ══════════');
const REAL_STATUSES = ['Bidding', 'Awarded', 'In Progress', 'Substantially Complete', 'Complete', 'On Hold'];
for (const file of FILES) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const mod = new Function(
    `${extractFunction(src, 'statusTextColor')}
     ${extractFunction(src, 'statusBadgeClass')}
     return { statusTextColor, statusBadgeClass };`)();

  console.log(`\n[${file}]`);
  assert('the status list the project form offers is the one we colour',
    REAL_STATUSES.every(s => src.includes(`'${s}'`)));
  for (const s of REAL_STATUSES) {
    assert(`${s} is coloured, not left grey`,
      mod.statusTextColor(s) !== 'var(--muted)' && mod.statusBadgeClass(s) !== 'badge-default');
  }
  assert('an unknown status still falls back safely',
    mod.statusTextColor('Wat') === 'var(--muted)' && mod.statusBadgeClass('Wat') === 'badge-default');
  assert('no colour lookup keys on a status this app never writes',
    !/=== 'Active'/.test(src), "'Active' is not in the project status list");

  // The Home cell shows At Risk / On Hold counts from the bid items ahead of
  // the project's own status — that ordering must survive the colour change.
  const homeCell = src.slice(src.indexOf('let statusCell;'), src.indexOf('let deadlineNote'));
  assert('the Home cell still puts At Risk and On Hold counts first',
    homeCell.indexOf('At Risk') < homeCell.indexOf('statusTextColor')
    && homeCell.indexOf('On Hold') < homeCell.indexOf('statusTextColor'));
  assert('  and colours the status through the shared helper',
    /statusCell = `<span style="color:\$\{statusTextColor\(status\)\}/.test(homeCell));
}

// The divisions that have no bid items or analytics tab are out of scope.
console.log('\n[divisions without jobs are untouched]');
for (const file of ['trucking.html', 'dust.html', 'quarry.html', 'intercompany.html']) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  assert(`${file} has no bid items, so no Financials tab`,
    !/analytics-item-financials/.test(src) && !/bidItems/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
