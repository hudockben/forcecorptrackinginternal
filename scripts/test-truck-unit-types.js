#!/usr/bin/env node
'use strict';
/**
 * A unit is three facts — what it is called, the number painted on it, and
 * what kind of truck it is — and Manage Lists lets the office edit all three.
 *
 * Run: node scripts/test-truck-unit-types.js
 *
 * Two things were wrong before this, and they are the two halves of this file.
 *
 * A unit was read-only. Fixing a typo in a name meant deleting the unit and
 * adding it again, which cost every row that named it: the rows kept the old
 * spelling, the loader's sweep read them back, and the office ended up with
 * both. So renaming is not a list edit here — the stored rows and the
 * scheduler's assignments are renamed with it, payroll's own rows are counted
 * out loud rather than rewritten, and the whole thing comes back on Undo.
 *
 * And the dispatch sheet worked out what kind of truck a haul went out on from
 * the unit's NAME. That only ever worked for the two units actually called
 * TriAxle and Lowboy — a unit named 2757, a tri-axle to everyone in the yard,
 * was filed under Other on every sheet that went out. The type is the unit's
 * own now, and the name is only read when nobody has set one.
 *
 * Layers, following test-truck-list-deletions.js:
 *   1. Behavioural — runs trucking.html's own functions in a vm.
 *   2. Report      — the same page's grouping and sheet columns, over units
 *                    whose type is set and units whose type is guessed.
 *   3. Panel       — the three fields really are fields, and the picker offers
 *                    the types.
 *   4. Server      — the type survives the round trip: it is written to the
 *                    normalized table, read back from it, and in the schema.
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
const ROUTE    = read('api/truck-division.js');
const SCHEMA   = read('neon-schema.sql');

const HELPERS = slice(TRUCKING, '    const _remKey =', '    function saveTruckLists()', 'list helpers + sweep');
const PANEL   = slice(TRUCKING, '    function addToList(key)', '    function schedSave()', 'panel handlers');
const RENDER  = slice(TRUCKING, '    /* ── Reading a sign-in against the drivers list',
                                '    function schedSave()', 'panel render');
const REPORT  = slice(TRUCKING, '    /* ═══════ How the daily report is grouped',
                                '    function schedSheetRows(date)', 'report grouping + sheet row');

const freshLists = () => ({
  drivers: [], customers: [], units: [], locations: [], materials: [], notDrivers: [],
  rates: {}, removed: { drivers: [], customers: [], units: [], materials: [], unitNumbers: {}, unitTypes: {} },
});

/** trucking.html's list handlers, over a made-up division. */
function newPage(state) {
  const sandbox = {
    console,
    divEntries: state.entries || [],
    divTruckLists: state.lists,
    icBillingArr: [], icSentMap: new Map(),
    _divEntriesLoaded: true,
    saves: 0,
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
    tdDivPut() { sandbox.saves++; },
    saveTruckLists() { sandbox.saves++; },
    renderListsPanel() {}, renderTrackingTab() {}, renderScheduler() {},
    schedIsActive: () => false, schedSave() {}, calcHours: () => null,
    // Payroll owns the rows it injected; a rename must leave them alone.
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    driverLoginMap: {}, saveDriverLogins() {},
    // Both boards name the truck, so both are walked.
    SCHED_BOARDS: [{ id: 'trucking' }, { id: 'labor' }],
    schedS: board => sandbox._schedStates[board || 'trucking'],
    schedEnsureLoaded: () => Promise.resolve(),
    schedDirty: 0,
    schedMarkDirty() { sandbox.schedDirty++; },
    _listsUndo: null, _listsShowRemoved: new Set(), _listsMerge: null, _listsNote: '',
    document: { getElementById: id => (id in (state.inputs || {}) ? { value: state.inputs[id] } : null) },
  };
  sandbox._schedStates = {
    trucking: { loaded: state.schedLoaded !== false, assignments: state.sched || {} },
    labor:    { loaded: state.laborLoaded === true,  assignments: state.labor || {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + PANEL, sandbox, { filename: 'trucking.html' });
  return sandbox;
}

/** A `const` declared at the top of a vm script is not a property of the
 *  sandbox — it lives in the context's lexical scope — so the column list is
 *  read by evaluating its name in the same context. */
const evalIn = (sandbox, expr) => vm.runInContext(expr, sandbox);

/** The same page's dispatch-report grouping, over a day of assignments. */
function newReport(lists, items, reports) {
  const sandbox = {
    console,
    divTruckLists: lists,
    schedRepItems: () => items,
    schedReports: reports || new Map(),
    schedHoursBetween: (a, b) => (a && b ? '8.00' : ''),
    schedTime12: v => v || '',
    schedDivLabel: k => k || '',
    schedJobOf: a => (a && (a.project || a.customer)) || '',
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + REPORT, sandbox, { filename: 'trucking.html' });
  return sandbox;
}

/** Render the Manage Lists panel and hand back the HTML it wrote. */
function renderPanel(state, drive) {
  let html = '', tabsHtml = '';
  const body = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const tabs = { set innerHTML(v) { tabsHtml = v; }, get innerHTML() { return tabsHtml; } };
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
        : id === 'lists-tabs' ? tabs
        : id in (state.inputs || {}) ? { value: state.inputs[id] } : null),
      addEventListener() {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + RENDER, sandbox, { filename: 'trucking.html' });
  if (drive) drive(sandbox);
  sandbox.renderListsPanel();
  return { html, tabs: tabsHtml, page: sandbox };
}

(async () => {
  console.log('Manage Lists — a unit, its number and what kind of truck it is\n');

  // ── 1. What kind of truck a unit is ──────────────────────────────────────
  console.log('[the type is the unit’s own]');
  {
    const lists = freshLists();
    lists.units = [
      { name: '2757',       number: '4',  type: 'triaxle' },
      { name: '3999 SPRAY', number: '18', type: ''        },
      { name: 'Lowboy',     number: '',   type: ''        },
      { name: '4485',       number: '4',  type: ''        },
      { name: '46',         number: '3',  type: 'nonsense' },
    ];
    const p = newPage({ lists });

    assert('a unit named 2757 is whatever the office says it is',
      p.unitType('2757') === 'triaxle' && p.unitTypeLabel('2757') === 'Tri-Axle',
      p.unitType('2757'));
    // The old behaviour, kept for every company that never opens the panel.
    assert('a unit nobody has typed one on falls back to its name',
      p.unitType('3999 SPRAY') === 'spray' && p.unitType('Lowboy') === 'lowboy',
      p.unitType('3999 SPRAY') + '/' + p.unitType('Lowboy'));
    assert('and a name that says nothing stays blank rather than guessing',
      p.unitType('4485') === '' && p.unitTypeLabel('4485') === '');
    assert('a type that is not one of the types is not one either',
      p.unitType('46') === '', p.unitType('46'));
    assert('a unit that is not on the list at all is still read by name',
      p.unitType('LOWBOY 9') === 'lowboy', p.unitType('LOWBOY 9'));
    assert('and nothing is not something', p.unitType('') === '' && p.unitType(null) === '');
  }

  // ── 2. Editing the three fields ──────────────────────────────────────────
  console.log('\n[the fields save what is typed in them]');
  {
    const lists = freshLists();
    lists.units = [{ name: '2757', number: '4', type: '' }];
    const p = newPage({ lists });

    p.updateUnitType('2757', 'lowboy');
    assert('the type picker sets the type', p.divTruckLists.units[0].type === 'lowboy',
      JSON.stringify(p.divTruckLists.units));
    assert('and saves it', p.saves > 0, String(p.saves));

    p.updateUnitType('2757', 'not-a-truck');
    assert('a value that is not a type clears it rather than storing junk',
      p.divTruckLists.units[0].type === '', JSON.stringify(p.divTruckLists.units));

    p.updateUnitNumber('2757', ' 41 ');
    assert('the number box trims what it is given', p.divTruckLists.units[0].number === '41',
      JSON.stringify(p.divTruckLists.units));

    const before = p.saves;
    p.updateUnitNumber('2757', '41');
    assert('and typing the same number again saves nothing', p.saves === before, String(p.saves));
  }

  console.log('\n[a unit is added with all three at once]');
  {
    const lists = freshLists();
    const p = newPage({ lists, inputs: {
      'lists-new-unit-name': '9544', 'lists-new-unit-number': '42', 'lists-new-unit-type': 'triaxle',
    } });
    p.addUnit();
    assert('the add row carries the type in with the name',
      JSON.stringify(p.divTruckLists.units) === JSON.stringify([{ name: '9544', number: '42', type: 'triaxle' }]),
      JSON.stringify(p.divTruckLists.units));
  }

  // ── 3. Renaming ──────────────────────────────────────────────────────────
  console.log('\n[renaming a unit takes its rows with it]');
  {
    const lists = freshLists();
    lists.units = [{ name: '2757', number: '4', type: 'triaxle' }];
    const p = newPage({
      lists,
      entries: [
        { id: 'a', unit: '2757' },
        { id: 'b', unit: '2760' },
      ],
      sched: { '2026-08-27': [{ id: 's1', unit: '2757' }, { id: 's2', unit: 'Lowboy' }] },
    });

    await p.renameUnit('2757', '2757A');
    assert('the unit is renamed', p.divTruckLists.units[0].name === '2757A',
      JSON.stringify(p.divTruckLists.units));
    assert('and keeps its number and type', p.divTruckLists.units[0].number === '4'
      && p.divTruckLists.units[0].type === 'triaxle', JSON.stringify(p.divTruckLists.units));
    assert('the rows that named it are renamed with it', p.divEntries[0].unit === '2757A',
      JSON.stringify(p.divEntries));
    assert('and the rows that did not are left alone', p.divEntries[1].unit === '2760');
    assert('the board is renamed too',
      p._schedStates.trucking.assignments['2026-08-27'][0].unit === '2757A',
      JSON.stringify(p._schedStates.trucking.assignments));
    assert('and marked for saving', p.schedDirty > 0, String(p.schedDirty));
    assert('another truck on the same day is untouched',
      p._schedStates.trucking.assignments['2026-08-27'][1].unit === 'Lowboy');

    // Nothing else names the old spelling, so there is nothing for the sweep
    // to put back and no reason to clutter the removed strip.
    assert('nothing is recorded as removed when the rename reached everything',
      (p.divTruckLists.removed.units || []).length === 0,
      JSON.stringify(p.divTruckLists.removed.units));

    p.undoListChange();
    assert('undo puts the name back', p.divTruckLists.units[0].name === '2757',
      JSON.stringify(p.divTruckLists.units));
    assert('and the rows with it', p.divEntries[0].unit === '2757');
    assert('and the board with them',
      p._schedStates.trucking.assignments['2026-08-27'][0].unit === '2757');
  }

  console.log('\n[a payroll row keeps the old name, and is said so]');
  {
    const lists = freshLists();
    lists.units = [{ name: '2757', number: '4', type: '' }];
    const p = newPage({
      lists,
      entries: [{ id: 'a', unit: '2757' }, { id: 'tst-9', unit: '2757' }],
    });

    await p.renameUnit('2757', '2757A');
    assert('payroll’s own row is left to payroll', p.divEntries[1].unit === '2757',
      JSON.stringify(p.divEntries));
    assert('and the undo bar counts it', p._listsUndo.locked === 1, JSON.stringify(p._listsUndo));
    // The sweep re-seeds any unit name it finds on a row, so without recording
    // the rename the old name would be back as a unit of its own.
    assert('the old name is recorded so the sweep cannot resurrect it',
      (p.divTruckLists.removed.units || []).includes('2757'),
      JSON.stringify(p.divTruckLists.removed.units));
    p._migrateExistingEntries();
    assert('and the next load leaves it off the list',
      !p.divTruckLists.units.some(u => u.name === '2757'), JSON.stringify(p.divTruckLists.units));

    p.undoListChange();
    assert('undo clears the record of it too',
      !(p.divTruckLists.removed.units || []).includes('2757'),
      JSON.stringify(p.divTruckLists.removed.units));
    assert('and the list is back to one unit under the old name',
      p.divTruckLists.units.length === 1 && p.divTruckLists.units[0].name === '2757',
      JSON.stringify(p.divTruckLists.units));
  }

  console.log('\n[the renames the panel refuses]');
  {
    const lists = freshLists();
    lists.units = [{ name: '2757', number: '4', type: '' }, { name: '2760', number: '187', type: '' }];
    const p = newPage({ lists, entries: [{ id: 'a', unit: '2757' }] });

    await p.renameUnit('2757', '2760');
    assert('renaming onto a name already in the list is refused',
      p.divTruckLists.units.map(u => u.name).join(',') === '2757,2760',
      JSON.stringify(p.divTruckLists.units));
    assert('the rows are not quietly folded into the other unit', p.divEntries[0].unit === '2757');
    assert('and the panel says why, and what to use instead',
      /already a unit named 2760/.test(p._listsNote) && /⇤/.test(p._listsNote), p._listsNote);

    await p.renameUnit('2757', '   ');
    assert('an emptied box changes nothing', p.divTruckLists.units[0].name === '2757');
    const saves = p.saves;
    await p.renameUnit('2757', '2757');
    assert('and the same name again is not a rename', p.saves === saves && p._listsUndo === null,
      String(p.saves));
  }

  console.log('\n[a removed unit comes back whole]');
  {
    const lists = freshLists();
    lists.units = [{ name: '3359 WINCH TRUCK', number: '20', type: 'winch' }];
    const p = newPage({ lists, entries: [{ id: 'a', unit: '3359 WINCH TRUCK' }] });

    p.removeUnit('3359 WINCH TRUCK');
    p._listsUndo = null;                       // days later, from the removed strip
    p.restoreToList('units', '3359 WINCH TRUCK');
    const back = p.divTruckLists.units[0];
    assert('Put back hands back the number and the type, not just the name',
      back && back.number === '20' && back.type === 'winch', JSON.stringify(p.divTruckLists.units));
  }

  // ── 4. What the dispatch report does with it ─────────────────────────────
  console.log('\n[the dispatch sheet is sectioned by the type]');
  {
    const lists = freshLists();
    lists.units = [
      { name: '2757',   number: '4', type: 'triaxle' },
      { name: '5403',   number: '21', type: 'lowboy' },
      { name: '4427',   number: '3', type: '' },
      { name: 'TriAxle', number: '', type: '' },
    ];
    const items = [
      { id: '1', unit: '2757',    driver: 'Barr, Michael' },
      { id: '2', unit: '5403',    driver: 'Kirk, Dan' },
      { id: '3', unit: 'TriAxle', driver: 'Rising, Camden' },
      { id: '4', unit: '4427',    driver: 'Riffer, Jeff' },
      { id: '5', unit: '2757',    driver: 'Glatt, Shane', division: 'dust' },
    ];
    const r = newReport(lists, items);

    assert('a unit typed as a tri-axle reads as one, whatever it is called',
      r.schedTruckGroup(items[0]) === 'triaxle', r.schedTruckGroup(items[0]));
    assert('the same for a lowboy', r.schedTruckGroup(items[1]) === 'lowboy');
    assert('a unit whose name says it is still read by name',
      r.schedTruckGroup(items[2]) === 'triaxle');
    assert('and one that says nothing lands in Other rather than being dropped',
      r.schedTruckGroup(items[3]) === 'other');
    // Work for dust is called out on its own whatever it went out on.
    assert('dust work is dust work whatever the truck', r.schedTruckGroup(items[4]) === 'dust');

    const groups = r.schedGroupedItems('2026-08-27');
    const labels = groups.map(g => g.label);
    assert('the sheet reads as sections, empty ones dropped',
      labels.join(' | ') === 'Tri-Axle | Lowboy | Dust Control | Other', labels.join(' | '));
    assert('and the tri-axles are together — the point of the whole thing',
      groups[0].rows.map(a => a.id).join(',') === '1,3', groups[0].rows.map(a => a.id).join(','));
    assert('every haul is in exactly one section',
      groups.reduce((n, g) => n + g.rows.length, 0) === items.length);
  }

  console.log('\n[and says the type on the row]');
  {
    const lists = freshLists();
    lists.units = [{ name: '2757', number: '4', type: 'triaxle' }];
    const r = newReport(lists, []);
    const cols = evalIn(r, 'SCHED_SHEET_COLS');
    const at   = cols.indexOf('Truck Type');
    assert('the sheet has a Truck Type column', at !== -1, cols.join(','));
    assert('and it sits beside the truck', cols[at - 1] === 'Truck', cols.slice(at - 2, at + 1).join(','));

    const row = r.schedSheetRow({ id: '1', unit: '2757', driver: 'Barr, Michael' });
    assert('a row says what kind of truck went out', row[at] === 'Tri-Axle', JSON.stringify(row));
    assert('and the row is as wide as the header', row.length === cols.length,
      row.length + ' vs ' + cols.length);
    assert('a haul on a unit nobody typed a type on leaves the cell empty',
      r.schedSheetRow({ id: '2', unit: '4485' })[at] === '');
  }

  console.log('\n[the columns that count on their position still line up]');
  {
    // Tons and loads are right-aligned and totalled by index, in three places
    // that must agree: the screen table, the print/email sheet and the .xlsx.
    const cols  = evalIn(newReport(freshLists(), []), 'SCHED_SHEET_COLS');
    const tons  = cols.indexOf('Tons'), loads = cols.indexOf('Loads');
    const html  = slice(TRUCKING, '    function schedSheetHTML(date)', '    function schedSheetPrint()', 'sheet html');
    const xlsx  = slice(TRUCKING, '    function schedSheetXlsx(date)', '      const files = [', 'sheet xlsx');
    const nums  = `new Set([4, ${tons}, ${loads}])`;
    assert('the printed sheet right-aligns the figure columns', html.includes(nums), nums);
    assert('and the workbook writes them as numbers', xlsx.includes(nums), nums);
    assert('the workbook totals the same two columns',
      xlsx.includes(`cell(r - 1, ${tons}, g.tons`) && xlsx.includes(`cell(r - 1, ${loads}, g.loads`));
    const widths = (xlsx.match(/const widths = \[([^\]]*)\]/) || [])[1];
    assert('and sizes every column it writes',
      widths && widths.split(',').length === cols.length,
      widths ? widths.split(',').length + ' vs ' + cols.length : 'no widths');

    // The day table on screen is the same sheet without Address and the
    // driver's notes; its band and subtotal rows span it.
    const day = slice(TRUCKING, '    function schedDayHTML()', '    /* ═══════ How the daily report',
      'day table');
    const heads = (day.match(/<th>/g) || []).length;
    assert('the day table has a Truck Type column too', /<th>Truck Type<\/th>/.test(day));
    assert('and its section bands span the whole row',
      day.includes(`<td colspan="${heads}">`), String(heads));
    const sub = (day.match(/<tr class="sch-sub">[\s\S]*?<\/tr>/) || [''])[0];
    const span = (sub.match(/colspan="(\d+)"/g) || [])
      .reduce((n, m) => n + Number(m.match(/\d+/)[0]), 0)
      + (sub.match(/<td(?![^>]*colspan)/g) || []).length;
    assert('and its subtotal row is exactly as wide', span === heads, span + ' vs ' + heads);
  }

  // ── 5. The panel itself ──────────────────────────────────────────────────
  console.log('\n[the panel offers three fields, not three labels]');
  {
    const lists = freshLists();
    lists.units = [{ name: '2757', number: '4', type: 'triaxle' }, { name: '3999 SPRAY', number: '18', type: '' }];
    const { html } = renderPanel({ lists }, page => page.listsOpenTab('units'));

    assert('the name is editable', /class="li-edit"[^>]*value="2757"/.test(html));
    assert('the number is editable', /class="li-num"[^>]*value="4"/.test(html));
    assert('renaming is wired to the rename, not to the list',
      /onchange="renameUnit\('2757',this\.value\)"/.test(html));
    assert('and the number to its own handler',
      /onchange="updateUnitNumber\('2757',this\.value\)"/.test(html));
    assert('the type is a picker', /onchange="updateUnitType\('2757',this\.value\)"/.test(html));
    assert('with the type already on the unit selected',
      /<option value="triaxle" selected>Tri-Axle<\/option>/.test(html));
    assert('and every type offered', /value="lowboy">Lowboy</.test(html) && /value="spray">Spray Truck</.test(html));
    // A blank type is not a job half done — it is the name being read.
    assert('a unit with no type says what the report will call it',
      /Spray Truck \(from the name\)/.test(html));
    assert('a unit whose name says nothing offers no guess',
      /— no type —/.test(html));
    assert('the add row takes a type too', /id="lists-new-unit-type"/.test(html));
    assert('and the panel says what the type is for',
      /dispatch sheet/i.test(html) && /renamed with it/.test(html));
  }

  // ── 6. The round trip ────────────────────────────────────────────────────
  console.log('\n[the type survives the round trip]');
  {
    assert('the units table has a type column',
      /ALTER TABLE truck_division_units ADD COLUMN IF NOT EXISTS type TEXT/.test(SCHEMA));
    assert('and a fresh database gets one without the migration',
      /CREATE TABLE IF NOT EXISTS truck_division_units[\s\S]*?type\s+TEXT/.test(SCHEMA));
    assert('the sync writes it',
      /INSERT INTO truck_division_units \(company_code, name, number, type, sort_order\)/.test(ROUTE)
      && /type\s*=\s*EXCLUDED\.type/.test(ROUTE));
    const selects = (ROUTE.match(/SELECT name, number, type FROM truck_division_units/g) || []).length;
    assert('and both reads ask for it', selects === 2, String(selects));
    const maps = (ROUTE.match(/type: r\.type \|\| ''/g) || []).length;
    assert('so the fallback to the tables answers with it, not without it',
      maps === 2, String(maps));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
