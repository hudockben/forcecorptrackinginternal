#!/usr/bin/env node
'use strict';
/**
 * Cost per unit of measure on the bid page's green cost-code bar.
 *
 * Run: node scripts/test-bid-group-unit-cost.js
 *
 * A section like "Full Depth Pavement" is built out of sub codes that are each
 * bought and placed in their own units — tons of base, tons of top, hours of
 * labor — so none of them is the section's size. The green bar now takes a
 * quantity typed for the section as a whole (100 SY) and divides the section's
 * Actual Cost by it: "100 SY @ $711.05/SY". The quantity is kept on the
 * project under 'bid-group-measures', keyed by cost code.
 *
 * Three layers, matching the other bid-header tests:
 *   1. Behavioural — the real helpers out of each division page, run against
 *      fixtures: the division, the empty and readonly states, and a free-text
 *      cost code surviving the trip through a data attribute.
 *   2. The in-place edit, in jsdom — typing redraws the figure and stores the
 *      quantity without rebuilding the table (which would take the cursor out
 *      of the box), and a rename or delete of the cost code carries it along.
 *   3. Structural — both header layouts carry the chip, and it is filled from
 *      the same totals the section's Total row prints. The printed bid report
 *      (also what the Email button and the scheduled auto-report send) carries
 *      the same figure on its cost-code header rows.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PAGES = [
  { file: 'tracker.html',         unit: 'SF' },
  { file: 'paving.html',          unit: 'SY' },
  { file: 'kiewit-pinetree.html', unit: 'SY' },
];

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + detail : ''}`); }
}

/* Lift one top-level function out of the page by brace-matching its body.
   Brace matching starts after the parameter list, not at the first `{` in the
   source — a default parameter puts a brace in the signature. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let paren = 0, i = src.indexOf('(', start);
  for (; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')' && --paren === 0) break;
  }
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name} is not closed`);
}

function extractLine(src, startsWith) {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error(`${startsWith} not found`);
  return src.slice(i, src.indexOf('\n', i));
}

/* The helpers run inside a jsdom window, so the edit handlers get a real
   closest() / querySelector() / focus() to work against. Scripts run
   'dangerously' so the chip's own inline onclick / oninput / onchange /
   onfocusout fire on dispatched events — the wiring is tested, not just the
   functions it is meant to call. The header row gets the same click-to-
   collapse the bid table gives it, so a click that leaks out of the chip
   shows up as a collapsed section. */
function load(src) {
  const dom = new JSDOM('<!doctype html><table><tbody><tr class="bid-group-hdr" data-collapsed="0"><td id="cell"></td></tr></tbody></table>',
    { runScripts: 'dangerously' });
  const w = dom.window;
  w.confirm = () => true;
  const hdr = w.document.querySelector('tr.bid-group-hdr');
  hdr.addEventListener('click', () => { hdr.dataset.collapsed = hdr.dataset.collapsed === '1' ? '0' : '1'; });
  w.eval(`
    let _proj = null, _saves = 0, _renders = 0;
    function setProj(p) { _proj = p; }
    function getProj(id) { return _proj && _proj.id === id ? _proj : null; }
    function saveProject() { _saves++; }
    function renderBidTable() { _renders++; }
    function counts() { return { saves: _saves, renders: _renders }; }
    ${extractFunction(src, 'fmt')}
    ${extractFunction(src, 'qfmt')}
    ${extractLine(src, 'const _cbEsc =')}
    ${extractLine(src, 'const UNIT_OPTS =')}
    ${extractLine(src, 'const BID_GROUP_UNIT_DEFAULT =')}
    ${extractFunction(src, '_bidGroupMeasure')}
    ${extractFunction(src, '_bidGroupUnitCostText')}
    ${extractFunction(src, '_bidGroupUnitCostTip')}
    ${extractFunction(src, '_bidGroupUnitCostHTML')}
    ${extractFunction(src, '_bidGroupMeasureOpen')}
    ${extractFunction(src, '_bidGroupMeasureBlur')}
    ${extractFunction(src, '_bidGroupMeasureEdit')}
    ${extractFunction(src, 'removeBidGroup')}
    ${extractFunction(src, 'removeBidItem')}
    ${extractFunction(src, 'updateBidGroupCode')}
    window.__t = { setProj, counts, BID_GROUP_UNIT_DEFAULT, _bidGroupMeasure, _bidGroupUnitCostText,
      _bidGroupUnitCostTip, _bidGroupUnitCostHTML, _bidGroupMeasureOpen, _bidGroupMeasureBlur,
      _bidGroupMeasureEdit, removeBidGroup, removeBidItem, updateBidGroupCode };
  `);
  return { w, doc: w.document, t: w.__t, hdr };
}

