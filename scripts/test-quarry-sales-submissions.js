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
 * 2. THE TOTAL IS A MULTIPLICATION, AND ONLY ONE SIDE MAY DO IT. The form asks
 *    the price and works the amount out: tons x price. The page shows the same
 *    figure as it is typed, off its own copy of the rule, and never posts it —
 *    the server multiplies the same two numbers again, so a page that could
 *    send its own total would be a page that could bill a customer something
 *    other than what its two figures say.
 *
 *    This ran the other way round first, and the reason it stopped is worth
 *    keeping: a division does not come back. $100 over 3 tons is 33.3333 a ton,
 *    and 33.3333 x 3 is 99.9999.
 *
 * 3. THE OFFICE'S PRICE SURVIVES. Price per ton is the one column of an
 *    injected row the office owns, and it is filled FORWARD ONLY — onto a cell
 *    still blank. A retried submit that restated it would silently re-price a
 *    load that has already been invoiced.
 *
 * 4. A SUBMITTED SALE IS NOT THE TAB'S TO DROP. The blob guard restores an
 *    injected row a whole-blob save omitted, so a row deleted only in the grid
 *    comes back on the next refresh — which looks, for the seconds in between,
 *    exactly like it worked. Removal has to go through the endpoint, which
 *    takes the submission with it.
 *
 * 5. OWN ROWS BY DEFAULT. A request that names no scope gets the caller's own
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
  FIELDS, MAX_TONS, MAX_PRICE, safeDate, parseTons, parsePrice,
  amountFrom, priced, normalizeBody, missingFields,
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
  price_per_ton: '18.00',
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

