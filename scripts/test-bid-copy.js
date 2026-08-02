#!/usr/bin/env node
'use strict';
/**
 * Tests for "Copy Bid" — lifting bid line items from one project into
 * another, or into a brand new one.
 *
 * Run: node scripts/test-bid-copy.js          (all three division pages)
 *      node scripts/test-bid-copy.js paving.html
 *
 * The point of the feature is repeat scope: the same work gets bid again
 * on the next job, so the estimate travels and the job history does not.
 * Only cost code, sub code, unit, quantity and unit cost are copied —
 * start dates, target dates, completion flags, change orders and daily
 * costs describe how the SOURCE job ran and must stay behind, and every
 * copied line needs a fresh id or the two projects would share one.
 *
 * Layers, same shape as the sibling frontend tests:
 *   1. Structural — the button is wired, the copy carries exactly the
 *      five estimate fields, the new-project path goes through
 *      addProject() (which writes the blob before the index), and the
 *      destructive mode is behind a confirm.
 *   2. Behavioural — the row builder and the add-vs-update planner run
 *      in a sandboxed vm over a synthetic source project.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const FILES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const TARGET = process.argv[2];
if (!TARGET) {
  const { spawnSync } = require('child_process');
  let bad = 0;
  for (const f of FILES) {
    console.log(`\n══════════ ${f} ══════════`);
    if (spawnSync(process.execPath, [__filename, f], { stdio: 'inherit' }).status !== 0) bad++;
  }
  console.log(bad ? `\n${bad} file(s) FAILED` : `\nall ${FILES.length} division pages pass`);
  process.exit(bad ? 1 : 0);
}

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '..', TARGET), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log(`\n[structural — wiring (${TARGET})]`);
assert('bid view has a Copy Bid button', /<button[^>]*id="bid-fs-copy"/.test(src));
assert('openBidView wires it to showBidCopy',
  /function openBidView[\s\S]+?getElementById\('bid-fs-copy'\)\.onclick = \(\) => showBidCopy\(projId\)/.test(src));
for (const fn of ['showBidCopy', 'closeBidCopy', '_bcpMode', '_bcpRows', '_bcpToggleAll', '_bcpRefresh', 'commitBidCopy']) {
  assert(`defines ${fn}`, new RegExp(`function ${fn}\\s*\\(`).test(src));
}

console.log('\n[structural — what travels and what stays]');
const rowsFn = src.match(/function _bcpRows\(\)[\s\S]+?\n\}\n/);
assert('the row builder maps exactly the five estimate fields',
  !!rowsFn && /cost_code:[\s\S]+?sub_code:[\s\S]+?unit:[\s\S]+?quantity:[\s\S]+?unit_cost:/.test(rowsFn[0]));
for (const leak of ['start_date', 'target_date', 'is_complete', 'change_orders', 'dailyRows']) {
  assert(`  never carries ${leak}`, !!rowsFn && !new RegExp(leak).test(rowsFn[0]));
}
const commitFn = src.match(/function commitBidCopy\(\)[\s\S]+?\n\}\n/);
assert('copied lines get a fresh id', !!commitFn && /id: uid\(\)/.test(commitFn[0]));
assert('  and the pushed item has no job-history fields',
  !!commitFn && !/start_date|target_date|is_complete|change_orders/.test(
    (commitFn[0].match(/target\.bidItems\.push\(\{[\s\S]+?\}\);/) || [''])[0]));
assert('an update refreshes only quantity / unit cost / unit',
  !!commitFn && /hit\.quantity\s*=\s*r\.quantity;[\s\S]{0,120}hit\.unit_cost\s*=\s*r\.unit_cost;/.test(commitFn[0])
  && !/hit\.start_date|hit\.change_orders|hit\.id/.test(commitFn[0]));

console.log('\n[structural — the new-project path]');
// addProject() writes the new blob BEFORE the index, so the index can never
// reference a project the server has not stored. Rebuilding that by hand here
// would reintroduce the race it exists to avoid.
assert('a new destination is created via addProject()', !!commitFn && /addProject\(\);/.test(commitFn[0]));
assert('  and is found by diffing ids, not by position',
  !!commitFn && /const before = new Set\(projectsList\.map\(p => p\.id\)\);/.test(commitFn[0])
  && /projectsList\.find\(p => !before\.has\(p\.id\)\)/.test(commitFn[0]));
assert('  a blank name is refused', !!commitFn && /if \(!name\) \{ alert\(/.test(commitFn[0]));
assert('the destructive mode confirms first',
  !!commitFn && /mode === 'replace'[\s\S]{0,300}confirm\(/.test(commitFn[0]));
assert('the destination is persisted', !!commitFn && /saveProject\(targetId2\)/.test(commitFn[0]));
assert('the sub code catalog is invalidated', !!commitFn && /_bidScInvalidate\(\)/.test(commitFn[0]));
assert('the view lands on the destination',
  !!commitFn && /closeBidView\(\);\s*\n\s*openBidView\(targetId2\);/.test(commitFn[0]));
assert('preview and commit share the add-vs-update planner',
  !!commitFn && /_pcPlan\(/.test(commitFn[0])
  && /function _bcpRefresh\(\)[\s\S]+?_pcPlan\(/.test(src));

console.log('\n[structural — an empty bid is refused up front]');
const showFn = src.match(/function showBidCopy\(projId\)[\s\S]+?\n\}\n/);
assert('showBidCopy bails when there is nothing to copy',
  !!showFn && /if \(!items\.length\) \{ alert\([\s\S]{0,80}return; \}/.test(showFn[0]));
assert('  and the source project itself is never offered as a destination',
  !!showFn && /projectsList\.filter\(p => p\.id !== projId\)/.test(showFn[0]));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL
// ─────────────────────────────────────────────────────────────────────
function block(startLabel, endLabels) {
  const a = src.indexOf(startLabel);
  if (a < 0) throw new Error('block: missing ' + startLabel);
  const ends = [].concat(endLabels).map(e => src.indexOf(e, a)).filter(i => i > 0);
  if (!ends.length) throw new Error('block: missing end for ' + startLabel);
  return src.slice(a, Math.min(...ends));
}

// _bcpRows reads its selection out of the DOM; stub just enough of it.
const checked = { codes: new Set(), keepQty: true };
const sandbox = {
  projectsList: [],
  getProj(id) { return sandbox.projectsList.find(p => p.id === id); },
  _bcpSrcId: 'src',
  _cbLabel: o => (typeof o === 'string' ? o : o.label),
  document: {
    querySelectorAll: () => [...checked.codes].map(v => ({ value: v })),
    getElementById: id => (id === 'bcp-qty' ? { checked: checked.keepQty } : null),
    querySelector: () => null,
  },
};
vm.createContext(sandbox);
// _pcPlan matches on _pcKey, which lives with the Procore helpers.
vm.runInContext(block('// Procore writes free-text units', ['/* ── Import modal ── */']), sandbox);
// This span covers the sub code picker and the copy-bid block that follows it.
vm.runInContext(block('// Matching key: what counts as', ['// Off-bid daily costs', 'function removeBidGroup(', 'function renderBidTable(']), sandbox);
vm.runInContext(block('// Decide add-vs-update for every line', ['function _pcRenderPreview']), sandbox);
// `let _bcpSrcId` is declared by that span, and a lexical binding shadows any
// property of the same name — so point it at the source from inside.
vm.runInContext('_bcpSrcId = "src";', sandbox);
const { _bcpRows, _pcPlan } = sandbox;

