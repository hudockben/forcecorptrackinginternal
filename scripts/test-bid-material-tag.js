#!/usr/bin/env node
'use strict';
/**
 * The Material tag under each sub code on Bid Line Items vs Actuals.
 *
 * Run: node scripts/test-bid-material-tag.js
 *
 * A sub code's Actual Cost is labor, equipment and material together, and the
 * table never said which. Someone checking a line had to open it to find out
 * whether there were invoices behind the number at all. Now a yellow
 * "Material $622.68" tag sits under the name, beside ✓ Complete, on every
 * sub code with material booked to it, and nothing sits there on a line that
 * is labor and equipment only. Hovering it lists each entry: the date, the PO
 * and the invoice / ticket # its delivery line carries (or "no invoice #"),
 * the inventory entry that drew it, or "Job row — no PO" for material typed
 * straight onto a job row, then the supplier, what was bought and the amount.
 *
 * Three layers, matching the other bid-view tests:
 *   1. Behavioural — the real helpers out of each division page, run against
 *      the job from the request: what counts as material on a line (the same
 *      rows Actual Cost adds up, and only their material), where each entry
 *      came from, the order they are listed in, credits, the tooltip's cap and
 *      text that has to survive a trip through an HTML attribute.
 *   2. The table — the real renderBidTable in jsdom, both layouts, so the tag
 *      is shown to land in the sub code cell beside ✓ Complete and nowhere on
 *      a labor-only line, and the PO lookup is built once per table.
 *   3. Structural — the page wiring and CSS, and the helpers being the same
 *      on Turf, Paving and Kiewit.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const HELPERS = ['_bidMaterialSources', 'materialForBidItem', '_bidMaterialEntry', '_bidMatMoney',
  '_bidMaterialTip', '_bidMaterialTagHTML'];

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

/* The page's own helpers in a jsdom window: the material ones, the Actual
   Cost they are measured against, and renderBidTable itself. Everything
   renderBidTable draws that has nothing to do with this tag — the green
   header's chips, the date cells, the past-average benchmark — is stubbed flat,
   so the rows carry only what this test is about. */
