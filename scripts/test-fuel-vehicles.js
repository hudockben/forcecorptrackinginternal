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

function liftConst(src, name, file) {
  const re = new RegExp(`^\\s{0,6}const ${name} = ([\\s\\S]*?);\\n`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`${file} no longer declares ${name}`);
  return m[0];
}

// Everything the report is built out of, lifted whole from the page so the
// tests exercise the code that actually ships rather than a copy of it.
function loadReportFns(filters) {
  const file = 'fuel-admin.html';
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  return new Function('FILTERS', `
    function val(id) { return FILTERS[id] || ''; }
    let vmSort = { col: 'truck', dir: 1 };
    ${liftConst(src, 'FUEL_CARDS',        file)}
    ${liftConst(src, 'CARD_COLUMN_ORDER', file)}
    ${liftFn(src, 'gallonsFromMeters',  file)}
    ${liftFn(src, 'meterFlagged',       file)}
    ${liftFn(src, 'n2',                 file)}
    ${liftFn(src, 'n1',                 file)}
    ${liftFn(src, 'monthOf',            file)}
    ${liftFn(src, 'buildReportModel',   file)}
    ${liftFn(src, 'vehicleMonthRows',   file)}
    ${liftConst(src, 'TOTAL_LABEL',     file)}
    ${liftFn(src, 'isTotalLabel',       file)}
    ${liftFn(src, 'delimiterFor',       file)}
    ${liftFn(src, 'parseStatement',     file)}
    ${liftFn(src, 'matchStatement',     file)}
    return {
      buildReportModel, vehicleMonthRows, parseStatement, matchStatement, monthOf,
      setSort: (col, dir) => { vmSort = { col, dir }; },
    };
  `)(filters);
}

