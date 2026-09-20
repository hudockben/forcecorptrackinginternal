#!/usr/bin/env node
'use strict';
/**
 * Front-end test for purchase-orders.html — the central purchasing page.
 *
 * Run: node scripts/test-po-page.js
 *
 * Two halves, the same shape as test-documents-frontend.js:
 *
 *  1. Wiring read from the source. The page is registered in half a dozen
 *     places — the division catalogue, the permission editor, the auth lists —
 *     and a division that is half-registered fails in a way nobody sees until
 *     somebody cannot log in to it.
 *
 *  2. The page's OWN functions, lifted and run. The money and the cascade are
 *     what a mistake here costs: an order charged to the wrong job, or a tax
 *     that disagrees with the division tab showing the same order.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM } = require('jsdom');
const { requireFn, sliceSource } = require('./lib/fn-source');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

let failed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail) console.error('      ' + String(detail).slice(0, 400));
};

const PAGE = read('purchase-orders.html');

// The line math sits on top of the page's own number reading — a comma in a
// money field is read the same way here, in the division tabs and on the
// server. Any context that runs lineAmt / lineTax needs these three lifted
// with it, so they are named once rather than in each sandbox.
const NUM_FNS = ['normalizeNumeric', 'num', 'num0'];

// ── 1. Registration ────────────────────────────────────────────────────────
console.log('\n[the division is registered everywhere it has to be]');
{
  const auth = read('api/lib/auth.js');
  assert('in the canonical division list',   /const ALL_DIVISIONS = \[[^\]]*'purchase_orders'/.test(auth));
  assert('with the job divisions it buys for',
    /const PO_SOURCE_DIVISIONS = \['turf', 'paving', 'kiewit'\]/.test(auth));

  ['api/auth/login.js', 'api/auth/verify.js', 'api/company/users.js',
   'api/admin/users.js', 'api/admin/companies.js'].forEach(f => {
    assert(`${f} accepts the division`, read(f).includes("'purchase_orders'"));
  });

  const divs = read('divisions.html');
  assert('the catalogue has a card for it',   /purchase_orders: \{[\s\S]{0,400}href:\s+'purchase-orders\.html'/.test(divs));
  assert('the card is marked built',          /href:\s+'purchase-orders\.html',\s*\n\s*built: true/.test(divs));
  assert('the permission editor lists it',    /id="mu-role-purchase_orders"/.test(divs));
  assert('it gets the full five-level scale',
    /DIV_KEYS_FULL_SCALE = \[[^\]]*'purchase_orders'\]/.test(divs));
  assert('the user table has a column for it', /title="Purchase Orders \(central purchasing\)">POs<\/th>/.test(divs));

  // The user table is table-layout: fixed with a <colgroup>, and it does NOT
  // scroll sideways. Three things have to stay in step or a column silently
  // loses its width — which is how adding the POS header without a matching
  // <col> slid c-act onto it and collapsed Actions, Edit button and all, to
  // nothing. None of it is visible in the markup; it only shows on screen.
  const dom = new JSDOM(divs);
  const table = dom.window.document.querySelector('.user-table');
  const cols  = [...table.querySelectorAll('colgroup col')];
  const ths   = [...table.querySelectorAll('thead th')];

  assert('every header column has a <col> of its own',
    cols.length === ths.length, `cols=${cols.length} headers=${ths.length}`);
  assert('and Actions is still the last one, not a division',
    cols[cols.length - 1].className === 'c-act', cols[cols.length - 1].className);
  assert('there is one c-div per division column',
    cols.filter(c => c.className === 'c-div').length === ths.length - 2);

  // Over 100% is scaled down silently, so it does not break outright — it just
  // squeezes every column and stops meaning what the stylesheet says.
  const pct = { 'c-user': 12, 'c-div': 4.5882, 'c-act': 10 };
  Object.entries(pct).forEach(([cls, want]) => {
    const re = new RegExp('col\\.' + cls + '\\s*\\{\\s*width:\\s*([\\d.]+)%');
    const got = (divs.match(re) || [])[1];
    assert(`${cls} is still ${want}%`, Number(got) === want, `got ${got}`);
  });
  const total = cols.reduce((n, c) => n + (pct[c.className] || 0), 0);
  assert('the column widths add to 100%', Math.abs(total - 100) < 0.001, total.toFixed(3) + '%');

  // "Loading…" sits short of the table's width without this — invisible until
  // the list is empty.
  const colspan = (divs.match(/<tr><td colspan="(\d+)" class="mu-empty-cell">/) || [])[1];
  assert('the empty-state colspan matches the header',
    Number(colspan) === ths.length, `colspan=${colspan} headers=${ths.length}`);
}

console.log('\n[the schema lets the new division exist]');
{
  const sql = read('neon-schema.sql');
  assert('purchase_orders rows may carry it',
    /purchase_orders_division_chk\s+CHECK \(division IN \([^)]*'purchase_orders'\)\)/.test(sql));
  // A receipt on a general order is filed under purchasing, so its folder and
  // document rows need the value too — and the CHECK would reject them.
  assert('document folders may carry it',
    /project_folders_division_chk[\s\S]{0,200}'purchase_orders'\)\)/.test(sql));
  assert('documents may carry it',
    /project_documents_division_chk[\s\S]{0,200}'purchase_orders'\)\)/.test(sql));
  assert('the mirror records who raised an order',
    /ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS origin TEXT;/.test(sql));
}

// ── 2. Page wiring ─────────────────────────────────────────────────────────
console.log('\n[purchase-orders.html]');
assert('it declares itself as the purchasing division',
  /const DIVISION = 'purchase_orders';/.test(PAGE));
assert('it guards on having come through the division selector',
  /if \(fctDivision !== DIVISION\) \{\s*window\.location\.replace\('divisions\.html'\);/.test(PAGE));
// fctUser.role is the caller's TURF role. Reading it here would answer about
// the wrong division in both directions.
assert('permissions come from the per-division map, not the turf role',
  // The map is consulted first and, when it exists, decides on its own: every
  // path out of that branch returns, so the flat role below is unreachable for
  // a token that has one. That is the trap — fctUser.role is the caller's TURF
  // role, and reading it for another division answers about the wrong one in
  // both directions.
  /const dr = fctUser\.divisionRoles;\s*\n\s*if \(dr && typeof dr === 'object'\) \{\s*\n\s*const r = dr\[division\];\s*\n\s*return \(r && r !== 'no_access'\) \? r : 'no_access';\s*\n\s*\}/.test(PAGE));

assert('it reads the catalogue from one endpoint, not the project blobs',
  PAGE.includes("api('GET', '/po-catalog')") && !/fct_paving_project_/.test(PAGE));
assert('it saves one order at a time',
  /api\('POST', qs, \{\s*purchaseOrder: poPayload\(po\),/.test(PAGE));

// This is the invariant the whole design rests on. A full-list PUT from here
// would erase whatever the division's own tab had saved since this page loaded.
assert('it NEVER uses the full-list PUT',
  !/'PUT',\s*'\/purchase-orders/.test(PAGE) && !/purchase-orders\?division=[^']*',\s*\{\s*method:\s*'PUT'/.test(PAGE));

assert('a re-tied order names the list it is leaving',
  /'&from=' \+ encodeURIComponent\(from\)/.test(PAGE));
assert('receipts are filed in the ORDER\'s division',
  /const division = po\._division;/.test(PAGE));
assert('opening a receipt names its order, so the carve-out can apply',
  /'&poId=' \+ encodeURIComponent\(poId\)/.test(PAGE));
// NOT capture="environment" on the receipt input. It jumps straight to the rear
// camera, and on iOS that is all it offers — a receipt photographed before
// signing in, or one a driver sent through, could not be used at all. Without
// it both phones still show the camera as the first option in the chooser.
assert('the receipt input does not force the camera',
  !/id="receipt-capture"[^>]*capture=/.test(PAGE));
assert('photos are downscaled before they are sent anywhere',
  /downscaleImage\(file, 1600\)/.test(PAGE));
assert('the scan endpoint is given the vendor list to match against',
  /vendors: \(catalog\.vendors \|\| \[\]\)\.map\(v => v\.name\)/.test(PAGE));
assert('a phone gets cards instead of the thirteen-column table',
  /@media \(max-width: 860px\)[\s\S]{0,400}\.table-wrap \{ display: none; \}/.test(PAGE));

// ── 3. The page's own functions ────────────────────────────────────────────
console.log('\n[line math agrees with the division tabs]');
{
  const ctx = vm.createContext({});
  NUM_FNS.concat(['lineAmt', 'lineTaxPct', 'lineTax', 'recalcLineTax', 'poTotals']).forEach(name => {
    vm.runInContext(requireFn(PAGE, name, 'purchase-orders.html'), ctx);
  });
  const run = expr => vm.runInContext(expr, ctx);

  assert('amount is qty × unit cost',
    run("lineAmt({qty:'4', unit_cost:'2.5'})") === 10);
  assert('a percentage tax is applied on top of the amount',
    Math.abs(run("lineTax({qty:'10', unit_cost:'10', tax_pct:'6'})") - 6) < 1e-9);
  assert('a line saved before the percentage existed keeps its dollars',
    run("lineTax({qty:'10', unit_cost:'10', tax:'4.44'})") === 4.44);

  // Clearing the percentage has to zero the stored dollars too, or the tax the
  // user just removed keeps being charged to the job.
  run("var L = {qty:'10', unit_cost:'10', tax:'6', tax_pct:''}; recalcLineTax(L);");
  assert('clearing the percentage zeroes the stored dollars', run('L.tax') === '');
  assert('and the tax then reads as nothing',                 run('lineTax(L)') === 0);

  run("var M = {qty:'10', unit_cost:'10', tax:'', tax_pct:'7'}; recalcLineTax(M);");
  assert('a percentage writes the dollars back', Math.abs(parseFloat(run('M.tax')) - 7) < 1e-9);

  // A legacy line has no tax_pct key AT ALL — recalc must leave it alone
  // rather than zeroing a figure it cannot reproduce.
  run("var N = {qty:'10', unit_cost:'10', tax:'3.21'}; recalcLineTax(N);");
  assert('a legacy line is left alone by recalc', run('N.tax') === '3.21');

  const tot = run("poTotals({lines:[{qty:'2',unit_cost:'10',tax_pct:'5'},{qty:'1',unit_cost:'20',tax_pct:'5'}]})");
  assert('order totals sum the deliveries', tot.qty === 3 && tot.amt === 40 && Math.abs(tot.total - 42) < 1e-9);
}

console.log('\n[the cascade]');
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const ctx = vm.createContext({
    window: dom.window, document: dom.window.document, console,
  });
  // The catalogue shape /api/po-catalog answers with.
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    let sourceDivs = [
      { division: 'turf',   label: 'Turf Management', projects: [
        { id: 't1', name: 'Turf Job', jobNumber: '100', codes: [
          { cost_code: '420', sub_code: 'Base', description: 'Stone base' } ] } ] },
      { division: 'paving', label: 'Paving', projects: [
        { id: 'p1', name: 'Paving Job', jobNumber: '200', codes: [] } ] },
    ];
    let purchaseOrders = [];
    // loadPurchaseOrders adds a key here once that division's list has come
    // back. A division absent from it has not loaded, and cannot be numbered.
    const loadedLists = new Set(['turf', 'paving', 'kiewit']);
  `, ctx);
  ['listDivs', 'divMeta', 'divLabel', 'projectsFor', 'projectFor', 'codesFor', 'codeLabel', 'codeValue', 'nextPONumber']
    .forEach(name => vm.runInContext(requireFn(PAGE, name, 'purchase-orders.html'), ctx));
  const run = expr => vm.runInContext(expr, ctx);

  assert('a division resolves to its jobs',   run("projectsFor('turf').length") === 1);
  assert('the general list has no jobs',      run("projectsFor(GENERAL).length") === 0);
  assert('codes come from the job\'s bid items', run("codesFor('turf','t1').length") === 1);
  assert('a job with no bid items offers no codes', run("codesFor('paving','p1').length") === 0);
  assert('a code is labelled cost / sub — description',
    run("codeLabel({cost_code:'420', sub_code:'Base', description:'Stone base'})") === '420 / Base — Stone base');
  assert('and valued as a cost||sub pair',
    run("codeValue({cost_code:'420', sub_code:'Base'})") === '420||Base');
  assert('the general list is labelled General', run("divLabel(GENERAL)") === 'General');

  // Numbering continues THAT division's own sequence, because its own tab
  // numbers off the same list — two parallel sequences would collide.
  run(`purchaseOrders = [
    { id:'a', po_number:'PO-0003', _division:'turf' },
    { id:'b', po_number:'PO-0011', _division:'paving' },
  ];`);
  assert('numbering continues the division\'s own sequence', run("nextPONumber('turf')") === 'PO-0004');
  assert('each division numbers independently',              run("nextPONumber('paving')") === 'PO-0012');
  assert('an empty list starts at one',                      run("nextPONumber('kiewit')") === 'PO-0001');
  // A list whose fetch failed is NOT an empty list. Numbering off it would hand
  // out a PO-0001 that division may already be using.
  run("loadedLists.delete('kiewit')");
  assert('a list that never loaded refuses to number',       run("nextPONumber('kiewit')") === '');
  run("loadedLists.add('kiewit')");
}

console.log('\n[re-tying an order]');
{
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const saves = [];
  const ctx = vm.createContext({ window: dom.window, document: dom.window.document, console });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    let sourceDivs = [{ division:'turf', label:'Turf', projects:[] }];
    let purchaseOrders = [{
      id:'x', po_number:'PO-0007', _division:'paving',
      project_id:'p1', cost_code:'420', sub_code:'Base', lines:[],
    }];
    const perm = { canEdit: true, canDelete: true };
    // These blocks exercise the cascade and the move, not the rights — the
    // rights have their own section above.
    function capsFor() { return { canEdit: true, canDelete: true }; }
    const saves = [];
    const loadedLists = new Set(['turf', 'paving', 'kiewit']);
    function savePO(po, opts) { saves.push({ id: po.id, immediate: !!(opts && opts.immediate) }); }
    function render() {}
    const toasted = [];
    function toast(msg) { toasted.push(msg); }
  `, ctx);
  ['listDivs', 'divMeta', 'divLabel', 'projectsFor', 'projectFor', 'codesFor', 'nextPONumber', 'setDivision', 'setProject', 'setSubCode']
    .forEach(name => vm.runInContext(requireFn(PAGE, name, 'purchase-orders.html'), ctx));
  const run = expr => vm.runInContext(expr, ctx);

  run("setDivision('x','turf')");
  const po = run('purchaseOrders[0]');
  assert('the order moves to the new division', po._division === 'turf');
  // A paving job id means nothing in turf. Keeping it would silently cost a
  // job that does not exist — or worse, one that does.
  assert('the old division\'s job is cleared',  po.project_id === '');
  assert('and its codes with it',               po.cost_code === '' && po.sub_code === '');
  // PO-0007 arriving in an empty turf list becomes PO-0001, not PO-0008: it
  // must not count itself when it has already been moved into that list.
  assert('it is renumbered into the new list',  po.po_number === 'PO-0001');
  assert('and saved straight away, not debounced',
    run('saves.length') === 1 && run('saves[0].immediate') === true);

  // Changing the job clears the codes for the same reason.
  run("purchaseOrders[0].project_id = 'a'; purchaseOrders[0].cost_code='1'; purchaseOrders[0].sub_code='2';");
  run("setProject('x','b')");
  assert('changing the job clears the codes',
    run('purchaseOrders[0].cost_code') === '' && run('purchaseOrders[0].sub_code') === '');

  run("setSubCode('x','430||Paving')");
  assert('a picked code splits into cost and sub',
    run('purchaseOrders[0].cost_code') === '430' && run('purchaseOrders[0].sub_code') === 'Paving');
  run("setSubCode('x','')");
  assert('clearing the picker clears both',
    run('purchaseOrders[0].cost_code') === '' && run('purchaseOrders[0].sub_code') === '');

  // A list that never loaded cannot be numbered against — nextPONumber says so
  // with ''. Storing that put the order live in the other division's tab with a
  // BLANK PO number, which nothing on this page or the division tabs can set,
  // so every order re-tied that way read the same and any report keying on the
  // number conflated them. The move has to be refused outright, and refused
  // before anything is mutated.
  run("purchaseOrders[0]._division = 'paving'; purchaseOrders[0].project_id = 'p1';");
  run("purchaseOrders[0].cost_code = '430'; purchaseOrders[0].sub_code = 'Paving';");
  run("purchaseOrders[0].po_number = 'PO-0007';");
  run("loadedLists.delete('kiewit'); saves.length = 0; toasted.length = 0;");
  run("setDivision('x','kiewit')");
  const stuck = run('purchaseOrders[0]');
  assert('a move into a list that never loaded is refused',
    stuck._division === 'paving', JSON.stringify(stuck));
  assert('and nothing about the order is touched on the way out',
    stuck.po_number === 'PO-0007' && stuck.project_id === 'p1' &&
    stuck.cost_code === '430' && stuck.sub_code === 'Paving', JSON.stringify(stuck));
  assert('nor is a save queued for it', run('saves.length') === 0);
  assert('and the user is told why', run('toasted.length') === 1 &&
    /could not be loaded/.test(run('toasted[0]')), JSON.stringify(run('toasted')));
}

console.log('\n[the payload sent to the server]');
{
  const ctx = vm.createContext({});
  vm.runInContext(vm.runInContext.length ? '' : '', ctx);
  vm.runInContext(requireFn(PAGE, 'poPayload', 'purchase-orders.html'), ctx);
  const out = vm.runInContext(`poPayload({
    id:'x', po_number:'PO-1', title:'Stone', _division:'paving', _scratch:1, lines:[],
  })`, ctx);
  // _division is where the order is STORED, which the URL already says. Letting
  // it into the blob would put a second, drifting answer in every order the
  // division tabs round-trip.
  assert('page-local fields never reach the blob',
    !('_division' in out) && !('_scratch' in out), JSON.stringify(out));
  assert('the real fields do',  out.id === 'x' && out.po_number === 'PO-1' && out.title === 'Stone');
  assert('and it is stamped as raised by purchasing', out.origin === 'purchasing');
}

console.log('\n[filtering]');
{
  const ctx = vm.createContext({ console });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    let sourceDivs = [
      { division:'turf',   label:'Turf Management', projects:[{id:'t1', name:'Ball Field', jobNumber:'100', codes:[]}] },
      { division:'paving', label:'Paving',          projects:[] },
    ];
    let search = '';
    let filters = { division:'', status:'', job:'', vendor:'' };
    let purchaseOrders = [
      { id:'1', po_number:'PO-0001', _division:'turf',   project_id:'t1', supplier:'Acme',  status:'pending',  title:'Stone', lines:[] },
      { id:'2', po_number:'PO-0002', _division:'paving', project_id:'',   supplier:'Bolt',  status:'approved', title:'Bolts', lines:[] },
      { id:'3', po_number:'PO-0003', _division:GENERAL,  project_id:'',   supplier:'Acme',  status:'pending',  title:'Office paper', lines:[] },
    ];
  `, ctx);
  ['listDivs', 'divMeta', 'divLabel', 'projectFor', 'projectsFor', 'visiblePOs'].forEach(name =>
    vm.runInContext(requireFn(PAGE, name, 'purchase-orders.html'), ctx));
  const ids = expr => {
    vm.runInContext(expr, ctx);
    return vm.runInContext('visiblePOs().map(p => p.id).join(",")', ctx);
  };

  assert('no filters shows everything',        ids("filters={division:'',status:'',job:'',vendor:''}; search='';") === '1,2,3');
  assert('by division',                        ids("filters.division='paving';") === '2');
  assert('the general list filters like one',  ids("filters.division=GENERAL;") === '3');
  assert('by status',                          ids("filters.division=''; filters.status='pending';") === '1,3');
  assert('orders tied to a job',               ids("filters.status=''; filters.job='job';") === '1');
  // A general order is a finished state, not an incomplete one — it has to be
  // findable as a category of its own.
  assert('orders tied to no job',              ids("filters.job='general';") === '2,3');
  assert('by vendor',                          ids("filters.job=''; filters.vendor='Acme';") === '1,3');
  assert('search covers the job name',         ids("filters.vendor=''; search='ball field';") === '1');
  assert('search covers the division label',   ids("search='paving';") === '2');
  assert('search covers the PO number',        ids("search='PO-0002';") === '2');
  assert('search is case-insensitive',         ids("search='STONE';") === '1');
  assert('filters combine',                    ids("search=''; filters.vendor='Acme'; filters.status='pending';") === '1,3');
}

console.log('\n[rights are per division, not per page]');
{
  // The bug from the field: a turf/paving administrator with NO purchasing
  // role opened this page, raised a general order, and could neither save nor
  // delete it — the row sat there permanently. The page had worked its rights
  // out ONCE and, finding no purchasing role, fallen back to fctUser.role,
  // which is the caller's TURF role. So it showed a delete button the server
  // refused.
  assert('the turf-role fallback is gone',
    !/else if \(fctUser && fctUser\.role\) level = fctUser\.role;/.test(PAGE));
  // ...but the LEGACY fallback is not the same thing and must stay. It reads
  // fctUser.role only when there is no divisionRoles map at all, which is what
  // levelFor() does on the server; the bug above read it when a map existed.
  assert('the legacy fallback only fires when there is no map at all',
    /if \(dr && typeof dr === 'object'\) \{[\s\S]{0,160}return \(r && r !== 'no_access'\) \? r : 'no_access';/.test(PAGE));
  assert('rights are computed per division', /function capsFor\(division\)/.test(PAGE));
  assert('the page\'s source-division list matches the server\'s',
    /const PO_SOURCE = \['turf', 'paving', 'kiewit'\];/.test(PAGE) &&
    JSON.stringify(require('../api/lib/auth').PO_SOURCE_DIVISIONS) === JSON.stringify(['turf','paving','kiewit']));
  assert('and GENERAL is declared before capsFor reads it',
    PAGE.indexOf('const GENERAL') < PAGE.indexOf('function capsFor'));

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const ctx = vm.createContext({ document: dom.window.document, console });
  vm.runInContext(`
    const DIVISION = 'purchase_orders';
    const GENERAL  = 'purchase_orders';
    // Lifted from the page rather than restated, so the two cannot drift.
    const PO_SOURCE = ['turf', 'paving', 'kiewit'];
    const PO_SOURCE_LABELS = { turf: 'Turf Management', paving: 'Paving', kiewit: 'Kiewit Pinetree' };
    let sourceDivs = [{ division: 'paving', label: 'Paving', projects: [] }];
    let fctUser = null;
  `, ctx);
  ['_levelIn', 'capsFor'].forEach(n => vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), ctx));
  const caps = (user, div) => {
    vm.runInContext('fctUser = ' + JSON.stringify(user) + ';', ctx);
    return vm.runInContext('capsFor(' + JSON.stringify(div) + ')', ctx);
  };

  // Exactly the user from the screenshot.
  const turfAdmin = { role: 'admin', divisionRoles: { turf: 'admin', paving: 'admin' } };
  assert('a turf admin with no purchasing role can still work paving orders',
    caps(turfAdmin, 'paving').canDelete === true);
  // ...and is NOT offered a delete the server would refuse.
  assert('but is not offered delete on the general list',
    caps(turfAdmin, 'purchase_orders').canDelete === false);
  assert('nor edit on it',
    caps(turfAdmin, 'purchase_orders').canEdit === false);

  const buyer = { divisionRoles: { purchase_orders: 'level3' } };
  assert('a purchasing level3 reaches the general list', caps(buyer, 'purchase_orders').canDelete === true);
  assert('and the job divisions',                        caps(buyer, 'paving').canDelete === true);
  assert('but not a division outside the carve-out',     caps(buyer, 'dust').canDelete === false);

  const viewer = { divisionRoles: { purchase_orders: 'level1' } };
  assert('a view-only purchasing user edits nothing', caps(viewer, 'paving').canEdit === false);
  const inserter = { divisionRoles: { purchase_orders: 'level2' } };
  assert('level2 edits but does not delete',
    caps(inserter, 'paving').canEdit === true && caps(inserter, 'paving').canDelete === false);
  assert('a platform admin reaches everything', caps({ isPlatformAdmin: true }, 'paving').canDelete === true);

  // These must agree with poCapabilities on the server, or the page offers
  // buttons the API refuses — which is the whole bug.
  // users.division_roles is nullable and login puts `divisionRoles: null` in the
  // token when it is unset, so a token with no map at all is a real shape — and
  // the server answers it from the flat role and allowedDivisions. Reading only
  // the map made this page read-only for such a user while the API accepted
  // every write they made.
  const legacyAdmin  = { role: 'admin',  allowedDivisions: ['turf', 'paving', 'purchase_orders'] };
  const legacyL3     = { role: 'level3', allowedDivisions: ['turf', 'paving'] };
  const legacyL2     = { role: 'level2', allowedDivisions: ['turf'] };
  const legacyL1     = { role: 'level1', allowedDivisions: ['turf', 'paving'] };
  const legacyNoList = { role: 'admin' };
  assert('a legacy token is not locked out of the lists it reaches',
    caps(legacyAdmin, 'paving').canDelete === true);
  assert('...nor of the general list when it reaches that too',
    caps(legacyAdmin, 'purchase_orders').canDelete === true);
  assert('but a division outside its list stays shut',
    caps(legacyL2, 'paving').canEdit === false);
  assert('and with no list at all it is turf only, as the server has it',
    caps(legacyNoList, 'turf').canDelete === true &&
    caps(legacyNoList, 'paving').canEdit === false);

  // These must agree with poCapabilities on the server, or the page offers
  // buttons the API refuses — or, the other way round, withholds ones it would
  // have allowed. Every shape a token really comes in, against every division
  // this page shows.
  const serverCaps = require('../api/lib/auth').poCapabilities;
  const SHAPES = [turfAdmin, buyer, viewer, inserter, { isPlatformAdmin: true },
                  legacyAdmin, legacyL3, legacyL2, legacyL1, legacyNoList];
  const DIVS = ['turf', 'paving', 'kiewit', 'purchase_orders', 'dust'];
  let disagreed = 0;
  SHAPES.forEach(u => DIVS.forEach(d => {
    const c = caps(u, d), sv = serverCaps(u, d);
    if (c.canEdit !== sv.canUpload || c.canDelete !== sv.canManage) {
      disagreed++;
      console.log('      ' + JSON.stringify(u) + ' on ' + d +
        ' client=' + JSON.stringify(c) +
        ' server=' + JSON.stringify({ canUpload: sv.canUpload, canManage: sv.canManage }));
    }
  }));
  assert(`client and server agree on all ${SHAPES.length * DIVS.length} token/division combinations`,
    disagreed === 0, disagreed + ' disagreed');
}

console.log('\n[the division tabs and a crafted id]');
{
  // The mirror image of this page's own jsAttr/idAttr hardening. These pages
  // already carry escJs for exactly this; the purchase-order table never used
  // it, so a crafted id stored through the full-list PUT — which validates
  // neither po.id nor line.id — ran in a supervisor's authenticated session.
  ['tracker.html', 'paving.html', 'kiewit-pinetree.html'].forEach(f => {
    const src = read(f);
    // Both spellings. The inp()/selOpts() helpers rename the ids to poId and
    // lineId on the way in, and checking only `po.id` declared those four
    // data- attributes clean while they were still interpolating raw — a `"`
    // in an id closed the attribute and the rest of it became markup.
    assert(`${f}: no raw id reaches the purchase-order markup`,
      !/\$\{po\.id\}|\$\{line\.id\}|\$\{poId\}|\$\{lineId\}/.test(src));
    assert(`${f}: handler arguments go through escJs`,
      /_togglePOLines\('\$\{escJs\(po\.id\)\}'\)/.test(src) &&
      /deletePOLine\('\$\{escJs\(po\.id\)\}','\$\{escJs\(line\.id\)\}'\)/.test(src) &&
      /addPOLine\('\$\{escJs\(po\.id\)\}'\)/.test(src));
    assert(`${f}: id and data- attributes go through esc`,
      /id="po-qty-\$\{esc\(po\.id\)\}"/.test(src) && /data-po-id="\$\{esc\(po\.id\)\}"/.test(src));
    // esc() covers ONE layer: the quote that would end an attribute. A value
    // reaching a TEXT node through it is raw HTML — `<img src=x onerror=…>`
    // comes back unchanged — and central purchasing can write a title or a
    // supplier straight into this division's blob without holding a role here.
    {
      const ectx = vm.createContext({});
      ['esc', 'escT'].forEach(n => vm.runInContext(requireFn(src, n, f), ectx));
      const payload = '<img src=x onerror=alert(1)>';
      const e  = vm.runInContext('esc(' + JSON.stringify(payload) + ')', ectx);
      const et = vm.runInContext('escT(' + JSON.stringify(payload) + ')', ectx);
      assert(`${f}: esc alone does not make a payload safe as text`, e === payload, e);
      assert(`${f}: escT does`, !/[<>]/.test(et), et);
      assert(`${f}: and it still escapes the ampersand`,
        vm.runInContext("escT('a & b')", ectx) === 'a &amp; b');
    }
    // Every purchase-order value that lands in a text node goes through escT.
    ['po.po_number', 'po.title', 'po.supplier', 'po.status', 'po.status_changed_by']
      .forEach(field => {
        const textSinks = (src.match(new RegExp('>\\$\\{esc\\(' + field.replace('.', '\\.'), 'g')) || []);
        assert(`${f}: ${field} never reaches a text node through esc`,
          textSinks.length === 0, JSON.stringify(textSinks));
      });
    // ...and they are actually there, rather than the field simply being absent.
    // Counted loosely at the call, because some of these cells go on to
    // `|| dash` before the brace closes.
    [['po.po_number', 3], ['po.title', 2], ['po.supplier', 1], ['po.status ', 1]]
      .forEach(([field, least]) => {
        const n = (src.match(new RegExp('\\$\\{escT\\(' + field.replace('.', '\\.'), 'g')) || []).length;
        assert(`${f}: ${field} reaches its text cells through escT (${n})`, n >= least, String(n));
      });
    // A <option> label is a text node too; its value is the attribute.
    // Built by concatenation rather than interpolation, so it is not in the
    // ${...} sweep above.
    assert(`${f}: the status-change byline is escaped as text too`,
      /escT\(po\.status_changed_by\)/.test(src) && !/esc\(po\.status_changed_by\)/.test(src));
    assert(`${f}: an option's label is escaped as text, its value as an attribute`,
      /<option value="\$\{esc\(v\)\}" \$\{v===current\?'selected':''\}>\$\{escT\(l\)\}<\/option>/.test(src));

    assert(`${f}: the input helpers escape the ids they are handed`,
      (src.match(/data-po-id="\$\{esc\(poId\)\}" data-line-id="\$\{esc\(lineId\)\}"/g) || []).length === 2 &&
      (src.match(/data-po-id="\$\{esc\(poId\)\}" data-po-field=/g) || []).length === 2);
  });
}

console.log('\n[the phone]');
{
  // This page's whole point on a phone is photographing a receipt at the supply
  // counter, so the phone layout is not a nice-to-have here.

  // The list renders as cards below 860px, and the table above it. The default
  // `display:none` has to come BEFORE the media query: both rules are a single
  // class, so at equal specificity the later one wins, and declaring it after
  // hid the cards at EVERY width — the phone showed a header, a filter bar,
  // "4 orders", and then nothing at all.
  const cardsDefault = PAGE.indexOf('.cards { display: none; }');
  const phoneQuery   = PAGE.indexOf('@media (max-width: 860px)');
  assert('the cards default is declared before the phone media query',
    cardsDefault > -1 && phoneQuery > -1 && cardsDefault < phoneQuery,
    `default at ${cardsDefault}, query at ${phoneQuery}`);
  assert('and the query turns them on while turning the table off',
    /@media \(max-width: 860px\)[\s\S]{0,900}\.table-wrap \{ display: none; \}[\s\S]{0,120}\.cards \{ display: block; \}/.test(PAGE));

  // A 44px target is what both Apple's and Android's guidance ask for, and a
  // 16px font is what stops iOS Safari zooming the page in on focus — it does
  // not zoom back out, so the sheet was left scaled up and off to one side.
  const phoneBlock = PAGE.slice(phoneQuery, PAGE.indexOf('\n    }', phoneQuery));
  assert('the sheet\'s fields are thumb-sized on a phone',
    /min-height: 44px; font-size: 16px;/.test(phoneBlock), phoneBlock.slice(0, 200));
  assert('and so are its buttons, and a card\'s',
    /\.sheet-actions button, \.po-card \.card-actions button \{ min-height: 44px; \}/.test(phoneBlock));

  // Money on a phone keypad: type=number alone does not guarantee a decimal
  // point on iOS.
  ['sc-qty', 'sc-unit', 'sc-taxpct', 'sc-total'].forEach(id => {
    assert(`${id} asks for the decimal keypad`,
      new RegExp('inputmode="decimal" id="' + id + '"').test(PAGE));
  });
  // An invoice number is a code, and a vendor is a proper noun. Neither wants
  // autocorrect — "Fastenal" becoming "Fastened" is the sort of thing nobody
  // notices until the report.
  assert('the invoice field does not autocorrect',
    /id="sc-invoice" autocapitalize="characters" autocorrect="off" spellcheck="false"/.test(PAGE));
  assert('nor does the vendor field',
    /id="sc-vendor"[^>]*autocorrect="off" spellcheck="false"/.test(PAGE));

  // The page behind a sheet must not scroll with it, and must not lose the
  // reader's place either: `position: fixed` is the only thing iOS honours, and
  // it resets scroll to the top on its own.
  assert('opening a sheet locks the page behind it',
    /function lockBodyScroll\(\)/.test(PAGE) &&
    /body\.sheet-open \{ position: fixed;/.test(PAGE));
  assert('and the scroll position is put back on close',
    /_scrollUnderSheet = window\.scrollY/.test(PAGE) &&
    /window\.scrollTo\(0, _scrollUnderSheet\)/.test(PAGE));
  // Both sheets — the scan and the documents list. Counted with a boundary,
  // because "unlockBodyScroll();" contains "lockBodyScroll();".
  assert('both sheets lock and unlock',
    (PAGE.match(/(?<![A-Za-z])lockBodyScroll\(\);/g) || []).length === 2 &&
    (PAGE.match(/(?<![A-Za-z])unlockBodyScroll\(\);/g) || []).length === 2,
    JSON.stringify({
      lock:   (PAGE.match(/(?<![A-Za-z])lockBodyScroll\(\);/g) || []).length,
      unlock: (PAGE.match(/(?<![A-Za-z])unlockBodyScroll\(\);/g) || []).length,
    }));

  // The preview's job on a phone is to confirm the right receipt was
  // photographed. At a fixed 240px on a 664px screen it pushed every figure the
  // person is there to check below the fold.
  assert('the receipt preview is sized against the viewport on a phone',
    /\.receipt-preview \{ max-height: 22vh; min-height: 110px; \}/.test(phoneBlock));

  // Narrow OR short. On width alone a big phone in landscape — 932px on an
  // iPhone 15 Pro Max, 892px on a Pixel 7 Pro — went back to the thirteen-column
  // office table in a viewport 430px tall.
  assert('a phone in landscape still gets the phone layout',
    /@media \(max-width: 860px\), \(max-height: 540px\)/.test(PAGE));

  // At 200% accessibility text the fixed pair kept its second column and pushed
  // it off the screen: Invoice #, Unit Cost and Total all ran past the edge, and
  // the sheet clips rather than scrolling sideways.
  assert('the paired money fields can stack when there is no room for two',
    /grid-template-columns: repeat\(auto-fit, minmax\(9rem, 1fr\)\);/.test(PAGE));
  assert('and the sheet buttons wrap rather than pushing Cancel off the edge',
    /\.sheet-actions \{ gap: 0\.6rem; flex-wrap: wrap; \}/.test(phoneBlock));

  // The filter row is taps too, and a <select> sizes to its widest option — one
  // long supplier name made the whole page wider than the screen.
  assert('the filter row and search box are thumb-sized too',
    /\.filter-bar select, \.search, \.chip \{\s*\n\s*min-height: 44px; font-size: 16px;/.test(phoneBlock));
  assert('and a long supplier name cannot widen the page',
    /\.filter-bar select \{ max-width: 100%; flex: 1 1 8rem; min-width: 0; \}/.test(phoneBlock));

  // --muted carries the vendor, the date, the job line and every field label,
  // on a screen read outdoors. #666 measured 3.41:1 against the background,
  // under the 4.5:1 AA wants for text this small.
  assert('muted text clears AA against the page background', /--muted:     #8a8a99;/.test(PAGE));
  {
    const lum = hex => {
      const c = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const bg = (PAGE.match(/--bg:\s*(#[0-9a-f]{6})/i) || [])[1];
    const muted = (PAGE.match(/--muted:\s*(#[0-9a-f]{6})/i) || [])[1];
    const ratio = (a, b) => {
      const la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    assert('...measured, not asserted', Boolean(bg && muted) && ratio(muted, bg) >= 4.5,
      `${muted} on ${bg} = ${bg && muted ? ratio(muted, bg).toFixed(2) : '?'}:1`);
  }

  // capture="environment" jumps straight to the rear camera, and on iOS that is
  // ALL it offers — a receipt photographed before signing in, or one a driver
  // sent through, could not be used at all.
  assert('a photo already on the phone can be used',
    /<input type="file" id="receipt-capture" accept="image\/\*" style="display:none"/.test(PAGE));

  // Close was the only way out of an undecodable photo, ending the attempt.
  assert('an undecodable photo offers another one',
    /Could not read that photo[\s\S]{0,500}Another photo<\/button>/.test(PAGE));
}

console.log('\n[the receipt, when things go wrong]');
{
  // Backing out of the camera fires no `change` at all on most phones, so the
  // listener stayed attached and its promise never settled. The next photo then
  // fired EVERY listener still on the input: one receipt decoded, uploaded and
  // read once per abandoned attempt — each a paid call — with the sheets racing.
  assert('a new pick abandons the one before it',
    /if \(_pickCleanup\[inputId\]\) \{ _pickCleanup\[inputId\]\(\); \}/.test(PAGE));
  assert('and a settled pick cannot settle twice',
    /let done = false;[\s\S]{0,200}if \(done\) return;\s*\n\s*done = true;/.test(PAGE));
  // The input's own `cancel` event would be the direct way to notice a
  // dismissed picker, but a programmatic click() can raise it immediately —
  // before any chooser is shown — which kills the scan before the photo lands.
  assert('the picker does not lean on the cancel event',
    !/addEventListener\('cancel'/.test(PAGE));

  // A thumb resting on the strip beside the sheet threw the photo away with no
  // message, after the receipt may already be back in the bin.
  assert('a backdrop tap cannot destroy a scan mid-read',
    /if \(_scanBusy\) \{[\s\S]{0,160}return;\s*\n\s*\}\s*\n\s*closeScan\(\);/.test(PAGE));
  assert('but Cancel still stops it deliberately',
    /function cancelScan\(\)/.test(PAGE) && /onclick="cancelScan\(\)"/.test(PAGE));
  assert('and the flag is cleared on every way out of the read',
    (PAGE.match(/_scanBusy = false;/g) || []).length >= 3);

  // A failed read used to leave one way forward: type all seven fields. The
  // photo is still in hand, and most of these failures are the request rather
  // than the receipt.
  assert('a failed read offers the photo again',
    /function rereadScan\(\)/.test(PAGE) && /onclick="rereadScan\(\)"/.test(PAGE));
  assert('and re-reads what it already holds, not a new photo',
    /const held = scanState;[\s\S]{0,600}imageBase64: held\.dataUrl\.split\(','\)\[1\]/.test(PAGE));

  // The order saved, the photo did not, and closing threw the only copy away —
  // leaving an order that looks exactly like one that never had a receipt.
  assert('a failed attach keeps the sheet and the photo',
    /_attachRetry = \{ poId: po\.id, blob: shotBlob, filename: shotName \};/.test(PAGE));
  assert('and offers both ways out by name',
    /onclick="retryAttach\(\)"/.test(PAGE) && /onclick="discardAttach\(\)"/.test(PAGE));
  assert('the retry path does not re-save the order, only the photo',
    /async function retryAttach\(\)[\s\S]{0,700}await attachToPO\(/.test(PAGE) &&
    !/async function retryAttach\(\)[\s\S]{0,700}_savePONow\(/.test(PAGE));

  // The endpoint's own message lands on a phone screen at a supply counter.
  {
    const ep = read('api/ai/receipt-scan.js');
    assert('the scan endpoint no longer echoes the SDK error',
      !/detail: err\.message/.test(ep));
    assert('and says something a person can act on',
      /Try the photo again, or type the figures in/.test(ep) &&
      /Type the figures in — the photo still attaches/.test(ep));
  }

  // "A few seconds" set the expectation at two or three, so at fifteen the
  // reasonable conclusion is that it has hung.
  assert('the waiting state is honest about how long it takes',
    /Usually under half a minute/.test(PAGE) && !/This takes a few seconds/.test(PAGE));

  // The SDK's own defaults do not fit the function it runs in: a ten-minute
  // timeout, two retries, and a retried timeout — thirty minutes of wall clock
  // inside a 60-second maxDuration. The platform always won that race, so the
  // phone got a gateway error instead of any message from this handler.
  {
    const ep = read('api/ai/receipt-scan.js');
    const timeout = Number((ep.match(/timeout:\s*([\d_]+)/) || [])[1].replace(/_/g, ''));
    const retries = Number((ep.match(/maxRetries:\s*(\d+)/) || [])[1]);
    const budget  = Number((ep.match(/maxDuration:\s*(\d+)/) || [])[1]) * 1000;
    assert('the reader is given an explicit timeout and retry count',
      Number.isFinite(timeout) && Number.isFinite(retries));
    assert('and the worst case fits inside the function it runs in',
      timeout * (retries + 1) < budget,
      `${timeout}ms x ${retries + 1} = ${timeout * (retries + 1)}ms vs ${budget}ms`);
  }
}

console.log('\n[a cost row this page has not loaded]');
{
  // Purchasing creates the cost rows for the orders it raises, server-side. A
  // division tab that loaded the job beforehand does not have them in memory —
  // and used to give up, so a supervisor's edit updated the order and left the
  // job on the old figures.
  ['tracker.html', 'paving.html', 'kiewit-pinetree.html'].forEach(f => {
    const src = read(f);
    const fn = src.slice(src.indexOf('function _syncPOLineToRow'));
    const body = fn.slice(0, fn.indexOf('function _ensurePOLineRow'));
    assert(`${f}: an absent row is rebuilt, not abandoned`,
      !/if \(!r\) return;/.test(body) && /proj\.dailyRows\.push\(r\);/.test(body));
    assert(`${f}: and written under the id the order already names`,
      /id:\s*line\.po_row_id,/.test(body));
    // ...but only AFTER the job's rows have been read. The PUT is a full
    // upsert, so a reconstruction carries defaultDailyRow's blanks straight
    // over whatever the stored row held.
    assert(`${f}: the job's rows are read before a row is invented`,
      /if \(!proj\._drFullLoaded\)/.test(body) &&
      body.indexOf('drGetAll({ projectId: po.project_id })') < body.indexOf('...defaultDailyRow()'));

    // Its sibling had the same bail-out for the same reason: a retitled order,
    // a corrected supplier or a re-coded PO reached the order and never the job
    // whenever the row was outside the first load's ninety days.
    const header = src.slice(src.indexOf('async function _syncPOHeaderToLines'));
    // Bounded at its own closing brace — the next declaration is `async
    // function` too, so '\nfunction ' would run on past it.
    const hBody  = header.slice(0, header.indexOf('\n}\n') + 3);
    assert(`${f}: the header sync reads the job's rows too`,
      /if \(!proj\._drFullLoaded/.test(hBody) &&
      /drGetAll\(\{ projectId: po\.project_id \}\)/.test(hBody));
    assert(`${f}: and still invents nothing when the row really is absent`,
      /if \(!r\) return;/.test(hBody) && !/defaultDailyRow/.test(hBody));
    assert(`${f}: both its call sites catch`,
      (src.match(/_syncPOHeaderToLines\(po(?:, true)?\)\.catch\(/g) || []).length === 2);

    // The division tabs export the same purchase orders the purchasing page
    // does, and only that page's export had the formula guard. Its trucking
    // twin sits in the same file with the same helper and the same free-text
    // columns — a driver, a truck type, a material hauled, a note.
    const APOS = String.fromCharCode(34) + String.fromCharCode(39);
    [['exportPOCSV', '  const csvLines = ['], ['exportTRCSV', '  const lines = [']].forEach(([fn, endMark]) => {
      const csv   = src.slice(src.indexOf('function ' + fn + '()'));
      const cBody = csv.slice(0, csv.indexOf('\n}\n') + 3);
      assert(`${f}: ${fn} defuses a leading formula character`,
        /if \(\/\^\[=\+\\-@\\t\\r\]\/\.test\(t\) && !NUMERIC\.test\(t\)\)/.test(cBody), cBody.slice(0, 300));
      assert(`${f}: ${fn} leaves a plain number alone`, /const NUMERIC = /.test(cBody));
      // Run the real helper, rather than trusting that the line is present.
      const ectx = vm.createContext({});
      vm.runInContext(sliceSource(cBody, '  const NUMERIC =', endMark,
        `${f} ${fn} quoting helper`, ['NUMERIC']), ectx);
      const q = v => vm.runInContext('escape(' + JSON.stringify(v) + ')', ectx);
      assert(`${f}: ${fn} defuses a formula`, q('=HYPERLINK(1)').startsWith(APOS), q('=HYPERLINK(1)'));
      assert(`${f}: ${fn} defuses every lead character`,
        ['+WEBSERVICE(1)', '-2+3', '@SUM(A1)'].every(v => q(v).startsWith(APOS)));
      assert(`${f}: ${fn} keeps a negative amount numeric`, q('-76.50') === '"-76.50"', q('-76.50'));
      assert(`${f}: ${fn} still doubles the quote`, q('say ' + String.fromCharCode(34) + 'hi' + String.fromCharCode(34)) ===
        String.fromCharCode(34) + 'say ' + String.fromCharCode(34,34) + 'hi' + String.fromCharCode(34,34,34), q('say "hi"'));
    });
  });

}

console.log('\n[load failures do not corrupt numbering]');
{
  assert('the page records which lists came back', /let loadedLists   = new Set\(\);/.test(PAGE));
  // A list that failed is not an empty list — numbering off it starts at
  // PO-0001 in a division that already has one.
  assert('numbering refuses a list that did not load',
    /if \(!loadedLists\.has\(divKey\)\) return '';/.test(PAGE));
  assert('and a new order will not start in one',
    /const usable = d => capsFor\(d\)\.canEdit && loadedLists\.has\(d\);/.test(PAGE));
  // A catalogue failure used to collapse the page to the general list, hiding
  // every turf, paving and kiewit order while the banner said otherwise — and
  // then, once the fetch was fixed, it still collapsed every ORDER's division
  // control to a lone "General" option, reporting job-division orders as
  // general. Both come from reading sourceDivs directly, so the fallback is
  // exercised rather than matched.
  {
    const ctx = vm.createContext({ console });
    vm.runInContext(`
      const GENERAL = 'purchase_orders';
      const PO_SOURCE = ['turf', 'paving', 'kiewit'];
      const PO_SOURCE_LABELS = { turf: 'Turf Management', paving: 'Paving', kiewit: 'Kiewit Pinetree' };
      let sourceDivs = [];          // the catalogue failed
    `, ctx);
    ['listDivs', 'divMeta', 'divLabel', 'listKeys']
      .forEach(n => vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), ctx));
    const r = e => vm.runInContext(e, ctx);
    assert('a catalogue failure still fetches every list',
      JSON.stringify(r('listKeys()')) ===
      JSON.stringify(['turf', 'paving', 'kiewit', 'purchase_orders']), JSON.stringify(r('listKeys()')));
    assert('and every division is still offered, so no order is mislabelled',
      JSON.stringify(r('listDivs().map(d => d.division)')) ===
      JSON.stringify(['turf', 'paving', 'kiewit']), JSON.stringify(r('listDivs()')));
    assert('under its real name, not its key',
      r("divLabel('kiewit')") === 'Kiewit Pinetree', r("divLabel('kiewit')"));
    // The job and code pickers are the only things that genuinely need the
    // catalogue, and they correctly stay empty.
    assert('but no jobs are invented for it',
      JSON.stringify(r("divMeta('kiewit').projects")) === '[]');
    // ...and when the catalogue DID load, its own rows win.
    r("sourceDivs = [{ division:'paving', label:'Paving Division', projects:[{id:'p1'}] }];");
    assert('a loaded catalogue is used in preference',
      JSON.stringify(r('listDivs().map(d => d.division)')) === JSON.stringify(['paving']) &&
      r("divLabel('paving')") === 'Paving Division');
  }
  assert('the division filter is rebuilt from the same list',
    /function renderDivisionFilter\(\)/.test(PAGE) &&
    /listDivs\(\)\.map\(d => '<option value="'/.test(PAGE) &&
    // ...including on the path where loadCatalog threw before building it.
    /Reload to try again\.';[\s\S]{0,260}renderDivisionFilter\(\);/.test(PAGE));
  assert('the scan sheet offers only writable lists',
    /const writable = d => capsFor\(d\)\.canEdit && loadedLists\.has\(d\);/.test(PAGE));
  assert('and defaults to one of them',  /onScanDivision\(scanDefault \|\| GENERAL\)/.test(PAGE));
}

console.log('\n[the receipt total is not thrown away]');
{
  assert('a disagreeing pair is booked at the receipt total',
    /Math\.abs\(withTax\(pairAmount\) - total\) > 0\.01/.test(PAGE));
  assert('and the user is told which figure won',
    /booked at the receipt total/.test(PAGE));
  // Quoting makes a CSV parse; it does not stop a spreadsheet evaluating a
  // field that starts with = or @. But a negative NUMBER is not a formula, and
  // prefixing one makes the cell text — so a credit or a return drops out of
  // every column sum and the export stops reconciling with the page. Run the
  // real helper over both.
  {
    const ctx = vm.createContext({ console });
    vm.runInContext(sliceSource(PAGE,
      '  const NUMERIC =', '  const out = [head.map(q)', 'exportCSV quoting helper', ['NUMERIC']), ctx);
    const q = v => vm.runInContext('q(' + JSON.stringify(v) + ')', ctx);
    const APOS = '"' + String.fromCharCode(39);

    assert('a formula vendor name is defused', q('=HYPERLINK("http://x","y")').startsWith(APOS));
    assert('...and every other lead character',
      ['+WEBSERVICE(1)', '-2+3', '@SUM(A1)', '\tx', '\rx'].every(v => q(v).startsWith(APOS)));
    assert('a negative amount is left as a number',   q('-76.50') === '"-76.50"', q('-76.50'));
    assert('...as is a negative quantity',            q('-3')     === '"-3"',     q('-3'));
    assert('...and a negative in exponent form',      q('-1e-7')  === '"-1e-7"',  q('-1e-7'));
    assert('a positive number is untouched',          q('76.50')  === '"76.50"');
    assert('and quotes are still doubled',            q('say "hi"') === '"say ""hi"""', q('say "hi"'));
  }
}

console.log('\n[deliveries this page did not know about]');
{
  // The server keeps any stored delivery this page did not send, because it
  // cannot otherwise tell one the user DELETED from one somebody else added.
  // So the page has to say which it deleted, or a removal is simply undone.
  assert('removed deliveries are remembered per order',
    /\(_deletedLines\[poId\] \|\| \(_deletedLines\[poId\] = new Set\(\)\)\)\.add\(lineId\);/.test(PAGE));
  assert('and sent with the save',
    /deletedLineIds: sentDeletions/.test(PAGE));
  assert('only the ones this save carried are forgotten',
    /sentDeletions\.forEach\(id => _deletedLines\[po\.id\]\.delete\(id\)\);/.test(PAGE));
  assert('deleting the order drops its pending removals',
    (PAGE.match(/delete _deletedLines\[poId\];/g) || []).length === 2);
  // A merge means the list on screen is short — show what arrived.
  assert('merged deliveries are taken on screen',
    /if \(res\.mergedLines > 0 && !isTyping\(\)\)/.test(PAGE));
  assert('but never while the user is mid-edit', /function isTyping\(\)/.test(PAGE));
  assert('and the poll shares that same test', /const isEditing = isTyping;/.test(PAGE));
}

console.log('\n[every control on a row asks that row]');
{
  // b45edce moved the HANDLERS to per-division rights but left 18 render sites
  // on the page-level perm, so a user who could not edit paving orders still
  // saw an enabled job picker, status select, delivery inputs, + Add Delivery
  // and Scan — every one of which silently did nothing.
  const rowSites = (PAGE.match(/perm\.canEdit \? '' : 'disabled '/g) || []).length;
  assert('no row control is disabled by a page-level right', rowSites === 0, rowSites + ' left');
  const rowBtns = PAGE.match(/perm\.canEdit \? '<button[^\n]*jsAttr\(po\.id\)/g);
  assert('no row button is gated by a page-level right', !rowBtns, JSON.stringify(rowBtns));
  // The three that SHOULD stay page-level: raising a new order, showing the
  // toolbar, starting a scan — all "can this user act anywhere".
  assert('the page-level right survives only where it belongs',
    (PAGE.match(/if \(!perm\.canEdit\)/g) || []).length === 3);
  assert('and it means "can act in at least one list"',
    /reachable\.some\(d => capsFor\(d\)\.canEdit\)/.test(PAGE));
}

console.log('\n[the division tabs and the version they hold]');
{
  ['tracker.html', 'paving.html', 'kiewit-pinetree.html'].forEach(f => {
    const src = read(f);
    // Adopting the version before the _isEditing bail left the tab believing it
    // held the newest list while still showing the old one, so its next save
    // skipped the merge and erased orders raised elsewhere.
    const poll = src.slice(src.indexOf('async function _pollPurchaseOrders'));
    const body = poll.slice(0, poll.indexOf('async function _pollTrucking'));
    assert(`${f}: the version is adopted with the list, not before it`,
      body.indexOf("if (_isEditing()) return;") < body.indexOf('_poBaseUpdatedAt = data.updatedAt'),
      'adopt-before-bail');
    // A merged save means the server kept orders this tab has never seen.
    assert(`${f}: a merged save does not adopt the new version`,
      /if \(j && j\.updatedAt && !j\.merged\) _poBaseUpdatedAt = j\.updatedAt;/.test(src));
  });
}

console.log('\n[an order the server never stored]');
{
  // The row the user could not get rid of. Its first save had failed, so the
  // server had nothing to delete and the delete call was refused — leaving it
  // on screen forever, retrying and failing.
  assert('deleting an unsaved order does not call the API',
    /if \(!_savedDivision\[poId\]\) \{/.test(PAGE));
  // Both exit branches have to leave nothing behind that could fire later: the
  // retry queue entry, the debounce timer, and the save chain. Checked per
  // branch rather than by adjacency, which broke the moment a line moved.
  const branches = PAGE.split('async function deletePO(')[1].split('\nfunction toggleLines')[0]
    .split('showSave(\'saving\', \'Deleting…\')');
  assert('deletePO has the two exit branches this checks', branches.length === 2);
  branches.forEach((b, i) => {
    const which = i === 0 ? 'the never-stored branch' : 'the real delete';
    assert(`${which} clears the retry queue`,   /_unsaved\.delete\(poId\)/.test(b));
    assert(`${which} clears the debounce timer`, /clearTimeout\(_saveTimers\[poId\]\)/.test(b));
    assert(`${which} clears the save chain`,     /delete _saveChain\[poId\]/.test(b));
  });
  assert('the delete button itself is per division',
    /capsFor\(po\._division\)\.canDelete \? '<button class="del-btn"/.test(PAGE));
  assert('a new order starts in a list the user can save to',
    /function defaultNewDivision\(\)/.test(PAGE));
  assert('and the page says so when the general list is out of reach',
    /those need a Purchase Orders role/.test(PAGE));
}

console.log('\n[Mathis on the purchasing page]');
{
  const mathis = read('mathis.js');
  // The panel is built from the server's digest, never from the reply text —
  // so a digest kind with no renderer is fetched, paid for, and shows nothing.
  assert('purchase_orders is offered as having figures',
    /HAS_FIGURES = \[[\s\S]*?'purchase_orders'/.test(mathis));
  assert('and the panel can actually draw them',
    /purchasing:\s+renderPurchasing/.test(mathis) && /function renderPurchasing\(d\)/.test(mathis));
  assert('the digest kind the server sends matches the renderer key',
    /kind: 'purchasing'/.test(read('api/lib/mathis-digests.js')));
  // A roll-up across only the divisions this user can reach; calling that
  // company-wide would be wrong for anyone whose access is partial.
  assert('the panel says which divisions the figures cover',
    /divisionsCovered/.test(mathis));

  // Every kind the server can send needs an entry, or the same gap reopens.
  const map = mathis.slice(mathis.indexOf('var by = {'));
  const keys = new Set((map.slice(0, map.indexOf('};')).match(/^\s*(\w+):/gm) || [])
    .map(k => k.trim().replace(':', '')));
  ['jobs', 'personal', 'purchasing', 'executive', 'payroll'].forEach(k =>
    assert(`renderer registered for "${k}"`, keys.has(k)));
}

console.log('\n[the scan endpoint gets the time it needs]');
{
  const vercel = JSON.parse(read('vercel.json'));
  const fn = vercel.functions['api/ai/receipt-scan.js'];
  // An Opus 5 vision call with thinking on does not finish inside a default
  // 10-15s window, and the in-file module.exports.config is not what the
  // platform reads for these handlers — api/ai/mathis.js, the same shape of
  // call in the same directory, needed this entry for the same reason.
  assert('receipt-scan has an explicit duration', Boolean(fn), JSON.stringify(Object.keys(vercel.functions)));
  assert('and it is at least as long as the other AI endpoints',
    fn && fn.maxDuration >= 60, JSON.stringify(fn));
}

console.log('\n[round-2 fixes]');
{
  // The headline feature: every leg of the upload has to name the order, or the
  // carve-out — which reads it from the QUERY — refuses and the bytes already
  // in the bucket are thrown away.
  const attach = sliceSource(PAGE, 'async function attachToPO', '/* ═══', 'attachToPO', ['poQ']);
  // A leg is one api(...) call, and several wrap across lines — match up to
  // the next call rather than to the end of the line.
  const legs = attach.split(/api\('(?:POST|PUT|DELETE)', '\//).slice(1)
    .map(chunk => chunk.split(/\n\s*(?:await |const |let )/)[0]);
  assert('every upload leg names the purchase order',
    legs.length >= 4 && legs.every(l => l.includes('poQ')),
    'legs=' + legs.length + ' missing: ' + legs.filter(l => !l.includes('poQ')).join(' | '));

  // Two saves of one order overlapping made both mint a row id.
  assert('saves of one order are serialized',
    /const _saveChain = \{\};/.test(PAGE) && /_saveChain\[po\.id\] = next/.test(PAGE));
  assert('and different orders still save in parallel',
    /const prior = _saveChain\[po\.id\] \|\| Promise\.resolve\(\);/.test(PAGE));

  // "nothing was saved" has to be true.
  assert('a failed scan undoes its local change', /if \(undo\) undo\(\);/.test(PAGE));
  // ...and takes it out of the retry queue — but only when the scan RAISED it.
  // Attaching to an existing order leaves it on the page, and it may have been
  // queued for an edit made long before the scan that the page has promised to
  // retry; clearing that left nothing to write it.
  assert('and takes an order it raised out of the retry queue',
    /if \(created && po\) \{ _unsaved\.delete\(po\.id\)/.test(PAGE));
  assert('but leaves the queue alone for one it merely attached to',
    /let created = false;/.test(PAGE) &&
    (PAGE.match(/created = true;/g) || []).length === 1 &&
    PAGE.indexOf('created = true;') > PAGE.indexOf('purchaseOrders.push(po);'));

  // A retry promised must be a retry given.
  assert('the retry runs before the typing guard',
    PAGE.indexOf('for (const id of [..._unsaved])') < PAGE.indexOf('if (isEditing()) return;'));
  assert('and a failed save is flushed on unload too',
    /Object\.keys\(_saveTimers\)\.concat\(\[\.\.\._unsaved\]\)/.test(PAGE));
  // ...carrying the deletions with it. Without them the server cannot tell a
  // delivery this tab removed from one it never saw, so unseenLines merges it
  // back and the removal is undone by the very save meant to record it.
  assert('and that flush declares its deletions',
    /purchaseOrder:\s*poPayload\(po\),\s*\n\s*deletedLineIds: deletedLinesFor\(id\),/.test(PAGE));
  // Every path that POSTs an order has to declare them, not just the debounced
  // one — there are exactly two.
  assert('every single-order POST declares them',
    (PAGE.match(/deletedLineIds:\s*(sentDeletions|deletedLinesFor\(id\))/g) || []).length === 2,
    JSON.stringify(PAGE.match(/deletedLineIds:[^,\n]*/g)));

  // A half-landed move has to converge.
  assert('staleCopy keeps the order queued', /_unsaved\.add\(po\.id\);/.test(PAGE));
  assert('and the poll leaves its division note alone',
    /merged\.forEach\(po => \{\s*\n\s*if \(_unsaved\.has\(po\.id\) \|\| _saveTimers\[po\.id\]\) return;\s*\n\s*_savedDivision\[po\.id\] = po\._division;/.test(PAGE));

  // The photo, read before anything can clear it.
  assert('the receipt is captured before the save',
    /const shotBlob = scanState\.blob;/.test(PAGE) &&
    /attachToPO\(po, shotBlob, shotName/.test(PAGE));

  // Ids reach id= attributes as well as handlers.
  assert('ids in id= attributes are escaped too', /function idAttr\(v\)/.test(PAGE));
  const rawIds = PAGE.match(/id="[a-z-]+-' \+ (?!idAttr)(?:po|l)\.id/g);
  assert('no id attribute takes a raw id', !rawIds, JSON.stringify(rawIds));
}

console.log('\n[a credit or return is a real figure]');
{
  const ctx = vm.createContext({ console });
  NUM_FNS.concat(['lineAmt', 'lineTaxPct', 'lineTax', 'poTotals']).forEach(n =>
    vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), ctx));
  const tot = vm.runInContext("poTotals({lines:[{qty:'1', unit_cost:'-85'}]})", ctx);
  assert('a return totals negative', tot.total === -85);
  // Every money guard tested > 0, so a credit rendered as "—" in the table
  // while the RUNNING TOTAL beneath it and the phone card both showed -$85.
  assert('the table shows a negative rather than a dash',
    !/tot\.(?:amt|total|qty) > 0 \?/.test(PAGE) && /tot\.total !== 0 \?/.test(PAGE));
  assert('and so does each delivery line',
    !/\bamt > 0 \? '\$'/.test(PAGE) && /amt !== 0 \? '\$'/.test(PAGE));

  // "0" is a non-empty string, so the old guard let a 0-priced ticket through.
  // num0 rather than parseFloat: a unit cost the phone wrote as '1.234,56' has
  // to be worth $1,234.56 here too, or the fallback replaces a real price with
  // the receipt total.
  assert('the $0 guard tests the amount, not whether the boxes are blank',
    /const pairAmount = num0\(lineQty\) \* num0\(lineUnit\);/.test(PAGE) &&
    /const pairIncomplete = pairAmount === 0;/.test(PAGE));
  assert('and a zero total is not treated as a usable one',
    /!isNaN\(total\) && total !== 0/.test(PAGE));
}

console.log('\n[a save that fails is never reported as success]');
{
  // commitScan told the user "Saved ... with the receipt attached" for an
  // order that was never written, because _savePONow swallowed every error and
  // execution fell through to the success toast. closeScan then nulled the
  // photo, so there was nothing to retry with.
  assert('a failed save is rethrown to whoever awaited it',
    /throw err;\n  \}\n\}/.test(PAGE));
  assert('the debounced path still handles its own failure',
    /_savePONow\(po\)\.catch\(/.test(PAGE));
  assert('commitScan says nothing was saved',
    /nothing was saved\. Try again\./.test(PAGE));
  assert('a failed order is remembered',  /_unsaved\.add\(po\.id\)/.test(PAGE));
  assert('and forgotten once it lands',   /_unsaved\.delete\(po\.id\)/.test(PAGE));
  assert('the poll retries it',           /for \(const id of \[\.\.\._unsaved\]\)/.test(PAGE));
  assert('and keeps its local copy meanwhile',
    /Object\.keys\(_saveTimers\)\.concat\(\[\.\.\._unsaved\]\)/.test(PAGE));
  assert('a double tap cannot book the same receipt twice',
    /if \(_committing \|\| !scanState\) return;/.test(PAGE));
}

