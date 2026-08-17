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
function headerLabels(html, marker) {
  const at = html.indexOf(marker);
  if (at < 0) return [];
  const slice = html.slice(at, at + 1600);
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
  assert(`  and quarry.html still shows it`, quarry.includes(`>${label}</div>`));
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
assert('plus the page\'s two invoice buckets',
  report.includes("label: 'Overdue'") && report.includes("label: 'Unpaid / Pending'")
  && dust.includes('>Overdue<') && dust.includes('>Unpaid / Pending<'));

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
assert('travel never counts as prevailing — the prevailing job\'s travel falls to standard',
  /prevailing_wage === true\) \{ acc\.pwHours \+= work; acc\.stdHours \+= travel; \}/.test(pm)
  && /prevailing_wage === true\) \{ acc\.pwHours \+= work; acc\.stdHours \+= travel; \}/.test(payroll));
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
  exec.includes('renderPayrollSection(payroll)')
  && !exec.includes('id="payrollBody"') && !exec.includes('id="payrollSub"'));

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
  ['renderPortfolioSection', 'renderQuarrySection', 'renderDustSection', 'renderPayrollSection']
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
                   '.ptable .v-variance-over', '.section-empty', '.ptable-more',
                   '.status-red', '.ptable tfoot .ptable-total td']) {
  assert(`${sel} has print colours`, printBlock.includes(sel));
}
// A blanket .metric-value colour after the tone palette flattens every figure on
// the strip to black on paper — margin, variance and overdue all reading alike.
assert('no blanket .metric-value colour undoes the tone palette in print',
  !/\.metric-value\s*\{[^}]*color:/.test(printBlock));
assert('row colours come from tone classes, not inline styles that would beat the print rules',
  exec.includes('class="pstatus tone-') && !exec.includes('STATUS_COLORS'));

console.log('');
if (failed) {
  console.error(`❌ ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('✅ all assertions passed');