function loadBuildReportModel(filters) {
  return loadReportFns(filters).buildReportModel;
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
    // byVehicle carries whole-range totals and nothing else — the states,
    // fuel types and odometer span it used to accumulate belong to the
    // by-month table that replaced its report block, and are asserted there.
    const r = m.byVehicle.get('412');
    assert('truck 412 is matched to its vehicle', r.vehicle && r.vehicle.vin === '1FUJGLDR8CSBP1234');
    assert('with both of its fills',             r.entries === 2 && r.gallons === 150);
    assert('and carries nothing the report no longer reads',
      r.states === undefined && r.types === undefined && r.maxMileage === undefined,
      JSON.stringify(Object.keys(r)));

    const vm = m.byVehicleMonth.get('412|2026-07');
    assert('the by-month row has the odometer span', vm.maxMileage - vm.minMileage === 500);
    assert('and lists every state it fuelled in',
      [...vm.states].sort().join(',') === 'OH,PA', [...vm.states].join(','));
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

// ── 4. Vehicle × month, and matching a statement to it ──────────────────────
const FILTERS = { 'flt-from': '2026-06-01', 'flt-to': '2026-07-31', 'rep-status': 'approved' };

const FLEET = [
  { id: '1', truck_number: 412, vin: '1FUJGLDR8CSBP1234', model_year: 2019, make: 'Freightliner',
    ifta: true, ifta_sticker: 'PA-9981', active: true },
  { id: '2', truck_number: 77,  vin: 'CAT0D6TXYZ12345', model_year: 2015, make: 'Caterpillar',
    ifta: false, ifta_sticker: null, active: true },
];

// Two months, two accounts, one truck on both — the shape the office
// actually balances.
const FLEET_ENTRIES = [
  entry({ work_date: '2026-06-10', truck_number: 412, fuel_card: 'Guttman', gallons: 100, mileage: 100000 }),
  entry({ work_date: '2026-06-24', truck_number: 412, fuel_card: 'Wex',     gallons: 60,  mileage: 100400 }),
  entry({ work_date: '2026-07-05', truck_number: 412, fuel_card: 'Guttman', gallons: 120, mileage: 101000 }),
  entry({ work_date: '2026-07-19', truck_number: 412, fuel_card: 'Guttman', gallons: 80,  mileage: 101600 }),
  entry({ work_date: '2026-07-08', truck_number: 77,  fuel_card: 'Wex',     gallons: 45 }),
  entry({ work_date: '2026-07-21', truck_number: 999, fuel_card: 'Guttman', gallons: 33 }),
];

function vehicleMonthTests() {
  console.log('\n[By vehicle and month]');
  const fns = loadReportFns(FILTERS);
  const m   = fns.buildReportModel(FLEET_ENTRIES, FLEET);

  console.log('\n  the month key');
  assert('is read off the string, not through a Date',
    fns.monthOf('2026-07-01') === '2026-07', fns.monthOf('2026-07-01'));
  assert('and an entry with no date is its own bucket',
    fns.monthOf('') === '(no date)');

  console.log('\n  rows');
  assert('one row per truck per month', m.byVehicleMonth.size === 4, String(m.byVehicleMonth.size));
  {
    const june = m.byVehicleMonth.get('412|2026-06');
    const july = m.byVehicleMonth.get('412|2026-07');
    assert('truck 412 has a June row and a July row', Boolean(june && july));
    assert("June's two fills are kept apart from July's",
      june.entries === 2 && july.entries === 2);
    assert('and their gallons do not run together',
      june.gallons === 160 && july.gallons === 200,
      `${june.gallons} / ${july.gallons}`);
  }

  console.log('\n  the card split — the whole point of the block');
  {
    const july = m.byVehicleMonth.get('412|2026-07');
    assert('July Guttman is its own figure', july.byCard.get('Guttman') === 200,
      String(july.byCard.get('Guttman')));
    assert('and July has nothing on Wex',    july.byCard.get('Wex') === undefined);
    const june = m.byVehicleMonth.get('412|2026-06');
    assert('June splits across both accounts',
      june.byCard.get('Guttman') === 100 && june.byCard.get('Wex') === 60,
      `${june.byCard.get('Guttman')} / ${june.byCard.get('Wex')}`);
  }
  {
    // Column order has to be stable, or the sheet reshuffles month to month.
    assert('Guttman and Wex lead the card columns',
      m.cardsPresent[0] === 'Guttman' && m.cardsPresent[1] === 'Wex',
      m.cardsPresent.join(', '));
  }

  console.log('\n  drill-down');
  {
    const july = m.byVehicleMonth.get('412|2026-07');
    assert('the fills behind a cell are kept with it', july.fills.length === 2);
    assert('and they are the right ones',
      july.fills.every(e => e.work_date.startsWith('2026-07') && e.truck_number === 412));
    assert('the odometer span is within the month only',
      july.maxMileage - july.minMileage === 600, String(july.maxMileage - july.minMileage));
  }

  console.log('\n  sorting');
  {
    fns.setSort('truck', 1);
    const byTruck = fns.vehicleMonthRows(m).map(r => `${r.truck}|${r.month}`);
    assert('truck order puts 77 before 412 before 999',
      byTruck[0].startsWith('77|') && byTruck[byTruck.length - 1].startsWith('999|'),
      byTruck.join(' '));

    fns.setSort('gallons', -1);
    const byGal = fns.vehicleMonthRows(m);
    assert('gallons descending leads with the biggest', byGal[0].gallons === 200, String(byGal[0].gallons));

    fns.setSort('Guttman', -1);
    const byCard = fns.vehicleMonthRows(m);
    assert('a card column sorts on that card alone',
      byCard[0].byCard.get('Guttman') === 200, String(byCard[0].byCard.get('Guttman')));

    // A fill-up with no truck number can't be balanced against anything, so
    // it belongs at the bottom whichever way the table is sorted.
    const withOrphan = fns.buildReportModel(
      FLEET_ENTRIES.concat([entry({ work_date: '2026-07-02', truck_number: null, gallons: 500 })]), FLEET);
    for (const dir of [1, -1]) {
      fns.setSort('truck', dir);
      const rows = fns.vehicleMonthRows(withOrphan);
      assert(`a row with no truck number sorts last (dir ${dir})`,
        rows[rows.length - 1].truck == null, String(rows[rows.length - 1].truck));
    }
    fns.setSort('truck', 1);
  }
}

function statementTests() {
  console.log('\n[Reading a pasted statement]');
  const fns   = loadReportFns(FILTERS);
  const known = new Set([412, 77]);
  const P = (text, pick = 'last') => fns.parseStatement(text, pick, known);

  {
    const r = P('412\t320.50\n77\t95.25');
    assert('a plain two-column paste reads',
      r.byTruck.get(412) === 320.5 && r.byTruck.get(77) === 95.25,
      JSON.stringify([...r.byTruck]));
  }
  {
    const r = P('412 320.50\n77 95.25');
    assert('so does one separated by spaces', r.byTruck.get(412) === 320.5);
  }
  {
    // Transaction-level exports are the common case — one line per fill-up.
    const r = P('412,07/15/2026,Diesel,84.50\n412,07/22/2026,Diesel,90.00');
    assert('lines for the same truck are added up', r.byTruck.get(412) === 174.5,
      String(r.byTruck.get(412)));
  }
  {
    // A date in the first column would be read as a truck number if the
    // parser went by position. Recognising a truck we know is what stops it.
    const r = P('07/15/2026,412,84.50');
    assert('a leading date column does not become the truck number',
      r.byTruck.size === 1 && r.byTruck.get(412) === 84.5, JSON.stringify([...r.byTruck]));
  }
  {
    const r = P('Vehicle,Gallons\n412,84.50\nTotal,84.50');
    assert('a header line is skipped', r.byTruck.get(412) === 84.5, JSON.stringify([...r.byTruck]));
    assert('the header and the total are both reported, not silently dropped',
      r.skipped.length === 2, JSON.stringify(r.skipped));
  }
  {
    // The one line that must never be read as data: a total whose figure
    // happens to be a truck number we recognise would otherwise land on that
    // truck and double it, and the row would look entirely ordinary.
    //
    // Every shape below was found slipping past a guard anchored to the start
    // of the raw line — statements pluralise the label, quote it, and put it
    // in a later column, and none of those start with "total".
    const totals = [
      ['Total,412.00',                    'a plain total'],
      ['Grand Total,412.00',              'a grand total'],
      ['Totals,412,1523.40',              'a pluralised label'],
      ['"Total","412","1523.40"',         'a quoted label — the line starts with a quote'],
      [',,,Total,412,1523.40',            'a label in a later column'],
      ['GRAND TOTAL\t412\t1523.40',       'shouted, and tab separated'],
      ['Subtotal;412;1523.40',            'a subtotal, semicolon separated'],
      ['Report Total,412,1523.40',        'a report total'],
      ['Total:,412,1523.40',              'a label with a trailing colon'],
    ];
    for (const [line, what] of totals) {
      const r = P('412,84.50\n' + line);
      assert(`${what} is not mistaken for a truck`,
        r.byTruck.size === 1 && r.byTruck.get(412) === 84.5,
        JSON.stringify([...r.byTruck]));
    }
    // …and the cost of guarding this way: a fuel station actually named
    // "Total" would be skipped. Only an EXACT cell match counts, so a
    // merchant column keeps working, which is the case that would really
    // happen.
    const merchant = P('412,TOTAL PETROLEUM #123,90.00');
    assert('a merchant whose name merely contains "total" is still data',
      merchant.byTruck.get(412) === 90, JSON.stringify([...merchant.byTruck]));
  }
  {
    // Gallons then dollars. "Last number" gets it wrong, which is exactly why
    // the picker is there — and the fix has to be one dropdown, not a re-export.
    const line = '412,84.50,312.45';
    assert('the last number is taken by default', P(line).byTruck.get(412) === 312.45);
    assert('and the picker moves it to the right column',
      P(line, '1').byTruck.get(412) === 84.5, String(P(line, '1').byTruck.get(412)));
  }
  {
    // The picker says "the Nth number AFTER the truck". Counting through a
    // list that still held the numbers before it meant a leading invoice
    // column WAS the answer to "the 1st number after the truck" — truck 412
    // credited with 55,012 gallons off a line that says 84.50.
    const line = '55012,412,3.99,84.50';
    assert('a leading invoice column is not "the 1st number after the truck"',
      P(line, '1').byTruck.get(412) === 3.99, String(P(line, '1').byTruck.get(412)));
    assert('the 2nd after the truck is the one after that',
      P(line, '2').byTruck.get(412) === 84.5, String(P(line, '2').byTruck.get(412)));
    assert('and the last number on the line is still the last',
      P(line).byTruck.get(412) === 84.5, String(P(line).byTruck.get(412)));
  }
  {
    // A number we only GUESSED at is capped at six digits. The things that
    // get guessed at wrongly — a date exported as 20260715, an invoice, a
    // card number — are all longer, and each one invents two findings from
    // one real fill-up: a phantom truck unbilled, and the real truck missing.
    const dated = P('20260715,999,84.50');
    assert('a numeric date column is not taken for a truck',
      dated.byTruck.get(999) === 84.5 && !dated.byTruck.has(20260715),
      JSON.stringify([...dated.byTruck]));
    // A truck already on the roster is recognised whatever its size, so the
    // cap only ever applies to a guess.
    // Called directly rather than through P(), which pins the known set.
    const bigKnown = fns.parseStatement('9000001\t84.50', 'last', new Set([9000001]));
    assert('but a rostered truck above the cap is still recognised',
      bigKnown.byTruck.get(9000001) === 84.5, JSON.stringify([...bigKnown.byTruck]));
  }
  {
    const r = P('412,"1,234.50"');
    assert('a quoted thousands separator survives the split',
      r.byTruck.get(412) === 1234.5, String(r.byTruck.get(412)));
  }
  {
    // A tab-separated export never quotes anything, so the comma in its
    // gallons column is a thousands separator and nothing else. Splitting on
    // commas as well turned 1,234.50 into 234.50 — the truck under-reported
    // by exactly a thousand gallons, with the line counted as read.
    const tsv = P('412\t1,234.50');
    assert('an unquoted thousands separator survives a tab-separated line',
      tsv.byTruck.get(412) === 1234.5, String(tsv.byTruck.get(412)));
    const semi = P('412;1,234.50');
    assert('and a semicolon-separated one', semi.byTruck.get(412) === 1234.5,
      String(semi.byTruck.get(412)));
    const pipe = P('412|1,234.50');
    assert('and a pipe-separated one', pipe.byTruck.get(412) === 1234.5,
      String(pipe.byTruck.get(412)));
    // On a comma-separated line an unquoted thousands separator is genuinely
    // ambiguous — "412,500" is either truck 412 taking 500 gallons or a
    // single figure — so the comma stays a column break there.
    const csv = P('412,500');
    assert('a comma-separated line still treats the comma as a column break',
      csv.byTruck.get(412) === 500, String(csv.byTruck.get(412)));
  }
  {
    // A fuel-card number is thirteen to nineteen digits. Taken for a truck it
    // overflows the INTEGER column and fails the INSERT — after the save has
    // cleared the previous lines.
    const r = P('7001234567890,500,84.50');
    assert('a card number is not taken for a truck number',
      r.byTruck.has(500) && !r.byTruck.has(7001234567890),
      JSON.stringify([...r.byTruck]));
    const only = P('7001234567890,84.50');
    assert('and a line offering nothing else is skipped, not stored',
      only.byTruck.size === 0 && only.skipped.length === 1,
      JSON.stringify([...only.byTruck]));
  }
  {
    const r = P('412,$312.45\n77,84.5 gal');
    assert('currency and unit suffixes are stripped',
      r.byTruck.get(412) === 312.45 && r.byTruck.get(77) === 84.5,
      JSON.stringify([...r.byTruck]));
  }
  {
    // A truck missing from the roster still has to match — that is the
    // condition the report is meant to surface, not swallow.
    const r = P('999\t50');
    assert('an unknown truck number still reads', r.byTruck.get(999) === 50);
  }
  {
    const r = P('no numbers here at all\n');
    assert('a paste with nothing in it yields nothing', r.byTruck.size === 0);
  }

  console.log('\n[Matching it against what the field reported]');
  const m = fns.buildReportModel(FLEET_ENTRIES, FLEET);
  // The match works over whatever the report range caught, NOT one month —
  // across June and July here, truck 412 bought 100 + 120 + 80 = 300 gal on
  // Guttman, and 999 another 33.
  {
    // The statement agrees on 412, has never heard of 999, and bills a truck
    // 55 we have no entry for at all.
    const statement = fns.parseStatement('412,300\n55,75', 'last', known);
    const r = fns.matchStatement(m, 'Guttman', statement);
    const by = new Map(r.rows.map(x => [x.truck, x]));

    assert('a truck that agrees is marked as agreeing', by.get(412).verdict === 'match');
    assert('a truck on the statement with no fuel entry is flagged',
      by.get(55).verdict === 'not-in-ours', by.get(55).verdict);
    assert('a truck we reported that was never billed is flagged',
      by.get(999).verdict === 'not-on-statement', by.get(999).verdict);
    assert('our total is the range total for that account alone',
      Math.round(r.oursTotal * 100) / 100 === 333, String(r.oursTotal));
    assert("and theirs is the statement's", r.statementTotal === 375, String(r.statementTotal));
  }
  {
    const statement = fns.parseStatement('412,304.5', 'last', known);
    const r = fns.matchStatement(m, 'Guttman', statement);
    const t412 = r.rows.find(x => x.truck === 412);
    assert('a figure that differs is a variance', t412.verdict === 'variance');
    assert('and the difference is ours minus theirs', t412.difference === -4.5, String(t412.difference));
    assert('with the fill-up count beside it', t412.fills === 3, String(t412.fills));
    assert('variances sort to the top', r.rows[0].truck === 412, String(r.rows[0].truck));
  }
  {
    // Rounding is not a discrepancy.
    const statement = fns.parseStatement('412,300.001', 'last', known);
    const r = fns.matchStatement(m, 'Guttman', statement);
    assert('a hundredth of a gallon still agrees',
      r.rows.find(x => x.truck === 412).verdict === 'match');
  }
  {
    // Which is exactly why the range matters: a one-month statement against a
    // two-month range makes every truck read as a variance, in the direction
    // of us having bought more, and nothing about the output looks broken.
    // The model has to carry the months so the page can say so.
    assert('the model knows the range spans two months',
      m.months.join(',') === '2026-06,2026-07', m.months.join(','));
    const oneMonth = fns.buildReportModel(
      FLEET_ENTRIES.filter(e => e.work_date.startsWith('2026-07')), FLEET);
    assert('and knows when it does not', oneMonth.months.join(',') === '2026-07', oneMonth.months.join(','));
    const julyOnly = fns.matchStatement(oneMonth, 'Guttman',
      fns.parseStatement('412,200', 'last', known));
    assert('narrowed to July, the same statement balances',
      julyOnly.rows.find(x => x.truck === 412).verdict === 'match');
  }
  {
    // Fuel the daily review hasn't reached is not the office's yet. Counting
    // it here would let a truck be declared to agree partly on gallons nobody
    // has accepted — and marking it balanced afterwards only ever touches the
    // approved rows, so the sign-off and the figure behind it would disagree.
    const withPending = FLEET_ENTRIES.concat([
      entry({ work_date: '2026-07-28', truck_number: 412, fuel_card: 'Guttman',
              gallons: 50, status: 'submitted' }),
    ]);
    const m2 = fns.buildReportModel(withPending, FLEET);
    const r  = fns.matchStatement(m2, 'Guttman', fns.parseStatement('412,300', 'last', known));
    assert('an entry awaiting the daily review is left out of the comparison',
      r.rows.find(x => x.truck === 412).verdict === 'match',
      JSON.stringify(r.rows.find(x => x.truck === 412)));
    assert('and is counted so the page can say so',
      r.notApproved === 1 && r.notApprovedGallons === 50,
      JSON.stringify([r.notApproved, r.notApprovedGallons]));
    assert('the fill-up count covers approved fills only',
      r.rows.find(x => x.truck === 412).fills === 3,
      String(r.rows.find(x => x.truck === 412).fills));
  }
  {
    // Approved fuel with no truck number can't be lined up against a
    // statement that identifies vehicles by number — but it IS real fuel, and
    // dropping it out of the total unremarked makes the account look like it
    // over-billed by exactly that much.
    const withBlank = FLEET_ENTRIES.concat([
      entry({ work_date: '2026-07-26', truck_number: null, fuel_card: 'Guttman', gallons: 60 }),
    ]);
    const m3 = fns.buildReportModel(withBlank, FLEET);
    const r  = fns.matchStatement(m3, 'Guttman', fns.parseStatement('412,300', 'last', known));
    assert('a blank truck number does not quietly leave the total',
      r.noTruck === 1 && r.noTruckGallons === 60, JSON.stringify([r.noTruck, r.noTruckGallons]));
    assert('and is not miscounted as awaiting approval', r.notApproved === 0, String(r.notApproved));
    assert('while the trucks that do have numbers still balance',
      r.rows.find(x => x.truck === 412).verdict === 'match');
  }
  {
    // The account filter has to bite, or a Wex statement gets matched against
    // Guttman's gallons and every line reads as a variance.
    const statement = fns.parseStatement('412,60\n77,45', 'last', known);
    const r = fns.matchStatement(m, 'Wex', statement);
    assert('matching Wex counts only Wex fuel',
      r.rows.every(x => x.verdict === 'match'), JSON.stringify(r.rows.map(x => [x.truck, x.verdict])));
    assert('and its total is Wex alone', r.oursTotal === 105, String(r.oursTotal));
  }
}

// ── 5. The IFTA badge on the submissions grid ───────────────────────────────
function iftaBadgeTests() {
  console.log('\n[IFTA standing on a fuel entry]');
  const file = 'fuel-admin.html';
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

  const ROSTER = [
    { id: '1', truck_number: 635, vin: '1M2AX07C6GM030635', model_year: 2016, make: 'Mack',
      ifta: true,  ifta_sticker: '4118811', active: true },
    { id: '2', truck_number: 77,  vin: 'CAT0D6TXYZ12345', model_year: 2015, make: 'Caterpillar',
      ifta: false, ifta_sticker: null, active: true },
    { id: '3', truck_number: 900, vin: null, model_year: null, make: null,
      ifta: true,  ifta_sticker: null, active: true },
  ];

  const fns = new Function('VEHICLES', `
    const vehicles = VEHICLES;
    ${liftFn(src, 'vehicleIndex',  file)}
    ${liftFn(src, 'iftaStateFor',  file)}
    return { vehicleIndex, iftaStateFor };
  `)(ROSTER);
  const fleet = fns.vehicleIndex();

  assert('a rostered IFTA truck reads as IFTA',
    fns.iftaStateFor(fleet, 635) === 'ifta', fns.iftaStateFor(fleet, 635));
  // Off-road equipment is deliberately not IFTA. Telling it apart from a
  // truck nobody has added yet is the whole reason this returns four values
  // rather than a boolean — one of those is fine and the other needs doing.
  assert('off-road equipment reads as deliberately not IFTA',
    fns.iftaStateFor(fleet, 77) === 'not-ifta', fns.iftaStateFor(fleet, 77));
  assert('an IFTA truck with no sticker is called out separately',
    fns.iftaStateFor(fleet, 900) === 'no-sticker', fns.iftaStateFor(fleet, 900));
  assert('a truck the roster has never heard of is unknown, not "no"',
    fns.iftaStateFor(fleet, 12345) === 'unknown', fns.iftaStateFor(fleet, 12345));
  assert('and so is an entry with no truck number at all',
    fns.iftaStateFor(fleet, null) === 'unknown', fns.iftaStateFor(fleet, null));

  console.log('\n[…and it reaches the export]');
  // Run the real exportCsv. The header and the row are two separate literals
  // in that function, so a column added to one and not the other silently
  // shifts every field after it — checked by running it rather than by
  // counting commas.
  const ENTRIES = [
    entry({ work_date: '2026-08-12', truck_number: 635, fuel_card: 'Bulk Fuel – No card',
            fuel_type: 'On Road', gallons: 55, mileage: 369898, beginning_meter: 3996.3,
            ending_meter: 4051.3, fueling_site: 'Shop', city_fueled: 'Indiana', state: 'PA',
            tank_number: 5179, employee_username: 'hudockben', username: 'hudockben' }),
    entry({ work_date: '2026-08-12', truck_number: 77, gallons: 20 }),
    entry({ work_date: '2026-08-12', truck_number: 4242, gallons: 10 }),
  ];

  let captured = null;
  new Function('ENTRIES', 'VEHICLES', 'capture', `
    const shownEntries = ENTRIES;
    const vehicles = VEHICLES;
    const activeTab = 'approved';
    function val() { return ''; }
    function alert(m) { throw new Error('alert: ' + m); }
    function downloadCsv(text, name) { capture(text, name); }
    ${liftFn(src, 'csvEscape',          file)}
    ${liftFn(src, 'gallonsFromMeters',  file)}
    ${liftFn(src, 'meteredGallons',     file)}
    ${liftFn(src, 'balanceOf',          file)}
    ${liftFn(src, 'vehicleIndex',       file)}
    ${liftFn(src, 'exportCsv',          file)}
    return exportCsv;
  `)(ENTRIES, ROSTER, (text, name) => { captured = { text, name }; })();

  const rows = captured.text.split('\n');
  const header = rows[0].split(',');
  assert('every row has exactly as many fields as the header',
    rows.slice(1).every(r => r.split(',').length === header.length),
    rows.map(r => r.split(',').length).join(','));

  const iftaCol = header.indexOf('IFTA');
  const stickCol = header.indexOf('IFTA Sticker');
  assert('the header carries IFTA and its sticker', iftaCol > 0 && stickCol === iftaCol + 1,
    header.join('|'));
  const cells = rows.slice(1).map(r => r.split(','));
  assert('the IFTA truck exports Yes with its sticker',
    cells[0][iftaCol] === 'Yes' && cells[0][stickCol] === '4118811',
    `${cells[0][iftaCol]} / ${cells[0][stickCol]}`);
  assert('the off-road machine exports No', cells[1][iftaCol] === 'No', cells[1][iftaCol]);
  // Blank, not "No": the roster has no opinion about a truck it has never
  // seen, and exporting one would put a fabricated answer into a filing.
  assert('and a truck not on the roster exports blank rather than No',
    cells[2][iftaCol] === '', `"${cells[2][iftaCol]}"`);
}

// ── 6. Reading a fuel-account workbook ──────────────────────────────────────
// Header rows copied verbatim from the real May 2026 exports. The two
// accounts agree on nothing — different column names, different column
// positions, different date encodings, different ways of writing the same
// vehicle — so anything that reads one by position reads the other wrong.
const GUTTMAN_HEADER = {
  A:'Status', B:'Account number', C:'Account name', D:'Fleet id', E:'Fleet name',
  F:'Driver ID', G:'Driver ID Description', H:'Card description', I:'Card number',
  J:'Vehicle Number', K:'Department', L:'Site Id', M:'Site description',
  T:'Transaction odometer', U:'Transaction date', V:'Transaction posted date',
  W:'Transaction amount', X:'Transaction quantity', Y:'Transaction id',
  Z:'Product category', AA:'Product number', AB:'Product description', AC:'Transaction type',
};
const WEX_HEADER = {
  A:'Transaction Date', B:'Transaction Time', C:'Post Date', D:'Account Number',
  E:'Account Name', F:'Card Number', G:'Trans ID', H:'Emboss Line 2',
  I:'Custom Vehicle/Asset ID', J:'Units', K:'Unit of Measure', L:'Unit Cost',
  M:'Total Fuel Cost', AF:'Product', AG:'Product Description', AI:'Merchant (Brand)',
  AJ:'Merchant Name', AP:'Current Odometer', AW:'VIN',
};

function statementTests2() {
  console.log('\n[Reading a fuel-account export]');
  const file = 'fuel-admin.html';
  const src  = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const api = new Function(`
    ${liftFn(src, 'excelSerialToYmd', file)}
    ${liftConst(src, 'STATEMENT_COLUMNS', file)}
    ${liftFn(src, 'detectColumns',      file)}
    ${liftFn(src, 'readStatementRows',  file)}
    ${liftFn(src, 'refKey',             file)}
    ${liftFn(src, 'aggregateByRef',     file)}
    ${liftFn(src, 'resolveStatementRefs', file)}
    return { excelSerialToYmd, detectColumns, readStatementRows, refKey,
             aggregateByRef, resolveStatementRefs };
  `)();

  console.log('\n  columns, by heading rather than position');
  {
    const g = api.detectColumns(GUTTMAN_HEADER).found;
    assert('Guttman: vehicle, gallons and date are found',
      g.vehicle === 'J' && g.gallons === 'X' && g.date === 'U', JSON.stringify(g));
    assert('and so are the rows it wants excluded',
      g.status === 'A' && g.category === 'Z', JSON.stringify(g));
    const w = api.detectColumns(WEX_HEADER).found;
    // Same three fields, none of them in the same place.
    assert('Wex: the same three, in different columns',
      w.vehicle === 'I' && w.gallons === 'J' && w.date === 'A', JSON.stringify(w));
    // "Product" sits before "Product Description" in the sheet, so a
    // column-order scan reads the fuel as "UNL" where the office says
    // "Unleaded Regular".
    assert('the more specific heading wins over the broader one',
      w.product === 'AG', String(w.product));
    assert("and Wex's Units column is not confused with Unit Cost",
      w.gallons === 'J', String(w.gallons));
  }

  console.log('\n  dates');
  // Wex writes Excel serials, Guttman writes text. Both have to land on a day.
  // 46171.2625 is the first transaction in the real Wex export; cross-checked
  // against Python's date arithmetic rather than taken from the same code
  // being tested.
  assert('an Excel serial becomes the day it means',
    api.excelSerialToYmd(46171.2625) === '2026-05-29', String(api.excelSerialToYmd(46171.2625)));
  assert('and the time of day does not push it to the next one',
    api.excelSerialToYmd(46169.337) === '2026-05-27', String(api.excelSerialToYmd(46169.337)));
  assert('and nonsense does not become a date',
    api.excelSerialToYmd('later') === null, String(api.excelSerialToYmd('later')));

  console.log('\n  rows the account says are not a fuel purchase');
  {
    const rows = [GUTTMAN_HEADER,
      { A:'POSTED',   J:'5894', U:'2026-05-29 15:25:00.0', X:'21.731', Z:'FUEL', AB:'ULS Diesel', AF:'Non IFTA' },
      { A:'POSTED',   J:'5894', U:'2026-05-27 05:36:00.0', X:'4.006',  Z:'FUEL', AB:'Unleaded E10 Reg' },
      // Both of the real file's excluded rows: declined, and non-fuel, with
      // no quantity at all.
      { A:'DECLINED', J:'2458', U:'2026-05-29 05:13:26.0', X:'',       Z:'NON-FUEL', AB:'Regular' },
    ];
    const read = api.readStatementRows(rows);
    assert('a declined row is dropped', read.rows.length === 2, String(read.rows.length));
    assert('and reported rather than silently ignored',
      read.dropped.length === 1 && /DECLINED/.test(read.dropped[0].why), JSON.stringify(read.dropped));
    const agg = api.aggregateByRef(read.rows);
    assert('the surviving gallons are summed per vehicle',
      agg.byRef.get('5894').gallons === 25.74, String(agg.byRef.get('5894').gallons));
    // Asked for by the office: balance the whole account, show the split.
    assert('and the IFTA split is carried alongside, not filtered out',
      agg.iftaGallons === 4.01 && agg.nonIftaGallons === 21.73,
      `${agg.iftaGallons} / ${agg.nonIftaGallons}`);
  }

  console.log('\n  the accounts do not spell a vehicle consistently');
  // One Wex export writes the same pickup three ways.
  assert('spacing and dashes are ignored when matching',
    api.refKey('PT 2458') === api.refKey('PT-2458') && api.refKey('PT-2458') === api.refKey('pt2458'),
    api.refKey('PT 2458'));

  console.log('\n  account ids resolved to trucks');
  {
    const fleet = new Map([
      ['635',  { truck_number: 635,  account_refs: { Guttman: '5894' } }],
      ['4805', { truck_number: 4805, account_refs: { Wex: 'PT-4805' } }],
      ['2913', { truck_number: 2913, account_refs: {} }],
    ]);
    const byRef = new Map([
      ['5894',    { gallons: 179.85, fills: 10 }],
      ['PT 4805', { gallons: 162.48, fills: 7  }],
      ['2913',    { gallons: 164.46, fills: 6  }],
      ['PT8248',  { gallons: 51.27,  fills: 2  }],
    ]);
    const wex = api.resolveStatementRefs(byRef, 'Wex', fleet);
    assert('a recorded id maps to its truck whatever the spacing',
      wex.byTruck.get(4805).gallons === 162.48, JSON.stringify([...wex.byTruck]));
    // An id that IS a truck number needs no setup at all.
    assert('an id that is already a truck number needs no mapping',
      wex.byTruck.get(2913).gallons === 164.46, JSON.stringify([...wex.byTruck]));
    // 5894 is Guttman's name for truck 635 — it must NOT resolve on a Wex run.
    assert("another account's id does not resolve on this one",
      !wex.byTruck.has(635), JSON.stringify([...wex.byTruck]));
    assert('and unrecognised ids are reported with their gallons, not guessed at',
      wex.unmapped.map(u => u.ref).sort().join(',') === '5894,PT8248',
      JSON.stringify(wex.unmapped));
    assert('worst first, so the biggest gap is the first thing read',
      wex.unmapped[0].ref === '5894', wex.unmapped[0].ref);

    const gutt = api.resolveStatementRefs(byRef, 'Guttman', fleet);
    assert('the same statement resolves differently for another account',
      gutt.byTruck.get(635).gallons === 179.85, JSON.stringify([...gutt.byTruck]));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  normalizeTests();
  await routingTests();
  reportTests();
  vehicleMonthTests();
  statementTests();
  iftaBadgeTests();
  statementTests2();

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
