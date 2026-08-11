#!/usr/bin/env node
'use strict';
/**
 * api/fuel-vehicles.js and the monthly balance built on top of it.
 *
 * Run: node scripts/test-fuel-vehicles.js
 * No DB or server required — the neon driver and the auth module are stubbed
 * at require time, and buildReportModel is lifted straight out of
 * fuel-admin.html and run against hand-built entries.
 *
 * The report is the reason the vehicle list exists. A fuel entry carries a
 * truck NUMBER; IFTA wants the vehicle behind it and whether that vehicle is
 * IFTA-qualified at all. Three things have to hold or the month goes out
 * wrong, and none of them announces itself:
 *
 *   - fuel for a truck that ISN'T on the list must be counted separately and
 *     named, never folded silently into a total that then looks complete
 *   - a vehicle not flagged IFTA must stay out of the IFTA gallons — off-road
 *     equipment burns dyed fuel that isn't highway-taxable, and rolling it in
 *     overstates the credit
 *   - a bulk tank's meter runs forward without resetting, so the fills
 *     recorded against it have to account for the whole distance it moved;
 *     what's left over is fuel that left the tank with no entry behind it
 */

const path   = require('path');
const fs     = require('fs');
const Module = require('module');

const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      fuelAdmin: true  };
const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', fuelAdmin: false };

let CURRENT_SQL = null;
let NEXT_AUTH   = ADMIN;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      requireDivision: () => null,
      hasDivisionAccess: (p, area) => (area === 'fuel_admin' ? !!(p && p.fuelAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'fuel-vehicles.js'));
const { normalizeVehicle, normalizeVin } = handler._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── 1. normalizeVehicle ─────────────────────────────────────────────────────
function normalizeTests() {
  console.log('\n[normalizeVehicle]');

  assert('a truck number is required',       normalizeVehicle({}).error != null);
  assert('and a blank one is refused',       normalizeVehicle({ truck_number: '' }).error != null);
  assert('truck 0 is a truck',               normalizeVehicle({ truck_number: '0' }).data.truck_number === 0);
  assert('a negative truck number is refused', normalizeVehicle({ truck_number: '-4' }).error != null);
  assert('everything else may be filled in later',
    normalizeVehicle({ truck_number: '412' }).data.vin === null);

  console.log('\n[VIN]');
  assert('a VIN is upper-cased',       normalizeVin('1fujgldr8csbp1234') === '1FUJGLDR8CSBP1234');
  assert('and stripped of spaces',     normalizeVin(' 1FUJ GLDR8 CSBP1234 ') === '1FUJGLDR8CSBP1234');
  assert('an empty VIN is null',       normalizeVin('   ') === null);
  // Pre-1981 trucks and trailers carry shorter VINs. Refusing those over a
  // formatting rule would keep a real vehicle off the roster.
  assert('a short VIN is accepted',    normalizeVin('CCE33 3B12345') === 'CCE333B12345');

  console.log('\n[IFTA]');
  {
    const { data } = normalizeVehicle({ truck_number: '412', ifta: true, ifta_sticker: 'PA-9981' });
    assert('an IFTA vehicle keeps its sticker', data.ifta === true && data.ifta_sticker === 'PA-9981');
  }
  {
    // Unticking IFTA has to take the sticker with it — a number left behind on
    // a truck no longer running under it would sit in the report exceptions
    // forever, or worse, be filed.
    const { data } = normalizeVehicle({ truck_number: '412', ifta: false, ifta_sticker: 'PA-9981' });
    assert('unticking IFTA clears the sticker', data.ifta === false && data.ifta_sticker === null);
  }
  {
    const { data } = normalizeVehicle({ truck_number: '412' });
    assert('IFTA defaults to off', data.ifta === false);
  }

  console.log('\n[Year]');
  assert('a four-digit year is kept', normalizeVehicle({ truck_number: '1', model_year: '2019' }).data.model_year === 2019);
  assert('a mileage figure in the year box is refused',
    normalizeVehicle({ truck_number: '1', model_year: '132480' }).error != null);
  assert('an absent year is null', normalizeVehicle({ truck_number: '1' }).data.model_year === null);

  console.log('\n[In service]');
  assert('a vehicle is in service by default', normalizeVehicle({ truck_number: '1' }).data.active === true);
  assert('and can be retired',                 normalizeVehicle({ truck_number: '1', active: false }).data.active === false);
}

