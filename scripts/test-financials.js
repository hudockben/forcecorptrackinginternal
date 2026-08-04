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
const CHAIN = ['offBidForProject', 'projIsDone', 'projForBidItem', 'projectedCostForProject'];
function loadFinancials(file, projects) {
  const src   = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const start = src.indexOf('/* ── Financials ───');
  const end   = src.indexOf('function renderSubCodePerf');
  if (start < 0 || end < 0) throw new Error(`Financials block not found in ${file}`);
  const code = CHAIN.map(n => extractFunction(src, n)).join('\n\n') + '\n\n' + src.slice(start, end);

  const bar = { innerHTML: '' }, table = { innerHTML: '' };
  const captured = { csv: null, print: null, alerts: [], download: null };

  const api = new Function(
    'projectsList', 'document', 'window', 'alert', 'Blob', 'URL',
    'dailyRowCost', 'fmt', 'esc',
    'actualForBidItem', 'runningQtyForBidItem', 'bidItemComplete', 'getProj',
    `${code}
     return {
       renderFinancials, exportFinancialsCSV, printFinancials,
       setFilters: f => { finFilters = f; },
       rows: _financialsRows, filtered: _financialsFiltered, totals: _financialsTotals,
     };`
  )(
    projects,
    {
      getElementById: id => (id === 'fin-content' ? bar : id === 'fin-table' ? table : null),
      createElement: () => ({ href: '', download: '', click() { captured.download = this.download; } }),
    },
    { open: () => ({ document: { write: h => { captured.print = h; }, close() {} } }) },
    m => captured.alerts.push(m),
    function (parts) { captured.csv = parts.join(''); },
    { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    r => r.cost || 0,
    (n, d = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
    s => String(s || '').replace(/"/g, '&quot;'),
    (b, id) => (b._actual || 0),
    (b, id) => (b._rqty || 0),
    (b, id) => !!b._done,
    () => null,
  );

  return {
    ...api,
    captured,
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
  job({ id: 'a', name: 'Franklin Regional Tennis Court', job: '1042', status: 'Active',   contract: 479312.32, bid: 375931.05, actual: 261562.30 }),
  job({ id: 'b', name: 'Saint Edmunds Field',            job: '1039', status: 'Complete', contract: 210000,    bid: 180000,    actual: 195000 }),
  job({ id: 'c', name: 'No Contract Yet',                job: '1044', status: 'Active',   contract: 0,         bid: 50000,     actual: 12000 }),
  // A quarter of the quantity down: projects to $400,000 against $100,000 spent,
  // so the two profit columns must not agree.
  job({ id: 'd', name: 'Half Built Job',                 job: '1001', status: 'Active',   contract: 1000000,   bid: 500000,    actual: 100000, rqty: 0.25, done: false }),
  // Contract signed, nothing spent — the case that would read as pure margin
  // if Actual Profit were contract minus zero.
  job({ id: 'e', name: 'Not Started Job',                job: '1002', status: 'Active',   contract: 800000,    bid: 600000,    actual: 0,      rqty: 0,    done: false }),
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
  assert('shows its status',          a.includes('Active'));
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
    job({ id: 'x', name: 'Unpriced One', job: '900', status: 'Active', contract: 0, bid: 1000, actual: 500 }),
    job({ id: 'y', name: 'Unpriced Two', job: '901', status: 'Active', contract: 0, bid: 2000, actual: 900 }),
  ]);
  const foot = noneHtml.slice(noneHtml.indexOf('<tfoot>'));
  assert('neither profit total claims $0.00 when no job has a contract',
    !/\$0\.00/.test(foot), foot);
  assert('  both dash instead', (foot.match(/—/g) || []).length >= 2);
  assert('  and the cost columns still total',
    foot.includes('$3,000.00') && foot.includes('$1,400.00'));
  // The spend-only exclusion is separate from the contract-only one.
  const noSpendHtml = render(file, [
    job({ id: 'z', name: 'Signed Not Started', job: '902', status: 'Active', contract: 500000, bid: 400000, actual: 0, rqty: 0, done: false }),
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
  const done = withFilters({ q: '', status: 'Complete' });
  assert('filtering to Complete keeps only that job',
    done.html().includes('Saint Edmunds Field') && !done.html().includes('Franklin Regional Tennis Court'));
  assert('  the count shows the filtered share', done.html().includes('1 of 5 jobs'));
  assert('  totals cover the filtered rows, not all of them',
    done.html().includes('$210,000.00') && !done.html().includes('$2,489,312.32'), 'contract total should be just the one job');
  assert('  and the table says the totals are filtered',
    /Totals cover the filtered rows only/.test(done.html()));

  console.log('  — search box —');
  const searched = withFilters({ q: 'franklin', status: '' });
  assert('search matches on job name', searched.html().includes('Franklin Regional Tennis Court'));
  assert('  and excludes the rest', !searched.html().includes('Saint Edmunds Field'));
  assert('search matches on job number',
    withFilters({ q: '1039', status: '' }).html().includes('Saint Edmunds Field'));
  assert('search is case-insensitive',
    withFilters({ q: 'FRANKLIN', status: '' }).html().includes('Franklin Regional Tennis Court'));
  assert('a filter matching nothing says so instead of rendering an empty table',
    /No jobs match these filters/.test(withFilters({ q: 'zzzznope', status: '' }).html()));

  console.log('  — the unfiltered view is unchanged —');
  const plain = withFilters({ q: '', status: '' });
  assert('no filter shows every job and the plain count', plain.html().includes('(5 jobs)'));
  assert('  and does not claim the totals are filtered',
    !/Totals cover the filtered rows only/.test(plain.html()));
  assert('the status dropdown offers every status in the data, not just visible ones',
    ['Active', 'Complete'].every(s => done.html().includes(`<option value="${s}"`)),
    'filtering to Complete must still offer Active');

  console.log('  — excel export —');
  const exp = withFilters({ q: '', status: '' });
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
    const m = loadFinancials(file, [job({ id: 'q', name: 'Smith, Jones & Co', job: '1', status: 'Active', contract: 100, bid: 90, actual: 80 })]);
    m.renderFinancials(); m.exportFinancialsCSV();
    return m.captured.csv.includes('"Smith, Jones & Co"');
  })());
  assert('  the filename names the division and the date',
    /^financials-.*-\d{4}-\d{2}-\d{2}\.csv$/.test(exp.captured.download), exp.captured.download);

  console.log('  — export follows the filter —');
  const expFiltered = withFilters({ q: '', status: 'Complete' });
  expFiltered.exportFinancialsCSV();
  const fcsv = expFiltered.captured.csv.split('\r\n');
  assert('a filtered export ships only the filtered rows', fcsv.length === 3, `${fcsv.length} lines`);
  assert('  and its totals match the filtered set', fcsv[2].startsWith('Totals,,,210000.00'));

  console.log('  — print view —');
  const pr = withFilters({ q: '', status: '' });
  pr.printFinancials();
  const doc = pr.captured.print;
  assert('the print view opens a document', !!doc && doc.includes('<!DOCTYPE html>'));
  assert('  it prints itself on load', /window\.print\(\)/.test(doc));
  assert('  it carries every column', FIN_HEADERS.every(h => doc.includes(`>${h}</th>`)));
  assert('  every job is on it', JOBS.every(j => doc.includes(j['project-name'])));
  assert('  it totals', doc.includes('$2,489,312.32'));
  assert('  it prints on white, not the dark app theme', /background:\s*#fff/.test(doc));
  assert('  the header repeats across pages', /thead\s*\{\s*display:\s*table-header-group/.test(doc));
  const prF = withFilters({ q: '', status: 'Complete' });
  prF.printFinancials();
  assert('a filtered print names the filter on the page',
    /Status:\s*Complete/.test(prF.captured.print), 'so a printout cannot be mistaken for the full book');
  assert('  and prints only those rows',
    !prF.captured.print.includes('Franklin Regional Tennis Court'));

  console.log('  — nothing to export —');
  const none = withFilters({ q: 'zzzznope', status: '' });
  none.exportFinancialsCSV();
  none.printFinancials();
  assert('exporting an empty result warns instead of shipping an empty file',
    none.captured.csv === null && none.captured.alerts.length === 2, JSON.stringify(none.captured.alerts));
}

// The buttons have to exist on the page, not just the functions behind them.
console.log('\n[the controls are wired up]');
for (const file of FILES) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  assert(`${file} has a search box, status filter and clear`,
    /oninput="finSetFilter\('q', this\.value\)"/.test(src)
    && /onchange="finSetFilter\('status', this\.value\)"/.test(src)
    && /onclick="finClearFilters\(\)"/.test(src));
  assert(`  ${file} has Excel and Print buttons`,
    /onclick="exportFinancialsCSV\(\)"/.test(src) && /onclick="printFinancials\(\)"/.test(src));
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

// The divisions that have no bid items or analytics tab are out of scope.
console.log('\n[divisions without jobs are untouched]');
for (const file of ['trucking.html', 'dust.html', 'quarry.html', 'intercompany.html']) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  assert(`${file} has no bid items, so no Financials tab`,
    !/analytics-item-financials/.test(src) && !/bidItems/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
