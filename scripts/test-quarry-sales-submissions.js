#!/usr/bin/env node
'use strict';
// A DATE read back from the driver used to lose a day on its way through
// safeDate anywhere east of Greenwich. Pin the clock there so the assertions
// below actually discriminate instead of passing by geography. Set before
// anything touches a Date.
process.env.TZ = 'Europe/Berlin';
/**
 * api/quarry-sales-submissions.js and the two pages either side of it.
 *
 * Run: node scripts/test-quarry-sales-submissions.js
 * No DB or server required — the neon driver, the auth module and the
 * normalized-table sync are stubbed at require time, and the sql mock records
 * each statement so a WHERE clause and its bound values can be asserted. The
 * form itself is loaded in jsdom and driven the way the scale house drives it,
 * because reading a page as text cannot tell whether it works.
 *
 * Four things are worth pinning here, in descending order of how quietly they
 * would break:
 *
 * 1. THE NAME IS THE LIST'S, NOT THE PAGE'S. The whole reason five of the
 *    seven answers are pickers is that Sales Tracking groups, filters and
 *    reports on the NAME. A page cached last week can post an id whose name
 *    has since been corrected, so the id is trusted and the name is re-read
 *    from Manage Lists on every write. Drop that and "Homer City" and "Homer
 *    city" become two pits in every report the quarry runs.
 *
 * 2. THE OFFICE'S PRICE SURVIVES. Price per ton is the one column of an
 *    injected row the office owns, and a re-submitted correction rebuilds the
 *    row. Rebuilding it from scratch turns a priced load into a $0 one, with
 *    nothing on screen to say so.
 *
 * 3. A SUBMITTED SALE IS NOT THE TAB'S TO DROP. The blob guard restores an
 *    injected row a whole-blob save omitted, so a row deleted only in the grid
 *    comes back on the next refresh — which looks, for the seconds in between,
 *    exactly like it worked. Removal has to go through the endpoint, which
 *    takes the submission with it.
 *
 * 4. OWN ROWS BY DEFAULT. A request that names no scope gets the caller's own
 *    sales, for every caller including the quarry office — company-wide is an
 *    opt-in, never something a page falls into by forgetting to ask.
 */

const path   = require('path');
const fs     = require('fs');
const Module = require('module');

// Three callers: the scale house (submit only), the quarry office (the grid
// these land in), and someone with neither.
const FIELD   = { companyCode: 'FCT', userId: 7,  username: 'strickallen', divs: ['quarry_sales'] };
const OFFICE  = { companyCode: 'FCT', userId: 42, username: 'office',      divs: ['quarry'] };
const OUTSIDE = { companyCode: 'FCT', userId: 99, username: 'paver',       divs: ['paving'] };

let CURRENT_SQL = null;
let NEXT_AUTH   = FIELD;
const SYNC_CALLS = [];

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      requireDivision: () => null,
      // Mirror the real gate rather than always saying yes: canSubmit is
      // hasDivisionAccess(payload,'quarry_sales') and canOffice is
      // hasDivisionAccess(payload,'quarry'), and a stub that waves both
      // through would let every scoping test below pass with no gate at all.
      hasDivisionAccess: (p, area) => !!(p && Array.isArray(p.divs) && p.divs.includes(area)),
    };
  }
  if (request === './lib/sync-normalized') {
    return { syncForKey: (sql, co, key, value) => { SYNC_CALLS.push({ co, key, value }); return Promise.resolve({}); } };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'quarry-sales-submissions.js'));
const {
  FIELDS, MAX_TONS, safeDate, parseTons, normalizeBody, missingFields,
  dbToEntry, resolveListNames, injectSalesRow, removeSalesRow,
} = handler._test;
const { PAYMENT_OPTIONS } = require(path.resolve(__dirname, '..', 'api', 'lib', 'quarry-sales-options.js'));
const { salesRowId, isQuarrySalesRow, SALES_TAB_FIELDS } =
  require(path.resolve(__dirname, '..', 'api', 'lib', 'quarry-sales-injected.js'));
