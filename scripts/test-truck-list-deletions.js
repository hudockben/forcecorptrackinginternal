#!/usr/bin/env node
'use strict';
/**
 * The Truck Tracking managed lists: deleting a name, merging two spellings of
 * one, and the rate a customer carries.
 *
 * Run: node scripts/test-truck-list-deletions.js
 *
 * The drivers, customers and units lists are two things at once: what the
 * office typed into them, and whatever the loader swept up out of the stored
 * rows. The sweep is why a deleted name used to come straight back — every
 * historical row still names its customer, so the next load re-seeded it, and
 * the office deleted the same company over and over. A roster of deletions now
 * rides in the same blob as the lists, and the sweep honours it.
 *
 * Deleting a name is a picker change, never a data change: the rows that carry
 * it keep their value and still read, invoice and total exactly as before.
 *
 * Two layers, following test-truck-unit-roster.js:
 *   1. Behavioural — runs trucking.html's own list functions in a vm and
 *      re-runs the loader's sweep over them, which is the round trip the bug
 *      lived in.
 *   2. Server — the GET falls back to the normalized tables when the blob is
 *      empty, and those tables hold no record of a deletion or a rate, so it
 *      has to carry both over rather than answer with the deletions undone.
 *
 * The rate is a fact about the company and the row is what was actually
 * billed, so it only ever fills a blank Haul Fee. The cases below hold that
 * line: a row that already has a fee is never restated by a later rate change.
 *
 * Merging is the other operation, and the only one that rewrites stored rows.
 * The lines it must not cross are all here: a payroll-injected row is left to
 * payroll and counted out loud, a third spelling is not swept along, the
 * scheduler board is not written unless it was really loaded, and every part
 * of it comes back on Undo.
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
function slice(src, from, to, label) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(`could not extract ${label} (marker moved: ${a < 0 ? from : to})`);
  return src.slice(a, b);
}

const TRUCKING = read('trucking.html');

// ── 1. Behavioural ─────────────────────────────────────────────────────────
// Two contiguous regions of the page: the deleted-name helpers plus the
// loader's sweep, and the panel's add/remove/restore handlers.
const HELPERS = slice(TRUCKING, '    const _remKey =', '    function saveTruckLists()', 'list helpers + sweep');
const PANEL   = slice(TRUCKING, '    function addToList(key)', '    function schedSave()', 'panel handlers');
const ROWEDIT = slice(TRUCKING, '    /** Re-total a row and keep', '\n    /* \u2550', 'updateField');
// The panel's own markup, for the render smoke test below. Starts a little
// earlier than PANEL so renderListsPanel and what it calls come along.
const RENDER  = slice(TRUCKING, '    function driverLoginsHTML(esc)', '    function schedSave()', 'panel render');

function newPage(state) {
  const sandbox = {
    console,
    divEntries: state.entries || [],
    divTruckLists: state.lists,
    icBillingArr: [],
    _divEntriesLoaded: true,
    saves: 0,
    // The sweep normalises CSV-shaped values on its way past; none of these
    // cases turn on that, so they pass through untouched.
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
    tdDivPut() { sandbox.saves++; },
    saveTruckLists() { sandbox.saves++; },
    renderListsPanel() {}, renderTrackingTab() {}, renderScheduler() {},
    schedIsActive: () => false, schedSave() {}, calcHours: () => null,
    icSentMap: new Map(),
    // A merge reaches past the lists: payroll owns some rows, a sign-in points
    // at a driver by name, and the board names the same people and companies.
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    driverLoginMap: state.logins || {}, loginSaves: 0,
    saveDriverLogins() { sandbox.loginSaves++; },
    schedAssignments: state.sched || {},
    _schedLoaded: !!state.schedLoaded, schedDirty: 0,
    schedMarkDirty() { sandbox.schedDirty++; },
    schedEnsureLoaded: () => Promise.resolve(),
    // Panel view state, declared with the panel rather than with the lists.
    _listsUndo: null, _listsShowRemoved: new Set(), _listsMerge: null,
    // The panel reads its input boxes and updateField writes the row's cells
    // back; neither is what these cases are about, so there is no DOM here.
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + PANEL + '\n' + ROWEDIT, sandbox, { filename: 'trucking.html' });
  return sandbox;
}

/** Render the Manage Lists panel against a mock document and hand back the
 *  HTML it wrote. Its own sandbox: the panel declares its view state, and
 *  seeding that from outside would shadow the declaration. */
