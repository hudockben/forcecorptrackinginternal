#!/usr/bin/env node
'use strict';
/**
 * Tests for the Procore estimate → bid items importer in tracker.html.
 *
 * Run: node scripts/test-procore-import.js
 *
 * Two layers, same shape as test-bid-items-frontend.js:
 *   1. Structural — greps tracker.html to verify the button exists, is
 *      wired from openBidView, and that the commit path still goes
 *      through saveProject / renderBidTable and only touches the four
 *      estimate fields on an update.
 *   2. Behavioural — evaluates the real parser + planner block inside a
 *      sandboxed vm and asserts on:
 *        - section rows (column A) become cost codes, item names
 *          (column B) become sub codes
 *        - the estimate's Summary/totals block never becomes line items
 *        - Procore's whitespace is trimmed and its free-text units are
 *          mapped onto the bid table's Unit dropdown values
 *        - header detection survives the title block above the table
 *        - merge planning claims each existing bid item at most once
 *
 * The .xlsx unzip path (_pcZipOpen / _pcZipRead / _pcSheetRows) needs
 * DOMParser + DecompressionStream, so it is exercised in the browser
 * rather than here; this file covers the estimate logic those feed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`);
  }
}

const src = fs.readFileSync(path.resolve(__dirname, '../tracker.html'), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log('\n[structural — tracker.html]');

assert('bid view has the Import Procore button',
  /<button[^>]*id="bid-fs-procore"/.test(src));
assert('openBidView wires the button to showProcoreImport',
  /function openBidView[\s\S]+?getElementById\('bid-fs-procore'\)\.onclick = \(\) => showProcoreImport\(projId\)/.test(src));

for (const fn of ['showProcoreImport', 'closeProcoreImport', 'previewProcoreImport',
                  'commitProcoreImport', '_pcParseEstimate', '_pcPlan', '_pcRowsFromFile',
                  '_pcZipOpen', '_pcZipRead', '_pcSheetRows', '_pcSharedStrings']) {
  assert(`defines ${fn}`, new RegExp(`function ${fn}\\s*\\(`).test(src));
}

const commitFn = src.match(/function commitProcoreImport\([\s\S]+?\n\}\n/);
assert('commit persists through saveProject',      !!commitFn && /saveProject\(projId\)/.test(commitFn[0]));
assert('commit re-renders the bid table',          !!commitFn && /renderBidTable\(projId\)/.test(commitFn[0]));
assert('commit mints ids with uid()',              !!commitFn && /id: uid\(\)/.test(commitFn[0]));
assert('commit confirms before a destructive replace',
  !!commitFn && /mode === 'replace'[\s\S]+confirm\(/.test(commitFn[0]));
// An update must not touch id / dates / change orders — those carry the
// item's daily costs and schedule.
const updateArm = commitFn && commitFn[0].match(/if \(action === 'update'\)[\s\S]+?\} else \{/);
assert('update writes only quantity / unit_cost / unit',
  !!updateArm && /target\.quantity/.test(updateArm[0]) && /target\.unit_cost/.test(updateArm[0])
    && !/target\.id/.test(updateArm[0]) && !/target\.start_date/.test(updateArm[0])
    && !/target\.change_orders/.test(updateArm[0]));

const previewFn = src.match(/function _pcRenderPreview\([\s\S]+?\n\}\n/);
assert('preview and commit share the same planner',
  !!previewFn && /_pcPlan\(/.test(previewFn[0]) && !!commitFn && /_pcPlan\(/.test(commitFn[0]));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL — run the real functions in a sandbox
// ─────────────────────────────────────────────────────────────────────
function extractBlock(startLabel, endLabel) {
  const start = src.indexOf(startLabel);
  const end   = src.indexOf(endLabel, start);
  if (start < 0 || end < 0) throw new Error(`extractBlock: missing labels ${startLabel} / ${endLabel}`);
  return src.slice(start, end);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  extractBlock('// Procore writes free-text units', '/* ── Import modal ── */') +
  extractBlock('// Decide add-vs-update for every line', 'function _pcRenderPreview'),
  sandbox
);
const { _pcNum, _pcUnit, _pcFix, _pcKey, _pcParseEstimate, _pcPlan } = sandbox;

console.log('\n[behavioural — numeric + unit coercion]');
assert('plain number',            _pcNum('34512') === 34512);
assert('decimal',                 _pcNum('1.794') === 1.794);
assert('currency + thousands',    _pcNum('$81,760.70') === 81760.70);
assert('parenthesised negative',  _pcNum('(500)') === -500);
assert('zero is a real value',    _pcNum('0') === 0);
assert('blank → null',            _pcNum('') === null);
assert('label text → null',       _pcNum('Profit') === null && _pcNum('Total labor') === null);
assert('float noise trimmed',     _pcFix(5.340000000000001) === '5.34');

assert('sq ft → SF',   _pcUnit('sq ft') === 'SF');
assert('ft → LF',      _pcUnit(' FT ')  === 'LF');
assert('cu yd → CY',   _pcUnit('cu yd') === 'CY');
assert('ton → TON',    _pcUnit('ton')   === 'TON');
assert('ea → EA',      _pcUnit('ea')    === 'EA');
assert('hrs → HR',     _pcUnit('hrs')   === 'HR');
assert('lb → LB',      _pcUnit('lb')    === 'LB');
assert('unknown → blank (never guessed)', _pcUnit('widgets') === '');

