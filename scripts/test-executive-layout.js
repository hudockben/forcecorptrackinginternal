'use strict';
/**
 * Layout test for executive.html.
 *
 * The executive report is meant to READ THE SAME as the division home pages it
 * rolls up: the same metric strip, the same project table, in the same order,
 * with the same words. That is the whole point of the layout — a figure an
 * executive questions has to be findable on the division page without
 * translation. This test pins that correspondence down by comparing
 * executive.html against tracker.html / paving.html / kiewit-pinetree.html,
 * so drift on either side shows up here rather than in a meeting.
 *
 * Run:  node scripts/test-executive-layout.js
 */

const fs   = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const exec    = read('executive.html');
const tracker = read('tracker.html');
const paving  = read('paving.html');
const kiewit  = read('kiewit-pinetree.html');
const quarry  = read('quarry.html');
const dust    = read('dust.html');
const payroll = read('payroll.html');
const truck   = read('trucking.html');
const ic      = read('intercompany.html');

const vm = require('vm');

let failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 300));
};

// ── The project table matches the division tables, column for column ──
console.log('\n[the project table mirrors the division tables]');

const COLUMNS = [
  'Project', 'Status', 'Progress', 'Contract Value', 'Bid Budget', 'Actual',
  'Variance', 'Projected Cost', 'Projected Profit', 'Actual Profit',
];

// Pull the <th> labels out of a page's project table, in document order.
function headerLabels(html, marker, span = 1600) {
  const at = html.indexOf(marker);
  if (at < 0) return [];
  const slice = html.slice(at, at + span);
  return [...slice.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1].trim());
}

const execCols = headerLabels(exec, '<th>Project</th>');
assert('executive.html lists the ten division columns in order',
  COLUMNS.every((c, i) => execCols[i] === c),
  'got: ' + JSON.stringify(execCols));
assert('and an eleventh, unlabelled column for the pin star',
  execCols.length === 11 && execCols[10] === '',
  'got ' + execCols.length + ' columns');

for (const [name, html] of [['tracker', tracker], ['paving', paving], ['kiewit-pinetree', kiewit]]) {
  const cols = headerLabels(html, '<th>Project</th>');
  assert(`${name}.html still has those same columns — the report is mirroring a live layout`,
    COLUMNS.every((c, i) => cols[i] === c),
    'got: ' + JSON.stringify(cols));
}

assert('Actual Profit carries the division pages\' own tooltip',
  exec.includes('title="Contract value minus actual cost. Final once the job is complete."'));

// ── The metric strip matches, label for label ──
console.log('\n[the metric strip mirrors the division strips]');

const METRICS = [
  'Active Projects', 'Total Contract Value', 'Awarded Backlog', 'Total Bid Budget',
  'Total Actual Spend', 'Total Variance', 'Total Projected Profit', 'Total Actual Profit',
];

const report = read('api/executive/report.js');
for (const label of METRICS) {
  assert(`the API builds "${label}"`, report.includes(`label: '${label}'`));
  for (const [name, html] of [['tracker', tracker], ['paving', paving], ['kiewit-pinetree', kiewit]]) {
    assert(`  and ${name}.html still shows it`,
      html.includes(`>${label}</span>`));
  }
}
assert('the strip is exactly those eight figures, no more',
  (report.match(/^\s+label: '(?:Active Projects|Total [A-Za-z ]+|Awarded Backlog)',$/gm) || []).length === METRICS.length);

// ── Bid budgets include change orders, as the division pages do ──
console.log('\n[bid budgets agree with the division pages]');
assert('the API adds change-order quantity into each bid line',
  /change_orders[\s\S]{0,200}qty_delta/.test(report));
for (const [name, html] of [['tracker', tracker], ['paving', paving], ['kiewit-pinetree', kiewit]]) {
  assert(`  ${name}.html computes its bid budget the same way`,
    /quantity\)\|\|0\)\s*\+\s*\(b\.change_orders\|\|\[\]\)\.reduce/.test(html.replace(/\s/g, m => m === '\n' ? '\n' : m)) ||
    html.includes('change_orders||[]).reduce((s,co)=>s+(parseFloat(co.qty_delta)||0),0)'));
}

// ── One section per job-running division ──
console.log('\n[one section per job-running division]');
assert('the report renders sections from `portfolios`, not a merged project list',
  exec.includes('renderPortfolios(') && exec.includes("data.portfolios"));
assert('the old cross-division Projects table is gone',
  !exec.includes('id="projectsBody"') && !exec.includes('id="projectsSub"'));
for (const [key, href] of [['turf', 'tracker.html'], ['paving', 'paving.html'], ['kiewit', 'kiewit-pinetree.html']]) {
  assert(`${key} links back to ${href} for the projects the table leaves out`,
    new RegExp(`${key}:\\s*\\{[^}]*href:\\s*'${href.replace('.', '\\.')}'`).test(exec));
}
assert('the API covers all three divisions',
  /PROJECT_DIVISIONS = \[[\s\S]*?'turf'[\s\S]*?'paving'[\s\S]*?'kiewit'[\s\S]*?\]/.test(report));