// ── 2. Routing and permissions ──────────────────────────────────────────────
function makeRes() {
  return {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
}

async function call(method, query, body, auth = ADMIN, rows = []) {
  NEXT_AUTH = auth;
  const seen = [];
  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    seen.push({ q, values });
    if (q.startsWith('SELECT * FROM fuel_vehicles'))  return Promise.resolve(rows);
    if (q.startsWith('SELECT id FROM fuel_vehicles')) return Promise.resolve(rows);
    if (q.startsWith('UPDATE fuel_vehicles') || q.startsWith('INSERT INTO fuel_vehicles')) {
      return Promise.resolve([Object.assign({ id: 1, company_code: 'FCT' }, body || {})]);
    }
    return Promise.resolve([]);
  };
  const res = makeRes();
  await handler({ method, query: query || {}, body: body || {} }, res);
  return { res, seen };
}

async function routingTests() {
  console.log('\n[Access]');
  {
    const { res } = await call('GET', {}, null, FIELD);
    assert('a field user cannot read the vehicle list', res.statusCode === 403);
  }
  {
    const { res } = await call('POST', {}, { truck_number: '412' }, FIELD);
    assert('nor add a vehicle', res.statusCode === 403);
  }
  {
    const { res } = await call('GET', {}, null, ADMIN);
    assert('an admin can read it', res.statusCode === 200);
  }

  console.log('\n[GET]');
  {
    const { seen } = await call('GET', {}, null, ADMIN);
    const list = seen.find(s => s.q.startsWith('SELECT * FROM fuel_vehicles'));
    assert('retired trucks are hidden by default', list.values.includes(false), JSON.stringify(list.values));
  }
  {
    const { seen } = await call('GET', { include_inactive: '1' }, null, ADMIN);
    const list = seen.find(s => s.q.startsWith('SELECT * FROM fuel_vehicles'));
    assert('?include_inactive=1 shows them', list.values.includes(true), JSON.stringify(list.values));
  }

  console.log('\n[POST]');
  {
    const { res } = await call('POST', {}, { vin: 'ABC' }, ADMIN);
    assert('a vehicle with no truck number is refused', res.statusCode === 400);
  }
  {
    // Two admins adding the same truck must not produce two rows — every
    // gallon it burned would be counted twice in the by-vehicle totals.
    const { seen } = await call('POST', {}, { truck_number: '412' }, ADMIN);
    const ins = seen.find(s => s.q.startsWith('INSERT INTO fuel_vehicles'));
    assert('a create folds into the existing truck number',
      /ON CONFLICT \(company_code, truck_number\) DO UPDATE/.test(ins.q), ins.q.slice(0, 120));
  }
  {
    // Editing a row onto a number another row already holds is the one case
    // the upsert can't resolve — it would silently merge two trucks.
    const { res } = await call('POST', {}, { id: 5, truck_number: '412' }, ADMIN, [{ id: 9 }]);
    assert('moving a vehicle onto a taken truck number is refused', res.statusCode === 409,
      JSON.stringify(res.body));
  }

  console.log('\n[DELETE]');
  {
    const { res } = await call('DELETE', {}, null, ADMIN);
    assert('delete with no id is a 400', res.statusCode === 400);
  }
  {
    const { res } = await call('DELETE', { id: '1' }, null, ADMIN, []);
    assert('deleting a vehicle that is gone is a 404', res.statusCode === 404);
  }
}

// ── 3. The report model, lifted out of fuel-admin.html ──────────────────────
function liftFn(src, name, file) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${file} no longer defines ${name}()`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${file}: could not find the end of ${name}()`);
}

function loadBuildReportModel(filters) {
  const file = 'fuel-admin.html';
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  return new Function('FILTERS', `
    function val(id) { return FILTERS[id] || ''; }
    ${liftFn(src, 'gallonsFromMeters', file)}
    ${liftFn(src, 'meterFlagged',      file)}
    ${liftFn(src, 'n2',                file)}
    ${liftFn(src, 'n1',                file)}
    ${liftFn(src, 'buildReportModel',  file)}
    return buildReportModel;
  `)(filters);
}