// ── Fixtures — the section from the request ─────────────────────────────────
const FDP    = 'Full Depth Pavement';
const TOTALS = { actual: 71104.85, bid: 0, proj: 71104.85, allDone: true };
// A section still being built: actual, projected and bid all differ, so a
// figure that divided the wrong one of them reads a different number.
const LIVE   = { actual: 35000, bid: 60000, proj: 70000, allDone: false };
const proj   = measures => ({ id: 'p1', bidItems: [], 'bid-group-measures': measures });

for (const page of PAGES) {
  console.log(`\n[${page.file}]`);
  const src = fs.readFileSync(path.resolve(__dirname, '..', page.file), 'utf8');
  const { w, doc, t, hdr } = load(src);
  const U = page.unit;
  const cell = doc.getElementById('cell');
  const draw = (code, totals, readonly) => {
    cell.innerHTML = t._bidGroupUnitCostHTML('p1', code, totals, readonly);
    return cell.querySelector('.bid-grp-uc');
  };

  // ── 1. The figure ─────────────────────────────────────────────────────────
  console.log('  — the division');
  assert('$71,104.85 over 100 SY is $711.05/SY',
    t._bidGroupUnitCostText(71104.85, 100, 'SY') === '$711.05/SY', t._bidGroupUnitCostText(71104.85, 100, 'SY'));
  assert('it rounds to the cent', t._bidGroupUnitCostText(71104.85, 250, 'SY') === '$284.42/SY');
  assert('thousands are grouped', t._bidGroupUnitCostText(12500, 4, 'EA') === '$3,125.00/EA');
  assert('a quantity with nothing spent yet reads a dash, not $0.00',
    t._bidGroupUnitCostText(0, 100, 'SY') === '—/SY');
  assert('no quantity never divides by zero', t._bidGroupUnitCostText(500, 0, 'SY') === '—/SY');

  console.log('  — the stored quantity');
  assert(`the default unit on this page is ${U}`, t.BID_GROUP_UNIT_DEFAULT === U, t.BID_GROUP_UNIT_DEFAULT);
  let m = t._bidGroupMeasure(proj({ [FDP]: { qty: 100, unit: 'SY' } }), FDP);
  assert('a stored measure reads back', m.qty === 100 && m.unit === 'SY', JSON.stringify(m));
  m = t._bidGroupMeasure(proj({ [FDP]: { qty: '1250.5', unit: 'SF' } }), FDP);
  assert('a quantity stored as text still reads as a number', m.qty === 1250.5 && m.unit === 'SF');
  m = t._bidGroupMeasure(proj({}), FDP);
  assert(`a section with none is 0 ${U}`, m.qty === 0 && m.unit === U, JSON.stringify(m));
  m = t._bidGroupMeasure({ id: 'p1' }, FDP);
  assert('a project from before this feature reads as none', m.qty === 0 && m.unit === U);
  m = t._bidGroupMeasure(null, FDP);
  assert('no project at all reads as none', m.qty === 0);
  m = t._bidGroupMeasure(proj({}), 'constructor');
  assert('a cost code named "constructor" does not read Object\'s own property', m.qty === 0 && m.unit === U,
    JSON.stringify(m));

  console.log('  — the chip');
  t.setProj(proj({}));
  assert('a readonly table prints nothing until there is a quantity',
    t._bidGroupUnitCostHTML('p1', FDP, TOTALS, true) === '');
  let el = draw(FDP, TOTALS, false);
  assert('an editable one offers to add it', el && el.classList.contains('uc-empty')
    && el.querySelector('.bid-grp-uc-add').textContent.trim() === `+ Cost / ${U}`);

  t.setProj(proj({ [FDP]: { qty: 100, unit: 'SY' } }));
  el = draw(FDP, TOTALS, true);
  assert('readonly: "100 SY @ $711.05/SY"',
    el && el.textContent.replace(/\s+/g, ' ').trim() === '100 SY@$711.05/SY', el && el.textContent);
  assert('readonly: nothing to type into', el && !el.querySelector('input, select, button'));

  el = draw(FDP, TOTALS, false);
  assert('editable: lit once it has a quantity', !el.classList.contains('uc-empty'));
  assert('editable: the quantity is in the box', el.querySelector('.bid-grp-uc-qty').value === '100');
  assert('editable: the unit is picked', el.querySelector('.bid-grp-uc-unit').value === 'SY');
  assert('editable: the figure is $711.05/SY', el.querySelector('.bid-grp-uc-val').textContent === '$711.05/SY');
  // The user's call: the bar divides ACTUAL cost. On a section still being
  // built the three totals differ, so dividing projected ($700) or bid ($600)
  // instead would print a different number here.
  assert('a section still being built divides its actual cost — readonly',
    draw(FDP, LIVE, true).querySelector('.bid-grp-uc-val').textContent === '$350.00/SY');
  el = draw(FDP, LIVE, false);
  assert('…and editable', el.querySelector('.bid-grp-uc-val').textContent === '$350.00/SY',
    el.querySelector('.bid-grp-uc-val').textContent);
  el.querySelector('.bid-grp-uc-qty').value = '50';
  t._bidGroupMeasureEdit(el.querySelector('.bid-grp-uc-qty'));
  assert('…and when the quantity is retyped', el.querySelector('.bid-grp-uc-val').textContent === '$700.00/SY',
    el.querySelector('.bid-grp-uc-val').textContent);
  t.setProj(proj({ [FDP]: { qty: 100, unit: 'SY' } }));
  el = draw(FDP, TOTALS, false);
  const opts = [...el.querySelectorAll('.bid-grp-uc-unit option')].map(o => o.value);
  assert('the units are the bid table\'s own, less blank and lump sum',
    opts.includes('SY') && opts.includes('SF') && opts.includes('TON') && !opts.includes('') && !opts.includes('LS'),
    opts.join());

  t.setProj(proj({ [FDP]: { qty: 3, unit: 'MI' } }));
  el = draw(FDP, TOTALS, false);
  assert('a unit the list does not carry is still offered, not silently swapped',
    el.querySelector('.bid-grp-uc-unit').value === 'MI');

  console.log('  — the working behind it');
  const tip = t._bidGroupUnitCostTip(TOTALS, 100, 'SY');
  assert('the tooltip shows the division', tip.includes('Actual cost $71,104.85 ÷ 100 SY = $711.05/SY'), tip);
  assert('a finished section does not add a projection', !/Projected/.test(tip));
  const live = t._bidGroupUnitCostTip({ actual: 35000, bid: 60000, proj: 70000, allDone: false }, 100, 'SY');
  assert('a section still being built shows where it is heading',
    live.includes('Projected at completion $70,000.00 ÷ 100 SY = $700.00/SY'), live);
  assert('a bid section shows the bid figure too', live.includes('Bid $60,000.00 ÷ 100 SY = $600.00/SY'), live);
  assert('the tooltip says how to start when there is no quantity',
    /measured quantity/.test(t._bidGroupUnitCostTip(TOTALS, 0, U)));

  t.setProj(proj({ [FDP]: { qty: 100, unit: 'SY' } }));
  el = draw(FDP, { actual: 35000, bid: 60000, proj: 70000, allDone: false }, false);
  assert('the tooltip survives its attribute, line breaks and all',
    el.title === t._bidGroupUnitCostTip({ actual: 35000, bid: 60000, proj: 70000, allDone: false }, 100, 'SY'));

  // Cost codes are free text. The chip carries its code in a data attribute
  // and the edit handler reads it back; it must come back exactly.
  const ODD = `Owner's "Alt" <B> & Restoration`;
  t.setProj(proj({ [ODD]: { qty: 10, unit: 'SY' } }));
  el = draw(ODD, TOTALS, false);
  assert('a free-text cost code round-trips through the chip', el && el.dataset.ucCode === ODD, el && el.dataset.ucCode);
  assert('…and finds its own quantity', el.querySelector('.bid-grp-uc-qty').value === '10');
  assert('no handler has the cost code written into it',
    ![...el.querySelectorAll('*')].concat(el).some(n => [...n.attributes].some(a => a.name.startsWith('on') && a.value.includes('Owner'))));

  // ── 2. Typing into it ─────────────────────────────────────────────────────
  console.log('  — typing a quantity');
  let p = proj(undefined); delete p['bid-group-measures'];
  t.setProj(p);
  el = draw(FDP, TOTALS, false);
  const before = t.counts();
  t._bidGroupMeasureOpen(el.querySelector('.bid-grp-uc-add'));
  assert('"+ Cost" opens the box', !el.classList.contains('uc-empty'));
  assert('…and puts the cursor in it', doc.activeElement === el.querySelector('.bid-grp-uc-qty'));

  const qty = el.querySelector('.bid-grp-uc-qty'), unit = el.querySelector('.bid-grp-uc-unit');
  qty.value = '100'; unit.value = 'SY';
  t._bidGroupMeasureEdit(qty);
  assert('the quantity is stored on the project, keyed by cost code',
    JSON.stringify(p['bid-group-measures']) === JSON.stringify({ [FDP]: { qty: 100, unit: 'SY' } }),
    JSON.stringify(p['bid-group-measures']));
  assert('the figure redraws in place', el.querySelector('.bid-grp-uc-val').textContent === '$711.05/SY');
  assert('the project is saved', t.counts().saves === before.saves + 1);
  assert('the table is not rebuilt under the cursor', t.counts().renders === before.renders);
  assert('the box is still the one being typed in', doc.activeElement === qty && cell.contains(qty));

  unit.value = 'SF';
  t._bidGroupMeasureEdit(unit);
  assert('changing the unit stores it', p['bid-group-measures'][FDP].unit === 'SF');
  assert('…and the figure follows', el.querySelector('.bid-grp-uc-val').textContent === '$711.05/SF');
  assert('…and so does the tooltip', el.title.includes('= $711.05/SF'), el.title);

  qty.value = '';
  t._bidGroupMeasureEdit(qty);
  assert('clearing the box removes the quantity', !(FDP in p['bid-group-measures']));
  assert('…and the figure goes back to a dash', el.querySelector('.bid-grp-uc-val').textContent === '—/SF');

  t._bidGroupMeasureBlur(el, { relatedTarget: unit });
  assert('moving to the unit dropdown keeps it open', !el.classList.contains('uc-empty'));
  t._bidGroupMeasureBlur(el, { relatedTarget: null });
  assert('leaving it empty folds it back to "+ Cost"', el.classList.contains('uc-empty'));
  qty.value = '40'; el.classList.remove('uc-empty');
  t._bidGroupMeasureBlur(el, { relatedTarget: null });
  assert('leaving it with a quantity keeps it lit', !el.classList.contains('uc-empty'));

  // A project from another tab may carry something that is not an object.
  p = { id: 'p1', bidItems: [], 'bid-group-measures': 'garbage' };
  t.setProj(p);
  el = draw(FDP, TOTALS, false);
  el.querySelector('.bid-grp-uc-qty').value = '5';
  t._bidGroupMeasureEdit(el.querySelector('.bid-grp-uc-qty'));
  assert('a malformed store is replaced, not written into', p['bid-group-measures'][FDP].qty === 5);

  // The same journey again, driven only by events on the page's own markup:
  // nothing below calls a chip function directly, so a handler that is
  // missing, misnamed or passed the wrong argument fails here.
  console.log('  — the chip\'s own wiring');
  // blur does not bubble — the same as in a browser, so the handler has to be
  // on the element that loses focus, not on the chip around it.
  const fire = (node, type, init = {}) => {
    const Ctor = type === 'blur' ? w.FocusEvent : type === 'click' ? w.MouseEvent : w.Event;
    node.dispatchEvent(new Ctor(type, Object.assign({ bubbles: type !== 'blur', cancelable: true }, init)));
  };
  p = { id: 'p1', bidItems: [] };
  t.setProj(p);
  hdr.dataset.collapsed = '0';
  el = draw(FDP, LIVE, false);
  fire(el.querySelector('.bid-grp-uc-add'), 'click');
  assert('clicking "+ Cost" opens the box', !el.classList.contains('uc-empty'));
  assert('…without folding the section up', hdr.dataset.collapsed === '0');
  const wq = el.querySelector('.bid-grp-uc-qty'), wu = el.querySelector('.bid-grp-uc-unit');
  fire(wq, 'click');
  fire(wu, 'click');
  assert('clicking into the box or the dropdown leaves the section open', hdr.dataset.collapsed === '0');
  wq.value = '100'; fire(wq, 'input');
  assert('typing stores the quantity', p['bid-group-measures'] && p['bid-group-measures'][FDP]
    && p['bid-group-measures'][FDP].qty === 100, JSON.stringify(p['bid-group-measures']));
  assert('…and redraws the figure off actual cost', el.querySelector('.bid-grp-uc-val').textContent === `$350.00/${U}`,
    el.querySelector('.bid-grp-uc-val').textContent);
  wu.value = 'SF'; fire(wu, 'change');
  assert('picking a unit stores it', p['bid-group-measures'][FDP].unit === 'SF');
  assert('…and the figure follows', el.querySelector('.bid-grp-uc-val').textContent === '$350.00/SF');
  fire(wq, 'blur', { relatedTarget: wu });
  assert('tabbing from the box to the dropdown keeps it open', !el.classList.contains('uc-empty'));
  fire(wq, 'blur', { relatedTarget: null });
  assert('leaving with a quantity in keeps it lit', !el.classList.contains('uc-empty'));
  wq.value = ''; fire(wq, 'input');
  fire(wq, 'blur', { relatedTarget: null });
  assert('clearing the box and clicking away folds it back to "+ Cost"',
    el.classList.contains('uc-empty') && !(FDP in p['bid-group-measures']));
  el.classList.remove('uc-empty');
  fire(wu, 'blur', { relatedTarget: null });
  assert('…and so does clicking away from the dropdown', el.classList.contains('uc-empty'));
  fire(el, 'click');
  assert('no click anywhere on the chip reaches the header', hdr.dataset.collapsed === '0');

  // ── Renaming and deleting the cost code ───────────────────────────────────
  console.log('  — renaming and deleting the section');
  const items = () => [{ id: 'a', cost_code: FDP }, { id: 'b', cost_code: 'Inlet Repair' }];
  p = { id: 'p1', bidItems: items(), 'bid-group-measures': { [FDP]: { qty: 100, unit: 'SY' } } };
  t.setProj(p);
  t.updateBidGroupCode('p1', FDP, 'FDP - Area A');
  assert('a rename carries the quantity to the new name',
    JSON.stringify(p['bid-group-measures']) === JSON.stringify({ 'FDP - Area A': { qty: 100, unit: 'SY' } }),
    JSON.stringify(p['bid-group-measures']));

  p = { id: 'p1', bidItems: items(), 'bid-group-measures': { [FDP]: { qty: 100, unit: 'SY' }, 'Inlet Repair': { qty: 4, unit: 'EA' } } };
  t.setProj(p);
  t.updateBidGroupCode('p1', FDP, 'Inlet Repair');
  assert('renaming onto a section that has its own keeps that one',
    JSON.stringify(p['bid-group-measures']) === JSON.stringify({ 'Inlet Repair': { qty: 4, unit: 'EA' } }),
    JSON.stringify(p['bid-group-measures']));

  p = { id: 'p1', bidItems: items(), 'bid-group-measures': { [FDP]: { qty: 100, unit: 'SY' } } };
  t.setProj(p);
  t.updateBidGroupCode('p1', FDP, FDP);
  assert('a rename to the same name loses nothing', p['bid-group-measures'][FDP].qty === 100);

  p = { id: 'p1', bidItems: items() };
  t.setProj(p);
  t.updateBidGroupCode('p1', FDP, 'Renamed');
  assert('a project with no quantities renames as before',
    p.bidItems[0].cost_code === 'Renamed' && p['bid-group-measures'] === undefined);

  p = { id: 'p1', bidItems: items(), 'bid-group-measures': { [FDP]: { qty: 100, unit: 'SY' }, 'Inlet Repair': { qty: 4, unit: 'EA' } } };
  t.setProj(p);
  t.removeBidGroup('p1', FDP);
  assert('deleting a section takes its quantity with it',
    JSON.stringify(p['bid-group-measures']) === JSON.stringify({ 'Inlet Repair': { qty: 4, unit: 'EA' } }));

  // A section also goes when its last line is deleted with the row ✕. Its
  // quantity must go with it: left behind, it sat out of sight and replaced
  // the quantity on whatever section was next renamed onto that code.
  const both = () => ({ [FDP]: { qty: 100, unit: 'SY' }, 'Inlet Repair': { qty: 4, unit: 'EA' } });
  p = { id: 'p1', bidItems: [{ id: 'a', cost_code: FDP }, { id: 'a2', cost_code: FDP }, { id: 'b', cost_code: 'Inlet Repair' }],
        'bid-group-measures': both() };
  t.setProj(p);
  t.removeBidItem('p1', 'a2');
  assert('deleting one of a section\'s lines keeps its quantity', p['bid-group-measures'][FDP].qty === 100);
  t.removeBidItem('p1', 'b');
  assert('deleting a section\'s last line takes its quantity with it',
    JSON.stringify(p['bid-group-measures']) === JSON.stringify({ [FDP]: { qty: 100, unit: 'SY' } }),
    JSON.stringify(p['bid-group-measures']));

  // Leftovers can still come from a Procore or Copy Bid replace. Renaming onto
  // one is not a merge: the bar the user can see keeps its quantity.
  p = { id: 'p1', bidItems: [{ id: 'a', cost_code: FDP }], 'bid-group-measures': both() };
  t.setProj(p);
  t.updateBidGroupCode('p1', FDP, 'Inlet Repair');
  assert('renaming onto a code with only a leftover quantity keeps the one on screen',
    JSON.stringify(p['bid-group-measures']) === JSON.stringify({ 'Inlet Repair': { qty: 100, unit: 'SY' } }),
    JSON.stringify(p['bid-group-measures']));
  p = { id: 'p1', bidItems: [{ id: 'a', cost_code: FDP }], 'bid-group-measures': { 'Inlet Repair': { qty: 4, unit: 'EA' } } };
  t.setProj(p);
  t.updateBidGroupCode('p1', FDP, 'Inlet Repair');
  assert('…and a section with no quantity does not pick the leftover up',
    JSON.stringify(p['bid-group-measures']) === '{}', JSON.stringify(p['bid-group-measures']));

  // ── 3. Wiring ─────────────────────────────────────────────────────────────
  console.log('  — wiring');
  const render = extractFunction(src, 'renderBidTable');
  assert('both the read-only and editable headers carry the chip, after the folder',
    (render.match(/\$\{gPctHTML\}\$\{gDaysHTML\}\$\{gDocsHTML\}<span class="bid-grp-uc-slot"><\/span>/g) || []).length === 2);
  const fill = render.indexOf('_bidGroupUnitCostHTML(projId, costCode,');
  assert('the slot it fills is the one the header draws',
    /const ucSlot = hdrTr\.querySelector\('\.bid-grp-uc-slot'\);\s*if \(ucSlot\) ucSlot\.outerHTML = _bidGroupUnitCostHTML\(/.test(render));
  assert('it divides the same totals the section\'s Total row prints',
    /_bidGroupUnitCostHTML\(projId, costCode,\s*\{ actual: gActual, bid: gBidTotal, proj: gProj, allDone: !!\(gPct && gPct\.allDone\) \}, readonly\)/.test(render));
  assert('…filled in once those totals are added up',
    fill > render.indexOf('gBidTotal += bidTot; gActual += actual;') && fill < render.indexOf('// ── Group subtotal row ──'));
  assert('the dropdown is sized for the bar, not by the page-wide `td select`',
    /\.bid-group-hdr select\.bid-grp-uc-unit \{ width: auto;/.test(src));
  assert('the style it needs ships with the page',
    /\.bid-grp-uc \{/.test(src) && /\.bid-grp-uc\.uc-empty > :not\(\.bid-grp-uc-add\) \{ display: none; \}/.test(src));

  // ── The printed / emailed bid report ──────────────────────────────────────
  // Print, the Email button and the scheduled auto-report all build it here.
  console.log('  — the bid report (print, email, auto-report)');
  const pdf = extractFunction(src, 'exportBidPDF');
  assert('it reads the same stored quantity the bar does',
    /const gUC = _bidGroupMeasure\(p, costCode\);/.test(pdf));
  assert('it divides the section\'s Actual Cost with the bar\'s own helper',
    /_bidGroupUnitCostText\(gActual, gUC\.qty, gUC\.unit\)/.test(pdf));
  assert('it prints "qty unit @ $/unit" on the cost-code header row',
    /\(gUC\.qty > 0 \? `<span class="grp-uc"> · \$\{qfmt\(gUC\.qty\)\} \$\{_cbEsc\(gUC\.unit\)\} @ <strong>/.test(pdf));
  const hdrAt = pdf.indexOf('rowsHTML += `<tr class="group-hdr">');
  assert('the header row is written once the section is totalled',
    hdrAt > pdf.indexOf('gBid += bidTot; gActual += actual;') && hdrAt < pdf.indexOf('rowsHTML += `<tr class="subtotal">'));
  assert('…and still lands above its sub codes',
    /\+ `<\/td><\/tr>` \+ gRowsHTML;/.test(pdf) && (pdf.match(/gRowsHTML \+= `<tr>/g) || []).length === 1
    && !/[^g]rowsHTML \+= `<tr>\n\s*<td class="sub">/.test(pdf));
  assert('the explanation prints only on a report that carries a figure',
    /\$\{anyUnitCost \? `<p class="note">The "@ \$\/unit" on a cost code's header row is its Actual Cost/.test(pdf)
    && /if \(gUC\.qty > 0\) anyUnitCost = true;/.test(pdf));
  assert('the figure prints in the report\'s actual-cost colour',
    /tr\.group-hdr \.grp-uc \{ font-weight: 400; color: #92400e; \}/.test(pdf) && /td\.actual \{[^}]*color: #92400e/.test(pdf));
  w.close();
}

// The three pages carry the same bid table with no shared module, so nothing
// but matching edits keeps them in step.
console.log('\n[the three pages agree]');
const NAMES = ['_bidGroupMeasure', '_bidGroupUnitCostText', '_bidGroupUnitCostTip', '_bidGroupUnitCostHTML',
  '_bidGroupMeasureOpen', '_bidGroupMeasureBlur', '_bidGroupMeasureEdit', 'updateBidGroupCode', 'removeBidGroup',
  'removeBidItem'];
const srcs = PAGES.map(pg => fs.readFileSync(path.resolve(__dirname, '..', pg.file), 'utf8'));
for (const name of NAMES) {
  const bodies = srcs.map(s => extractFunction(s, name));
  assert(`${name} is the same on every page`, bodies.every(b => b === bodies[0]));
}

console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