function renderPanel(state, drive) {
  let html = '';
  const body = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const sandbox = {
    console,
    divEntries: state.entries || [],
    divTruckLists: state.lists,
    divLists: { employees: [], equipment: [] },
    icBillingArr: [], icSentMap: new Map(),
    driverLoginMap: {}, driverLoginUsers: [], _driverLoginsLoaded: true,
    loadDriverLogins: () => Promise.resolve(),
    renderTrackingTab() {}, renderScheduler() {}, schedIsActive: () => false,
    schedSave() {}, calcHours: () => null, tdDivPut() {}, saveTruckLists() {},
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    document: {
      getElementById: id => (id === 'lists-panel-body' ? body
        : id in (state.inputs || {}) ? { value: state.inputs[id] } : null),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + RENDER + '\n' + ROWEDIT, sandbox, { filename: 'trucking.html' });
  if (drive) drive(sandbox);
  sandbox.renderListsPanel();
  return { html, page: sandbox };
}

const ROWS = [
  { id: 'a', driver: 'Leasure, Rick',    unit: '7687', customer: 'Kovalchick' },
  { id: 'b', driver: 'Cribbs, Jonathan', unit: '2767', customer: 'Kinkead'    },
  { id: 'c', driver: 'Barr, Michael',    unit: '7687', customer: 'kovalchick' },
];
const freshLists = () => ({
  drivers: [], customers: [], units: [], locations: [], materials: [],
  removed: { drivers: [], customers: [], units: [], materials: [] },
});
// Cases run in one async pass: a merge reaches the scheduler blob, so
// mergeIntoName is async and the cases around it read in order.
(async () => {
  console.log('\n[the bug: a deleted customer, and the next load]');
  {
    const p = newPage({ entries: ROWS.map(r => ({ ...r })), lists: freshLists() });

    // First load seeds the lists off the stored rows, the way it always has.
    p._migrateExistingEntries();
    assert('the loader still seeds customers from the rows',
      p.divTruckLists.customers.includes('Kovalchick'), JSON.stringify(p.divTruckLists.customers));

    // The office deletes one.
    p.removeFromList('customers', 'Kovalchick');
    assert('deleting drops it from the list',
      !p.divTruckLists.customers.includes('Kovalchick'), JSON.stringify(p.divTruckLists.customers));
    assert('and records the deletion',
      (p.divTruckLists.removed.customers || []).includes('Kovalchick'),
      JSON.stringify(p.divTruckLists.removed));

    // This is the whole bug: the rows still name it, so the next load swept it
    // back in and the office deleted the same company again the next morning.
    p._migrateExistingEntries();
    assert('and the next load leaves it deleted',
      !p.divTruckLists.customers.includes('Kovalchick'), JSON.stringify(p.divTruckLists.customers));

    // A row's own value is not a list entry — the haul still bills to whoever it
    // billed to before, and the cell still shows the name.
    assert('the rows that name it are untouched',
      p.divEntries.filter(e => e.customer === 'Kovalchick').length === 1,
      JSON.stringify(p.divEntries.map(e => e.customer)));

    // The list this company keeps holds several spellings of the same company —
    // "kovalchick" and "Kovalchick" both reached it by being typed onto a row —
    // and deleting the duplicate has to leave the one being kept alone.
    assert('a differently-cased spelling is its own entry and survives',
      p.divTruckLists.customers.includes('kovalchick'), JSON.stringify(p.divTruckLists.customers));
    p.removeFromList('customers', 'kovalchick');
    p._migrateExistingEntries();
    assert('and deletes on its own terms',
      !p.divTruckLists.customers.some(c => c.toLowerCase() === 'kovalchick'),
      JSON.stringify(p.divTruckLists.customers));
  }

  console.log('\n[a name with a stray space]');
  {
    // Two entries that render identically in the panel. Deleting the one you can
    // see has to take the one you cannot, or the name looks like it came back.
    const p = newPage({
      entries: [{ id: 'a', customer: 'Kinkead ' }, { id: 'b', customer: 'Kinkead' }],
      lists: freshLists(),
    });
    p._migrateExistingEntries();
    p.removeFromList('customers', 'Kinkead');
    p._migrateExistingEntries();
    assert('both spellings go',
      p.divTruckLists.customers.length === 0, JSON.stringify(p.divTruckLists.customers));
  }

  console.log('\n[drivers and units delete the same way]');
  {
    const p = newPage({ entries: ROWS.map(r => ({ ...r })), lists: freshLists() });
    p._migrateExistingEntries();

    p.removeFromList('drivers', 'Leasure, Rick');
    p.removeUnit('7687');
    p._migrateExistingEntries();

    assert('a deleted driver stays deleted',
      !p.divTruckLists.drivers.includes('Leasure, Rick'), JSON.stringify(p.divTruckLists.drivers));
    assert('a deleted unit stays deleted',
      !p.divTruckLists.units.some(u => u.name === '7687'),
      JSON.stringify(p.divTruckLists.units));
    assert('the drivers still on the rows are still offered',
      p.divTruckLists.drivers.includes('Cribbs, Jonathan'), JSON.stringify(p.divTruckLists.drivers));
  }

  console.log('\n[a unit keeps its number through all of this]');
  {
    // Every other list holds a bare name. A unit is a name and the number the
    // office reads beside it on every row, and Put back handing over half a
    // unit is a silent blank on 40 rows.
    const lists = freshLists();
    lists.units = [{ name: '7687', number: '21' }, { name: '2767', number: '13' }];
    const p = newPage({ entries: [{ id: 'a', unit: '7687' }], lists });

    p.removeUnit('7687');
    p.undoListChange();
    assert('undo gives the number back with the name',
      (p.divTruckLists.units.find(u => u.name === '7687') || {}).number === '21',
      JSON.stringify(p.divTruckLists.units));

    // And the same from the removed strip, days later, where the undo bar is
    // long gone — the number rides with the removal, not with the undo.
    p.removeUnit('7687');
    p._listsUndo = null;
    p.restoreToList('units', '7687');
    assert('and so does Put back, long after the fact',
      (p.divTruckLists.units.find(u => u.name === '7687') || {}).number === '21',
      JSON.stringify(p.divTruckLists.units));

    await p.mergeIntoName('units', '7687', '2767');
    assert('a merged unit is renamed on its rows', p.divEntries[0].unit === '2767');
    p.undoListChange();
    assert('and undoing that merge restores the number too',
      (p.divTruckLists.units.find(u => u.name === '7687') || {}).number === '21',
      JSON.stringify(p.divTruckLists.units));
  }

  console.log('\n[putting one back]');
  {
    const p = newPage({ entries: ROWS.map(r => ({ ...r })), lists: freshLists() });
    p._migrateExistingEntries();
    p.removeFromList('customers', 'Kinkead');

    p.restoreToList('customers', 'Kinkead');
    assert('restore puts the name back on the list',
      p.divTruckLists.customers.includes('Kinkead'), JSON.stringify(p.divTruckLists.customers));
    assert('and clears the record of the deletion',
      !(p.divTruckLists.removed.customers || []).some(v => v.toLowerCase() === 'kinkead'),
      JSON.stringify(p.divTruckLists.removed));
    p._migrateExistingEntries();
    assert('so the next load keeps it',
      p.divTruckLists.customers.includes('Kinkead'), JSON.stringify(p.divTruckLists.customers));

    // Typing the name back into the Add box is the other way back, and the one
    // an office reaches for first.
    p.removeFromList('customers', 'Kinkead');
    p.document.getElementById = id => (id === 'lists-new-customers' ? { value: 'Kinkead' } : null);
    p.addToList('customers');
    p._migrateExistingEntries();
    assert('re-adding a deleted name also brings it back',
      p.divTruckLists.customers.includes('Kinkead'), JSON.stringify(p.divTruckLists.customers));
  }

  console.log('\n[a name another tab pushed back]');
  {
    // A second dispatcher's tab saves a copy of the lists it read before the
    // deletion, or a stale poll hands one back. Converging on the deletion is
    // what keeps the office from deleting the same company twice.
    const lists = freshLists();
    lists.customers = ['Kinkead', 'Kovalchick', 'kovalchick'];
    lists.removed.customers = ['Kovalchick'];
    const p = newPage({ entries: ROWS.map(r => ({ ...r })), lists });
    p._migrateExistingEntries();
    assert('the deletion wins over the stale copy',
      !p.divTruckLists.customers.includes('Kovalchick'), JSON.stringify(p.divTruckLists.customers));
    assert('and takes only the spelling that was deleted',
      p.divTruckLists.customers.includes('kovalchick'), JSON.stringify(p.divTruckLists.customers));
    assert('and the correction is saved rather than left in memory', p.saves > 0, String(p.saves));
  }

  console.log('\n[a settled list saves nothing]');
  {
    // Every load sweeps the rows into the lists, and a load that changes
    // something saves. A deleted name that got swept in and pruned back out
    // would count as a change twice over — so the tab would PUT the whole
    // division blob on every single open, for nothing.
    const lists = freshLists();
    lists.drivers   = ['Barr, Michael', 'Cribbs, Jonathan', 'Leasure, Rick'];
    lists.customers = ['Kinkead', 'kovalchick'];
    lists.units     = [{ name: '2767', number: '' }, { name: '7687', number: '' }];
    lists.removed.customers = ['Kovalchick'];
    const p = newPage({ entries: ROWS.map(r => ({ ...r })), lists });
    p._migrateExistingEntries();
    assert('nothing was swept back in',
      !p.divTruckLists.customers.includes('Kovalchick'), JSON.stringify(p.divTruckLists.customers));
    assert('and the load saves nothing', p.saves === 0, String(p.saves));
  }

  console.log('\n[a CSV import]');
  {
    const p = newPage({ entries: [], lists: freshLists() });
    p.divTruckLists.removed.customers = ['Kovalchick'];
    // Imports seed the lists from the incoming rows on the same terms the loader
    // does, so they are the other door a deleted name could walk back through.
    assert('the import path honours the deletions too',
      /const add = \(key, arr, val\) =>[\s\S]{0,160}_isRemovedName\(key, val\)/.test(TRUCKING));
  }

  console.log('\n[the rate on a customer]');
  {
    const p = newPage({ entries: [], lists: freshLists() });
    p.divTruckLists.customers = ['Kinkead', 'Kovalchick'];
    p.setCustomerRate('Kinkead', '121');

    // A new row: name the customer, and the fee it bills at is already there.
    p.divEntries.push({ id: 'r1', customer: '', haul_fee: '', total_hours: '8' });
    p.updateField('r1', 'customer', 'Kinkead');
    assert('naming a customer fills a blank Haul Fee',
      p.divEntries[0].haul_fee === '121', JSON.stringify(p.divEntries[0]));

    // A row priced deliberately — a one-off, a negotiated haul, an invoice
    // already sent. Restating it from a list would be the worst thing here.
    p.divEntries.push({ id: 'r2', customer: '', haul_fee: '95', total_hours: '4' });
    p.updateField('r2', 'customer', 'Kinkead');
    assert('a fee already on the row is left alone',
      p.divEntries[1].haul_fee === '95', JSON.stringify(p.divEntries[1]));

    // A customer with no rate must not blank out what the row already had.
    p.divEntries.push({ id: 'r3', customer: '', haul_fee: '88', total_hours: '2' });
    p.updateField('r3', 'customer', 'Kovalchick');
    assert('a customer with no rate changes nothing',
      p.divEntries[2].haul_fee === '88', JSON.stringify(p.divEntries[2]));

    // The rate is read the same way the list is: one company, one rate,
    // whichever spelling of it is stored.
    assert('the rate reads back under a differently-cased spelling',
      p.customerRate('kinkead') === '121', p.customerRate('kinkead'));
    p.setCustomerRate('KINKEAD', '130');
    assert('and setting it again does not fork into a second entry',
      Object.keys(p.divTruckLists.rates).length === 1, JSON.stringify(p.divTruckLists.rates));
    assert('it just updates the one that is there',
      p.customerRate('Kinkead') === '130', JSON.stringify(p.divTruckLists.rates));

    // Clearing the box clears the rate rather than storing a blank.
    p.updateCustomerRate('Kinkead', '');
    assert('clearing the box drops the rate',
      p.customerRate('Kinkead') === '', JSON.stringify(p.divTruckLists.rates));
    p.updateCustomerRate('Kinkead', 'abc');
    assert('and nonsense in the box is not stored as a rate',
      p.customerRate('Kinkead') === '', JSON.stringify(p.divTruckLists.rates));
  }

  console.log('\n[a rate read off the rows that already exist]');
  {
    // 1,944 rows already say what each company is billed. Reading that by eye to
    // fill the rates in is the work this saves.
    const p = newPage({
      entries: [
        { id: '1', customer: 'Kinkead',    haul_fee: '121' },
        { id: '2', customer: 'Kinkead',    haul_fee: '121' },
        { id: '3', customer: 'Kinkead',    haul_fee: '115' },
        { id: '4', customer: 'kinkead',    haul_fee: '121' },
        { id: '5', customer: 'Kovalchick', haul_fee: '115' },
        { id: '6', customer: 'Force',      haul_fee: ''    },
      ],
      lists: freshLists(),
    });
    p._migrateExistingEntries();
    assert('the usual fee is what most of the rows bill at',
      p._historicRate('Kinkead') === '121', p._historicRate('Kinkead'));
    assert('every spelling of the company counts toward it',
      p._historicRate('kinkead') === '121', p._historicRate('kinkead'));
    assert('a customer whose rows carry no fee suggests nothing',
      p._historicRate('Force') === '', p._historicRate('Force'));

    p.setCustomerRate('Kovalchick', '150');   // set by hand, and not to be touched
    p.fillRatesFromHistory();
    assert('blank rates fill in from the rows',
      p.customerRate('Kinkead') === '121', JSON.stringify(p.divTruckLists.rates));
    assert('and a rate someone set by hand survives it',
      p.customerRate('Kovalchick') === '150', JSON.stringify(p.divTruckLists.rates));
    assert('a customer with nothing to go on stays blank',
      p.customerRate('Force') === '', JSON.stringify(p.divTruckLists.rates));
  }

  console.log('\n[merging two spellings of one company]');
  {
    // Removing "kovalchick" tidies the picker but leaves 4 rows saying it, so
    // Analytics still bills one company as two. Merging is what joins them.
    const lists = freshLists();
    lists.customers = ['Kinkead', 'Kovalchick', 'kovalchick'];
    lists.rates = { kovalchick: '115' };
    const p = newPage({
      entries: [
        { id: 'a', customer: 'Kovalchick', haul_fee: '115' },
        { id: 'b', customer: 'kovalchick', haul_fee: '115' },
        { id: 'c', customer: 'kovalchick', haul_fee: '115' },
        { id: 'd', customer: 'Kinkead',    haul_fee: '121' },
        // Payroll's: its customer came off an approved timesheet, and the server
        // refuses this tab's writes to it.
        { id: 'tst-99-1', customer: 'kovalchick', haul_fee: '115' },
      ],
      lists,
    });

    await p.mergeIntoName('customers', 'kovalchick', 'Kovalchick');

    assert('the rows it owns are renamed',
      p.divEntries.filter(e => e.customer === 'Kovalchick').length === 3,
      JSON.stringify(p.divEntries.map(e => e.customer)));
    assert('a payroll row is left exactly as payroll wrote it',
      p.divEntries.find(e => e.id === 'tst-99-1').customer === 'kovalchick',
      JSON.stringify(p.divEntries.find(e => e.id === 'tst-99-1')));
    assert('and the merge says so rather than skipping it quietly',
      p._listsUndo.locked === 1, JSON.stringify(p._listsUndo));
    assert('a different company is not swept along',
      p.divEntries.find(e => e.id === 'd').customer === 'Kinkead');
    assert('the merged spelling leaves the picker',
      !p.divTruckLists.customers.includes('kovalchick'), JSON.stringify(p.divTruckLists.customers));
    // Two spellings of one company already share a rate — that is what makes
    // rates company-level rather than per-entry — so there is nothing to move.
    assert('the rate reads the same from either spelling all along',
      p.customerRate('Kovalchick') === '115', JSON.stringify(p.divTruckLists.rates));

    // The payroll row still names the old spelling, so without the deletion on
    // record the sweep would put it straight back and undo the merge by half.
    p._migrateExistingEntries();
    assert('and the next load does not bring it back',
      !p.divTruckLists.customers.includes('kovalchick'), JSON.stringify(p.divTruckLists.customers));
  }

  console.log('\n[which name a merge suggests]');
  {
    const p = newPage({
      entries: [
        { id: 'a', customer: 'Kovalchick' }, { id: 'b', customer: 'Kovalchick' },
        { id: 'c', customer: 'KOVALCHICK' }, { id: 'd', customer: 'kovalchick' },
      ],
      lists: (() => {
        const l = freshLists();
        l.customers = ['Kinkead', 'KOVALCHICK', 'Kovalchick', 'kovalchick'];
        return l;
      })(),
    });
    const others = ['Kinkead', 'KOVALCHICK', 'Kovalchick'];
    assert('it suggests the spelling the rows actually use',
      p._mergeSuggestion('customers', 'kovalchick', others) === 'Kovalchick',
      p._mergeSuggestion('customers', 'kovalchick', others));
    assert('punctuation and spacing do not hide a match',
      p._mergeSuggestion('customers', 'kovalchick.', others) === 'Kovalchick');
    assert('and a name that is nobody else\'s spelling suggests nothing',
      p._mergeSuggestion('customers', 'Force', others) === '',
      p._mergeSuggestion('customers', 'Force', others));
  }

  console.log('\n[a merge is undoable]');
  {
    const lists = freshLists();
    lists.customers = ['Kovalchick', 'kovalchick'];
    lists.rates = { kovalchick: '115' };
    const p = newPage({
      entries: [
        { id: 'a', customer: 'Kovalchick' },
        { id: 'b', customer: 'kovalchick' },
        { id: 'c', customer: 'Kinkead' },
      ],
      lists,
    });
    await p.mergeIntoName('customers', 'kovalchick', 'Kovalchick');
    assert('the bar offers the merge back',
      p._listsUndo && p._listsUndo.kind === 'merge', JSON.stringify(p._listsUndo));

    p.undoListChange();
    assert('undo puts the old spelling back on its rows',
      p.divEntries.find(e => e.id === 'b').customer === 'kovalchick',
      JSON.stringify(p.divEntries.map(e => e.customer)));
    assert('and only on the rows the merge changed',
      p.divEntries.find(e => e.id === 'a').customer === 'Kovalchick' &&
      p.divEntries.find(e => e.id === 'c').customer === 'Kinkead',
      JSON.stringify(p.divEntries.map(e => e.customer)));
    assert('the name is back on the picker',
      p.divTruckLists.customers.includes('kovalchick'), JSON.stringify(p.divTruckLists.customers));
    p._migrateExistingEntries();
    assert('which the next load respects',
      p.divTruckLists.customers.includes('kovalchick'), JSON.stringify(p.divTruckLists.customers));
  }

  console.log('\n[the rate, when the two names really differ]');
  {
    // "Kinkead Aggregates." and "Kinkead" are the same company under two names
    // rather than two spellings, so each has its own rate to reconcile.
    const lists = freshLists();
    lists.customers = ['Kinkead', 'Kinkead Aggregates.'];
    lists.rates = { 'Kinkead Aggregates.': '130' };
    const p = newPage({ entries: [{ id: 'a', customer: 'Kinkead Aggregates.' }], lists });
    await p.mergeIntoName('customers', 'Kinkead Aggregates.', 'Kinkead');
    assert('the rate follows the company when the survivor had none',
      p.customerRate('Kinkead') === '130', JSON.stringify(p.divTruckLists.rates));
    p.undoListChange();
    assert('and undo takes it back off again',
      p.customerRate('Kinkead') === '', JSON.stringify(p.divTruckLists.rates));
    assert('leaving it where it came from',
      p.customerRate('Kinkead Aggregates.') === '130', JSON.stringify(p.divTruckLists.rates));
  }

  console.log('\n[a rate the survivor already had]');
  {
    const lists = freshLists();
    lists.customers = ['Kinkead', 'Kinkead Aggregates.'];
    lists.rates = { Kinkead: '121', 'Kinkead Aggregates.': '130' };
    const p = newPage({ entries: [{ id: 'a', customer: 'Kinkead Aggregates.' }], lists });
    await p.mergeIntoName('customers', 'Kinkead Aggregates.', 'Kinkead');
    assert('is the one that survives — it is the rate the office chose to keep',
      p.customerRate('Kinkead') === '121', JSON.stringify(p.divTruckLists.rates));
    p.undoListChange();
    assert('and undo does not clear it',
      p.customerRate('Kinkead') === '121', JSON.stringify(p.divTruckLists.rates));
  }

  console.log('\n[merging a driver, and what points at one]');
  {
    const p = newPage({
      entries: [
        { id: 'a', driver: 'barrmike', unit: '7687' },
        { id: 'b', driver: 'Barr, Michael', unit: '7687' },
        { id: 'tst-1-1', driver: 'barrmike', unit: '7687' },
      ],
      lists: (() => { const l = freshLists(); l.drivers = ['Barr, Michael', 'barrmike']; return l; })(),
      logins: { barrmike: 'barrmike', jsmith: 'Smith, John' },
      sched: { '2026-08-20': [
        { id: 's1', driver: 'barrmike', customer: 'Kinkead' },
        { id: 's2', driver: 'Smith, John' },
      ] },
      schedLoaded: true,
    });

    await p.mergeIntoName('drivers', 'barrmike', 'Barr, Michael');
    assert('the rows it owns take the real name',
      p.divEntries.find(e => e.id === 'a').driver === 'Barr, Michael');
    // A sign-in points at a driver BY NAME. Left behind, the phone matches
    // nothing and that driver opens the app to an empty board.
    assert("the driver's sign-in follows the name",
      p.driverLoginMap.barrmike === 'Barr, Michael', JSON.stringify(p.driverLoginMap));
    assert('and is saved, not just changed in memory', p.loginSaves > 0, String(p.loginSaves));
    assert('someone else\'s link is untouched', p.driverLoginMap.jsmith === 'Smith, John');
    assert('the board is renamed too',
      p.schedAssignments['2026-08-20'][0].driver === 'Barr, Michael',
      JSON.stringify(p.schedAssignments));
    assert('and marked for saving', p.schedDirty > 0, String(p.schedDirty));
    assert('another dispatcher\'s assignment is left alone',
      p.schedAssignments['2026-08-20'][1].driver === 'Smith, John');

    p.undoListChange();
    assert('undo gives the sign-in back', p.driverLoginMap.barrmike === 'barrmike',
      JSON.stringify(p.driverLoginMap));
    assert('and the board with it',
      p.schedAssignments['2026-08-20'][0].driver === 'barrmike', JSON.stringify(p.schedAssignments));
  }

  console.log('\n[a board that was never loaded]');
  {
    // schedAssignments is empty until the Scheduler tab has read it. Renaming
    // that empty object and marking it dirty is how a merge could cost a
    // dispatcher their week, so it is left alone unless it is really loaded.
    const p = newPage({
      entries: [{ id: 'a', customer: 'kovalchick' }],
      lists: (() => { const l = freshLists(); l.customers = ['Kovalchick', 'kovalchick']; return l; })(),
      // Assignments in hand but the load not finished: whatever is in there is
      // not the board, and writing it back is what would cost the week.
      sched: { '2026-08-20': [{ id: 's1', customer: 'kovalchick' }] },
      schedLoaded: false,
    });
    await p.mergeIntoName('customers', 'kovalchick', 'Kovalchick');
    assert('the rows still merge', p.divEntries[0].customer === 'Kovalchick');
    assert('the board is left exactly as it was',
      p.schedAssignments['2026-08-20'][0].customer === 'kovalchick', JSON.stringify(p.schedAssignments));
    assert('and nothing is written to it', p.schedDirty === 0, String(p.schedDirty));
  }

  console.log('\n[what a merge refuses]');
  {
    const lists = freshLists();
    lists.customers = ['Kinkead'];
    const p = newPage({ entries: [{ id: 'a', customer: 'Kinkead' }], lists });
    await p.mergeIntoName('customers', 'Kinkead', 'Kinkead');
    assert('merging a name into itself does nothing',
      p.divTruckLists.customers.includes('Kinkead') && p._listsUndo === null,
      JSON.stringify(p.divTruckLists.customers));
    await p.mergeIntoName('customers', 'Kinkead', '');
    assert('and neither does merging into nothing',
      p.divTruckLists.customers.includes('Kinkead') && p._listsUndo === null);
    await p.mergeIntoName('materials', '2b stone', 'R4');
    assert('a list whose names are not on the rows cannot be merged',
      p._listsUndo === null, JSON.stringify(p._listsUndo));
  }

  console.log('\n[the count beside a name]');
  {
    // The count is what makes a deletion a decision rather than a guess, and it
    // counts THIS spelling — the whole reason to look is to see which of
    // "kinkead" and "Kinkead" the rows actually use before deleting one.
    const p = newPage({
      entries: [
        { id: '1', customer: 'Kinkead' }, { id: '2', customer: 'Kinkead' },
        { id: '3', customer: 'kinkead' }, { id: '4', driver: 'Barr, Michael', unit: '7687' },
      ],
      lists: freshLists(),
    });
    assert('a name is counted under its own spelling',
      p._countRowsNaming('customers', 'Kinkead') === 2, String(p._countRowsNaming('customers', 'Kinkead')));
    assert('and the duplicate carries its own, smaller count',
      p._countRowsNaming('customers', 'kinkead') === 1, String(p._countRowsNaming('customers', 'kinkead')));
    assert('drivers and units are counted the same way',
      p._countRowsNaming('drivers', 'Barr, Michael') === 1 && p._countRowsNaming('units', '7687') === 1);
    assert('a name no row uses counts zero — nothing depends on it',
      p._countRowsNaming('customers', 'Force') === 0);
  }

  console.log('\n[adding a customer and its rate in one go]');
  {
    const p = newPage({ entries: [], lists: freshLists() });
    p.document.getElementById = id =>
      id === 'lists-new-customers'      ? { value: 'Marsh Contracting' } :
      id === 'lists-new-customers-rate' ? { value: '135' } : null;
    p.addToList('customers');
    assert('the name lands on the list',
      p.divTruckLists.customers.includes('Marsh Contracting'), JSON.stringify(p.divTruckLists.customers));
    assert('and the rate lands with it',
      p.customerRate('Marsh Contracting') === '135', JSON.stringify(p.divTruckLists.rates));
  }

  console.log('\n[undo, where the click was]');
  {
    const p = newPage({ entries: ROWS.map(r => ({ ...r })), lists: freshLists() });
    p._migrateExistingEntries();
    p.setCustomerRate('Kinkead', '121');

    p.removeFromList('customers', 'Kinkead');
    assert('a removal offers itself back',
      !!p._listsUndo && p._listsUndo.value === 'Kinkead', JSON.stringify(p._listsUndo));
    assert('and says how many rows still name it — none of which change',
      p._listsUndo.uses === 1, JSON.stringify(p._listsUndo));

    p.undoListChange();
    assert('undo puts it back on the list',
      p.divTruckLists.customers.includes('Kinkead'), JSON.stringify(p.divTruckLists.customers));
    assert('and clears the bar',  p._listsUndo === null, JSON.stringify(p._listsUndo));
    p._migrateExistingEntries();
    assert('and the next load keeps it', p.divTruckLists.customers.includes('Kinkead'),
      JSON.stringify(p.divTruckLists.customers));
    assert('the rate came back with the name', p.customerRate('Kinkead') === '121',
      JSON.stringify(p.divTruckLists.rates));

    // Removing a unit is the same gesture and gets the same bar.
    p.removeUnit('7687');
    assert('removing a unit offers itself back too',
      !!p._listsUndo && p._listsUndo.key === 'units', JSON.stringify(p._listsUndo));
    p.undoListChange();
    assert('and undo restores the unit',
      p.divTruckLists.units.some(u => u.name === '7687'), JSON.stringify(p.divTruckLists.units));
  }

  console.log('\n[the panel as it actually renders]');
  {
    const lists = freshLists();
    lists.customers = ['Kinkead', "Kinkead's Yard", 'Kovalchick'];
    lists.drivers   = ['Barr, Michael'];
    lists.rates     = { Kinkead: '121' };
    const entries = [
      { id: '1', customer: 'Kinkead', driver: 'Barr, Michael', unit: '7687', haul_fee: '121' },
      { id: '2', customer: 'Kinkead', driver: 'Barr, Michael', unit: '7687', haul_fee: '121' },
      { id: '3', customer: 'Kovalchick', haul_fee: '115' },
    ];

    const { html } = renderPanel({ entries, lists });
    assert('the customers section carries the rates', /Customers &amp; Rates/.test(html));
    assert('a stored rate shows in its box', /class="li-rate"[^>]*value="121"/.test(html), );
    assert('a customer with no rate offers the one its rows bill at',
      /placeholder="115"/.test(html), html.slice(html.indexOf('Kovalchick') - 300, html.indexOf('Kovalchick') + 300));
    assert('each name says how many rows use it', /class="li-count"[^>]*>2</.test(html));
    assert('and the blank rates can be filled from those rows in one click',
      /fillRatesFromHistory\(\)/.test(html));
    assert('nothing is in the removed strip yet', !/removed customers/.test(html));

    // A name with an apostrophe: the case that used to render a delete button
    // which did nothing at all when clicked. Run the attribute the way a browser
    // would rather than eyeball it — the bug was that it did not parse.
    {
      const m = html.match(/onclick="(removeFromList\([^"]*Yard[^"]*\))"/);
      assert('the apostrophe name still gets a delete call', !!m,
        (html.match(/[^"]*Yard[^"]*/) || ['not found'])[0]);
      if (m) {
        const call = m[1].replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
        let got = null;
        const box = { removeFromList: (k, v) => { got = [k, v]; } };
        vm.createContext(box);
        let threw = null;
        try { vm.runInContext(call, box); } catch (err) { threw = err.message; }
        assert('and the call parses and runs', threw === null, threw);
        assert('with the name intact',
          !!got && got[0] === 'customers' && got[1] === "Kinkead's Yard", JSON.stringify(got));
      }
    }

    // And the same panel after a removal.
    const after = renderPanel({ entries, lists: JSON.parse(JSON.stringify(lists)) },
      page => page.removeFromList('customers', 'Kovalchick'));
    assert('the removal puts up an undo bar', /class="lists-undo"/.test(after.html));
    assert('naming what went and what did not change',
      /Removed <strong>Kovalchick<\/strong>/.test(after.html) && /still total the same/.test(after.html));
    assert('and the section keeps a folded way back',
      /1 removed customers/.test(after.html) && !/>Put back</.test(after.html),
      (after.html.match(/removed customers[\s\S]{0,80}/) || [''])[0]);

    const opened = renderPanel({ entries, lists: JSON.parse(JSON.stringify(lists)) }, page => {
      page.removeFromList('customers', 'Kovalchick');
      page.toggleRemoved('customers');
    });
    assert('which opens to a labelled Put back', />Put back<\/button>/.test(opened.html));

    // The merge form stands in for the row it belongs to, and says what it is
    // about to do before it does it.
    const merge = renderPanel({ entries, lists: JSON.parse(JSON.stringify(lists)) },
      page => page.openMerge('customers', 'Kinkead'));
    assert('the merge form opens in place of the name',
      /class="lists-merge"/.test(merge.html) && /Merge <strong>Kinkead<\/strong> into:/.test(merge.html));
    assert('offering the other names to merge into, and not itself',
      /<option value="Kovalchick"/.test(merge.html) && !/<option value="Kinkead"/.test(merge.html),
      (merge.html.match(/<option[^>]*>/g) || []).join(' '));
    // The list is alphabetical. Landing on whatever sorts first is how one
    // stray click folds a company into an unrelated one.
    assert('nothing is preselected when no name is obviously the same',
      /<option value="">— choose a name —<\/option>/.test(merge.html) && / disabled>Merge</.test(merge.html),
      (merge.html.match(/<option[^>]*>[^<]*/g) || []).join(' | '));
    assert('and saying how many rows it will rename',
      /Renames it on 2 rows/.test(merge.html),
      (merge.html.match(/Renames it on [^<]*/) || ['not found'])[0]);

    // A payroll row cannot be renamed from here, and the form has to say so —
    // silently leaving one behind is how a merge half-works.
    const withLocked = renderPanel({
      entries: entries.concat([{ id: 'tst-7-1', customer: 'Kinkead' }]),
      lists: JSON.parse(JSON.stringify(lists)),
    }, page => page.openMerge('customers', 'Kinkead'));
    assert('a payroll row is called out rather than skipped quietly',
      /1 payroll row keeps the old name/.test(withLocked.html),
      (withLocked.html.match(/payroll row[^<]*/) || ['not found'])[0]);

    // The case the office actually has: one spelling of a company sitting
    // beside another. That one IS obviously right, so the form opens on it.
    const dupLists = JSON.parse(JSON.stringify(lists));
    dupLists.customers = ['Kovalchick', 'kovalchick', 'Kinkead'];
    const dup = renderPanel({
      entries: entries.concat([{ id: 'z', customer: 'kovalchick' }]),
      lists: dupLists,
    }, page => page.openMerge('customers', 'kovalchick'));
    assert('the obvious spelling is preselected and named as one',
      /<option value="Kovalchick" selected>Kovalchick — same name, different spelling</.test(dup.html),
      (dup.html.match(/<option[^>]*>[^<]*/g) || []).join(' | '));
    assert('and the merge is ready to run', !/ disabled>Merge</.test(dup.html));

    // Nothing to merge into is not a merge — the button would open a form with
    // an empty picker.
    const alone = renderPanel({ entries: [{ id: 'a', customer: 'Solo' }],
      lists: (() => { const l = freshLists(); l.customers = ['Solo']; return l; })() });
    assert('the merge button stays away when there is nothing to merge into',
      !/openMerge\('customers'/.test(alone.html));
  }

  // ── 2. Structural / panel ──────────────────────────────────────────────────
  console.log('\n[the Manage Lists panel]');
  {
    assert('deleted names are offered back, not hidden forever',
      /function restoreToList\(key, val\)/.test(TRUCKING) && /onclick="restoreToList\(/.test(TRUCKING));
    // esc() leaves an apostrophe alone, and the name goes into a JS string
    // literal inside an onclick — so "Kinkead's" used to break its own delete
    // button, which reads to the office as another name that won't go away.
    assert('a name with an apostrophe can still be deleted',
      /const argEsc = v => esc\(v\)\.replace\(\/'\/g, "\\\\'"\)/.test(TRUCKING));
    assert('and the delete buttons use it',
      /removeFromList\('\$\{key\}','\$\{argEsc\(v\)\}'\)/.test(TRUCKING) &&
      /removeUnit\('\$\{argEsc\(u\.name\)\}'\)/.test(TRUCKING));

    // What makes the removal readable rather than a name silently vanishing.
    assert('an undo bar rides at the top of the panel',
      /class="lists-undo"/.test(TRUCKING) && /onclick="undoListChange\(\)"/.test(TRUCKING));
    assert('the ✕ says what removing actually does',
      /Rows that already name it keep it and still total the same/.test(TRUCKING));
    assert('the removed strip folds away instead of padding every section',
      /onclick="toggleRemoved\('\$\{key\}'\)"/.test(TRUCKING));
    assert('and offers a labelled way back, not a glyph',
      />Put back<\/button>/.test(TRUCKING));
    assert('the rate box sits beside the customer',
      /onchange="updateCustomerRate\('\$\{argEsc\(c\)\}', this\.value\)"/.test(TRUCKING));
    assert('a customer can be added with its rate in one go',
      /id="lists-new-customers-rate"/.test(TRUCKING));
    assert('and blank rates can be filled from the rows in one click',
      /onclick="fillRatesFromHistory\(\)"/.test(TRUCKING));
    assert('the panel says which way the rate flows',
      /already has a fee is left alone/.test(TRUCKING));
    assert('merging is offered beside removing',
      /onclick="openMerge\('\$\{key\}','\$\{argEsc\(v\)\}'\)"/.test(TRUCKING));
    assert('and says what it does to the rows',
      /renames it on the rows that carry it/.test(TRUCKING));
  }

  // ── 3. Server ──────────────────────────────────────────────────────────────
  console.log('\n[GET /api/truck-division — the normalized fallback]');
  {
    const Module = require('module');
    const origLoad = Module._load;
    let CURRENT_SQL = () => Promise.resolve([]);
    Module._load = function (request) {
      if (request === '@neondatabase/serverless') return { neon: () => (...a) => CURRENT_SQL(...a) };
      if (request === './lib/auth') return { requireAuth: () => ({ companyCode: 'FCT', userId: 1 }) };
      return origLoad.apply(this, arguments);
    };
    const handler = require('../api/truck-division.js');
    Module._load = origLoad;

    const BLOB_LISTS = {
      drivers: [], customers: [], units: [],
      removed: { drivers: [], customers: ['Kovalchick'], units: [], materials: [] },
      rates:   { Kinkead: '121' },
    };
    CURRENT_SQL = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT value FROM app_data')) {
        // Entries blob empty (so the handler falls back), lists blob holding the
        // roster of deletions — the state a company lands in after a re-sync.
        const key = values[0];
        if (key === 'FCT:fct_truck_division_lists') return Promise.resolve([{ value: BLOB_LISTS }]);
        return Promise.resolve([]);
      }
      if (q.includes('FROM dropdown_lists')) {
        if (q.includes('truck_customers')) return Promise.resolve([{ value: 'Kinkead' }, { value: 'Kovalchick' }]);
        if (q.includes('truck_drivers'))   return Promise.resolve([{ value: 'Barr, Michael' }]);
        return Promise.resolve([]);
      }
      if (q.includes('FROM truck_division_units'))   return Promise.resolve([{ name: '7687', number: '12' }]);
      if (q.includes('FROM truck_division_entries')) return Promise.resolve([{ id: 'a', customer: 'Kovalchick' }]);
      if (/^(INSERT|UPDATE|DELETE)\b/.test(q)) return Promise.resolve([]);
      throw new Error('Unexpected query in mock: ' + q.slice(0, 90));
    };

    const res = {
      statusCode: 200, body: null,
      setHeader() {}, status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }, end() { return this; },
    };
    {
      await handler({ method: 'GET', query: {}, body: {} }, res);
      const lists = (res.body && res.body.lists) || {};
      assert('answers from the tables', res.statusCode === 200 && lists.customers.includes('Kinkead'),
        JSON.stringify(lists.customers));
      assert('and carries the deletions across with them',
        !!(lists.removed && (lists.removed.customers || []).includes('Kovalchick')),
        JSON.stringify(lists.removed));
      // The tables store a customer as a bare name, so the rates would be gone
      // and every new row would go back to having its fee typed in by hand.
      assert('and the rates with them',
        !!(lists.rates && lists.rates.Kinkead === '121'), JSON.stringify(lists.rates));

    }
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
