#!/usr/bin/env node
'use strict';
/**
 * GET /api/truck-division?lists=1 — the dropdown rosters on their own.
 *
 * Run: node scripts/test-truck-division-lists.js
 *
 * Payroll's approve modal offers the trucking office's own unit names when it
 * asks for a haul's unit, so that what payroll types is a unit the office
 * recognises: the Truck Tracking tab looks a row's unit up BY NAME to show its
 * number, so a near-miss ("Truck 1000", a stray space) lands on the row looking
 * fine in Payroll and unrecognised in Trucking. This branch exists so filling
 * that dropdown does not mean shipping the whole tracking blob — thousands of
 * rows — to a page that wants a list of names.
 *
 * Verifies:
 *   - it answers with lists ONLY, never entries,
 *   - units keep their {name, number} shape from the normalized table,
 *   - the blob wins when it holds anything (the trucking page writes it
 *     synchronously; the tables are synced fire-and-forget and lag),
 *   - an empty blob falls back to the tables rather than answering nothing,
 *   - the legacy unscoped blob key is still read,
 *   - the per-customer haul rates ride along, whichever source the rosters came
 *     from — payroll fills a haul's fee in from them, and they live only in the
 *     blob (dropdown_lists stores a customer as a bare name),
 *   - and the full GET is left alone by the new branch.
 *
 * No DB or server required.
 */

const Module = require('module');

let AUTH = { companyCode: 'FCT', userId: 42, username: 'office' };
let CURRENT_SQL = () => Promise.resolve([]);

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => (...a) => CURRENT_SQL(...a) };
  if (request === './lib/auth') {
    return { requireAuth: () => AUTH, requireDivision: () => null, hasDivisionAccess: () => true };
  }
  return origLoad.apply(this, arguments);
};

const handler = require('../api/truck-division.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// Route on the query text, the way the other mocked suites here do. `state`
// decides what each backing store holds for a given case.
function install(state) {
  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT value FROM app_data')) {
      let key = values[0];
      if (key === undefined) { const m = q.match(/key = '([^']*)'/); key = m ? m[1] : undefined; }
      const v = state.appData[key];
      return Promise.resolve(v === undefined ? [] : [{ value: v }]);
    }
    if (q.includes('FROM dropdown_lists')) {
      if (q.includes('truck_drivers'))   return Promise.resolve((state.drivers   || []).map(v => ({ value: v })));
      if (q.includes('truck_customers')) return Promise.resolve((state.customers || []).map(v => ({ value: v })));
      return Promise.resolve([]);
    }
    if (q.includes('FROM truck_division_units')) {
      return Promise.resolve(state.unitRows || []);
    }
    if (q.includes('FROM truck_division_entries')) {
      return Promise.resolve(state.entryRows || []);
    }
    // The full GET kicks off a fire-and-forget re-sync when the normalized
    // tables look behind the blob. It is not what these cases are about, and it
    // swallows its own errors, but letting it throw here would print a scary
    // line into an otherwise clean run.
    if (/^(INSERT|UPDATE|DELETE)\b/.test(q)) return Promise.resolve([]);
    throw new Error('Unexpected query in mock: ' + q.slice(0, 90));
  };
}

async function get(query) {
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method: 'GET', query, body: {} }, res);
  return res;
}

const UNIT_ROWS = [
  { name: '2773', number: '17' },
  { name: '635',  number: '04' },
  { name: '1000', number: '21' },
];