sandbox.projectsList.push({
  id: 'src',
  bidItems: [
    { id: 's1', cost_code: 'Site Prep', sub_code: 'Bulk Excavation', unit: 'CY', quantity: '1200', unit_cost: '8.50',
      start_date: '2026-03-01', target_date: '2026-03-20', is_complete: true,
      change_orders: [{ id: 'co1', qty_delta: 100 }] },
    { id: 's2', cost_code: 'Site Prep', sub_code: 'Fine Grading',   unit: 'SF', quantity: '8000', unit_cost: '0.42' },
    { id: 's3', cost_code: 'Concrete',  sub_code: 'Slab on Grade',  unit: 'SF', quantity: '3000', unit_cost: '12.00' },
  ],
  dailyRows: [{ id: 'd1', sub_code: 'Bulk Excavation', labor_hours: 40 }],
});

console.log('\n[behavioural — the rows that get copied]');
checked.codes = new Set(['Site Prep', 'Concrete']);
let rows = _bcpRows();
assert('every selected line is included', rows.length === 3, String(rows.length));
assert('estimate fields carried', rows[0].cost_code === 'Site Prep' && rows[0].sub_code === 'Bulk Excavation'
  && rows[0].unit === 'CY' && rows[0].quantity === '1200' && rows[0].unit_cost === '8.50', JSON.stringify(rows[0]));
assert('no id travels with the row', !('id' in rows[0]));
assert('no dates, flag or change orders travel',
  !('start_date' in rows[0]) && !('target_date' in rows[0]) && !('is_complete' in rows[0]) && !('change_orders' in rows[0]),
  Object.keys(rows[0]).join(','));
assert('the row carries exactly five fields', Object.keys(rows[0]).length === 5, Object.keys(rows[0]).join(','));

checked.codes = new Set(['Concrete']);
rows = _bcpRows();
assert('an unselected cost code is left out', rows.length === 1 && rows[0].cost_code === 'Concrete', String(rows.length));

checked.codes = new Set();
assert('nothing selected copies nothing', _bcpRows().length === 0);

checked.codes = new Set(['Site Prep', 'Concrete']);
checked.keepQty = false;
rows = _bcpRows();
assert('quantities can be dropped', rows.every(r => r.quantity === ''), JSON.stringify(rows.map(r => r.quantity)));
assert('  while unit costs are kept', rows.every(r => r.unit_cost !== ''), JSON.stringify(rows.map(r => r.unit_cost)));
assert('  and the units are kept', rows.every(r => r.unit !== ''), JSON.stringify(rows.map(r => r.unit)));
checked.keepQty = true;

console.log('\n[behavioural — landing in the destination]');
rows = _bcpRows();
const dest = [
  { id: 'e1', cost_code: 'Site Prep', sub_code: 'Bulk Excavation', unit: 'CY', quantity: '900', unit_cost: '8.00', start_date: '2026-01-05' },
  { id: 'e2', cost_code: 'Own Work',  sub_code: 'Hand Added',      unit: 'LS', quantity: '1',   unit_cost: '500' },
];
const merged = _pcPlan(rows, dest);
assert('a line already there is planned as an update', merged.updated === 1 && merged.added === 2,
  `updated=${merged.updated} added=${merged.added}`);
assert('  targeting the existing item itself', merged.plan.find(e => e.action === 'update').target === dest[0]);
assert('  leaving the destination\'s own line alone', !merged.plan.some(e => e.target === dest[1]));
assert('an empty destination takes everything as new', _pcPlan(rows, []).added === rows.length);
// Copying the same bid twice must not stack duplicates.
assert('copying twice into the same place updates rather than duplicates',
  _pcPlan(rows, rows.map((r, i) => ({ id: 'x' + i, ...r }))).added === 0);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
