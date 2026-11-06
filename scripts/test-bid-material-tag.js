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
 * Clicking or tapping it opens the same list as a panel, for an iPad, which
 * never shows a hover tooltip.
 *
 * Layers, matching the other bid-view tests:
 *   1. Behavioural — the real helpers out of each division page, run against
 *      the job from the request: what counts as material on a line (the same
 *      rows Actual Cost adds up, and only the material inside that cost, which
 *      on a row priced by an imported Total Cost can be less than the row's own
 *      material figure), where each entry came from, the order they are listed
 *      in, credits, the tooltip's cap and text that has to survive a trip
 *      through an HTML attribute.
 *   2. The table — the real renderBidTable in jsdom, both layouts, so the tag
 *      is shown to land in the sub code cell beside ✓ Complete and nowhere on
 *      a labor-only line, and the PO lookup is built once per table.
 *   3. The panel a tap opens — every entry, read fresh, escaped; and every way
 *      it closes, leaving no listener behind; and where it is placed.
 *   4. Staying current — a polled change to the open job's orders or inventory
 *      redraws the bid, but never under someone typing or reading the panel.
 *   5. Structural — the page wiring and CSS, and the helpers being the same
 *      on Turf, Paving and Kiewit.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const HELPERS = ['_bidMaterialSources', '_rowMaterialInCost', 'materialForBidItem', '_bidMaterialEntry', '_bidMatMoney',
  '_bidMatAmountText', '_bidMaterialTip', '_bidMaterialTagHTML', '_bidMatPopToggle', '_bidMatPopOpen', '_bidMatPopClose',
  '_bidMatPopHTML', '_bidMatPopPlace', '_bidMatListChanged', '_bidMatRefreshDue'];
const STATE = ['const BID_MAT_TIP_MAX =', 'let _bidMatPop = null;', 'let _bidMatRefreshFor = null'];

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

const P = 'p26053';

/* The page's own helpers in a jsdom window: the material ones, the Actual
   Cost they are measured against, and renderBidTable itself. Everything
   renderBidTable draws that has nothing to do with this tag — the green
   header's chips, the date cells, the past-average benchmark — is stubbed flat,
   so the rows carry only what this test is about.

   Timers are run by hand (the refresh retries every two seconds), and the
   document's listeners are counted, so the panel can be shown to leave none
   behind. Inline onclick attributes do not run here; the tag's is asserted as
   text and its target called directly, and a real browser clicks it in the
   end-to-end check. */
function load(src) {
  const dom = new JSDOM(`<!doctype html><body><table><tbody id="tb"></tbody><tbody id="ro"></tbody>
    <tbody id="btbody-${P}"></tbody></table><input id="elsewhere"><div id="scroller"></div></body>`,
    { runScripts: 'outside-only' });
  const w = dom.window;
  const timers = [];
  w.setTimeout = fn => { timers.push({ fn, live: true }); return timers.length; };
  w.clearTimeout = id => { if (id && timers[id - 1]) timers[id - 1].live = false; };
  const tick = () => {
    const due = timers.filter(x => x.live);
    due.forEach(x => { x.live = false; });
    due.forEach(x => x.fn());
    return due.length;
  };
  const listening = {};
  const add = w.document.addEventListener.bind(w.document);
  const rem = w.document.removeEventListener.bind(w.document);
  w.document.addEventListener    = (type, fn, o) => { listening[type] = (listening[type] || 0) + 1; return add(type, fn, o); };
  w.document.removeEventListener = (type, fn, o) => { listening[type] = (listening[type] || 0) - 1; return rem(type, fn, o); };

  w.eval(`
    let _projects = [];
    let purchaseOrders = [], inventoryEntries = [];
    let _srcCalls = 0, _renders = 0;
    function setData(d) {
      _projects = d.projects || []; purchaseOrders = d.purchaseOrders || []; inventoryEntries = d.inventoryEntries || [];
    }
    function setPOs(list) { purchaseOrders = list; }
    function getPOs() { return purchaseOrders; }
    function getProj(id) { return _projects.find(p => p.id === id); }
    function getAllDailyRows() { return _projects.reduce((all, p) => all.concat(p.dailyRows || []), []); }
    let pvPreview = { active: false, rate: 0 };
    function setPV(active, rate) { pvPreview = { active, rate }; }
    let bidFilters = {}, bidViewProjId = null;
    function setView(id) { bidViewProjId = id; }
    ${extractLine(src, 'const HAUL_FIELD_TYPE_RE =')}
    ${extractLine(src, 'const _cbEsc =')}
    ${extractLine(src, 'const UNIT_OPTS =')}
    ${STATE.map(s => extractLine(src, s)).join('\n')}
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

    // Counts how often a table render builds the PO / inventory lookup, and
    // how often the table is redrawn.
    const _realSources = _bidMaterialSources;
    _bidMaterialSources = function () { _srcCalls++; return _realSources(); };
    function srcCalls() { const n = _srcCalls; _srcCalls = 0; return n; }
    const _realRender = renderBidTable;
    renderBidTable = function (...a) { _renders++; return _realRender(...a); };
    function renders() { const n = _renders; _renders = 0; return n; }
    function popOpen() { return !!_bidMatPop; }

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
    function _bidPlanRateCellHTML() { return '<td></td>'; }
    function cbHtml(listKey, value) { return '<div class="cb-wrap"><input class="cb-input" value="' + _cbEsc(value) + '"></div>'; }

    window.__t = { setData, setPOs, getPOs, setPV, setView, srcCalls, renders, popOpen,
      renderBidTable, actualForBidItem, calcDaily, BID_MAT_TIP_MAX, ${HELPERS.join(', ')} };
  `);
  return { w, doc: w.document, t: w.__t, tick, timers, listening };
}