assert('Turf, Paving and Kiewit no longer double as snapshot tiles',
  !report.includes('buildTurfTile') && !report.includes('buildPavingTile'));
assert('rubber inventory rides inside the Turf section',
  /d\.key === 'turf' \? renderRubberInventory/.test(exec));

// ── Table rows carry what the division tables carry ──
console.log('\n[rows carry the same detail]');
assert('the name sub-line is job number · client · PM',
  /metaBits = \[p\.jobNumber, p\.client\]/.test(exec) && exec.includes("metaBits.push('PM: '"));
assert('a bid line At Risk / On Hold outranks the project status',
  /p\.atRisk > 0[\s\S]{0,200}p\.onHold > 0[\s\S]{0,200}p\.status/.test(exec));
assert('overdue and near-deadline jobs are flagged',
  exec.includes('d overdue') && exec.includes('d left'));
assert('Actual Profit is rendered from its own field',
  exec.includes('profitCell(p.actProfit, p.actProfitPct)'));
assert('and the API only reports it where there is both a contract and spend',
  /actProfit = contract > 0 && actual\s+> 0 \? contract - actual\s+: null/.test(report));

// ── Quarry mirrors the Quarry page ──
console.log('\n[quarry mirrors the Quarry page]');

// The eight Home KPIs, in the page's own words and the page's own order.
const QUARRY_METRICS = [
  'Tons On Hand', 'Days of Supply', 'Net Change', 'Needs Attention',
  'Margin / Ton', 'Avg Price / Ton', 'Cost / Ton', 'Break-Even',
];
for (const label of QUARRY_METRICS) {
  assert(`the API builds "${label}"`, report.includes(`label: '${label}'`));
  // Tag-agnostic: the Home tab's KPI labels moved from <div class="kpi-label">
  // onto the shared strip's <span class="home-metric-label">.
  assert(`  and quarry.html still shows it`,
    new RegExp(`>\\s*${label.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')}\\s*<`).test(quarry));
}

// The Analytics tab's Performance by Location table, column for column.
const QUARRY_COLUMNS = [
  'Location', 'Sales', 'Cost', 'Margin', 'Tons Sold', 'Cost / Ton Sold',
  'Cost / Ton (Prod.)', 'Tons Crushed', 'Loss %', 'Final Screen Tons', 'Hours',
];
const execQuarryCols = headerLabels(exec, '<th>Location</th>');
assert('the executive quarry table has the same eleven columns',
  QUARRY_COLUMNS.every((c, i) => execQuarryCols[i] === c),
  'got: ' + JSON.stringify(execQuarryCols));
// Anchor on the table's own id — the Daily Tracking table also opens with a
// Location column, and it comes first in the file.
const pageQuarryCols = headerLabels(quarry, 'id="analyticsLocationTable"');
assert('and quarry.html\'s Performance by Location table still has them',
  QUARRY_COLUMNS.every((c, i) => pageQuarryCols[i] === c),
  'got: ' + JSON.stringify(pageQuarryCols));

assert('the quarry arithmetic is ported, not re-derived',
  fs.existsSync(path.resolve(__dirname, '../api/lib/quarry-metrics.js'))
  && report.includes("require('../lib/quarry-metrics')"));
assert('the old approximate Quarry tile is gone',
  !report.includes('buildQuarryTile') && report.includes('buildQuarryPortfolio'));
const qm = read('api/lib/quarry-metrics.js');
assert('cost per ton sold divides total cost by tons sold, and cost per ton divides crushing by tons crushed',
  /avgCostPerTonSold\s*=\s*e\.tonsSold > 0 \? e\.totalCost \/ e\.tonsSold/.test(qm)
  && /costPerTon\s*=\s*e\.tonsCrushed > 0 \? e\.crushCost \/ e\.tonsCrushed/.test(qm));
assert('break-even takes royalty off the price before dividing fixed cost',
  /avgPrice - royaltyPerTon - varCostPerTon/.test(qm));
assert('and the division break-even sums the pits rather than blending them',
  /breakEvenTons: T\.beTonsAny \? T\.beTons : null/.test(qm));
assert('the stockpile balances opening + produced − sold + adjustments',
  /onHand\s*=\s*e\.opening \+ e\.produced - e\.tonsSold \+ e\.adjustments/.test(qm));
assert('a pit with no loss figure reports null rather than 0%',
  /hasLoss\) \? e\.lossPct : null/.test(report));

// ── Dust Control mirrors the Dust Control page ──
console.log('\n[dust control mirrors the Dust Control page]');

const DUST_METRICS = [
  'YTD Revenue', 'Jobs This Month', 'Gallons YTD', 'Active Customers',
  'Avg Rev / Job', 'Service Hours YTD',
];
for (const label of DUST_METRICS) {
  assert(`the API builds "${label}"`, report.includes(`label: '${label}'`));
  assert(`  and dust.html still shows it`, dust.includes(`kpiCard('${label}'`));
}
// The invoice buckets moved onto the same strip component as the KPIs above
// them, so they are built the same way now.
assert('plus the page\'s two invoice buckets',
  report.includes("label: 'Overdue'") && report.includes("label: 'Unpaid / Pending'")
  && dust.includes("kpiCard('Overdue'") && dust.includes("kpiCard('Unpaid / Pending'"));