// Every load the total rule is measured against — the server's copy and the
// form's. Kept as data so pageTests() can run the page's copy through exactly
// the same cases and fail if the two ever disagree by so much as an edge.
const AMOUNT_CASES = [
  // [tons, price, expected amount or null, what it is]
  [24.5,   18,      441,      'an ordinary load'],
  [3,      33.3333, 100,      'a price divided back out of an old ticket, multiplied home again'],
  [20,     20,      400,      'the sale already in the table when this changed'],
  [5.96,   15.75,   93.87,    'a real row off the grid'],
  [45.41,  18,      817.38,   'another, to the cent'],
  [24.5,   18.005,  441.12,   'a half-cent that has to round, not truncate'],
  [200,    1000,    200000,   'the biggest load at the highest price both caps allow'],
  [0,      18,      null,     'no tonnage yet — a half-finished draft'],
  [24.5,   0,       null,     'no price yet'],
  [null,   18,      null,     'the tonnage not filled in'],
  [24.5,   null,    null,     'the price not filled in'],
  [-24.5,  18,      null,     'a negative weight'],
  [24.5,   -18,     null,     'a negative price'],
  ['24.5', '18.00', 441,      'the strings a form actually posts'],
  ['lots', 18,      null,     'nonsense'],
];

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
    assert('so does the price', data.price_per_ton === 18, String(data.price_per_ton));
    assert('and the total is worked out, not asked for',
      data.amount_charged === 441, String(data.amount_charged));
    assert('and it counts as complete', missingFields(data).length === 0,
      JSON.stringify(missingFields(data)));
  }
  {
    const { data, error } = normalizeBody({ work_date: '2026-08-11' });
    assert('a date on its own parses', !error, error);
    assert('tons left blank stay null', data.tons === null);
    assert('and with no tons and no price there is no total',
      data.amount_charged === null, String(data.amount_charged));
    assert('and everything else is reported missing, in form order',
      missingFields(data).join('|') === 'Location|Employee|Customer|Product|Tons|Price / Ton|Payment',
      missingFields(data).join('|'));
    assert('the total is never "missing" — it is not something anyone fills in',
      !missingFields(data).includes('Amount Charged'));
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

  console.log('\n[price per ton]');
  assert('blank is allowed',              parsePrice('').value === null && !parsePrice('').error);
  assert('a real price is kept',          parsePrice('18.00').value === 18);
  assert('cents are kept',                parsePrice('15.75').value === 15.75);
  // Four places, not two. A sale recorded while the form asked for the ticket
  // total carries a price divided back out of it, and rounding that to the
  // cent on the first edit would quietly move the money.
  assert('four decimals survive',         parsePrice('33.3333').value === 33.3333);
  assert('a fifth is rounded off',        parsePrice('33.33335').value === 33.3334);
  assert('zero is refused',               !!parsePrice('0').error);
  assert('negative is refused',           !!parsePrice('-18').error);
  assert('nonsense is refused',           !!parsePrice('eighteen').error);
  assert(`over $${MAX_PRICE} a ton is refused`, !!parsePrice(String(MAX_PRICE + 1)).error);
  assert('the cap itself is allowed',     parsePrice(String(MAX_PRICE)).value === MAX_PRICE);
  assert('a missed decimal point is caught', !!parsePrice('1575').error);
  {
    const { data, error } = normalizeBody(Object.assign({}, FULL, { price_per_ton: '0' }));
    assert('and the refusal says what is wrong with it',
      !data && /more than zero/.test(error || ''), error);
  }

  console.log('\n[what the load comes to]');
  for (const [tons, price, want, what] of AMOUNT_CASES) {
    const got = amountFrom(tons, price);
    assert(`${what}`, got === want, `${tons} x ${price} → ${got}, expected ${want}`);
  }
  {
    // The server owns this multiplication. A body that carries its own total
    // must not be able to bill a customer something other than tons x price.
    const { data } = normalizeBody(Object.assign({}, FULL, { amount_charged: '99999.99' }));
    assert('a total posted by the client is ignored, not trusted',
      data.amount_charged === 441, String(data.amount_charged));
  }

  console.log('\n[payment]');
  for (const p of PAYMENT_OPTIONS) {
    assert(`${p} is accepted`, !normalizeBody(Object.assign({}, FULL, { payment: p })).error);
  }
  assert('anything else is refused',
    !!normalizeBody(Object.assign({}, FULL, { payment: 'Check' })).error);

  console.log('\n[dates]');
  assert('an ISO date is kept',        safeDate('2026-08-11') === '2026-08-11');
  // Shaped like a date is not the same as being one. These get past the
  // pattern and a plain 1-31 range check, and are then refused by the DATE
  // column — a 500 with a driver's error in it rather than the 400 that tells
  // the scale house to fix the date.
  assert('the 30th of February is refused',   safeDate('2026-02-30') === null);
  assert('the 31st of April is refused',      safeDate('2026-04-31') === null);
  assert('the 29th of a non-leap year too',   safeDate('2026-02-29') === null);
  assert('but a real leap day is kept',       safeDate('2024-02-29') === '2024-02-29');
  assert('and the last day of a long month',  safeDate('2026-12-31') === '2026-12-31');
  assert('and the last day of a short one',   safeDate('2026-04-30') === '2026-04-30');
  assert('an impossible date is refused as a 400, not passed to the column',
    !!normalizeBody({ work_date: '2026-02-30' }).error);
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

    assert('the row is added, not swapped in', arr.length === 2);
    assert("the tab's own row is untouched", arr.some(r => r.id === 'typed-by-hand'));
    assert('and the sale lands at the top, where "+ Add Row" puts one',
      arr[0].id === salesRowId(55), JSON.stringify(arr.map(r => r.id)));
    assert('the id names its submission', row.id === salesRowId(55), row.id);
    assert('and reads as an injected row',  isQuarrySalesRow(row));
    assert('the seven answers are carried across',
      row.date === '2026-08-11' && row.locationName === 'Homer City' &&
      row.employeeName === 'Jamey Strickland' && row.customerName === 'Kinkead Aggregates' &&
      row.productName === '2A Modified' && row.tons === 24.5 && row.payment === 'Cash',
      JSON.stringify(row));
    assert('the ids ride along, so the grid filters work',
      row.locationId === 'loc1' && row.customerId === 'cus1' && row.productId === 'prd1');
    assert('the price is the one the form was given', row.pricePerTon === 18, String(row.pricePerTon));
    assert('and tons x price is the total the submitter was shown',
      row.tons * row.pricePerTon === 441, String(row.tons * row.pricePerTon));
    assert('and the normalized mirror is refreshed',
      SYNC_CALLS.some(c => c.key === 'fct_quarry_sales' && c.value.length === 2));
  }
  {
    // A sale carrying no price still lands, unpriced, for the office to price
    // by hand. Unreachable through submit, which checks completeness first.
    const store = new Map([[KEY, []]]);
    const row = await injectSalesRow(makeSql(store), 'FCT',
      Object.assign({}, sub, { price_per_ton: null }));
    assert('a sale with no price arrives with a blank one', row.pricePerTon === '',
      String(row.pricePerTon));
  }
  {
    // The half-finished submit. injectSalesRow lands the row, the status UPDATE
    // behind it dies, and the submission is still a draft — so the submitter
    // can fix the total they fat-fingered and send it again.
    //
    // This regressed once and it regressed in the worst direction: the row kept
    // the price the FIRST attempt carried, so a load priced at $18 went on
    // billing at $180 with the submission reading 18 and nothing on the row to
    // say the two disagreed. Every column corrected except the money.
    const store = new Map([[KEY, []]]);
    const sql = makeSql(store);
    await injectSalesRow(sql, 'FCT', Object.assign({}, sub, { price_per_ton: 180 }));
    assert('the mistyped price lands on the row first time round',
      store.get(KEY)[0].pricePerTon === 180, String(store.get(KEY)[0].pricePerTon));

    await injectSalesRow(sql, 'FCT', Object.assign({}, sub, { tons: 26, price_per_ton: 20 }));
    const arr = store.get(KEY);
    assert('a correction replaces the row rather than adding a second',
      arr.length === 1, JSON.stringify(arr.map(r => r.id)));
    assert('the corrected tonnage lands', arr[0].tons === 26, String(arr[0].tons));
    assert('AND SO DOES THE CORRECTED PRICE', arr[0].pricePerTon === 20, String(arr[0].pricePerTon));
    assert('so the grid bills what the corrected sale says',
      arr[0].tons * arr[0].pricePerTon === 520, String(arr[0].tons * arr[0].pricePerTon));
  }
  {
    // priced() states the rule on its own, because the whole of it is which of
    // two numbers wins and an off-by-one reading of "blank" decides it.
    const t = { tons: 24.5, price_per_ton: 18 };
    assert('no prior row → the sale prices it',      priced(null, t) === 18);
    assert("a prior '' → the sale prices it",        priced({ pricePerTon: '' }, t) === 18);
    assert('a prior null → the sale prices it',      priced({ pricePerTon: null }, t) === 18);
    assert('a prior absent → the sale prices it',    priced({}, t) === 18);
    assert('a prior figure does NOT survive a sale that disagrees',
      priced({ pricePerTon: 180 }, t) === 18);
    assert('a prior 0 does not either',              priced({ pricePerTon: 0 }, t) === 18);
    assert('a price posted as a string still counts',
      priced({ pricePerTon: 180 }, { tons: 24.5, price_per_ton: '18.00' }) === 18);
    // The one case the fallback is for: no price on the sale, so whatever is on
    // the row stays. Unreachable through submit, which checks completeness
    // first — it is here so an incomplete injection cannot blank a hand-typed
    // price.
    const noPrice = { tons: 24.5, price_per_ton: null };
    assert('with no price on the sale, a hand-typed one is left alone',
      priced({ pricePerTon: 18.75 }, noPrice) === 18.75);
    assert('with no price and no prior, it stays blank',
      priced(null, noPrice) === '');
    assert("with no price, a prior '' stays ''",
      priced({ pricePerTon: '' }, noPrice) === '');
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

// ── 3b. Sales that predate the price column ─────────────────────────────────
// The form asked for the ticket total before it asked for a price, so rows
// exist with an amount and no price. The migration divides one back out where
// it can; where the quotient is above what the form accepts it leaves NULL
// rather than writing a figure that would lock the row's own draft.
function legacyRowTests() {
  console.log('\n[a sale recorded before the price was asked for]');

  const row = over => Object.assign({
    id: 9, status: 'submitted', username: 'strickallen', user_id: 7,
    work_date: '2026-08-26', tons: '20', price_per_ton: null, amount_charged: '400.00',
    payment: 'Cash',
  }, over);

  {
    // Backfilled: 400 over 20 tons is 20 a ton, which is what its Sales
    // Tracking row was already showing.
    const e = dbToEntry(row({ price_per_ton: '20.0000' }));
    assert('a backfilled price comes back as a number', e.price_per_ton === 20, String(e.price_per_ton));
    assert('and the total is the product of the two', e.amount_charged === 400, String(e.amount_charged));
  }
  {
    // Not backfilled — the quotient was over the cap. It was still charged
    // what it was charged, and blanking that out of the submitter's own list
    // would lose a real figure.
    const e = dbToEntry(row({ tons: '1', price_per_ton: null, amount_charged: '1200.00' }));
    assert('a row left unpriced keeps the amount it was charged',
      e.amount_charged === 1200, String(e.amount_charged));
    assert('and reports no price rather than inventing one', e.price_per_ton === null);
  }
  {
    const e = dbToEntry(row({ tons: null, price_per_ton: null, amount_charged: null }));
    assert('a draft with neither has neither',
      e.amount_charged === null && e.price_per_ton === null, JSON.stringify(e));
  }

  // Reading it back is only half of it. The total is DERIVED, so an ordinary
  // Save Draft on one of these rows posts a body with no tonnage and no price,
  // normalizeBody hands back amount_charged: null, and a plain assignment
  // would write that over the figure the customer was charged — on the first
  // save, with the number never having appeared on screen to be missed.
  {
    const { data } = normalizeBody({ work_date: '2026-08-11' });
    assert('a save with nothing to multiply derives no total',
      data.amount_charged === null, String(data.amount_charged));

    const api = read('api/quarry-sales-submissions.js');
    const upd = /UPDATE quarry_sales_submissions SET([\s\S]*?)RETURNING/.exec(api);
    assert('and the UPDATE coalesces rather than assigning it', !!upd &&
      /amount_charged = COALESCE\(\$\{data\.amount_charged\}::numeric, amount_charged\)/.test(upd[1]),
      upd && upd[1]);
    assert('while every other column assigns as normal', !!upd &&
      /price_per_ton\s+= \$\{data\.price_per_ton\},/.test(upd[1]) &&
      /tons\s+= \$\{data\.tons\},/.test(upd[1]));
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

// ── 5b. Submitting the same load twice ──────────────────────────────────────
// A fill-up repeated to the gallon is a double-press. A truckload repeated to
// the ton is a customer taking four of them before lunch — the tickets agree
// on every column because the loads did. So the second one is a question, and
// the answer comes back as ?confirm_duplicate=1.
async function duplicateTests() {
  console.log('\n[the same load, submitted twice]');

  const DRAFT = Object.assign({
    id: 55, company_code: 'FCT', user_id: 7, username: 'strickallen', status: 'draft',
  }, normalizeBody(FULL).data);

  // A submit path that answers every statement it runs, with the duplicate
  // lookup switchable.
  function submitSql(store, dupFound) {
    const seen = [];
    const sql = makeSql(store, (q) => {
      seen.push(q);
      if (/JOIN quarry_sales_submissions b/.test(q))          return dupFound ? [{ id: 99 }] : [];
      if (/SELECT \* FROM quarry_sales_submissions/.test(q))   return [DRAFT];
      if (/UPDATE quarry_sales_submissions/.test(q))          return [Object.assign({}, DRAFT, { status: 'submitted' })];
    });
    sql.seen = seen;
    return sql;
  }

  async function submit(dupFound, query) {
    NEXT_AUTH   = FIELD;
    const store = new Map([['FCT:fct_quarry_sales', []]]);
    CURRENT_SQL = submitSql(store, dupFound);
    const res = makeRes();
    await handler({ method: 'POST', query: Object.assign({ action: 'submit', id: '55' }, query), body: {} }, res);
    return { res, store, sql: CURRENT_SQL };
  }

  {
    const { res, store } = await submit(false);
    assert('an ordinary sale goes straight in', res.statusCode === 200 && res.body.ok === true,
      JSON.stringify(res.body));
    assert('and lands in the grid, priced', store.get('FCT:fct_quarry_sales')[0].pricePerTon === 18,
      JSON.stringify(store.get('FCT:fct_quarry_sales')));
  }
  {
    const { res, store } = await submit(true);
    assert('a matching sale comes back as a question, not a refusal',
      res.statusCode === 409 && res.body.code === 'duplicate', JSON.stringify(res.body));
    assert('the question names it as a possible second load', /second load/i.test(res.body.error),
      res.body.error);
    assert('it points at the sale it matched', res.body.duplicate_of === '99');
    assert('and nothing was posted to the grid', store.get('FCT:fct_quarry_sales').length === 0);
  }
  {
    const { res, store, sql } = await submit(true, { confirm_duplicate: '1' });
    assert('answered yes, the second load goes in', res.statusCode === 200 && res.body.ok === true,
      JSON.stringify(res.body));
    assert('and the check is not even run', !sql.seen.some(q => /JOIN quarry_sales_submissions b/.test(q)));
    assert('so the grid gets its second row', store.get('FCT:fct_quarry_sales').length === 1);
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
  // All eight ARE grid columns — the form asks for exactly the ones the scale
  // house can answer, and the grid works out the rest (sales tax, net sales,
  // total due) from them.
  assert('the server asks for eight of Sales Tracking\'s own columns',
    serverLabels === 'Date|Location|Employee|Customer|Product|Tons|Price / Ton|Payment',
    serverLabels);
  const formFields = /const FIELDS = \[([\s\S]*?)\n    \];/.exec(form);
  assert('the form declares its fields as data', !!formFields);
  if (formFields) {
    const labels = [...formFields[1].matchAll(/label: '([^']+)'/g)].map(m => m[1]).join('|');
    assert('and asks for the same eight, in the same order', labels === serverLabels, labels);
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
  assert('tons and the price are the two numbers typed in',
    /<input type="number" id="f-tons"/.test(form) && /<input type="number" id="f-price"/.test(form));
  // parsePrice keeps four places so a price divided back out of an old ticket
  // survives. At step="0.01" such a value is :invalid and one press of the
  // spinner SNAPS it — 18.0151 becomes 18.02, re-pricing the load on a
  // keystroke meant to nudge it.
  {
    const stepOf = re => { const m = re.exec(form); return m && m[1]; };
    assert('the price input admits the precision the server stores',
      stepOf(/<input type="number" id="f-price"[^>]*step="([\d.]+)"/) === '0.0001',
      stepOf(/<input type="number" id="f-price"[^>]*step="([\d.]+)"/));
    const grid2 = read('quarry.html');
    assert("and matches the grid's own price cell",
      /updateSalesNumber\(\$\{i\}, 'pricePerTon'/.test(grid2) &&
      /step="0\.0001"[^>]*oninput="updateSalesNumber\(\$\{i\}, 'pricePerTon'/.test(grid2));
  }
  // The total is filled in, not asked for. readonly rather than disabled: a
  // disabled box is skipped by the browser's own focus order AND greyed to
  // near-invisible on a phone, and this is the figure the customer is billed.
  assert('and the total is a box the form fills in',
    /<input type="text" id="f-amount" readonly/.test(form));

  // The form shows the price as it is typed, off its own copy of the rule. A
  // page that showed one figure and stored another is worse than one that
  // showed nothing, so both copies are run over the same tickets.
  const pageAmount = (() => {
    const start = form.indexOf('function amountFrom(');
    assert('the form carries its own copy of the total rule', start >= 0);
    if (start < 0) return null;
    let depth = 0;
    for (let j = form.indexOf('{', start); j < form.length; j++) {
      if (form[j] === '{') depth++;
      else if (form[j] === '}' && --depth === 0) {
        return new Function(`${form.slice(start, j + 1)}\nreturn amountFrom;`)();
      }
    }
    return null;
  })();
  if (pageAmount) {
    const off = AMOUNT_CASES.filter(([t, p, want]) => pageAmount(t, p) !== want);
    assert(`the form agrees with the server on all ${AMOUNT_CASES.length} loads`,
      off.length === 0,
      off.map(([t, p, want]) => `(${t},${p}) form=${pageAmount(t, p)} server=${want}`).join('; '));
  }

  // The grid's own copy of the payment list is the one the injected row has to
  // match — a value it does not know renders as a blank cell.
  const gridPayments = /const PAYMENT_OPTIONS = \[([^\]]+)\]/.exec(grid);
  assert('Sales Tracking still offers exactly the server\'s payment options',
    !!gridPayments && gridPayments[1].replace(/['\s]/g, '') === PAYMENT_OPTIONS.join(','),
    gridPayments && gridPayments[1]);

  // The price tooltip has been got wrong twice, both times by asserting
  // something an office re-price falsifies. Nothing it says may depend on the
  // price, and it may not name a dollar figure at all.
  assert('the grid recognises a submitted sale', /function isSalesSubmissionRow/.test(grid));
  assert('and renders it locked', /class="qss-locked"/.test(grid));
  assert('leaving price per ton editable on it',
    /qss-locked[\s\S]{0,2200}updateSalesNumber\(\$\{i\}, 'pricePerTon'/.test(grid));
  // The price tooltip used to name tons x price as "charged on the ticket",
  // which stopped being true the moment the office re-priced the row — it then
  // quoted a total nobody was ever charged, and refreshSalesRowTotals never
  // refreshed it anyway. Nothing it says may depend on the price.
  {
    const src = /function salesPriceTitle\(row\) \{([\s\S]*?)\n    \}/.exec(grid);
    assert('the grid explains where a submitted sale\'s price came from', !!src);
    if (src) {
      assert('and states no dollar figure that an edit could falsify',
        !/formatMoney/.test(src[1]), src[1].trim());
      assert('and reads nothing off the price itself, so it cannot go stale',
        !/pricePerTon/.test(src[1]), src[1].trim());
    }
  }
  // A submitted sale used to arrive at the BOTTOM of the grid — under three
  // hundred rows, on a tab with no sort control — which reads exactly like it
  // never arrived. The injector prepends now, but that alone is not enough:
  // mergeInjectedRows appends any row a save never mentioned, so a sale landing
  // while the tab is open goes to the end however it was stored. The table has
  // to order itself.
  assert('Sales Tracking orders itself by date, newest first',
    /\.sort\(byDateDesc\)/.test(grid) && /function byDateDesc/.test(grid));
  // Daily and Crushing have sorted newest-first since payroll started injecting
  // into them, but off their own copies of the rule, which put an undated row
  // at the BOTTOM where Sales puts it at the top. Three tabs, one comparator,
  // so they cannot drift apart again.
  const SORTED_BY_DATE = /\.sort\((?:byDateDesc\b|\(a, b\) => byDateDesc\()/g;
  assert('and so do Daily and Crushing, off the same comparator',
    (grid.match(SORTED_BY_DATE) || []).length === 3,
    String((grid.match(SORTED_BY_DATE) || []).length));
  {
    // Scoped to the three tracking grids — the ones that carry injected rows.
    // Inventory's adjustment grid sorts by date too and is left alone: nothing
    // is injected into it, so an undated row there means something else.
    const blocks = [...grid.matchAll(/const visibleEntries = \w+Rows\n[\s\S]*?;\n/g)].map(m => m[0]);
    assert('all three tracking grids build their rows the same way', blocks.length === 3,
      String(blocks.length));
    // Crushing groups its rows by day, so it breaks a same-date tie by pit to
    // keep each day's rows contiguous under one group header. byDateDesc still
    // decides the dates, and the only tie it breaks is one byDateDesc itself
    // returns 0 for — anything ordering these grids by something OTHER than
    // the shared comparator is a tab drifting off the rule again.
    const SHARED = /\.sort\((?:byDateDesc|\(a, b\) => byDateDesc\(a, b\)(?: \|\| \w+\(a, b\))?)\);\n$/;
    assert('and every one of them sorts with the shared comparator',
      blocks.every(b => SHARED.test(b)),
      blocks.filter(b => !SHARED.test(b)).join('\n---\n'));
  }
  {
    const src = /function byDateDesc\(a, b\) \{([\s\S]*?)\n    \}/.exec(grid);
    assert('and the comparator is lifted out where it can be read', !!src);
    if (src) {
      const cmp = new Function(`${src[0]}\nreturn byDateDesc;`)();
      const rows = [
        { row: { id: 'aug06', date: '2026-08-06' } },
        { row: { id: 'aug26', date: '2026-08-26' } },
        { row: { id: 'nodate', date: '' } },
        { row: { id: 'aug10a', date: '2026-08-10' } },
        { row: { id: 'aug10b', date: '2026-08-10' } },
        { row: { id: 'sep02', date: '2026-09-02' } },
      ];
      const order = rows.slice().sort(cmp).map(e => e.row.id).join(',');
      assert('newest first, undated at the top, same-date order kept',
        order === 'nodate,sep02,aug26,aug10a,aug10b,aug06', order);
    }
  }
  assert('the filtered-delete tool skips it', /!isInjectedRow\(r\)/.test(grid));
  assert('a row delete on it is refused locally',
    /if \(isInjectedRow\(salesRows\[index\]\)\) return;/.test(grid));
  assert('and removal goes through the endpoint, which takes the submission too',
    /deleteSubmittedSale[\s\S]{0,1200}\/api\/quarry-sales-submissions\?id=/.test(grid));

  // The migration divides a price back out of every sale recorded before the
  // form asked for one — but only where the quotient is a price the form would
  // accept. Above the cap it leaves NULL, because a row it wrote there is a
  // DRAFT nobody can save: every write re-parses it and parsePrice refuses it.
  {
    const schema = read('neon-schema.sql');
    const m = /UPDATE quarry_sales_submissions[\s\S]*?amount_charged \/ NULLIF\(tons, 0\) <= (\d+)/.exec(schema);
    assert('the backfill is bounded', !!m, 'no bound found on the backfill UPDATE');
    assert('and bounded by the same figure the form accepts',
      m && Number(m[1]) === MAX_PRICE, m && m[1]);
    // NULLIF rather than a bare tons > 0: Postgres does not promise to evaluate
    // WHERE conditions in written order, so the guard cannot be relied on to
    // run before the division it guards — and this statement executes inside
    // the Vercel build, where a throw takes the deploy with it.
    assert('it cannot divide by zero, whatever order the planner picks',
      !/amount_charged \/ tons/.test(schema) &&
      (schema.match(/amount_charged \/ NULLIF\(tons, 0\)/g) || []).length === 2,
      (schema.match(/amount_charged \/ NULLIF\(tons, 0\)/g) || []).join(' | '));
    assert('and it cannot write a zero or negative price', /amount_charged > 0/.test(schema));
    assert('and it is a no-op on every run after the first',
      /price_per_ton IS NULL/.test(schema));
  }

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
  // editEntry reads the page's own cache, which is filled by loadEntries from
  // the network. Seeding it directly is how a single row gets in front of the
  // form without standing up a whole fake listing endpoint.
  const entriesCacheSeed = rows => window.eval(`entriesCache = ${JSON.stringify(rows)}`);
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
      /still needed: Location, Customer, Product, Tons, Price \/ Ton, Payment\./.test(sel('formMsg').textContent),
      sel('formMsg').textContent);
    assert('and nothing is sent', calls.length === before);
  }

  // The total is the only guard against a price typed wrong, so it has to fill
  // in as the two figures are entered and not a moment later.
  assert('the total box is empty before anything is typed', sel('f-amount').value === '',
    sel('f-amount').value);
  assert('and the note says where it will come from',
    !/\$/.test(sel('amountNote').textContent) && sel('amountNote').textContent.length > 0,
    sel('amountNote').textContent);
  sel('f-tons').value = '24.5';
  window.updateAmount();
  assert('still empty with only the tonnage in', sel('f-amount').value === '', sel('f-amount').value);
  sel('f-price').value = '18.00';
  window.updateAmount();
  assert('then fills the total in as the price is typed',
    sel('f-amount').value === '441.00', sel('f-amount').value);
  // The note is the form's live region — an aria-live on the INPUT never fires
  // for a value change — so what it says is the whole sum a screen reader
  // hears, total included, not just the two figures behind it.
  assert('and says what it is made of, total and all',
    sel('amountNote').textContent === '24.5 tons × $18.00 / ton = $441.00',
    sel('amountNote').textContent);
  assert('the live region is the note, not the box',
    sel('amountNote').getAttribute('aria-live') === 'polite' &&
    !sel('f-amount').hasAttribute('aria-live'));
  assert('and it cannot be typed into', sel('f-amount').readOnly === true);
  // readonly but reachable: a negative tabindex took the total out of the tab
  // order, which was the last way a screen reader could get at it.
  assert('the total is still reachable by keyboard',
    !sel('f-amount').hasAttribute('tabindex'), sel('f-amount').getAttribute('tabindex'));

  {
    // The sum the live region states has to be TRUE. A price divided back out
    // of an old ticket runs to four places, and shown to two it stops
    // multiplying out — "3 tons × $33.33 / ton = $100.00" is wrong by a cent,
    // stated by the form, in its own announcement.
    sel('f-tons').value = '3';
    sel('f-price').value = '33.3333';
    window.updateAmount();
    assert('a four-place price is shown to four places',
      sel('amountNote').textContent === '3 tons × $33.3333 / ton = $100.00',
      sel('amountNote').textContent);
    assert('and the total it states is the product of what it states',
      sel('f-amount').value === '100.00', sel('f-amount').value);
    sel('f-price').value = '18.00';
    window.updateAmount();
    assert('an ordinary price still reads to two',
      /\$18\.00 \/ ton/.test(sel('amountNote').textContent), sel('amountNote').textContent);
    sel('f-tons').value = '24.5';
    window.updateAmount();
  }

  {
    // A draft recorded before the form asked for a price has a total and no
    // price. The box shows tons x price and there is no price, so without
    // carrying it the figure the customer was charged is invisible while the
    // submitter decides what to type over it.
    entriesCacheSeed([{ id: '77', status: 'draft', work_date: '2026-08-11',
      location_id: 'loc2', location_name: 'Rossiter', employee_id: 'emp2', employee_name: 'Dale Wilson',
      customer_id: 'cus1', customer_name: 'Kinkead Aggregates LLC',
      product_id: 'prd2', product_name: 'AASHTO #1',
      tons: null, price_per_ton: null, amount_charged: 400, payment: 'Cash' }]);
    window.editEntry('77');
    await settle();
    assert('the recorded total is put on screen, not left blank',
      sel('f-amount').value === '400.00', sel('f-amount').value);
    assert('and the note says why there is no price behind it',
      /Recorded at \$400\.00 before this form asked for a price/.test(sel('amountNote').textContent),
      sel('amountNote').textContent);
    sel('f-tons').value = '20';
    sel('f-price').value = '20.00';
    window.updateAmount();
    assert('and pricing it takes the total back over',
      sel('f-amount').value === '400.00' &&
      sel('amountNote').textContent === '20 tons × $20.00 / ton = $400.00',
      sel('amountNote').textContent);
    window.resetForm();
    assert('a reset clears the carried total', sel('f-amount').value === '', sel('f-amount').value);
  }

  {
    // A 0 in the tonnage is not empty and is not a load either. Branching on
    // emptiness pointed at the price — telling someone to fill in a box they
    // had just filled in, while the wrong one sat there with a 0 in it.
    const hintFor = (tons, price) => {
      sel('f-tons').value = tons; sel('f-price').value = price;
      window.updateAmount();
      return sel('amountNote').textContent;
    };
    assert('a zero tonnage points at the tonnage',
      /Fill in the tonnage/.test(hintFor('0', '18.00')), hintFor('0', '18.00'));
    assert('a negative tonnage does too',
      /Fill in the tonnage/.test(hintFor('-5', '18.00')), hintFor('-5', '18.00'));
    assert('a zero price points at the price',
      /Fill in the price/.test(hintFor('24.5', '0')), hintFor('24.5', '0'));
    assert('and neither usable asks for both',
      /tonnage and the price/.test(hintFor('0', '0')), hintFor('0', '0'));
    hintFor('24.5', '18.00');
  }
  {
    // The whole point: a decimal point missed shows up here, on the screen of
    // the person writing the ticket, because no threshold could catch it.
    sel('f-price').value = '1800';
    window.updateAmount();
    assert('a missed decimal point is unmissable in it',
      sel('f-amount').value === '44,100.00', sel('f-amount').value);
    sel('f-price').value = '18.00';
    window.updateAmount();
  }

  sel('f-location').value = 'loc2';
  sel('f-employee').value = 'emp2';
  sel('f-customer').value = 'cus1';
  sel('f-product').value  = 'prd2';
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
    assert('the three typed answers ride along',
      body.tons === '24.5' && body.price_per_ton === '18.00' && body.payment === 'Credit',
      JSON.stringify(body));
    assert('and the TOTAL is not among them — the server does that multiplication',
      !('amount_charged' in body), Object.keys(body).join(','));
    assert('and nothing else is sent', Object.keys(body).sort().join(',') ===
      'customer_id,customer_name,employee_id,employee_name,location_id,location_name,payment,price_per_ton,product_id,product_name,tons,work_date',
      Object.keys(body).sort().join(','));
  }
  assert('then it is submitted against the row it just adopted',
    calls.some(c => c.url.includes('action=submit&id=55')),
    JSON.stringify(calls.map(c => c.method + ' ' + c.url)));
  assert('the form says where the sale went',
    /Sales Tracking/.test(sel('formMsg').textContent), sel('formMsg').textContent);
  assert('and clears for the next load', sel('formTitle').textContent === 'New Sale');

  // ── Whose sales the list is showing ──────────────────────────────────────
  // The toggle is offered only to someone who also works the quarry side,
  // because the endpoint quietly scopes a field user's ?scope=all back to
  // their own rows — for anyone else it would be a button that appears to do
  // nothing. This user holds quarry_sales and nothing else.
  {
    assert('a field-only user is never offered the company view',
      sel('whoToggle').hidden === true);
    const before = calls.length;
    window.setWho(false);
    await settle();
    assert('and calling it directly changes nothing',
      calls.length === before, JSON.stringify(calls.slice(before).map(c => c.url)));
  }

  // A second identical load. The endpoint asks; the form has to put the
  // question to the person holding the tickets and act on either answer.
  {
    let dupUntilConfirmed = true;
    const before = calls.length;
    window.fetch = async (url, init) => {
      const u = String(url), method = (init && init.method) || 'GET';
      calls.push({ url: u, method, body: init && init.body });
      if (u.includes('action=submit')) {
        if (dupUntilConfirmed && !u.includes('confirm_duplicate=1')) {
          return { ok: false, status: 409, json: async () => ({
            error: 'A sale already submitted today matches this one exactly. Was this a second load?',
            code: 'duplicate', duplicate_of: '54',
          }) };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, entry: { id: '56', status: 'submitted' } }) };
      }
      if (method === 'POST' || method === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true, entry: { id: '56', status: 'draft' } }) };
      return { ok: true, status: 200, json: async () => ({ entries: [] }) };
    };

    const fill = () => {
      sel('f-location').value = 'loc2'; sel('f-employee').value = 'emp2';
      sel('f-customer').value = 'cus1'; sel('f-product').value  = 'prd2';
      sel('f-tons').value = '24.5';     sel('f-price').value    = '18.00';
      sel('f-payment').value = 'Credit';
    };

    // Answered no: it stays a draft, and is not sent again.
    let asked = 0;
    window.confirm = () => { asked++; return asked === 1; };   // yes to submit, no to the duplicate
    fill();
    await window.submitEntry();
    await settle();
    assert('answered no, it is left as a draft',
      /draft/i.test(sel('formMsg').textContent) && sel('formTitle').textContent === 'Edit Draft',
      sel('formMsg').textContent);
    assert('and never sent a second time',
      !calls.slice(before).some(c => c.url.includes('confirm_duplicate=1')),
      JSON.stringify(calls.slice(before).map(c => c.url)));

    // Answered yes: it goes in as a second load.
    const mark = calls.length;
    window.confirm = () => true;
    fill();
    await window.submitEntry();
    await settle();
    assert('answered yes, the form sends it as a second load',
      calls.slice(mark).some(c => c.url.includes('confirm_duplicate=1')),
      JSON.stringify(calls.slice(mark).map(c => c.url)));
    assert('and reports it went in', /Submitted/.test(sel('formMsg').textContent),
      sel('formMsg').textContent);
  }

  window.close();
}

// ── 7b. The company view, for someone who also works the quarry ─────────────
// Two axes, not one: "everyone's, last 30 days" and "mine, all of them" are
// both answers somebody wants, so the toggle and the window have to compose.
// And the drafts slice stays the caller's own however it is set — an
// unfinished sale of somebody else's is not something anyone here can act on.
async function companyViewTests() {
  console.log('\n[the company view]');

  const { JSDOM } = require('jsdom');
  const calls = [];
  const dom = new JSDOM(read('quarry-sales.html'), {
    runScripts: 'dangerously',
    url: 'https://example.test/quarry-sales.html',
    beforeParse(window) {
      window.localStorage.setItem('fct_token', 'tok');
      // Holds BOTH: submits sales and works Sales Tracking.
      window.localStorage.setItem('fct_user', JSON.stringify({
        username: 'office', companyCode: 'FCT',
        allowedDivisions: ['quarry_sales', 'quarry'],
        divisionRoles: { quarry_sales: 'level1', quarry: 'level3' },
      }));
      window.fetch = async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.startsWith('/api/quarry-sales-lists')) {
          return { ok: true, status: 200, json: async () => ({ locations: [], employees: [], customers: [], products: [], payments: PAYMENT_OPTIONS.slice() }) };
        }
        if (u.includes('status=submitted')) {
          return { ok: true, status: 200, json: async () => ({ entries: [{
            id: '77', status: 'submitted', username: 'strickallen', work_date: '2026-08-26',
            location_name: 'Homer City', employee_name: 'Steve Travis',
            customer_name: 'CASH TAXABLE', product_name: '#3 Limestone',
            tons: 20, price_per_ton: 20, amount_charged: 400, payment: 'Cash',
            submitted_at: '2026-08-26T18:11:00Z',
          }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ entries: [] }) };
      };
      window.confirm = () => true;
      window.scrollTo = () => {};
      window.Element.prototype.scrollIntoView = function () {};
    },
  });
  const { window } = dom, d = window.document, sel = id => d.getElementById(id);
  const settle = () => new Promise(r => setTimeout(r, 30));
  const sent = () => calls.filter(u => u.includes('status=submitted'));
  await settle();

  assert('a quarry user IS offered the company view', sel('whoToggle').hidden === false);
  assert('and it opens on their own sales',
    sel('whoMine').classList.contains('is-on') &&
    sel('entriesTitle').textContent === 'My Recent Sales');
  assert('which is asked for without a scope',
    sent().length === 1 && !sent()[0].includes('scope=all'), JSON.stringify(sent()));

  window.setWho(false);
  await settle();
  assert('switching asks the company-wide question',
    sent().slice(-1)[0].includes('scope=all'), sent().slice(-1)[0]);
  assert('and keeps the window it was on',
    /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/.test(sent().slice(-1)[0]), sent().slice(-1)[0]);
  assert('the drafts slice stays the caller\'s own',
    calls.filter(u => u.includes('status=draft')).every(u => !u.includes('scope=all')),
    JSON.stringify(calls.filter(u => u.includes('status=draft'))));
  assert('the heading says whose it is now',
    sel('entriesTitle').textContent === 'Recent Sales · Everyone', sel('entriesTitle').textContent);
  assert('and the scope line says the drafts are still only yours',
    /everyone \(\+ my drafts\)/.test(sel('entriesScope').textContent), sel('entriesScope').textContent);
  assert('somebody else\'s sale is named with who sent it',
    /strickallen/.test(sel('entriesList').innerHTML), sel('entriesList').textContent.trim().slice(0, 120));
  assert('and is not clickable, so it cannot be opened for editing',
    !/onclick="editEntry/.test(sel('entriesList').innerHTML));

  // The two axes have to compose.
  window.toggleScope();
  await settle();
  const last = sent().slice(-1)[0];
  assert('everyone + all time drops the window but keeps the scope',
    last.includes('scope=all') && !last.includes('from='), last);
  assert('and the scope line reflects both', /All sales · everyone/.test(sel('entriesScope').textContent),
    sel('entriesScope').textContent);

  window.setWho(true);
  await settle();
  const back = sent().slice(-1)[0];
  assert('switching back drops the scope and keeps all-time',
    !back.includes('scope=all') && !back.includes('from='), back);

  window.close();
}

(async () => {
  console.log('Quarry Sales — the form, the endpoint and the grid it lands in');
  parsingTests();
  await spellingTests();
  await injectionTests();
  legacyRowTests();
  guardTests();
  await accessTests();
  await duplicateTests();
  pageTests();
  await browserTests();
  await companyViewTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