function entry(o) {
  return Object.assign({
    id: String(Math.random()).slice(2), status: 'approved',
    work_date: '2026-07-15', employee_username: 'strickallen',
    fuel_card: 'Wex', fuel_type: 'Diesel',
    gallons: 0, mileage: null, truck_number: null,
    beginning_meter: 0, ending_meter: 0,
    fueling_site: 'Yard', city_fueled: 'Punxsutawney', state: 'PA', tank_number: null,
  }, o);
}

function reportTests() {
  console.log('\n[The monthly balance]');
  const build = loadBuildReportModel({ 'flt-from': '2026-07-01', 'flt-to': '2026-07-31', 'rep-status': 'approved' });

  const VEHICLES = [
    { id: '1', truck_number: 412, vin: '1FUJGLDR8CSBP1234', model_year: 2019, make: 'Freightliner',
      ifta: true,  ifta_sticker: 'PA-9981', active: true },
    // Off-road equipment: real truck, real fuel, deliberately NOT IFTA.
    { id: '2', truck_number: 77,  vin: 'CAT0D6TXYZ12345', model_year: 2015, make: 'Caterpillar',
      ifta: false, ifta_sticker: null, active: true },
  ];

  const ENTRIES = [
    entry({ truck_number: 412, state: 'PA', gallons: 100, mileage: 100000, fuel_card: 'Wex' }),
    entry({ truck_number: 412, state: 'OH', gallons: 50,  mileage: 100500, fuel_card: 'Wex' }),
    // Two bulk-tank fills whose meters leave a 50-gallon hole between them.
    entry({ truck_number: 77, state: 'PA', fuel_type: 'Off Road Diesel', fuel_card: 'Bulk Fuel – No card',
            tank_number: 2, beginning_meter: 1000, ending_meter: 1200, gallons: 200 }),
    entry({ truck_number: 77, state: 'PA', fuel_type: 'Off Road Diesel', fuel_card: 'Bulk Fuel – No card',
            tank_number: 2, beginning_meter: 1250, ending_meter: 1300, gallons: 50 }),
    // A truck nobody put on the vehicle list.
    entry({ truck_number: 999, state: 'PA', gallons: 30, fuel_card: 'Guttman' }),
  ];

  const m = build(ENTRIES, VEHICLES);

  console.log('\n  totals');
  assert('every fill-up is counted', m.count === 5);
  assert('gallons add up', Number(m.gallons.toFixed(2)) === 430, String(m.gallons));
  assert('only the IFTA truck contributes IFTA gallons', m.iftaGallons === 150, String(m.iftaGallons));
  assert('off-road and unmatched fuel stays out of it', m.nonIftaGallons === 280, String(m.nonIftaGallons));
  assert('fuel for an unlisted truck is counted apart', m.unmatchedGallons === 30, String(m.unmatchedGallons));

  console.log('\n  by state');
  assert('PA totals every fill bought there', m.byState.get('PA').gallons === 380, String(m.byState.get('PA').gallons));
  assert('OH is its own line',                m.byState.get('OH').gallons === 50);
  assert('the PA IFTA column counts only the IFTA truck', m.byState.get('PA').ifta === 100,
    String(m.byState.get('PA').ifta));
  assert('and OH likewise',                   m.byState.get('OH').ifta === 50);

  console.log('\n  by vehicle');
  {
    const r = m.byVehicle.get('412');
    assert('truck 412 is matched to its vehicle', r.vehicle && r.vehicle.vin === '1FUJGLDR8CSBP1234');
    assert('with both of its fills',             r.entries === 2 && r.gallons === 150);
    assert('the odometer span is max minus min', r.maxMileage - r.minMileage === 500);
    assert('and it lists every state it fuelled in',
      [...r.states].sort().join(',') === 'OH,PA', [...r.states].join(','));
  }
  {
    const r = m.byVehicle.get('999');
    assert('an unlisted truck still gets a row', r.entries === 1 && r.gallons === 30);
    assert('but no vehicle behind it',          r.vehicle === null);
  }

  console.log('\n  tank balance');
  {
    const t = m.tanks.get('2');
    assert('both metered fills land on the tank', t.fills === 2);
    assert('gallons are summed off the meters',   t.gallons === 250, String(t.gallons));
    assert('the span is the whole meter travel',  t.span === 300, String(t.span));
    assert('and the difference is the missing fuel', t.difference === 50, String(t.difference));
    assert('so the tank does not balance',        t.balanced === false);
  }
  {
    // A card purchase never touched a tank. Counting one would make every
    // tank look short by exactly the fuel that was never in it.
    assert('card purchases are kept off the tank balance', m.tanks.size === 1, String(m.tanks.size));
  }

  console.log('\n  by card and type');
  assert('Wex totals its two fills',   m.byCard.get('Wex').gallons === 150);
  assert('the bulk card totals its own', m.byCard.get('Bulk Fuel – No card').gallons === 250);
  assert('Guttman is on its own line', m.byCard.get('Guttman').gallons === 30);
  assert('diesel and off-road are separate',
    m.byType.get('Diesel').gallons === 180 && m.byType.get('Off Road Diesel').gallons === 250,
    `${m.byType.get('Diesel').gallons} / ${m.byType.get('Off Road Diesel').gallons}`);

  console.log('\n  exceptions');
  const kinds = m.exceptions.map(x => x.kind).join(' | ');
  assert('the unlisted truck is named', /Truck 999 not on the vehicle list/.test(kinds), kinds);
  assert('so is the tank that is out',  /Tank 2 is out by 50\.00 gal/.test(kinds), kinds);
  assert('and nothing else is raised',  m.exceptions.length === 2, kinds);

  console.log('\n  a clean month raises nothing');
  {
    const clean = build(
      [entry({ truck_number: 412, state: 'PA', gallons: 100, mileage: 100000 })],
      VEHICLES);
    assert('no exceptions when everything matches', clean.exceptions.length === 0,
      clean.exceptions.map(x => x.kind).join(' | '));
    assert('and the IFTA total is the whole of it', clean.iftaGallons === 100);
  }

  console.log('\n  an IFTA truck with no sticker');
  {
    const noSticker = build(
      [entry({ truck_number: 55, state: 'PA', gallons: 10 })],
      [{ id: '3', truck_number: 55, vin: null, model_year: null, make: null,
         ifta: true, ifta_sticker: null, active: true }]);
    assert('is raised — the filing needs the number',
      noSticker.exceptions.some(x => /Truck 55 has no IFTA sticker/.test(x.kind)),
      noSticker.exceptions.map(x => x.kind).join(' | '));
  }
  {
    // …but only when it actually bought fuel in the range. Flagging every
    // stickerless truck in the yard would bury the ones that matter.
    const idle = build(
      [entry({ truck_number: 412, state: 'PA', gallons: 10 })],
      VEHICLES.concat([{ id: '3', truck_number: 55, ifta: true, ifta_sticker: null, active: true }]));
    assert('a stickerless truck that bought nothing is not raised',
      idle.exceptions.length === 0, idle.exceptions.map(x => x.kind).join(' | '));
  }

  console.log('\n  a retired truck still reports');
  {
    // A truck taken out of service in March still bought fuel in February.
    const retired = build(
      [entry({ truck_number: 412, state: 'PA', gallons: 40 })],
      [Object.assign({}, VEHICLES[0], { active: false })]);
    assert('its fuel is still attributed to it', retired.byVehicle.get('412').vehicle !== null);
    assert('and still counts as IFTA',           retired.iftaGallons === 40);
    assert('with no exception raised',           retired.exceptions.length === 0,
      retired.exceptions.map(x => x.kind).join(' | '));
  }

  console.log('\n  a backwards meter is surfaced, not silently dropped');
  {
    const rolled = build(
      [entry({ truck_number: 412, state: 'PA', gallons: 41.2, tank_number: 3,
               beginning_meter: 99000, ending_meter: 120 })],
      VEHICLES);
    assert('the reported gallons still count', rolled.gallons === 41.2);
    assert('the fill stays off the tank balance', rolled.tanks.size === 0);
    assert('and the reading is raised for a look',
      rolled.exceptions.some(x => /ending meter below the beginning/.test(x.kind)),
      rolled.exceptions.map(x => x.kind).join(' | '));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  normalizeTests();
  await routingTests();
  reportTests();

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
