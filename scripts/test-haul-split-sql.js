#!/usr/bin/env node
'use strict';
/**
 * SQL-level integration test for splitting an approved day into hauls.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-haul-split-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates the timesheet, tracking and app_data tables.
 *
 * The mocked suites (test-dust-injection.js, test-trucking-injection.js) assert
 * what the injectors intend to write. This one drives the real handler against a
 * real PostgreSQL, because everything that makes a split expensive to get wrong
 * lives below that line:
 *
 *   - one approval writing a row per leg into the dust TABLE, and into the
 *     trucking BLOB plus its normalized mirror only for the legs that reach
 *     that tab — a haul billed off Dust Control Tracking posts nothing there,
 *     so the row ids that do land are the legs' places in the DAY and not
 *     their positions in the list,
 *   - NUMERIC(10,4) coercion of per-haul gallons and rates,
 *   - a re-edit that drops a haul — or re-points one from material back to UB —
 *     actually deleting that row from both stores AND taking its Intercompany
 *     billing entry with it,
 *   - the read-time sweep retiring the Truck Tracking rows posted back when
 *     every dust haul wrote one, which nothing else can remove,
 *   - un-approve sweeping every leg of both halves,
 *   - a TRUCKING day splitting the same way with no dust half at all, and its
 *     hours still summing to the figure payroll approved.
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}

const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

let AUTH = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth') {
    return {
      requireAuth: () => AUTH,
      requireDivision: () => null,
      hasDivisionAccess: () => true,
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));
// The same tagged template the handler is given, for the few library calls
// this suite makes directly rather than through an endpoint.
const SQL = makeSql(client);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'barrmike', divisionRoles: { timesheet: 'level1' } };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',   divisionRoles: { timesheet: 'level1', payroll: 'level3' } };

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query: query || {}, body: body || {} }, res);
  return res;
}

const q = (t, v) => client.query(t, v);
const blob = async key => {
  const r = await q(`SELECT value FROM app_data WHERE key = $1`, [key]);
  return r.rows.length && Array.isArray(r.rows[0].value) ? r.rows[0].value : [];
};
const mine = (rows, prefix) => rows.filter(r => String(r.id || '').startsWith(prefix));

async function seed() {
  await q(`TRUNCATE daily_tracking, timesheet_entries, timesheet_audit_log, app_data,
                    dust_control_entries, truck_division_entries, intercompany_billing_entries
           RESTART IDENTITY CASCADE`);
  await q(`DELETE FROM dust_company_locations WHERE dust_company_id LIKE 'co-%'`);
  await q(`DELETE FROM dust_company_personnel WHERE dust_company_id LIKE 'co-%'`);
  await q(`DELETE FROM dust_equipment  WHERE company_code = 'FCT'`);
  await q(`DELETE FROM dust_companies  WHERE company_code = 'FCT'`);
  await q(`DELETE FROM users WHERE id IN (7, 42)`);
  await q(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await q(`INSERT INTO users (id, company_code, username, password_hash, role)
           VALUES (7,'FCT','barrmike','x','level1'), (42,'FCT','office','x','admin')`);
  // Two dust customers: CNX bills an escort, Antero does not.
  await q(`INSERT INTO dust_companies (id, company_code, name, v1_rate, v2_rate, ub_rate, sort_order) VALUES
             ('co-cnx','FCT','CNX',135,60,NULL,0),
             ('co-ant','FCT','Antero',145,NULL,NULL,1)`);
  await q(`INSERT INTO dust_company_locations (id, dust_company_id, name, state, sort_order) VALUES
             ('l1','co-cnx','Deer Lick Compressor','PA',0),
             ('l2','co-ant','Bear Hollow','WV',0)`);
  await q(`INSERT INTO dust_company_personnel (id, dust_company_id, name, sort_order) VALUES
             ('p1','co-cnx','Steve Quinn',0),
             ('p2','co-ant','Maximus Lockerbie',0)`);
  await q(`INSERT INTO dust_equipment (id, company_code, name, unit_number, vehicle_rate, sort_order) VALUES
             ('e1','FCT','Distributor Truck 4000','4000',99,0),
             ('e2','FCT','Escort Vehicle 7549','7549',50,1)`);
}

// 05:00–15:00 is 10 h gross; the lunch answer takes 30 minutes off, so the
// server lands on 9.5 work + 1.0 travel = 10.5 billable hours for the day.
const DUST_DAY = {
  entry_type: 'daily', work_date: '2026-08-17', division: 'dust',
  job_id: 'co-cnx', job_label: 'CNX',
  start_time: '05:00', end_time: '15:00', lunch_break: true, operated_equipment: false,
  travel_to_site_hours: '0.5', travel_to_shop_hours: '0.5',
  supervisor_id: 3, supervisor_name: 'Dan Hudock', notes: '',
  truck_unit: 'Distributor Truck 4000', truck_description: 'Ultra bond',
};
const TRUCK_DAY = {
  entry_type: 'daily', work_date: '2026-08-18', division: 'trucking',
  job_id: 'Acme Materials', job_label: 'Acme Materials',
  start_time: '07:00', end_time: '15:30', lunch_break: true, operated_equipment: false,
  travel_to_site_hours: '1', travel_to_shop_hours: '0',
  supervisor_id: 3, supervisor_name: 'Dan Hudock', notes: '',
  truck_unit: '634', truck_description: 'Haul 2b from Derry to HC Quarry',
};

async function submitted(day) {
  const created = await call('POST', {}, day, FIELD);
  if (!created.body || !created.body.entry) throw new Error('create failed: ' + JSON.stringify(created.body));
  const id = created.body.entry.id;
  await call('POST', { action: 'submit', id }, {}, FIELD);
  return id;
}

async function run() {
  await client.connect();
  await seed();

  const TRUCK_BLOB = 'FCT:fct_truck_division';

  // ── A dust day split across two customers ────────────────────────────────
  console.log('\n[a dust day approved as two hauls]');
  const dustId = await submitted(DUST_DAY);
  const tsd = `tsd-${dustId}-`, tst = `tst-${dustId}-`;

  const appr = await call('POST', { action: 'approve', id: dustId }, {
    trucking: {
      haul_fee: 135, division: '', unit: 'Distributor Truck 4000',
      rows: [
        { start_time: '05:00', end_time: '10:00', haul_fee: 135 },
        { company: 'Antero', start_time: '10:00', end_time: '15:00', haul_fee: 145 },
      ],
    },
    dust: {
      rows: [
        { company_man: 'Steve Quinn', location: 'Deer Lick Compressor',
          start_time: '05:00', end_time: '10:00', gallons_ub: 4000,
          vehicle1: 'Distributor Truck 4000', vehicle2: 'Escort Vehicle 7549' },
        { company: 'Antero', company_man: 'Maximus Lockerbie', location: 'Bear Hollow',
          start_time: '10:00', end_time: '15:00', gallons_ub: 2000,
          vehicle1: 'Distributor Truck 4000', vehicle2: '' },
      ],
    },
  }, ADMIN);
  assert('approved', appr.statusCode === 200 && appr.body.entry.status === 'approved',
    JSON.stringify(appr.body));

  const dustRows = (await q(`SELECT * FROM dust_control_entries WHERE id LIKE $1 ORDER BY id`, [tsd + '%'])).rows;
  assert('two Dust Control Tracking rows', dustRows.length === 2, String(dustRows.length));
  const byId = new Map(dustRows.map(r => [r.id, r]));
  const d1 = byId.get(`${tsd}row`), d2 = byId.get(`${tsd}2`);
  assert('leg 1 keeps the historic id, leg 2 gets its own', !!d1 && !!d2);
  assert('each names the customer it hauled for',
    d1.company === 'CNX' && d2.company === 'Antero');
  assert('each carries its own window',
    d1.start_time === '05:00' && d1.end_time === '10:00' &&
    d2.start_time === '10:00' && d2.end_time === '15:00');
  assert('gallons land as NUMERIC, per haul',
    Number(d1.gallons_ub) === 4000 && Number(d2.gallons_ub) === 2000);
  assert('rates come from each haul\'s own customer',
    Number(d1.v1_rate) === 135 && Number(d2.v1_rate) === 145);
  assert('the state follows each haul\'s own pad',
    d1.state === 'PA' && d2.state === 'WV');
  assert('the escort is billed only where the customer has one',
    d1.vehicle2 === 'Escort Vehicle 7549' && Number(d1.v2_rate) === 60 &&
    (d2.vehicle2 === null || d2.vehicle2 === ''));

  // Both hauls bill off Dust Control Tracking, which the dust office owns end
  // to end: it records the haul, prices it off vehicle rates times hours and
  // invoices it. Nothing goes to Truck Tracking — a second copy of the same
  // haul there was work nobody in that division did, that its office could not
  // correct and had to remember not to bill against.
  assert('nothing lands in Truck Tracking', mine(await blob(TRUCK_BLOB), tst).length === 0);
  assert('nor in its normalized mirror',
    (await q(`SELECT 1 FROM truck_division_entries WHERE id LIKE $1`, [tst + '%'])).rows.length === 0);
  assert('and the blob is not written at all — nothing to race the tab over',
    (await q(`SELECT 1 FROM app_data WHERE key = $1`, [TRUCK_BLOB])).rows.length === 0);

  // ── A re-edit that drops the second haul ─────────────────────────────────
  console.log('\n[re-editing back down to one haul]');
  // Both offices have started billing: an invoice number on the dust row and an
  // Intercompany entry against each of the four injected rows.
  await q(`UPDATE dust_control_entries SET inv_number = 'INV-501' WHERE id = $1`, [`${tsd}row`]);
  await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['FCT:fct_intercompany_billing_entries', JSON.stringify([
      { id: 'ic1', source: 'dust',     source_id: `${tsd}row`, total: 100 },
      { id: 'ic2', source: 'dust',     source_id: `${tsd}2`,   total: 200 },
      { id: 'ic5', source: 'dust',     source_id: 'manual-1',  total: 500 },
    ])]);

  const re = await call('POST', { action: 'resplit', id: dustId }, {
    trucking: {
      haul_fee: 135, division: '', unit: 'Distributor Truck 4000',
      rows: [{ start_time: '05:00', end_time: '15:00', haul_fee: 135 }],
    },
    dust: {
      rows: [{ company_man: 'Steve Quinn', location: 'Deer Lick Compressor',
               start_time: '05:00', end_time: '15:00', gallons_ub: 6000,
               vehicle1: 'Distributor Truck 4000', vehicle2: 'Escort Vehicle 7549' }],
    },
  }, ADMIN);
  assert('the edit goes through', re.statusCode === 200, JSON.stringify(re.body));

  const dustAfter  = (await q(`SELECT * FROM dust_control_entries WHERE id LIKE $1`, [tsd + '%'])).rows;
  assert('one dust row is left', dustAfter.length === 1 && dustAfter[0].id === `${tsd}row`,
    JSON.stringify(dustAfter.map(r => r.id)));
  assert('and still nothing in Truck Tracking', mine(await blob(TRUCK_BLOB), tst).length === 0);
  assert('the surviving dust row carries the corrected gallons',
    Number(dustAfter[0].gallons_ub) === 6000);
  assert('and keeps the invoice number the office had typed on it',
    dustAfter[0].inv_number === 'INV-501');

  const ic = await blob('FCT:fct_intercompany_billing_entries');
  const icIds = ic.map(e => e.id).sort();
  assert('the dropped haul\'s billing entry went with it',
    !icIds.includes('ic2'), JSON.stringify(icIds));
  assert('the surviving haul keeps its own',
    icIds.includes('ic1'), JSON.stringify(icIds));
  assert('and a manual row\'s entry is never touched', icIds.includes('ic5'));

  // ── An out-of-date page cannot quietly un-bill a split day ───────────────
  // A payroll tab cached from before splitting sends the old flat shape — no
  // `rows` key at all — which parses as one derive-everything haul. Applying it
  // would prune every other haul and its Intercompany billing, off a page that
  // never knew they existed. The read side stays old-client-friendly; the write
  // side refuses.
  console.log('\n[a stale page editing a split day]');
  {
    // Put the day back to two hauls first.
    await call('POST', { action: 'resplit', id: dustId }, {
      trucking: { haul_fee: 135, unit: 'Distributor Truck 4000', rows: [
        { start_time: '05:00', end_time: '10:00' }, { company: 'Antero', start_time: '10:00', end_time: '15:00' }] },
      dust: { rows: [
        { location: 'Deer Lick Compressor', start_time: '05:00', end_time: '10:00', gallons_ub: 4000 },
        { company: 'Antero', location: 'Bear Hollow', start_time: '10:00', end_time: '15:00', gallons_ub: 2000 }] },
    }, ADMIN);
    const before = (await q(`SELECT id FROM dust_control_entries WHERE id LIKE $1`, [tsd + '%'])).rows.length;
    assert('two hauls posted', before === 2);

    const stale = await call('POST', { action: 'resplit', id: dustId }, {
      trucking: { haul_fee: 135, division: '', unit: 'Distributor Truck 4000' },
      dust: { company_man: 'Steve Quinn', location: 'Deer Lick Compressor', gallons_ub: 6000 },
    }, ADMIN);
    assert('the edit is refused', stale.statusCode === 409, JSON.stringify(stale.body));
    assert('naming how many hauls the day actually has',
      stale.body && stale.body.posted_haul_count === 2, JSON.stringify(stale.body));
    assert('and nothing is taken away',
      (await q(`SELECT id FROM dust_control_entries WHERE id LIKE $1`, [tsd + '%'])).rows.length === 2);

    // The same body against a day that only ever had one haul is fine — that is
    // every bulk approval and every unsplit re-edit.
    const oneHaul = await call('POST', { action: 'resplit', id: dustId }, {
      trucking: { haul_fee: 135, unit: 'Distributor Truck 4000', rows: [{ start_time: '05:00', end_time: '15:00' }] },
      dust: { rows: [{ location: 'Deer Lick Compressor', start_time: '05:00', end_time: '15:00', gallons_ub: 6000 }] },
    }, ADMIN);
    assert('collapsing it deliberately still works', oneHaul.statusCode === 200);
    const after = await call('POST', { action: 'resplit', id: dustId }, {
      trucking: { haul_fee: 140, division: '', unit: 'Distributor Truck 4000' },
      dust: { company_man: 'Steve Quinn', location: 'Deer Lick Compressor', gallons_ub: 6500 },
    }, ADMIN);
    assert('and an old-shape edit of a one-haul day goes through', after.statusCode === 200,
      JSON.stringify(after.body));
  }

  // ── Un-approve takes every leg back ──────────────────────────────────────
  console.log('\n[un-approving a split day]');
  // Split it again first, so there is more than one leg on each side to sweep.
  await call('POST', { action: 'resplit', id: dustId }, {
    trucking: { haul_fee: 135, unit: 'Distributor Truck 4000', rows: [
      { start_time: '05:00', end_time: '10:00' }, { company: 'Antero', start_time: '10:00', end_time: '15:00' }] },
    dust: { rows: [
      { location: 'Deer Lick Compressor', start_time: '05:00', end_time: '10:00', gallons_ub: 4000 },
      { company: 'Antero', location: 'Bear Hollow', start_time: '10:00', end_time: '15:00', gallons_ub: 2000 }] },
  }, ADMIN);
  assert('two hauls again on the dust grid',
    (await q(`SELECT 1 FROM dust_control_entries WHERE id LIKE $1`, [tsd + '%'])).rows.length === 2);

  const un = await call('POST', { action: 'unapprove', id: dustId }, {}, ADMIN);
  assert('un-approved', un.statusCode === 200, JSON.stringify(un.body));
  assert('every dust leg is gone',
    (await q(`SELECT 1 FROM dust_control_entries WHERE id LIKE $1`, [tsd + '%'])).rows.length === 0);
  assert('every truck leg is gone from the blob', mine(await blob(TRUCK_BLOB), tst).length === 0);
  assert('and from the mirror',
    (await q(`SELECT 1 FROM truck_division_entries WHERE id LIKE $1`, [tst + '%'])).rows.length === 0);

  // ── A day split across both dust grids ───────────────────────────────────
  // Leg 1 is UB on a pad and leg 2 is a delivery of material. Only the second
  // reaches Truck Tracking: Other Billing prices the material, and the hauling
  // of it is the trucking office's line.
  console.log('\n[a dust day billed half UB, half material]');
  const mixedId = await submitted({ ...DUST_DAY, work_date: '2026-08-19' });
  const mtsd = `tsd-${mixedId}-`, mtst = `tst-${mixedId}-`, mtso = `tso-${mixedId}-`;
  const OB_BLOB = 'FCT:dust_other_billing_rows';

  const mixedBody = obLeg => ({
    trucking: {
      haul_fee: 135, division: '', unit: 'Distributor Truck 4000',
      rows: [
        { start_time: '05:00', end_time: '10:00', haul_fee: 135 },
        { company: 'Antero', start_time: '10:00', end_time: '15:00', haul_fee: 145 },
      ],
    },
    dust: {
      rows: [
        { dest: 'dust', company_man: 'Steve Quinn', location: 'Deer Lick Compressor',
          start_time: '05:00', end_time: '10:00', gallons_ub: 4000,
          vehicle1: 'Distributor Truck 4000' },
        obLeg
          ? { dest: 'ob', company: 'Antero', location: 'Bear Hollow',
              start_time: '10:00', end_time: '15:00', material: 'Limestone',
              gallons_bags: 24, mu: 'TON', price_per_unit: 31, trucking_rate: 145 }
          : { dest: 'dust', company: 'Antero', company_man: 'Maximus Lockerbie',
              location: 'Bear Hollow', start_time: '10:00', end_time: '15:00',
              gallons_ub: 2000, vehicle1: 'Distributor Truck 4000' },
      ],
    },
  });

  const mixed = await call('POST', { action: 'approve', id: mixedId }, mixedBody(true), ADMIN);
  assert('approved', mixed.statusCode === 200, JSON.stringify(mixed.body));
  assert('the UB haul posts to Dust Control Tracking',
    (await q(`SELECT id FROM dust_control_entries WHERE id LIKE $1`, [mtsd + '%'])).rows
      .map(r => r.id).join() === `${mtsd}row`);
  assert('the material haul posts to Other Billing',
    mine(await blob(OB_BLOB), mtso).map(r => r.id).join() === `${mtso}2`);

  const mRows = mine(await blob(TRUCK_BLOB), mtst);
  assert('exactly one Truck Tracking row', mRows.length === 1, JSON.stringify(mRows.map(r => r.id)));
  // The id is the haul's place in the DAY, not its place among the rows that
  // landed here — Intercompany keys its billing entry off it, so renumbering
  // the survivor into leg 1's slot would move one customer's billing history
  // onto another customer's haul.
  assert('under the id of the leg it actually is', mRows[0].id === `${mtst}2`, mRows[0].id);
  assert('billing that haul\'s own customer and window',
    mRows[0].customer === 'Antero' && mRows[0].actual_start === '10:00');
  // 10:00–15:00 is 5 h. The lunch came off leg 1 and the travel rode on it,
  // exactly as they would have if leg 1 had posted here too.
  assert('and its own hours, unchanged by what leg 1 billed off',
    mRows[0].total_hours === 5, String(mRows[0].total_hours));
  assert('mirrored, and only that one',
    (await q(`SELECT id FROM truck_division_entries WHERE id LIKE $1`, [mtst + '%'])).rows
      .map(r => r.id).join() === `${mtst}2`);

  // Re-editing that haul back onto UB has to take the Truck Tracking row with
  // it. Nothing else ever would: the tab refuses to delete payroll's rows, and
  // the entry itself has not changed, so the read-time sweep still sees a live
  // dust customer haul.
  await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['FCT:fct_intercompany_billing_entries', JSON.stringify([
      { id: 'icm', source: 'trucking', source_id: `${mtst}2`, total: 725 },
    ])]);
  const backToUb = await call('POST', { action: 'resplit', id: mixedId }, mixedBody(false), ADMIN);
  assert('re-pointing it at UB goes through', backToUb.statusCode === 200, JSON.stringify(backToUb.body));
  assert('and takes the Truck Tracking row back', mine(await blob(TRUCK_BLOB), mtst).length === 0);
  assert('out of the mirror too',
    (await q(`SELECT 1 FROM truck_division_entries WHERE id LIKE $1`, [mtst + '%'])).rows.length === 0);
  assert('and its Intercompany billing with it',
    !(await blob('FCT:fct_intercompany_billing_entries')).some(e => e.id === 'icm'));
  assert('while both hauls now bill off Dust Control Tracking',
    (await q(`SELECT 1 FROM dust_control_entries WHERE id LIKE $1`, [mtsd + '%'])).rows.length === 2);

  // ── The rows posted before a UB haul stopped posting one ─────────────────
  // Every dust customer haul used to post a Truck Tracking row. Those rows are
  // stranded — the tab refuses to delete payroll's, and payroll cannot take one
  // back without un-approving a timesheet the office has been paid for — so the
  // read-time sweep is the only thing that will ever retire them.
  console.log('\n[a legacy UB row is retired on the next read]');
  {
    const { sweepInjectedTruckRows } = require(path.resolve(__dirname, '..', 'api', 'lib', 'truck-injected.js'));
    const legacy = { id: `${mtst}row`, customer: 'CNX', total_hours: 5.5, haul_fee: 135, driver: 'Mike Barr' };
    const manual = { id: 'TR-1016', customer: 'Kinkead', total_hours: 1.25 };
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [TRUCK_BLOB, JSON.stringify([legacy, manual])]);
    await q(`INSERT INTO truck_division_entries (id, company_code, customer, total_hours)
             VALUES ($1, 'FCT', 'CNX', 5.5) ON CONFLICT (id) DO NOTHING`, [legacy.id]);
    await q(`INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['FCT:fct_intercompany_billing_entries', JSON.stringify([
        { id: 'icl', source: 'trucking', source_id: legacy.id, total: 742.5 },
      ])]);

    const { entries, removed } = await sweepInjectedTruckRows(SQL, 'FCT', [legacy, manual]);
    assert('the legacy UB row is swept', removed.length === 1 && removed[0] === legacy.id,
      JSON.stringify(removed));
    assert('the office\'s own row is never touched',
      entries.length === 1 && entries[0].id === 'TR-1016');
    assert('gone from the blob on the same read',
      !mine(await blob(TRUCK_BLOB), mtst).length);
    assert('and from the mirror',
      (await q(`SELECT 1 FROM truck_division_entries WHERE id = $1`, [legacy.id])).rows.length === 0);
    // Without this the trucking page reads the billing entry as a row it lost
    // and rebuilds exactly what was just swept.
    assert('its Intercompany billing goes too',
      !(await blob('FCT:fct_intercompany_billing_entries')).some(e => e.id === 'icl'));
  }

  // ── A trucking day, which has no dust half at all ────────────────────────
  console.log('\n[a trucking day split across customers]');
  const truckId = await submitted(TRUCK_DAY);
  const tst2 = `tst-${truckId}-`;
  const appr2 = await call('POST', { action: 'approve', id: truckId }, {
    trucking: {
      haul_fee: 90, division: '', unit: '634',
      rows: [
        { start_time: '07:00', end_time: '11:15', haul_fee: 90 },
        { company: 'Derry Stone', start_time: '11:15', end_time: '15:30', haul_fee: 105 },
      ],
    },
  }, ADMIN);
  assert('approved', appr2.statusCode === 200, JSON.stringify(appr2.body));

  const tRows = mine(await blob(TRUCK_BLOB), tst2).sort((a, b) => a.id.localeCompare(b.id));
  assert('two Truck Tracking rows', tRows.length === 2, String(tRows.length));
  assert('one per customer',
    tRows.some(r => r.customer === 'Acme Materials') && tRows.some(r => r.customer === 'Derry Stone'));
  const first  = tRows.find(r => r.id === `${tst2}row`);
  const second = tRows.find(r => r.id === `${tst2}2`);
  // 4.25 h window − 0.5 h lunch + 1 h travel = 4.75; the second is its 4.25.
  assert('the lunch break and the travel ride on the first haul',
    first.total_hours === 4.75 && second.total_hours === 4.25,
    `${first.total_hours} / ${second.total_hours}`);
  assert('and the day adds up to the 8 + 1 payroll approved',
    first.total_hours + second.total_hours === 9);
  assert('each bills at its own fee', first.haul_fee === 90 && second.haul_fee === 105);
  assert('the division column stays blank for a trucking entry',
    first.division === '' && second.division === '');
  assert('no dust rows are posted for a trucking day',
    (await q(`SELECT 1 FROM dust_control_entries WHERE id LIKE $1`, [`tsd-${truckId}-%`])).rows.length === 0);

  // The unsplit form of the same day must bill exactly what it always did.
  console.log('\n[the same day, left unsplit]');
  await call('POST', { action: 'unapprove', id: truckId }, {}, ADMIN);
  await call('POST', { action: 'approve', id: truckId },
    { trucking: { haul_fee: 90, division: '', unit: '634' } }, ADMIN);
  const single = mine(await blob(TRUCK_BLOB), tst2);
  assert('one row for the day', single.length === 1 && single[0].id === `${tst2}row`);
  assert('billing the entry\'s own hours, lunch deducted, plus travel',
    single[0].total_hours === 9, String(single[0].total_hours));
  assert('on the timesheet\'s customer', single[0].customer === 'Acme Materials');
  assert('and its own window', single[0].actual_start === '07:00' && single[0].actual_end === '15:30');

  // The shape the modal leaves behind after a split is collapsed back to one
  // haul: a single leg still carrying the back half's window. The row must be
  // the day again — window and hours together — or it reads as four hours of
  // work billed as nine.
  await call('POST', { action: 'resplit', id: truckId }, {
    trucking: { haul_fee: 90, division: '', unit: '634',
                rows: [{ start_time: '11:15', end_time: '15:30', haul_fee: 90 }] },
  }, ADMIN);
  const collapsed = mine(await blob(TRUCK_BLOB), tst2);
  assert('collapsing to one haul leaves one row', collapsed.length === 1);
  assert('billing the whole day', collapsed[0].total_hours === 9, String(collapsed[0].total_hours));
  assert('and stamped with the whole day\'s window',
    collapsed[0].actual_start === '07:00' && collapsed[0].actual_end === '15:30',
    `${collapsed[0].actual_start}-${collapsed[0].actual_end}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  await client.end();
  process.exit(failed ? 1 : 0);
}

run().catch(async err => {
  console.error('FATAL', err);
  try { await client.end(); } catch (_) {}
  process.exit(1);
});