// ── Fixtures — the job from the request ─────────────────────────────────────
// Juniata College Baseball, #26053. Mobilization and Travel are crew time, the
// silt fence was bought on a PO with its stakes picked up at a store, the
// stone base came in on one PO over several tickets, and the infill came out
// of inventory.
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
      // A flat order from before delivery lines existed, an order on another
      // job, and an empty slot.
      { id: 'po-old', po_number: 'PO-0001' },
      { id: 'po-other', po_number: 'PO-0500', project_id: 'another-job', lines: [{ id: 'lx', invoice_num: 'X1', po_row_id: 'zz' }] },
      null,
    ],
    inventoryEntries: [{ id: 'i1', inv_number: 'INV-0003', project_id: P, inv_row_id: 'r14' }, { id: 'i2', inv_row_id: null }],
  };
}

/* Rows a CSV import brought in carrying the spreadsheet's own Total Cost.
   Actual Cost takes that total for the row (dailyRowCost), so only as much
   material as the total has room for, after the row's labor and equipment,
   is inside the Actual Cost. */
function importFixture() {
  const imp = (id, sc, o) => Object.assign({ id, cost_code: 'Imported', sub_code: sc, date: '2026-06-01' }, o);
  const rows = [
    imp('i1', 'Fence Posts', { labor_hours: 10, rate: 45, material_cost: 800, total_cost: 1250, supplier: 'Merchants Metals' }),
    imp('i2', 'Seeding',     { labor_hours: 10, rate: 50, material_cost: 800, total_cost: 500 }),     // the total is the labor alone
    imp('i3', 'Topsoil',     { labor_hours: 10, rate: 50, material_cost: 800, total_cost: 900, supplier: 'Bulk Soils' }),
    imp('i7', 'Topsoil',     { date: '2026-06-02', material_cost: 200, supplier: 'Bulk Soils' }),   // priced by its parts
    imp('i4', 'Lump',        { material_cost: 800, total_cost: 600 }),                                // a total and nothing else
    imp('i5', 'Returns',     { labor_hours: 10, rate: 50, material_cost: -200, total_cost: 300 }),    // a credit inside the total
    imp('i6', 'Stakes',      { labor_hours: 7.3, rate: 45.99, material_cost: 0.3 }),                  // labor and material on one row
  ];
  const subs = ['Fence Posts', 'Seeding', 'Topsoil', 'Lump', 'Returns', 'Stakes'];
  return { projects: [{ id: P, bidItems: subs.map((s, i) => bid('x' + i, 'Imported', s)), dailyRows: rows }] };
}

const item = (sc, cc) => ({ id: 'x', cost_code: cc, sub_code: sc });
const SILT  = { id: 'b2', cost_code: 'E&S', sub_code: 'Silt Fence' };
const STONE = { id: 'b3', cost_code: 'Earthwork', sub_code: 'Stone Base' };
const near  = (a, b) => Math.abs(a - b) < 0.005;

