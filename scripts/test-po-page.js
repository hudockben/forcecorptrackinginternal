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
  /fctUser\.divisionRoles\[DIVISION\]/.test(PAGE));

assert('it reads the catalogue from one endpoint, not the project blobs',
  PAGE.includes("api('GET', '/po-catalog')") && !/fct_paving_project_/.test(PAGE));
assert('it saves one order at a time',
  /api\('POST', qs, \{ purchaseOrder: poPayload\(po\) \}\)/.test(PAGE));

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
    const perm = { canEdit: true };
    const saves = [];
    function savePO(po, opts) { saves.push({ id: po.id, immediate: !!(opts && opts.immediate) }); }
    function render() {}
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
    (PAGE.match(/_savedDivision\[po\.id\] = key;/g) || []).length === 2);
  assert('and it is declared before the loaders that seed it',
    PAGE.indexOf('const _savedDivision = {};') < PAGE.indexOf('async function loadPurchaseOrders'));

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const ctx = vm.createContext({ document: dom.window.document, console });
  vm.runInContext(`
    const GENERAL = 'purchase_orders';
    let sourceDivs = [{ division:'turf', label:'Turf', projects:[] }];
    const perm = { canEdit: true };
    const _savedDivision = {};
    const sent = [];
    // The order was loaded from paving, as loadPurchaseOrders would leave it.
    let purchaseOrders = [{ id:'x', po_number:'PO-0007', _division:'paving', project_id:'p1', lines:[] }];
    _savedDivision['x'] = 'paving';
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

console.log(`\n${failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'}`);
process.exit(failed ? 1 : 0);