const DUST_COLUMNS = ['Customer', 'Visits', 'Gallons', 'Hours', 'Revenue',
                      'Avg / Visit', 'Overdue', 'Unpaid', 'Paid'];
const execDustCols = headerLabels(exec, '<th>Customer</th>');
assert('the customer table carries visits, volume, revenue and the invoice state',
  DUST_COLUMNS.every((c, i) => execDustCols[i] === c),
  'got: ' + JSON.stringify(execDustCols));

const dm = read('api/lib/dust-metrics.js');
assert('the dust arithmetic is ported, not re-derived in SQL',
  fs.existsSync(path.resolve(__dirname, '../api/lib/dust-metrics.js'))
  && report.includes("require('../lib/dust-metrics')"));
assert('the old approximate Dust tile is gone',
  !report.includes('buildDustTile') && report.includes('buildDustPortfolio'));
assert('a job invoices for vehicle hours plus gallons at the customer\'s UB rate',
  /v1Total\s*=\s*round2\(num\(row && row\.v1_rate\) \* hours\)/.test(dm)
  && /ubTotal\s*=\s*round2\(gallons \* ubRateFor\(row\)\)/.test(dm));
assert('an overnight shift wraps instead of going negative',
  /if \(mins < 0\) mins \+= 24 \* 60/.test(dm));
assert('a per-customer UB rate override beats the division default',
  /const own = byName\.get/.test(dm));
assert('an unpaid invoice past 45 days reads overdue, and paid stays paid',
  /OVERDUE_AFTER_DAYS = 45/.test(dm)
  && /inv_status === 'paid' \|\| row\.inv_received/.test(dm));

// ── Payroll mirrors the Payroll page's Reports tab ──
console.log('\n[payroll mirrors the Payroll page]');

// The Hours Report's twelve columns, in the page's own words and order.
const PAYROLL_COLUMNS = [
  'Employee', 'Hours', 'Travel to Site', 'Travel to Shop', 'Travel', 'Total',
  'Prevailing Hrs', 'Standard Hrs', 'Pending Hrs', 'Approved Hrs',
  'Time Off', 'Status',
];
const execPayrollCols = headerLabels(exec, '<th>Employee</th>');
assert('the executive payroll table has the same twelve columns',
  PAYROLL_COLUMNS.every((c, i) => execPayrollCols[i] === c),
  'got: ' + JSON.stringify(execPayrollCols));
// Anchor inside the Reports tab's own table — the Pending tab's table also opens
// with an Employee column and comes first in the file. The page writes these
// headers with &nbsp; and inline alignment, so compare on the text.
const pagePayrollCols = [...payroll.slice(payroll.indexOf('<div class="report-scroll">'))
  .slice(0, 1800).matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)]
  .map(m => m[1].replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim());
assert('and payroll.html\'s Hours Report still has them',
  PAYROLL_COLUMNS.every((c, i) => pagePayrollCols[i] === c),
  'got: ' + JSON.stringify(pagePayrollCols));

assert('the two tooltips that explain the pay-rate split come across verbatim',
  exec.includes('Travel is excluded — it is not paid at the prevailing rate.')
  && payroll.includes('Travel is excluded — it is not paid at the prevailing rate.')
  && exec.includes('work on non-prevailing jobs plus all travel time')
  && payroll.includes('work on non-prevailing jobs plus all travel time'));

const pm = read('api/lib/payroll-metrics.js');
assert('the payroll arithmetic is ported, not re-derived in SQL',
  fs.existsSync(path.resolve(__dirname, '../api/lib/payroll-metrics.js'))
  && report.includes("require('../lib/payroll-metrics')"));
assert('hours are work plus travel',
  /const h\s*=\s*work \+ travel;/.test(pm) && /const h = work \+ travel;/.test(payroll));
