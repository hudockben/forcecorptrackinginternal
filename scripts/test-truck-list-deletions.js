#!/usr/bin/env node
'use strict';
/**
 * Deleting a name from a Truck Tracking managed list makes it stay deleted.
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
 *      empty, and those tables hold no record of a deletion, so it has to
 *      carry the roster over rather than answer with the deletions undone.
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
    isPayrollRowId: () => false,
    tdDivPut() { sandbox.saves++; },
    saveTruckLists() { sandbox.saves++; },
    renderListsPanel() {}, renderTrackingTab() {}, renderScheduler() {},
    schedIsActive: () => false,
    // The panel reads its input boxes; addToList is driven directly here.
    document: { getElementById: () => null },
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + PANEL, sandbox, { filename: 'trucking.html' });
  return sandbox;
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
  (async () => {
    await handler({ method: 'GET', query: {}, body: {} }, res);
    const lists = (res.body && res.body.lists) || {};
    assert('answers from the tables', res.statusCode === 200 && lists.customers.includes('Kinkead'),
      JSON.stringify(lists.customers));
    assert('and carries the deletions across with them',
      !!(lists.removed && (lists.removed.customers || []).includes('Kovalchick')),
      JSON.stringify(lists.removed));

    console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })();
}
