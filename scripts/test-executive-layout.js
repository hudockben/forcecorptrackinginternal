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
                   '.ptable .v-variance-over', '.section-empty', '.ptable-more']) {
  assert(`${sel} has print colours`, printBlock.includes(sel));
}
assert('row colours come from tone classes, not inline styles that would beat the print rules',
  exec.includes('class="pstatus tone-') && !exec.includes('STATUS_COLORS'));

console.log('');
if (failed) {
  console.error(`❌ ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('✅ all assertions passed');
