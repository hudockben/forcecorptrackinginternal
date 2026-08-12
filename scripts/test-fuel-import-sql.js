#!/usr/bin/env node
'use strict';
// Same reason as test-fuel-submissions-sql.js: a DATE round-trips through the
// driver as a Date object, and anywhere east of Greenwich a UTC conversion
// moves the day backwards. Pin the clock there so a backfilled month cannot
// quietly land a day early.
process.env.TZ = 'Europe/Berlin';
/**
 * SQL-level integration test for the fuel entry IMPORT.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-fuel-import-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * DESTRUCTIVE: truncates fuel_submissions and fuel_audit_log. It refuses to
 * run against a database whose name doesn't look like a test database.
 *
 * Mocking this one would prove nothing. The three things an import has to get
 * right are all statements rather than JavaScript:
 *
 *   - the batch goes in as ONE INSERT over jsonb_to_recordset, so the shapes
 *     the recordset declares have to match what the columns actually are
 *   - a row that is already in the table is skipped by a NOT EXISTS inside
 *     that same statement, which is what makes re-running a file safe and is
 *     the difference between a truck's month reading 300 gallons and 600
 *   - that subquery CANNOT see the rows the statement is inserting, so two
 *     identical rows in one file are caught in JS beforehand or not at all
 *
 * The rule underneath the whole thing: an import is a back door to nothing.
 * Every row goes through the same normalizeBody and the same completeness
 * check the form's own submit does, so an imported entry is never one the
 * field could not have sent.
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script truncates tables. Point PG_TEST_URL at a scratch database.');
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
const { MAX_IMPORT_ROWS } = handler._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', divisionRoles: { fuel: 'level1' } };
const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      divisionRoles: { fuel: 'level1', fuel_admin: 'level3' } };
const OTHERCO = { companyCode: 'ZZZ', userId: 90, username: 'elsewhere', divisionRoles: { fuel_admin: 'level3' } };

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
  await q(`DELETE FROM users WHERE id IN (7, 42, 90)`);
  await q(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await q(`INSERT INTO companies (code, name) VALUES ('ZZZ','Other Co')   ON CONFLICT (code) DO NOTHING`);
  await q(`INSERT INTO users (id, company_code, username, password_hash, role)
           VALUES (7,'FCT','strickallen','x','level1'),
                  (42,'FCT','office','x','admin'),
                  (90,'ZZZ','elsewhere','x','admin')`);
}

// A month as a spreadsheet holds it. Card purchases, so both meters are the
// documented 0 — the value most likely to be read as "never answered".
function row(over) {
  return Object.assign({
    work_date: '2026-05-04',
    employee_username: 'strickallen',
    fuel_card: 'Guttman',
    fuel_type: 'Off Road Diesel',
    gallons: 84.5,
    mileage: 132480,
    truck_number: 635,
    beginning_meter: 0,
    ending_meter: 0,
    fueling_site: 'Guttman Clearfield',
    city_fueled: 'Clearfield',
    state: 'PA',
    tank_number: 0,
  }, over || {});
}

const MAY = [
  row(),
  row({ work_date: '2026-05-11', truck_number: 2409, gallons: 61.2 }),
  row({ work_date: '2026-05-19', truck_number: 635,  gallons: 90.05, fuel_card: 'Wex' }),
];

async function countRows(where, args) {
  const r = await client.query(`SELECT COUNT(*)::int AS n FROM fuel_submissions ${where}`, args || []);
  return r.rows[0].n;
}

async function run() {
  await client.connect();
  await seed();

  // ── 1. Who may import ─────────────────────────────────────────────────────
  console.log('\n[only Fuel Admin can import]');
  {
    const res = await call('POST', { action: 'import' }, { rows: MAY, status: 'approved' }, FIELD);
    assert('a field user is refused', res.statusCode === 403, JSON.stringify(res.body));
    assert('and nothing was written', (await countRows('')) === 0);
  }

  // ── 2. The happy path ─────────────────────────────────────────────────────
  console.log('\n[a month goes in]');
  let batch;
  {
    const res = await call('POST', { action: 'import' },
      { rows: MAY, status: 'approved', batch: 'may2026' }, ADMIN);
    assert('accepted', res.statusCode === 200 && res.body.ok, JSON.stringify(res.body));
    assert('three entries created', res.body.created === 3, String(res.body.created));
    assert('nothing rejected', res.body.rejected.length === 0, JSON.stringify(res.body.rejected));
    assert('nothing skipped as a duplicate', res.body.duplicates.length === 0);
    batch = res.body.batch;
    assert('the batch id the page chose is the one used', batch === 'may2026', batch);

    const e = res.body.entries.find(x => x.work_date === '2026-05-04');
    assert('the date lands on the day the sheet said', !!e, JSON.stringify(res.body.entries.map(x => x.work_date)));
    assert('status is approved', e.status === 'approved');
    assert('approved_by is the admin who loaded it', e.approved_by_name === 'office');
    assert('submitted_at is stamped too — it did not skip a stage',
      !!e.submitted_at && !!e.approved_at);
    // Two different people are recorded on one row and both matter: who
    // loaded the file, and who actually fueled.
    assert('the loader is on the row as the owner', e.username === 'office');
    assert('the employee is who fueled, off the sheet', e.employee_username === 'strickallen');
    assert('the batch is stamped on the row', e.import_batch === 'may2026');
    // The falsy-zero trap, on a new path. A 0 read as "empty" here would make
    // every card purchase in the file incomplete and reject the lot.
    assert('a 0 meter round-trips as the number 0',
      e.beginning_meter === 0 && e.ending_meter === 0,
      `${JSON.stringify(e.beginning_meter)} / ${JSON.stringify(e.ending_meter)}`);
    assert('and a 0 tank number too', e.tank_number === 0, JSON.stringify(e.tank_number));
    assert('the gallons are the sheet\'s, since the meters describe no fill',
      e.gallons === 84.5, String(e.gallons));
    assert('balance starts pending — importing is not balancing', e.balance_status === 'pending');

    const audit = await client.query(
      `SELECT action, COUNT(*)::int AS n FROM fuel_audit_log GROUP BY action`);
    const imports = audit.rows.find(a => a.action === 'IMPORT');
    assert('one IMPORT audit row per entry', imports && imports.n === 3,
      JSON.stringify(audit.rows));
  }

  // ── 3. Running the same file again ────────────────────────────────────────
  console.log('\n[the same file, twice]');
  {
    const res = await call('POST', { action: 'import' },
      { rows: MAY, status: 'approved', batch: 'may2026-again' }, ADMIN);
    assert('accepted', res.statusCode === 200, JSON.stringify(res.body));
    assert('nothing created the second time', res.body.created === 0, String(res.body.created));
    assert('all three named as already here', res.body.duplicates.length === 3,
      JSON.stringify(res.body.duplicates));
    assert('and named by their position in the file, not just counted',
      res.body.duplicates.map(d => d.index).join(',') === '0,1,2',
      JSON.stringify(res.body.duplicates.map(d => d.index)));
    assert('the table still holds three', (await countRows('')) === 3);
  }

  // ── 4. Two identical rows inside ONE file ────────────────────────────────
  // The NOT EXISTS above cannot see rows its own statement is inserting, so
  // this is caught in JS beforehand or not at all. Left uncaught it doubles a
  // truck's month, and the only symptom is a variance found weeks later.
  console.log('\n[a file that repeats itself]');
  {
    const dup = row({ work_date: '2026-06-01', truck_number: 77, gallons: 40 });
    const res = await call('POST', { action: 'import' },
      { rows: [dup, dup, row({ work_date: '2026-06-02', truck_number: 77, gallons: 41 })], status: 'approved' },
      ADMIN);
    assert('two created, not three', res.body.created === 2, String(res.body.created));
    assert('the repeat is rejected against the line it repeats',
      res.body.rejected.length === 1 && res.body.rejected[0].duplicate_of_row === 1,
      JSON.stringify(res.body.rejected));
  }

  // ── 5. A row the form itself would not have accepted ─────────────────────
  console.log('\n[an import is a back door to nothing]');
  {
    const res = await call('POST', { action: 'import' }, {
      rows: [
        row({ work_date: '2026-07-01', truck_number: 1, city_fueled: '' }),
        row({ work_date: '2026-07-02', truck_number: 2, fuel_card: 'Sunoco' }),
        row({ work_date: '2026-02-30', truck_number: 3 }),
        row({ work_date: '2026-07-04', truck_number: 4 }),
      ],
      status: 'approved',
    }, ADMIN);
    assert('only the sound row is written', res.body.created === 1, String(res.body.created));
    const byIndex = Object.fromEntries(res.body.rejected.map(r => [r.index, r.error]));
    assert('an empty city is reported as missing, by its label',
      /Missing: .*City Fueled/.test(byIndex[0] || ''), byIndex[0]);
    assert('a card that is not one of the four is refused',
      /not one of the fuel cards/.test(byIndex[1] || ''), byIndex[1]);
    // Shaped like a date but not a day. Left to Postgres this is a driver
    // error that takes the whole statement — and therefore the other three
    // rows — down with it.
    assert('the 30th of February is one bad row, not a failed batch',
      /valid date/i.test(byIndex[2] || ''), byIndex[2]);
    assert('and the sound row still landed', (await countRows(`WHERE truck_number = 4`)) === 1);
  }

  // ── 6. Meter readings that describe a fill ───────────────────────────────
  console.log('\n[gallons off the tank meter]');
  {
    const res = await call('POST', { action: 'import' }, {
      rows: [
        row({
          work_date: '2026-07-10', truck_number: 88, fuel_card: 'Bulk Fuel – No card',
          beginning_meter: 18240.5, ending_meter: 18325, gallons: 84,
        }),
        // The shape four thousand real responses actually take when they go
        // wrong: a 55-gallon fill whose ending reading is a thousand out.
        row({
          work_date: '2026-07-11', truck_number: 89, fuel_card: 'Bulk Fuel – No card',
          beginning_meter: 52028.1, ending_meter: 53083.1, gallons: 55,
        }),
      ],
      status: 'approved',
    }, ADMIN);
    const byTruck = Object.fromEntries(res.body.entries.map(e => [e.truck_number, e]));
    // Where the two describe the same fill, the meter's precision wins.
    assert('the meter refines a figure that agrees with it', byTruck[88].gallons === 84.5,
      String(byTruck[88].gallons));
    // Where they contradict each other, the receipt stands. Importing is
    // exactly where the two were typed independently, so this is the case that
    // matters most — the alternative is storing 1055 gallons and losing the
    // month it lands in.
    assert('and a reading that contradicts it does not overwrite it', byTruck[89].gallons === 55,
      String(byTruck[89].gallons));
    assert('with the readings kept as reported, so the row can be corrected',
      byTruck[89].beginning_meter === 52028.1 && byTruck[89].ending_meter === 53083.1);
  }

  // ── 7. Awaiting review rather than approved ──────────────────────────────
  console.log('\n[bringing a month in for review instead]');
  {
    const res = await call('POST', { action: 'import' }, {
      rows: [row({ work_date: '2026-07-20', truck_number: 99 })],
      status: 'submitted', batch: 'review-batch',
    }, ADMIN);
    const e = res.body.entries[0];
    assert('status is submitted', e.status === 'submitted');
    assert('and it is NOT stamped as approved', e.approved_at === null && e.approved_by_name === null,
      `${e.approved_at} / ${e.approved_by_name}`);
    assert('but it is stamped as submitted', !!e.submitted_at);
  }

  console.log('\n[what an import may not be]');
  {
    const draft = await call('POST', { action: 'import' }, { rows: [row()], status: 'draft' }, ADMIN);
    assert('a draft import is refused — a draft belongs to whoever is filling it in',
      draft.statusCode === 400, JSON.stringify(draft.body));

    const empty = await call('POST', { action: 'import' }, { rows: [], status: 'approved' }, ADMIN);
    assert('an empty batch is a 400', empty.statusCode === 400);

    const huge = await call('POST', { action: 'import' },
      { rows: new Array(MAX_IMPORT_ROWS + 1).fill(row()), status: 'approved' }, ADMIN);
    assert(`more than ${MAX_IMPORT_ROWS} rows in one request is refused`, huge.statusCode === 400,
      JSON.stringify(huge.body));

    const allBad = await call('POST', { action: 'import' },
      { rows: [row({ fuel_type: 'Kerosene' })], status: 'approved' }, ADMIN);
    assert('a batch where nothing survives is a 400, not a cheerful zero',
      allBad.statusCode === 400 && allBad.body.created === 0, JSON.stringify(allBad.body));

    // Silently generating a replacement would give each chunk of one file its
    // own batch, and the load would stop being one undoable thing.
    const badBatch = await call('POST', { action: 'import' },
      { rows: [row()], status: 'approved', batch: 'may 2026' }, ADMIN);
    assert('a batch id that cannot be stored is refused, not replaced',
      badBatch.statusCode === 400 && /batch/.test(badBatch.body.error), JSON.stringify(badBatch.body));
  }

  // ── 8. A draft with the same key does not block ──────────────────────────
  console.log('\n[an unfinished draft is not a duplicate]');
  {
    const same = {
      work_date: '2026-08-15', employee_username: 'strickallen', fuel_card: 'Guttman',
      fuel_type: 'Diesel', gallons: '50', mileage: '1000', truck_number: '500',
      beginning_meter: '0', ending_meter: '0', fueling_site: 'Yard',
      city_fueled: 'DuBois', state: 'PA', tank_number: '1',
    };
    await call('POST', {}, same, FIELD);   // a draft, still being filled in
    const res = await call('POST', { action: 'import' },
      { rows: [row(Object.assign({}, same, { gallons: 50, truck_number: 500, tank_number: 1, mileage: 1000, fuel_type: 'Diesel', fueling_site: 'Yard', city_fueled: 'DuBois' }))], status: 'approved' },
      ADMIN);
    // The duplicate gate is about fuel the office has ACCEPTED. Somebody's
    // half-finished draft is not a record of anything yet, and letting it
    // block the import would leave the month short with no way to see why.
    assert('the import still lands', res.body.created === 1, JSON.stringify(res.body));
  }

  // ── 9. What the tab lists ────────────────────────────────────────────────
  console.log('\n[past imports]');
  {
    const res = await call('GET', { action: 'imports' }, null, ADMIN);
    assert('listed', res.statusCode === 200 && Array.isArray(res.body.imports));
    const may = res.body.imports.find(b => b.batch === 'may2026');
    assert('the May batch is there with its count', may && may.entries === 3, JSON.stringify(may));
    assert('and the range of days it covers', may.from_date === '2026-05-04' && may.to_date === '2026-05-19',
      `${may && may.from_date} → ${may && may.to_date}`);
    assert('with who loaded it', may.username === 'office');
    assert('and nothing balanced yet', may.balanced === 0);

    const denied = await call('GET', { action: 'imports' }, null, FIELD);
    assert('a field user cannot see the import history', denied.statusCode === 403);

    const other = await call('GET', { action: 'imports' }, null, OTHERCO);
    assert('another company sees none of it', other.body.imports.length === 0,
      JSON.stringify(other.body.imports));
  }

  // ── 10. Undo ─────────────────────────────────────────────────────────────
  console.log('\n[undoing a load]');
  {
    const gone = await call('POST', { action: 'undo_import' }, { batch: 'review-batch' }, ADMIN);
    assert('the batch comes back out', gone.statusCode === 200 && gone.body.deleted === 1,
      JSON.stringify(gone.body));
    assert('nothing was held back', gone.body.kept === 0);
    assert('the row is really gone', (await countRows(`WHERE truck_number = 99`)) === 0);

    const audit = await client.query(
      `SELECT COUNT(*)::int AS n FROM fuel_audit_log WHERE action = 'IMPORT_UNDO'`);
    // The snapshot goes in the log, so an undo pressed by mistake is still
    // recoverable from what was recorded rather than only from the file.
    assert('the undo is recorded', audit.rows[0].n === 1, String(audit.rows[0].n));

    const again = await call('POST', { action: 'undo_import' }, { batch: 'review-batch' }, ADMIN);
    assert('undoing it twice is a 404, not a second success', again.statusCode === 404);

    const nobatch = await call('POST', { action: 'undo_import' }, {}, ADMIN);
    assert('undo without a batch is a 400', nobatch.statusCode === 400);

    const notMine = await call('POST', { action: 'undo_import' }, { batch: 'may2026' }, OTHERCO);
    assert('another company cannot undo this one', notMine.statusCode === 404, JSON.stringify(notMine.body));
    assert('and the entries are untouched', (await countRows(`WHERE import_batch = 'may2026'`)) === 3);
  }

  // ── 11. Undo leaves balanced fuel alone ──────────────────────────────────
  console.log('\n[undo stops at fuel that has been accounted for]');
  {
    const ids = (await client.query(
      `SELECT id FROM fuel_submissions WHERE import_batch = 'may2026' ORDER BY id ASC`)).rows.map(r => String(r.id));
    const bal = await call('POST', { action: 'balance' },
      { ids: [ids[0]], balance_status: 'balanced' }, ADMIN);
    assert('one of the three is balanced against a statement', bal.body.updated === 1);

    const undo = await call('POST', { action: 'undo_import' }, { batch: 'may2026' }, ADMIN);
    // Deleting a fill-up somebody has already reconciled would remove fuel
    // that a signed-off statement match counted. The undo does the rest and
    // says what it left.
    assert('the two pending ones go', undo.body.deleted === 2, JSON.stringify(undo.body));
    assert('the balanced one stays, and is reported', undo.body.kept === 1, JSON.stringify(undo.body));
    assert('and it is still in the table', (await countRows(`WHERE import_batch = 'may2026'`)) === 1);

    const rest = await call('POST', { action: 'undo_import' }, { batch: 'may2026' }, ADMIN);
    assert('a second undo with nothing left to take is a 409 that explains itself',
      rest.statusCode === 409 && /balanced/i.test(rest.body.error), JSON.stringify(rest.body));
  }

  console.log(`\n${'─'.repeat(40)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(40)}`);
  await client.end();
  process.exit(failed ? 1 : 0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
