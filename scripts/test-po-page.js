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

// The bookkeeping every edit and every save now goes through: which of an
// order's fields and deliveries this page changed, so the server takes only
// those from its copy. The page's own functions and lists, lifted — any
// context running a setter or _savePOWrite needs them. `_editedLines` is left
// to each context, which already declares it.
const EDIT_BOOKKEEPING = [
  'const _editedFields = {};',
  'let _editSeq = 0;',
  sliceSource(PAGE, 'const PO_HEADER_FIELDS', '\nconst PO_STATUS_STAMP_FIELDS', 'the header field list'),
  (PAGE.match(/const PO_STATUS_STAMP_FIELDS = [^\n]*/) || [''])[0],
  (PAGE.match(/const PO_LINE_FIELDS = \[[\s\S]*?\];/) || [''])[0],
  (PAGE.match(/const PO_LINE_MONEY = [^\n]*/) || [''])[0],
  // adoptStoredLines re-runs the load-time tax migration; a context that has
  // not lifted the real one gets a no-op.
  'var migratePO = typeof migratePO === "function" ? migratePO : function () {};',
  ...['noteEdit', 'pendingEdits', 'clearSentEdits', 'editedFieldsFor', 'adoptStoredFields', 'isTyping',
      'lineEditKey', 'lineEditSplit', 'editedLinesFor', 'editedLineFieldsFor', 'adoptStoredLines']
    .map(n => requireFn(PAGE, n, 'purchase-orders.html')),
].join('\n');

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
  assert('with the divisions it buys for',
    /const PO_SOURCE_DIVISIONS = \['turf', 'paving', 'kiewit', 'quarry'\]/.test(auth));
  assert('of which only the ones with jobs can be charged',
    /const PO_JOB_DIVISIONS = \['turf', 'paving', 'kiewit'\]/.test(auth));

  // Sign-in and the session refresh keep no division list of their own: what
  // an account may open comes from api/lib/auth.js, so the canonical list
  // above is the one they use.
  {
    const login = read('api/auth/login.js');
    const verify = read('api/auth/verify.js');
    assert('sign-in takes its divisions from the canonical rule',
      /accessFromRow\(/.test(login) && !/ALL_DIVISIONS\s*=/.test(login));
    assert('and so does the session refresh',
      /requireAuth\(/.test(verify) && !/ALL_DIVISIONS\s*=/.test(verify));
  }

  ['api/company/users.js', 'api/admin/users.js', 'api/admin/companies.js'].forEach(f => {
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
  // Quarry is a source division, so its orders are mirrored too...
  assert('and quarry orders can be mirrored',
    /purchase_orders_division_chk\s+CHECK \(division IN \([^)]*'quarry'[^)]*\)\)/.test(sql));
  // ...but it has no jobs, so nothing may ever cost one under it.
  assert('but quarry never becomes a job cost row',
    !/daily_tracking_division_chk\s+CHECK \(division IN \([^)]*'quarry'[^)]*\)\)/.test(sql));
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
  NUM_FNS.concat(['lineAmt', 'lineTaxPct', 'lineTax', 'lineUnitCostWithTax', 'recalcLineTax', 'poTotals']).forEach(name => {
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

  // The unit cost shown under the price is the one the job's cost row carries,
  // so it has to agree with the server's figure for the same line.
  const poSync = require('../api/lib/po-sync');
  [
    { qty: '63.82', unit_cost: '16',    tax_pct: '6' },
    { qty: '7',     unit_cost: '15.37', tax_pct: '6' },
    { qty: '10',    unit_cost: '10',    tax: '3.21' },
    { qty: '',      unit_cost: '20',    tax_pct: '6' },
    { qty: '5',     unit_cost: '12',    tax_pct: '' },
  ].forEach(l => {
    const page = run('lineUnitCostWithTax(' + JSON.stringify(l) + ')');
    assert('unit cost with tax matches the server for ' + JSON.stringify(l),
      page === poSync.lineUnitCostWithTax(l), page + ' vs ' + poSync.lineUnitCostWithTax(l));
  });
}

console.log('\n[the division tabs carry the tax into the cost row\'s unit cost]');
['paving.html', 'tracker.html', 'kiewit-pinetree.html'].forEach(file => {
  const src = read(file);
  const ctx = vm.createContext({});
  ['_normalizeNumeric', '_poNum', '_poNum0', '_lineAmt', '_lineTaxPct', '_lineTax', '_lineUnitCostWithTax']
    .forEach(name => vm.runInContext(requireFn(src, name, file), ctx));
  const poSync = require('../api/lib/po-sync');
  const l = { qty: '63.82', unit_cost: '16', tax_pct: '6' };
  assert(file + ': same figure as the server',
    vm.runInContext('_lineUnitCostWithTax(' + JSON.stringify(l) + ')', ctx) === poSync.lineUnitCostWithTax(l));
  assert(file + ': an existing cost row is given it',
    /r\.unit_cost      = line\.unit_cost \? String\(_lineUnitCostWithTax\(line\)\) : '';/.test(src));
  assert(file + ': and so is a new one',
    /unit_cost:       line\.unit_cost \? String\(_lineUnitCostWithTax\(line\)\) : '',/.test(src));
});

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
        { id: 'p1', name: 'Paving Job', jobNumber: '200', codes: [] },
        { id: 'p2', name: 'Finished Job', jobNumber: '201', done: true, codes: [
          { cost_code: '500', sub_code: 'Top', description: 'Wearing course' } ] } ] },
    ];
    let purchaseOrders = [];
    // loadPurchaseOrders adds a key here once that division's list has come
    // back. A division absent from it has not loaded, and cannot be numbered.
    const loadedLists = new Set(['turf', 'paving', 'kiewit']);
  `, ctx);
  ['listDivs', 'divMeta', 'divLabel', 'projectsFor', 'projectFor', 'pickableProjects', 'projectOptionLabel',
   'codesFor', 'codeLabel', 'codeValue', 'nextPONumber']
    .forEach(name => vm.runInContext(requireFn(PAGE, name, 'purchase-orders.html'), ctx));
  const run = expr => vm.runInContext(expr, ctx);

  assert('a division resolves to its jobs',   run("projectsFor('turf').length") === 1);

  // A finished job is not somewhere new orders go, so the pickers leave it
  // out — but an order already on it keeps it, labelled, and still reads its
  // name and codes, which is why the catalogue flags it instead of dropping it.
  assert('the pickers leave out a finished job',
    run("pickableProjects('paving').map(p => p.id).join()") === 'p1');
  assert('but keep it for an order already tied to it',
    run("pickableProjects('paving','p2').map(p => p.id).join()") === 'p1,p2');
  assert('where it is labelled complete',
    run("projectOptionLabel(projectFor('paving','p2'))") === 'Finished Job  (#201) (complete)');
  assert('an open job carries no such label',
    run("projectOptionLabel(projectFor('paving','p1'))") === 'Paving Job  (#200)');
  assert('an order on a finished job still reads its codes', run("codesFor('paving','p2').length") === 1);
  // The flag comes from the job's own Status, the same rule the division tabs
  // use for a finished job.
  {
    const cat = read('api/po-catalog.js');
    const isDone = new Function(requireFn(cat, 'projectIsDone', 'api/po-catalog.js') + '; return projectIsDone;')();
    assert('the catalogue flags a Complete job done',  isDone({ status: 'Complete' }) === true);
    assert('and a Closed one',                          isDone({ status: 'closed' }) === true);
    assert('but not one still being worked',
      ['In Progress', 'Substantially Complete', 'On Hold', ''].every(st => isDone({ status: st }) === false));
    assert('and sends the flag with each job',          /done:\s+projectIsDone\(blob\)/.test(cat));
  }
  assert('both job pickers read the filtered list',
    /const list = pickableProjects\(po\._division, po\.project_id\);/.test(PAGE) &&
    /: pickableProjects\(divKey\);/.test(PAGE));
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
    function updateCodeInPlace() {}
    const toasted = [];
    function toast(msg) { toasted.push(msg); }
  `, ctx);
  vm.runInContext(EDIT_BOOKKEEPING, ctx);
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
    /const PO_SOURCE = \['turf', 'paving', 'kiewit', 'quarry'\];/.test(PAGE) &&
    JSON.stringify(require('../api/lib/auth').PO_SOURCE_DIVISIONS) === JSON.stringify(['turf','paving','kiewit','quarry']));
  assert('and so does its list of divisions with jobs',
    /const PO_JOB = \['turf', 'paving', 'kiewit'\];/.test(PAGE) &&
    JSON.stringify(require('../api/lib/auth').PO_JOB_DIVISIONS) === JSON.stringify(['turf','paving','kiewit']));
  // The sandboxes below restate these constants, so the PAGE's own copies are
  // pinned here — otherwise dropping quarry from them would pass every check.
  assert('the page names quarry for a catalogue failure',
    /const PO_SOURCE_LABELS = \{[^}]*quarry: 'Quarry'[^}]*\};/.test(PAGE));
  assert('and gives it its own chip colour',
    /const DIV_COLORS = \{[^}]*quarry: 'var\(--div-quarry\)'[^}]*\};/.test(PAGE) &&
    /--div-quarry:\s*#f97316;/.test(PAGE));
  // Quarry has no Purchase Orders tab, so the attachments sheet must not send
  // anyone looking for a paperclip there.
  {
    const sub = (PAGE.match(/'<div class="sub">Filed under '[\s\S]{0,700}?'<\/div>'/) || [''])[0];
    assert('the attachments sheet only promises a tab to divisions that have one',
      /po\._division === GENERAL \|\| hasJobs\(po\._division\)/.test(sub) &&
      /has no Purchase Orders tab of its own/.test(sub), sub.slice(0, 300));
  }
  assert('and GENERAL is declared before capsFor reads it',
    PAGE.indexOf('const GENERAL') < PAGE.indexOf('function capsFor'));

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const ctx = vm.createContext({ document: dom.window.document, console });
  vm.runInContext(`
    const DIVISION = 'purchase_orders';
    const GENERAL  = 'purchase_orders';
    // Lifted from the page rather than restated, so the two cannot drift.
    const PO_SOURCE = ['turf', 'paving', 'kiewit', 'quarry'];
    const PO_SOURCE_LABELS = { turf: 'Turf Management', paving: 'Paving', kiewit: 'Kiewit Pinetree', quarry: 'Quarry' };
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
    ['po.po_number', 'po.title', 'po.supplier', 'po.status', 'po.status_changed_by', 'po.created_by']
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
  // The vendor box is the typeahead picker now, so its attributes come out of
  // cbHtml rather than sitting in the page as markup. Render the sheet's own
  // call and read them off the element.
  {
    const at = PAGE.indexOf("cbHtml('vendors', val(r.vendor)");
    const call = at < 0 ? '' : PAGE.slice(at, PAGE.indexOf('})', at) + 2);
    const ctx = vm.createContext({});
    ['esc', 'cbHtml'].forEach(n => vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), ctx));
    const html = call ? vm.runInContext('const val = v => v; const r = { vendor: "Fastenal" };\n' + call, ctx) : '';
    const box = new JSDOM(html).window.document.getElementById('sc-vendor');
    assert('nor does the vendor field',
      Boolean(box) && box.getAttribute('autocorrect') === 'off' && box.getAttribute('spellcheck') === 'false'
      && box.value === 'Fastenal', html || 'the sheet\'s vendor box is not built with cbHtml');
  }

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
    // Every call site catches — the PO tab's two, and on tracker.html the
    // Suppliers tab's rename, which carries a new supplier name to the orders.
    const headerCalls = (src.match(/_syncPOHeaderToLines\(/g) || []).length
      - (src.match(/function _syncPOHeaderToLines\(/g) || []).length;
    const caught = (src.match(/_syncPOHeaderToLines\(po(?:, true)?\)\.catch\(/g) || []).length;
    assert(`${f}: every one of its call sites catches`, headerCalls >= 2 && caught === headerCalls, `${caught} of ${headerCalls}`);

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
      const PO_SOURCE = ['turf', 'paving', 'kiewit', 'quarry'];
      const PO_SOURCE_LABELS = { turf: 'Turf Management', paving: 'Paving', kiewit: 'Kiewit Pinetree', quarry: 'Quarry' };
      let sourceDivs = [];          // the catalogue failed
    `, ctx);
    ['listDivs', 'divMeta', 'divLabel', 'listKeys']
      .forEach(n => vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), ctx));
    const r = e => vm.runInContext(e, ctx);
    assert('a catalogue failure still fetches every list',
      JSON.stringify(r('listKeys()')) ===
      JSON.stringify(['turf', 'paving', 'kiewit', 'quarry', 'purchase_orders']), JSON.stringify(r('listKeys()')));
    assert('and every division is still offered, so no order is mislabelled',
      JSON.stringify(r('listDivs().map(d => d.division)')) ===
      JSON.stringify(['turf', 'paving', 'kiewit', 'quarry']), JSON.stringify(r('listDivs()')));
    assert('quarry included, under its real name',
      r("divLabel('quarry')") === 'Quarry', r("divLabel('quarry')"));
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
    /deletedLineIds:\s*sentDeletions/.test(PAGE));
  assert('only the ones this save carried are forgotten',
    /sentDeletions\.forEach\(id => _deletedLines\[po\.id\]\.delete\(id\)\);/.test(PAGE));
  assert('deleting the order drops its pending removals',
    (PAGE.match(/delete _deletedLines\[poId\];/g) || []).length === 2);
  // A merge means the list on screen is short — show what arrived. Taken on
  // delivery by delivery and key by key now (adoptStoredLines, run in
  // "[a save says which of the order's fields it changed]"), never by a
  // wholesale swap that threw away an edit made while the save was out.
  assert('merged deliveries are taken on screen',
    /if \(!isTyping\(\)\) \{\s*const took = adoptStoredLines\(po, res\.purchaseOrder\.lines, sentLineIds\);/.test(PAGE));
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
  vm.runInContext(EDIT_BOOKKEEPING, ctx);
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

console.log('\n[who raised an order, and when]');
{
  // The "Created" byline sits under the status, beside the status-change one,
  // on this page and on the three division tabs. Both are run here, not read.
  const T1 = '2026-10-30T15:45:00.000Z';   // raised
  const T2 = '2026-11-03T14:05:00.000Z';   // status set
  const day  = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const evil = '<img src=x onerror=alert(1)>';

  // ── This page ──
  const statuses = (PAGE.match(/const PO_STATUSES = (\[[^\n]*\]);/) || [])[1];
  assert('one status list feeds both the dropdown and the byline',
    Boolean(statuses) && /const opts = PO_STATUSES\s*\.map\(/.test(PAGE));
  const ctx = vm.createContext({});
  vm.runInContext('const PO_STATUSES = ' + statuses + ';', ctx);
  ['esc', 'stampLineHTML', 'stampsHTML'].forEach(n => vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), ctx));
  const stampsOf = po => vm.runInContext('stampsHTML(' + JSON.stringify(po) + ')', ctx);
  const bylines = po => [...new JSDOM(stampsOf(po)).window.document.querySelectorAll('.stamp')]
    .map(el => ({ text: el.textContent, title: el.getAttribute('title') }));

  let got = bylines({ id: 'a', status: 'approved', created_at: T1, created_by: 'hudockben',
                      status_changed_at: T2, status_changed_by: 'farmerykaleb' });
  assert('two bylines, each saying what it is: who raised it, then who set its status',
    got.length === 2 && got[0].text === 'Created hudockben · ' + day(T1)
    && got[1].text === 'Approved farmerykaleb · ' + day(T2), JSON.stringify(got));
  assert('  with the time on hover',
    got[0].title === 'Created by hudockben · ' + day(T1) + ', ' + time(T1), got[0].title);
  got = bylines({ id: 'b', status: 'pending', created_at: T1, created_by: 'hudockben' });
  assert('an order whose status nobody has changed shows who raised it',
    got.length === 1 && got[0].text === 'Created hudockben · ' + day(T1), JSON.stringify(got));
  got = bylines({ id: 'c', status: 'closed', status_changed_at: T2, status_changed_by: 'farmerykaleb' });
  assert('an order raised before the stamp existed shows only its status byline',
    got.length === 1 && got[0].text === 'Closed farmerykaleb · ' + day(T2), JSON.stringify(got));
  assert('  and one with neither shows nothing', bylines({ id: 'd', status: 'pending' }).length === 0);
  assert('a time that does not read as one is left out rather than shown as "Invalid Date"',
    bylines({ id: 'e', created_at: 'garbage', created_by: 'x' }).length === 0);
  got = bylines({ id: 'f', created_at: T1 });
  assert('a stamp with no name still says when',
    got.length === 1 && got[0].text === 'Created ' + day(T1), JSON.stringify(got));
  const evilHtml = stampsOf({ id: 'g', created_at: T1, created_by: evil });
  assert('the name is escaped',
    new JSDOM(evilHtml).window.document.querySelectorAll('img').length === 0
    && bylines({ id: 'g', created_at: T1, created_by: evil })[0].text.includes(evil), evilHtml);
  assert('the bylines sit under the status dropdown in the table',
    /const meta = stampsHTML\(po\);/.test(PAGE) && /'<td>' \+ statusSelectHTML\(po\) \+ meta \+ '<\/td>'/.test(PAGE));
  assert('  and under Status on a phone card',
    /<label>Status<\/label>' \+ statusSelectHTML\(po\) \+ stampsHTML\(po\) \+ '<\/div>'/.test(PAGE));

  // + New PO stamps it, and the stamp goes out with the save.
  const nctx = vm.createContext({});
  vm.runInContext(`
    const perm = { canEdit: true };
    const fctUser = { username: 'hudockben' };
    let purchaseOrders = [], page = 3;
    const expanded = new Set();
    let saved = null;
    function defaultNewDivision() { return 'purchase_orders'; }
    function nextPONumber() { return 'PO-0042'; }
    function uid() { return 'id' + purchaseOrders.length; }
    function localDateStr() { return '2026-11-03'; }
    function newLine() { return { id: 'L1' }; }
    function savePO(po) { saved = po; }
    function render() {}
    function toast() {}
  `, nctx);
  ['newPO', 'poPayload'].forEach(n => vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), nctx));
  const t0 = Date.now();
  const raised = vm.runInContext('newPO()', nctx);
  assert('+ New PO stamps who raised the order', raised && raised.created_by === 'hudockben', JSON.stringify(raised));
  assert('  and when', Date.parse(raised.created_at) >= t0 && Date.parse(raised.created_at) <= Date.now(),
    raised && raised.created_at);
  const sent = vm.runInContext('poPayload(saved)', nctx);
  assert('  and both go out with the save', sent.created_by === 'hudockben' && sent.created_at === raised.created_at,
    JSON.stringify(sent));

  // ...and so does a scanned receipt that raises a new order.
  const scanNew = sliceSource(PAGE,
    '      po = {\n        id:           uid(),\n        po_number:    nextPONumber(divKey),',
    '        _division:    divKey,', 'the order a scan raises', ['origin:']);
  assert('a scanned receipt that raises an order is stamped the same way',
    /created_at:\s+new Date\(\)\.toISOString\(\)/.test(scanNew)
    && /created_by:\s+\(fctUser && fctUser\.username\) \|\| ''/.test(scanNew), scanNew);

  // ── The division tabs ──
  const when = iso => day(iso) + ' ' + time(iso);
  ['tracker.html', 'paving.html', 'kiewit-pinetree.html'].forEach(f => {
    const src = read(f);

    // + New PO stamps it before the save that stores it.
    const actx = vm.createContext({});
    vm.runInContext(`
      const fctUser = { username: 'farmerykaleb' };
      let purchaseOrders = [], poPage = 2;
      const _poExpanded = new Set();
      let savedWith = null;
      function uid() { return 'id' + Math.random().toString(36).slice(2); }
      function nextPONumber() { return 'PO-0007'; }
      function _localDateStr() { return '2026-11-03'; }
      function savePurchaseOrders() { savedWith = JSON.parse(JSON.stringify(purchaseOrders)); }
      function renderPOTab() {}
    `, actx);
    vm.runInContext(requireFn(src, 'addPO', f), actx);
    const t1 = Date.now();
    vm.runInContext('addPO()', actx);
    const stored = (vm.runInContext('savedWith', actx) || [])[0] || {};
    assert(`${f}: + New PO stamps who raised the order, in the save`,
      stored.created_by === 'farmerykaleb', JSON.stringify(stored));
    assert(`${f}:   and when`, Date.parse(stored.created_at) >= t1 && Date.parse(stored.created_at) <= Date.now(),
      stored.created_at);

    // The status cell, lifted from renderPOTab and run.
    const block = sliceSource(src, "        const statusOpts = [['pending','Pending']",
      '        // Badge showing delivery count', `${f} status cell`, ['statusMeta = ']);
    const rctx = vm.createContext({});
    ['esc', 'escT', '_poStampWhen'].forEach(n => vm.runInContext(requireFn(src, n, f), rctx));
    const cellOf = po => vm.runInContext('(function (po) {\n' + block + '\nreturn createdMeta + statusMeta;\n})('
      + JSON.stringify(po) + ')', rctx);
    const lines = po => [...new JSDOM(cellOf(po)).window.document.body.children]
      .map(el => el.textContent).filter(Boolean);

    let cell = lines({ id: 'a', status: 'approved', created_at: T1, created_by: 'hudockben',
                       status_changed_at: T2, status_changed_by: 'farmerykaleb' });
    assert(`${f}: the status cell shows who raised the order, then who set its status`,
      cell.length === 2 && cell[0] === 'Created hudockben · ' + when(T1)
      && cell[1] === 'Approved farmerykaleb · ' + when(T2), JSON.stringify(cell));
    cell = lines({ id: 'b', status: 'pending', created_at: T1, created_by: 'hudockben' });
    assert(`${f}:   only the first when the status was never changed`,
      cell.length === 1 && cell[0] === 'Created hudockben · ' + when(T1), JSON.stringify(cell));
    cell = lines({ id: 'c', status: 'closed', status_changed_at: T2, status_changed_by: 'x' });
    assert(`${f}:   only the second for an order raised before the stamp`,
      cell.length === 1 && cell[0] === 'Closed x · ' + when(T2), JSON.stringify(cell));
    assert(`${f}:   and nothing for an unreadable time`,
      lines({ id: 'd', status: 'pending', created_at: 'garbage', created_by: 'x' }).length === 0);
    const evilCell = cellOf({ id: 'e', status: 'pending', created_at: T1, created_by: evil });
    assert(`${f}: the name is escaped as text`,
      new JSDOM(evilCell).window.document.querySelectorAll('img').length === 0, evilCell);

    // Changing the status repaints its own byline in place. The Created line is
    // a separate element, so it survives.
    const dom = new JSDOM('<!doctype html><body>' +
      '<select data-po-id="a" data-po-field="status"><option value="pending">Pending</option>' +
      '<option value="approved">Approved</option><option value="closed">Closed</option></select>' +
      '<div id="po-created-meta-a">Created hudockben</div><div id="po-status-meta-a"></div></body>');
    const hctx = vm.createContext({ document: dom.window.document, console });
    vm.runInContext(`
      const fctUser = { username: 'farmerykaleb' };
      let purchaseOrders = [{ id: 'a', status: 'pending', project_id: '', lines: [],
                              created_at: '${T1}', created_by: 'hudockben' }];
      let saves = 0;
      function savePurchaseOrders() { saves++; }
      function _syncPOHeaderToLines() { return Promise.resolve(); }
      function renderProjectPOs() {}
      const _poEditedFields = {};
      let _poEditSeq = 0;
    `, hctx);
    ['_poStampWhen', '_poNoteEdit', '_handlePOEvent'].forEach(n => vm.runInContext(requireFn(src, n, f), hctx));
    dom.window.document.querySelector('select').value = 'closed';
    vm.runInContext('_handlePOEvent({ type: "change", target: document.querySelector("select") })', hctx);
    const meta = dom.window.document.getElementById('po-status-meta-a');
    const po = vm.runInContext('purchaseOrders[0]', hctx);
    assert(`${f}: a status change repaints its byline under the new status's name`,
      meta.textContent === 'Closed farmerykaleb · ' + when(po.status_changed_at)
      && meta.querySelector('b') && meta.querySelector('b').textContent === 'Closed', meta.innerHTML);
    assert(`${f}:   leaves the Created line alone`,
      dom.window.document.getElementById('po-created-meta-a').textContent === 'Created hudockben');
    assert(`${f}:   keeps who raised the order`,
      po.created_by === 'hudockben' && po.created_at === T1 && vm.runInContext('saves', hctx) === 1,
      JSON.stringify(po));
    // ...and tells the save it changed the status, and nothing else on the
    // order — so the server keeps every other field as stored.
    assert(`${f}:   and records the status as this tab's edit`,
      vm.runInContext('JSON.stringify([...(_poEditedFields.a || new Map()).keys()])', hctx) === '["status"]',
      vm.runInContext('JSON.stringify([...(_poEditedFields.a || new Map()).keys()])', hctx));
  });
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
    function _lineUnitCostWithTax(l) { return parseFloat(l.unit_cost) || 0; }
  `, ctx);
  vm.runInContext('async ' + requireFn(read('tracker.html'), '_syncPOLineToRow', 'tracker.html'), ctx);
  await vm.runInContext(`_syncPOLineToRow(
    { project_id:'p1', cost_code:'100', sub_code:'A', title:'Stone', supplier:'Acme', po_number:'PO-0007' },
    { id:'L1', po_row_id:'row-1', date:'2026-02-02', employee:'Sam', qty:'10', unit_cost:'5' })`, ctx);

  // The row on screen follows the delivery; the row on the server is written
  // by the order's own save, from the delivery as stored (writeTabRows). This
  // page PUTting the row whole from its own copy of the job is what put a
  // stale quantity back on the job whenever anything else on it was edited.
  const out = vm.runInContext('proj.dailyRows.find(r => r.id === "row-1")', ctx);
  assert('the job\'s rows are fetched rather than assumed empty',
    vm.runInContext('fetched', ctx) === 1, String(vm.runInContext('fetched', ctx)));
  assert('the delivery figures reach the row on screen',
    out && out.units_purchased === '10' && out.unit_cost === '5' && out.material_cost === '50',
    JSON.stringify(out));
  assert('and the installed quantity is left alone',      out.quantity  === '250', JSON.stringify(out));
  assert('and the job class',                             out.job_class === 'Operator', JSON.stringify(out));
  assert('and the cost code the supervisor re-coded',
    out.cost_code === '999' && out.sub_code === 'SUPERVISOR', JSON.stringify(out));
  assert('and it is the stored row, not a new one',
    vm.runInContext('proj.dailyRows.length', ctx) === 1);
  assert('and this page writes no row itself — the order\'s save does, on the server',
    vm.runInContext('written.length', ctx) === 0, JSON.stringify(vm.runInContext('written', ctx)));
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
    const _editedLines  = {};
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
    function editedLinesFor() { return []; }
    async function api(method, path) { calls.push(method + ' ' + path); return {}; }
  `, ctx);
  vm.runInContext(EDIT_BOOKKEEPING, ctx);
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
    const _editedLines  = {};
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
    function editedLinesFor() { return []; }
    async function api(method, path) { calls.push(method + ' ' + path); return {}; }
  `, ctx2);
  vm.runInContext(EDIT_BOOKKEEPING, ctx2);
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
    const _editedLines  = {};
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
    function editedLinesFor() { return []; }
    function deletedLineIdsSent() { return []; }
    async function api(method, path) {
      calls.push(method + ' ' + path);
      if (method === 'DELETE') return deletePromise;
      return {};
    }
  `, ctx3);
  vm.runInContext(EDIT_BOOKKEEPING, ctx3);
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

