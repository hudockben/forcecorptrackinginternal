#!/usr/bin/env node
'use strict';
/**
 * Saving a customer's rate fills it into that customer's rows that have no
 * fee and are not invoiced yet — and the rate past rows suggest sits beside
 * an empty box instead of inside it.
 *
 * Run: node scripts/test-truck-rate-fill.js
 *
 * Two things sent the office asking why the Haul Fee "doesn't auto fill":
 *
 *   1. A customer with no saved rate showed the fee its past rows usually
 *      billed as the rate box's gray placeholder. A gray 115 in a box reads as
 *      a saved 115, and nothing fills a row from a placeholder — 26 customers
 *      sat like that, Kovalchick among them.
 *   2. A rate only ever reached a row at the moment somebody named the
 *      customer on it. Saving one later changed the list and nothing else, and
 *      a payroll row — whose Customer cell is locked — could never get one.
 *
 * What this pins:
 *   - which rows a saved rate fills: that company's, fee blank, nothing on the
 *     row saying it was invoiced; never a typed fee, a payroll fee or a $0,
 *   - a payroll row takes it through the backup fee, as if typed in its box,
 *   - Undo empties exactly what the fill wrote and nothing typed since, and
 *     leaves the rate saved,
 *   - a mistyped rate corrected while its bar is up corrects the rows too,
 *   - every way a rate is saved (the box, the "usually" chip, Add with a
 *     rate, Fill blank rates from past rows) and the rows a rate saved earlier
 *     is still owed (Fill blank Haul Fees from saved rates),
 *   - what the panel says about all of it.
 *
 * No DB, server or browser required.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const { sliceSource: slice, evalSlice } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const { guardConfigFor, mergeInjectedRows } = require('../api/lib/injected-blob-guard.js');

const TRUCKING = read('trucking.html');
const BAR = '═'.repeat(43);

// The same regions test-truck-list-deletions.js lifts, plus the backup fee a
// payroll row is priced through.
const HELPERS   = slice(TRUCKING, '    const _remKey =', '    function saveTruckLists()', 'list helpers + sweep',
                        ['function customerRate', 'function _historicRate']);
const PANEL     = slice(TRUCKING, '    function addToList(key)', '    function schedSave()', 'panel handlers',
                        ['function updateCustomerRate', 'function _rateFillAfterSave', 'function fillFeesFromRates']);
const RENDER    = slice(TRUCKING, '    /* ── Reading a sign-in against the drivers list', '    function schedSave()',
                        'panel render', 'function renderListsPanel');
const ROWEDIT   = slice(TRUCKING, '    /** Re-total a row and keep', `    /* ${BAR}\n       BACKUP HAUL FEE`,
                        '_syncRowTotal + updateField', ['function _syncRowTotal', 'function updateField']);
const BACKUPFEE = slice(TRUCKING, `    /* ${BAR}\n       BACKUP HAUL FEE`, '    /* ── The pooled name on a Customer cell',
                        'the fee gate + the backup fee', ['function _feeVal', 'function _applyBackupFee', 'function clearBackupFee']);
const POOL      = slice(TRUCKING, `    /* ${BAR}\n       INTERCOMPANY CUSTOMER POOLING`, `    /* ${BAR}\n       INTERCOMPANY BILLING`,
                        'the EES customer pool');

const YEAR = String(new Date().getFullYear());
const LAST = String(new Date().getFullYear() - 1);

const freshLists = () => ({
  drivers: [], customers: [], units: [], locations: [], materials: [], rates: {},
  removed: { drivers: [], customers: [], units: [], materials: [] },
});

/** The panel's handlers over a set of rows, with the saves and redraws counted. */
function newPage(state) {
  const sandbox = {
    console,
    divEntries: state.entries || [],
    divTruckLists: state.lists || freshLists(),
    icBillingArr: [], icSentMap: new Map(),
    _divEntriesLoaded: true,
    saves: 0, tableDraws: 0,
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
    tdDivPut() { sandbox.saves++; },
    saveTruckLists() { sandbox.saves++; },
    renderListsPanel() {}, renderScheduler() {},
    renderTrackingTab() { sandbox.tableDraws++; },
    _paintCustPool() {},
    schedIsActive: () => false, schedSave() {}, calcHours: () => null,
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    driverLoginMap: {}, saveDriverLogins() {},
    SCHED_BOARDS: [], schedS: () => ({ loaded: false, assignments: {} }),
    schedEnsureLoaded: () => Promise.resolve(), schedMarkDirty() {},
    _listsUndo: null, _listsShowRemoved: new Set(), _listsMerge: null, _listsNote: '',
    document: { getElementById: id => (state.inputs && id in state.inputs ? { value: state.inputs[id] } : null) },
  };
  vm.createContext(sandbox);
  evalSlice(POOL + '\n' + HELPERS + '\n' + PANEL + '\n' + ROWEDIT + '\n' + BACKUPFEE, sandbox,
           'the pool + list helpers + the panel + the row editor + the backup fee', { filename: 'trucking.html' });
  return sandbox;
}