(async () => {
  console.log('GET /api/truck-division?lists=1\n');

  console.log('[the rosters, without the tracking rows]');
  {
    install({ appData: {}, unitRows: UNIT_ROWS, drivers: ['Barr, Mike'], customers: ['CNX'] });
    const r = await get({ lists: '1' });
    assert('answers 200', r.statusCode === 200, String(r.statusCode));
    assert('with a lists object', !!(r.body && r.body.lists), JSON.stringify(r.body));
    // The whole point of the branch: payroll must not have to download the
    // tracking blob to populate one dropdown.
    assert('and no entries at all', !('entries' in (r.body || {})), Object.keys(r.body || {}).join(','));
    assert('units keep their name + number',
      JSON.stringify(r.body.lists.units) === JSON.stringify(UNIT_ROWS), JSON.stringify(r.body.lists.units));
    assert('drivers come along', r.body.lists.drivers[0] === 'Barr, Mike', JSON.stringify(r.body.lists.drivers));
    assert('customers too', r.body.lists.customers[0] === 'CNX', JSON.stringify(r.body.lists.customers));
  }

  console.log('\n[the blob wins while the tables catch up]');
  {
    // trucking.html PUTs the blob synchronously and the normalized tables are
    // synced fire-and-forget, so a unit added a moment ago is in one and not
    // the other. Offering the stale answer would hide the truck payroll is
    // most likely to be asked about — the one just added.
    install({
      appData: {
        'FCT:fct_truck_division_lists': {
          drivers: ['Boring, Jamey'], customers: ['Kinkead'],
          units: [{ name: '1000', number: '21' }, { name: 'NEW-TRUCK', number: '99' }],
        },
      },
      unitRows: UNIT_ROWS, drivers: ['Barr, Mike'], customers: ['CNX'],
    });
    const r = await get({ lists: '1' });
    assert('a unit only the blob knows is offered',
      r.body.lists.units.some(u => u.name === 'NEW-TRUCK'), JSON.stringify(r.body.lists.units));
    assert('and the table\'s own answer is not mixed in',
      !r.body.lists.units.some(u => u.name === '2773'), JSON.stringify(r.body.lists.units));
    assert('drivers follow the same source', r.body.lists.drivers[0] === 'Boring, Jamey',
      JSON.stringify(r.body.lists.drivers));
  }

  console.log('\n[an empty blob is not an answer]');
  {
    // A blob that exists but holds nothing must not shadow a perfectly good
    // roster in the tables — that would leave the dropdown empty for good.
    install({
      appData: { 'FCT:fct_truck_division_lists': { drivers: [], customers: [], units: [] } },
      unitRows: UNIT_ROWS, drivers: ['Barr, Mike'], customers: ['CNX'],
    });
    const r = await get({ lists: '1' });
    assert('it falls back to the tables', r.body.lists.units.length === 3, JSON.stringify(r.body.lists.units));
  }

  console.log('\n[the customer rates ride along]');
  {
    // What each company is billed per hour, set in the tab's Manage Lists.
    // Payroll pre-fills a haul's fee from it, so it has to come down the same
    // cheap route as the rosters — the alternative is payroll downloading every
    // tracking row to learn one number.
    install({
      appData: {
        'FCT:fct_truck_division_lists': {
          drivers: ['Boring, Jamey'], customers: ['Kinkead'],
          units: [{ name: '1000', number: '21' }],
          rates: { Kinkead: '121', 'Derry Stone': '98.50' },
        },
      },
      unitRows: UNIT_ROWS, drivers: [], customers: [],
    });
    const r = await get({ lists: '1' });
    assert('a rate comes back with the roster it belongs to',
      r.body.lists.rates && r.body.lists.rates.Kinkead === '121', JSON.stringify(r.body.lists.rates));
    assert('and so does every other one', r.body.lists.rates['Derry Stone'] === '98.50',
      JSON.stringify(r.body.lists.rates));
  }
  {
    // The case the fallback makes tricky: the blob's ROSTERS are empty, so the
    // rosters come from the tables — but the rates are in the blob or nowhere,
    // because the tables store a customer as a bare name. Reading them off the
    // chosen source rather than off the blob would drop them silently here.
    install({
      appData: {
        'FCT:fct_truck_division_lists': { drivers: [], customers: [], units: [], rates: { Kinkead: '121' } },
      },
      unitRows: UNIT_ROWS, drivers: ['Barr, Mike'], customers: ['CNX'],
    });
    const r = await get({ lists: '1' });
    assert('rates survive a fallback to the tables',
      r.body.lists.rates.Kinkead === '121', JSON.stringify(r.body.lists));
    assert('while the rosters still come from them', r.body.lists.units.length === 3,
      JSON.stringify(r.body.lists.units));
  }
  {
    // A rate that is not a price must not reach a box that reads as money.
    install({
      appData: {
        'FCT:fct_truck_division_lists': {
          drivers: [], customers: [], units: [{ name: '1000', number: '21' }],
          rates: { Kinkead: '', CNX: 'call us', '  ': '99', ' Derry Stone ': ' 98.50 ' },
        },
      },
      unitRows: [], drivers: [], customers: [],
    });
    const r = await get({ lists: '1' });
    assert('a blank rate is dropped', !('Kinkead' in r.body.lists.rates), JSON.stringify(r.body.lists.rates));
    assert('so is a word', !('CNX' in r.body.lists.rates), JSON.stringify(r.body.lists.rates));
    assert('so is a nameless one', !('' in r.body.lists.rates), JSON.stringify(r.body.lists.rates));
    assert('and a good one is trimmed on the way out', r.body.lists.rates['Derry Stone'] === '98.50',
      JSON.stringify(r.body.lists.rates));
  }
  {
    install({ appData: {}, unitRows: UNIT_ROWS, drivers: [], customers: [] });
    const r = await get({ lists: '1' });
    // An absent key would read as "not supported by this server" at the far end;
    // an empty object reads as "this company prices nothing", which is the truth.
    assert('a company with no rates gets an empty set, never a missing key',
      r.body.lists.rates && typeof r.body.lists.rates === 'object'
      && Object.keys(r.body.lists.rates).length === 0, JSON.stringify(r.body.lists));
  }

  console.log('\n[legacy unscoped key still readable]');
  {
    // Companies that predate the company-scoped keys keep their lists under the
    // bare key; the full GET reads it, so this must too.
    install({
      appData: { 'fct_truck_division_lists': {
        drivers: [], customers: [], units: [{ name: 'OLD-1', number: '1' }], rates: { Kinkead: '121' },
      } },
      unitRows: [], drivers: [], customers: [],
    });
    const r = await get({ lists: '1' });
    assert('the legacy roster comes back',
      r.body.lists.units.length === 1 && r.body.lists.units[0].name === 'OLD-1',
      JSON.stringify(r.body.lists.units));
    assert('and its rates with it', r.body.lists.rates.Kinkead === '121',
      JSON.stringify(r.body.lists.rates));
  }

  console.log('\n[nothing anywhere]');
  {
    install({ appData: {}, unitRows: [], drivers: [], customers: [] });
    const r = await get({ lists: '1' });
    assert('answers with empty lists, not an error', r.statusCode === 200
      && Array.isArray(r.body.lists.units) && r.body.lists.units.length === 0, JSON.stringify(r.body));
  }

  console.log('\n[the full GET is untouched]');
  {
    // The new branch sits above the existing one; it must only catch ?lists=1.
    install({
      appData: { 'FCT:fct_truck_division': [{ id: 'tst-1-9', unit: '1000' }] },
      unitRows: UNIT_ROWS, drivers: [], customers: [],
    });
    const r = await get({});
    assert('entries still come back with the lists',
      Array.isArray(r.body.entries) && r.body.entries.length === 1 && !!r.body.lists,
      JSON.stringify(r.body).slice(0, 120));
    // Any other truthy value is not the opt-in — only '1' is.
    const other = await get({ lists: 'true' });
    assert('?lists=true is not the opt-in', Array.isArray(other.body.entries),
      JSON.stringify(other.body).slice(0, 90));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