const { guardConfigFor, mergeInjectedRows } =
  require(path.resolve(__dirname, '..', 'api', 'lib', 'injected-blob-guard.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

// A complete, valid sale. Individual tests knock one field out of it.
const FULL = {
  work_date: '2026-08-11',
  location_id: 'loc1',  location_name: 'Homer City',
  employee_id: 'emp1',  employee_name: 'Jamey Strickland',
  customer_id: 'cus1',  customer_name: 'Kinkead Aggregates',
  product_id:  'prd1',  product_name:  '2A Modified',
  tons: '24.5',
  payment: 'Cash',
};

// What the quarry's Manage Lists actually holds — deliberately spelled
// differently from FULL so a re-resolve is visible when it happens.
const LISTS = {
  location:  [{ id: 'loc1', name: 'Homer City Pit' }],
  employees: [{ id: 'emp1', name: 'Jamey Strickland' }],
  customer:  [{ id: 'cus1', name: 'Kinkead Aggregates LLC' }],
  product:   [{ id: 'prd1', name: '2A Modified' }],
};

// A tagged-template sql mock. `store` is the app_data table; anything else a
// test needs to answer is handled by the per-test `extra` function.
function makeSql(store, extra) {
  const calls = [];
  const sql = (strings, ...values) => {
    const q = Array.isArray(strings) ? strings.join('?') : String(strings);
    calls.push({ q, values });
    if (extra) {
      const r = extra(q, values);
      if (r !== undefined) return Promise.resolve(r);
    }
    if (/^\s*SELECT value FROM app_data/.test(q)) {
      const v = store.get(values[0]);
      return Promise.resolve(v === undefined ? [] : [{ value: v }]);
    }
    if (/^\s*INSERT INTO app_data/.test(q)) {
      store.set(values[0], typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1]);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  sql.calls = calls;
  return sql;
}

function makeRes() {
  return {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
}

// ── 1. What the form is allowed to send ─────────────────────────────────────
function parsingTests() {
  console.log('\n[a draft may be half-filled; a wrong value may not]');

  {
    const { data, error } = normalizeBody(FULL);
    assert('a complete sale parses', !error, error);
    assert('tons come through as a number', data.tons === 24.5, String(data.tons));
    assert('and it counts as complete', missingFields(data).length === 0,
      JSON.stringify(missingFields(data)));
  }
  {
    const { data, error } = normalizeBody({ work_date: '2026-08-11' });
    assert('a date on its own parses', !error, error);
    assert('tons left blank stay null', data.tons === null);
    assert('and everything else is reported missing, in form order',
      missingFields(data).join('|') === 'Location|Employee|Customer|Product|Tons|Payment',
      missingFields(data).join('|'));
  }

  console.log('\n[tons]');
  assert('blank is allowed',            parseTons('').value === null && !parseTons('').error);
  assert('a real weight is kept',       parseTons('24.5').value === 24.5);
  assert('zero is refused',             !!parseTons('0').error, JSON.stringify(parseTons('0')));
  assert('negative is refused',         !!parseTons('-3').error);
  assert('nonsense is refused',         !!parseTons('lots').error);
  assert(`over ${MAX_TONS} is refused`, !!parseTons(String(MAX_TONS + 1)).error);
  assert('a mistyped 1055 is caught',   !!parseTons('1055').error);
  assert('the cap itself is allowed',   parseTons(String(MAX_TONS)).value === MAX_TONS);
  {
    // Zero is refused rather than treated as an empty box: the message the
    // driver needs is "tons must be more than zero", not "you left tons blank"
    // over a field with a 0 sitting in it.
    const { data, error } = normalizeBody(Object.assign({}, FULL, { tons: '0' }));
    assert('and the refusal says so', !data && /more than zero/.test(error || ''), error);
  }

  console.log('\n[payment]');
  for (const p of PAYMENT_OPTIONS) {
    assert(`${p} is accepted`, !normalizeBody(Object.assign({}, FULL, { payment: p })).error);
  }
  assert('anything else is refused',
    !!normalizeBody(Object.assign({}, FULL, { payment: 'Check' })).error);

  console.log('\n[dates]');
  assert('an ISO date is kept',        safeDate('2026-08-11') === '2026-08-11');
  assert('a Date keeps its local day', safeDate(new Date(2026, 7, 11)) === '2026-08-11');
  assert('a typo is refused',          safeDate('11/08/2026') === null);
  assert('year 1899 is refused',       safeDate('1899-08-11') === null);
  assert('a bad date is refused, not passed through',
    !!normalizeBody({ work_date: '11/08/2026' }).error);
}

// ── 2. The name comes back from Manage Lists ────────────────────────────────
async function spellingTests() {
  console.log('\n[the name is re-read from the list on every write]');

  const store = new Map([['FCT:fct_quarry_lists', LISTS]]);
  {
    const { data } = normalizeBody(FULL);
    await resolveListNames(makeSql(store), 'FCT', data);
    assert('a stale location name is corrected', data.location_name === 'Homer City Pit', data.location_name);
    assert('a stale customer name is corrected', data.customer_name === 'Kinkead Aggregates LLC', data.customer_name);
    assert('an already-current name is left alone', data.product_name === '2A Modified');
    assert('the ids are untouched', data.location_id === 'loc1' && data.customer_id === 'cus1');
  }
  {
    // The customer was deleted from Manage Lists between draft and submit.
    // The sale still happened, and the name is the only record of who bought
    // it — refusing the load over a tidied list would strand it.
    const { data } = normalizeBody(Object.assign({}, FULL, { customer_id: 'gone', customer_name: 'Someone Ltd' }));
    await resolveListNames(makeSql(store), 'FCT', data);
    assert('an id that resolves to nothing keeps the posted name',
      data.customer_name === 'Someone Ltd', data.customer_name);
  }
  {
    // A read that fails must not blank the answers on its way out.
    const angry = () => Promise.reject(new Error('neon down'));
    const { data } = normalizeBody(FULL);
    await resolveListNames(angry, 'FCT', data);
    assert('a failed list read leaves the posted names alone',
      data.location_name === 'Homer City' && data.product_name === '2A Modified');
  }
  {
    // Nothing picked — no reason to go to the database at all.
    const sql = makeSql(store);
    await resolveListNames(sql, 'FCT', normalizeBody({ work_date: '2026-08-11' }).data);
    assert('a body with no ids skips the lookup entirely', sql.calls.length === 0, String(sql.calls.length));
  }
}

// ── 3. Into the grid, and back out ──────────────────────────────────────────
async function injectionTests() {
  console.log('\n[a submitted sale lands in Sales Tracking]');

  const KEY = 'FCT:fct_quarry_sales';
  const sub = Object.assign({ id: 55 }, normalizeBody(FULL).data);

  {
    const store = new Map([[KEY, [{ id: 'typed-by-hand', date: '2026-08-01', tons: 3 }]]]);
    SYNC_CALLS.length = 0;
    const row = await injectSalesRow(makeSql(store), 'FCT', sub);
    const arr = store.get(KEY);

    assert('the row is appended, not swapped in', arr.length === 2);
    assert("the tab's own row is untouched", arr[0].id === 'typed-by-hand');
    assert('the id names its submission', row.id === salesRowId(55), row.id);
    assert('and reads as an injected row',  isQuarrySalesRow(row));
    assert('the seven answers are carried across',
      row.date === '2026-08-11' && row.locationName === 'Homer City' &&
      row.employeeName === 'Jamey Strickland' && row.customerName === 'Kinkead Aggregates' &&
      row.productName === '2A Modified' && row.tons === 24.5 && row.payment === 'Cash',
      JSON.stringify(row));
    assert('the ids ride along, so the grid filters work',
      row.locationId === 'loc1' && row.customerId === 'cus1' && row.productId === 'prd1');
    assert('price per ton arrives empty for the office to fill in', row.pricePerTon === '');
    assert('and the normalized mirror is refreshed',
      SYNC_CALLS.some(c => c.key === 'fct_quarry_sales' && c.value.length === 2));
  }
  {
    // The office prices the load, then the sale is corrected and re-submitted.
    const store = new Map([[KEY, []]]);
    const sql = makeSql(store);
    await injectSalesRow(sql, 'FCT', sub);
    store.get(KEY)[0].pricePerTon = 18.75;

    await injectSalesRow(sql, 'FCT', Object.assign({}, sub, { tons: 26 }));
    const arr = store.get(KEY);
    assert('a correction replaces the row rather than adding a second',
      arr.length === 1, JSON.stringify(arr.map(r => r.id)));
    assert('the corrected tonnage lands', arr[0].tons === 26, String(arr[0].tons));
    assert("the office's price survives the correction",
      arr[0].pricePerTon === 18.75, String(arr[0].pricePerTon));
  }
  {
    // Removal has to reach the mirror table too: syncForKey short-circuits on
    // an empty array, so the last row out would otherwise stay in the mirror
    // and go on being reported.
    const store = new Map([[KEY, []]]);
    const sql = makeSql(store);
    await injectSalesRow(sql, 'FCT', sub);
    const deletes = [];
    const sql2 = makeSql(store, (q, values) => {
      if (/DELETE FROM quarry_sales_entries/.test(q)) { deletes.push(values); return []; }
    });
    const removed = await removeSalesRow(sql2, 'FCT', 55);
    assert('the row goes from the grid', removed === 1 && store.get(KEY).length === 0);
    assert('and from the normalized mirror by id',
      deletes.length === 1 && deletes[0][1].join(',') === salesRowId(55),
      JSON.stringify(deletes));
    assert('removing a submission with no row is a no-op',
      (await removeSalesRow(sql2, 'FCT', 999)) === 0);
  }
}

// ── 4. A stale grid save cannot drop or rewrite the sale ────────────────────
function guardTests() {
  console.log('\n[Sales Tracking saves the whole grid, and it is stale]');

  const cfg = guardConfigFor('fct_quarry_sales');
  assert('the blob is registered with the guard', !!cfg && cfg.prefix === 'qss-');
  assert('price per ton is the only column the tab owns',
    cfg && cfg.tabFields.join(',') === 'pricePerTon', cfg && cfg.tabFields.join(','));
  assert('and the injector agrees about which that is',
    SALES_TAB_FIELDS.join(',') === (cfg ? cfg.tabFields.join(',') : ''));

  const sale = (over = {}) => Object.assign({
    id: salesRowId(55), date: '2026-08-11', locationName: 'Homer City Pit',
    employeeName: 'Jamey Strickland', customerName: 'Kinkead Aggregates LLC',
    productName: '2A Modified', tons: 24.5, payment: 'Cash', pricePerTon: '',
  }, over);
  const typed = { id: '1755-ab12c', date: '2026-08-01', tons: 3 };

  {
    // Submitted while the tab was open. The tab's next keystroke saves the
    // list it loaded before the sale existed.
    const merged = mergeInjectedRows([typed, sale()], [typed], cfg);
    assert('a sale the save never saw is kept', merged.some(r => r.id === salesRowId(55)));
    assert('the row typed by hand is kept too', merged.some(r => r.id === '1755-ab12c'));
  }
  {
    // Deleted through the endpoint while the tab was open.
    const merged = mergeInjectedRows([typed], [typed, sale()], cfg);
    assert('a removed sale is NOT resurrected by a stale save',
      !merged.some(r => r.id === salesRowId(55)));
  }
  {
    const incoming = sale({
      tons: 999, customerName: 'SOMEONE ELSE', payment: 'Credit', date: '2020-01-01',
      pricePerTon: 18.75,
    });
    const [row] = mergeInjectedRows([sale()], [incoming], cfg);
    assert('tons stay the scale house\'s',     row.tons === 24.5, String(row.tons));
    assert('the customer stays theirs',        row.customerName === 'Kinkead Aggregates LLC');
    assert('the payment stays theirs',         row.payment === 'Cash');
    assert('the date stays theirs',            row.date === '2026-08-11');
    assert("the office's price lands",         row.pricePerTon === 18.75, String(row.pricePerTon));
  }
}

// ── 5. Who may do what ──────────────────────────────────────────────────────
async function accessTests() {
  console.log('\n[who may submit, and whose sales come back]');

  const store = new Map([['FCT:fct_quarry_lists', LISTS]]);

  async function call(who, req) {
    NEXT_AUTH   = who;
    CURRENT_SQL = makeSql(store, req._extra);
    const res = makeRes();
    await handler(Object.assign({ method: 'GET', query: {}, body: {} }, req), res);
    return { res, sql: CURRENT_SQL };
  }

  {
    const { res } = await call(OUTSIDE, { method: 'GET' });
    assert('someone with neither role is refused', res.statusCode === 403, String(res.statusCode));
  }
  {
    const { res } = await call(OFFICE, { method: 'POST', body: FULL });
    assert('the office cannot record a sale on the field\'s behalf',
      res.statusCode === 403 && /Quarry Sales access/.test(res.body.error), JSON.stringify(res.body));
  }
  {
    const { res } = await call(FIELD, { method: 'POST', body: Object.assign({}, FULL, { work_date: '' }) });
    assert('a draft with no date is refused', res.statusCode === 400 && /date/i.test(res.body.error),
      JSON.stringify(res.body));
  }
  {
    const { res } = await call(FIELD, { method: 'POST', body: Object.assign({}, FULL, { tons: '0' }) });
    assert('a zero-ton draft is refused with the useful message',
      res.statusCode === 400 && /more than zero/.test(res.body.error), JSON.stringify(res.body));
  }

  // Scope. The default is the caller's own rows for EVERY caller.
  const boundUser = sql => {
    const q = sql.calls.find(c => /FROM quarry_sales_submissions/.test(c.q));
    return q ? q.values : null;
  };
  {
    const { sql } = await call(FIELD, { method: 'GET', query: {} });
    assert('a field user gets their own sales', (boundUser(sql) || []).includes(7), JSON.stringify(boundUser(sql)));
  }
  {
    const { sql } = await call(FIELD, { method: 'GET', query: { scope: 'all' } });
    assert('a field user asking for all of them is quietly scoped to themselves',
      (boundUser(sql) || []).includes(7), JSON.stringify(boundUser(sql)));
  }
  {
    const { sql } = await call(OFFICE, { method: 'GET', query: {} });
    assert('the office gets its OWN sales by default, not the company\'s',
      (boundUser(sql) || []).includes(42), JSON.stringify(boundUser(sql)));
  }
  {
    const { sql } = await call(OFFICE, { method: 'GET', query: { scope: 'all' } });
    const vals = boundUser(sql) || [];
    assert('and the whole company only when it asks',
      !vals.includes(42) && vals.includes('FCT'), JSON.stringify(vals));
  }

  // A submitted sale is the office's to remove, not the submitter's.
  const submitted = {
    id: 55, company_code: 'FCT', user_id: 7, username: 'strickallen', status: 'submitted',
    work_date: '2026-08-11', tons: '24.5', payment: 'Cash',
  };
  const rowLookup = row => (q) => {
    if (/SELECT \* FROM quarry_sales_submissions/.test(q)) return row ? [row] : [];
    if (/DELETE FROM quarry_sales_submissions/.test(q)) return [];
    if (/DELETE FROM quarry_sales_entries/.test(q)) return [];
  };
  {
    const { res } = await call(FIELD, { method: 'DELETE', query: { id: '55' }, _extra: rowLookup(submitted) });
    assert('the submitter cannot pull a sale back out of the grid',
      res.statusCode === 403 && /quarry office/.test(res.body.error), JSON.stringify(res.body));
  }
  {
    const { res } = await call(OFFICE, { method: 'DELETE', query: { id: '55' }, _extra: rowLookup(submitted) });
    assert('the office can', res.statusCode === 200 && res.body.ok === true, JSON.stringify(res.body));
  }
  {
    const draft = Object.assign({}, submitted, { status: 'draft' });
    const { res } = await call(FIELD, { method: 'DELETE', query: { id: '55' }, _extra: rowLookup(draft) });
    assert('and a draft is still the submitter\'s to throw away',
      res.statusCode === 200 && res.body.ok === true, JSON.stringify(res.body));
  }
  {
    const other = Object.assign({}, submitted, { status: 'draft', user_id: 8 });
    const { res } = await call(FIELD, { method: 'DELETE', query: { id: '55' }, _extra: rowLookup(other) });
    assert('but not somebody else\'s draft', res.statusCode === 403, String(res.statusCode));
  }
  {
    const { res } = await call(FIELD, { method: 'PUT', query: { id: '55' }, body: FULL, _extra: rowLookup(submitted) });
    assert('a submitted sale can no longer be edited from the form',
      res.statusCode === 409 && /quarry office/.test(res.body.error), JSON.stringify(res.body));
  }
  NEXT_AUTH = FIELD;
}

// ── 6. The pages and the server describe the same form ──────────────────────
function pageTests() {
  console.log('\n[the form, the grid and the server agree]');

  const form = read('quarry-sales.html');
  const grid = read('quarry.html');
  const divs = read('divisions.html');

  // The seven questions, in order, on both sides.
  const serverLabels = FIELDS.map(f => f.label).join('|');
  assert('the server asks for the seven Sales Tracking columns',
    serverLabels === 'Date|Location|Employee|Customer|Product|Tons|Payment', serverLabels);
  const formFields = /const FIELDS = \[([\s\S]*?)\n    \];/.exec(form);
  assert('the form declares its fields as data', !!formFields);
  if (formFields) {
    const labels = [...formFields[1].matchAll(/label: '([^']+)'/g)].map(m => m[1]).join('|');
    assert('and asks for the same seven, in the same order', labels === serverLabels, labels);
    const lists = [...formFields[1].matchAll(/list: '([^']+)'/g)].map(m => m[1]).join(',');
    assert('five of them are pickers, not text boxes',
      lists === 'locations,employees,customers,products', lists);
  }
  assert('payment is a picker too',
    /<select id="f-payment">/.test(form) && /lists\.payments/.test(form));
  assert('and its options come from the server rather than a copy in the page',
    !/'Cash'/.test(form) && !/"Cash"/.test(form));
  assert('the pickers are filled from the quarry\'s own Manage Lists',
    /\/api\/quarry-sales-lists/.test(form));
  assert('tons is the one number typed in', /<input type="number" id="f-tons"/.test(form));

  // The grid's own copy of the payment list is the one the injected row has to
  // match — a value it does not know renders as a blank cell.
  const gridPayments = /const PAYMENT_OPTIONS = \[([^\]]+)\]/.exec(grid);
  assert('Sales Tracking still offers exactly the server\'s payment options',
    !!gridPayments && gridPayments[1].replace(/['\s]/g, '') === PAYMENT_OPTIONS.join(','),
    gridPayments && gridPayments[1]);

  assert('the grid recognises a submitted sale', /function isSalesSubmissionRow/.test(grid));
  assert('and renders it locked', /class="qss-locked"/.test(grid));
  assert('leaving price per ton editable on it',
    /qss-locked[\s\S]{0,2200}updateSalesNumber\(\$\{i\}, 'pricePerTon'/.test(grid));
  assert('the filtered-delete tool skips it', /!isInjectedRow\(r\)/.test(grid));
  assert('a row delete on it is refused locally',
    /if \(isInjectedRow\(salesRows\[index\]\)\) return;/.test(grid));
  assert('and removal goes through the endpoint, which takes the submission too',
    /deleteSubmittedSale[\s\S]{0,1200}\/api\/quarry-sales-submissions\?id=/.test(grid));

  assert('the division is on the selector', /quarry_sales: \{/.test(divs));
  assert('with a page to open',             /href:\s*'quarry-sales\.html'/.test(divs));
  assert('and a column in Manage Users',    /mu-role-quarry_sales/.test(divs));
  assert('the permissions matrix stays in step with DIV_KEYS',
    /const MU_SPAN = DIV_KEYS\.length \+ 2;/.test(divs));

  // The page's access guard has to name the division the token carries.
  assert('the form checks for quarry_sales access',
    /allowedDivisions\.includes\('quarry_sales'\)/.test(form));
}

// ── 7. The form, actually run ───────────────────────────────────────────────
// The checks above read quarry-sales.html as text, which cannot tell whether
// the page WORKS. This loads it in jsdom with the network stubbed and drives
// it the way the scale house does: open it, fill it in, press Submit. What it
// is really pinning is the request body — a picked answer has to post BOTH
// halves, because the id is what the server trusts and the name is what
// survives the list item being deleted a year from now.
async function browserTests() {
  console.log('\n[the form, run in a browser]');

  const { JSDOM } = require('jsdom');
  const LISTS = {
    locations: [{ id: 'loc1', name: 'Homer City Pit' }, { id: 'loc2', name: 'Rossiter' }],
    employees: [{ id: 'emp1', name: 'Jamey Strickland' }, { id: 'emp2', name: 'Dale Wilson' }],
    customers: [{ id: 'cus1', name: 'Kinkead Aggregates LLC' }],
    products:  [{ id: 'prd1', name: '2A Modified' }, { id: 'prd2', name: 'AASHTO #1' }],
    payments:  PAYMENT_OPTIONS.slice(),
  };

  const calls = [];
  const dom = new JSDOM(read('quarry-sales.html'), {
    runScripts: 'dangerously',
    url: 'https://example.test/quarry-sales.html',
    beforeParse(window) {
      window.localStorage.setItem('fct_token', 'tok');
      window.localStorage.setItem('fct_user', JSON.stringify({
        username: 'strickland', companyCode: 'FCT',
        allowedDivisions: ['quarry_sales'], divisionRoles: { quarry_sales: 'level1' },
      }));
      window.fetch = async (url, init) => {
        const u = String(url), method = (init && init.method) || 'GET';
        calls.push({ url: u, method, body: init && init.body });
        if (u.startsWith('/api/quarry-sales-lists')) return { ok: true, status: 200, json: async () => LISTS };
        if (u.includes('action=submit')) return { ok: true, status: 200, json: async () => ({ ok: true, entry: { id: '55', status: 'submitted' } }) };
        if (method === 'POST' || method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true, entry: { id: '55', status: 'draft' } }) };
        return { ok: true, status: 200, json: async () => ({ entries: [] }) };
      };
      window.confirm = () => true;
      window.scrollTo = () => {};
      // jsdom implements neither; the page calls both when it refuses a form.
      window.Element.prototype.scrollIntoView = function () {};
    },
  });

  const { window } = dom;
  const d = window.document;
  const sel = id => d.getElementById(id);
  const settle = () => new Promise(r => setTimeout(r, 30));
  await settle();

  assert('the page opens for a quarry_sales user',
    !sel('mainContent').classList.contains('hidden'));
  assert('the date opens on today', /^\d{4}-\d{2}-\d{2}$/.test(sel('f-date').value), sel('f-date').value);
  assert('every picker is filled from the endpoint',
    sel('f-location').options.length === 3 && sel('f-employee').options.length === 3 &&
    sel('f-customer').options.length === 2 && sel('f-product').options.length === 3 &&
    sel('f-payment').options.length === PAYMENT_OPTIONS.length + 1);
  assert('the employee opens on whoever is signed in, matched by surname',
    sel('f-employee').value === 'emp1', sel('f-employee').value);

  {
    // An empty form must say what is short of it rather than post anything.
    const before = calls.length;
    window.submitEntry();
    await settle();
    assert('an incomplete form is refused, naming what is missing in form order',
      /still needed: Location, Customer, Product, Tons, Payment\./.test(sel('formMsg').textContent),
      sel('formMsg').textContent);
    assert('and nothing is sent', calls.length === before);
  }

  sel('f-location').value = 'loc2';
  sel('f-employee').value = 'emp2';
  sel('f-customer').value = 'cus1';
  sel('f-product').value  = 'prd2';
  sel('f-tons').value     = '24.5';
  sel('f-payment').value  = 'Credit';
  await window.submitEntry();
  await settle();

  const post = calls.find(c => c.method === 'POST' && !c.url.includes('action=submit'));
  assert('the sale is written out as a draft first', !!post,
    JSON.stringify(calls.map(c => c.method + ' ' + c.url)));
  if (post) {
    const body = JSON.parse(post.body);
    assert('every picked answer posts BOTH halves',
      body.location_id === 'loc2' && body.location_name === 'Rossiter' &&
      body.employee_id === 'emp2' && body.employee_name === 'Dale Wilson' &&
      body.customer_id === 'cus1' && body.customer_name === 'Kinkead Aggregates LLC' &&
      body.product_id  === 'prd2' && body.product_name  === 'AASHTO #1',
      JSON.stringify(body));
    assert('the two typed answers ride along', body.tons === '24.5' && body.payment === 'Credit');
    assert('and nothing else is sent', Object.keys(body).sort().join(',') ===
      'customer_id,customer_name,employee_id,employee_name,location_id,location_name,payment,product_id,product_name,tons,work_date',
      Object.keys(body).sort().join(','));
  }
  assert('then it is submitted against the row it just adopted',
    calls.some(c => c.url.includes('action=submit&id=55')),
    JSON.stringify(calls.map(c => c.method + ' ' + c.url)));
  assert('the form says where the sale went',
    /Sales Tracking/.test(sel('formMsg').textContent), sel('formMsg').textContent);
  assert('and clears for the next load', sel('formTitle').textContent === 'New Sale');

  window.close();
}

(async () => {
  console.log('Quarry Sales — the form, the endpoint and the grid it lands in');
  parsingTests();
  await spellingTests();
  await injectionTests();
  guardTests();
  await accessTests();
  pageTests();
  await browserTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