// A miniature Procore estimate export, laid out exactly like the real
// one: title block, header on row 5, section rows in column A, line
// items in column B, then the Summary/totals block at the bottom.
const H = [];
H[1] = 'Name'; H[2] = 'Unit Labor (mins)'; H[4] = 'Quantity'; H[5] = 'U/M'; H[6] = 'Unit Cost';
H[21] = 'Cost Code Name'; H[22] = 'Cost Code';
const row = (o) => { const r = []; Object.entries(o).forEach(([k, v]) => { r[+k] = v; }); return r; };
const rows = [
  row({ 0: 'Date', 1: '8/2/2026' }),
  [], row({ 0: 'List of items' }), [],
  H,
  row({ 0: 'Design and Permitting ' }),                                             // section (note trailing space)
  row({ 1: ' Infiltration Testing ', 4: '0', 5: 'ea', 6: '6000', 21: 'Geo', 22: '42-02' }),
  row({ 1: 'Survey/Layout',          4: '0', 5: 'ea', 6: '6500', 22: '34-03-01' }),
  row({ 0: 'Field Construction ' }),
  row({ 1: 'Bulk Excavation',        4: '34512', 5: 'sq ft', 6: '0.62' }),
  row({ 1: 'Export Spoil',           4: '1016',  5: 'ton',   6: '15.95' }),
  row({ 0: 'Custom items' }),
  row({ 4: '0', 5: 'ea', 6: '0' }),                                                  // blank-name placeholder
  row({ 4: '0', 5: 'ea', 6: '0' }),
  [],
  row({ 0: 'Summary' }),                                                             // everything below is totals
  row({ 1: 'Total sales', 3: 'Total cost', 4: 'Profit', 5: 'Lost Time and Waste', 6: 'Total labor' }),
  row({ 0: 'Total labor', 1: '19315.8', 3: '19315.8', 5: '0' }),
  row({ 0: 'Total Materials', 5: '0' }),
];

console.log('\n[behavioural — estimate parsing]');
const { items } = _pcParseEstimate(rows);
assert('found 4 line items', items.length === 4, `got ${items.length}: ${items.map(i => i.sub_code).join(' | ')}`);
assert('section row became the cost code',
  items[0].cost_code === 'Design and Permitting' && items[2].cost_code === 'Field Construction',
  items.map(i => i.cost_code).join(' | '));
assert('item name became the sub code',
  items[0].sub_code === 'Infiltration Testing' && items[2].sub_code === 'Bulk Excavation');
assert('cost codes are trimmed',   items.every(i => i.cost_code === i.cost_code.trim()));
assert('sub codes are trimmed',    items.every(i => i.sub_code === i.sub_code.trim()));
assert('quantity carried across',  items[2].quantity === '34512' && items[3].quantity === '1016');
assert('unit cost carried across', items[2].unit_cost === '0.62' && items[3].unit_cost === '15.95');
assert('U/M mapped to the dropdown', items[2].unit === 'SF' && items[3].unit === 'TON' && items[0].unit === 'EA');
assert('zero quantities are kept, not dropped', items[0].quantity === '0');
assert('blank-name placeholder rows skipped',
  !items.some(i => !i.sub_code));
assert('Summary block produced no line items',
  !items.some(i => /total|profit/i.test(i.sub_code)),
  items.map(i => i.sub_code).join(' | '));
assert('"Custom items" section did not leak in as a cost code',
  !items.some(i => i.cost_code === 'Custom items'));
assert('Procore cost code kept for the preview only',
  items[0].pcode === '42-02 · Geo' && !('cost_code_procore' in items[0]));

console.log('\n[behavioural — header detection]');
assert('throws a readable error when the header is missing', (() => {
  try { _pcParseEstimate([['hello', 'world'], ['1', '2']]); return false; }
  catch (e) { return /doesn't look like a Procore estimate export/.test(e.message); }
})());
// A shifted export (extra leading column) must still line up: the section
// column is always one to the left of Name.
const shifted = rows.map(r => (r.length ? ['', ...r] : r));
const shiftedOut = _pcParseEstimate(shifted);
assert('handles an export with an extra leading column',
  shiftedOut.items.length === 4 && shiftedOut.items[2].cost_code === 'Field Construction',
  `${shiftedOut.items.length} items`);

console.log('\n[behavioural — merge planning]');
const existing = [
  { id: 'b1', cost_code: 'Field Construction', sub_code: 'Bulk Excavation', quantity: '30000', unit_cost: '0.60', start_date: '2026-03-01' },
  { id: 'b2', cost_code: 'Hand Added',         sub_code: 'Punch List',      quantity: '1',     unit_cost: '900' },
];
const merged = _pcPlan(items, existing);
assert('matching line planned as an update', merged.updated === 1 && merged.added === 3,
  `updated=${merged.updated} added=${merged.added}`);
assert('update targets the existing item by identity',
  merged.plan.find(e => e.action === 'update').target === existing[0]);
assert('a hand-added line is never touched',
  !merged.plan.some(e => e.target === existing[1]));

assert('matching ignores case and surrounding whitespace',
  _pcKey(' FIELD construction ', 'bulk EXCAVATION ') === _pcKey('Field Construction', 'Bulk Excavation'));

// A sub code duplicated inside the estimate must add a second line rather
// than overwrite the first one twice.
const dupSource = [
  { cost_code: 'A', sub_code: 'X', quantity: '1', unit_cost: '1', unit: '' },
  { cost_code: 'A', sub_code: 'X', quantity: '2', unit_cost: '2', unit: '' },
];
const dupPlan = _pcPlan(dupSource, [{ id: 'e1', cost_code: 'A', sub_code: 'X', quantity: '9', unit_cost: '9' }]);
assert('each existing item is claimed at most once',
  dupPlan.updated === 1 && dupPlan.added === 1,
  `updated=${dupPlan.updated} added=${dupPlan.added}`);

assert('an empty existing list plans everything as new',
  _pcPlan(items, []).added === items.length);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
