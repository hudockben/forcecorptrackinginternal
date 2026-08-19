#!/usr/bin/env node
'use strict';
/**
 * Tests for the Daily Tracking table's Cost Code picker.
 *
 * Run: node scripts/test-daily-costcode-picker.js
 *
 * The Cost Code column used to be a native <select>. On a job carrying thirty
 * cost codes that is a scroll, and it was the one plain dropdown left in a row
 * whose Employee, Equipment and Supplier columns are already the shared
 * typeahead combobox. It is now that same combobox.
 *
 * The risk is not the widget, it is what the widget feeds. Daily rows are
 * saved by two delegated document-level listeners keyed on data-tab / data-i /
 * data-f, and a cost-code change does more than store a string: it repopulates
 * the Sub Code <select> beside it, clears a sub code the new cost code does not
 * carry, and puts the rate back when the cleared one was Travel. A combobox
 * commits by dispatching synthetic input + change events, so all of that has to
 * still fire. Both halves are checked here:
 *   1. Structural — the cell renders the combobox with the attributes the
 *      listeners key on, and the Sub Code cell is still a <select>, because
 *      the cost-code branch rewrites its options directly.
 *   2. Behavioural — the real listeners and the real combobox, sliced out of
 *      the page and run against a synthetic job in a real DOM.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// The daily table ships in all three division pages. With no argument this
// re-runs itself once per file so each one is checked independently.
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

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve(__dirname, '..', TARGET), 'utf8');

// ─────────────────────────────────────────────────────────────────────
// 1) STRUCTURAL
// ─────────────────────────────────────────────────────────────────────
console.log(`\n[structural — the cell (${TARGET})]`);

assert('the Cost Code cell is the shared combobox, not a <select>',
  /\$\{cbHtml\('daily_codes:' \+ projId, row\.cost_code \|\| '', '— select —'/.test(src)
  && !/makeSelect\(ccOpts/.test(src));
// Without these the delegated listeners never see the commit and nothing saves.
assert('  carrying the attributes both delegated listeners key on',
  /cbHtml\('daily_codes:' \+ projId[^\n]*data-tab="daily" data-proj="\$\{projId\}" data-i="\$\{ai\}" data-f="cost_code"/.test(src));
assert('  and it commits through passthrough mode',
  /const passFlag  = passthroughAttrs \? ' data-passthrough="1"' : '';/.test(src)
  && /if \(cb\.dataset\.passthrough === '1'\)/.test(src));
assert('cbOptionsFor serves the daily_codes list',
  /if \(listKey\.startsWith\('daily_codes:'\)\) \{/.test(src));
assert('  slicing the project id off the right offset',
  /getCostCodes\(listKey\.slice\(12\)\)/.test(src) && 'daily_codes:'.length === 12);

// The cost-code branch of the input listener rewrites the sub code cell's
// options as <option> HTML. Turning that cell into a combobox would leave it
// silently unfilterable, so it is pinned here rather than left to be noticed
// in production.
assert('the Sub Code cell is still a <select>, which the cost-code branch rewrites',
  /makeSelect\(row\.cost_code \? \['', \.\.\.getSubCodes\(projId, row\.cost_code\)/.test(src)
  && /scSelect\.innerHTML = opts\.map\(o =>/.test(src));

assert('no dead cost-code option list was left behind',
  !/const ccOpts        = \['', \.\.\.costCodes/.test(src)
  && !/const costCodes     = getCostCodes\(projId\);/.test(src));

// ─────────────────────────────────────────────────────────────────────
// 2) BEHAVIOURAL
// ─────────────────────────────────────────────────────────────────────
console.log('\n[behavioural — a commit reaches the row]');

// Lift a declaration out of the page, brace-matched to its close.
function grab(header, tail = '') {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`${TARGET}: no ${header}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1) + tail;
  }
  throw new Error(`${TARGET}: unbalanced ${header}`);
}
function grabLine(header) {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`${TARGET}: no ${header}`);
  return src.slice(at, src.indexOf('\n', at));
}

const CODES = ['Earthwork', 'Site Bituminous Paving', 'Design & Permitting', 'E&S'];
// Only Earthwork carries Travel; picking anything else must clear it.
const SUBS  = { 'Earthwork': ['Cut', 'Fill', 'Travel'], 'E&S': ['Silt Fence'] };

const harness = [
  grabLine('const _cbState = new WeakMap();'),
  grabLine('const _cbEsc = s =>'),
  grabLine('const _cbLabel = o =>'),
  grabLine('function esc(s) {'),
  grab('function cbHtml('),
  grab('function cbOptionsFor('),
  grab('function cbFilterFor('),
  grab('function cbOnFocus('),
  grab('function cbOnInput('),
  grab('function cbRenderMenu('),
  grab('function cbClose('),
  grab('function cbCommitInput('),
  grab("document.addEventListener('input', e => {", ');'),
  grab("document.addEventListener('change', e => {", ');'),
  // The page globals those reach for, and nothing more.
  `var CODES = ${JSON.stringify(CODES)};
   var SUBS  = ${JSON.stringify(SUBS)};
   var TRAVEL_SUB_CODE = 'travel';
   var INJECTED_EDITABLE_FIELDS = new Set(['cost_code', 'sub_code', 'job_class', 'quantity']);
   var lists = { employees: [], equipment: [] };
   var costRows = [];
   var saveCostRows = () => {};
   var renderCostTable = () => {};
   var renderDailyCalcCells = () => {};
   var _bidScInvalidate = () => {};
   var dailyNavFromEl = () => false;
   var fmt = n => String(n);
   var AUTO_RATE = 41.5;
   var dailyRowAutoRate = () => AUTO_RATE;
   var saves = { debounced: [], now: [] };
   var drPutDebounced = (id, row) => saves.debounced.push([id, row.cost_code, row.sub_code]);
   var drPutNow       = (id, row) => saves.now.push([id, row.cost_code, row.sub_code]);
   function getCostCodes(projId) { return projId === 'p1' ? CODES.slice() : []; }
   function getSubCodes(projId, costCode) {
     if (costCode) return (SUBS[costCode] || []).slice();
     return [...new Set(Object.values(SUBS).flat())];
   }
   var PROJ = { id: 'p1', dailyRows: [
     { id: 'r1', cost_code: 'Earthwork', sub_code: 'Travel', rate: '99', job_class: '', quantity: '' },
   ] };
   function getProj(id) { return id === 'p1' ? PROJ : null; }
   function _probe() { return { row: PROJ.dailyRows[0], saves }; }`,
].join('\n\n');

const dom = new JSDOM(`<!doctype html><body><table><tbody id="daily-tbody-p1"></tbody></table></body>`,
  { url: 'http://localhost/', runScripts: 'dangerously' });
const { window } = dom;
window.eval(harness);
const doc = window.document;

// One daily row, built from the page's own cell template rather than a copy
// of it — so a change to the real cell lands in this test instead of sliding
// past it. The line is a template literal in the page and is evaluated as one
// here, with the same three names renderDailyTable has in scope at that point.
const cellLine = src.split('\n').find(l => l.includes("cbHtml('daily_codes:' + projId"));
if (!cellLine) {
  assert('the Cost Code cell template is where the behavioural half can find it', false,
    'no line calls cbHtml with daily_codes — the structural failures above say why');
  console.log(`\n${failed} failed, ${passed} passed.`);
  process.exit(1);
}
window.eval('var projId = "p1", ai = 0, row = PROJ.dailyRows[0];');
const costCell = window.eval('`' + cellLine.trim() + '`');

doc.getElementById('daily-tbody-p1').innerHTML = `
  <tr>
    ${costCell}
    <td><select data-tab="daily" data-proj="p1" data-i="0" data-f="sub_code">
          <option value=""></option><option value="Travel" selected>Travel</option>
        </select></td>
    <td><input data-tab="daily" data-proj="p1" data-i="0" data-f="rate" value="99"></td>
  </tr>`;

const input  = doc.querySelector('.cb-input');
const scSel  = doc.querySelector('[data-f="sub_code"]');
const rateEl = doc.querySelector('[data-f="rate"]');
const menu   = () => [...doc.querySelectorAll('.cb-opt')].map(o => o.dataset.val);
const type   = text => { input.value = text; window.cbOnInput({ stopPropagation() {} }, input); };

assert('the cell renders a combobox bound to this job',
  Boolean(input) && input.closest('.cb').dataset.list === 'daily_codes:p1',
  input && input.closest('.cb').dataset.list);
assert('  showing the row\'s saved cost code', input.value === 'Earthwork', input.value);

window.cbOnFocus(input);
assert('the menu offers the job\'s cost codes, sorted, with no blank row',
  menu().join('|') === 'Design & Permitting|E&S|Earthwork|Site Bituminous Paving', menu().join('|'));

type('bitum');
assert('typing part of a code narrows to it',
  menu().join('|') === 'Site Bituminous Paving', menu().join('|'));
type('&');
assert('a code with an ampersand is matchable and not double-escaped',
  menu().join('|') === 'Design & Permitting|E&S', menu().join('|'));

// Commit the way the menu's mousedown delegate does.
type('');
const pick = [...doc.querySelectorAll('.cb-opt')].find(o => o.dataset.val === 'Site Bituminous Paving');
input.value = pick.dataset.val;
window.cbCommitInput(input);

let p = window._probe();
assert('the pick is stored on the row', p.row.cost_code === 'Site Bituminous Paving', p.row.cost_code);
assert('the sub code list is rebuilt for the new cost code',
  [...scSel.options].map(o => o.value).join('|') === '', [...scSel.options].map(o => o.value).join('|'));
assert('a sub code the new cost code does not carry is cleared',
  p.row.sub_code === '' && scSel.value === '', `${p.row.sub_code} / ${scSel.value}`);
assert('and the rate falls back off the Travel flat rate',
  p.row.rate === 41.5 && rateEl.value === '41.5', `${p.row.rate} / ${rateEl.value}`);
assert('the debounced write fired', p.saves.debounced.length === 1, JSON.stringify(p.saves.debounced));
assert('and the blur flush wrote immediately, so nothing waits on a timer',
  p.saves.now.length === 1 && p.saves.now[0][1] === 'Site Bituminous Paving',
  JSON.stringify(p.saves.now));

// Emptying the box has to still clear the code — a cost code must be removable.
window.cbOnFocus(input);
type('');
window.cbCommitInput(input);
p = window._probe();
assert('emptying the box clears the cost code', p.row.cost_code === '', JSON.stringify(p.row.cost_code));
assert('  and the sub code list falls back to every sub code on the job',
  [...scSel.options].map(o => o.value).join('|') === '|Cut|Fill|Silt Fence|Travel',
  [...scSel.options].map(o => o.value).join('|'));

// A code retired from the lists must still show and must survive an idle
// focus/blur — the <select> guaranteed this by carrying the saved value as an
// extra option, and the combobox has to keep the promise.
window.PROJ.dailyRows[0].cost_code = 'Retired Code 1970';
input.value = 'Retired Code 1970';
window.cbOnFocus(input);
window.cbCommitInput(input);
p = window._probe();
assert('a cost code no longer in the lists still displays', input.value === 'Retired Code 1970', input.value);
assert('  and survives a focus and blur that changed nothing',
  p.row.cost_code === 'Retired Code 1970', p.row.cost_code);

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nall ${passed} checks passed.`);
process.exit(failed ? 1 : 0);
