#!/usr/bin/env node
'use strict';
/**
 * Daily Tracking → Purchase Orders, in the three division pages.
 *
 * Run: node scripts/test-po-daily-sync.js
 *
 * The PO # on a Daily Tracking row used to be a label and nothing more: a row
 * could name PO-0003 and carry 20 t at $16.00 under 02-100 / 0420, the job was
 * charged, and PO-0003 — on the division's own tab and on central purchasing —
 * still read "no deliveries". These tests run the pages' OWN functions (lifted
 * from tracker.html, paving.html and kiewit-pinetree.html, which must carry the
 * same block) and pin what a row now does to the order it names:
 *
 *  - recorded as a delivery line, linked by po_row_id, tagged source:'daily'
 *  - edits to quantity / unit cost / date / employee / codes follow
 *  - a changed PO # moves the line; a cleared one removes it
 *  - rows that are not deliveries (labor, equipment, payroll, trucking,
 *    inventory, another job's order, an unpriced copy) are left alone
 *  - a line raised on the order follows the row's figures, tax and all, and
 *    keeps its PO # locked
 *  - deleting the row removes a Daily Tracking line, detaches any other
 *  - the catch-up pass records what is missing and never re-aligns
 *  - PO numbers that match no order are listed, and can be raised
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { requireFn, sliceSource, evalSlice } = require('./lib/fn-source');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

let passed = 0, failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail !== undefined) console.error('      ' + String(detail).slice(0, 500));
};

const PAGES = ['tracker.html', 'paving.html', 'kiewit-pinetree.html'];
const BLOCK_FROM = '/* ── Daily Tracking → Purchase Orders';
const BLOCK_TO   = '\nfunction _subCodeOpts(po) {';
const LIFTED = [
  '_normalizeNumeric', '_poNum', '_poNum0', '_lineAmt', '_lineTaxPct', '_lineTax',
  '_recalcLineTax', '_lineUnitCostWithTax', '_detachLinkedRows', 'makePOSelect',
  '_syncPOHeaderToLines',
];

function block(src, page) {
  return sliceSource(src, BLOCK_FROM, BLOCK_TO, `the Daily Tracking → PO block in ${page}`,
    'function _poDailyOrphansHTML');
}

/** A sandbox running one page's own code over a fresh set of orders and jobs. */
function sandbox(src, page) {
  const state = { saves: 0, rowPuts: [], confirms: 0, confirmAnswer: true };
  let n = 0;
  const ctx = vm.createContext({
    console, Map, Set, Math, String, Number, Array, Boolean, JSON, Date, Promise, isNaN,
    purchaseOrders: [], projectsList: [], truckingEntries: [], inventoryEntries: [],
    perm: { canEdit: true }, _AUTO_REPORT: false, activeTab: 'daily', _poLoadOk: true,
    fctUser: { name: 'Tester' }, _poExpanded: new Set(), poPage: 3,
    document: { getElementById: () => null, activeElement: null },
    uid: () => 'u' + (++n),
    _localDateStr: () => '2026-11-10',
    esc:   s => String(s || '').replace(/"/g, '&quot;'),
    escT:  s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escJs: s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"),
    fmt:   v => Number(v).toFixed(2),
    savePurchaseOrders: () => { state.saves++; },
    saveTruckingEntries: () => {}, saveInventoryEntries: () => {},
    renderPOTab: () => {}, renderProjectPOs: () => {}, renderDailyTable: () => {},
    drPutNow: (id, row) => { state.rowPuts.push({ id, row: { ...row } }); },
    drGetAll: async () => [],
    confirm: () => { state.confirms++; return state.confirmAnswer; },
  });
  ctx.getProj = id => ctx.projectsList.find(p => p.id === id);
  // requireFn starts at `function`, so an async one gets its keyword back here.
  LIFTED.forEach(name => {
    const fn = requireFn(src, name, page);
    evalSlice((src.includes(`async function ${name}(`) ? 'async ' : '') + fn, ctx, `${name} from ${page}`);
  });
  evalSlice(block(src, page), ctx, `the Daily Tracking → PO block from ${page}`);
  return { ctx, state, run: code => vm.runInContext(code, ctx) };
}

function row(over) {
  return Object.assign({
    id: 'r1', date: '2026-11-02', field_type: 'Material', employee: 'Sam',
    cost_code: '02-100', sub_code: '0420', material: '57 stone', supplier: 'Quarry Co',
    po_num: 'PO-0003', units_purchased: '20', unit_cost: '16', material_cost: '320',
    labor_hours: '', equip_hours: '', timesheet_entry_id: null,
  }, over || {});
}
function order(over) {
  return Object.assign({
    id: 'po3', po_number: 'PO-0003', title: 'Aggregate', supplier: 'Acme', status: 'pending',
    date_created: '2026-11-01', project_id: 'job1', cost_code: '', sub_code: '', lines: [],
  }, over || {});
}

// ── 0. One block, three pages ───────────────────────────────────────────────
console.log('\n[the three division pages carry the same code]');
{
  const blocks = PAGES.map(p => block(read(p), p));
  assert('paving.html carries the same block as tracker.html', blocks[1] === blocks[0]);
  assert('kiewit-pinetree.html carries the same block as tracker.html', blocks[2] === blocks[0]);
  ['makePOSelect', '_detachLinkedRows', '_syncPOHeaderToLines', 'deletePOLine'].forEach(fn => {
    const srcs = PAGES.map(p => requireFn(read(p), fn, p));
    assert(`${fn} is the same in all three`, srcs.every(s => s === srcs[0]));
  });
}

// ── 1. Wiring ───────────────────────────────────────────────────────────────
console.log('\n[the pages call it where they have to]');
PAGES.forEach(page => {
  const src = read(page);
  const change = sliceSource(src, "document.addEventListener('change', e => {\n  const el = e.target;\n  if (el.dataset.tab !== 'daily'",
    '\n});', `${page} daily change handler`, 'drPutNow');
  const syncAt = change.indexOf('_dailyRowToPO(el.dataset.proj, i)');
  assert(`${page}: a Daily Tracking edit reaches the order, before the row is written`,
    syncAt > 0 && syncAt < change.indexOf('drPutNow(p.dailyRows[i].id'));
  assert(`${page}: payroll rows are skipped`, /if \(!_isInj && PO_ROW_SYNC_FIELDS\.has\(el\.dataset\.f\)\)/.test(change));
  const boot = sliceSource(src, 'const _bootReady = (async () => {', '\n})();', `${page} boot`, 'renderHeaderActions');
  assert(`${page}: the catch-up runs after load and after the older rows arrive`,
    /_reconcileDailyPOLinks\(\)/.test(boot) && /_drBackfillDone\)\.then\(_dailyPOCatchUp\)/.test(boot)
    && boot.indexOf('_dailyPOCatchUp();') > boot.indexOf('if (_AUTO_REPORT) return;'));
  assert(`${page}: an import records its rows`,
    /_reconcileDailyPOLinks\(\)/.test(requireFn(src, 'commitImportCSV', page)));
  assert(`${page}: the daily table hands the PO # cell its link`,
    /makePOSelect\(projId, row\.po_num, ai, poLinks\.get\(String\(row\.id\)\)\)/.test(requireFn(src, 'renderDailyTable', page)));
  assert(`${page}: a good read of the orders is what allows the catch-up`,
    /_poLoadOk = true;/.test(requireFn(src, 'loadPurchaseOrders', page)));
  assert(`${page}: the PO tab lists numbers with no order`,
    /\$\{_poDailyOrphansHTML\(\)\}/.test(requireFn(src, 'renderPOTab', page)));
  assert(`${page}: and tags the deliveries Daily Tracking recorded`,
    /_poLineFromDaily\(line\) \? `<div title="Entered on Daily Tracking/.test(requireFn(src, 'renderPOTab', page)));
  assert(`${page}: removing a Daily Tracking delivery asks first`,
    /_poLineFromDaily\(line\) && line\.po_row_id && po\.project_id &&\s*!confirm\(/.test(requireFn(src, 'deletePOLine', page)));
});

// ── 2. Behaviour, run against each page's own code ──────────────────────────
PAGES.forEach(page => {
  const src = read(page);
  console.log(`\n[${page}: a row naming its job's order is a delivery on it]`);
  {
    const { ctx } = sandbox(src, page);
    const r = row();
    const po = order();
    ctx.projectsList.push({ id: 'job1', 'project-name': 'Main St', dailyRows: [r] });
    ctx.purchaseOrders.push(po);
    const res = ctx._syncDailyRowToPO('job1', r);
    const line = po.lines[0];
    assert('the order changed', res.poChanged === true);
    assert('it now has the delivery', po.lines.length === 1, JSON.stringify(po.lines));
    assert('  linked to the row', line && line.po_row_id === 'r1');
    assert('  tagged as entered on Daily Tracking', line && line.source === 'daily');
    assert('  with one id per row', line && line.id === 'dr-r1');
    assert('  the quantity and unit cost', line && line.qty === '20' && line.unit_cost === '16', JSON.stringify(line));
    assert('  the date and who received it', line && line.date === '2026-11-02' && line.employee === 'Sam');
    assert('  and the row\'s own cost / sub code', line && line.cost_code === '02-100' && line.sub_code === '0420');
    assert('  coming to the same money as the job row',
      ctx._lineAmt(line) + ctx._lineTax(line) === 320);
    assert('the order\'s own header is left alone',
      po.cost_code === '' && po.sub_code === '' && po.title === 'Aggregate' && po.supplier === 'Acme');
    assert('the row needs no rewrite', res.rowChanged === false);
    assert('a second pass changes nothing',
      ctx._syncDailyRowToPO('job1', r).poChanged === false && po.lines.length === 1);

    // The quantity changes on the job.
    r.units_purchased = '25'; r.material_cost = '400';
    ctx._syncDailyRowToPO('job1', r);
    assert('a new quantity follows to the order', line.qty === '25' && ctx._lineAmt(line) === 400, JSON.stringify(line));
    r.unit_cost = '18'; r.material_cost = '450';
    ctx._syncDailyRowToPO('job1', r);
    assert('a new unit cost follows', line.unit_cost === '18' && ctx._lineAmt(line) === 450, JSON.stringify(line));
    r.sub_code = '0430';
    ctx._syncDailyRowToPO('job1', r);
    assert('a re-coded row re-codes its delivery', line.sub_code === '0430');
    assert('  and still not the order', po.sub_code === '');
    r.date = '2026-11-04'; r.employee = 'Lee';
    ctx._syncDailyRowToPO('job1', r);
    assert('the date and employee follow', line.date === '2026-11-04' && line.employee === 'Lee');

    // Another order on the same job.
    const po4 = order({ id: 'po4', po_number: 'PO-0004' });
    ctx.purchaseOrders.push(po4);
    line.invoice_num = 'T-118';
    r.po_num = 'PO-0004';
    ctx._syncDailyRowToPO('job1', r);
    assert('a changed PO # moves the delivery', po.lines.length === 0 && po4.lines.length === 1);
    assert('  keeping its invoice #', po4.lines[0].invoice_num === 'T-118');
    r.po_num = '';
    ctx._syncDailyRowToPO('job1', r);
    assert('a cleared PO # takes it off the order', po4.lines.length === 0 && po.lines.length === 0);
    r.po_num = 'PO-0003';
    ctx._syncDailyRowToPO('job1', r);
    assert('putting it back records it again, once', po.lines.length === 1 && po.lines[0].id === 'dr-r1');
    r.units_purchased = ''; r.unit_cost = ''; r.material_cost = '';
    ctx._syncDailyRowToPO('job1', r);
    assert('a row emptied of material leaves the order', po.lines.length === 0);
  }

  console.log(`\n[${page}: what is not a delivery stays off the order]`);
  {
    const { ctx } = sandbox(src, page);
    const po = order();
    ctx.purchaseOrders.push(po, order({ id: 'poX', po_number: 'PO-0009', project_id: 'job2' }));
    const job = { id: 'job1', 'project-name': 'Main St', dailyRows: [] };
    ctx.projectsList.push(job);
    const cases = [
      ['a crew row with labor hours', row({ id: 'a', labor_hours: '8' })],
      ['a row with equipment hours',  row({ id: 'b', equip_hours: '4' })],
      ['a payroll row',               row({ id: 'c', timesheet_entry_id: 77 })],
      ['a payroll-minted id',         row({ id: 'ts12-1' })],
      ['a row a trucking entry owns', row({ id: 'd' })],
      ['a row an inventory entry owns', row({ id: 'e' })],
      ['a row naming another job\'s order', row({ id: 'f', po_num: 'PO-0009' })],
      ['a copied row not yet charged', row({ id: 'g', material_cost: '' })],
      ['a row with no material at all', row({ id: 'h', units_purchased: '', unit_cost: '', material_cost: '' })],
    ];
    ctx.truckingEntries.push({ id: 't', tr_row_id: 'd' });
    ctx.inventoryEntries.push({ id: 'i', inv_row_id: 'e' });
    cases.forEach(([label, r]) => {
      job.dailyRows.push(r);
      const res = ctx._syncDailyRowToPO('job1', r);
      assert(label + ' is not recorded', !res.poChanged && po.lines.length === 0, JSON.stringify(po.lines));
    });
    const qtyOnly = row({ id: 'q', unit_cost: '', material_cost: '' });
    ctx._syncDailyRowToPO('job1', qtyOnly);
    assert('a quantity with no price yet IS recorded — purchasing prices it',
      po.lines.length === 1 && po.lines[0].qty === '20' && po.lines[0].unit_cost === '', JSON.stringify(po.lines));
    po.lines = [];
    const imported = row({ id: 'imp', units_purchased: '10', unit_cost: '15', material_cost: '160' });
    ctx._syncDailyRowToPO('job1', imported);
    assert('an imported total is matched to the cent',
      po.lines.length === 1 && ctx._lineAmt(po.lines[0]) === 160 && po.lines[0].unit_cost === '16', JSON.stringify(po.lines));
    po.lines = [];
    const lumpSum = row({ id: 'ls', units_purchased: '', unit_cost: '', material_cost: '500' });
    ctx._syncDailyRowToPO('job1', lumpSum);
    assert('a lump sum is one unit at the total',
      po.lines.length === 1 && po.lines[0].qty === '1' && po.lines[0].unit_cost === '500', JSON.stringify(po.lines));
    po.lines = [];
    ctx._syncDailyRowToPO('job1', row({ id: 'case', po_num: '  po-0003 ' }));
    assert('the PO # matches whatever its case and spacing', po.lines.length === 1);
    po.lines = [];
    ctx.perm.canEdit = false;
    ctx._dailyRowToPO('job1', 0);
    assert('a view-only user writes nothing', po.lines.length === 0);
  }

  console.log(`\n[${page}: a line raised on the order follows its row]`);
  {
    const { ctx, state } = sandbox(src, page);
    // Raised on the PO tab with 6.5% tax: the row carries unit cost WITH tax.
    const line = { id: 'L1', invoice_num: 'INV-1', date: '2026-11-02', qty: '10', unit_cost: '16',
                   tax: '10.4', tax_pct: '6.5', employee: 'Sam', po_row_id: 'r9' };
    const po = order({ cost_code: '100', sub_code: 'A', lines: [line] });
    const r = row({ id: 'r9', units_purchased: '10', unit_cost: '17.04', material_cost: '170.4',
                    cost_code: '100', sub_code: 'A' });
    ctx.purchaseOrders.push(po);
    ctx.projectsList.push({ id: 'job1', 'project-name': 'Main St', dailyRows: [r] });

    assert('an untouched row changes nothing', ctx._syncDailyRowToPO('job1', r).poChanged === false);
    r.units_purchased = '12'; r.material_cost = String(12 * 17.04);
    const res = ctx._syncDailyRowToPO('job1', r);
    assert('the new quantity reaches the order', res.poChanged && line.qty === '12', JSON.stringify(line));
    assert('  its pre-tax unit cost is untouched', line.unit_cost === '16');
    assert('  its tax is redone on the new amount', Math.abs(ctx._lineTax(line) - 12.48) < 1e-9, line.tax);
    assert('  and the order and the job agree',
      Math.abs(ctx._lineAmt(line) + ctx._lineTax(line) - Number(r.material_cost)) < 0.005);
    r.unit_cost = '21.3'; r.material_cost = String(12 * 21.3);
    ctx._syncDailyRowToPO('job1', r);
    assert('a new unit cost has the tax taken back out of it', line.unit_cost === '20', JSON.stringify(line));
    assert('  and still comes to the job\'s money',
      Math.abs(ctx._lineAmt(line) + ctx._lineTax(line) - Number(r.material_cost)) < 0.005);
    r.cost_code = '250'; r.sub_code = 'B';
    ctx._syncDailyRowToPO('job1', r);
    assert('a supervisor re-coding the row does not re-code the order',
      po.cost_code === '100' && po.sub_code === 'A' && line.cost_code === undefined);
    r.po_num = 'PO-0004';
    ctx.purchaseOrders.push(order({ id: 'po4', po_number: 'PO-0004' }));
    ctx._syncDailyRowToPO('job1', r);
    assert('its PO # is the order\'s — the line does not move', po.lines.length === 1);
    r.po_num = 'PO-0003';

    // Legacy flat-dollar tax: the row is brought to what the line charges.
    const legacy = { id: 'L2', date: '2026-11-02', qty: '10', unit_cost: '16', tax: '9.6', employee: 'Sam', po_row_id: 'r10' };
    po.lines.push(legacy);
    const r10 = row({ id: 'r10', units_purchased: '12', unit_cost: '16.96', material_cost: String(12 * 16.96) });
    const res2 = ctx._syncDailyRowToPO('job1', r10);
    assert('a flat tax stays flat on a new quantity', legacy.qty === '12' && legacy.tax === '9.6' && legacy.unit_cost === '16');
    assert('  and the row is brought to it', res2.rowChanged && Math.abs(Number(r10.material_cost) - 201.6) < 1e-9, r10.material_cost);

    // The catch-up never re-aligns: its rows can be older than the order.
    r.units_purchased = '99';
    ctx._syncDailyRowToPO('job1', r, { bulk: true });
    assert('the catch-up leaves a raised line alone', line.qty === '12');

    // The PO # cell.
    const links = ctx._poLinksByRow();
    const locked = ctx.makePOSelect('job1', 'PO-0003', 0, links.get('r9'));
    assert('the PO # cell is locked on a row an order raised', /\sdisabled\b/.test(locked) && /PO-0003/.test(locked));
    const free = ctx.makePOSelect('job1', 'PO-0003', 1, undefined);
    assert('and free on any other row', !/\sdisabled\b/.test(free) && !/outline/.test(free));
    const orphan = ctx.makePOSelect('job1', 'PO-0999', 2, undefined);
    assert('a number with no order on the job is flagged', /outline:1px solid var\(--yellow\)/.test(orphan) && /PO-0999/.test(orphan));
    assert('no confirm was needed for any of it', state.confirms === 0);
  }

  console.log(`\n[${page}: deleting the row]`);
  {
    const { ctx, state } = sandbox(src, page);
    const daily = { id: 'dr-r1', source: 'daily', qty: '20', unit_cost: '16', po_row_id: 'r1' };
    const raised = { id: 'L1', qty: '5', unit_cost: '10', po_row_id: 'r2' };
    const po = order({ lines: [daily, raised] });
    ctx.purchaseOrders.push(po);
    ctx._detachLinkedRows(id => id === 'r1');
    assert('a Daily Tracking delivery goes with its row', po.lines.length === 1 && po.lines[0] === raised);
    ctx._detachLinkedRows(id => id === 'r2');
    assert('a line raised on the order stays, detached as before',
      po.lines.length === 1 && raised.po_row_id === null && raised.qty === '5');
    assert('both saved', state.saves === 2);
  }

  console.log(`\n[${page}: the order's header edits leave a Daily Tracking row's own fields]`);
  {
    const { ctx, state } = sandbox(src, page);
    const r1 = row({ id: 'r1' });
    const r2 = row({ id: 'r2', material: '', supplier: '', cost_code: '', sub_code: '' });
    const po = order({ title: 'Stone', supplier: 'Acme', cost_code: '300', sub_code: 'C', po_number: 'PO-0007',
      lines: [{ id: 'dr-r1', source: 'daily', po_row_id: 'r1' }, { id: 'L2', po_row_id: 'r2' }] });
    ctx.purchaseOrders.push(po);
    ctx.projectsList.push({ id: 'job1', dailyRows: [r1, r2], _drFullLoaded: true });
    vm.runInContext('_syncPOHeaderToLines(purchaseOrders[0], true)', ctx);
    assert('the Daily Tracking row keeps its codes, material and supplier',
      r1.cost_code === '02-100' && r1.sub_code === '0420' && r1.material === '57 stone' && r1.supplier === 'Quarry Co',
      JSON.stringify(r1));
    assert('  but takes the order\'s number', r1.po_num === 'PO-0007');
    assert('the raised row follows the order as before',
      r2.cost_code === '300' && r2.sub_code === 'C' && r2.material === 'Stone' && r2.supplier === 'Acme' && r2.po_num === 'PO-0007');
    assert('both rows written', state.rowPuts.length === 2);
  }

  console.log(`\n[${page}: the catch-up pass]`);
  {
    const { ctx, state } = sandbox(src, page);
    const po = order();
    const dead = { id: 'dr-gone', source: 'daily', qty: '3', unit_cost: '5', po_row_id: null };
    po.lines.push(dead);
    const noJob = order({ id: 'poN', po_number: 'PO-0050', project_id: '',
      lines: [{ id: 'dr-x', source: 'daily', qty: '4', unit_cost: '5', po_row_id: null }] });
    ctx.purchaseOrders.push(po, noJob);
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', labor_hours: '8' }),
      row({ id: 'c', po_num: 'PO-0777' }),
      row({ id: 'd', po_num: '' }),
    ];
    ctx.projectsList.push({ id: 'job1', 'project-name': 'Main St', dailyRows: rows });

    ctx._poLoadOk = false;
    assert('nothing runs against an order list that failed to load', ctx._reconcileDailyPOLinks() === 0 && state.saves === 0);
    ctx._poLoadOk = true;
    ctx.perm.canEdit = false;
    assert('nothing runs for a view-only user', ctx._reconcileDailyPOLinks() === 0 && state.saves === 0);
    ctx.perm.canEdit = true;
    ctx._AUTO_REPORT = true;
    assert('nothing runs for the report robot', ctx._reconcileDailyPOLinks() === 0 && state.saves === 0);
    ctx._AUTO_REPORT = false;

    const n = ctx._reconcileDailyPOLinks();
    assert('it records the row that is a delivery', po.lines.some(l => l.po_row_id === 'a'), JSON.stringify(po.lines));
    assert('  and only that one', po.lines.filter(l => l.source === 'daily').length === 1);
    assert('it clears a Daily Tracking line whose row is gone', !po.lines.includes(dead));
    assert('but not on an order with no job, whose rows come back when one is set', noJob.lines.length === 1);
    assert('one save for the lot', n === 1 && state.saves === 1);
    assert('a second pass finds nothing to do', ctx._reconcileDailyPOLinks() === 0 && state.saves === 1);

    // A row recorded twice — once by purchasing, once by a tab that saw the
    // row before the order linking it. The order's own line stands.
    const shadowed = order({ id: 'poS', po_number: 'PO-0005', lines: [
      { id: 'L9', qty: '2', unit_cost: '3', po_row_id: 'z' },
      { id: 'dr-z', source: 'daily', qty: '2', unit_cost: '3', po_row_id: 'z' },
    ] });
    ctx.purchaseOrders.push(shadowed);
    ctx._reconcileDailyPOLinks();
    assert('a Daily Tracking copy of a raised line is dropped',
      shadowed.lines.length === 1 && shadowed.lines[0].id === 'L9', JSON.stringify(shadowed.lines));

    // A second tab, holding the same rows, records the same line — not a twin.
    const other = sandbox(src, page).ctx;
    const po2 = order();
    other.purchaseOrders.push(po2);
    other.projectsList.push({ id: 'job1', dailyRows: [row({ id: 'a' })] });
    other._reconcileDailyPOLinks();
    assert('another tab mints the same line id', po2.lines.length === 1 && po2.lines[0].id === po.lines.find(l => l.po_row_id === 'a').id);
  }

  console.log(`\n[${page}: PO numbers with no order]`);
  {
    const { ctx, state } = sandbox(src, page);
    ctx.purchaseOrders.push(order(), order({ id: 'poZ', po_number: 'PO-0020', project_id: 'job2' }));
    ctx.projectsList.push(
      { id: 'job1', 'project-name': 'Main St', dailyRows: [
        row({ id: 'a', po_num: 'PO-0099', date: '2026-10-30', material: '#2 stone', cost_code: '02-200', sub_code: '0500' }),
        row({ id: 'b', po_num: 'po-0099', date: '2026-10-28', material_cost: '100', units_purchased: '5', unit_cost: '20' }),
        row({ id: 'c', po_num: 'PO-0020' }),
        row({ id: 'd', po_num: 'PO-0003' }),
      ] },
      { id: 'job2', 'project-name': 'Oak Ave', dailyRows: [] });
    const groups = ctx._dailyPONumbersWithoutOrder();
    const g99 = groups.find(g => g.poNum.toLowerCase() === 'po-0099');
    const g20 = groups.find(g => g.poNum === 'PO-0020');
    assert('a number with no order anywhere is listed, its rows counted together',
      g99 && g99.rows === 2 && g99.material === 420 && !g99.elsewhere, JSON.stringify(groups));
    assert('a number another job holds is listed with that order', g20 && g20.elsewhere && g20.elsewhere.id === 'poZ');
    assert('a number the job has an order for is not listed', !groups.some(g => g.poNum === 'PO-0003'));
    const html = ctx._poDailyOrphansHTML();
    assert('the notice offers to raise the missing one', /createPOFromDaily\('job1','PO-0099'\)/.test(html), html);
    assert('  but not one that exists on another job', !/createPOFromDaily\('job1','PO-0020'\)/.test(html) && /is on Oak Ave/.test(html));

    ctx.createPOFromDaily('job1', 'PO-0020');
    assert('it will not raise a number the division already has', ctx.purchaseOrders.length === 2);
    ctx.createPOFromDaily('job1', 'PO-0099');
    const made = ctx.purchaseOrders.find(p => p.po_number === 'PO-0099');
    assert('raising it creates the order on the job', made && made.project_id === 'job1' && made.status === 'pending');
    assert('  headed from the rows', made && made.title === '#2 stone' && made.cost_code === '02-200' && made.sub_code === '0500');
    assert('  dated from the earliest row', made && made.date_created === '2026-10-28');
    assert('  stamped with who raised it', made && made.created_by === 'Tester' && Boolean(made.created_at));
    assert('  with both rows recorded on it', made && made.lines.length === 2 && made.lines.every(l => l.source === 'daily'));
    assert('  and saved once, first page', state.saves === 1 && ctx.poPage === 0);
    assert('the notice no longer lists it', !ctx._dailyPONumbersWithoutOrder().some(g => g.poNum.toLowerCase() === 'po-0099'));
  }
});

// ── 3. Central purchasing shows where a delivery came from ──────────────────
console.log('\n[purchase-orders.html]');
{
  const src = read('purchase-orders.html');
  const ctx = vm.createContext({ String, Boolean });
  vm.runInContext(requireFn(src, 'esc') + requireFn(src, 'isDailyLine') + requireFn(src, 'dailyLineTagHTML'), ctx);
  const tag = ctx.dailyLineTagHTML({ source: 'daily', cost_code: '02-100', sub_code: '0420' });
  assert('a Daily Tracking delivery is tagged with the row\'s codes', /from Daily Tracking/.test(tag) && /02-100 \/ 0420/.test(tag), tag);
  assert('an ordinary one is not', ctx.dailyLineTagHTML({ id: 'L1' }) === '');
  assert('the delivery rows draw the tag', /inp\('invoice_num','text', l\.invoice_num, 'placeholder="Invoice \/ Ticket #"'\) \+ dailyLineTagHTML\(l\)/.test(requireFn(src, 'lineRowsHTML')));
  assert('removing one asks first — it deletes the job row',
    /isDailyLine\(gone\) && gone\.po_row_id && po\.project_id &&\s*!confirm\(/.test(requireFn(src, 'deleteLine')));
}

console.log('\n────────────────────────────────────────');
console.log(`  ${passed} passed, ${failed} failed`);
console.log('────────────────────────────────────────\n');
process.exit(failed === 0 ? 0 : 1);
