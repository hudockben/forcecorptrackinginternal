#!/usr/bin/env node
'use strict';
/**
 * Tests for the Daily Tracking table's Cost Code and Sub Code pickers.
 *
 * Run: node scripts/test-daily-code-pickers.js
 *
 * Both columns used to be native <select>s. On a job carrying thirty cost
 * codes that is a scroll, and they were the two plain dropdowns left in a row
 * whose Employee, Equipment and Supplier columns are already the shared
 * typeahead combobox. They are now that same combobox.
 *
 * The risk is not the widget, it is what the widget feeds, and the two columns
 * are a pair rather than two independent controls. Daily rows are saved by two
 * delegated document-level listeners keyed on data-tab / data-i / data-f, and
 * a cost-code change does more than store a string: it drops a sub code the new
 * cost code does not carry and puts the rate back when the dropped one was
 * Travel. The sub code list itself is no longer rebuilt by that listener — the
 * picker reads the row's cost code every time it opens — which is the part most
 * likely to rot silently. A combobox commits by dispatching synthetic input and
 * change events, so all of it has to still fire. Both halves are checked here:
 *   1. Structural — each cell renders the combobox with the attributes the
 *      listeners key on, and the listener no longer writes <option> HTML into
 *      a cell that is not a <select> any more.
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
assert('the Sub Code cell is too',
  /\$\{cbHtml\('daily_subcodes:' \+ ai \+ '\|' \+ projId, row\.sub_code \|\| '', '— select —'/.test(src)
  && !/makeSelect\(row\.cost_code \?/.test(src));
// Without these the delegated listeners never see the commit and nothing saves.
assert('  carrying the attributes both delegated listeners key on',
  /cbHtml\('daily_codes:' \+ projId[^\n]*data-tab="daily" data-proj="\$\{projId\}" data-i="\$\{ai\}" data-f="cost_code"/.test(src));
assert('  and it commits through passthrough mode',
  /const passFlag  = passthroughAttrs \? ' data-passthrough="1"' : '';/.test(src)
  && /if \(cb\.dataset\.passthrough === '1'\)/.test(src));
// A menu positioned inside the row is clipped by the table's own scroll
// container. All four combobox columns opt into the fixed-position menu so the
// list escapes it — one column behaving differently from the three beside it
// reads as a bug even when both behaviours are defensible.
const dailyCbs = src.match(/cbHtml\([^\n]*data-tab="daily"[^\n]*\)\}/g) || [];
assert('the daily row has five comboboxes', dailyCbs.length === 5, String(dailyCbs.length));
assert('  and every one lifts its menu out of the table\'s scroll container',
  dailyCbs.every(c => c.includes(`'data-cb-fixed="1"'`)),
  dailyCbs.filter(c => !c.includes('data-cb-fixed')).join(' | ') || 'none missing');

assert('cbOptionsFor serves the daily_codes list',
  /if \(listKey\.startsWith\('daily_codes:'\)\) \{/.test(src));
assert('  slicing the project id off the right offset',
  /getCostCodes\(listKey\.slice\(12\)\)/.test(src) && 'daily_codes:'.length === 12);
assert('cbOptionsFor serves the daily_subcodes list off the row\'s live cost code',
  /if \(listKey\.startsWith\('daily_subcodes:'\)\) \{/.test(src)
  && /getSubCodes\(projId, row\.cost_code \|\| ''\)/.test(src)
  && 'daily_subcodes:'.length === 15);

// The cost-code branch used to write <option> HTML into the sub code cell.
// Left behind against a combobox that would wipe the input's menu container
// and put nothing usable back, and the sub code column would quietly stop
// working while still looking fine.
assert('the cost-code branch no longer writes <option> HTML into that cell',
  !/scSelect\.innerHTML = opts\.map\(o =>/.test(src)
  && !/const scSelect = rowEl\.querySelector/.test(src));
assert('  but still drops a sub code the new cost code does not carry',
  /if \(cur && !newSubCodes\.includes\(cur\)\) \{\s*\n\s*scEl\.value = '';\s*\n\s*p\.dailyRows\[i\]\.sub_code = '';/.test(src));

assert('no dead option lists were left behind',
  !/const ccOpts        = \['', \.\.\.costCodes/.test(src)
  && !/const costCodes     = getCostCodes\(projId\);/.test(src)
  && !/const scOpts        = \['', \.\.\.subCodes/.test(src)
  && !/const subCodes      = getSubCodes\(projId\);/.test(src));

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
  grab('function _cbPositionFixed('),
  grab('function _cbRepositionFixedMenus('),
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
   var _bidScInvalidate = () => { bidScInvalidations++; };
   var dailyNavFromEl = () => false;
   var fmt = n => String(n);
   var TRAVEL_RATE = 18, STANDARD_RATE = 41.5;
   var dailyRowAutoRate = (proj, row) =>
     (row.sub_code || '').trim().toLowerCase() === 'travel' ? TRAVEL_RATE : STANDARD_RATE;
   var bidScInvalidations = 0;
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
   function _probe() { return { row: PROJ.dailyRows[0], saves, bidScInvalidations }; }`,
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
function cellTemplate(listKey) {
  const line = src.split('\n').find(l => l.includes(`cbHtml('${listKey}`));
  if (line) return line.trim();
  assert(`the ${listKey} cell template is where the behavioural half can find it`, false,
    'the structural failures above say why');
  console.log(`\n${failed} failed, ${passed} passed.`);
  process.exit(1);
}
window.eval('var projId = "p1", ai = 0, row = PROJ.dailyRows[0];');
const costCell = window.eval('`' + cellTemplate('daily_codes:') + '`');
const subCell  = window.eval('`' + cellTemplate('daily_subcodes:') + '`');

doc.getElementById('daily-tbody-p1').innerHTML = `
  <tr>
    ${costCell}
    ${subCell}
    <td><input data-tab="daily" data-proj="p1" data-i="0" data-f="rate" value="99"></td>
  </tr>`;

const input  = doc.querySelector('[data-f="cost_code"]');
const scEl   = doc.querySelector('[data-f="sub_code"]');
const rateEl = doc.querySelector('[data-f="rate"]');
// Each combobox owns the menu that follows it, so the two are read apart.
const menuOf = el => [...el.nextElementSibling.querySelectorAll('.cb-opt')].map(o => o.dataset.val);
const menu   = () => menuOf(input);
const subs   = () => { window.cbOnFocus(scEl); const m = menuOf(scEl); window.cbClose(scEl); return m; };
const type   = text => { input.value = text; window.cbOnInput({ stopPropagation() {} }, input); };

assert('the Cost Code cell renders a combobox bound to this job',
  Boolean(input) && input.closest('.cb').dataset.list === 'daily_codes:p1',
  input && input.closest('.cb').dataset.list);
assert('  showing the row\'s saved cost code', input.value === 'Earthwork', input.value);
assert('the Sub Code cell renders one bound to this row',
  Boolean(scEl) && scEl.closest('.cb').dataset.list === 'daily_subcodes:0|p1',
  scEl && scEl.closest('.cb').dataset.list);
assert('  showing the row\'s saved sub code', scEl.value === 'Travel', scEl.value);
// The whole point of keying on the row: the list follows the cost code that
// row happens to hold, not one baked in when the table was drawn.
assert('  offering only the sub codes this row\'s cost code carries',
  subs().join('|') === 'Cut|Fill|Travel', subs().join('|'));

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
assert('the sub code list now follows the new cost code', subs().join('|') === '', subs().join('|'));
assert('a sub code the new cost code does not carry is cleared',
  p.row.sub_code === '' && scEl.value === '', `${p.row.sub_code} / ${scEl.value}`);
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
  subs().join('|') === 'Cut|Fill|Silt Fence|Travel', subs().join('|'));

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

console.log('\n[behavioural — the sub code commits too]');

// Put the row back on a cost code that carries sub codes.
window.cbOnFocus(input);
input.value = 'Earthwork';
window.cbCommitInput(input);
assert('the sub code list comes back with the cost code',
  subs().join('|') === 'Cut|Fill|Travel', subs().join('|'));

window.cbOnFocus(scEl);
scEl.value = 'fi';
window.cbOnInput({ stopPropagation() {} }, scEl);
assert('typing narrows the sub code list', menuOf(scEl).join('|') === 'Fill', menuOf(scEl).join('|'));
scEl.value = 'Fill';
window.cbCommitInput(scEl);
p = window._probe();
assert('picking a sub code stores it', p.row.sub_code === 'Fill', p.row.sub_code);
assert('  and flushes on blur the way the cost code does',
  p.saves.now[p.saves.now.length - 1][2] === 'Fill', JSON.stringify(p.saves.now.slice(-1)));
// The bid sub-code picker caches the names in use; a commit here has to
// invalidate it or that list goes stale.
assert('  and invalidates the bid sub-code cache',
  p.bidScInvalidations > 0, String(p.bidScInvalidations));

// Travel is the one sub code that drives the rate, in both directions.
window.cbOnFocus(scEl);
scEl.value = 'Travel';
window.cbCommitInput(scEl);
p = window._probe();
assert('moving onto Travel forces its flat rate',
  p.row.rate === 18 && rateEl.value === '18', `${p.row.rate} / ${rateEl.value}`);
window.cbOnFocus(scEl);
scEl.value = 'Cut';
window.cbCommitInput(scEl);
p = window._probe();
assert('  and leaving it restores the standard rate',
  p.row.rate === 41.5 && rateEl.value === '41.5', `${p.row.rate} / ${rateEl.value}`);
// A rate typed by hand has to survive a re-categorization that never touches
// Travel — the reason that branch is gated rather than unconditional.
window.PROJ.dailyRows[0].rate = '77';
rateEl.value = '77';
window.cbOnFocus(scEl);
scEl.value = 'Fill';
window.cbCommitInput(scEl);
p = window._probe();
assert('a hand-typed rate survives a non-Travel re-categorization',
  p.row.rate === '77' && rateEl.value === '77', `${p.row.rate} / ${rateEl.value}`);

console.log('\n[behavioural — the menu escapes the table]');

const cbMenu = doc.querySelector('.cb-menu');
window.cbOnFocus(input);
assert('opening the menu pins it to the viewport, clear of the scroll container',
  cbMenu.style.position === 'fixed', cbMenu.style.position || '(unset)');
// jsdom hands out a zeroed rect, so this is the "room below" branch.
assert('  hanging just under the cell when there is room',
  cbMenu.style.top === '2px' && cbMenu.style.bottom === 'auto',
  `${cbMenu.style.top} / ${cbMenu.style.bottom}`);

// A row near the bottom of the window has to open upward instead of running
// off the screen — the case that makes the last rows of a long day unusable.
input.getBoundingClientRect = () => ({ left: 100, top: 700, bottom: 720, width: 180, right: 280, height: 20 });
window.cbRenderMenu(input);
assert('  and flipping above the cell when there is not',
  cbMenu.style.top === 'auto' && cbMenu.style.bottom === '70px',
  `${cbMenu.style.top} / ${cbMenu.style.bottom}`);
assert('  lined up on the cell it belongs to', cbMenu.style.left === '100px', cbMenu.style.left);

// Scrolling the table moves the cell out from under the menu. A viewport-fixed
// menu does not move with it unless something moves it.
input.getBoundingClientRect = () => ({ left: 40, top: 120, bottom: 140, width: 180, right: 220, height: 20 });
window._cbRepositionFixedMenus();
assert('a scroll drags the open menu back onto its cell',
  cbMenu.style.left === '40px' && cbMenu.style.top === '142px',
  `${cbMenu.style.left} / ${cbMenu.style.top}`);

// The opt-in has to stay an opt-in: every other combobox on the page — bid
// rows, PO lines, the job picker — relies on its menu staying in the flow.
doc.body.insertAdjacentHTML('beforeend',
  `<div id="control">${window.cbHtml('daily_codes:p1', '', '— select —', 'data-tab="x"')}</div>`);
const plain = doc.querySelector('#control .cb-input');
window.cbOnFocus(plain);
assert('a combobox that did not opt in keeps its menu in the flow',
  doc.querySelector('#control .cb-menu').style.position === '',
  doc.querySelector('#control .cb-menu').style.position || '(unset)');

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nall ${passed} checks passed.`);
process.exit(failed ? 1 : 0);