// Anchored on the CONDITION, not just on the two increments. Matching the
// increments alone passes even if the guard above them is deleted outright —
// checked by rewriting the condition to `if (true)`, which the loose form
// happily accepted while every hour on every job became prevailing.
// The gap is bounded (not [\s\S]*) so the match cannot wander off to a pair of
// increments somewhere else in the file — which is the whole failure mode.
const PW_GUARD_RE =
  /prevailing_wage === true[\s\S]{0,40}\{\s*acc\.pwHours\s*\+=\s*work;\s*acc\.stdHours\s*\+=\s*travel;/;
assert('travel never counts as prevailing — the prevailing job\'s travel falls to standard',
  PW_GUARD_RE.test(pm) && PW_GUARD_RE.test(payroll));
// An off-site haul is standard for the same reason travel is: the prevailing
// premium is for work on the covered site, and a driver running to and from it
// never worked there. Asserted in BOTH implementations for the same reason the
// travel rule is — the executive report renders the fortnight from
// payroll-metrics.js while payroll.html renders it in the browser, and a rule
// that lands in only one of them shows the office two different answers for
// the same pay period.
assert('an off-site haul never counts as prevailing, in both implementations',
  /haul_type === 'off_site'/.test(pm)
  && /prevailing_wage === true && !offSiteHaul/.test(pm)
  && /haul_type === 'off_site'/.test(payroll)
  && /prevailing_wage === true && !isOffSiteHaul\(e\)/.test(payroll));
// A haul ON the site is ordinary covered work. Only 'off_site' may move hours
// out of prevailing — a check for a bare truthy haul_type, or one that also
// named 'on_site', would quietly underpay every driver who spent the day
// working inside the fence.
// Scoped to the ONE predicate each file classifies by, not to the whole file:
// payroll.html also names both values in the approve modal's explanatory note,
// which is prose about the rule rather than the rule itself.
//
// payroll-metrics.js sets `offSiteHaul` and payroll.html defines
// `isOffSiteHaul`; either testing a bare truthy haul_type, or admitting
// 'on_site', would quietly underpay every driver who spent the day working
// inside the fence.
const pmPredicate      = /const offSiteHaul = ([^;]+);/.exec(pm);
const payrollPredicate = /function isOffSiteHaul\(e\) \{\s*return ([^;]+);/.exec(payroll);
assert('each implementation classifies by a single findable predicate',
  !!pmPredicate && !!payrollPredicate);
assert('an on-site haul stays prevailing — only off_site is excluded',
  !!pmPredicate && /'off_site'/.test(pmPredicate[1]) && !/'on_site'/.test(pmPredicate[1])
  && !!payrollPredicate && /'off_site'/.test(payrollPredicate[1]) && !/'on_site'/.test(payrollPredicate[1]),
  `pm: ${pmPredicate && pmPredicate[1]} | payroll: ${payrollPredicate && payrollPredicate[1]}`);
assert('only an explicit true is prevailing, so a division without the concept is standard',
  /=== true/.test(pm) && !/prevailing_wage\s*\?/.test(pm));
assert('only submitted and approved entries carry hours',
  /COUNTED_STATUSES = new Set\(\['submitted', 'approved'\]\)/.test(pm));
assert('the two travel legs stay separate from their authoritative sum',
  /travelToSite \+= num\(e\.travel_to_site_hours\)/.test(pm)
  && /travelToShop \+= num\(e\.travel_to_shop_hours\)/.test(pm));

// The flag lives on the project blob, so the report has to look it up the same
// way the timesheet API does — same three divisions, same key prefixes.
const tsApi = read('api/timesheet-entries.js');
for (const [div, prefix] of [['turf', 'fct_project_'], ['paving', 'fct_paving_project_'], ['kiewit', 'fct_kiewit_project_']]) {
  assert(`prevailing wage for ${div} reads ${prefix}<id>, as the timesheet API does`,
    new RegExp(`${div}:\\s*'${prefix}'`).test(report)
    && new RegExp(`${div}:\\s*'${prefix}'`).test(tsApi));
}
assert('a missing project blob reads as not-prevailing, never as prevailing',
  /pwByKey\.has\(key\) \? pwByKey\.get\(key\) : false/.test(report));

assert('the pay period is the biweekly cycle anchored on the page\'s own date',
  /new Date\(Date\.UTC\(2026, 4, 10\)\)/.test(report)
  && /new Date\(2026, 4, 10\)/.test(payroll));

assert('payroll is a division section like the rest, not a bespoke block',
  exec.includes('renderPayrollSection(data.payroll)')
  && !exec.includes('id="payrollBody"') && !exec.includes('id="payrollSub"'));

// ── Trucking mirrors the Trucking page ──
console.log('\n[trucking mirrors the Trucking page]');

// The Trucking page's Dashboard now carries the same eight-figure strip the
// other division pages carry, and the report's section mirrors it — so this can
// compare them label for label instead of spot-checking four.
const TRUCK_METRICS = [
  'Total Revenue', 'Total Hours', 'Active Units', 'Active Drivers',
  'Avg Revenue / Entry', 'Avg Haul Fee', 'To Invoice', 'Awaiting Payment',
];
// renderDashboard runs to the next function; slicing there keeps the Analytics
// sub-tabs' own cards out of the comparison.
const truckDash = truck.slice(truck.indexOf('function renderDashboard()'),
                              truck.indexOf('function downloadAnalyticsPDF'));
const pageTruckMetrics = [...truckDash.matchAll(/\$\{metric\('([^']+)'/g)].map(m => m[1]);
assert('the Trucking page\'s strip carries the eight figures in order',
  TRUCK_METRICS.every((l, i) => pageTruckMetrics[i] === l),
  'got: ' + JSON.stringify(pageTruckMetrics));
for (const label of TRUCK_METRICS) {
  assert(`  and the report's section reports "${label}" too`, report.includes(`label: '${label}'`));
}
assert('the page uses the same strip component as tracker/paving/kiewit',
  truck.includes('home-metric-strip') && truck.includes('home-metric-value')
  && tracker.includes('home-metric-strip'));
assert('and the same project-table component for its own tables',
  truck.includes('class="proj-table"') && tracker.includes('.proj-table {'));
assert('the old bespoke stat cards are gone from the dashboard',
  !truckDash.includes('statCard('));
const tm = read('api/lib/trucking-metrics.js');
assert('the trucking arithmetic is ported, not re-derived in SQL',
  fs.existsSync(path.resolve(__dirname, '../api/lib/trucking-metrics.js'))
  && report.includes("require('../lib/trucking-metrics')"));
assert('the old approximate Trucking tile is gone',
  !report.includes('buildTruckingTile') && report.includes('buildTruckingPortfolio'));
assert('revenue is hours × haul fee, as it is on the page — there is no stored column',
  /num\(e && e\.total_hours\) \* num\(e && e\.haul_fee\)/.test(tm)
  && /\(parseFloat\(e\.total_hours\)\|\|0\)\*\(parseFloat\(e\.haul_fee\)\|\|0\)/.test(truck));
assert('"this year" is the latest year with entries, falling back to the calendar year',
  /years\.length \? years\[years\.length - 1\] : String\(fallbackYear\)/.test(tm)
  && /allYears\.length \? allYears\[allYears\.length-1\] : String\(new Date\(\)\.getFullYear\(\)\)/.test(truck));
assert('the average haul fee is the mean rate, not revenue divided by hours',
  /reduce\(\(s, e\) => s \+ num\(e\.haul_fee\), 0\) \/ cur\.length/.test(tm));

// The page reads the blob because a save writes it synchronously; the mirror
// table lags behind. Reading the table here would show a stale day.
assert('trucking reads the same blob the page reads, with the table as a fallback',
  report.includes('TRUCK_DIVISION_BLOB') && /FROM truck_division_entries/.test(report));
assert('and hides orphaned injected rows without deleting them — a report mutates nothing',
  report.includes('findStaleTruckRows') && !report.includes('sweepInjectedTruckRows'));
// A dust haul billed off Dust Control Tracking posts no Truck Tracking row any
// more, and the rows posted before that was true are retired on read. Hiding
// them needs the per-leg half of the check as well: without it the report goes
// on counting those hauls as trucking revenue — the same hauls the dust
// roll-up already bills — until somebody happens to open the Trucking tab, at
// which point the division total moves on its own.
assert('the per-leg UB exclusion is applied here too, or the report double-counts a dust haul',
  report.includes('dustBilledLegs')
  && /findStaleTruckRows\(blobEntries, entriesById, ubLegs\)/.test(report));

const TRUCK_COLUMNS = ['Customer', 'Entries', 'Hours', 'Revenue', 'Avg / Hr',
                       'To Invoice', 'Awaiting Payment', 'Paid'];
const execTruckCols = headerLabels(exec, 'function renderTruckingSection(d) {', 2600);
assert('the customer table carries the work and the money still owed on it',
  TRUCK_COLUMNS.every((c, i) => execTruckCols[i] === c),
  'got: ' + JSON.stringify(execTruckCols));
const pageTruckCols = headerLabels(truck, 'const custTableHtml', 1400);
assert('and the Trucking page\'s own customer table has the same columns',
  TRUCK_COLUMNS.every((c, i) => pageTruckCols[i] === c),
  'got: ' + JSON.stringify(pageTruckCols));
// The page decides invoice state from the fields its Truck Tracking tab edits;
// the report has to read those same fields or the two will disagree.
assert('both read invoice state off invoice_sent_date and date_paid',
  /if \(e\.date_paid\)\s+return 'paid';/.test(truck)
  && /if \(e\.invoice_sent_date\)\s+return 'awaiting';/.test(truck)
  && /if \(e\.date_paid\) return 'paid';/.test(tm)
  && /if \(e\.invoice_sent_date\) return 'awaiting';/.test(tm));

// ── Intercompany mirrors the Intercompany dashboard ──
console.log('\n[intercompany mirrors the Intercompany dashboard]');

// The executive card is a fixed year-to-date snapshot and says so on every
// tile. The intercompany dashboard now carries a user-chosen date range, so it
// names the period once in its header badge instead of repeating a claim on six
// tiles that a narrowed window would make false. The two therefore mirror each
// other on the metric NAMES, and on the figures whenever the dashboard is on
// its default window — which is asserted directly below, because that default
// is the whole thing keeping the two screens reconciled.
const IC_METRICS = ['Total IC Revenue', 'Trucking IC', 'Dust Control IC',
                    'Total Hours', 'Customer Revenue', 'Outstanding IC'];
for (const label of IC_METRICS) {
  // Outstanding is the one tile the executive card does not date-qualify.
  const execLabel = label === 'Outstanding IC' ? label : `${label} — YTD`;
  assert(`the API builds "${execLabel}"`, report.includes(`label: '${execLabel}'`));
  assert(`  and intercompany.html still shows it`, ic.includes(`kpiCard('${label}'`));
}
// ic-metrics.js scopes on the year alone, so entries dated later this year are
// in its totals. The dashboard has to open on the same whole-year window or the
// two screens post different numbers for the same metric on first load.
assert('  and the dashboard opens on the whole year, matching ic-metrics',
  /let icRange = \{ preset: 'year'/.test(ic)
  && /case 'year':\s+return span\(new Date\(y, 0, 1\), new Date\(y, 11, 31\)\)/.test(ic),
  'the default range must cover the calendar year, not year-to-date');
assert('  and ic-metrics still scopes the executive card on the year',
  /slice\(0, 4\) === yr/.test(read('api/lib/ic-metrics.js')));

const im = read('api/lib/ic-metrics.js');
assert('the intercompany arithmetic is ported, not re-derived in SQL',
  fs.existsSync(path.resolve(__dirname, '../api/lib/ic-metrics.js'))
  && report.includes("require('../lib/ic-metrics')"));
assert('the old approximate Intercompany tile is gone',
  !report.includes('buildIntercompanyTile') && report.includes('buildIcPortfolio'));

// The blob is the source, not the mirror table: payment_received_date and the
// rates live only there, and the table keeps the duplicates the page collapses.
const icSection = report.slice(report.indexOf('async function buildIcPortfolio'));
assert('intercompany reads the billing blob, not the mirror table',
  report.includes('fct_intercompany_billing_entries')
  && !/FROM intercompany_billing_entries/.test(icSection));
assert('and nothing queries the mirror table for aged invoices either',
  !/FROM intercompany_billing_entries/.test(report));
assert('payment_received_date is a blob-only field, which is why',
  /payment_received_date/.test(im) && /payment_received_date/.test(ic)
  && !/payment_received_date/.test(read('neon-schema.sql')));
assert('the page\'s two-pass dedup comes across, so a re-send is not billed twice',
  /bestBySourceId/.test(im) && /bestByJobKey/.test(im)
  && /bestBySourceId/.test(ic) && /bestByJobKey/.test(ic));
assert('a payroll-injected dust row is decided by source_id alone — two are two real hauls',
  /isInjectedDust/.test(im) && /isInjectedDust/.test(ic));
assert('the intercompany amount is rate × quantity per source, with flat-total sources apart',
  /DUST_FLAT_TOTAL_SOURCES/.test(im) && /num\(e\.total_hours\) \* truckRate/.test(im)
  && /DUST_FLAT_TOTAL_SOURCES = \['dust-other-billing', 'dust-ees-other'\]/.test(ic));
assert('and it is not the customer total — the two prices are reported side by side',
  /customerRevenue/.test(report) && exec.includes('Customer Revenue'));
assert('the truck rate falls back to the page\'s own default when nothing is saved',
  /DEFAULT_TRUCK_RATE = 121/.test(im) && /ic_truck_rate.*121/.test(ic));

const IC_COLUMNS = ['Company', 'Hours', 'Trucking IC', 'Dust IC', 'Total IC',
                    'Customer Revenue', 'Not Invoiced', 'Awaiting Payment', 'Paid'];
const execIcCols = headerLabels(exec, '<th>Company</th>');
assert('the company table splits intercompany by division and by invoice state',
  IC_COLUMNS.every((c, i) => execIcCols[i] === c),
  'got: ' + JSON.stringify(execIcCols));

// ── The report is division sections and nothing else ──
console.log('\n[every division has its own section]');
assert('nothing is a snapshot tile',
  !exec.includes('id="divGrid"') && !exec.includes('renderDivisionTile')
  && !/snapshot\.divisions/.test(report));
assert('and the Company Snapshot above them is gone too',
  !exec.includes('Company Snapshot') && !exec.includes('id="heroKpis"')
  && !exec.includes('renderHero') && !/\bsnapshot\b/.test(report)
  && !/buildHero|mockHero/.test(report));
assert('the hero CSS went with it',
  !exec.includes('.hero-kpi') && !exec.includes('.delta-'));
assert('and the tile CSS went with it',
  !exec.includes('.div-tile') && !exec.includes('.div-kpi-'));
assert('as did the legacy timeline block it shared print rules with',
  !exec.includes('.timeline-'));
for (const key of ['turf', 'paving', 'kiewit', 'quarry', 'dust', 'trucking', 'intercompany', 'payroll']) {
  assert(`${key} has a section`, new RegExp(`'${key}'`).test(report));
}

// ── Every division page opens on the same components ──
console.log('\n[the division pages share one dashboard layout]');

for (const [name, html] of [['tracker', tracker], ['paving', paving], ['kiewit-pinetree', kiewit],
                            ['trucking', truck], ['quarry', quarry], ['dust', dust]]) {
  assert(`${name}.html opens on the shared metric strip`,
    html.includes('home-metric-strip') && html.includes('home-metric-value'));
  assert(`  and uses the shared table for its own rows`,
    html.includes('.proj-table') || html.includes('class="proj-table"'));
}
assert('the bespoke strips those pages used to carry are gone',
  !dust.includes('dash-kpi-item') && !dust.includes('dash-inv-card')
  && !quarry.includes('id="homeLocationCards"'));

// Quarry's pit cards became the table the Analytics tab already had, and both
// mount points now run through one builder.
assert('quarry renders Performance by Location from one shared builder',
  /function renderLocationTable\(selector, byLoc\)/.test(quarry)
  && /renderLocationTable\('#homeLocationTable tbody'/.test(quarry)
  && /renderLocationTable\('#analyticsLocationTable tbody'/.test(quarry));
const homeQuarryCols = headerLabels(quarry, 'id="homeLocationTable"');
assert('and its Home table has the same eleven columns as Analytics',
  QUARRY_COLUMNS.every((c, i) => homeQuarryCols[i] === c),
  'got: ' + JSON.stringify(homeQuarryCols));

// Quarry's Needs Attention holds a sentence, not a number — the strip's value
// style is nowrap + ellipsis, so it needs the text modifier or it truncates.
assert('quarry\'s text-valued metric is allowed to wrap',
  /\.home-metric-value\.is-text/.test(quarry)
  && /class="home-metric-value is-text" id="homeKpiLow"/.test(quarry));

// Dust's customer table has to classify invoices the same way the Invoice
// Overview beneath it does, or the two disagree on the same page.
const DUST_PAGE_COLUMNS = ['Customer', 'Visits', 'Gallons', 'Hours', 'Revenue',
                           'Avg / Visit', 'Overdue', 'Unpaid', 'Paid'];
const dustPageCols = headerLabels(dust, 'const custTableHtml', 1400);
assert('dust\'s customer table carries the visit and the money owed on it',
  DUST_PAGE_COLUMNS.every((c, i) => dustPageCols[i] === c),
  'got: ' + JSON.stringify(dustPageCols));
assert('and classifies invoices with effectiveInvStatus, as the Invoice Overview does',
  /const st = effectiveInvStatus\(r\);[\s\S]{0,200}c\.overdue/.test(dust));

// ── Print + email scope ──
console.log('\n[print and email scope]');
assert('each division section prints on its own via printSection()',
  exec.includes('function printSection(sectionId)') && exec.includes("printSection('${id}')"));
assert('the scoped print hides the other sections',
  /body\.printing-scoped #reportBody > \.section:not\(\.print-scope\)/.test(exec) &&
  /body\.printing-scoped #portfolioSections > \.section:not\(\.print-scope\)/.test(exec));
assert('and drops its scope classes when printing ends, so the full-report button still works',
  /afterprint[\s\S]{0,400}remove\('printing-scoped'\)|remove\('printing-scoped'\)[\s\S]{0,400}afterprint/.test(exec));
assert('the emailed report covers every section on the page',
  exec.includes("'#reportBody .section'"));
assert('and every division builds one, so none can be left out of it',
  ['renderPortfolioSection', 'renderQuarrySection', 'renderDustSection',
   'renderTruckingSection', 'renderIcSection', 'renderPayrollSection']
    .every(fn => exec.includes(`function ${fn}(`))
  && /renderDivisionSection\(d, \{/.test(exec));
assert('the per-project detail pages are gone from the report',
  !/pd-table|project-detail|renderDetail|projectDetails/.test(exec));
assert('and from the API, along with the per-project queries they needed',
  !/buildProjectDetails|buildDetailObject/.test(report));
assert('and strips the per-division PDF buttons out of the email',
  /section-action-btn'\)\.forEach\(btn => btn\.remove\(\)\)/.test(exec));

// ── Print legibility: nothing may print in a screen-only shade ──
console.log('\n[the PDF is ink on paper]');
const printBlock = exec.slice(exec.indexOf('@media print'), exec.indexOf('@media (max-width: 1200px)'));
for (const sel of ['.metric-strip', '.inv-card', '.tone-amber', '.ptable .v-contract',
                   '.ptable .v-variance-over', '.section-empty',
                   '.status-red', '.ptable tfoot .ptable-total td']) {
  assert(`${sel} has print colours`, printBlock.includes(sel));
}
// "18 more — View all in Turf" is a page control, not a figure: a link to
// another page is nothing on paper, and as the last thing in a section it takes
// a sheet of its own whenever the table fills the page. The section's own
// sub-line already reports the truncation — "6 pinned of 25 projects".
const moreRule = (printBlock.match(/[^{}]*\.ptable-more[^{}]*\{[^}]*\}/) || [''])[0];
assert('the "N more — View all in …" link does not print',
  /display:\s*none/.test(moreRule), moreRule || '(no .ptable-more rule in the print block)');
assert('and keeps no ink colours it can no longer use',
  moreRule !== '' && !/color:/.test(moreRule), moreRule);
// A blanket .metric-value colour after the tone palette flattens every figure on
// the strip to black on paper — margin, variance and overdue all reading alike.
assert('no blanket .metric-value colour undoes the tone palette in print',
  !/\.metric-value\s*\{[^}]*color:/.test(printBlock));
assert('row colours come from tone classes, not inline styles that would beat the print rules',
  exec.includes('class="pstatus tone-') && !exec.includes('STATUS_COLORS'));

console.log('');
// ── Dust Control renders its per-book composition ──────────────────────────
// Not a grep: the "Revenue by Billing Book" block was attached to
// renderQuarrySection for a whole commit — a one-line paste into the first of
// several identically-ending section renderers — and every structural check
// still passed, because the call WAS there and renderDustBooks DID exist. Only
// rendering the section catches that. Quarry carries no `books`, so the block
// silently returned '' there and the executive report simply never showed the
// composition behind a revenue figure that had just changed meaning.
console.log('\n[the executive report renders Dust Control\'s billing books]');
{
  // The render helpers, sliced out and run for real against stubs. Everything
  // from renderMetricStrip through the end of renderDustSection, which is all
  // of them plus the two other section renderers the block must NOT be on.
  const from = exec.indexOf('    function renderMetricStrip(metrics) {');
  const to   = exec.indexOf('\n', exec.indexOf('    function renderDustSection(d) {'));
  const end  = exec.indexOf('\n    }\n', to) + '\n    }\n'.length;
  assert('the render helpers are where the test expects', from > 0 && end > from);

  const ctx = {
    esc: s => String(s ?? '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtMoney: (n, o = {}) => (o.zeroDash && !(Math.abs(Number(n) || 0) > 0.005))
      ? '—' : '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    fmtCount: n => Math.round(Number(n) || 0).toLocaleString('en-US'),
    DIVISION_PAGES: {},
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(exec.slice(from, end), ctx);

  const payload = {
    key: 'dust', name: 'Dust Control', accent: '#fbbf24',
    status: 'On Track', statusKind: 'green', year: '2026',
    metrics: [{ label: 'YTD Revenue', value: '$50,000.00', tone: 'amber', sub: 'x' }],
    books: [
      { key: 'tracking', label: 'Dust Control Tracking', available: true, lines: 12,
        revenue: 30000, hours: 96, hoursLabel: 'field hours',
        hoursText: '96.0 field hours', volume: '40,000 gal UB',
        ar: 'invoiced here — sent, paid and overdue all tracked' },
      { key: 'other', label: 'Other Billing', available: true, lines: 5,
        revenue: 15000, hours: 20, hoursLabel: 'trucking hours',
        hoursText: '20.0 trucking hours', volume: '4,500.5 GAL · 40 BAG',
        ar: 'invoice number only — no sent or paid date on this side' },
      { key: 'ees', label: 'EES Other', available: false, lines: 0,
        revenue: 0, hours: 0, hoursLabel: 'billable hours',
        hoursText: '', volume: '',
        ar: 'no dust-side invoice — billed through Intercompany' },
    ],
    unavailable: ['EES Other'],
    unpriced: { count: 3, other: 1, ees: 2 },
    invoices: { untracked: { amount: 15000, count: 5, byBook: { other: 15000, ees: 0 } } },
    rows: [{
      name: 'CNX', meta: 'PA · WV', lastVisit: '2026-08-04',
      visits: 12, gallons: 40000, hours: 96,
      revenue: 45000, revenueTracking: 30000, revenueOther: 15000, revenueEes: 0,
      avgPerVisit: 2500, overdue: 1000, unpaid: 2000, paid: 27000, untracked: 15000,
    }],
  };

  ctx.__d = payload;
  const html = vm.runInContext('renderDustSection(__d)', ctx);

  assert('the Dust section renders the billing-book table',
    /Revenue by Billing Book|Billing book/.test(html), html.slice(0, 200));
  for (const label of ['Dust Control Tracking', 'Other Billing', 'EES Other']) {
    assert(`  it lists ${label}`, html.includes(label));
  }
  assert('  with the module\'s own volume string, not a re-rounded one',
    html.includes('4,500.5 GAL · 40 BAG'), 'part-bag was rounded away');
  assert('  and the module\'s own hours string',
    html.includes('96.0 field hours') && html.includes('20.0 trucking hours'));
  assert('  it states each book\'s invoicing regime',
    html.includes('sent, paid and overdue all tracked')
    && html.includes('no sent or paid date on this side'));
  assert('an unreadable book is called out, not shown as zero',
    /Could not read/.test(html) && html.includes('EES Other'), 'no unavailable banner');
  assert('money with no invoice state is named as such',
    /not AR-tracked|no dust-side invoice state/i.test(html), 'untracked note missing');
  assert('work recorded at no price is surfaced',
    /record work at no price|no price/i.test(html), 'unpriced note missing');
  assert('the customer table carries the Untracked column',
    html.includes('>Untracked<'), 'column missing');
  assert('and the per-customer books split is in the revenue tooltip',
    html.includes('Other Billing $15,000.00'), 'tooltip missing the split');

  // The other two section renderers must NOT carry it — that is the actual bug.
  const quarryHtml = vm.runInContext(
    'renderQuarrySection({ key: "quarry", name: "Quarry", metrics: [], rows: [], locations: [] })', ctx);
  assert('the Quarry section does not render dust\'s books block',
    !/Billing book/.test(quarryHtml));
}

if (failed) {
  console.error(`❌ ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('✅ all assertions passed');