const sources = {};
for (const page of PAGES) {
  console.log(`\n[${page}]`);
  const src = fs.readFileSync(path.resolve(__dirname, '..', page), 'utf8');
  sources[page] = src;
  const { w, doc, t, tick, timers, listening } = load(src);
  t.setData(fixture());
  const M = (b, s) => t.materialForBidItem(b, P, s);
  const tipOf = m => t._bidMaterialTip(m).split('\n');

  // ── 1. What counts ────────────────────────────────────────────────────────
  console.log('  — what counts as material on a line');
  let m = M(SILT);
  assert('Silt Fence: the fabric off the PO and the stakes off the job row, $622.68',
    m.total === 622.68 && m.entries.length === 2, JSON.stringify(m));
  const actual = t.actualForBidItem(SILT, P);
  assert('…which is its Actual Cost less the crew\'s 24 h at $45.99', near(actual, 24 * 45.99 + 622.68), actual);
  assert('the same sub code under another cost code is not this line', !m.entries.some(e => e.amount === 99));
  m = M(item('Travel', 'Mobilization'));
  assert('Travel is crew time only: nothing to tag', m.total === 0 && m.entries.length === 0);
  assert('…and no tag is drawn for it', t._bidMaterialTagHTML(m, P, 'b1') === '');
  m = M(STONE);
  assert('Stone Base: three tickets, and the truck that hauled the stone is not one of them',
    m.entries.length === 3 && m.total === 17722.84, JSON.stringify(m.entries.map(e => e.amount)));
  assert('…its haul is still in the Actual Cost, as equipment',
    near(t.actualForBidItem(STONE, P), 40 * 45.99 + 95 * 9 + 17722.84));
  m = M(item('Fine Grading', 'Earthwork'));
  assert('a blank material cost is no material', m.entries.length === 0);
  m = M(item('', 'E&S'));
  assert('a line with only a cost code takes every sub code under it, as Actual Cost does',
    m.total === 622.68 && m.entries.length === 2, m.total);
  m = M(item('', ''));
  assert('a line with neither code has none', m.total === 0 && m.entries.length === 0);
  assert('a material cost saved as text still counts', M(SILT).entries.some(e => e.amount === 580.5));

  // ── 1b. Imported totals ───────────────────────────────────────────────────
  console.log('  — rows priced by an imported Total Cost');
  t.setData(importFixture());
  const imp = sc => ({ cost_code: 'Imported', sub_code: sc });
  m = M(imp('Fence Posts'));
  assert('an imported total that includes the material carries it whole',
    m.total === 800 && m.entries[0].onRow === null, JSON.stringify(m.entries));
  m = M(imp('Seeding'));
  assert('an imported total that is the labor alone leaves its material out of the tag',
    m.entries.length === 0 && t._bidMaterialTagHTML(m, P, 'x1') === '', JSON.stringify(m));
  assert('…as it is out of the Actual Cost, which reads the $500 total', near(t.actualForBidItem(imp('Seeding'), P), 500));
  m = M(imp('Topsoil'));
  assert('a total with room for part of it carries that part: $400 of the $800, beside a row priced by its parts',
    m.total === 600 && m.entries.length === 2 && m.entries[0].amount === 400 && m.entries[0].onRow === 800,
    JSON.stringify(m.entries));
  assert('…and the list says why the figure differs from Daily Tracking',
    tipOf(m)[1] === '06/01/2026 · Job row — no PO · Bulk Soils · $400.00 of $800.00 (capped by its imported Total Cost)', tipOf(m)[1]);
  assert('…while the row priced by its parts reads plainly', tipOf(m)[2] === '06/02/2026 · Job row — no PO · Bulk Soils · $200.00', tipOf(m)[2]);
  m = M(imp('Lump'));
  assert('a bare imported total caps the material at itself',
    m.total === 600 && near(t.actualForBidItem(imp('Lump'), P), 600), m.total);
  m = M(imp('Returns'));
  assert('a credit inside an imported total counts whole', m.total === -200, m.total);
  m = M(imp('Stakes'));
  assert('a row priced by its parts keeps its material to the cent, with no floating-point dust',
    m.entries[0].amount === 0.3 && m.entries[0].onRow === null, m.entries[0] && m.entries[0].amount);
  const lines = ['Fence Posts', 'Topsoil', 'Lump', 'Stakes'];
  assert('no tag ever claims more than its line\'s Actual Cost',
    lines.every(s => M(imp(s)).total <= t.actualForBidItem(imp(s), P) + 0.005));
  t.setPV(true, 60);
  m = M(imp('Seeding'));
  assert('under the prevailing-wage preview every row is priced by its parts, material whole',
    m.total === 800 && near(t.actualForBidItem(imp('Seeding'), P), 600 + 800), m.total);
  t.setPV(false, 0);
  t.setData(fixture());

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
  assert('the lookup keys PO lines by row id as text', s.po.has('1721.5') && s.po.has('r9') && s.po.size === 5,
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
    m.total === 0 && Object.is(m.total, 0) && />Material \$0\.00</.test(t._bidMaterialTagHTML(m, P, 'b2')), t._bidMaterialTagHTML(m, P, 'b2'));
  assert('…and is still tagged, because there is paperwork behind it', m.entries.length === 2);
  assert('a credit is listed as one', /· -\$580\.50$/.test(tipOf(m)[2]), tipOf(m)[2]);
  assert('the total is to the cent', M(item('Inlet Protection', 'E&S')).total === 0.3);
  assert('a line that nets to a credit reads -$50.00',
    />Material -\$50\.00</.test(t._bidMaterialTagHTML(M(item('Returns', 'E&S')), P, 'b9')));

  const many = n => ({ projects: [{ id: P, bidItems: [bid('b3', 'Earthwork', 'Stone Base')], dailyRows: Array.from({ length: n }, (_, i) =>
    mat('m' + i, 'Earthwork', 'Stone Base', `2026-08-${String(i + 1).padStart(2, '0')}`, 100 + i, { supplier: 'Quarry' })) }] });
  t.setData(many(15));
  tip = tipOf(M(STONE));
  assert(`a long tooltip stops at ${t.BID_MAT_TIP_MAX} entries and points at the panel for the rest`,
    tip.length === t.BID_MAT_TIP_MAX + 2 && tip[tip.length - 1] === '…and 3 more. Click the tag to see them all.',
    tip.length + ' lines, last: ' + tip[tip.length - 1]);
  assert('…and the first line still counts every one', /from 15 entries/.test(tip[0]) && /\$1,605\.00/.test(tip[0]), tip[0]);
  t.setData(many(t.BID_MAT_TIP_MAX));
  tip = tipOf(M(STONE));
  assert(`exactly ${t.BID_MAT_TIP_MAX} are all listed, with no "more"`,
    tip.length === t.BID_MAT_TIP_MAX + 1 && !/more/.test(tip[tip.length - 1]));
  t.setData(many(1));
  assert('one entry is "1 entry"', /from 1 entry \(/.test(tipOf(M(STONE))[0]));

  // ── 4. Through an attribute ───────────────────────────────────────────────
  console.log('  — free text in the tag');
  const nasty = fixture();
  nasty.projects[0].dailyRows.push(mat('n1', 'Earthwork', 'Stone Base', '2026-08-07', 12.5,
    { supplier: 'Smith & Sons <Supply> "Yard"', material: 'Rip-rap &amp; fabric <b>x</b>' }));
  nasty.purchaseOrders[1].lines.push({ id: 'l9', invoice_num: 'A&B<1>"2"', po_row_id: 'n1' });
  t.setData(nasty);
  m = M(STONE);
  const host = doc.createElement('div');
  host.innerHTML = t._bidMaterialTagHTML(m, 'job "1" & <2>', 'line <3>');
  const tag = host.querySelector('button.bid-mat-tag');
  assert('the tag parses to one button and nothing else', !!tag && host.children.length === 1 && tag.children.length === 0,
    host.innerHTML);
  assert('a plain button, not a form submit', tag && tag.type === 'button' && tag.getAttribute('aria-expanded') === 'false');
  assert('it reads "Material" and the amount', tag && tag.textContent === 'Material $17,735.34', tag && tag.textContent);
  assert('the tooltip comes back exactly as written — ampersands, brackets, quotes and line breaks',
    tag && tag.title === t._bidMaterialTip(m), tag && JSON.stringify(tag.title));
  assert('…including text that already looks like an entity',
    tag && tag.title.includes('Smith & Sons <Supply> "Yard" · Rip-rap &amp; fabric <b>x</b>') && tag.title.includes('Inv A&B<1>"2"'));
  assert('the job and line ride in data attributes and come back exact',
    tag && tag.dataset.matProj === 'job "1" & <2>' && tag.dataset.matItem === 'line <3>');
  assert('the click handler names no free text, only the button',
    tag && tag.getAttribute('onclick') === 'event.stopPropagation();_bidMatPopToggle(this)', tag && tag.getAttribute('onclick'));

  // ── 5. The table ──────────────────────────────────────────────────────────
  console.log('  — the table');
  t.setData(fixture());
  t.srcCalls();
  t.renderBidTable(P, { tbodyId: 'tb' });
  assert('one table render builds the PO lookup once, not once per sub code', t.srcCalls() === 1);
  const rowFor = (tbodyId, name, col) => [...doc.querySelectorAll(`#${tbodyId} tr.bid-group-child:not(.bid-group-total)`)].find(r => {
    const td = r.children[col];
    const input = td && td.querySelector('input');
    return (input ? input.value : td && td.firstChild && td.firstChild.textContent.trim()) === name;
  });
  const cellFor = (tbodyId, name, col) => { const tr = rowFor(tbodyId, name, col); return tr ? tr.children[col] : null; };
  for (const [tb, col, label] of [['tb', 1, 'editable'], ['ro', 0, 'readonly']]) {
    if (tb === 'ro') { t.renderBidTable(P, { tbodyId: 'ro', readonly: true }); t.srcCalls(); }
    const silt = cellFor(tb, 'Silt Fence', col);
    const tags = silt && silt.querySelector('.bid-sub-tags');
    assert(`${label}: Silt Fence carries ✓ Complete, then its material`,
      !!tags && tags.children.length === 2 && /✓ Complete/.test(tags.children[0].textContent)
      && tags.children[1].className === 'bid-mat-tag' && tags.children[1].textContent === 'Material $622.68',
      silt && silt.innerHTML);
    assert(`${label}: the tag knows its job and line`,
      !!tags && tags.children[1].dataset.matProj === P && tags.children[1].dataset.matItem === 'b2');
    const travel = cellFor(tb, 'Travel', col);
    assert(`${label}: Travel keeps ✓ Complete and gets no material tag`,
      !!travel && !!travel.querySelector('.bid-sub-tags') && !travel.querySelector('.bid-mat-tag'), travel && travel.innerHTML);
    const stone = cellFor(tb, 'Stone Base', col);
    assert(`${label}: Stone Base, not complete, carries the material tag alone`,
      !!stone && stone.querySelectorAll('.bid-sub-tags > *').length === 1 && !!stone.querySelector('.bid-mat-tag'),
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
  // 19: the editable row's Plan / Day box came in beside Target Date.
  assert('neither layout gains a column', roCells === 14 && edCells === 19, `${roCells} / ${edCells}`);
  t.setData(importFixture());
  t.renderBidTable(P, { tbodyId: 'tb' });
  assert('a line whose only material sits outside its imported total is not tagged',
    !!cellFor('tb', 'Seeding', 1) && !cellFor('tb', 'Seeding', 1).querySelector('.bid-mat-tag')
    && /Material \$600\.00/.test(cellFor('tb', 'Topsoil', 1).textContent));

  // ── 6. The panel a tap opens ──────────────────────────────────────────────
  console.log('  — the panel a tap opens');
  t.setData(fixture());
  t.setView(P);
  t.renderBidTable(P);
  const btnFor = name => { const c = cellFor(`btbody-${P}`, name, 1); return c && c.querySelector('.bid-mat-tag'); };
  const pops = () => doc.querySelectorAll('.bid-mat-pop');
  // Counts that have gone back to zero are no listener at all.
  const live = () => JSON.stringify(Object.fromEntries(Object.entries(listening).filter(([, n]) => n)));
  const baseline = live();
  let btn = btnFor('Silt Fence');
  const tipBefore = btn.title;
  t._bidMatPopToggle(btn);
  let pop = doc.querySelector('.bid-mat-pop');
  assert('a tap opens one panel, on the page body', pops().length === 1 && pop.parentElement === doc.body);
  assert('it is labelled for a screen reader', pop.getAttribute('role') === 'dialog' && pop.getAttribute('aria-label') === 'Material on Silt Fence');
  assert('its head gives the total and the count',
    /^Material \$622\.68 · 2 entries, part of this sub code's Actual Cost/.test(pop.querySelector('.bmp-head').textContent),
    pop.querySelector('.bmp-head').textContent);
  let trs = pop.querySelectorAll('tbody tr');
  assert('a row per entry, oldest first: date, PO and invoice, supplier and what, amount',
    trs.length === 2 && [...trs[0].children].map(c => c.textContent).join(' | ')
      === '07/16/2026 | PO-0412Inv 88412 | Hanson & Sons SupplySilt fence 36" x 100\' | $580.50',
    trs[0] && [...trs[0].children].map(c => c.textContent).join(' | '));
  assert('the button says it is open, and drops its tooltip while the panel shows the same list',
    btn.getAttribute('aria-expanded') === 'true' && !btn.hasAttribute('title') && t.popOpen());
  assert('it listens for the ways it closes', listening.pointerdown > 0 && listening.keydown > 0 && listening.scroll > 0 && listening.focusin > 0);
  t._bidMatPopToggle(btn);
  assert('tapping the tag again closes it', pops().length === 0 && !t.popOpen());
  assert('…puts the tooltip back and says it is closed', btn.title === tipBefore && btn.getAttribute('aria-expanded') === 'false');
  assert('…and leaves no listener behind', live() === baseline, live());

  const fire = (target, type, init) => target.dispatchEvent(new w.Event(type, Object.assign({ bubbles: true }, init)));
  t._bidMatPopToggle(btn);
  fire(doc.querySelector('.bid-mat-pop td'), 'pointerdown');
  assert('a tap inside the panel leaves it open, so its numbers can be selected', pops().length === 1);
  fire(doc.querySelector('.bid-mat-pop'), 'scroll', { bubbles: false });
  assert('scrolling a long list inside it leaves it open', pops().length === 1);
  fire(doc.getElementById('elsewhere'), 'pointerdown');
  assert('a tap anywhere else closes it', pops().length === 0 && live() === baseline);
  t._bidMatPopToggle(btn);
  doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert('Esc closes it and hands focus back to the tag', pops().length === 0 && doc.activeElement === btn);
  t._bidMatPopToggle(btn);
  fire(doc.getElementById('scroller'), 'scroll', { bubbles: false });
  assert('scrolling the table closes it, rather than leave it hanging off nothing', pops().length === 0);
  t._bidMatPopToggle(btn);
  doc.getElementById('elsewhere').focus();
  assert('focus moving elsewhere closes it', pops().length === 0);
  t._bidMatPopToggle(btn);
  doc.querySelector('.bmp-close').onclick();
  assert('its ✕ closes it', pops().length === 0);
  t._bidMatPopToggle(btn);
  w.dispatchEvent(new w.Event('resize'));
  assert('a resize or turn of the iPad closes it', pops().length === 0 && live() === baseline, live());
  t._bidMatPopToggle(btn);
  t._bidMatPopToggle(btnFor('Stone Base'));
  pop = doc.querySelector('.bid-mat-pop');
  assert('opening another tag swaps the panel; there is only ever one',
    pops().length === 1 && /Material \$17,722\.84/.test(pop.textContent) && btn.getAttribute('aria-expanded') === 'false');
  assert('a delivery with no invoice # is picked out in the list',
    [...pop.querySelectorAll('.bmp-missing')].map(e => e.textContent).join() === 'no invoice #');
  t._bidMatPopClose();

  // Read fresh: the invoice arrives after the table was drawn.
  const fresh = t.getPOs();
  fresh[1].lines.find(l => l && l.id === 'l4').invoice_num = 'T-55302';
  t._bidMatPopToggle(btnFor('Stone Base'));
  assert('the panel reads the job as it is now, not as the table was drawn',
    /Inv T-55302/.test(doc.querySelector('.bid-mat-pop').textContent) && !/T-55302/.test(btnFor('Stone Base').title));
  t._bidMatPopClose();

  t.setData(many(15));
  t.renderBidTable(P);
  t._bidMatPopToggle(btnFor('Stone Base'));
  assert('the panel lists every entry, past the tooltip\'s cap', doc.querySelectorAll('.bid-mat-pop tbody tr').length === 15);
  t._bidMatPopClose();

  t.setData(nasty);
  t.renderBidTable(P);
  t._bidMatPopToggle(btnFor('Stone Base'));
  pop = doc.querySelector('.bid-mat-pop');
  assert('free text in the panel stays text: no element comes out of a supplier or invoice #',
    !pop.querySelector('tbody b') && pop.textContent.includes('Smith & Sons <Supply> "Yard"')
    && pop.textContent.includes('Rip-rap &amp; fabric <b>x</b>') && pop.textContent.includes('Inv A&B<1>"2"'));
  t._bidMatPopClose();

  t.setData(importFixture());
  t.renderBidTable(P);
  t._bidMatPopToggle(btnFor('Topsoil'));
  assert('a capped entry says so in the panel too',
    /\$400\.00of \$800\.00 on the row, capped by its imported Total Cost/.test(doc.querySelector('.bid-mat-pop').textContent),
    doc.querySelector('.bid-mat-pop').textContent);
  t._bidMatPopClose();

  const ghost = doc.createElement('button');
  ghost.dataset.matProj = P; ghost.dataset.matItem = 'deleted-line';
  t._bidMatPopToggle(ghost);
  assert('a tag whose line has since been deleted opens nothing', pops().length === 0 && !t.popOpen());

  // Placement, with the geometry a browser would report.
  const stub = (el, prop, v) => Object.defineProperty(el, prop, { value: v, configurable: true });
  stub(doc.documentElement, 'clientWidth', 1024);
  stub(doc.documentElement, 'clientHeight', 768);
  const place = (r, h, wd = 400) => {
    const el = doc.createElement('div');
    stub(el, 'offsetWidth', wd); stub(el, 'offsetHeight', h);
    const b = doc.createElement('button');
    b.getBoundingClientRect = () => ({ left: r[0], top: r[1], right: r[0] + 90, bottom: r[1] + 14 });
    t._bidMatPopPlace(el, b);
    return [parseInt(el.style.left, 10), parseInt(el.style.top, 10)];
  };
  assert('it hangs just under the tag, lined up with it', place([100, 300], 200).join() === '100,320', place([100, 300], 200).join());
  assert('…above the tag near the foot of the screen', place([100, 700], 200).join() === '100,494', place([100, 700], 200).join());
  assert('…pulled in from the right edge', place([900, 300], 200).join() === '616,320', place([900, 300], 200).join());
  assert('…and kept on screen when it fits neither above nor below', place([100, 300], 700).join() === '100,60',
    place([100, 300], 700).join());

  // ── 7. Staying current ────────────────────────────────────────────────────
  console.log('  — staying current when the poll brings new orders');
  t.setData(fixture());
  t.setView(P);
  t.renderBidTable(P);
  t.renders();
  const withInvoice = () => {
    const next = JSON.parse(JSON.stringify(t.getPOs()));
    next[1].lines.find(l => l && l.id === 'l4').invoice_num = 'T-55302';
    return next;
  };
  let before = t.getPOs(), after = withInvoice();
  t.setPOs(after);
  t._bidMatListChanged(before, after);
  assert('an invoice # added to a delivery on the open job redraws the bid at once', t.renders() === 1);
  assert('…and the tag\'s tooltip now has it', /Inv T-55302/.test(btnFor('Stone Base').title));
  before = t.getPOs(); after = JSON.parse(JSON.stringify(before));
  after.find(o => o && o.id === 'po-other').lines[0].invoice_num = 'X2';
  t.setPOs(after);
  t._bidMatListChanged(before, after);
  assert('a change on another job\'s order does not redraw this one', t.renders() === 0 && tick() === 0);
  t._bidMatListChanged(after, JSON.parse(JSON.stringify(after)));
  assert('a poll that changed nothing does not redraw', t.renders() === 0);
  const invBefore = [{ id: 'i1', inv_number: 'INV-0003', project_id: P, inv_row_id: 'r14' }];
  t._bidMatListChanged(invBefore, [{ id: 'i1', inv_number: 'INV-0004', project_id: P, inv_row_id: 'r14' }]);
  assert('a change to the open job\'s inventory redraws it too', t.renders() === 1);

  // Not under someone typing: it waits, and lands when they are done.
  doc.querySelector(`#btbody-${P} input`).focus();
  t._bidMatListChanged(t.getPOs(), withInvoice().map(o => o && o.id === 'po2' ? Object.assign(o, { title: 'Silt fence 2' }) : o));
  assert('a change landing while a box in the bid has focus waits', t.renders() === 0 && timers.some(x => x.live));
  assert('…and keeps waiting while it does', tick() === 1 && t.renders() === 0 && timers.some(x => x.live));
  doc.getElementById('elsewhere').focus();
  tick();
  assert('…then redraws once the box is let go', t.renders() === 1 && !timers.some(x => x.live));
  // Nor under someone reading the panel.
  t._bidMatPopToggle(btnFor('Silt Fence'));
  t._bidMatListChanged([], [{ id: 'new', project_id: P }]);
  assert('a change while the material panel is open waits for it to close', t.renders() === 0 && timers.some(x => x.live));
  t._bidMatPopClose();
  tick();
  assert('…and redraws after', t.renders() === 1);
  // Nor after the bid is closed.
  doc.querySelector(`#btbody-${P} input`).focus();
  t._bidMatListChanged([], [{ id: 'new2', project_id: P }]);
  t.setView(null);
  doc.getElementById('elsewhere').focus();
  tick();
  assert('a bid closed while a redraw waited is left alone, and the wait ends', t.renders() === 0 && !timers.some(x => x.live));
  t._bidMatListChanged([], [{ id: 'new3', project_id: P }]);
  assert('with no bid open a poll redraws nothing', t.renders() === 0 && !timers.some(x => x.live));
  t.setView(P);
  t.setView(null);

  // ── 8. Wiring ─────────────────────────────────────────────────────────────
  console.log('  — wiring');
  const render = extractFunction(src, 'renderBidTable');
  assert('the lookup is built before the groups are walked',
    /const matSrc = _bidMaterialSources\(\);\n\n  visGroups\.forEach\(costCode => \{/.test(render));
  assert('each sub code reads its material off that lookup, and hands the tag its job and line',
    /_bidMaterialTagHTML\(materialForBidItem\(b, projId, matSrc\), projId, b\.id\)/.test(render));
  assert('both layouts put the tags in the sub code cell', (render.match(/\$\{_subTags\}<\/td>/g) || []).length === 2);
  assert('the ✓ Complete badge itself is unchanged',
    render.includes('<span style="display:inline-block;font-size:0.56rem;font-weight:700;color:#4ade80;background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.4);border-radius:3px;padding:0.06rem 0.34rem;white-space:nowrap;letter-spacing:0.02em" title="Marked complete in the schedule">✓ Complete</span>'));
  assert('…and sits where it did, 0.18rem under the name', /\.bid-sub-tags \{ margin-top: 0\.18rem; \}/.test(src));
  assert('the tag is yellow, like the Actual Cost it is part of', /\.bid-mat-tag \{[^}]*color: var\(--yellow\);/.test(src));
  assert('the old single-badge variable is gone', !/_doneBadge/.test(src));
  assert('closing the bid closes the panel', /function closeBidView\(\) \{\n  _bidMatPopClose\(\);/.test(src));
  assert('on a touch screen the tap target reaches past the badge',
    /@media \(pointer: coarse\) \{\n\s+\.bid-mat-tag::after \{ content: ''; position: absolute;/.test(src));
  assert('the panel puts back the wrapping and borders the page\'s table rules take away',
    /\.bid-mat-pop table \{[^}]*white-space: normal;/.test(src) && /\.bid-mat-pop td \{ border: none;/.test(src));
  const poll = extractFunction(src, '_pollPurchaseOrders');
  assert('the PO poll hands the open bid the old and new lists, after its editing bail-out',
    /if \(_isEditing\(\)\) return;[\s\S]*const _poBefore = purchaseOrders;\n    purchaseOrders = incoming;\n[\s\S]*_bidMatListChanged\(_poBefore, incoming\);/
      .test(poll), poll);
  const invPoll = extractFunction(src, '_pollInventory');
  assert('…and so does the inventory poll',
    /if \(_isEditing\(\)\) return;[\s\S]*const _invBefore = inventoryEntries;\n    inventoryEntries = incoming;\n[\s\S]*_bidMatListChanged\(_invBefore, incoming\);/
      .test(invPoll), invPoll);
}

// ── 9. One implementation ───────────────────────────────────────────────────
console.log('\n[the three pages]');
for (const name of HELPERS) {
  const [a, ...rest] = PAGES.map(p => extractFunction(sources[p], name));
  assert(`${name} is the same on Turf, Paving and Kiewit`, rest.every(x => x === a));
}
for (const line of STATE) {
  const got = PAGES.map(p => extractLine(sources[p], line));
  assert(`…and so is "${line}"`, got.every(x => x === got[0]));
}

console.log(`\n${failed ? '❌' : '✅'}  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