function load(src) {
  const dom = new JSDOM('<!doctype html><table><tbody id="tb"></tbody><tbody id="ro"></tbody></table>',
    { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`
    let _projects = [];
    let purchaseOrders = [], inventoryEntries = [];
    let _srcCalls = 0;
    function setData(d) {
      _projects = d.projects || []; purchaseOrders = d.purchaseOrders || []; inventoryEntries = d.inventoryEntries || [];
    }
    function getProj(id) { return _projects.find(p => p.id === id); }
    function getAllDailyRows() { return _projects.reduce((all, p) => all.concat(p.dailyRows || []), []); }
    const pvPreview = { active: false, rate: 0 };
    let bidFilters = {}, bidViewProjId = null;
    ${extractLine(src, 'const HAUL_FIELD_TYPE_RE =')}
    ${extractLine(src, 'const _cbEsc =')}
    ${extractLine(src, 'const UNIT_OPTS =')}
    ${extractLine(src, 'const BID_MAT_TIP_MAX =')}
    ${extractFunction(src, 'fmt')}
    ${extractFunction(src, 'qfmt')}
    ${extractFunction(src, 'esc')}
    ${extractFunction(src, 'escJs')}
    ${extractFunction(src, 'calcDaily')}
    ${extractFunction(src, 'dailyRowCost')}
    ${extractFunction(src, '_dailySortDate')}
    ${extractFunction(src, 'actualForBidItem')}
    ${extractFunction(src, 'runningQtyForBidItem')}
    ${extractFunction(src, 'cumulativeHoursForBidItem')}
    ${extractFunction(src, 'laborerCountForBidItem')}
    ${HELPERS.map(n => extractFunction(src, n)).join('\n')}
    ${extractFunction(src, 'renderBidTable')}

    // Counts how often a table render builds the PO / inventory lookup.
    const _realSources = _bidMaterialSources;
    _bidMaterialSources = function () { _srcCalls++; return _realSources(); };
    function srcCalls() { const n = _srcCalls; _srcCalls = 0; return n; }

    // renderBidTable's other company, flattened.
    function _bidScrollParent() { return null; }
    function renderBidFooter() {}
    function _renderBidOffBidBadge() {}
    function _updateBidFilterButtons() {}
    function bidGroupPct() { return null; }
    function _bidGroupPctHTML() { return ''; }
    function daysWorkedForGroup() { return 0; }
    function _bidGroupDaysHTML() { return ''; }
    function _bidGroupDocsHTML() { return ''; }
    function _bidGroupUnitCostHTML() { return ''; }
    function bidItemComplete(b) { return !!b.is_complete; }
    function projIsDone() { return false; }
    function projForBidItem(b, actual) { return actual; }
    function computeSizeAwarePastAvg() { return null; }
    function _workDaysForItems() { return []; }
    function _autoBidDates() { return { start: '', target: '' }; }
    function _workDaySpanLabel() { return ''; }
    function _bidDateCellHTML() { return '<td></td>'; }
    function cbHtml(listKey, value) { return '<div class="cb-wrap"><input class="cb-input" value="' + _cbEsc(value) + '"></div>'; }

    window.__t = { setData, srcCalls, renderBidTable, actualForBidItem, calcDaily, BID_MAT_TIP_MAX,
      ${HELPERS.join(', ')} };
  `);
  return { w, doc: w.document, t: w.__t };
}

// ── Fixtures — the job from the request ─────────────────────────────────────
// Juniata College Baseball, #26053. Mobilization and Travel are crew time, the
// silt fence was bought on a PO with its stakes picked up at a store, the
// stone base came in on one PO over several tickets, and the infill came out
// of inventory.
const P = 'p26053';
const bid = (id, cc, sc, extra) => Object.assign({ id, cost_code: cc, sub_code: sc, unit: 'EA', quantity: 1, unit_cost: 1 }, extra || {});
const labor = (id, cc, sc, date, hrs) =>
  ({ id, cost_code: cc, sub_code: sc, date, employee: 'Crew ' + id, rate: 45.99, labor_hours: hrs, material_cost: 0 });
const mat = (id, cc, sc, date, amount, extra) =>
  Object.assign({ id, cost_code: cc, sub_code: sc, date, material_cost: amount }, extra || {});

function fixture() {
  const rows = [
    labor('r1', 'Mobilization', 'Travel', '2026-07-15', 43),
    labor('r2', 'Mobilization', 'Travel', '2026-07-16', 43),
    labor('r3', 'E&S', 'Silt Fence', '2026-07-16', 12),
    labor('r4', 'E&S', 'Silt Fence', '2026-07-17', 12),
    // Synced from PO-0412's delivery line. The row id came back from the
    // server as text; the PO line still holds the number it was minted as.
    mat('1721.5', 'E&S', 'Silt Fence', '2026-07-16', '580.50',
      { field_type: 'Material', material: 'Silt fence 36" x 100\'', supplier: 'Hanson & Sons Supply', po_num: 'PO-0412' }),
    // Typed straight onto a job row.
    mat('r6', 'E&S', 'Silt Fence', '7/17/2026', 42.18, { material: 'Wood stakes', supplier: 'Home Depot' }),
    // The same sub code name under another cost code is another line.
    mat('r7', 'E&S Phase 2', 'Silt Fence', '2026-07-20', 99),
    // Stone base: three tickets on one PO, the last not invoiced yet. The row
    // for the second carries no supplier or description of its own.
    labor('r8', 'Earthwork', 'Stone Base', '2026-08-03', 40),
    mat('r9',  'Earthwork', 'Stone Base', '2026-08-05', 6839.42, { material: '2A Modified Stone', supplier: 'New Enterprise', po_num: 'PO-0420' }),
    mat('r10', 'Earthwork', 'Stone Base', '2026-08-03', 6952.31, { po_num: 'PO-0420' }),
    mat('r11', 'Earthwork', 'Stone Base', '', 3931.11, { material: '2A Modified Stone', supplier: 'New Enterprise', po_num: 'PO-0420' }),
    // A truck that hauled stone: it names the material, but its cost is equipment.
    { id: 'r12', cost_code: 'Earthwork', sub_code: 'Stone Base', date: '2026-08-04', job_class: 'Trucking', equipment: 'Tri-axle',
      equip_unit_cost: 95, equip_hours: 9, material: '2A Modified Stone', quantity: 18, material_cost: 0 },
    { id: 'r13', cost_code: 'Earthwork', sub_code: 'Fine Grading', date: '2026-08-10', rate: 52, labor_hours: 10,
      equip_unit_cost: 120, equip_hours: 10, material_cost: '' },
    // Infill drawn out of inventory, with a PO # typed on the row as well.
    mat('r14', 'Synthetic Turf', 'Infill', '2026-09-02', 11400, { material: 'SBR Rubber Infill', supplier: 'Liberty Tire', po_num: '7731' }),
    // A job row carrying a supplier's own PO #, linked to nothing.
    mat('r15', 'Synthetic Turf', 'Turf Glue', '2026-09-03', 310.4, { material: 'Seam adhesive', supplier: 'Synthetic Supply', po_num: '7731' }),
  ];
  return {
    projects: [{
      id: P, 'project-name': 'Juniata College Baseball',
      bidItems: [
        bid('b1', 'Mobilization', 'Travel', { is_complete: true }),
        bid('b2', 'E&S', 'Silt Fence', { is_complete: true }),
        bid('b3', 'Earthwork', 'Stone Base'),
        bid('b4', 'Earthwork', 'Fine Grading'),
        bid('b5', 'Synthetic Turf', 'Infill'),
        bid('b6', 'Synthetic Turf', 'Turf Glue'),
      ],
      dailyRows: rows,
    }],
    purchaseOrders: [
      { id: 'po2', po_number: 'PO-0412', title: 'Silt fence', supplier: 'Hanson & Sons Supply', project_id: P,
        lines: [{ id: 'l1', invoice_num: ' 88412 ', po_row_id: 1721.5 }] },
      { id: 'po3', po_number: 'PO-0420', title: '2A Modified Stone (PO title)', supplier: 'New Enterprise Stone & Lime', project_id: P,
        lines: [{ id: 'l2', invoice_num: 'T-55287', po_row_id: 'r9' }, { id: 'l3', invoice_num: 'T-55190', po_row_id: 'r10' },
                { id: 'l4', invoice_num: '', po_row_id: 'r11' }, { id: 'l5', invoice_num: 'unsynced', po_row_id: null },
                { id: 'l6', invoice_num: 'blank-link', po_row_id: '' }, null] },
      // A flat order from before delivery lines existed, and an empty slot.
      { id: 'po-old', po_number: 'PO-0001' },
      null,
    ],
    inventoryEntries: [{ id: 'i1', inv_number: 'INV-0003', project_id: P, inv_row_id: 'r14' }, { id: 'i2', inv_row_id: null }],
  };
}

const item = (sc, cc) => ({ id: 'x', cost_code: cc, sub_code: sc });
const SILT = { id: 'b2', cost_code: 'E&S', sub_code: 'Silt Fence' };
const STONE = { id: 'b3', cost_code: 'Earthwork', sub_code: 'Stone Base' };

const sources = {};
for (const page of PAGES) {
  console.log(`\n[${page}]`);
  const src = fs.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
  sources[page] = src;
  const { w, doc, t } = load(src);
  t.setData(fixture());
  const M = (b, s) => t.materialForBidItem(b, P, s);
  const tipOf = m => t._bidMaterialTip(m).split('\n');

  // ── 1. What counts ────────────────────────────────────────────────────────
  console.log('  — what counts as material on a line');
  let m = M(SILT);
  assert('Silt Fence: the fabric off the PO and the stakes off the job row, $622.68',
    m.total === 622.68 && m.entries.length === 2, JSON.stringify(m));
  const actual = t.actualForBidItem(SILT, P);
  assert('…which is its Actual Cost less the crew\'s 24 h at $45.99',
    Math.abs(actual - (24 * 45.99 + 622.68)) < 0.005, actual);
  assert('the same sub code under another cost code is not this line', !m.entries.some(e => e.amount === 99));
  m = M(item('Travel', 'Mobilization'));
  assert('Travel is crew time only: nothing to tag', m.total === 0 && m.entries.length === 0);
  assert('…and no tag is drawn for it', t._bidMaterialTagHTML(m) === '');
  m = M(STONE);
  assert('Stone Base: three tickets, and the truck that hauled the stone is not one of them',
    m.entries.length === 3 && m.total === 17722.84, JSON.stringify(m.entries.map(e => e.amount)));
  assert('…its haul is still in the Actual Cost, as equipment',
    Math.abs(t.actualForBidItem(STONE, P) - (40 * 45.99 + 95 * 9 + 17722.84)) < 0.005);
  m = M(item('Fine Grading', 'Earthwork'));
  assert('a blank material cost is no material', m.entries.length === 0);
  m = M(item('', 'E&S'));
  assert('a line with only a cost code takes every sub code under it, as Actual Cost does',
    m.total === 622.68 && m.entries.length === 2, m.total);
  m = M(item('', ''));
  assert('a line with neither code has none', m.total === 0 && m.entries.length === 0);
  assert('a material cost saved as text still counts',
    M(SILT).entries.some(e => e.amount === 580.5));

  // ── 2. Where it came from ─────────────────────────────────────────────────
  console.log('  — where each entry came from');
  let tip = tipOf(M(SILT));
  assert('the first line says how much and from how many entries',
    tip[0] === 'Material on this sub code: $622.68 from 2 entries (part of its Actual Cost)', tip[0]);
  assert('a PO delivery: its PO, its invoice #, the supplier, what, and the amount',
    tip[1] === '07/16/2026 · PO-0412 · Inv 88412 · Hanson & Sons Supply · Silt fence 36" x 100\' · $580.50', tip[1]);
  assert('…found by row id though the PO holds a number and the row a string', /PO-0412/.test(tip[1]));
  assert('material typed on a job row with no PO says so',
    tip[2] === '07/17/2026 · Job row — no PO · Home Depot · Wood stakes · $42.18', tip[2]);
  tip = tipOf(M(STONE));
  assert('a delivery still waiting on its invoice says "no invoice #"',
    tip.some(l => /^no date · PO-0420 · no invoice # · New Enterprise · 2A Modified Stone · \$3,931\.11$/.test(l)), tip.join(' | '));
  assert('a row with no supplier or description of its own takes the PO\'s',
    tip.includes('08/03/2026 · PO-0420 · Inv T-55190 · New Enterprise Stone & Lime · 2A Modified Stone (PO title) · $6,952.31'),
    tip.join(' | '));
  tip = tipOf(M(item('Infill', 'Synthetic Turf')));
  assert('material drawn from inventory names the entry, and claims no invoice',
    tip[1] === '09/02/2026 · Inventory INV-0003 · Liberty Tire · SBR Rubber Infill · $11,400.00', tip[1]);
  tip = tipOf(M(item('Turf Glue', 'Synthetic Turf')));
  assert('a job row with a PO # typed on it, linked to nothing, shows the reference',
    tip[1] === '09/03/2026 · Job row (ref 7731) · Synthetic Supply · Seam adhesive · $310.40', tip[1]);

  const d2 = fixture();
  d2.purchaseOrders[0].po_number = '4471';
  d2.purchaseOrders[1].po_number = '';
  t.setData(d2);
  assert('a PO number typed bare gets its "PO"', /· PO 4471 · Inv 88412 ·/.test(t._bidMaterialTip(M(SILT))));
  assert('a PO with no number at all still reads as a PO', /· PO \(no number\) · Inv T-55190 ·/.test(t._bidMaterialTip(M(STONE))));
  t.setData(fixture());

  // The lookup the table builds once.
  const s = t._bidMaterialSources();
  assert('the lookup keys PO lines by row id as text', s.po.has('1721.5') && s.po.has('r9') && s.po.size === 4,
    [...s.po.keys()].join(','));
  assert('…and skips lines with no row, an old flat order and empty slots', !s.po.has('null') && !s.po.has(''));
  assert('…and keys inventory the same way', s.inv.size === 1 && s.inv.get('r14').inv_number === 'INV-0003');
  assert('given the lookup, the answer is the same as building it',
    JSON.stringify(M(STONE, s)) === JSON.stringify(M(STONE)));
  t.setData({ projects: fixture().projects });
  m = M(SILT);
  assert('with no POs loaded the amounts still stand, the source read off the row',
    m.total === 622.68 && /Job row \(ref PO-0412\)/.test(t._bidMaterialTip(m)), t._bidMaterialTip(m));
  t.setData(fixture());

  // ── 3. Order, credits, the cap ────────────────────────────────────────────
  console.log('  — order, credits and the cap');
  m = M(STONE);
  assert('oldest first, whichever way the date was written; undated last',
    m.entries.map(e => e.date).join(',') === '08/03/2026,08/05/2026,', m.entries.map(e => e.date).join(','));
  m = M(SILT);
  assert('an imported M/D/YYYY date reads like the rest', m.entries[1].date === '07/17/2026', m.entries[1].date);

  const credit = { projects: [{ id: P, bidItems: [], dailyRows: [
    mat('c1', 'E&S', 'Silt Fence', '2026-07-16', 580.5), mat('c2', 'E&S', 'Silt Fence', '2026-07-18', -580.5),
    mat('c3', 'E&S', 'Inlet Protection', '2026-07-16', 0.1), mat('c4', 'E&S', 'Inlet Protection', '2026-07-16', 0.2),
    mat('c5', 'E&S', 'Returns', '2026-07-19', -50),
  ] }] };
  t.setData(credit);
  m = M(SILT);
  assert('a return that cancels its delivery nets to $0.00, not -$0.00',
    m.total === 0 && Object.is(m.total, 0) && /Material \$0\.00</.test(t._bidMaterialTagHTML(m)), t._bidMaterialTagHTML(m));
  assert('…and is still tagged, because there is paperwork behind it', m.entries.length === 2);
  assert('a credit is listed as one', /· -\$580\.50$/.test(tipOf(m)[2]), tipOf(m)[2]);
  assert('the total is to the cent', M(item('Inlet Protection', 'E&S')).total === 0.3);
  assert('a line that nets to a credit reads -$50.00',
    /Material -\$50\.00</.test(t._bidMaterialTagHTML(M(item('Returns', 'E&S')))));

  const many = n => ({ projects: [{ id: P, bidItems: [], dailyRows: Array.from({ length: n }, (_, i) =>
    mat('m' + i, 'Earthwork', 'Stone Base', `2026-08-${String(i + 1).padStart(2, '0')}`, 100 + i, { supplier: 'Quarry' })) }] });
  t.setData(many(15));
  tip = tipOf(M(STONE));
  assert(`a long list stops at ${t.BID_MAT_TIP_MAX} entries and counts the rest`,
    tip.length === t.BID_MAT_TIP_MAX + 2 && tip[tip.length - 1] === '…and 3 more. Daily Tracking and Purchase Orders list them all.',
    tip.length + ' lines, last: ' + tip[tip.length - 1]);
  assert('…and the first line still counts every one', /from 15 entries/.test(tip[0]) && /\$1,605\.00/.test(tip[0]), tip[0]);
  t.setData(many(t.BID_MAT_TIP_MAX));
  tip = tipOf(M(STONE));
  assert(`exactly ${t.BID_MAT_TIP_MAX} are all listed, with no "more"`,
    tip.length === t.BID_MAT_TIP_MAX + 1 && !/more/.test(tip[tip.length - 1]));
  t.setData(many(1));
  assert('one entry is "1 entry"', /from 1 entry \(/.test(tipOf(M(STONE))[0]));

  // ── 4. Through an attribute ───────────────────────────────────────────────
  console.log('  — free text in the tooltip');
  const nasty = fixture();
  nasty.projects[0].dailyRows.push(mat('n1', 'Earthwork', 'Stone Base', '2026-08-07', 12.5,
    { supplier: 'Smith & Sons <Supply> "Yard"', material: 'Rip-rap &amp; fabric' }));
  nasty.purchaseOrders[1].lines.push({ id: 'l9', invoice_num: 'A&B<1>"2"', po_row_id: 'n1' });
  t.setData(nasty);
  m = M(STONE);
  const host = doc.createElement('div');
  host.innerHTML = t._bidMaterialTagHTML(m);
  const tag = host.querySelector('span.bid-mat-tag');
  assert('the tag parses to one span and nothing else', !!tag && host.children.length === 1 && tag.children.length === 0,
    host.innerHTML);
  assert('it reads "Material" and the amount', tag && tag.textContent === 'Material $17,735.34', tag && tag.textContent);
  assert('the tooltip comes back exactly as written — ampersands, brackets, quotes and line breaks',
    tag && tag.title === t._bidMaterialTip(m), tag && JSON.stringify(tag.title));
  assert('…including text that already looks like an entity',
    tag && tag.title.includes('Smith & Sons <Supply> "Yard" · Rip-rap &amp; fabric') && tag.title.includes('Inv A&B<1>"2"'));

  // ── 5. The table ──────────────────────────────────────────────────────────
  console.log('  — the table');
  t.setData(fixture());
  t.srcCalls();
  t.renderBidTable(P, { tbodyId: 'tb' });
  assert('one table render builds the PO lookup once, not once per sub code', t.srcCalls() === 1);
  const cellFor = (tbodyId, name, col) => {
    const tr = [...doc.querySelectorAll(`#${tbodyId} tr.bid-group-child:not(.bid-group-total)`)].find(r => {
      const td = r.children[col];
      const input = td && td.querySelector('input');
      return (input ? input.value : td && td.firstChild && td.firstChild.textContent.trim()) === name;
    });
    return tr ? tr.children[col] : null;
  };
  for (const [tb, col, label] of [['tb', 1, 'editable'], ['ro', 0, 'readonly']]) {
    if (tb === 'ro') { t.renderBidTable(P, { tbodyId: 'ro', readonly: true }); t.srcCalls(); }
    const silt = cellFor(tb, 'Silt Fence', col);
    const tags = silt && silt.querySelector('.bid-sub-tags');
    assert(`${label}: Silt Fence carries ✓ Complete, then its material`,
      !!tags && tags.children.length === 2 && /✓ Complete/.test(tags.children[0].textContent)
      && tags.children[1].className === 'bid-mat-tag' && tags.children[1].textContent === 'Material $622.68',
      silt && silt.innerHTML);
    const travel = cellFor(tb, 'Travel', col);
    assert(`${label}: Travel keeps ✓ Complete and gets no material tag`,
      !!travel && !!travel.querySelector('.bid-sub-tags') && !travel.querySelector('.bid-mat-tag'), travel && travel.innerHTML);
    const stone = cellFor(tb, 'Stone Base', col);
    assert(`${label}: Stone Base, not complete, carries the material tag alone`,
      !!stone && stone.querySelectorAll('.bid-sub-tags > span').length === 1 && !!stone.querySelector('.bid-mat-tag'),
      stone && stone.innerHTML);
    const grade = cellFor(tb, 'Fine Grading', col);
    assert(`${label}: Fine Grading, neither, has nothing under its name`,
      !!grade && !grade.querySelector('.bid-sub-tags'), grade && grade.innerHTML);
    const infill = cellFor(tb, 'Infill', col);
    assert(`${label}: the tag's tooltip is the hover list`,
      !!infill && /Inventory INV-0003/.test(infill.querySelector('.bid-mat-tag').title));
  }
  const roCells = doc.querySelector('#ro tr.bid-group-child').children.length;
  const edCells = doc.querySelector('#tb tr.bid-group-child').children.length;
  assert('neither layout gains a column', roCells === 14 && edCells === 18,
    `${roCells} / ${edCells}`);

  // ── 6. Wiring ─────────────────────────────────────────────────────────────
  console.log('  — wiring');
  const render = extractFunction(src, 'renderBidTable');
  assert('the lookup is built before the groups are walked',
    /const matSrc = _bidMaterialSources\(\);\n\n  visGroups\.forEach\(costCode => \{/.test(render));
  assert('each sub code reads its material off that lookup',
    /_bidMaterialTagHTML\(materialForBidItem\(b, projId, matSrc\)\)/.test(render));
  assert('both layouts put the tags in the sub code cell', (render.match(/\$\{_subTags\}<\/td>/g) || []).length === 2);
  assert('the ✓ Complete badge itself is unchanged',
    render.includes('<span style="display:inline-block;font-size:0.56rem;font-weight:700;color:#4ade80;background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.4);border-radius:3px;padding:0.06rem 0.34rem;white-space:nowrap;letter-spacing:0.02em" title="Marked complete in the schedule">✓ Complete</span>'));
  assert('…and sits where it did, 0.18rem under the name', /\.bid-sub-tags \{ margin-top: 0\.18rem; \}/.test(src));
  assert('the tag is yellow, the colour of material and of Actual Cost',
    /\.bid-mat-tag \{[^}]*color: var\(--yellow\);/.test(src));
  assert('the old single-badge variable is gone', !/_doneBadge/.test(src));
}

// ── 7. One implementation ───────────────────────────────────────────────────
console.log('\n[the three pages]');
for (const name of [...HELPERS, 'renderBidTable']) {
  if (name === 'renderBidTable') continue;   // differs per division for reasons of its own
  const [a, ...rest] = PAGES.map(p => extractFunction(sources[p], name));
  assert(`${name} is the same on Turf, Paving and Kiewit`, rest.every(x => x === a));
}
const tipMax = PAGES.map(p => extractLine(sources[p], 'const BID_MAT_TIP_MAX ='));
assert('…and so is the tooltip\'s cap', tipMax.every(x => x === tipMax[0]));

console.log(`\n${failed ? '❌' : '✅'}  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