console.log('\n[cost / sub code, vendor and received by are typeahead pickers]');
{
  // Structural: every place the three fields appear goes through the picker,
  // and the datalists it replaced are gone rather than left half-wired.
  assert('the order table uses the pickers',
    /'<td>' \+ subCodePickerHTML\(po\) \+ '<\/td>'/.test(PAGE) && /'<td>' \+ vendorPickerHTML\(po\) \+ '<\/td>'/.test(PAGE));
  assert('and so does the phone card editor',
    /<label>Cost \/ Sub Code<\/label>' \+ subCodePickerHTML\(po\)/.test(PAGE)
    && /<label>Vendor<\/label>' \+ vendorPickerHTML\(po\)/.test(PAGE));
  assert('every delivery row — both surfaces build them — picks who received it',
    /receivedByPickerHTML\(po, l\)/.test(PAGE));
  assert('the scan sheet\'s code is a picker too, closed until a job is chosen',
    /cbHtml\('scan-codes', '', \{[^}]*attrs: 'id="sc-code"', disabled: true \}\)/.test(PAGE));
  assert('and its save refuses a code that was typed but never picked',
    /const scanCode = codeBox \? cbResolve\(codeBox, cbOptionsFor\(codeBox\.closest\('\.cb'\)\)\) : \{ value: '' \};/.test(PAGE)
    && /if \(!scanCode\) \{[\s\S]{0,200}Pick the cost \/ sub code from the list, or clear it\./.test(PAGE)
    && /const codeVal = scanCode\.value\.split\('\|\|'\);/.test(PAGE));
  assert('no datalist is left behind',
    !/<datalist id=/.test(PAGE) && !/createElement\('datalist'\)/.test(PAGE) && !/list="(vendor|employee)-list"/.test(PAGE));
  // A re-render after a code is taken rebuilt the row under the field Tab had
  // just moved to; holding it back until the fields were left moved the damage
  // onto the next button pressed, rebuilt mid-press, its click lost.
  assert('a new code is shown in place, never by re-rendering the rows',
    /savePO\(po, \{ immediate: true \}\);\s*\n\s*updateCodeInPlace\(po\);\s*\n\}/.test(PAGE)
    && !/renderWhenIdle/.test(PAGE));
  assert('  including the card\'s job line, which has an id to be found by',
    /'<div class="meta" id="card-job-' \+ idAttr\(po\.id\) \+ '">' \+ cardJobLineHTML\(po\)/.test(PAGE));
  // A press that began inside the sheet and was let go over the backdrop is
  // sent to the backdrop as a click, and read as a tap beside the sheet.
  assert('only a press that began on the backdrop closes the scan sheet',
    /_pressOnScanBackdrop = e\.target === this;/.test(PAGE)
    && /addEventListener\('click', function \(e\) \{\s*\n\s*if \(!_pressOnScanBackdrop\) return;/.test(PAGE));

  // Behavioural: the page's own picker, run in a real DOM with the inline
  // handlers live, against one paving job.
  const start = PAGE.indexOf('const _cbState = new WeakMap();');
  const end   = PAGE.lastIndexOf('/*', PAGE.indexOf('\n   RENDER\n'));
  const region = start > -1 && end > start ? PAGE.slice(start, end) : '';
  assert('the combobox region can be lifted whole',
    region.includes('function cbHtml(') && region.includes("document.addEventListener('mousedown'")
    && region.includes("document.addEventListener('click'"));

  const harness = [
    `var GENERAL = 'purchase_orders';
     var PO_SOURCE = ['turf', 'paving', 'kiewit', 'quarry'];
     var PO_JOB = ['turf', 'paving', 'kiewit'];
     var PO_SOURCE_LABELS = { turf: 'Turf Management', paving: 'Paving', kiewit: 'Kiewit Pinetree', quarry: 'Quarry' };
     var sourceDivs = [{ division: 'paving', label: 'Paving', projects: [{ id: 'p1', name: 'Route 9', jobNumber: '2201', codes: [
       { cost_code: '100', sub_code: 'Mobilization', description: '' },
       { cost_code: '420', sub_code: 'Base',    description: 'Stone base' },
       { cost_code: '420', sub_code: 'Surface', description: 'Asphalt surface' },
       { cost_code: '510', sub_code: 'Stone',   description: 'Rip rap' },
     ] }] }, { division: 'quarry', label: 'Quarry', projects: [] }];
     var catalog = {
       vendors:   [{ name: 'Fastenal' }, { name: 'Home Depot' }, { name: 'Tri-State Aggregates & Supply Co' }],
       employees: [{ name: 'Dana Ruiz' }, { name: 'Lee Park' }],
     };
     var purchaseOrders = [{ id: 'po1', po_number: 'PO-0001', _division: 'paving', project_id: 'p1',
       cost_code: '420', sub_code: 'Base', supplier: 'Home Depot', lines: [{ id: 'l1', employee: '' }] }];
     var fctUser = { username: 'tester' };
     var DIV_COLORS = { turf: 'var(--div-turf)', paving: 'var(--div-paving)', kiewit: 'var(--div-kiewit)', quarry: 'var(--div-quarry)' };
     var saves = [], renders = 0;
     var _editedLines = {};
     function capsFor() { return { canEdit: true, canDelete: true }; }
     function savePO(po, opts) {
       saves.push({ immediate: !!(opts && opts.immediate), supplier: po.supplier, code: po.cost_code + '||' + po.sub_code });
     }
     function render() { renders++; }
     function recalcLineTax() {}
     function updateTotalsInPlace() {}`,
    EDIT_BOOKKEEPING,
    ...['esc', 'listDivs', 'divMeta', 'projectsFor', 'projectFor', 'pickableProjects',
        'projectOptionLabel', 'codesFor', 'codeLabel', 'codeValue', 'subCodePickerHTML', 'vendorPickerHTML',
        'receivedByPickerHTML', 'updateCodeInPlace', 'cardJobLineHTML', 'divChipHTML', 'divColor', 'divLabel',
        'hasJobs', 'projectSelectHTML', 'setSubCode', 'setField', 'setLineField', 'onScanDivision', 'onScanProject',
        'resetScanCode']
      .map(n => requireFn(PAGE, n, 'purchase-orders.html')),
    region,
  ].join('\n\n');

  const dom = new JSDOM('<!doctype html><body><table><tbody><tr id="row"></tr></tbody></table>' +
    '<div id="cards"></div><input id="elsewhere"><div id="sheet"></div></body>',
    { url: 'http://localhost/', runScripts: 'dangerously' });
  const { window } = dom;
  const doc = window.document;
  // jsdom lays nothing out, and has no scrollIntoView to scroll a list with.
  window.Element.prototype.scrollIntoView = function () {};
  window.eval(harness);
  // The order as the table shows it, and as its card does: both are in the
  // page at once, whichever is on screen.
  window.eval(`document.getElementById('row').innerHTML =
    '<td>' + subCodePickerHTML(purchaseOrders[0]) + '</td>' +
    '<td>' + vendorPickerHTML(purchaseOrders[0]) + '</td>' +
    '<td>' + receivedByPickerHTML(purchaseOrders[0], purchaseOrders[0].lines[0]) + '</td>';
    document.getElementById('cards').innerHTML =
      '<div class="meta" id="card-job-po1">' + cardJobLineHTML(purchaseOrders[0]) + '</div>' +
      subCodePickerHTML(purchaseOrders[0]);`);

  const box   = list => doc.querySelector('.cb[data-list="' + list + '"] .cb-input');
  const menu  = el => [...el.nextElementSibling.querySelectorAll('.cb-opt')].map(o => o.textContent);
  const hi    = el => { const h = el.nextElementSibling.querySelector('.cb-opt.hi'); return h ? h.textContent : null; };
  const type  = (el, text) => { el.value = text; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const key   = (el, k) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const state = () => window.eval('({ po: purchaseOrders[0], saves: saves.slice(), renders: renders })');
  const settle = () => new Promise(r => setTimeout(r, 150));   // past the 120ms blur commit
  const mouse = (el, type, button) =>
    el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, button: button || 0 }));
  const elsewhere = doc.getElementById('elsewhere');

  // ── Cost / Sub Code ──
  const code = box('codes');
  const cardCode = doc.querySelector('#cards .cb[data-list="codes"] .cb-input');
  const cardLine = doc.getElementById('card-job-po1');
  assert('the code cell is a search over the job\'s codes, not a <select>',
    Boolean(code) && code.closest('.cb').dataset.po === 'po1' && !doc.querySelector('#row select'));
  assert('  showing the order\'s code by its label', code.value === '420 / Base — Stone base', code.value);
  assert('  with the code itself behind it', code.dataset.cbValue === '420||Base', code.dataset.cbValue);

  code.focus();
  assert('focusing it lists the job\'s codes',
    menu(code).join(' | ') === '100 / Mobilization | 420 / Base — Stone base | 420 / Surface — Asphalt surface | 510 / Stone — Rip rap',
    menu(code).join(' | '));
  assert('  with the order\'s own code highlighted', hi(code) === '420 / Base — Stone base', hi(code));
  type(code, 'stone');
  assert('typing narrows to the codes it appears in',
    menu(code).join(' | ') === '420 / Base — Stone base | 510 / Stone — Rip rap', menu(code).join(' | '));
  type(code, 'rip 510');
  assert('  matching every word, in any order', menu(code).join(' | ') === '510 / Stone — Rip rap', menu(code).join(' | '));
  assert('  and a search writes nothing', state().saves.length === 0 && state().po.cost_code === '420');
  type(code, 'zzz');
  assert('a search with no hit says so',
    code.nextElementSibling.textContent === 'No code on this job matches', code.nextElementSibling.textContent);

  type(code, 'rip');
  key(code, 'Enter');
  let s = state();
  assert('Enter takes the highlighted code', s.po.cost_code === '510' && s.po.sub_code === 'Stone', JSON.stringify(s.po));
  assert('  saved straight away', s.saves.length === 1 && s.saves[0].immediate && s.saves[0].code === '510||Stone',
    JSON.stringify(s.saves));
  assert('  and the box shows its label', code.value === '510 / Stone — Rip rap', code.value);
  await settle();
  assert('  nothing is re-rendered for it', state().renders === 0, state().renders);
  assert('  the same order\'s box on the other surface shows the new code too',
    cardCode.value === '510 / Stone — Rip rap' && cardCode.dataset.cbValue === '510||Stone', cardCode.value);
  assert('  and so does the card\'s job line', /510 \/ Stone/.test(cardLine.textContent), cardLine.textContent);
  assert('  and the blur after it writes nothing more', state().saves.length === 1, state().saves.length);

  code.focus(); type(code, 'asph'); code.blur(); await settle();
  s = state();
  assert('half-typed text that names no code goes back to the order\'s code',
    code.value === '510 / Stone — Rip rap' && code.dataset.cbValue === '510||Stone' && s.po.cost_code === '510',
    code.value);
  assert('  without a write', s.saves.length === 1, s.saves.length);

  code.focus(); type(code, '420 / surface'); code.blur(); await settle();
  s = state();
  assert('the bare pair typed in full is taken without its description',
    s.po.sub_code === 'Surface' && code.value === '420 / Surface — Asphalt surface', code.value);

  code.focus(); type(code, ''); key(code, 'Enter'); await settle();
  s = state();
  assert('emptying the box and pressing Enter clears the code — rather than taking the first entry',
    s.po.cost_code === '' && s.po.sub_code === '', JSON.stringify(s.po));
  assert('  on both surfaces', cardCode.value === '' && !cardCode.dataset.cbValue
    && !/\//.test(cardLine.textContent), cardLine.textContent);

  // Tab commits and moves on in one keystroke. A synthetic keydown has no
  // default action, so the move is made by hand.
  code.focus(); type(code, 'mobil'); key(code, 'Tab'); elsewhere.focus(); await settle();
  s = state();
  assert('Tab takes the code too', s.po.cost_code === '100' && s.po.sub_code === 'Mobilization', JSON.stringify(s.po));
  elsewhere.blur(); await settle();
  assert('  and nothing is rebuilt — not under the field the focus moved to, nor once it leaves',
    state().renders === 0, state().renders);

  // The old <select> kept a code the job no longer carries as an extra
  // option, so the order still showed it. The box has to keep that promise.
  window.eval("purchaseOrders[0].cost_code = '999'; purchaseOrders[0].sub_code = 'Gone';" +
    "document.querySelector('.cb[data-list=codes]').parentNode.innerHTML = subCodePickerHTML(purchaseOrders[0]);");
  const gone = box('codes');
  assert('a code the job no longer carries still labels its order',
    gone.value === '999 / Gone (not on this job)', gone.value);
  const savesBefore = state().saves.length;
  gone.focus(); gone.blur(); await settle();
  assert('  and survives a focus and blur that changed nothing',
    state().po.cost_code === '999' && state().saves.length === savesBefore, JSON.stringify(state().po));

  // ── Vendor ──
  const vendor = box('vendors');
  vendor.focus();
  assert('the vendor box lists the catalogue\'s vendors',
    menu(vendor).join(' | ') === 'Fastenal | Home Depot | Tri-State Aggregates & Supply Co', menu(vendor).join(' | '));
  assert('  with the order\'s vendor highlighted', hi(vendor) === 'Home Depot', hi(vendor));
  type(vendor, 'Tri');
  assert('a vendor is written as it is typed, as the plain box wrote it', state().po.supplier === 'Tri', state().po.supplier);
  type(vendor, 'state');
  assert('  matching inside a name, not only at its start',
    menu(vendor).join(' | ') === 'Tri-State Aggregates & Supply Co', menu(vendor).join(' | '));
  // Free text only suggests. Tab there still means the next field, and a
  // name that a longer entry contains is a real name in its own right.
  assert('  suggested, not chosen: a partial match is not highlighted', hi(vendor) === null, hi(vendor));
  key(vendor, 'Enter');
  assert('so Enter keeps what was typed', state().po.supplier === 'state' && vendor.value === 'state',
    state().po.supplier);
  await settle();
  vendor.focus(); type(vendor, 'state');
  const rowBefore = vendor.nextElementSibling.querySelector('.cb-opt');
  key(vendor, 'ArrowDown');
  assert('ArrowDown highlights the suggestion', hi(vendor) === 'Tri-State Aggregates & Supply Co', hi(vendor));
  assert('  restyling the row it lands on, not rebuilding the list',
    vendor.nextElementSibling.querySelector('.cb-opt') === rowBefore
    && vendor.getAttribute('aria-activedescendant') === rowBefore.id);
  key(vendor, 'Enter');
  assert('  for Enter to take it',
    state().po.supplier === 'Tri-State Aggregates & Supply Co' && vendor.value === 'Tri-State Aggregates & Supply Co',
    state().po.supplier);
  await settle();
  vendor.focus(); type(vendor, 'home depot');
  assert('the same name typed in other capitals is chosen for it', hi(vendor) === 'Home Depot', hi(vendor));
  key(vendor, 'Tab'); elsewhere.focus(); await settle();
  assert('  and Tab writes it as listed', state().po.supplier === 'Home Depot' && vendor.value === 'Home Depot',
    state().po.supplier);

  vendor.focus(); type(vendor, 'Acme Rentals');
  assert('a vendor not on the list is kept as typed', state().po.supplier === 'Acme Rentals', state().po.supplier);
  assert('  and the list says it will be', vendor.nextElementSibling.textContent === 'No match — saved as typed',
    vendor.nextElementSibling.textContent);
  vendor.blur(); await settle();
  assert('  leaving the box keeps it', state().po.supplier === 'Acme Rentals' && vendor.value === 'Acme Rentals');

  let escapes = 0;
  doc.addEventListener('keydown', e => { if (e.key === 'Escape') escapes++; });
  vendor.focus(); type(vendor, 'Fast'); key(vendor, 'Escape'); await settle();
  assert('Escape puts the vendor back, the write included',
    state().po.supplier === 'Acme Rentals' && vendor.value === 'Acme Rentals', state().po.supplier);
  assert('  and goes no further, so it cannot close the sheet the box sits in', escapes === 0, escapes);

  // Coming back to the window refocuses the box. That is not a new visit: what
  // Escape goes back to, and what the list is narrowed to, both stand.
  vendor.focus(); type(vendor, 'Fa');
  vendor.dispatchEvent(new window.FocusEvent('focus'));
  assert('the focus coming back with the window leaves the list as it was narrowed',
    menu(vendor).join(' | ') === 'Fastenal', menu(vendor).join(' | '));
  key(vendor, 'Escape'); await settle();
  assert('  and Escape still goes back to what the box held before the typing',
    state().po.supplier === 'Acme Rentals' && vendor.value === 'Acme Rentals', state().po.supplier);

  // The pick is the click, not the press: a press hid the list under the
  // pointer, and the release fell through to whatever lay beneath it.
  vendor.focus(); type(vendor, 'fast');
  const fastenal = vendor.nextElementSibling.querySelector('.cb-opt');
  mouse(fastenal, 'mousedown');
  assert('pressing on an entry does not take it yet, and keeps the list open',
    state().po.supplier === 'fast' && !vendor.nextElementSibling.hidden, state().po.supplier);
  mouse(fastenal, 'click', 2);
  assert('  nor does a click of another button — a right-click to copy it',
    state().po.supplier === 'fast' && !vendor.nextElementSibling.hidden, state().po.supplier);
  mouse(fastenal, 'click');
  assert('a click on an entry takes it', state().po.supplier === 'Fastenal' && vendor.value === 'Fastenal',
    state().po.supplier);
  await settle();

  // ── Received By ──
  const recv = box('employees');
  recv.focus();
  assert('an empty Received By opens with nothing highlighted', hi(recv) === null, hi(recv));
  key(recv, 'Tab'); elsewhere.focus(); await settle();
  assert('  so tabbing through it leaves it empty', state().po.lines[0].employee === '' && recv.value === '',
    state().po.lines[0].employee);
  recv.focus(); type(recv, 'Lee');
  assert('a name is written to the delivery as it is typed', state().po.lines[0].employee === 'Lee');
  key(recv, 'Tab'); elsewhere.focus(); await settle();
  assert('  and Tab keeps it: a delivery taken by "Lee" does not become "Lee Park"',
    state().po.lines[0].employee === 'Lee' && recv.value === 'Lee', state().po.lines[0].employee);
  recv.focus(); type(recv, 'lee'); key(recv, 'ArrowDown'); key(recv, 'Enter'); await settle();
  assert('ArrowDown then Enter takes the listed name', state().po.lines[0].employee === 'Lee Park',
    state().po.lines[0].employee);

  // ── Ids ──
  // The ids reach the box through data- attributes, never a handler, so a
  // crafted one is inert text rather than markup.
  const hostile = 'x" onfocus="alert(1)';
  window.eval('var hostileHtml = vendorPickerHTML(' + JSON.stringify({ id: hostile, _division: 'paving', supplier: 'A' }) + ');');
  const holder = doc.createElement('div');
  holder.innerHTML = window.hostileHtml;
  assert('a quote in an order id cannot break out of the box\'s markup',
    holder.querySelector('.cb').dataset.po === hostile
    && holder.querySelector('input').getAttribute('onfocus') === 'cbOnFocus(this)', window.hostileHtml);

  // ── The scan sheet ──
  window.eval(`document.getElementById('sheet').innerHTML =
    '<select id="sc-division"><option value="paving">Paving</option></select>' +
    '<select id="sc-project"><option value="">General — no job</option></select>' +
    cbHtml('scan-codes', '', { placeholder: '— pick a job first —', attrs: 'id="sc-code"', disabled: true });
    onScanDivision('paving');`);
  const sc = doc.getElementById('sc-code');
  const resolveScan = () => window.eval(
    "cbResolve(document.getElementById('sc-code'), cbOptionsFor(document.getElementById('sc-code').closest('.cb')))");
  assert('the scan sheet\'s code box waits for a job', sc.disabled && sc.placeholder === '— pick a job first —');
  doc.getElementById('sc-project').value = 'p1';
  window.eval("onScanProject('p1')");
  assert('  and opens for one with codes', !sc.disabled && sc.placeholder === 'Search codes…', sc.placeholder);
  sc.focus(); type(sc, 'base'); sc.blur(); await settle();
  assert('a half-typed code stays in the sheet\'s box, for its save to refuse',
    sc.value === 'base' && resolveScan() === null, sc.value);
  sc.focus(); type(sc, 'base'); key(sc, 'Enter'); await settle();
  assert('  and a picked one is what the save books', (resolveScan() || {}).value === '420||Base',
    JSON.stringify(resolveScan()));
  window.eval("onScanProject('')");
  assert('changing the job empties the box and closes it again',
    sc.value === '' && !sc.dataset.cbValue && sc.disabled && sc.placeholder === 'No job — no code');

  // ── Quarry: a division with no jobs ──
  // Orders file there, but there is nothing to charge, so the job and code
  // pickers say so instead of offering a lone "General — no job".
  window.eval("onScanDivision('quarry')");
  const scProj = doc.getElementById('sc-project');
  assert('the scan sheet has no job to offer in quarry',
    scProj.disabled && scProj.options.length === 1 && scProj.options[0].text === 'No jobs in Quarry',
    scProj.innerHTML);
  assert('  and its code box stays shut', sc.disabled && sc.placeholder === '—', sc.placeholder);
  window.eval("onScanDivision('paving')");
  assert('  while paving still offers its jobs',
    !scProj.disabled && [...scProj.options].some(o => o.value === 'p1'), scProj.innerHTML);
  const quarryPO = { id: 'q1', _division: 'quarry', project_id: '', cost_code: '', sub_code: '', lines: [] };
  const qJob  = window.eval('projectSelectHTML(' + JSON.stringify(quarryPO) + ')');
  const qCode = window.eval('subCodePickerHTML(' + JSON.stringify(quarryPO) + ')');
  assert('a quarry order\'s row has no job picker', !/<select/.test(qJob) && /No jobs in Quarry/.test(qJob), qJob);
  assert('  nor a code picker', !/class="cb/.test(qCode) && />—</.test(qCode), qCode);
  assert('  and its chip is quarry\'s colour', /var\(--div-quarry\)/.test(window.eval("divChipHTML('quarry')")));
}

console.log('\n[a save says which of the order\'s fields it changed]');
{
  // Every save carried the whole order as this page last saw it, and the server
  // stored it whole — so approving PO-0365 on a screen that had loaded it blank
  // wiped the title and supplier somebody else had filled in. The page now
  // tells the server which fields it changed; the server keeps the rest.
  //
  // The page's own setters and save, run against a stubbed api().
  const dom = new JSDOM('<!doctype html><html><body><input id="elsewhere"></body></html>');
  const ctx = vm.createContext({ document: dom.window.document, console, JSON, Promise, Set, Math,
                                 setTimeout, clearTimeout });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    let purchaseOrders = [{ id: 'po365', po_number: 'PO-0365', _division: 'paving', project_id: 'p1',
                            cost_code: '', sub_code: '', title: '', supplier: '', status: 'pending', lines: [] }];
    let sourceDivs = [{ division: 'paving', label: 'Paving', projects: [] }, { division: 'turf', label: 'Turf', projects: [] }];
    const loadedLists = new Set(['paving', 'turf']);
    const fctUser = { username: 'hudockben' };
    const _saveTimers = {}, _unsaved = new Set(), _deletedLines = {}, _editedLines = {};
    const _savedDivision = { po365: 'paving' }, _saveChain = {}, _deleting = new Set(), _deferredSaves = new Set();
    let _inflight = 0, _saveEpoch = 0, renders = 0;
    const sent = [];
    let answer = null, hold = null;
    function capsFor() { return { canEdit: true, canDelete: true }; }
    function showSave() {} function toast() {} function updateCodeInPlace() {}
    function render() { renders++; }
    function deletedLinesFor() { return []; }
    function poPayload(po) { const o = {}; Object.keys(po).forEach(k => { if (k[0] !== '_') o[k] = po[k]; }); return o; }
    // The save the server answers: the order as it stored it.
    async function api(method, path, body) {
      sent.push(JSON.parse(JSON.stringify(body)));
      if (hold) await hold;
      return { ok: true, purchaseOrder: Object.assign({}, body.purchaseOrder, answer || {}) };
    }
  `, ctx);
  vm.runInContext(EDIT_BOOKKEEPING, ctx);
  ['listDivs', 'divMeta', 'divLabel', 'projectsFor', 'projectFor', 'codesFor', 'nextPONumber',
   'setField', 'setSubCode', 'setProject', 'setDivision', 'savePO', '_savePONow', '_savePOWrite']
    .forEach(n => vm.runInContext((n === '_savePOWrite' ? 'async ' : '') + requireFn(PAGE, n, 'purchase-orders.html'), ctx));
  const run = e => vm.runInContext(e, ctx);
  const fields = () => run('JSON.stringify(editedFieldsFor("po365"))');
  const settle = () => new Promise(r => setTimeout(r, 20));

  // ── What each setter records ──
  run("setField('po365', 'status', 'approved')");
  assert('a status change is recorded as the field it changed', fields() === '["status"]', fields());
  run("setSubCode('po365', '420||Base')");
  assert('  a code change as both halves of the code', fields() === '["status","cost_code","sub_code"]', fields());
  run("clearSentEdits(_editedFields, 'po365', pendingEdits(_editedFields, 'po365'))");
  run("setProject('po365', 'p2')");
  assert('  a job change as the job and the codes it clears', fields() === '["project_id","cost_code","sub_code"]', fields());
  run("clearSentEdits(_editedFields, 'po365', pendingEdits(_editedFields, 'po365'))");
  run("setDivision('po365', 'turf')");
  assert('  a move as the job, the codes and the number', fields() === '["project_id","cost_code","sub_code","po_number"]', fields());
  run("clearSentEdits(_editedFields, 'po365', pendingEdits(_editedFields, 'po365'))");
  Object.values(run('_saveTimers')).forEach(t => clearTimeout(t));
  run("Object.keys(_saveTimers).forEach(k => delete _saveTimers[k]); sent.length = 0");

  // ── What a save sends, and what it takes back ──
  // This screen approves; somebody else filled the order in meanwhile, and the
  // server answers with the stored title and supplier.
  run(`purchaseOrders[0]._division = 'paving'; _savedDivision.po365 = 'paving';
       answer = { title: 'Drain Fabric', supplier: 'Hanes Geo Components', status: 'approved' };
       setField('po365', 'status', 'approved')`);
  await settle();
  assert('the save names the one field it changed',
    JSON.stringify(run('sent[0] && sent[0].editedFields')) === '["status"]', JSON.stringify(run('sent[0]')));
  assert('  and forgets it once stored', fields() === '[]', fields());
  assert('the screen takes on what the server kept',
    run('purchaseOrders[0].title') === 'Drain Fabric' && run('purchaseOrders[0].supplier') === 'Hanes Geo Components',
    run('JSON.stringify(purchaseOrders[0])'));
  assert('  and shows it', run('renders') > 0);

  // A field typed AGAIN while the save carrying it is in flight is owed to the
  // next save. Forgetting it when the first landed sent the second save out
  // saying nothing had changed, and the server kept the old value.
  run(`answer = null; let release; hold = new Promise(r => { release = r; }); globalThis.release = release;
       sent.length = 0; purchaseOrders[0].title = 'Drain'; noteEdit(_editedFields, 'po365', 'title');
       var first = _savePONow(purchaseOrders[0]);`);
  await settle();
  run(`purchaseOrders[0].title = 'Drain fabric, 12 oz'; noteEdit(_editedFields, 'po365', 'title');
       var second = _savePONow(purchaseOrders[0]);`);
  run('hold = null; release()');
  await settle();
  assert('a field edited again mid-save is sent again by the next save',
    run('sent.length') === 2 && JSON.stringify(run('sent[1].editedFields')) === '["title"]'
    && run('sent[1].purchaseOrder.title') === 'Drain fabric, 12 oz', JSON.stringify(run('sent')));

  // While a field has focus the screen is left alone — re-rendering would tear
  // the input out from under the typing — and the poll catches it up instead.
  run(`answer = { supplier: 'Someone Else Supply' }; sent.length = 0; renders = 0`);
  dom.window.document.getElementById('elsewhere').focus();
  await run('_savePONow(purchaseOrders[0])');
  assert('nothing is taken on while the user is typing',
    run('purchaseOrders[0].supplier') === 'Hanes Geo Components' && run('renders') === 0,
    run('JSON.stringify(purchaseOrders[0])'));
  dom.window.document.getElementById('elsewhere').blur();

  // A field with an edit still owed keeps the user's value over the server's.
  run(`answer = { title: 'stale', supplier: 'Someone Else Supply' }; noteEdit(_editedFields, 'po365', 'title');
       purchaseOrders[0].title = 'typed after this save left';`);
  run(`hold = new Promise(r => { globalThis.release2 = r; }); var p3 = _savePONow(purchaseOrders[0]);`);
  await settle();
  run(`noteEdit(_editedFields, 'po365', 'title'); hold = null; release2()`);
  await settle();
  assert('a field edited since the save left keeps what the user typed',
    run('purchaseOrders[0].title') === 'typed after this save left'
    && run('purchaseOrders[0].supplier') === 'Someone Else Supply', run('JSON.stringify(purchaseOrders[0])'));

  // The two other ways an order leaves this page.
  assert('the save made as the tab closes says which fields it changed too',
    /editedFields:\s*editedFieldsFor\(id\),/.test(PAGE));
  const scan = requireFn(PAGE, 'commitScan', 'purchase-orders.html');
  assert('a receipt scanned into an order records the supplier and title it fills',
    /fill\('supplier'/.test(scan) && /fill\('title'/.test(scan) && /noteEdit\(_editedFields, po\.id, k\)/.test(scan));
  assert('  and a save that fails takes those notes back', /noted\.forEach\(/.test(scan));
  assert('a deleted order\'s notes go with it',
    (requireFn(PAGE, 'deletePO', 'purchase-orders.html').match(/delete _editedFields\[poId\];/g) || []).length === 2);

  // The division tabs save their whole list, so every order in it travels with
  // each save — the one being edited and every other one, as old as the tab's
  // last refresh. The save says which fields of which orders, and which keys of
  // which deliveries, it changed — and what it deleted — goes out one at a
  // time, and takes back what the server merged. The page's own code, run.
  for (const f of ['tracker.html', 'paving.html', 'kiewit-pinetree.html']) {
    const src = read(f);
    const tctx = vm.createContext({ console, JSON, Promise, Object, Map, Set, setTimeout });
    vm.runInContext(`
      const window = { addEventListener() {} };
      const document = { activeElement: null };
      const API_BASE = '/api', fctToken = 't', activeTab = 'po';
      let purchaseOrders = [
        { id: 'a', status: 'pending', project_id: '', lines: [{ id: 'L1', qty: '10', unit_cost: '16', tax_pct: '' }] },
        { id: 'b', title: '', project_id: '', lines: [] },
      ];
      let _poBaseUpdatedAt = 'V0';
      const bodies = [], answers = [];
      let renders = 0, errors = 0;
      // Each request waits for the test to answer it.
      function fetch(url, init) {
        bodies.push(JSON.parse(init.body));
        return new Promise((ok, bad) => answers.push({ ok, bad }));
      }
      function reply(i, j) { answers[i].ok({ ok: true, status: 200, json: async () => j }); }
      function _showSaveError() { errors++; }
      function _poRefreshDailyLines() {}
      function renderPOTab() { renders++; }
      function renderProjectPOs() {}
      function _migratePOs() {}
      function getProj() { return null; }
      function _poLineFromDaily(l) { return Boolean(l && l.source === 'daily'); }
    `, tctx);
    vm.runInContext(sliceSource(src, 'const _poEditedFields = Object.create(null);', '// Whether a read of the purchase orders has worked.',
      f + ' PO edit state'), tctx);
    ['savePurchaseOrders', '_poAdoptSaved', '_poMergeLine', '_poRowsFollowOrder']
      .forEach(n => vm.runInContext(requireFn(src, n, f), tctx));
    const t = e => vm.runInContext(e, tctx);
    const J = e => JSON.stringify(t(e));

    // ── What a save says ──
    t(`purchaseOrders[0].status = 'approved'; _poNoteEdit('a', 'status');
       purchaseOrders[0].lines[0].qty = '12'; _poNoteLineEdit('a', 'L1', 'qty');
       savePurchaseOrders();`);
    assert(`${f}: a save names the order fields it changed — and nothing for orders it did not touch`,
      J('bodies[0].editedFields') === '{"a":["status"]}', J('bodies[0]'));
    assert(`${f}:   and each delivery's keys`, J('bodies[0].editedLineFields') === '{"a":{"L1":["qty"]}}',
      J('bodies[0].editedLineFields'));
    assert(`${f}:   and what it deleted (nothing yet)`,
      J('bodies[0].deletedLineIds') === '{}' && J('bodies[0].deletedOrderIds') === '[]');

    // ── One at a time ──
    t(`purchaseOrders[0].lines[0].qty = '14'; _poNoteLineEdit('a', 'L1', 'qty'); savePurchaseOrders();
       savePurchaseOrders();`);
    assert(`${f}: a second save waits for the first instead of racing it`, t('bodies.length') === 1);
    // The first lands. Purchasing had filled in order b meanwhile, so it comes
    // back; order a comes back as stored by THIS save — qty 12 — while the
    // screen already says 14.
    t(`reply(0, { ok: true, updatedAt: 'V1', orders: [
         { id: 'a', status: 'approved', project_id: '', lines: [{ id: 'L1', qty: '12', unit_cost: '16', tax_pct: '' }] },
         { id: 'b', title: 'Drain Fabric', project_id: '', lines: [] } ] })`);
    await settle();
    assert(`${f}:   the merged order is taken on`, t('purchaseOrders[1].title') === 'Drain Fabric', J('purchaseOrders[1]'));
    assert(`${f}:   but not over a key typed since the save left`, t('purchaseOrders[0].lines[0].qty') === '14',
      J('purchaseOrders[0]'));
    assert(`${f}:   and the version is adopted, the list now being the stored one`, t('_poBaseUpdatedAt') === 'V1');
    assert(`${f}:   the waiting save goes once the first has landed — once`, t('bodies.length') === 2, String(t('bodies.length')));
    assert(`${f}:   carrying only what is still owed`,
      J('bodies[1].editedFields') === '{}' && J('bodies[1].editedLineFields') === '{"a":{"L1":["qty"]}}',
      J('bodies[1]'));
    t(`reply(1, { ok: true, updatedAt: 'V2', orders: [] })`);
    await settle();
    assert(`${f}:   and nothing is owed once it lands`,
      t('Object.keys(_poEditedFields).length + Object.keys(_poEditedLines).length') === 0);

    // ── Deletions, and a save that does not land ──
    t(`(_poDeletedLines.a || (_poDeletedLines.a = new Set())).add('L9'); _poDeletedOrders.add('gone');
       purchaseOrders[1].title = 'x'; _poNoteEdit('b', 'title'); savePurchaseOrders();`);
    assert(`${f}: what was deleted is said`,
      J('bodies[2].deletedLineIds') === '{"a":["L9"]}' && J('bodies[2].deletedOrderIds') === '["gone"]', J('bodies[2]'));
    t(`answers[2].bad(new TypeError('Failed to fetch'))`);
    await settle();
    assert(`${f}:   a save that does not land is owed again, its edits and deletions kept`,
      t('_poSaveFailed') === true && t('_poEditedFields.b && _poEditedFields.b.has("title")') === true
      && t('_poDeletedOrders.has("gone")') === true && t('errors') === 1);
    t(`savePurchaseOrders(); answers[3].bad(new TypeError('Failed to fetch'))`);
    await settle();
    assert(`${f}:   and failing again says so once, not every retry`, t('errors') === 1, String(t('errors')));
    t(`savePurchaseOrders(); reply(4, { ok: true, updatedAt: 'V3', orders: [] })`);
    await settle();
    assert(`${f}:   until one lands`, t('_poSaveFailed') === false && t('_poDeletedOrders.size') === 0
      && !t('"a" in _poDeletedLines') && !t('"b" in _poEditedFields'));

    // ── A delivery the server dropped, and one added here meanwhile ──
    t(`purchaseOrders[0].lines.push({ id: 'dr-9', source: 'daily', qty: '1', po_row_id: '9' });
       savePurchaseOrders();
       purchaseOrders[0].lines.push({ id: 'NEW', qty: '' });
       reply(5, { ok: true, updatedAt: 'V4', orders: [
         { id: 'a', status: 'approved', project_id: '', lines: [{ id: 'L1', qty: '14', unit_cost: '16', tax_pct: '' }] } ] })`);
    await settle();
    assert(`${f}: a delivery the server dropped goes; one added since the save stays`,
      J('purchaseOrders[0].lines.map(l => l.id)') === '["L1","NEW"]', J('purchaseOrders[0].lines'));

    // ── Rows the server deleted for a save ──
    // Only the ones it says it removed leave this page: a row it kept (one
    // that failed its delete's checks) is still on the job.
    t(`var forgotten = []; function _drForgetRow(id) { forgotten.push(String(id)); }
       purchaseOrders[0].lines[0].qty = '15'; _poNoteLineEdit('a', 'L1', 'qty'); savePurchaseOrders();
       reply(6, { ok: true, updatedAt: 'V5', orders: [], removedRowIds: ['rStale'] })`);
    await settle();
    assert(`${f}: a row the server says it deleted for a save leaves this page`, J('forgotten') === '["rStale"]', J('forgotten'));
    t(`purchaseOrders[0].lines[0].qty = '16'; _poNoteLineEdit('a', 'L1', 'qty'); savePurchaseOrders();
       reply(7, { ok: true, updatedAt: 'V6', orders: [] })`);
    await settle();
    assert(`${f}:   and no other`, J('forgotten') === '["rStale"]', J('forgotten'));
  }
}

