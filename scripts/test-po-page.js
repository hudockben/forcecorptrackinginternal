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

// ── 1. Registration ────────────────────────────────────────────────────────
console.log('\n[the division is registered everywhere it has to be]');
{
  const auth = read('api/lib/auth.js');
  assert('in the canonical division list',   /'quarry_sales', 'purchase_orders'\]/.test(auth));
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
  const pct = { 'c-user': 12, 'c-div': 4.875, 'c-act': 10 };
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
assert('the camera is asked for by default on a phone',
  /id="receipt-capture"[^>]*capture="environment"/.test(PAGE));
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
  ['lineAmt', 'lineTaxPct', 'lineTax', 'recalcLineTax', 'poTotals'].forEach(name => {
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
  ['divMeta', 'divLabel', 'projectsFor', 'projectFor', 'codesFor', 'codeLabel', 'codeValue', 'nextPONumber']
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
  ['divMeta', 'divLabel', 'projectsFor', 'projectFor', 'codesFor', 'nextPONumber', 'setDivision', 'setProject', 'setSubCode']
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
  ['divMeta', 'divLabel', 'projectFor', 'projectsFor', 'visiblePOs'].forEach(name =>
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
    assert(`${f}: the input helpers escape the ids they are handed`,
      (src.match(/data-po-id="\$\{esc\(poId\)\}" data-line-id="\$\{esc\(lineId\)\}"/g) || []).length === 2 &&
      (src.match(/data-po-id="\$\{esc\(poId\)\}" data-po-field=/g) || []).length === 2);
  });
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
  // every turf, paving and kiewit order while the banner said otherwise.
  assert('a catalogue failure still fetches every list',
    /sourceDivs\.length \? sourceDivs\.map\(d => d\.division\) : PO_SOURCE\.slice\(\)/.test(PAGE));
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
  // field that starts with = or @.
  assert('CSV fields that look like formulas are defused',
    /if \(\/\^\[=\+\\-@\\t\\r\]\/\.test\(t\)\) t = "'" \+ t;/.test(PAGE));
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
  assert('and takes the order out of the retry queue',
    /if \(po\) \{ _unsaved\.delete\(po\.id\)/.test(PAGE));

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
  ['lineAmt', 'lineTaxPct', 'lineTax', 'poTotals'].forEach(n =>
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
  assert('the $0 guard tests the amount, not whether the boxes are blank',
    /const pairAmount = \(parseFloat\(lineQty\) \|\| 0\) \* \(parseFloat\(lineUnit\) \|\| 0\);/.test(PAGE) &&
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
  assert('dismissing the sheet cancels the scan',
    /if \(e\.target === this\) closeScan\(\);/.test(PAGE));
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
  vm.runInContext(requireFn(PAGE, 'lineAmt', 'purchase-orders.html'), ctx);
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
  ['divMeta', 'divLabel', 'projectsFor', 'projectFor', 'codesFor', 'nextPONumber', 'setDivision']
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
  // _savePONow without going through savePO at all.
  run2('const retry = _savePONow(purchaseOrders[0]);');
  run2('releaseFirstSave();');
  await new Promise(r => setTimeout(r, 30));
  await vm.runInContext('Promise.all([deleting2, retry])', ctx2);
  await new Promise(r => setTimeout(r, 50));

  const sent2 = run2('calls');
  assert('a retry that reaches _savePONow directly is refused too',
    !sent2.some(c => c.startsWith('POST')), JSON.stringify(sent2));
  assert('and that row is gone as well',
    run2('purchaseOrders.length') === 0);
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
}

console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
})();