console.log('\n[a scan the user walked away from]');
{
  // Dismissing still cancels — but only when nothing is being read. The sheet
  // fills a phone screen and the backdrop is a strip down each side, so a thumb
  // resting there was enough to throw the photo away with no message at all.
  assert('dismissing the sheet cancels the scan',
    /if \(e\.target !== this\) return;[\s\S]{0,420}closeScan\(\);/.test(PAGE));
  assert('...unless it is mid-read, which needs Cancel',
    /if \(_scanBusy\) \{[\s\S]{0,160}return;/.test(PAGE));
  assert('Escape cancels it too',
    /classList\.contains\('open'\)\) closeScan\(\)/.test(PAGE));
  assert('every scan takes a number',   /const token = \+\+_scanToken;/.test(PAGE));
  assert('closing retires it',          /_scanToken\+\+;/.test(PAGE));
  // Without this, a reply for an abandoned scan re-opened the sheet over
  // whatever the user had moved on to — and if they had started a second scan,
  // rendered receipt #1's figures against receipt #2's photo and order.
  assert('a late reply for a retired scan is dropped',
    (PAGE.match(/if \(!live\(\)\) return;/g) || []).length >= 3);
}

console.log('\n[money the scan books]');
{
  const ctx = vm.createContext({ console });
  NUM_FNS.concat(['lineAmt']).forEach(n =>
    vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), ctx));
  const amt = e => vm.runInContext(e, ctx);
  // Amount is qty x unit cost, so either alone is zero — and lineHasCost is an
  // OR, so a row still reaches the job. That is a real delivery charged at $0.
  assert('a quantity with no unit cost is worth nothing',
    amt("lineAmt({qty:'8.5', unit_cost:''})") === 0);
  assert('and a unit cost with no quantity likewise',
    amt("lineAmt({qty:'', unit_cost:'25'})") === 0);
  assert('so the scan falls back whenever the pair is worth nothing, not only when both are blank',
    /const pairIncomplete = pairAmount === 0;/.test(PAGE));
  assert('and refuses rather than booking $0 when there is no total either',
    /otherwise the order books at \$0/.test(PAGE));
  assert('the hint no longer describes only the both-blank case',
    /Qty and Unit Cost go together/.test(PAGE));
}

