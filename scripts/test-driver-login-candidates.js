#!/usr/bin/env node
'use strict';
/**
 * The drivers list offering the sign-ins that have no name behind them.
 *
 * Run: node scripts/test-driver-login-candidates.js
 *
 * A login is a username and a driver is a name on the office's own list, and
 * nothing in the schema joins the two — /api/driver/logins exists precisely to
 * let the office state the link. Which means a new hire can have an account,
 * be on the payroll, and still not exist to the board; the only symptom is the
 * driver opening the app to an empty schedule, on the one screen the office
 * never looks at. Nobody opens a list to check it is still complete.
 *
 * So the drivers list offers them. Every sign-in with no driver behind it
 * shows up under the list that is missing it, either as a guess to confirm or
 * as a box to type the name into — and adding the name and linking the sign-in
 * happen in the one click, because doing only the first is the failure this
 * exists to prevent.
 *
 * Offered, never taken. The driver app matches a haul to a person by this
 * exact string (api/driver/schedule.js), so a link made on a guess alone would
 * show one driver another's day. Every case below holds that line: the guess
 * is shown beside the sign-in it came from and a person clicks it, ambiguity
 * produces no guess at all, and "not a driver" is an answer the office gives
 * rather than one inferred from the shape of a username.
 *
 * Three layers:
 *   1. Matching   — the surname-plus-initial rule, against this company's own
 *                   usernames and the ways it must refuse to guess.
 *   2. Behavioural— the panel handlers in a vm: add-and-link, dismiss, undo,
 *                   and the loader sweep that has to leave all of it alone.
 *   3. Render     — the strip and the tab count, as the panel actually writes
 *                   them.
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

// The same three regions test-truck-list-deletions.js works in: the deleted-name
// helpers plus the loader's sweep, the panel handlers, and the panel's markup
// (which starts at the sign-in matchers the drivers section calls into).
const HELPERS = slice(TRUCKING, '    const _remKey =', '    function saveTruckLists()', 'list helpers + sweep');
const PANEL   = slice(TRUCKING, '    function addToList(key)', '    function schedSave()', 'panel handlers');
const RENDER  = slice(TRUCKING, '    /* ── Reading a sign-in against the drivers list', '    function schedSave()', 'panel render');

const freshLists = (over) => Object.assign({
  drivers: [], customers: [], units: [], locations: [], materials: [],
  rates: {}, notDrivers: [],
  removed: { drivers: [], customers: [], units: [], materials: [] },
}, over || {});

/** The matchers on their own, with a drivers list to read against. */
function matcher(drivers) {
  const sandbox = {
    console, divTruckLists: freshLists({ drivers }), driverLoginMap: {}, driverLoginUsers: [],
    // The region binds Escape at load; nothing here presses keys.
    document: { getElementById: () => null, addEventListener() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(RENDER, sandbox, { filename: 'trucking.html' });
  return sandbox;
}

/** The panel handlers over a page's state, with one typed-in name standing by
 *  in the box the strip would have rendered. */
function newPage(state) {
  const sandbox = {
    console,
    divEntries: state.entries || [],
    divTruckLists: state.lists,
    icBillingArr: [], icSentMap: new Map(),
    _divEntriesLoaded: true,
    saves: 0, loginSaves: 0,
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
    tdDivPut() { sandbox.saves++; },
    saveTruckLists() { sandbox.saves++; },
    driverLoginMap: state.logins || {},
    driverLoginUsers: state.users || [],
    saveDriverLogins() { sandbox.loginSaves++; },
    renderListsPanel() {}, renderTrackingTab() {}, renderScheduler() {},
    schedIsActive: () => false, schedSave() {}, calcHours: () => null,
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    schedAssignments: {}, _schedLoaded: false, schedMarkDirty() {},
    schedEnsureLoaded: () => Promise.resolve(),
    _listsUndo: null, _listsShowRemoved: new Set(), _listsMerge: null,
    // The strip's name boxes, addressed by position the way the panel writes
    // them. focus() is what an empty one gets instead of a silent no-op.
    focused: [],
    document: {
      getElementById: id => {
        const m = /^lists-login-name-(\d+)$/.exec(id);
        if (!m) return null;
        const i = Number(m[1]);
        return { value: (state.inputs || [])[i] || '', focus() { sandbox.focused.push(i); } };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPERS + '\n' + PANEL, sandbox, { filename: 'trucking.html' });
  return sandbox;
}

/** Render the Manage Lists panel and hand back what it wrote. */
function renderPanel(state) {
  let html = '', tabsHtml = '';
  const body = { set innerHTML(v) { html = v; }, get innerHTML() { return html; } };
  const tabs = { set innerHTML(v) { tabsHtml = v; }, get innerHTML() { return tabsHtml; } };
  const sandbox = {
    console,
    divEntries: state.entries || [],
    divTruckLists: state.lists,
    divLists: { employees: [], equipment: [] },
    icBillingArr: [], icSentMap: new Map(),
    driverLoginMap: state.logins || {},
    driverLoginUsers: state.users || [],
    _driverLoginsLoaded: state.loaded !== false,
    loadDriverLogins: () => Promise.resolve(),
    renderTrackingTab() {}, renderScheduler() {}, schedIsActive: () => false,
    schedSave() {}, calcHours: () => null, tdDivPut() {}, saveTruckLists() {},
    saveDriverLogins() {},
    _csvDate: v => v, _csvTime: v => v, _csvNum: v => v,
    isPayrollRowId: id => String(id || '').startsWith('tst-'),
    document: {
      getElementById: id => (id === 'lists-panel-body' ? body : id === 'lists-tabs' ? tabs : null),
      addEventListener() {},
    },
  };
  vm.createContext(sandbox);
  // The panel counts how many stored rows name each driver, which is the
  // deleted-name helpers' key function — so the render needs both regions.
  vm.runInContext(HELPERS + '\n' + RENDER, sandbox, { filename: 'trucking.html' });
  // Through the panel's own handler: which tab is open is declared inside the
  // region, so setting it from out here would only shadow it. The handler
  // renders, which is what these cases read.
  sandbox.listsOpenTab(state.tab || 'drivers');
  return { html, tabs: tabsHtml, page: sandbox };
}

// The company's real drivers list and the usernames its office actually
// issued: surname, then the first name starting. Every case here reads
// against these rather than names invented to suit the rule.
const DRIVERS = [
  'Barr, Michael', 'Becker, Ben', 'Boring, Jamey', 'Cribbs, Jonathan',
  'Detwiler, Nick', 'Fairman, Kris', 'Himes, Jacob', 'Leasure, Rick',
  'Rising, Camden', 'Thomas, Jason', 'hudockben',
];

console.log('\n[reading a username against the drivers list]');
{
  const m = matcher(DRIVERS);
  const g = u => m._guessDriverForLogin(u);

  assert('a full first name matches', g('himesjacob') === 'Himes, Jacob', g('himesjacob'));
  assert('and a shortened one does too', g('cribbsjon') === 'Cribbs, Jonathan', g('cribbsjon'));
  assert('and a nickname the first name does not even start with',
    g('barrmike') === 'Barr, Michael', g('barrmike'));
  assert('casing in the username is nothing to go on',
    g('BoringJamey') === 'Boring, Jamey', g('BoringJamey'));
  assert('nor is punctuation', g('rising.cam') === 'Rising, Camden', g('rising.cam'));
  assert('a bare username on the list matches itself',
    g('hudockben') === 'hudockben', g('hudockben'));

  // The whole point: the sign-in that has nobody behind it must come back with
  // nothing, so it is offered as a name to add rather than paired off.
  assert('a driver who is not on the list gets no guess', g('wetzeljohn') === '', g('wetzeljohn'));
  assert('a surname that only starts the same way is not a match',
    g('thomsonjason') === '', g('thomsonjason'));
  assert('a first initial that disagrees is not a match',
    g('leasurepete') === '', g('leasurepete'));
  assert('a surname alone is not enough to name a person',
    g('leasure') === '', g('leasure'));
  assert('and nothing is guessed from an empty username', g('') === '', g(''));
}

console.log('\n[two people a username cannot tell apart]');
{
  const m = matcher(['Kirk, Dan', 'Kirk, Dave', 'Kirkland, Dana']);
  assert('a shared surname and initial produces no guess — not a coin toss',
    m._guessDriverForLogin('kirkd') === '', m._guessDriverForLogin('kirkd'));
  // The longer surname is the more specific reading, and the shorter one still
  // matches character for character — so the tie is only a tie at equal length.
  assert('the longer surname wins over one that merely prefixes it',
    m._guessDriverForLogin('kirklanddana') === 'Kirkland, Dana',
    m._guessDriverForLogin('kirklanddana'));
  assert('and the two Kirks are still told apart when the name says which',
    m._guessDriverForLogin('kirkdave') === 'Kirk, Dave', m._guessDriverForLogin('kirkdave'));

  // Which of the two carries more of the first name is not something to
  // depend on: the username shortens it ("jon" for Jonathan) as readily as it
  // runs past it ("nicky"), so agreement counts either way round.
  const n = matcher(['Detwiler, Nick', 'Detwiler, Ned']);
  assert('a username that runs past the name on the list still lands on it',
    n._guessDriverForLogin('detwilernicky') === 'Detwiler, Nick',
    n._guessDriverForLogin('detwilernicky'));
  // And where neither name is inside the other, a shared initial is all there
  // is — which between two brothers is not enough to say which.
  assert('but a shared initial alone is not enough to pick between two of them',
    n._guessDriverForLogin('detwilernicholas') === '',
    n._guessDriverForLogin('detwilernicholas'));
}

console.log('\n[which sign-ins get offered]');
{
  const m = matcher(DRIVERS);
  m.driverLoginMap  = { himesjacob: 'Himes, Jacob' };
  m.divTruckLists.notDrivers = ['officeacct'];
  m.driverLoginUsers = [
    { id: 1, username: 'himesjacob' }, { id: 2, username: 'wetzeljohn' },
    { id: 3, username: 'officeacct' }, { id: 4, username: 'barrmike' },
  ];
  const out = m._unlinkedLogins();
  const names = out.map(c => c.username);
  assert('a linked sign-in is not offered again', !names.includes('himesjacob'), names.join(','));
  assert('one dismissed as not a driver stays gone', !names.includes('officeacct'), names.join(','));
  assert('the rest are offered', names.join(',') === 'wetzeljohn,barrmike', names.join(','));
  assert('and each carries the driver it looks like, or none',
    out.find(c => c.username === 'barrmike').guess === 'Barr, Michael'
    && out.find(c => c.username === 'wetzeljohn').guess === '',
    JSON.stringify(out));

  // Usernames are typed by hand and their casing wanders — api/driver/logins.js
  // sorts on LOWER() for the same reason. A link stored one way must not leave
  // the same account being offered under another.
  m.driverLoginMap = { HimesJacob: 'Himes, Jacob' };
  m.divTruckLists.notDrivers = ['OfficeAcct'];
  const again = m._unlinkedLogins().map(c => c.username);
  assert('casing does not resurrect a linked sign-in', !again.includes('himesjacob'), again.join(','));
  assert('nor a dismissed one', !again.includes('officeacct'), again.join(','));
}

console.log('\n[adding the name and linking the sign-in, in one click]');
{
  const p = newPage({
    lists: freshLists({ drivers: ['Thomas, Jason'] }),
    users: [{ id: 1, username: 'wetzeljohn' }],
    inputs: ['Wetzel, John'],
  });
  p.addDriverFromLogin('wetzeljohn', 0);

  assert('the name lands on the drivers list',
    p.divTruckLists.drivers.includes('Wetzel, John'), JSON.stringify(p.divTruckLists.drivers));
  assert('in order, so the picker reads the way it always has',
    p.divTruckLists.drivers.join('|') === 'Thomas, Jason|Wetzel, John',
    p.divTruckLists.drivers.join('|'));
  // Both halves or neither: the list without the link is exactly the state
  // that leaves a driver signed in to an empty schedule.
  assert('and the sign-in is linked to it in the same click',
    p.driverLoginMap.wetzeljohn === 'Wetzel, John', JSON.stringify(p.driverLoginMap));
  assert('the drivers list is saved', p.saves > 0, String(p.saves));
  assert('and so is the link — two blobs, two writes', p.loginSaves > 0, String(p.loginSaves));
}

console.log('\n[a name that was deleted once]');
{
  // Removing a driver records the deletion so the loader cannot sweep it back
  // in. Adding it here has to lift that, or the name is added, linked, and
  // gone again on the next load — with the link left pointing at nobody.
  const p = newPage({
    lists: freshLists({ drivers: ['Wetzel, John'] }),
    entries: [{ id: 'a', driver: 'Wetzel, John', customer: 'Kinkead', unit: '7687' }],
    users: [{ id: 1, username: 'wetzeljohn' }],
    inputs: ['Wetzel, John'],
  });
  p.removeFromList('drivers', 'Wetzel, John');
  assert('the deletion is on record',
    p.divTruckLists.removed.drivers.includes('Wetzel, John'),
    JSON.stringify(p.divTruckLists.removed.drivers));

  p.addDriverFromLogin('wetzeljohn', 0);
  assert('adding it back clears the deletion',
    !p.divTruckLists.removed.drivers.includes('Wetzel, John'),
    JSON.stringify(p.divTruckLists.removed.drivers));

  p._migrateExistingEntries();
  assert('so the next load leaves it alone',
    p.divTruckLists.drivers.includes('Wetzel, John'), JSON.stringify(p.divTruckLists.drivers));
  assert('and the link still points at a name that is there',
    p.driverLoginMap.wetzeljohn === 'Wetzel, John', JSON.stringify(p.driverLoginMap));
}

console.log('\n[an empty box is a question, not a command]');
{
  const p = newPage({
    lists: freshLists(), users: [{ id: 1, username: 'wetzeljohn' }], inputs: [''],
  });
  p.addDriverFromLogin('wetzeljohn', 0);
  assert('nothing is added on a blank name', p.divTruckLists.drivers.length === 0,
    JSON.stringify(p.divTruckLists.drivers));
  assert('and nothing is linked', Object.keys(p.driverLoginMap).length === 0,
    JSON.stringify(p.driverLoginMap));
  assert('nothing is saved either', p.saves === 0 && p.loginSaves === 0,
    `${p.saves}/${p.loginSaves}`);
  assert('the box asks again instead', p.focused.join(',') === '0', p.focused.join(','));

  // Whitespace is a blank name typed slowly.
  const q = newPage({ lists: freshLists(), users: [{ id: 1, username: 'x' }], inputs: ['   '] });
  q.addDriverFromLogin('x', 0);
  assert('and spaces are not a name', q.divTruckLists.drivers.length === 0,
    JSON.stringify(q.divTruckLists.drivers));
}

console.log('\n[taking the guess]');
{
  const p = newPage({ lists: freshLists({ drivers: ['Barr, Michael'] }), users: [{ id: 1, username: 'barrmike' }] });
  p.linkLoginToDriver('barrmike', 'Barr, Michael');
  assert('the link is made', p.driverLoginMap.barrmike === 'Barr, Michael',
    JSON.stringify(p.driverLoginMap));
  assert('and saved', p.loginSaves === 1, String(p.loginSaves));
  assert('the drivers list is untouched — the name was already on it',
    p.divTruckLists.drivers.join('|') === 'Barr, Michael' && p.saves === 0,
    `${p.divTruckLists.drivers.join('|')} / ${p.saves}`);
}

console.log('\n[not a driver]');
{
  const p = newPage({ lists: freshLists(), users: [{ id: 1, username: 'officeacct' }] });
  p.dismissLoginCandidate('officeacct');
  assert('the answer is recorded', p.divTruckLists.notDrivers.includes('officeacct'),
    JSON.stringify(p.divTruckLists.notDrivers));
  assert('and stored with the lists, not in this browser — one answer for the office',
    p.saves === 1, String(p.saves));
  assert('nothing is added to the drivers list', p.divTruckLists.drivers.length === 0,
    JSON.stringify(p.divTruckLists.drivers));

  p.dismissLoginCandidate('OfficeAcct');
  assert('saying it twice does not say it twice',
    p.divTruckLists.notDrivers.length === 1, JSON.stringify(p.divTruckLists.notDrivers));

  // A dismissal is one click and the strip redraws under it, so it offers
  // itself back the way every other list change does.
  assert('it offers itself back', p._listsUndo && p._listsUndo.kind === 'notdriver',
    JSON.stringify(p._listsUndo));
  p.undoListChange();
  assert('and undo puts it back in the queue', !p.divTruckLists.notDrivers.includes('officeacct'),
    JSON.stringify(p.divTruckLists.notDrivers));
  assert('clearing the bar with it', p._listsUndo === null, JSON.stringify(p._listsUndo));
}

console.log('\n[the sweep leaves all of it alone]');
{
  // Every load re-seeds the lists from the stored rows. The dismissals are not
  // names on any list, and a load that walked over them would put every office
  // account back on the drivers tab.
  const p = newPage({
    lists: freshLists({ notDrivers: ['officeacct'] }),
    entries: [{ id: 'a', driver: 'Thomas, Jason', customer: 'Kinkead', unit: '7687' }],
  });
  p._migrateExistingEntries();
  assert('the sweep still seeds drivers from the rows',
    p.divTruckLists.drivers.includes('Thomas, Jason'), JSON.stringify(p.divTruckLists.drivers));
  assert('and the dismissals survive it',
    p.divTruckLists.notDrivers.join('|') === 'officeacct',
    JSON.stringify(p.divTruckLists.notDrivers));
}

console.log('\n[what comes back from the server]');
{
  const p = newPage({ lists: freshLists() });
  assert('a stored list of dismissals is taken as one',
    p._normNotDrivers(['officeacct', 'shared']).join('|') === 'officeacct|shared');
  assert('blanks and repeats are dropped',
    p._normNotDrivers(['a', ' a ', '', null, 'A', 'b']).join('|') === 'a|b',
    p._normNotDrivers(['a', ' a ', '', null, 'A', 'b']).join('|'));
  assert('and anything that is not a list reads as none',
    p._normNotDrivers(undefined).length === 0 && p._normNotDrivers({ a: 1 }).length === 0);
}

console.log('\n[the strip, as the panel writes it]');
{
  const { html, tabs } = renderPanel({
    lists: freshLists({ drivers: ['Barr, Michael', 'Thomas, Jason'] }),
    users: [
      { id: 1, username: 'barrmike' }, { id: 2, username: 'wetzeljohn' },
      { id: 3, username: 'thomasjason' },
    ],
    logins: { thomasjason: 'Thomas, Jason' },
  });

  assert('the drivers list says how many sign-ins have no name on it',
    /2 sign-ins with no name on this list/.test(html), html.slice(0, 200));
  assert('and says what that costs the driver',
    /empty schedule/.test(html));
  assert('a sign-in it can place is offered as the pairing it would make',
    /barrmike[\s\S]{0,120}Barr, Michael[\s\S]{0,200}linkLoginToDriver\('barrmike','Barr, Michael'\)/.test(html));
  assert('one it cannot gets a box for the name instead',
    /wetzeljohn[\s\S]{0,300}id="lists-login-name-1"/.test(html));
  assert('shown in the shape the office writes names in',
    /placeholder="Last, First"/.test(html));
  assert('and one button that does both halves',
    /addDriverFromLogin\('wetzeljohn',1\)[\s\S]{0,200}Add &amp; link/.test(html));
  assert('each can be answered "not a driver"',
    /dismissLoginCandidate\('wetzeljohn'\)/.test(html));
  assert('an already-linked sign-in is not offered',
    !/thomasjason/.test(html), 'thomasjason should not appear on the drivers tab');

  // Nobody opens a list to check it is still complete, so the count is on the
  // tab, in the colour the page uses for "look at this".
  assert('the tab strip carries the count',
    /Drivers<span class="n">2<\/span><span class="n" style="color:var\(--amber\)[^"]*">\+2</.test(tabs), tabs);
  assert('and says what it means on hover',
    /2 sign-ins with no name here/.test(tabs), tabs);
}

console.log('\n[a name with an apostrophe in it]');
{
  // A guessed name reaches an onclick as a JS string literal inside an HTML
  // attribute, so it needs both escapes — the same thing that once stopped
  // "Kinkead's" being deletable at all.
  const { html, page } = renderPanel({
    lists: freshLists({ drivers: ["O'Brien, Dan"] }),
    users: [{ id: 1, username: 'obriendan' }],
  });
  assert('it is still guessed at', /O&#039;Brien|O&#39;Brien|O&apos;Brien/.test(html) || /O'Brien/.test(html));
  assert('and the apostrophe cannot break the call',
    /linkLoginToDriver\('obriendan','O(&#0?39;|&apos;|\\')Brien, Dan'\)/.test(html),
    (html.match(/linkLoginToDriver\([^)]*\)/) || [''])[0]);
  // The proof it round-trips: the link the button would make is the name on
  // the list, apostrophe and all.
  page.linkLoginToDriver('obriendan', "O'Brien, Dan");
  assert('and links to the name as it is written',
    page.driverLoginMap.obriendan === "O'Brien, Dan", JSON.stringify(page.driverLoginMap));
}

console.log('\n[the strip when there is nothing to say]');
{
  const clean = renderPanel({
    lists: freshLists({ drivers: ['Barr, Michael'] }),
    users: [{ id: 1, username: 'barrmike' }],
    logins: { barrmike: 'Barr, Michael' },
  });
  assert('a list with every sign-in behind it says nothing at all',
    !/no name on this list/.test(clean.html));
  assert('and the tab carries no count', !/\+\d/.test(clean.tabs), clean.tabs);

  // An empty strip and one that has not loaded are different things, and only
  // one of them is a statement about the list.
  const early = renderPanel({
    lists: freshLists({ drivers: ['Barr, Michael'] }),
    users: [{ id: 1, username: 'wetzeljohn' }], loaded: false,
  });
  assert('nothing is claimed before the sign-ins are in hand',
    !/no name on this list/.test(early.html) && !/\+\d/.test(early.tabs));
}

console.log('\n[dismissed sign-ins keep a way back]');
{
  const { html } = renderPanel({
    lists: freshLists({ drivers: ['Barr, Michael'], notDrivers: ['officeacct'] }),
    users: [{ id: 1, username: 'officeacct' }],
  });
  assert('they fold away rather than sitting under the list for ever',
    /1 sign-in marked not a driver/.test(html));
  assert('and are not offered while they are there',
    !/lists-login-name-0/.test(html));
}

console.log('\n[the filter runs over the strip too]');
{
  // The filter is how you are looking, not a claim about the list — so it
  // reaches the strip the same way it reaches the names above it, and matches
  // on either half of a pairing.
  const state = {
    lists: freshLists({ drivers: ['Barr, Michael'] }),
    users: [{ id: 1, username: 'barrmike' }, { id: 2, username: 'wetzeljohn' }],
  };
  const { page } = renderPanel(state);
  const shown = () => { page.renderListsPanel(); return page.document.getElementById('lists-panel-body').innerHTML; };
  const tabs  = () => page.document.getElementById('lists-tabs').innerHTML;

  page.listsSearch('wetzel');
  assert('a filter narrows the strip to what was asked for',
    /wetzeljohn/.test(shown()) && !/barrmike/.test(shown()));
  assert('and the tab count narrows with it', /\+1</.test(tabs()), tabs());

  // Matched on the driver half as readily as the username half.
  page.listsSearch('Michael');
  assert('a guess is found by the driver it names',
    /barrmike/.test(shown()) && !/wetzeljohn/.test(shown()));

  page.listsSearch('');
  assert('and clearing it puts both back',
    /wetzeljohn/.test(shown()) && /barrmike/.test(shown()));
  assert('with the full count on the tab', /\+2</.test(tabs()), tabs());
}

console.log('\n[the sign-ins tab points at where a missing name gets added]');
{
  const { html } = renderPanel({
    tab: 'logins',
    lists: freshLists({ drivers: ['Barr, Michael'] }),
    users: [{ id: 1, username: 'wetzeljohn' }],
  });
  assert('it names the tab that can fix it',
    /listsOpenTab\('drivers'\)/.test(html), html.slice(0, 400));
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