/** Render the Customers & Rates tab and hand back its HTML. */
function renderPanel(state, drive) {
  let html = '', tabsHtml = '';
  const body = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const tabs = { set innerHTML(v) { tabsHtml = v; }, get innerHTML() { return tabsHtml; } };
  const sandbox = {
    console,
    divEntries: state.entries || [],
    divTruckLists: state.lists || freshLists(),
    divLists: { employees: [], equipment: [] },
    icBillingArr: [], icSentMap: new Map(),
    driverLoginMap: {}, driverLoginUsers: [], _driverLoginsLoaded: true,
    loadDriverLogins: () => Promise.resolve(),
    renderTrackingTab() {}, renderScheduler() {}, schedIsActive: () => false,
    schedSave() {}, calcHours: () => null, tdDivPut() {}, saveTruckLists() {},
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    document: {
      getElementById: id => (id === 'lists-panel-body' ? body : id === 'lists-tabs' ? tabs : null),
      addEventListener() {},
    },
  };
  vm.createContext(sandbox);
  evalSlice(POOL + '\n' + HELPERS + '\n' + RENDER + '\n' + ROWEDIT + '\n' + BACKUPFEE, sandbox,
           'the pool + list helpers + the render + the row editor + the backup fee', { filename: 'trucking.html' });
  if (drive) drive(sandbox);
  sandbox.renderListsPanel();
  return { html: html.replace(/\s+/g, ' '), page: sandbox };
}

// A Kovalchick book with one of everything a fill has to tell apart.
const kovalchickRows = () => ([
  { id: 'm-blank',    customer: 'Kovalchick', haul_fee: '',    total_hours: '10',   actual_date: `${YEAR}-09-24`, invoice_status: 'Unpaid' },
  { id: 'm-lower',    customer: 'kovalchick', haul_fee: '',    total_hours: '2',    actual_date: `${YEAR}-09-20`, invoice_status: 'Unpaid' },
  { id: 'm-space',    customer: 'Kovalchick', haul_fee: '  ',  total_hours: '1',    actual_date: `${YEAR}-09-19`, invoice_status: 'Unpaid' },
  { id: 'm-old',      customer: 'Kovalchick', haul_fee: '',    total_hours: '4',    actual_date: `${LAST}-06-01`, invoice_status: 'Unpaid' },
  { id: 'm-priced',   customer: 'Kovalchick', haul_fee: '120', total_hours: '5',    actual_date: `${YEAR}-09-18`, invoice_status: 'Unpaid' },
  { id: 'm-zero',     customer: 'Kovalchick', haul_fee: 0,     total_hours: '3',    actual_date: `${YEAR}-09-17`, invoice_status: 'Unpaid' },
  { id: 'm-qb',       customer: 'Kovalchick', haul_fee: '',    total_hours: '8',    actual_date: `${YEAR}-09-16`, qb_invoice: 'QB-7001' },
  { id: 'm-invd',     customer: 'Kovalchick', haul_fee: '',    total_hours: '8',    actual_date: `${YEAR}-09-15`, invoiced_date: `${YEAR}-09-16` },
  { id: 'm-sent',     customer: 'Kovalchick', haul_fee: '',    total_hours: '8',    actual_date: `${YEAR}-09-14`, invoice_sent_date: `${YEAR}-09-16` },
  { id: 'm-paid',     customer: 'Kovalchick', haul_fee: '',    total_hours: '8',    actual_date: `${YEAR}-09-13`, invoice_status: 'Paid' },
  { id: 'm-partial',  customer: 'Kovalchick', haul_fee: '',    total_hours: '8',    actual_date: `${YEAR}-09-12`, invoice_status: 'partial' },
  { id: 'm-datepaid', customer: 'Kovalchick', haul_fee: '',    total_hours: '8',    actual_date: `${YEAR}-09-11`, date_paid: `${YEAR}-09-20` },
  { id: 'm-other',    customer: 'Kinkead',    haul_fee: '',    total_hours: '6',    actual_date: `${YEAR}-09-24`, invoice_status: 'Unpaid' },
  // Payroll's rows: the fee is payroll's, and the tab prices one only through
  // its backup fee.
  { id: 'tst-5-row',  customer: 'Kovalchick', haul_fee: '',    total_hours: 10.25, actual_date: `${YEAR}-09-25`, invoice_status: 'Unpaid' },
  { id: 'tst-6-row',  customer: 'Kovalchick', haul_fee: 110,   total_hours: 9,     actual_date: `${YEAR}-09-23`, invoice_status: 'Unpaid' },
  { id: 'tst-7-row',  customer: 'Kovalchick', haul_fee: 125,   haul_fee_override: 125, haul_fee_payroll: '',
    total_hours: 9, actual_date: `${YEAR}-09-22`, invoice_status: 'Unpaid' },
  { id: 'tst-8-row',  customer: 'Kovalchick', haul_fee: '',    total_hours: 9,     actual_date: `${YEAR}-09-21`, invoiced_date: `${YEAR}-09-22` },
]);
const row = (p, id) => p.divEntries.find(e => e.id === id);