console.log('\n[totals on the surface the user is looking at]');
{
  // Both trees are always in the document — the media query only hides one — so
  // an unprefixed id existed twice and getElementById always returned the
  // desktop one. On a phone the line totals never moved.
  assert('delivery cell ids are scoped per surface',
    /function lineRowsHTML\(po, surface\)/.test(PAGE) &&
    /const cell = \(kind, id\) => esc\(\(surface \|\| 'tbl'\)/.test(PAGE));
  assert('the table asks for its own',  /lineRowsHTML\(po, 'tbl'\)/.test(PAGE));
  assert('and the phone card for its own', /lineRowsHTML\(po, 'card'\)/.test(PAGE));
  assert('an in-place update touches both',
    /\['tbl', 'card'\]\.forEach\(sfc =>/.test(PAGE));
  assert('the RUNNING TOTAL row updates too, instead of contradicting the header',
    /set\('run-tot-' \+ po\.id/.test(PAGE) && /id="run-qty-' \+ idAttr\(po\.id\)/.test(PAGE));
  assert('and the doc-count load waits rather than stealing focus',
    /el\.addEventListener\('blur', \(\) => render\(\), \{ once: true \}\)/.test(PAGE));
}

console.log('\n[ids inside handler attributes]');
{
  const ctx = vm.createContext({});
  vm.runInContext(requireFn(PAGE, 'esc', 'purchase-orders.html'), ctx);
  vm.runInContext(requireFn(PAGE, 'jsAttr', 'purchase-orders.html'), ctx);
  const enc = v => vm.runInContext('jsAttr(' + JSON.stringify(v) + ')', ctx);

  // esc() alone is no protection inside onclick: it turns ' into &#39;, which
  // the HTML parser decodes back to ' before the JS parser sees it.
  const hostile = "x');alert(1);('";
  const attr = new JSDOM(`<button onclick="deletePO('${enc(hostile)}')"></button>`)
    .window.document.querySelector('button').getAttribute('onclick');
  assert('a quote in an id cannot break out of the handler',
    /^deletePO\('(?:[^'\\]|\\.)*'\)$/.test(attr), attr);
  assert('a backslash cannot either',
    /^deletePO\('(?:[^'\\]|\\.)*'\)$/.test(
      new JSDOM(`<button onclick="deletePO('${enc('a\\b')}')"></button>`)
        .window.document.querySelector('button').getAttribute('onclick')));
  assert('an ordinary id is untouched', enc('abc123') === 'abc123');

  // Ids are uid()-generated everywhere today, but the full-list PUT validates
  // nothing about po.id or line.id — so a crafted one can reach this page.
  const raw = PAGE.match(/(?:setDivision|setProject|setSubCode|setField|setLineField|deleteLine|deletePO|addLine|scanIntoPO|openDocs|toggleLines|addAttachment|openDoc)\(\\' \+ (?!jsAttr)[a-z]/g);
  assert('every id in a handler goes through jsAttr', !raw, JSON.stringify(raw));
}

console.log('\n[an order re-tied after a page reload]');
{
  // The bug this pins: _savedDivision was only written after a SAVE, so an
  // order that existed before this page loaded carried no record of where the
  // server has it. Re-tying it then sent no `from`, the server never emptied
  // the old list, and the same order id went live in two divisions' tabs at
  // once — with the old job still carrying its costs.
  assert('loading a list records where the server has each order',
    /_savedDivision\[po\.id\] = key;[\s\S]{0,120}migratePO\(po\);/.test(PAGE));
  assert('the poll records it too, for orders raised in a division tab since',
    /_savedDivision\[po\.id\] = po\._division;/.test(PAGE));
  // ...but only once the poll has committed to adopting what it fetched. The
  // fetch takes time; a move that lands while it is in flight would otherwise
  // be undone by a note naming the list the order has already left.
  // savePO writes the same note on a successful move, so measure inside the
  // poll's own body rather than across the whole page.
  {
    const pollBody = PAGE.slice(PAGE.indexOf('async function poll()'));
    assert('and only after the poll re-checks that it is still safe to adopt',
      pollBody.indexOf('if (isEditing() || _inflight > 0) return;') > -1 &&
      pollBody.indexOf('if (isEditing() || _inflight > 0) return;')
        < pollBody.indexOf('_savedDivision[po.id] = po._division;'));
  }
  assert('and it is declared before the loaders that seed it',
    PAGE.indexOf('const _savedDivision = {};') < PAGE.indexOf('async function loadPurchaseOrders'));

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const ctx = vm.createContext({ document: dom.window.document, console });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    let sourceDivs = [{ division:'turf', label:'Turf', projects:[] }];
    const perm = { canEdit: true, canDelete: true };
    // These blocks exercise the cascade and the move, not the rights — the
    // rights have their own section above.
    function capsFor() { return { canEdit: true, canDelete: true }; }
    const _savedDivision = {};
    const sent = [];
    // The order was loaded from paving, as loadPurchaseOrders would leave it.
    let purchaseOrders = [{ id:'x', po_number:'PO-0007', _division:'paving', project_id:'p1', lines:[] }];
    _savedDivision['x'] = 'paving';
    const loadedLists = new Set(['turf', 'paving', 'kiewit']);
    function savePO(po) { sent.push({ to: po._division, from: _savedDivision[po.id] }); }
    function render() {}
  `, ctx);
  ['listDivs', 'divMeta', 'divLabel', 'projectsFor', 'projectFor', 'codesFor', 'nextPONumber', 'setDivision']
    .forEach(name => vm.runInContext(requireFn(PAGE, name, 'purchase-orders.html'), ctx));

  vm.runInContext("setDivision('x','turf')", ctx);
  const sent = vm.runInContext('sent', ctx);
  assert('re-tying a loaded order still knows the list it is leaving',
    sent.length === 1 && sent[0].from === 'paving' && sent[0].to === 'turf', JSON.stringify(sent));
}

console.log('\n[the poll that picks up division-tab edits]');
{
  // The division tabs write the same lists this page reads, so an edit made
  // there has to reach this screen. The risk is the other way round: a poll
  // that overwrites what the user is in the middle of typing.
  assert('the page polls on the same 60s interval the division tabs use',
    /const POLL_MS = 60_000;/.test(PAGE) && /setInterval\(poll, POLL_MS\)/.test(PAGE));
  assert('it re-checks on returning to the tab, rather than waiting out the interval',
    /visibilitychange[\s\S]{0,140}poll\(\)/.test(PAGE));
  assert('it stands down while a save is in the air',
    /if \(_inflight > 0\) return;/.test(PAGE));
  assert('and while the user is in a field',
    /if \(isEditing\(\)\) return;/.test(PAGE));
  // A <select> has to count: the division and job pickers are how an order is
  // re-tied, and swapping the list out under an open dropdown loses the choice.
  assert('a dropdown counts as editing',
    /el\.tagName === 'SELECT'/.test(PAGE));
  assert('a failed poll changes nothing',
    /console\.warn\('\[po\] poll failed:'[\s\S]{0,40}return;/.test(PAGE));

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const ctx = vm.createContext({ document: dom.window.document, console, JSON });
  // The merge step, lifted out of poll() and run against the cases that matter.
  const mergeSrc = sliceSource(PAGE,
    '    const pending = pendingIds();',
    '    if (JSON.stringify(merged)',
    'poll() merge step', ['pending.has']);
  vm.runInContext(`
    let purchaseOrders = [
      { id:'a', title:'local edit in progress' },
      { id:'b', title:'untouched here' },
      { id:'new', title:'raised here, not stored yet' },
    ];
    let incoming = [
      { id:'a', title:'what paving stored' },
      { id:'b', title:'what paving stored' },
      { id:'c', title:'raised in the paving tab' },
    ];
    let _pending = new Set(['a', 'new']);
    function pendingIds() { return _pending; }
  `, ctx);
  vm.runInContext(mergeSrc.replace(/^\s*const pending = pendingIds\(\);/m, 'const pending = pendingIds();'), ctx);
  const merged = vm.runInContext('merged', ctx);
  const byId = Object.fromEntries(merged.map(p => [p.id, p]));

  // The user typed this a second ago and the debounced save has not gone yet.
  // Taking the server's copy would silently discard what they wrote.
  assert('an order with a save outstanding keeps the local copy',
    byId.a && byId.a.title === 'local edit in progress', JSON.stringify(byId.a));
  assert('an order nobody is editing takes the stored copy',
    byId.b && byId.b.title === 'what paving stored', JSON.stringify(byId.b));
  assert('an order raised in the division tab appears',  Boolean(byId.c));
  // Absent from the server only because its first save is still in flight.
  assert('an order raised here and not yet stored is not dropped',
    byId.new && byId.new.title === 'raised here, not stored yet', JSON.stringify(byId.new));
  assert('and nothing is duplicated', merged.length === 4, JSON.stringify(merged.map(p => p.id)));
}

// Async, so it and the summary that follows run inside one IIFE — this file is
// CommonJS and a top-level await would make its module format ambiguous.
(async () => {
console.log('\n[a cost row this page has not loaded — run]');
{
  // Run it. The row exists on the server, this page has not loaded it, and a
  // supervisor has set an installed quantity, a job class and their own cost
  // code on it. None of those belong to the purchase order.
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const ctx = vm.createContext({ document: dom.window.document, console, JSON, Promise, String });
  vm.runInContext(`
    const written = [];
    const STORED_ROW = {
      id: 'row-1', _projectId: 'p1', date: '2026-01-01', field_type: 'Material',
      employee: '', cost_code: '999', sub_code: 'SUPERVISOR', job_class: 'Operator',
      quantity: '250', material: 'Stone', supplier: 'Acme', po_num: 'PO-0007',
      units_purchased: '1', unit_cost: '1', material_cost: '1',
    };
    const proj = { id: 'p1', dailyRows: [] };          // not loaded
    let fetched = 0;
    function getProj() { return proj; }
    function defaultDailyRow() {
      return { id:'', _projectId:'', date:'', field_type:'', employee:'', cost_code:'',
               sub_code:'', job_class:'', rate:'', labor_hours:'', equipment:'',
               equip_unit_cost:'', equip_hours:'', material:'', supplier:'', po_num:'',
               units_purchased:'', unit_cost:'', material_cost:'', quantity:'' };
    }
    async function drGetAll() { fetched++; return { rows: [Object.assign({}, STORED_ROW)] }; }
    function drPutNow(id, row) { written.push(JSON.parse(JSON.stringify(row))); }
    function renderDailyTable() {}
    function _lineAmt(l) { return (parseFloat(l.qty)||0) * (parseFloat(l.unit_cost)||0); }
    function _lineTax() { return 0; }
  `, ctx);
  vm.runInContext('async ' + requireFn(read('tracker.html'), '_syncPOLineToRow', 'tracker.html'), ctx);
  await vm.runInContext(`_syncPOLineToRow(
    { project_id:'p1', cost_code:'100', sub_code:'A', title:'Stone', supplier:'Acme', po_number:'PO-0007' },
    { id:'L1', po_row_id:'row-1', date:'2026-02-02', employee:'Sam', qty:'10', unit_cost:'5' })`, ctx);

  const out = vm.runInContext('written[0]', ctx);
  assert('the job\'s rows are fetched rather than assumed empty',
    vm.runInContext('fetched', ctx) === 1, String(vm.runInContext('fetched', ctx)));
  assert('the delivery figures reach the row',
    out && out.units_purchased === '10' && out.unit_cost === '5' && out.material_cost === '50',
    JSON.stringify(out));
  assert('and the installed quantity is left alone',      out.quantity  === '250', JSON.stringify(out));
  assert('and the job class',                             out.job_class === 'Operator', JSON.stringify(out));
  assert('and the cost code the supervisor re-coded',
    out.cost_code === '999' && out.sub_code === 'SUPERVISOR', JSON.stringify(out));
  assert('and it is the stored row that was written, not a new one',
    out.id === 'row-1' && vm.runInContext('written.length', ctx) === 1);
}

console.log('\n[a keystroke while a delete is in flight]');
{
  // deletePO yields twice — waiting out a save already in flight, then the
  // DELETE — and the row stays on screen and editable across both, because
  // nothing re-renders until it is done. A save armed in either window used to
  // survive the deletion and POST afterwards: for a brand-new order that leaves
  // an order on the server this screen does not show and cannot remove, and for
  // a stored one it re-creates the order and its job cost rows after the DELETE.
  //
  // The real functions, run against a stubbed api().
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const calls = [];
  const ctx = vm.createContext({
    document: dom.window.document, console, JSON, Promise, Set, Math,
    setTimeout, clearTimeout,
  });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    const calls = [];
    let purchaseOrders = [{ id:'new1', po_number:'PO-0001', _division:'purchase_orders',
                            title:'', lines:[], project_id:'' }];
    const _saveTimers = {};
    const _unsaved = new Set();
    const _deletedLines = {};
    const _savedDivision = {};        // never stored
    const expanded = new Set();
    let _inflight = 0, _saveEpoch = 0;
    // The first save is still on the wire when delete is clicked.
    let releaseFirstSave;
    const firstSave = new Promise(r => { releaseFirstSave = r; });
    const _saveChain = { new1: firstSave };
    const _deleting = new Set();
    const _deferredSaves = new Set();
    function capsFor() { return { canEdit: true, canDelete: true }; }
    function confirm() { return true; }
    function showSave() {}
    function toast() {}
    function render() {}
    function poPayload(po) { return po; }
    function deletedLinesFor() { return []; }
    async function api(method, path) { calls.push(method + ' ' + path); return {}; }
  `, ctx);
  ['savePO', '_savePONow', '_savePOWrite', 'deletePO', 'setField']
    .forEach(n => {
      const src = requireFn(PAGE, n, 'purchase-orders.html');
      // requireFn brace-matches from `function <name>`; async declarations lose
      // their keyword, so put it back for the two that need it.
      vm.runInContext((/^(deletePO|_savePOWrite)$/.test(n) ? 'async ' : '') + src, ctx);
    });

  const run = expr => vm.runInContext(expr, ctx);
  // Delete is clicked and starts awaiting the in-flight first save...
  run('const deleting = deletePO("new1");');
  // ...and the user types into the row, which is still on screen.
  run('setField("new1", "title", "typed after the delete was clicked");');
  // The first save now lands, and the delete resumes.
  run('releaseFirstSave();');
  await new Promise(r => setTimeout(r, 30));
  await vm.runInContext('deleting', ctx);
  // Let any debounce that was armed fire.
  await new Promise(r => setTimeout(r, 700));

  const left  = run('purchaseOrders.map(p => p.id)');
  const sent  = run('calls');
  const timer = run('Object.keys(_saveTimers)');
  assert('the row is gone', left.length === 0, JSON.stringify(left));
  assert('and nothing was POSTed for it afterwards',
    !sent.some(c => c.startsWith('POST')), JSON.stringify(sent));
  assert('and no debounce is left armed to do it later',
    timer.length === 0, JSON.stringify(timer));

  // Clearing the timer on the way out covers the debounce, but not every path
  // into a save: the poll's retry loop and commitScan call _savePONow directly,
  // and an `immediate` save fires on a 0ms timer that can land mid-await. Those
  // need the guard itself, so drive one of them.
  const ctx2 = vm.createContext({
    document: dom.window.document, console, JSON, Promise, Set, Math,
    setTimeout, clearTimeout,
  });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    const calls = [];
    let purchaseOrders = [{ id:'new2', po_number:'PO-0002', _division:'purchase_orders',
                            title:'', lines:[], project_id:'' }];
    const _saveTimers = {};
    const _unsaved = new Set(['new2']);     // a failed save left it queued
    const _deletedLines = {};
    const _savedDivision = {};
    const expanded = new Set();
    const _deleting = new Set();
    const _deferredSaves = new Set();
    let _inflight = 0, _saveEpoch = 0;
    let releaseFirstSave;
    const firstSave = new Promise(r => { releaseFirstSave = r; });
    const _saveChain = { new2: firstSave };
    function capsFor() { return { canEdit: true, canDelete: true }; }
    function confirm() { return true; }
    function showSave() {}
    function toast() {}
    function render() {}
    function poPayload(po) { return po; }
    function deletedLinesFor() { return []; }
    async function api(method, path) { calls.push(method + ' ' + path); return {}; }
  `, ctx2);
  ['savePO', '_savePONow', '_savePOWrite', 'deletePO']
    .forEach(n => vm.runInContext(
      (/^(deletePO|_savePOWrite)$/.test(n) ? 'async ' : '') +
      requireFn(PAGE, n, 'purchase-orders.html'), ctx2));

  const run2 = expr => vm.runInContext(expr, ctx2);
  run2('const deleting2 = deletePO("new2");');
  // The poll's retry loop fires while the delete is still awaiting, reaching
  // _savePONow without going through savePO at all. It REJECTS rather than
  // quietly resolving: commitScan awaits this and, on anything that is not a
  // throw, goes on to tell the user the order was saved with the receipt
  // attached — which would be false for a save that never happened.
  run2('let refusal = null; const retry = _savePONow(purchaseOrders[0]).catch(e => { refusal = e.message; });');
  run2('releaseFirstSave();');
  await new Promise(r => setTimeout(r, 30));
  await vm.runInContext('Promise.all([deleting2, retry])', ctx2);
  await new Promise(r => setTimeout(r, 50));

  const sent2 = run2('calls');
  assert('a retry that reaches _savePONow directly is refused too',
    !sent2.some(c => c.startsWith('POST')), JSON.stringify(sent2));
  assert('and it rejects, so a caller cannot report success',
    run2('refusal') === 'That order is being deleted', JSON.stringify(run2('refusal')));
  assert('and that row is gone as well',
    run2('purchaseOrders.length') === 0);
  // Every direct caller has to handle that rejection. There are four, and each
  // is either awaited inside a try, or has a .catch on it.
  const direct = PAGE.split('\n').filter(l => /_savePONow\(/.test(l) && !/function _savePONow/.test(l));
  assert('every direct _savePONow call handles a rejection',
    direct.length === 4 && direct.every(l => /\.catch\(|await _savePONow/.test(l)),
    JSON.stringify(direct.map(l => l.trim())));

  // ...and when the DELETE FAILS the order is still there, so what was typed
  // into it has to be saved after all. Refusing the save outright meant no
  // timer, no retry-queue entry and nothing in the unload flush — the poll
  // replaced the row with the server's copy 60 seconds later and the only
  // thing the page had said was "Not deleted".
  const ctx3 = vm.createContext({
    document: dom.window.document, console, JSON, Promise, Set, Math,
    setTimeout, clearTimeout,
  });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    const calls = [];
    let purchaseOrders = [{ id:'kept', po_number:'PO-0003', _division:'purchase_orders',
                            title:'', lines:[], project_id:'' }];
    const _saveTimers = {};
    const _unsaved = new Set();
    const _deletedLines = {};
    const _savedDivision = { kept: 'purchase_orders' };   // stored, so a DELETE is sent
    const expanded = new Set();
    const _deleting = new Set();
    const _deferredSaves = new Set();
    const _saveChain = {};
    let _inflight = 0, _saveEpoch = 0;
    let releaseDelete;
    const deletePromise = new Promise((_, rej) => { releaseDelete = () => rej(new Error('network')); });
    function capsFor() { return { canEdit: true, canDelete: true }; }
    function confirm() { return true; }
    function showSave() {}
    function toast() {}
    function render() {}
    function poPayload(po) { return po; }
    function deletedLinesFor() { return []; }
    function deletedLineIdsSent() { return []; }
    async function api(method, path) {
      calls.push(method + ' ' + path);
      if (method === 'DELETE') return deletePromise;
      return {};
    }
  `, ctx3);
  ['savePO', '_savePONow', '_savePOWrite', 'deletePO', 'setField']
    .forEach(n => vm.runInContext(
      (/^(deletePO|_savePOWrite)$/.test(n) ? 'async ' : '') +
      requireFn(PAGE, n, 'purchase-orders.html'), ctx3));

  const run3 = expr => vm.runInContext(expr, ctx3);
  run3('const del = deletePO("kept");');
  // The row is still on screen for the whole of the DELETE, so it can be typed
  // into — which is the premise of the guard in the first place.
  run3('setField("kept", "title", "typed while the delete was in flight");');
  run3('releaseDelete();');
  await vm.runInContext('del', ctx3);
  await new Promise(r => setTimeout(r, 60));

  assert('a failed delete leaves the order on the page',
    run3('purchaseOrders.length') === 1);
  assert('...still showing what was typed',
    run3('purchaseOrders[0].title') === 'typed while the delete was in flight');
  assert('and the edit is saved after all, not silently dropped',
    run3('calls').some(c => c.startsWith('POST')), JSON.stringify(run3('calls')));
  assert('and nothing is left deferred',
    run3('_deferredSaves.size') === 0);
}

console.log('\n[the unload flush and an order on its way out]');
{
  // The flush is the one writer the delete guard did not reach, and the worst
  // placed to miss it: the DELETE is an ordinary fetch the unload aborts, while
  // this POST is keepalive and is delivered regardless. Closing the tab right
  // after a delete re-created the order and its job cost rows behind the user.
  // Sliced without requiring the guard, so its absence reads as a failed
  // assertion rather than a thrown extraction error.
  const flushStart = PAGE.indexOf('  const outstanding = new Set(Object.keys(_saveTimers)');
  const flush = PAGE.slice(flushStart, PAGE.indexOf('\n});', flushStart));
  assert('the flush skips an order that is being deleted',
    /if \(_deleting\.has\(id\)\) return;/.test(flush), flush.slice(0, 400));
  assert('and does so before it reads the order at all',
    flush.indexOf('_deleting.has(id)') > -1 &&
    flush.indexOf('purchaseOrders.find') > -1 &&
    flush.indexOf('_deleting.has(id)') < flush.indexOf('purchaseOrders.find'));
  // All three writers consult it. Measured inside each one's own body, so a
  // guard deleted from one is not covered by another's further down the file.
  const bodyOf = (from, to) => {
    const a = PAGE.indexOf(from);
    return a < 0 ? '' : PAGE.slice(a, PAGE.indexOf(to, a + from.length));
  };
  [['function savePO(po, opts)', '\n}'],
   ['function _savePONow(po)',   '\n}'],
   ['window.addEventListener(\'beforeunload\'', '\n});']].forEach(([from, to]) => {
    const body = bodyOf(from, to);
    assert(`${from.split('(')[0]} is guarded`,
      body.length > 0 && /_deleting\.has\(/.test(body), body.slice(0, 200));
  });
}

console.log('\n[a poll whose fetch predates a save that landed]');
{
  // _inflight only says whether a save is in the air at the instant it is read.
  // It is 0 when the GETs leave and 0 again when they land, which says nothing
  // about a save that started and finished in between — and that response was
  // computed BEFORE the save. Adopting it puts a completed move back where it
  // came from on screen and points _savedDivision at the list the order has
  // already left, so the next save sends the wrong `from` (every cost row the
  // order owns deleted and re-minted) or none at all (the order live in two
  // divisions' tabs, the job charged twice).
  //
  // The whole poll body is run here, not a regex over it.
  const dom = new JSDOM('<!doctype html><html><body></body></html>');

  const runPoll = async ({ saveLandsDuringFetch }) => {
    const ctx = vm.createContext({
      document: dom.window.document, console, JSON, Promise, Array, Set, setTimeout,
    });
    vm.runInContext(`
      const GENERAL = 'purchase_orders';
      // The move has already completed: the server holds PO-0007 in turf.
      let purchaseOrders = [{ id:'po1', po_number:'PO-0007', _division:'turf', lines:[] }];
      const _savedDivision = { po1: 'turf' };
      const _unsaved = new Set();
      const _saveTimers = {};
      let _inflight = 0;
      let _saveEpoch = 0;
      let renders = 0;
      const loadedLists = new Set(['paving']);
      let landDuringFetch = ${saveLandsDuringFetch ? 'true' : 'false'};
      function listKeys() { return ['paving']; }
      function pendingIds() { return new Set(); }
      function migratePO() {}
      function isEditing() { return false; }
      function render() { renders++; }
      // The paving GET was computed before the move and answers after it.
      async function api() {
        if (landDuringFetch) {
          // A save starts and finishes entirely inside the fetch window, so
          // _inflight is 0 on both sides of it.
          _inflight++;
          _inflight--;
          _saveEpoch++;
        }
        return { purchaseOrders: [{ id:'po1', po_number:'PO-0007', lines:[] }] };
      }
    `, ctx);
    // requireFn brace-matches from `function <name>`, so the `async` in front of
    // the declaration is not part of what it returns. Put it back.
    vm.runInContext('async ' + requireFn(PAGE, 'poll', 'purchase-orders.html'), ctx);
    await vm.runInContext('poll()', ctx);
    return {
      division: vm.runInContext('purchaseOrders[0]._division', ctx),
      saved:    vm.runInContext('_savedDivision.po1', ctx),
      renders:  vm.runInContext('renders', ctx),
    };
  };

  const raced = await runPoll({ saveLandsDuringFetch: true });
  assert('a stale response does not move the order back on screen',
    raced.division === 'turf', JSON.stringify(raced));
  assert('nor re-point the note at the list it has left',
    raced.saved === 'turf', JSON.stringify(raced));
  assert('and nothing is re-rendered from it', raced.renders === 0, JSON.stringify(raced));

  // ...and an ordinary poll still works, or the guard would just stop polling.
  const quiet = await runPoll({ saveLandsDuringFetch: false });
  assert('a poll with no save in the window still adopts what it fetched',
    quiet.saved === 'paving' && quiet.renders === 1, JSON.stringify(quiet));

  // A list that failed at boot and answered on a later tick has proved itself.
  // Only boot wrote to loadedLists, so such a list stayed marked unusable for
  // the life of the page: its orders were on screen while numbering refused it,
  // the division picker did not offer it, and neither "+ New PO" nor the scan
  // sheet would land there — every one of them telling the user to reload a
  // list they could already see.
  {
    const ctx = vm.createContext({
      document: dom.window.document, console, JSON, Promise, Array, Set, setTimeout,
    });
    vm.runInContext(`
      const GENERAL = 'purchase_orders';
      let purchaseOrders = [];
      const _savedDivision = {};
      const _unsaved = new Set();
      const _saveTimers = {};
      let _inflight = 0, _saveEpoch = 0, renders = 0;
      const loadedLists = new Set();        // paving's GET failed at boot
      function listKeys() { return ['paving']; }
      function pendingIds() { return new Set(); }
      function migratePO() {}
      function isEditing() { return false; }
      function render() { renders++; }
      async function api() { return { purchaseOrders: [{ id:'p1', po_number:'PO-0001', lines:[] }] }; }
    `, ctx);
    vm.runInContext('async ' + requireFn(PAGE, 'poll', 'purchase-orders.html'), ctx);
    await vm.runInContext('poll()', ctx);
    assert('a list the poll fetched is marked loaded',
      vm.runInContext("loadedLists.has('paving')", ctx) === true);
    assert('and its orders are adopted',
      vm.runInContext('purchaseOrders.length', ctx) === 1);
  }
}

// ── a number with a comma in it ────────────────────────────────────────
console.log('\n[a number with a comma in it]');
{
  // The reading itself, and the six copies of it, are scripts/test-numeric.js.
  // What belongs here is the purchase-order path specifically: the receipt
  // reader, the digest that answers questions about purchasing, and the page
  // agreeing with the server on one order's money.
  const server = require('../api/lib/numeric');

  // The receipt reader is where the hundredfold error was. Run its own
  // extractor, not a restatement of it.
  {
    const scan = read('api/ai/receipt-scan.js');
    const ctx = vm.createContext({ numeric: server.numeric });
    vm.runInContext(requireFn(scan, 'numOrNull', 'receipt-scan.js') + ';this.f = numOrNull;', ctx);
    const numOrNull = vm.runInContext('f', ctx);
    assert('a scanned "360,82" is $360.82, not $36,082',  numOrNull('360,82') === 360.82);
    assert('a scanned "1.234,56" is $1,234.56',           numOrNull('1.234,56') === 1234.56);
    assert('a scanned "1,234.56" is $1,234.56',           numOrNull('1,234.56') === 1234.56);
    assert('a blank field is still nothing',              numOrNull('') === null);
    assert('and so is an unreadable one',                 numOrNull('illegible') === null);
    assert('the comma-stripping that caused it is gone',
      !/replace\(\/\[\$,\]\/g/.test(scan), 'receipt-scan.js still strips commas');
  }

  // What Mathis is told a job has spent. This read the line with Number(),
  // which is NaN for '360,82' — so the delivery counted as zero and the answer
  // was short by the whole line, with nothing on screen to say so.
  {
    const digests = read('api/lib/mathis-digests.js');
    const src = sliceSource(digests, 'const poValue =', '}, 0);',
      'poValue in mathis-digests.js', 'l.unit_cost') + '}, 0);';
    const ctx = vm.createContext({ numericOrZero: server.numericOrZero });
    vm.runInContext(src + ';this.f = poValue;', ctx);
    const poValue = vm.runInContext('f', ctx);
    assert('a plain order is worth qty × cost plus tax',
      poValue({ lines: [{ qty: '2', unit_cost: '10', tax: '1.40' }] }) === 21.40);
    assert('and a comma-priced one is worth the same, not nothing',
      Math.abs(poValue({ lines: [{ qty: '2', unit_cost: '10,00', tax: '1,40' }] }) - 21.40) < 1e-9,
      poValue({ lines: [{ qty: '2', unit_cost: '10,00', tax: '1,40' }] }));
    assert('a European invoice over a thousand is not dropped either',
      Math.abs(poValue({ lines: [{ qty: '1', unit_cost: '1.234,56' }] }) - 1234.56) < 1e-9);
    assert('an order with no lines is worth nothing',
      poValue({}) === 0 && poValue({ lines: [] }) === 0);
  }

  // Both writers of the blob read a stored comma the same way, so the figure
  // the division tab shows is the figure that lands in po_deliveries.
  {
    const line = { qty: '8,5', unit_cost: '1.234,56', tax_pct: '7,5' };
    const poSync = require('../api/lib/po-sync');
    const ctxPage = vm.createContext({});
    vm.runInContext(
      NUM_FNS.concat(['lineAmt', 'lineTaxPct', 'lineTax'])
        .map(n => requireFn(PAGE, n, 'purchase-orders.html')).join('\n') +
      ';this.amt = lineAmt; this.tax = lineTax;', ctxPage);
    const pageAmt = vm.runInContext('amt', ctxPage)(line);
    const pageTax = vm.runInContext('tax', ctxPage)(line);
    assert('8,5 × 1.234,56 is $10,493.76 on the purchasing page',
      Math.abs(pageAmt - 10493.76) < 0.005, pageAmt);
    assert('and the server agrees to the cent',
      Math.abs(poSync.lineAmt(line) - pageAmt) < 1e-9,
      `${poSync.lineAmt(line)} vs ${pageAmt}`);
    assert('the tax does too',
      Math.abs(poSync.lineTax(line) - pageTax) < 1e-9,
      `${poSync.lineTax(line)} vs ${pageTax}`);
  }
}

console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
})();
