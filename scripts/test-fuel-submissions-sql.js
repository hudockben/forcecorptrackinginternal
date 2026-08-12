#!/usr/bin/env node
'use strict';
// A DATE goes out to Postgres and comes back as a driver Date object. Anywhere
// east of Greenwich, converting it through UTC moves the day backwards — pin
// the clock there so the round-trip assertion below actually discriminates.
process.env.TZ = 'Europe/Berlin';
/**
 * SQL-level integration test for /api/fuel-submissions.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-fuel-submissions-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates fuel_submissions and fuel_audit_log. It refuses to
 * run against a database whose name doesn't look like a test database.
 *
 * scripts/test-fuel-submissions.js asserts what the handler INTENDS to send.
 * This one drives the real handler against a real PostgreSQL and asserts what
 * the database does with it:
 *
 *   - the whole life cycle: create → submit → approve → un-approve → delete
 *   - a 0 meter reading surviving the round trip as 0 and not as NULL, which
 *     is the difference between "not on Force Fuel" and "never answered"
 *   - the DATE landing on the day the driver typed
 *   - list scoping — own rows by default, ?scope=all for the review grid —
 *     against the real WHERE clause rather than a recorded one
 *   - the duplicate gate on submit, which is pure SQL and untestable mocked
 *   - the audit trail each transition leaves behind
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

// This truncates. Make it hard to point at something real by accident.
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script truncates tables. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

const client = new Client({ connectionString: URL });

// neon-serverless' tagged template, backed by pg: same contract (a Promise of
// the row array), so the handler cannot tell the difference.
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
      // Mirror the real gate rather than always saying yes, so the scoping
      // assertions below are testing a permission check that exists.
      hasDivisionAccess: (p, area) => {
        if (!p) return false;
        if (p.isPlatformAdmin) return true;
        return !!(p.divisionRoles && p.divisionRoles[area] && p.divisionRoles[area] !== 'no_access');
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'fuel-submissions.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', divisionRoles: { fuel: 'level1' } };
const OTHER = { companyCode: 'FCT', userId: 11, username: 'dhoover',     divisionRoles: { fuel: 'level1' } };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      divisionRoles: { fuel: 'level1', fuel_admin: 'level3' } };

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

async function seed() {
  const q = (t, v) => client.query(t, v);
  await q(`TRUNCATE fuel_submissions, fuel_audit_log, fuel_vehicles RESTART IDENTITY CASCADE`);
  await q(`DELETE FROM users WHERE id IN (7, 11, 42)`);
  await q(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await q(`INSERT INTO users (id, company_code, username, password_hash, role)
           VALUES (7,'FCT','strickallen','x','level1'),
                  (11,'FCT','dhoover','x','level1'),
                  (42,'FCT','office','x','admin')`);
}

// A fill-up as the driver reports it. Not on Force Fuel, so both meters are
// the documented 0 — which is the case most likely to be quietly mishandled.
const FILL = {
  work_date: '2026-07-29',
  employee_username: 'strickallen',
  fuel_card: 'Guttman',
  fuel_type: 'Off Road Diesel',
  gallons: '84.5',
  mileage: '132480',
  truck_number: '412',
  beginning_meter: '0',
  ending_meter: '0',
  fueling_site: 'Force Yard',
  city_fueled: 'Punxsutawney',
  state: 'PA',
  tank_number: '2',
};

async function auditActions(entryId) {
  const r = await client.query(
    'SELECT action FROM fuel_audit_log WHERE entry_id = $1 ORDER BY id ASC', [entryId]);
  return r.rows.map(x => x.action);
}

async function run() {
  await client.connect();
  await seed();

  console.log('\n[create]');
  const created = await call('POST', {}, FILL, FIELD);
  assert('draft created', created.statusCode === 200 && created.body.ok, JSON.stringify(created.body));
  const id = created.body.entry.id;
  const e0 = created.body.entry;
  assert('status forced to draft', e0.status === 'draft');
  // The whole feature turns on this: 0 has to come back as 0, not as null and
  // not as the string "0". A null here reads as "never answered" and the
  // submit below would refuse a correctly-filled form.
  assert('a 0 meter round-trips as the number 0',
    e0.beginning_meter === 0 && e0.ending_meter === 0,
    `${JSON.stringify(e0.beginning_meter)} / ${JSON.stringify(e0.ending_meter)}`);
  assert('the date lands on the day it was typed', e0.work_date === '2026-07-29', String(e0.work_date));
  assert('gallons come back as a number', e0.gallons === 84.5, String(e0.gallons));
  assert('the truck number is an integer', e0.truck_number === 412, String(e0.truck_number));
  assert('the submitter is taken from the token, not the body', e0.username === 'strickallen');

  console.log('\n[gallons off the tank meter]');
  {
    // FILL is a card purchase — meters at 0 — so the receipt figure stands.
    assert('a card purchase keeps the reported gallons', e0.gallons === 84.5, String(e0.gallons));

    // A Force Fuel tank fill. The gallons in the body are deliberately wrong;
    // the meter is what the row must end up carrying.
    const tank = await call('POST', {}, Object.assign({}, FILL, {
      work_date: '2026-08-02', truck_number: '9',
      beginning_meter: '18240.5', ending_meter: '18325', gallons: '10',
    }), FIELD);
    assert('a tank fill computes gallons from the readings', tank.body.entry.gallons === 84.5,
      String(tank.body.entry.gallons));
    assert('and the readings themselves are stored as given',
      tank.body.entry.beginning_meter === 18240.5 && tank.body.entry.ending_meter === 18325,
      `${tank.body.entry.beginning_meter} / ${tank.body.entry.ending_meter}`);

    // No gallons typed at all — the meter is enough to make the row complete.
    const noGallons = await call('POST', {}, Object.assign({}, FILL, {
      work_date: '2026-08-03', truck_number: '10',
      beginning_meter: '100', ending_meter: '160', gallons: '',
    }), FIELD);
    assert('a tank fill needs no typed gallons at all', noGallons.body.entry.gallons === 60,
      String(noGallons.body.entry.gallons));
    const noGallonsSubmit = await call('POST', { action: 'submit', id: noGallons.body.entry.id }, null, FIELD);
    assert('and submits without one', noGallonsSubmit.statusCode === 200,
      JSON.stringify(noGallonsSubmit.body));

    // A rolled-over meter: the difference is meaningless, so the driver's
    // figure stands and Fuel Admin flags the row for a look.
    const rolled = await call('POST', {}, Object.assign({}, FILL, {
      work_date: '2026-08-04', truck_number: '11',
      beginning_meter: '99000', ending_meter: '120', gallons: '41.2',
    }), FIELD);
    assert('a rolled-over meter keeps the reported gallons', rolled.body.entry.gallons === 41.2,
      String(rolled.body.entry.gallons));
  }

  console.log('\n[a draft may be incomplete]');
  const partial = await call('POST', {}, { work_date: '2026-07-30' }, FIELD);
  assert('a bare date saves as a draft', partial.statusCode === 200 && partial.body.ok,
    JSON.stringify(partial.body));
  const partialId = partial.body.entry.id;
  const partialSubmit = await call('POST', { action: 'submit', id: partialId }, null, FIELD);
  assert('but it cannot be submitted', partialSubmit.statusCode === 400);
  assert('and the refusal names every empty field',
    (partialSubmit.body.missing_fields || []).length === 12,
    JSON.stringify(partialSubmit.body.missing_fields));

  console.log('\n[submit]');
  const wrongUser = await call('POST', { action: 'submit', id }, null, OTHER);
  assert("another driver cannot submit someone else's draft", wrongUser.statusCode === 403);

  const submitted = await call('POST', { action: 'submit', id }, null, FIELD);
  assert('the complete entry submits', submitted.statusCode === 200, JSON.stringify(submitted.body));
  assert('status is submitted', submitted.body.entry.status === 'submitted');
  assert('submitted_at is stamped', Boolean(submitted.body.entry.submitted_at));
  assert('the 0 meters survived submission',
    submitted.body.entry.beginning_meter === 0 && submitted.body.entry.ending_meter === 0);

  const again = await call('POST', { action: 'submit', id }, null, FIELD);
  assert('the same row cannot be submitted twice', again.statusCode === 409);

  console.log('\n[the duplicate gate]');
  const dupeDraft = await call('POST', {}, FILL, FIELD);
  const dupeId = dupeDraft.body.entry.id;
  const dupeSubmit = await call('POST', { action: 'submit', id: dupeId }, null, FIELD);
  assert('the same fill-up sent twice is refused', dupeSubmit.statusCode === 409,
    JSON.stringify(dupeSubmit.body));
  assert('and it points at the row that already covers it',
    String(dupeSubmit.body.duplicate_of) === String(id), JSON.stringify(dupeSubmit.body));

  // A second fill-up on the same day, in a different truck, is an ordinary
  // day's work — not a duplicate.
  const secondTruck = await call('POST', {}, Object.assign({}, FILL, { truck_number: '77' }), FIELD);
  const secondOk = await call('POST', { action: 'submit', id: secondTruck.body.entry.id }, null, FIELD);
  assert('a different truck on the same day goes through', secondOk.statusCode === 200,
    JSON.stringify(secondOk.body));

  console.log('\n[approve / un-approve]');
  const fieldApprove = await call('POST', { action: 'approve', id }, null, FIELD);
  assert('a driver cannot approve their own fuel', fieldApprove.statusCode === 403);

  const approved = await call('POST', { action: 'approve', id }, null, ADMIN);
  assert('an admin approves it', approved.statusCode === 200, JSON.stringify(approved.body));
  assert('approved_by is recorded', approved.body.entry.approved_by_name === 'office');
  assert('approved_at is stamped', Boolean(approved.body.entry.approved_at));

  const unapproved = await call('POST', { action: 'unapprove', id }, null, ADMIN);
  assert('un-approve puts it back to submitted', unapproved.body.entry.status === 'submitted');
  assert('and clears the approval stamp',
    unapproved.body.entry.approved_at === null && unapproved.body.entry.approved_by_name === null,
    JSON.stringify(unapproved.body.entry));

  console.log('\n[the second review — balancing]');
  {
    // Two more approved fill-ups so the bulk path is exercised with something
    // to bulk over.
    const extra = [];
    for (const [d, truck] of [['2026-07-11', 412], ['2026-07-12', 412]]) {
      const c = await call('POST', {}, Object.assign({}, FILL, { work_date: d, truck_number: String(truck) }), FIELD);
      await call('POST', { action: 'submit', id: c.body.entry.id }, null, FIELD);
      await call('POST', { action: 'approve', id: c.body.entry.id }, null, ADMIN);
      extra.push(c.body.entry.id);
    }

    const fresh = await call('GET', { scope: 'all', status: 'approved' }, null, ADMIN);
    assert('an approved entry starts out pending',
      fresh.body.entries.every(e => e.balance_status === 'pending'),
      JSON.stringify(fresh.body.entries.map(e => e.balance_status)));

    const asField = await call('POST', { action: 'balance' },
      { ids: extra, balance_status: 'balanced' }, FIELD);
    assert('a driver cannot balance', asField.statusCode === 403);

    const marked = await call('POST', { action: 'balance' },
      { ids: extra, balance_status: 'balanced' }, ADMIN);
    assert('an admin balances both at once', marked.body.updated === 2, String(marked.body.updated));
    assert('and each is stamped with who and when',
      marked.body.entries.every(e => e.balanced_by_name === 'office' && e.balanced_at),
      JSON.stringify(marked.body.entries.map(e => [e.balanced_by_name, e.balanced_at])));

    const issue = await call('POST', { action: 'balance' },
      { ids: [extra[0]], balance_status: 'issue', balance_note: 'not on the Guttman statement' }, ADMIN);
    assert('a fill-up can be flagged instead', issue.body.entries[0].balance_status === 'issue');
    assert('with the reason kept', issue.body.entries[0].balance_note === 'not on the Guttman statement');

    const backToPending = await call('POST', { action: 'balance' },
      { ids: [extra[0]], balance_status: 'pending' }, ADMIN);
    assert('and put back to pending', backToPending.body.entries[0].balance_status === 'pending');
    assert('which clears who reached the verdict',
      backToPending.body.entries[0].balanced_by_name === null &&
      backToPending.body.entries[0].balanced_at === null,
      JSON.stringify(backToPending.body.entries[0]));

    // Balancing is the stage after approval — a fill-up the office has not
    // agreed to yet cannot be accounted for on a statement.
    const draft = await call('POST', {}, Object.assign({}, FILL, { work_date: '2026-07-13', truck_number: '5' }), FIELD);
    const tooEarly = await call('POST', { action: 'balance' },
      { ids: [draft.body.entry.id], balance_status: 'balanced' }, ADMIN);
    assert('an unapproved entry cannot be balanced', tooEarly.statusCode === 409, JSON.stringify(tooEarly.body));

    const mixed = await call('POST', { action: 'balance' },
      { ids: [extra[1], draft.body.entry.id], balance_status: 'balanced' }, ADMIN);
    assert('a mixed batch takes the approved ones', mixed.body.updated === 1, String(mixed.body.updated));
    assert('and names the ones it left alone',
      mixed.body.skipped.length === 1 && String(mixed.body.skipped[0]) === String(draft.body.entry.id),
      JSON.stringify(mixed.body.skipped));

    const filtered = await call('GET', { scope: 'all', status: 'approved', balance: 'balanced' }, null, ADMIN);
    assert('the list can be filtered to what is balanced',
      filtered.body.entries.length === 1 && filtered.body.entries[0].id === extra[1],
      JSON.stringify(filtered.body.entries.map(e => [e.id, e.balance_status])));

    const stillPending = await call('GET', { scope: 'all', status: 'approved', balance: 'pending' }, null, ADMIN);
    assert('and to what is still to do',
      stillPending.body.entries.every(e => e.balance_status === 'pending'),
      JSON.stringify(stillPending.body.entries.map(e => e.balance_status)));

    // Un-approving withdraws the figure, so the verdict reached about it has
    // to go too — otherwise a row reads as accounted-for while unapproved.
    await call('POST', { action: 'unapprove', id: extra[1] }, null, ADMIN);
    const afterUnapprove = await call('GET', { scope: 'all', status: 'submitted' }, null, ADMIN);
    const back = afterUnapprove.body.entries.find(e => e.id === extra[1]);
    assert('un-approving returns it to pending', back.balance_status === 'pending', back.balance_status);
    assert('and clears who balanced it',
      back.balanced_by_name === null && back.balanced_at === null, JSON.stringify(back));

    const acts = await auditActions(extra[0]);
    assert('every balancing decision is in the audit log',
      acts.filter(a => a === 'BALANCE').length === 3, acts.join(','));

    // Clean up so the scoping counts further down aren't thrown by these.
    for (const id of extra) await call('DELETE', { id }, null, ADMIN);
    await call('DELETE', { id: draft.body.entry.id }, null, ADMIN);
  }

  console.log('\n[admin edit]');
  const blanked = await call('PUT', { id },
    Object.assign({}, FILL, { city_fueled: '' }), ADMIN);
  assert('an admin cannot blank a field on a submitted entry', blanked.statusCode === 400);

  // Still a card purchase (meters 0/0), so gallons remain the reviewer's to
  // correct — this is the fuel-card figure being reconciled to a statement.
  const edited = await call('PUT', { id }, Object.assign({}, FILL, { gallons: '90.25' }), ADMIN);
  assert('an admin can correct a reported gallons figure', edited.statusCode === 200,
    JSON.stringify(edited.body));
  assert('and the correction is stored', edited.body.entry.gallons === 90.25);

  // Turn the same row into a tank fill. The meters now own gallons, so the
  // 90.25 in the body loses to them — otherwise the row would carry a gallons
  // figure its own meter readings contradict.
  const metered = await call('PUT', { id },
    Object.assign({}, FILL, { gallons: '90.25', beginning_meter: '1200.5', ending_meter: '1208' }), ADMIN);
  assert('setting real meter readings recomputes gallons', metered.body.entry.gallons === 7.5,
    String(metered.body.entry.gallons));
  assert('a real meter reading round-trips with its decimal',
    metered.body.entry.beginning_meter === 1200.5, String(metered.body.entry.beginning_meter));

  // …and putting it back to 0/0 hands gallons back to whatever is reported.
  const backToCard = await call('PUT', { id }, Object.assign({}, FILL, { gallons: '90.25' }), ADMIN);
  assert('clearing the meters returns gallons to the reported figure',
    backToCard.body.entry.gallons === 90.25, String(backToCard.body.entry.gallons));

  const fieldEdit = await call('PUT', { id }, FILL, FIELD);
  assert('the driver can no longer edit it', fieldEdit.statusCode === 403);

  console.log('\n[list scoping — against the real WHERE clause]');
  {
    const mine = await call('GET', {}, null, FIELD);
    assert('a driver sees only their own rows',
      mine.body.entries.every(e => e.username === 'strickallen'),
      JSON.stringify(mine.body.entries.map(e => e.username)));
  }
  {
    // The office row, so "everything" is distinguishable from "mine".
    const officeDraft = await call('POST', {},
      Object.assign({}, FILL, { work_date: '2026-07-31', employee_username: 'office' }), ADMIN);
    assert('the office can file its own fuel too', officeDraft.statusCode === 200);

    const own = await call('GET', {}, null, ADMIN);
    assert('an admin who asks for nothing gets their OWN rows',
      own.body.entries.every(e => e.username === 'office'),
      JSON.stringify(own.body.entries.map(e => e.username)));

    const all = await call('GET', { scope: 'all' }, null, ADMIN);
    const names = new Set(all.body.entries.map(e => e.username));
    assert('?scope=all returns the company', names.has('strickallen') && names.has('office'),
      JSON.stringify([...names]));

    const asField = await call('GET', { scope: 'all' }, null, FIELD);
    assert('?scope=all from a driver is still just theirs',
      asField.body.entries.every(e => e.username === 'strickallen'));
  }
  {
    const statusFiltered = await call('GET', { scope: 'all', status: 'submitted_approved' }, null, ADMIN);
    assert('status=submitted_approved excludes drafts',
      statusFiltered.body.entries.length > 0 &&
      statusFiltered.body.entries.every(e => e.status !== 'draft'),
      JSON.stringify(statusFiltered.body.entries.map(e => e.status)));

    const drafts = await call('GET', { scope: 'all', status: 'draft' }, null, ADMIN);
    assert('status=draft returns only drafts',
      drafts.body.entries.length > 0 && drafts.body.entries.every(e => e.status === 'draft'));

    const ranged = await call('GET', { scope: 'all', from: '2026-07-29', to: '2026-07-29' }, null, ADMIN);
    assert('the date range is inclusive on both ends',
      ranged.body.entries.length > 0 && ranged.body.entries.every(e => e.work_date === '2026-07-29'),
      JSON.stringify(ranged.body.entries.map(e => e.work_date)));

    const byEmployee = await call('GET', { scope: 'all', employee: 'office' }, null, ADMIN);
    assert('the employee filter matches on who fuelled, not who sent it',
      byEmployee.body.entries.length === 1 && byEmployee.body.entries[0].employee_username === 'office',
      JSON.stringify(byEmployee.body.entries.map(e => e.employee_username)));

    const byCard = await call('GET', { scope: 'all', fuel_card: 'Wex' }, null, ADMIN);
    assert('a card nobody used returns nothing', byCard.body.entries.length === 0);
  }

  console.log('\n[delete]');
  {
    const driverDelete = await call('DELETE', { id }, null, FIELD);
    assert('a driver cannot delete a submitted entry', driverDelete.statusCode === 403);

    const ownDraft = await call('DELETE', { id: partialId }, null, FIELD);
    assert('a driver can delete their own draft', ownDraft.statusCode === 200);

    const adminDelete = await call('DELETE', { id }, null, ADMIN);
    assert('an admin can delete a submitted entry', adminDelete.statusCode === 200);

    const gone = await call('DELETE', { id }, null, ADMIN);
    assert('deleting it twice is a 404', gone.statusCode === 404);
  }

  console.log('\n[the vehicle roster]');
  {
    // Driven through the real handler, against the real unique index — the
    // upsert below is the whole reason that index exists, and a mock can't
    // tell you whether ON CONFLICT actually has a constraint to catch.
    const vehicles = require(path.resolve(__dirname, '..', 'api', 'fuel-vehicles.js'));
    async function vcall(method, query, body, auth) {
      AUTH = auth;
      const res = {
        statusCode: 200, body: null,
        setHeader() {}, status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; }, end() { return this; },
      };
      await vehicles({ method, query: query || {}, body: body || {} }, res);
      return res;
    }

    const added = await vcall('POST', {}, {
      truck_number: '412', vin: ' 1fujgldr8csbp1234 ', model_year: '2019',
      make: 'Freightliner', ifta: true, ifta_sticker: 'PA-9981',
    }, ADMIN);
    assert('a vehicle is added', added.statusCode === 200 && added.body.ok, JSON.stringify(added.body));
    assert('the VIN is stored upper-case and unspaced',
      added.body.vehicle.vin === '1FUJGLDR8CSBP1234', added.body.vehicle.vin);
    assert('and it is in service by default', added.body.vehicle.active === true);

    // The same truck added a second time must fold into the first row, not
    // create a second — two rows for one truck double every gallon it burned
    // in the by-vehicle totals.
    const again = await vcall('POST', {}, {
      truck_number: '412', vin: '1FUJGLDR8CSBP1234', model_year: '2020',
      make: 'Freightliner', ifta: true, ifta_sticker: 'PA-1000',
    }, ADMIN);
    assert('adding the same truck number updates it', again.statusCode === 200, JSON.stringify(again.body));
    assert('and does not mint a second row', again.body.vehicle.id === added.body.vehicle.id,
      `${again.body.vehicle.id} vs ${added.body.vehicle.id}`);
    assert('with the new details applied', again.body.vehicle.model_year === 2020 &&
      again.body.vehicle.ifta_sticker === 'PA-1000');

    const second = await vcall('POST', {}, { truck_number: '77', ifta: false, ifta_sticker: 'STALE' }, ADMIN);
    assert('a non-IFTA vehicle drops the sticker on the way in',
      second.body.vehicle.ifta_sticker === null, String(second.body.vehicle.ifta_sticker));

    const collide = await vcall('POST', {}, { id: second.body.vehicle.id, truck_number: '412' }, ADMIN);
    assert('moving truck 77 onto 412 is refused', collide.statusCode === 409, JSON.stringify(collide.body));

    const retired = await vcall('POST', {}, {
      id: second.body.vehicle.id, truck_number: '77', active: false,
    }, ADMIN);
    assert('a truck can be retired without deleting it', retired.body.vehicle.active === false);

    const listed = await vcall('GET', {}, null, ADMIN);
    assert('the default list hides retired trucks',
      listed.body.vehicles.length === 1 && listed.body.vehicles[0].truck_number === 412,
      JSON.stringify(listed.body.vehicles.map(v => v.truck_number)));

    const listedAll = await vcall('GET', { include_inactive: '1' }, null, ADMIN);
    assert('include_inactive brings it back',
      listedAll.body.vehicles.map(v => v.truck_number).join(',') === '77,412',
      JSON.stringify(listedAll.body.vehicles.map(v => v.truck_number)));

    const removed = await vcall('DELETE', { id: second.body.vehicle.id }, null, ADMIN);
    assert('a vehicle can be deleted', removed.statusCode === 200);

    // Deleting a truck must not touch the fuel bought for it — those entries
    // record what a driver reported, and the report surfaces them as
    // unmatched rather than having them disappear.
    const stillThere = await client.query(
      `SELECT COUNT(*)::int AS n FROM fuel_submissions WHERE company_code = 'FCT' AND truck_number = 77`);
    assert('and its fuel entries are left alone', stillThere.rows[0].n > 0, String(stillThere.rows[0].n));
  }

  console.log('\n[audit trail]');
  {
    const actions = await auditActions(id);
    // Runs of the same action are collapsed: the shape of the life cycle is
    // what is being pinned, not how many corrections the edit section above
    // happens to make.
    const shape = actions.filter((a, i) => a !== actions[i - 1]);
    assert('every transition was recorded, in order',
      shape.join(',') === 'INSERT,SUBMIT,APPROVE,UNAPPROVE,ADMIN_EDIT,DELETE',
      actions.join(','));
    assert('each admin correction left its own entry',
      actions.filter(a => a === 'ADMIN_EDIT').length === 3, actions.join(','));
    const snap = await client.query(
      `SELECT snapshot FROM fuel_audit_log WHERE entry_id = $1 AND action = 'DELETE'`, [id]);
    assert('the delete kept a snapshot of what was removed',
      snap.rows.length === 1 && snap.rows[0].snapshot &&
      snap.rows[0].snapshot.employee_username === 'strickallen',
      JSON.stringify(snap.rows[0] && snap.rows[0].snapshot));
  }

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────');
}

run()
  .then(() => client.end())
  .then(() => process.exit(failed ? 1 : 0))
  .catch(err => { console.error(err); client.end(); process.exit(1); });