console.log('\n[a delivery\'s figures are kept key by key, and the tabs write no cost row]');
{
  // 7e1efb3 stopped a stale copy of an ORDER putting back fields somebody else
  // had changed. A delivery's figures went the same way one level down: a page
  // held each delivery as it last saw it, typing an invoice # on one sent its
  // old quantity along as an edit, and the server wrote that quantity to the
  // job's cost row. Now an edit is noted per KEY of a delivery, what a save
  // stored is taken back key by key, and the division tabs no longer PUT the
  // cost row themselves — the order's save writes it on the server, from the
  // delivery as stored. The pages' own functions, run.

  // Every await below waits on a promise this test settles by hand. One that
  // never settles would end the run part-way without a word — Node exits on
  // an empty event loop, and the summary line is never reached — so say so.
  process.once('beforeExit', () => {
    console.error('  ✗ the run stopped part-way: something it awaited never settled');
    process.exit(1);
  });

  // ── Purchasing: what a save's answer puts back on screen ──
  const pdom = new JSDOM('<!doctype html><html><body><input id="typing"></body></html>');
  const pctx = vm.createContext({ document: pdom.window.document, console, setTimeout, clearTimeout });
  vm.runInContext('const _editedLines = {}, _deletedLines = {};', pctx);
  // The real load-time migration, so "re-run after adoption" is the page's.
  NUM_FNS.concat(['lineAmt', 'lineTaxPct', 'lineTax', 'recalcLineTax', 'uid', 'localDateStr', 'migratePO'])
    .forEach(n => vm.runInContext(requireFn(PAGE, n, 'purchase-orders.html'), pctx));
  vm.runInContext(EDIT_BOOKKEEPING, pctx);
  const p  = e => vm.runInContext(e, pctx);
  const PJ = e => JSON.stringify(p(e));

  // The screen's copy of PO-0412. The save in question carried L1–L4; L5 was
  // added after it left. While it was out the user typed a quantity on L1 and
  // an invoice # on L4, and removed L8 — which somebody else had recorded.
  p(`
    var po = { id: 'po412', po_number: 'PO-0412', lines: [
      { id: 'L1', invoice_num: '', date: '2026-11-02', qty: '12', unit_cost: '16', tax_pct: '5', tax: '9.6', employee: 'Sam' },
      { id: 'L2', invoice_num: 'INV-1', date: '2026-11-03', qty: '4', unit_cost: '20', tax_pct: '', tax: '', employee: 'Lee' },
      { id: 'L3', invoice_num: '', date: '2026-11-04', qty: '1', unit_cost: '5', tax_pct: '', tax: '', employee: '',
        source: 'daily', po_row_id: 'r3' },
      { id: 'L4', invoice_num: 'INV-4', date: '2026-11-05', qty: '2', unit_cost: '5', tax_pct: '', tax: '', employee: '' },
      { id: 'L5', invoice_num: '', date: '2026-11-06', qty: '', unit_cost: '', tax_pct: '', tax: '', employee: '' },
    ] };
    var sent = new Set(['L1', 'L2', 'L3', 'L4']);
    noteEdit(_editedLines, 'po412', lineEditKey('L1', 'qty'));
    noteEdit(_editedLines, 'po412', lineEditKey('L4', 'invoice_num'));
    (_deletedLines.po412 = new Set()).add('L8');
  `);
  // The order as stored. Purchasing's quantity on L1 is the one this save
  // displaced; L2 was re-figured by somebody else; L3, a Daily Tracking
  // delivery whose row moved on, and L4 are gone from it; L6 and L8 were
  // recorded elsewhere — L6 by a page from before the tax percentage, so it
  // carries only a dollar tax.
  const took = p(`adoptStoredLines(po, [
      { id: 'L1', invoice_num: 'INV-7', date: '2026-11-02', qty: '10', unit_cost: '16', tax_pct: '5', tax: '8', employee: 'Sam' },
      { id: 'L2', invoice_num: 'INV-1', date: '2026-11-03', qty: '6', unit_cost: '20', tax_pct: '10', tax: '12', employee: 'Max' },
      { id: 'L6', invoice_num: 'INV-6', date: '2026-11-07', qty: '10', unit_cost: '10', tax: '8', employee: 'Ann' },
      { id: 'L8', invoice_num: '', date: '2026-11-08', qty: '1', unit_cost: '1', tax_pct: '', tax: '', employee: '' },
    ], sent)`);
  const pl = id => p(`po.lines.find(l => l.id === '${id}')`) || {};
  assert('purchasing: a delivery key with an edit still owed keeps what the user typed',
    pl('L1').qty === '12', JSON.stringify(pl('L1')));
  assert('purchasing:   while the same delivery\'s other keys take the stored value',
    pl('L1').invoice_num === 'INV-7', JSON.stringify(pl('L1')));
  assert('purchasing:   and its tax is not taken while a figure it is worked out from is pending',
    pl('L1').tax === '9.6', JSON.stringify(pl('L1')));
  assert('purchasing: a delivery with nothing pending takes every stored key, tax included',
    pl('L2').qty === '6' && pl('L2').employee === 'Max' && pl('L2').tax_pct === '10' && pl('L2').tax === '12',
    JSON.stringify(pl('L2')));
  assert('purchasing: a delivery somebody else recorded is added — and counted, for the notice',
    Boolean(pl('L6').id) && took.added === 1 && took.changed === true, JSON.stringify(took));
  assert('purchasing:   but not one removed here since the save left',
    !pl('L8').id, PJ('po.lines.map(l => l.id)'));
  assert('purchasing: a delivery the save carried and the server dropped goes',
    !pl('L3').id, PJ('po.lines.map(l => l.id)'));
  assert('purchasing:   unless it has been changed here since — that edit is still owed',
    pl('L4').invoice_num === 'INV-4', PJ('po.lines.map(l => l.id)'));
  assert('purchasing: a delivery added since the save left stays',
    Boolean(pl('L5').id), PJ('po.lines.map(l => l.id)'));
  assert('purchasing:   in the order they were on screen, the newcomer last',
    PJ('po.lines.map(l => l.id)') === '["L1","L2","L4","L5","L6"]', PJ('po.lines.map(l => l.id)'));
  assert('purchasing: the load-time tax migration is re-run on what was taken',
    pl('L6').tax_pct === '8', JSON.stringify(pl('L6')));
  p(`var shown = po.lines;
     var again = adoptStoredLines(po, JSON.parse(JSON.stringify(po.lines)), new Set(po.lines.map(l => l.id)));`);
  assert('purchasing: an answer that matches the screen changes nothing, so nothing is redrawn',
    p('again.changed') === false && p('again.added') === 0 && p('po.lines === shown'), PJ('again'));

  // ── Purchasing: what an edit notes, and what the save says ──
  p(`
    let purchaseOrders = [{ id: 'po9', po_number: 'PO-0009', _division: 'paving', lines: [
      { id: 'L1', invoice_num: '', date: '2026-11-02', qty: '10', unit_cost: '16', tax_pct: '5', tax: '8', employee: 'Sam' } ] }];
    let saves = 0;
    function capsFor() { return { canEdit: true, canDelete: true }; }
    function savePO() { saves++; }
    function updateTotalsInPlace() {}
  `);
  p(requireFn(PAGE, 'setLineField', 'purchase-orders.html'));
  p(`setLineField('po9', 'L1', 'qty', '12')`);
  assert('purchasing: a quantity typed on a delivery is noted as that key of that delivery',
    PJ('[...(_editedLines.po9 || new Map()).keys()]') === '["qty:L1"]', PJ('[...(_editedLines.po9 || new Map()).keys()]'));
  assert('purchasing:   its tax is worked out again, and the save is queued',
    p('purchaseOrders[0].lines[0].tax') === '9.6' && p('saves') === 1, PJ('purchaseOrders[0].lines[0]'));
  p(`setLineField('po9', 'L1', 'invoice_num', 'INV-3')`);
  assert('purchasing: a second key on the same delivery is noted beside the first',
    PJ('editedLineFieldsFor("po9")') === '{"L1":["qty","invoice_num"]}', PJ('editedLineFieldsFor("po9")'));
  assert('purchasing:   and the delivery is still named once',
    PJ('editedLinesFor("po9")') === '["L1"]', PJ('editedLinesFor("po9")'));
  assert('purchasing: a delivery id with a colon in it survives the round trip',
    PJ(`editedLineFieldsFor('x', new Map([[lineEditKey('dr:r7', 'qty'), 1]]))`) === '{"dr:r7":["qty"]}',
    PJ(`editedLineFieldsFor('x', new Map([[lineEditKey('dr:r7', 'qty'), 1]]))`));

  // The save itself: it names the delivery's keys, and takes the stored order
  // back key by key — a unit cost typed while it was out stays as typed.
  p(`
    const _saveTimers = {}, _savedDivision = { po9: 'paving' }, _unsaved = new Set();
    let _inflight = 0, _saveEpoch = 0, renders = 0;
    const toasts = [], bodies = [];
    let release, answer;
    function showSave() {} function render() { renders++; } function toast(m) { toasts.push(m); }
    function divLabel(d) { return d; }
    function poPayload(po) { const o = {}; Object.keys(po).forEach(k => { if (k[0] !== '_') o[k] = po[k]; }); return o; }
    async function api(method, path, body) {
      bodies.push(JSON.parse(JSON.stringify(body)));
      await new Promise(r => { release = r; });
      return { ok: true, purchaseOrder: answer };
    }
  `);
  p(requireFn(PAGE, 'deletedLinesFor', 'purchase-orders.html'));
  p('async ' + requireFn(PAGE, '_savePOWrite', 'purchase-orders.html'));
  p('var saving = _savePOWrite(purchaseOrders[0])');
  assert('purchasing: the save names each delivery\'s changed keys',
    PJ('bodies[0].editedLineFields') === '{"L1":["qty","invoice_num"]}' && PJ('bodies[0].editedLineIds') === '["L1"]',
    PJ('bodies[0]'));
  p(`setLineField('po9', 'L1', 'unit_cost', '18');
     answer = { id: 'po9', po_number: 'PO-0009', lines: [
       { id: 'L1', invoice_num: 'INV-3', date: '2026-11-02', qty: '12', unit_cost: '16', tax_pct: '5', tax: '9.6', employee: 'Sam', po_row_id: 'row-1' },
       { id: 'L7', invoice_num: 'INV-70', date: '2026-11-09', qty: '3', unit_cost: '2', tax_pct: '', tax: '', employee: 'Max' } ] };
     release();`);
  await p('saving');
  assert('purchasing: what the save carried is forgotten; the key typed since is still owed',
    PJ('[...(_editedLines.po9 || new Map()).keys()]') === '["unit_cost:L1"]',
    PJ('[...(_editedLines.po9 || new Map()).keys()]'));
  assert('purchasing:   and keeps what was typed over the stored figure',
    p('purchaseOrders[0].lines[0].unit_cost') === '18' && p('purchaseOrders[0].lines[0].po_row_id') === 'row-1',
    PJ('purchaseOrders[0].lines[0]'));
  assert('purchasing:   a delivery recorded elsewhere meanwhile is shown, and said so',
    PJ('purchaseOrders[0].lines.map(l => l.id)') === '["L1","L7"]' && p('renders') === 1
    && /^1 delivery was added to PO-0009/.test(p('toasts[0]') || ''), PJ('[purchaseOrders[0].lines, toasts]'));

  // ── The division tabs ──
  // Each tab's copy of the job, and an order on it: L1 and L2 raised cost rows
  // r1 and r2 — r1 since re-coded by a supervisor, with an installed quantity
  // and a job class of their own — and dr-r5 was recorded from the field's
  // row r5 in Daily Tracking.
  const TAB_STATE = `
    const window = { addEventListener() {} };
    const fctUser = { username: 'farmerykaleb' };
    let activeTab = 'po';
    let _aggCacheRowCount = 7, _projSubAggCacheRowCount = 7;
    const _poExpanded = new Set();
    const proj = { id: 'p1', _drFullLoaded: true, dailyRows: [
      { id: 'r1', _projectId: 'p1', date: '2026-11-02', employee: 'Sam', cost_code: '999', sub_code: 'SUPERVISOR',
        job_class: 'Operator', quantity: '250', material: 'Stone', supplier: 'Acme', po_num: 'PO-0007',
        units_purchased: '10', unit_cost: '16.8', material_cost: '168' },
      { id: 'r2', _projectId: 'p1', date: '2026-11-03', employee: 'Lee', cost_code: '100', sub_code: 'A',
        job_class: '', quantity: '', material: 'Stone', supplier: 'Acme', po_num: 'PO-0007',
        units_purchased: '4', unit_cost: '20', material_cost: '80' },
      { id: 'r5', _projectId: 'p1', date: '2026-11-04', employee: 'Kim', cost_code: '02-100', sub_code: '0420',
        job_class: '', quantity: '', material: 'Field sand', supplier: 'Pit 9', po_num: 'PO-0007',
        units_purchased: '3', unit_cost: '7', material_cost: '21' },
    ] };
    let purchaseOrders = [
      { id: 'a', po_number: 'PO-0007', title: 'Stone', supplier: 'Acme', status: 'pending', project_id: 'p1',
        cost_code: '100', sub_code: 'A', lines: [
        { id: 'L1', invoice_num: '', date: '2026-11-02', qty: '10', unit_cost: '16', tax_pct: '5', tax: '8',
          employee: 'Sam', po_row_id: 'r1' },
        { id: 'L2', invoice_num: 'INV-1', date: '2026-11-03', qty: '4', unit_cost: '20', tax_pct: '', tax: '',
          employee: 'Lee', po_row_id: 'r2' },
        { id: 'dr-r5', source: 'daily', invoice_num: '', date: '2026-11-04', qty: '3', unit_cost: '7', tax_pct: '',
          tax: '', employee: 'Kim', cost_code: '02-100', sub_code: '0420', po_row_id: 'r5' } ] },
      { id: 'b', po_number: 'PO-0008', title: '', project_id: '', lines: [] },
    ];
    let _poBaseUpdatedAt = 'V0', _poLoadOk = false;
    function getProj(id) { return id === 'p1' ? proj : undefined; }
  `;
  // The line math and the Daily Tracking test every tab context needs.
  const TAB_MATH = ['_normalizeNumeric', '_poNum', '_poNum0', '_lineAmt', '_lineTaxPct', '_lineTax', '_recalcLineTax',
                    '_lineUnitCostWithTax', '_poTotals', '_poLineFromDaily'];
  const liftTab = (src, f, ctx, names) => {
    vm.runInContext(sliceSource(src, 'const _poEditedFields = Object.create(null);', '// Whether a read of the purchase orders has worked.',
      f + ' PO edit state', '_poSaveEpoch'), ctx);
    const daily = src.match(/const PO_DAILY_SOURCE = [^\n]*/);
    if (!daily) throw new Error('PO_DAILY_SOURCE not found in ' + f);
    vm.runInContext(daily[0], ctx);
    TAB_MATH.concat(names).forEach(n => vm.runInContext(requireFn(src, n, f), ctx));
  };
  const TAB_HTML = '<!doctype html><body>'
    + '<select data-po-id="a" data-po-field="status"><option value="pending">Pending</option>'
    + '<option value="approved">Approved</option></select>'
    + '<input data-po-id="a" data-po-field="title">'
    + '<input data-po-id="a" data-line-id="L1" data-line-field="qty">'
    + '<input data-po-id="a" data-line-id="L1" data-line-field="invoice_num">'
    + '<input data-po-id="a" data-line-id="dr-r5" data-line-field="qty">'
    + '<div id="po-status-meta-a"></div></body>';
  // A tab with its real edit handler and row syncs. Every collaborator that
  // could write to the server is a counter; the rows are only ever in memory.
  const makeTab = (f, src) => {
    const dom = new JSDOM(TAB_HTML);
    const ctx = vm.createContext({ document: dom.window.document, console, setTimeout });
    vm.runInContext(TAB_STATE + `
      let saves = 0, puts = 0, posts = 0, reads = 0, renders = 0;
      const deletes = [];
      function savePurchaseOrders() { saves++; }
      function drPutNow() { puts++; }
      function drPost() { posts++; }
      function drDelete(id) { deletes.push(String(id)); }
      async function drGetAll() { reads++; return { rows: [] }; }
      function renderDailyTable() { renders++; }
      function renderProjectPOs() {}
      function renderPOTab() {}
    `, ctx);
    liftTab(src, f, ctx, ['fmt', 'qfmt', '_poStampWhen', '_ensurePOLineRow', '_handlePOEvent', 'deletePOLine', 'deletePO',
                          '_poAdoptServerOrders', '_poMergeLine', '_poRowsFollowOrder']);
    ['_syncPOHeaderToLines', '_syncPOLineToRow'].forEach(n => vm.runInContext('async ' + requireFn(src, n, f), ctx));
    const t = e => vm.runInContext(e, ctx);
    const fire = (sel, value) => {
      const el = dom.window.document.querySelector(sel);
      el.value = value;
      t('_handlePOEvent')({ type: 'change', target: el });
    };
    return { t, J: e => JSON.stringify(t(e)), fire };
  };
  const settle = () => new Promise(r => setTimeout(r, 10));

  for (const f of ['tracker.html', 'paving.html', 'kiewit-pinetree.html']) {
    const src = read(f);

    // ── An edit on the PO tab ──
    {
      const { t, J, fire } = makeTab(f, src);
      const fieldMarks = () => J('[...(_poEditedFields.a || new Map()).keys()]');
      const lineMarks  = () => J('[...(_poEditedLines.a || new Map()).keys()]');
      const row = id => t(`proj.dailyRows.find(r => r.id === '${id}')`);

      fire('select[data-po-field="status"]', 'approved');
      await settle();
      assert(`${f}: approving an order notes its status — and no delivery`,
        fieldMarks() === '["status"]' && lineMarks() === '[]', fieldMarks() + ' ' + lineMarks());
      assert(`${f}:   and saves the list`, t('saves') === 1, String(t('saves')));

      fire('input[data-po-field="title"]', 'Stone, 57');
      await settle();
      assert(`${f}: retitling notes the title beside it`, fieldMarks() === '["status","title"]', fieldMarks());
      assert(`${f}:   the cost row on screen takes the new title`, row('r1').material === 'Stone, 57',
        JSON.stringify(row('r1')));
      assert(`${f}:   but keeps the codes a supervisor gave it — the title changed, not the codes`,
        row('r1').cost_code === '999' && row('r1').sub_code === 'SUPERVISOR', JSON.stringify(row('r1')));
      assert(`${f}:   and the field's own row keeps its description`, row('r5').material === 'Field sand',
        JSON.stringify(row('r5')));

      fire('input[data-line-id="L1"][data-line-field="qty"]', '12');
      await settle();
      assert(`${f}: a quantity typed on a delivery notes that key of that delivery, not the order`,
        lineMarks() === '["qty:L1"]' && fieldMarks() === '["status","title"]', lineMarks());
      assert(`${f}:   and saves the list`, t('saves') === 3, String(t('saves')));
      assert(`${f}:   the cost row on screen follows the delivery, its tax in the unit cost`,
        row('r1').units_purchased === '12' && row('r1').unit_cost === '16.8' && row('r1').material_cost === '201.6',
        JSON.stringify(row('r1')));
      assert(`${f}:   leaving the supervisor's installed quantity, job class and codes alone`,
        row('r1').quantity === '250' && row('r1').job_class === 'Operator' && row('r1').cost_code === '999',
        JSON.stringify(row('r1')));

      // That save has landed. Typing an invoice # now must not carry the
      // quantity it sits beside, which this tab may hold stale.
      t('_poForgetSentEdits(_poEditedLines, _poSnapshotEdits(_poEditedLines))');
      fire('input[data-line-id="L1"][data-line-field="invoice_num"]', 'INV-9');
      await settle();
      assert(`${f}: an invoice # notes the invoice # alone — not the quantity beside it`,
        lineMarks() === '["invoice_num:L1"]', lineMarks());
      assert(`${f}:   and saves the list`, t('saves') === 4, String(t('saves')));

      fire('input[data-line-id="dr-r5"][data-line-field="qty"]', '5');
      await settle();
      assert(`${f}: a Daily Tracking delivery's edit is noted the same way`,
        lineMarks() === '["invoice_num:L1","qty:dr-r5"]', lineMarks());
      assert(`${f}:   and its row on screen follows it`,
        row('r5').units_purchased === '5' && row('r5').material_cost === '35', JSON.stringify(row('r5')));

      const before = t('saves');
      fire('input[data-line-id="L1"][data-line-field="qty"]', '12');
      assert(`${f}: committing a value that did not change is no edit and no save`,
        t('saves') === before && lineMarks() === '["invoice_num:L1","qty:dr-r5"]', lineMarks());

      assert(`${f}: through all of it the tab PUT no cost row — the order's save writes them on the server`,
        t('puts') === 0, String(t('puts')));
      assert(`${f}:   nor minted one: every delivery already had its row`, t('posts') === 0, String(t('posts')));
      assert(`${f}:   nor read the job again: its rows were loaded`, t('reads') === 0, String(t('reads')));
      assert(`${f}:   and the job's totals are worked out again from the rows on screen`,
        t('_aggCacheRowCount') === -1 && t('_projSubAggCacheRowCount') === -1 && t('renders') > 0);
    }

    // ── Deleting a delivery ──
    {
      const { t, J } = makeTab(f, src);
      t(`deletePOLine('a', 'L2')`);
      assert(`${f}: deleting a delivery is recorded until a save confirms it`,
        J('[...(_poDeletedLines.a || [])]') === '["L2"]', J('[...(_poDeletedLines.a || [])]'));
      assert(`${f}:   the delivery and its cost row leave the screen, and the list is saved`,
        J('purchaseOrders[0].lines.map(l => l.id)') === '["L1","dr-r5"]'
        && !t('proj.dailyRows.some(r => r.id === "r2")') && t('saves') === 1,
        J('purchaseOrders[0].lines.map(l => l.id)'));
      t(`deletePOLine('a', 'dr-r5')`);
      assert(`${f}: a delivery recorded in Daily Tracking is not deleted here, so nothing is recorded`,
        J('[...(_poDeletedLines.a || [])]') === '["L2"]' && t('purchaseOrders[0].lines.length') === 2
        && t('saves') === 1, J('[...(_poDeletedLines.a || [])]'));
    }

    // ── Deleting an order ──
    {
      const { t, J } = makeTab(f, src);
      t(`_poNoteEdit('a', 'title'); _poNoteLineEdit('a', 'L1', 'qty'); (_poDeletedLines.a = new Set()).add('L9');
         _poNoteEdit('b', 'title');
         deletePO('a');`);
      assert(`${f}: deleting an order is recorded until a save confirms it`,
        t('_poDeletedOrders.has("a")') === true, J('[..._poDeletedOrders]'));
      assert(`${f}:   and its own marks go with it — there is nothing left to send them for`,
        !t('"a" in _poEditedFields') && !t('"a" in _poEditedLines') && !t('"a" in _poDeletedLines'));
      assert(`${f}:   but another order's stay`,
        J('[...(_poEditedFields.b || new Map()).keys()]') === '["title"]');
      assert(`${f}:   the order leaves the list, which is saved`,
        J('purchaseOrders.map(p => p.id)') === '["b"]' && t('saves') === 1);
      assert(`${f}:   the rows its deliveries raised go with it; the field's row stays on the job`,
        J('deletes') === '["r1","r2"]' && t('proj.dailyRows.some(r => r.id === "r5")') === true, J('deletes'));
    }

    // ── An order a job-row write answered with ──
    {
      const { t, J } = makeTab(f, src);
      // Typed here, not yet stored: L1's quantity and dr-r5's.
      t(`const ls = purchaseOrders[0].lines;
         ls[0].qty = '12'; _recalcLineTax(ls[0]); _poNoteLineEdit('a', 'L1', 'qty');
         ls[2].qty = '5'; _poNoteLineEdit('a', 'dr-r5', 'qty');`);
      const n = t(`_poAdoptServerOrders([{ id: 'a', po_number: 'PO-0007', project_id: 'p1', lines: [
          { id: 'L1', invoice_num: 'INV-7', date: '2026-11-02', qty: '10', unit_cost: '16', tax_pct: '5', tax: '8',
            employee: 'Sam', po_row_id: 'r1' },
          { id: 'L2', invoice_num: 'INV-1', date: '2026-11-03', qty: '6', unit_cost: '20', tax_pct: '', tax: '',
            employee: 'Max', po_row_id: 'r2' },
          { id: 'dr-r5', source: 'daily', invoice_num: '', date: '2026-11-04', qty: '3', unit_cost: '7', tax_pct: '',
            tax: '', employee: 'Ari', cost_code: '03-300', sub_code: '0610', po_row_id: 'r5' } ] }])`);
      const L = id => t(`purchaseOrders[0].lines.find(l => l.id === '${id}')`) || {};
      assert(`${f}: an order a row write answered with is taken on`, n === 1, String(n));
      assert(`${f}:   but a raised delivery's quantity typed here and not yet stored stays as typed`,
        L('L1').qty === '12', JSON.stringify(L('L1')));
      assert(`${f}:   with its tax, which follows the figures it is worked out from`,
        L('L1').tax === '9.6', JSON.stringify(L('L1')));
      assert(`${f}:   while its other keys take the stored value`, L('L1').invoice_num === 'INV-7',
        JSON.stringify(L('L1')));
      assert(`${f}:   a delivery with nothing pending is taken as stored`,
        L('L2').qty === '6' && L('L2').employee === 'Max', JSON.stringify(L('L2')));
      assert(`${f}:   a Daily Tracking delivery's pending quantity stays as typed too`,
        L('dr-r5').qty === '5', JSON.stringify(L('dr-r5')));
      assert(`${f}:   and the rest of it is taken — its codes are its row's`,
        L('dr-r5').employee === 'Ari' && L('dr-r5').cost_code === '03-300', JSON.stringify(L('dr-r5')));
      assert(`${f}:   with nothing else lost or doubled`,
        J('purchaseOrders[0].lines.map(l => l.id)') === '["L1","L2","dr-r5"]', J('purchaseOrders[0].lines'));
    }

    // ── The rows an order raised follow it on screen ──
    {
      const { t, J } = makeTab(f, src);
      t(`Object.assign(purchaseOrders[0], { po_number: 'PO-0017', title: 'Stone, 57', supplier: 'Acme Stone & Sand',
                                            cost_code: '300', sub_code: 'C' });
         Object.assign(purchaseOrders[0].lines[0], { qty: '15', unit_cost: '20', tax_pct: '5', tax: '15',
                                                     date: '2026-11-05', employee: 'Ann' });
         purchaseOrders[0].lines[2].qty = '99';
         purchaseOrders[0].lines.push({ id: 'L9', qty: '1', unit_cost: '1', po_row_id: 'not-loaded' });
         _poRowsFollowOrder(purchaseOrders[0]);`);
      const r1 = t('proj.dailyRows.find(r => r.id === "r1")');
      assert(`${f}: a raised delivery's row on screen takes the stored figures, tax in its unit cost`,
        r1.units_purchased === '15' && r1.unit_cost === '21' && r1.material_cost === '315'
        && r1.date === '2026-11-05' && r1.employee === 'Ann', JSON.stringify(r1));
      assert(`${f}:   and the order's number, title and supplier`,
        r1.po_num === 'PO-0017' && r1.material === 'Stone, 57' && r1.supplier === 'Acme Stone & Sand', JSON.stringify(r1));
      assert(`${f}:   but not its codes, which the supervisor re-coded, nor the job class or installed quantity`,
        r1.cost_code === '999' && r1.sub_code === 'SUPERVISOR' && r1.job_class === 'Operator' && r1.quantity === '250',
        JSON.stringify(r1));
      // A Daily Tracking delivery's figures were derived from its row by the
      // server a moment ago, so the copy on screen follows them back: editing
      // the delivery here wrote this page's figures over it in memory, and the
      // next edit to the row in Daily Tracking would send those whole. Its
      // description, supplier and codes stay the row's own.
      const r5 = t('proj.dailyRows.find(r => r.id === "r5")');
      assert(`${f}:   a Daily Tracking delivery's row follows its figures and the order's number`,
        r5.units_purchased === '99' && r5.po_num === 'PO-0017', JSON.stringify(r5));
      assert(`${f}:   but keeps the row's own description, supplier and codes`,
        r5.material !== 'Stone, 57' && r5.supplier !== 'Acme Stone & Sand' && r5.cost_code !== '300',
        JSON.stringify(r5));
      assert(`${f}:   a row this page has not loaded is skipped, not invented`,
        t('proj.dailyRows.length') === 3, J('proj.dailyRows.map(r => r.id)'));
      assert(`${f}:   the job's table is redrawn once, and nothing is PUT`,
        t('renders') === 1 && t('puts') === 0, String(t('renders')));
      t('_poRowsFollowOrder(purchaseOrders[0])');
      assert(`${f}:   and a second pass, with nothing to change, draws nothing`, t('renders') === 1, String(t('renders')));
    }

    // ── The poll ──
    {
      // _pollPurchaseOrders lives inside the boot IIFE; lifted with the real
      // queued save it calls, against a fetch the test answers by hand.
      const ctx = vm.createContext({ console, setTimeout });
      vm.runInContext(TAB_STATE + `
        const document = { activeElement: null };
        const API_BASE = '/api', fctToken = 't';
        const calls = [];
        let renders = 0;
        function fetch(url, init) {
          const call = { method: (init && init.method) || 'GET', url, body: init && init.body ? JSON.parse(init.body) : null };
          calls.push(call);
          return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
        }
        function answer(i, j) { calls[i].resolve({ ok: true, status: 200, json: async () => j }); }
        function _showSaveError() {}
        function _poRefreshDailyLines() {}
        function renderPOTab() { renders++; }
        function renderProjectPOs() {}
        function renderDailyTable() {}
        function _migratePOs() {}
        function _isEditing() { return false; }
        function _bidMatListChanged() {}
      `, ctx);
      liftTab(src, f, ctx, ['savePurchaseOrders', '_poAdoptSaved', '_poMergeLine', '_poRowsFollowOrder']);
      vm.runInContext(sliceSource(src, '  async function _pollPurchaseOrders() {', '\n  async function _pollTrucking',
        f + ' purchase-order poll', '_bidMatListChanged(_poBefore, incoming)'), ctx);
      const q = e => vm.runInContext(e, ctx);
      const QJ = e => JSON.stringify(q(e));
      const stored = (title, qty) => ({ purchaseOrders: [
        { id: 'a', po_number: 'PO-0007', title, supplier: 'Acme', status: 'pending', project_id: 'p1',
          cost_code: '100', sub_code: 'A', lines: [
          { id: 'L1', invoice_num: '', date: '2026-11-02', qty, unit_cost: '16', tax_pct: '5', tax: String(qty * 16 * 0.05),
            employee: 'Sam', po_row_id: 'r1' } ] } ] });

      // Started, never awaited outright: a poll that reads when it should not
      // waits on a fetch nobody answers, and awaiting it would end the run
      // without a word rather than fail it. Says whether it returned, and what
      // it sent.
      const pollOnce = async () => {
        const before = q('calls.length');
        let done = false;
        q('_pollPurchaseOrders()').then(() => { done = true; });
        await settle();
        return { done, sent: JSON.stringify(q(`calls.slice(${before}).map(c => c.method)`)) };
      };

      // A save that did not land: the poll sends it again, and reads nothing.
      q(`purchaseOrders[0].title = 'Stone, 57'; _poNoteEdit('a', 'title'); _poSaveFailed = true;`);
      let polled = await pollOnce();
      assert(`${f}: the poll sends a save that did not land again`,
        polled.sent.startsWith('["PUT"') && QJ('calls[0].body.editedFields') === '{"a":["title"]}',
        QJ('calls.map(c => [c.method, c.body && c.body.editedFields])'));
      assert(`${f}:   and reads nothing over it`, polled.done && polled.sent === '["PUT"]', JSON.stringify(polled));
      polled = await pollOnce();
      assert(`${f}: while a save is out the poll neither sends it again nor reads`,
        polled.done && polled.sent === '[]', JSON.stringify(polled));
      q(`answer(0, { ok: true, updatedAt: 'V1', orders: [] })`);
      await settle();
      assert(`${f}:   once it lands nothing is owed`,
        q('_poSaveFailed') === false && q('_poSaving') === false && q('Object.keys(_poEditedFields).length') === 0);

      // Anything this tab has not had stored yet: the list here is newer than a
      // read could bring, and adopting one would show the stored values over it.
      for (const [what, set, clear] of [
        ['an order field',     `_poNoteEdit('a', 'title')`,               `delete _poEditedFields.a`],
        ['a delivery key',     `_poNoteLineEdit('a', 'L1', 'qty')`,       `delete _poEditedLines.a`],
        ['a deleted delivery', `(_poDeletedLines.a = new Set()).add('L2')`, `delete _poDeletedLines.a`],
        ['a deleted order',    `_poDeletedOrders.add('z')`,               `_poDeletedOrders.clear()`],
      ]) {
        q(set);
        polled = await pollOnce();
        assert(`${f}: with ${what} changed here and not yet stored, the poll reads nothing`,
          polled.done && polled.sent === '[]', JSON.stringify(polled));
        q(clear);
      }

      // A read answered after a save that went out and landed while it was in
      // the air: computed before that save, so older than the screen.
      let n = q('calls.length');
      q('var polling = _pollPurchaseOrders()');
      assert(`${f}: with nothing owed the poll reads`, q(`calls[${n}].method`) === 'GET', QJ('calls.map(c => c.method)'));
      q(`purchaseOrders[0].title = 'Stone, 58'; _poNoteEdit('a', 'title'); savePurchaseOrders();
         answer(${n + 1}, { ok: true, updatedAt: 'V2', orders: [] })`);
      await settle();
      q(`answer(${n}, ${JSON.stringify(Object.assign(stored('Stone', '10'), { updatedAt: 'V-OLD' }))})`);
      await q('polling');
      assert(`${f}: a read that a save landed during is dropped — the save's version and title stand`,
        q('purchaseOrders[0].title') === 'Stone, 58' && q('_poBaseUpdatedAt') === 'V2' && q('renders') === 0,
        QJ('[purchaseOrders[0].title, _poBaseUpdatedAt, renders]'));

      // ...and one answered while a save is still out.
      n = q('calls.length');
      q('var polling2 = _pollPurchaseOrders()');
      q(`purchaseOrders[0].title = 'Stone, 59'; _poNoteEdit('a', 'title'); savePurchaseOrders();`);
      q(`answer(${n}, ${JSON.stringify(Object.assign(stored('Stone', '10'), { updatedAt: 'V-OLD' }))})`);
      await q('polling2');
      assert(`${f}: a read answered while a save is out is dropped too`,
        q('purchaseOrders[0].title') === 'Stone, 59' && q('_poBaseUpdatedAt') === 'V2' && q('renders') === 0,
        QJ('[purchaseOrders[0].title, _poBaseUpdatedAt, renders]'));
      q(`answer(${n + 1}, { ok: true, updatedAt: 'V3', orders: [] })`);
      await settle();

      // With nothing owed and no save in the window it still takes the list on
      // — or the guards would only have stopped the poll. Purchasing has since
      // re-figured L1.
      n = q('calls.length');
      q('var polling3 = _pollPurchaseOrders()');
      q(`answer(${n}, ${JSON.stringify(Object.assign(stored('Stone, 59', '14'), { updatedAt: 'V4' }))})`);
      await q('polling3');
      assert(`${f}: a quiet poll takes the stored list on, and its version`,
        q('purchaseOrders[0].lines[0].qty') === '14' && q('_poBaseUpdatedAt') === 'V4' && q('renders') === 1,
        QJ('[purchaseOrders[0].lines[0], _poBaseUpdatedAt, renders]'));
      // The job's row that delivery raised has to follow it, exactly as it does
      // after this tab's own save (_poRowsFollowOrder): left at the quantity
      // this tab loaded, the next Daily Tracking edit to anything on that row
      // PUTs it whole — and the server copies the row's figures back onto the
      // order (applyRowToLine), undoing purchasing's change on both.
      assert(`${f}:   and the cost row that delivery raised follows it on screen`,
        q('proj.dailyRows.find(r => r.id === "r1").units_purchased') === '14',
        QJ('proj.dailyRows.find(r => r.id === "r1")'));
    }
  }
}

console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
})();