(async () => {
  console.log('Saving a rate fills the rows that are waiting on one\n');

  // ── 1. Which rows a saved rate fills ───────────────────────────────────
  console.log('[saving Kovalchick at 115]');
  {
    const lists = freshLists();
    lists.customers = ['Kinkead', 'Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists });
    p.updateCustomerRate('Kovalchick', '115');

    assert('the rate is saved', p.customerRate('Kovalchick') === '115', JSON.stringify(p.divTruckLists.rates));
    assert('a blank row takes it', row(p, 'm-blank').haul_fee === '115', JSON.stringify(row(p, 'm-blank')));
    assert('so does the same company typed in lower case', row(p, 'm-lower').haul_fee === '115');
    assert('and a fee box holding only spaces, which is blank', row(p, 'm-space').haul_fee === '115');
    assert('an uninvoiced row from last year is filled too', row(p, 'm-old').haul_fee === '115');

    assert('a fee already on the row is left alone', row(p, 'm-priced').haul_fee === '120');
    assert('and so is a deliberate $0', row(p, 'm-zero').haul_fee === 0, JSON.stringify(row(p, 'm-zero').haul_fee));

    for (const [id, what] of [['m-qb', 'a QB invoice number'], ['m-invd', 'an invoiced date'],
                              ['m-sent', 'a sent date'], ['m-paid', 'Paid'], ['m-partial', 'Partial'],
                              ['m-datepaid', 'a paid date']]) {
      assert(`a blank row with ${what} is not repriced`, row(p, id).haul_fee === '', JSON.stringify(row(p, id)));
    }
    assert('another customer\'s blank row is untouched', row(p, 'm-other').haul_fee === '');

    const t5 = row(p, 'tst-5-row');
    assert('a blank payroll row is priced through its backup fee',
      t5.haul_fee === 115 && t5.haul_fee_override === 115 && t5.haul_fee_payroll === '', JSON.stringify(t5));
    assert('a payroll row payroll priced is left alone',
      row(p, 'tst-6-row').haul_fee === 110 && !('haul_fee_override' in row(p, 'tst-6-row')));
    assert('and so is one the office already priced here',
      row(p, 'tst-7-row').haul_fee === 125 && row(p, 'tst-7-row').haul_fee_override === 125);
    assert('an invoiced payroll row is not repriced either',
      row(p, 'tst-8-row').haul_fee === '' && !('haul_fee_override' in row(p, 'tst-8-row')));

    const u = p._listsUndo;
    assert('the fill is on the Undo bar', !!u && u.kind === 'ratefill', JSON.stringify(u));
    assert('naming exactly the rows it wrote',
      !!u && u.rows.map(r => r.id).sort().join() === ['m-blank', 'm-lower', 'm-space', 'm-old', 'tst-5-row'].sort().join(),
      u && u.rows.map(r => r.id).join());
    assert('and counting the blank rows it left alone for being invoiced', !!u && u.skipped === 7, u && String(u.skipped));
    assert('one save carries the rate and the rows together', p.saves === 1, String(p.saves));
    assert('and the table is redrawn to show them', p.tableDraws === 1, String(p.tableDraws));

    // What the server does with the payroll row the save carries: the backup
    // fee is a column the tab owns, and haul_fee is derived from it.
    const srv = { id: 'tst-5-row', customer: 'Kovalchick', haul_fee: '', total_hours: 10.25, invoice_status: 'Unpaid' };
    const [stored] = mergeInjectedRows([srv], [JSON.parse(JSON.stringify(t5))], guardConfigFor('fct_truck_division'));
    assert('and the server keeps it, as the office\'s fee beside payroll\'s blank',
      stored.haul_fee === 115 && stored.haul_fee_override === 115 && stored.haul_fee_payroll === '',
      JSON.stringify(stored));
  }

  // ── 2. Undo ────────────────────────────────────────────────────────────
  console.log('\n[undo]');
  {
    const lists = freshLists();
    lists.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists });
    p.updateCustomerRate('Kovalchick', '115');
    p.undoListChange();
    assert('empties the rows it filled',
      ['m-blank', 'm-lower', 'm-space', 'm-old'].every(id => row(p, id).haul_fee === ''),
      ['m-blank', 'm-lower', 'm-space', 'm-old'].map(id => JSON.stringify(row(p, id).haul_fee)).join());
    const t5 = row(p, 'tst-5-row');
    assert('and hands the payroll row back to payroll\'s blank',
      t5.haul_fee === '' && !('haul_fee_payroll' in t5), JSON.stringify(t5));
    // Blank, not deleted — or the save guard keeps the override it has.
    assert('sending the backup fee as a blank answer', t5.haul_fee_override === '', JSON.stringify(t5));
    const srv = { id: 'tst-5-row', customer: 'Kovalchick', haul_fee: 115, haul_fee_override: 115,
                  haul_fee_payroll: '', total_hours: 10.25 };
    const [stored] = mergeInjectedRows([srv], [JSON.parse(JSON.stringify(t5))], guardConfigFor('fct_truck_division'));
    assert('which the server takes, rather than keeping the fee it had',
      stored.haul_fee === '' && !('haul_fee_override' in stored), JSON.stringify(stored));
    assert('the rate stays saved', p.customerRate('Kovalchick') === '115');
    assert('the rows it never touched are as they were',
      row(p, 'm-priced').haul_fee === '120' && row(p, 'm-zero').haul_fee === 0 && row(p, 'tst-6-row').haul_fee === 110);
    assert('and the bar is gone', p._listsUndo === null);
  }
  {
    // Undo takes back what the fill wrote — never what somebody did since.
    const lists = freshLists();
    lists.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists });
    p.updateCustomerRate('Kovalchick', '115');
    row(p, 'm-blank').haul_fee = '130';            // typed over since
    row(p, 'm-lower').qb_invoice = 'QB-7002';      // invoiced since
    p.setBackupFee('tst-5-row', '140');            // payroll row typed over since
    p.undoListChange();
    assert('a fee typed over the fill survives the undo', row(p, 'm-blank').haul_fee === '130');
    assert('a row invoiced since keeps the fee it was invoiced at', row(p, 'm-lower').haul_fee === '115');
    assert('a payroll row typed over keeps the office\'s fee', row(p, 'tst-5-row').haul_fee === 140);
    assert('the rest still empty', row(p, 'm-old').haul_fee === '' && row(p, 'm-space').haul_fee === '');
  }

  // ── 3. A mistyped rate, corrected while its bar is up ──────────────────
  console.log('\n[a mistyped rate]');
  {
    const lists = freshLists();
    lists.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists });
    p.updateCustomerRate('Kovalchick', '1155');
    assert('fills at the typo', row(p, 'm-blank').haul_fee === '1155' && row(p, 'tst-5-row').haul_fee === 1155);
    p.updateCustomerRate('Kovalchick', '115');
    assert('correcting it corrects the rows it just filled',
      row(p, 'm-blank').haul_fee === '115' && row(p, 'm-old').haul_fee === '115',
      JSON.stringify([row(p, 'm-blank').haul_fee, row(p, 'm-old').haul_fee]));
    assert('payroll row included', row(p, 'tst-5-row').haul_fee === 115 && row(p, 'tst-5-row').haul_fee_override === 115,
      JSON.stringify(row(p, 'tst-5-row')));
    assert('and the bar describes the corrected fill',
      p._listsUndo && p._listsUndo.rate === '115' && p._listsUndo.rows.length === 5, JSON.stringify(p._listsUndo));
    assert('a fee that was on the row before either is still untouched', row(p, 'm-priced').haul_fee === '120');

    p.updateCustomerRate('Kovalchick', '');
    assert('clearing the rate while its bar is up empties what it filled',
      row(p, 'm-blank').haul_fee === '' && row(p, 'tst-5-row').haul_fee === '', JSON.stringify(row(p, 'tst-5-row')));
    assert('and says so', /Emptied the 5 rows/.test(p._listsNote), p._listsNote);
    assert('leaving nothing to undo', p._listsUndo === null);
  }
  {
    // Once the bar is gone the fill is just the fee on the row, and a later
    // rate leaves it alone like any other.
    const lists = freshLists();
    lists.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists });
    p.updateCustomerRate('Kovalchick', '115');
    p._listsUndo = null;                           // the panel was closed and reopened
    p.updateCustomerRate('Kovalchick', '120');
    assert('a later rate does not restate a fee filled earlier', row(p, 'm-blank').haul_fee === '115');
    assert('nor a payroll row priced earlier', row(p, 'tst-5-row').haul_fee === 115);
  }
  {
    // Another customer's rate saved in between is not a correction of this one.
    const lists = freshLists();
    lists.customers = ['Kinkead', 'Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists });
    p.updateCustomerRate('Kovalchick', '115');
    p.updateCustomerRate('Kinkead', '121');
    assert('saving another customer\'s rate fills that customer', row(p, 'm-other').haul_fee === '121');
    assert('and leaves the first fill standing', row(p, 'm-blank').haul_fee === '115');
  }

  // ── 4. The other ways a rate is saved ──────────────────────────────────
  console.log('\n[every way a rate is saved]');
  {
    const lists = freshLists();
    lists.customers = ['Kinkead', 'Kovalchick', 'Force Omni'];
    lists.rates = { 'Force Omni': '130' };        // saved before any of this
    const entries = [
      { id: 'h1', customer: 'Kinkead',    haul_fee: '121', total_hours: '1', actual_date: `${YEAR}-01-02` },
      { id: 'h2', customer: 'Kinkead',    haul_fee: '',    total_hours: '1', actual_date: `${YEAR}-09-24` },
      { id: 'h3', customer: 'Kovalchick', haul_fee: '115', total_hours: '1', actual_date: `${YEAR}-01-02` },
      { id: 'h4', customer: 'Kovalchick', haul_fee: '',    total_hours: '1', actual_date: `${YEAR}-09-24` },
      { id: 'h5', customer: 'Force Omni', haul_fee: '',    total_hours: '1', actual_date: `${YEAR}-09-24` },
    ];
    const p = newPage({ entries, lists });
    p.fillRatesFromHistory();
    assert('Fill blank rates from past rows saves them', p.customerRate('Kinkead') === '121' && p.customerRate('Kovalchick') === '115');
    assert('and fills each into its customer\'s blank rows', row(p, 'h2').haul_fee === '121' && row(p, 'h4').haul_fee === '115');
    assert('the bar counts the rates it saved', p._listsUndo && p._listsUndo.fromHistory === 2, JSON.stringify(p._listsUndo));
    assert('a rate saved before is not re-saved, so its rows are not touched by it', row(p, 'h5').haul_fee === '');

    assert('the rows a saved rate is still owed are counted',
      JSON.stringify(p._customersAwaitingRate()) === JSON.stringify([{ name: 'Force Omni', rows: 1 }]),
      JSON.stringify(p._customersAwaitingRate()));
    p.fillFeesFromRates();
    assert('and Fill blank Haul Fees from saved rates reaches them', row(p, 'h5').haul_fee === '130');
    assert('with its own Undo', p._listsUndo && p._listsUndo.rows.length === 1 && p._listsUndo.rate === '130',
      JSON.stringify(p._listsUndo));
    assert('after which nothing is waiting', p._customersAwaitingRate().length === 0);
  }
  {
    // Adding with a rate, for a name already on the list.
    const lists = freshLists();
    lists.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists,
      inputs: { 'lists-new-customers': 'Kovalchick', 'lists-new-customers-rate': '115' } });
    p.addToList('customers');
    assert('a rate typed beside a name already listed fills its rows', row(p, 'm-blank').haul_fee === '115');
  }
  {
    // A name typed back in, with its rate.
    const lists = freshLists();
    lists.removed.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists,
      inputs: { 'lists-new-customers': 'Kovalchick', 'lists-new-customers-rate': '115' } });
    p.addToList('customers');
    assert('so does one added back with its rate',
      p.divTruckLists.customers.includes('Kovalchick') && row(p, 'm-blank').haul_fee === '115');
    assert('and the bar is the fill\'s', p._listsUndo && p._listsUndo.kind === 'ratefill');
  }
  {
    // "121/hr" survives the list's parseFloat, but it is not a price.
    const lists = freshLists();
    lists.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows(), lists });
    p.divTruckLists.rates = { Kovalchick: '121/hr' };
    p.fillFeesFromRates();
    p.updateCustomerRate('Kovalchick', '121/hour');
    assert('a rate that is not a price fills nothing', row(p, 'm-blank').haul_fee === '' && p._listsUndo === null);
  }
  {
    // Every blank row already invoiced: nothing to fill, and the panel says why.
    const lists = freshLists();
    lists.customers = ['Kovalchick'];
    const p = newPage({ entries: kovalchickRows().filter(e => /qb|invd|sent/.test(e.id)), lists });
    p.updateCustomerRate('Kovalchick', '115');
    assert('invoiced rows are not filled', p.divEntries.every(e => e.haul_fee === ''));
    assert('and the panel says they were left alone on purpose',
      /3 of Kovalchick's rows with no fee are already invoiced, so the rate was not filled into them/.test(p._listsNote),
      p._listsNote);
    assert('with nothing to undo', p._listsUndo === null);
    assert('and no table redraw for rows that did not move', p.tableDraws === 0, String(p.tableDraws));
  }

  // ── 5. What the panel says ─────────────────────────────────────────────
  console.log('\n[the panel]');
  {
    const lists = freshLists();
    lists.customers = ['Force Omni', 'Kovalchick'];
    lists.rates = { 'Force Omni': '130' };
    const entries = [
      { id: 'p1', customer: 'Kovalchick', haul_fee: '115', total_hours: '1', actual_date: `${YEAR}-01-02`, qb_invoice: 'QB-1' },
      { id: 'p2', customer: 'Kovalchick', haul_fee: '',    total_hours: '1', actual_date: `${YEAR}-09-24` },
      { id: 'p3', customer: 'Kovalchick', haul_fee: '',    total_hours: '1', actual_date: `${LAST}-03-01` },
      { id: 'p4', customer: 'Force Omni', haul_fee: '130', total_hours: '1', actual_date: `${YEAR}-01-02` },
    ];
    const clone = () => ({ entries: JSON.parse(JSON.stringify(entries)), lists: JSON.parse(JSON.stringify(lists)) });

    const { html } = renderPanel(clone());
    assert('a customer with no rate gets a "usually" chip beside its box',
      /<button class="li-usual"[^>]*>usually 115<\/button>/.test(html), (html.match(/li-usual[^<]*<[^>]*>[^<]*/) || ['none'])[0]);
    assert('its box is empty and says so',
      /Kovalchick[\s\S]{0,700}class="li-rate"[^>]*value="" placeholder="rate"/.test(html));
    assert('no box ever carries a number it has not saved', !/placeholder="\d/.test(html));
    assert('a saved rate is in its box, with no chip',
      /class="li-rate"[^>]*value="130"/.test(html) && (html.match(/class="li-usual"/g) || []).length === 1);
    assert('the hint says the chip is not a rate', /isn't a rate until you click it or type one/.test(html));
    assert('and what saving one does to the rows', /also fills it into that customer's rows that have no fee and aren't invoiced yet/.test(html));

    // The chip's click, run the way a browser would.
    const m = html.match(/<button class="li-usual" onclick="([^"]*)"/);
    let got = null;
    if (m) {
      const box = { updateCustomerRate: (n, v) => { got = [n, v]; } };
      vm.createContext(box);
      try { vm.runInContext(m[1].replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'), box); }
      catch (err) { got = ['threw', err.message]; }
    }
    assert('clicking it saves that figure as the rate',
      !!got && got[0] === 'Kovalchick' && got[1] === '115', JSON.stringify(got));

    const after = renderPanel(clone(), page => page.updateCustomerRate('Kovalchick', '115'));
    assert('after a save the bar says what was filled, at what rate',
      /Filled <strong>\$115\/hr<\/strong> into <strong>2 Kovalchick rows<\/strong> that had no fee and aren't invoiced yet/.test(after.html),
      (after.html.match(/class="lists-undo"[\s\S]{0,400}/) || ['no bar'])[0]);
    assert('and how far back it reached', new RegExp(`1 of them dated before ${YEAR}`).test(after.html));
    assert('and that Undo leaves the rate', /Undo empties them again; the rate stays\./.test(after.html));
    assert('with the Undo button', /class="lists-undo"[\s\S]*onclick="undoListChange\(\)"/.test(after.html));
    assert('and the chip is gone once the rate is saved', !/class="li-usual"/.test(after.html));

    const history = renderPanel(clone(), page => page.fillRatesFromHistory());
    assert('the batch fill is counted by rates and rows',
      /Saved 1 rate from past rows and filled it into <strong>2 Kovalchick rows<\/strong>/.test(history.html),
      (history.html.match(/class="lists-undo"[\s\S]{0,300}/) || ['no bar'])[0]);

    // The link for rows a rate saved earlier is still owed.
    const owed = clone();
    owed.entries.push({ id: 'p5', customer: 'Force Omni', haul_fee: '', total_hours: '1', actual_date: `${YEAR}-09-25` });
    const withOwed = renderPanel(owed);
    assert('rows a saved rate is owed get a one-click fill',
      /onclick="fillFeesFromRates\(\)"[^>]*>\s*Fill 1 blank Haul Fee from saved rates/.test(withOwed.html),
      (withOwed.html.match(/fillFeesFromRates[\s\S]{0,200}/) || ['none'])[0]);
    assert('naming whose they are', /title="Force Omni: 1 — fills each customer's saved rate/.test(withOwed.html));
    assert('and it is not offered when nothing is owed', !/fillFeesFromRates/.test(html));
    const multi = renderPanel(owed, page => page.fillFeesFromRates());
    assert('its bar names the customer when there is one',
      /Filled <strong>\$130\/hr<\/strong> into <strong>1 Force Omni row<\/strong> that had no fee and isn't invoiced yet\./.test(multi.html),
      (multi.html.match(/class="lists-undo"[\s\S]{0,300}/) || ['no bar'])[0]);
  }
  {
    // Two customers at once: counted, not named, and "rates" plural.
    const lists = freshLists();
    lists.customers = ['Force Omni', 'Kinkead'];
    lists.rates = { 'Force Omni': '130', Kinkead: '121' };
    const entries = [
      { id: 'a', customer: 'Force Omni', haul_fee: '', total_hours: '1', actual_date: `${YEAR}-09-24` },
      { id: 'b', customer: 'Kinkead',    haul_fee: '', total_hours: '1', actual_date: `${YEAR}-09-24` },
    ];
    const { html } = renderPanel({ entries, lists }, page => page.fillFeesFromRates());
    assert('a fill across customers says so, and that the rates stay',
      /Filled each customer's saved rate into <strong>2 rows<\/strong>[\s\S]*the rates stay\./.test(html),
      (html.match(/class="lists-undo"[\s\S]{0,300}/) || ['no bar'])[0]);
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
