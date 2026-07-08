#!/usr/bin/env node
'use strict';
/**
 * Trucking timesheet → Truck Tracking injection tests.
 *
 * Run: node scripts/test-trucking-injection.js
 *
 * Exercises the pure injection helpers (insertTruckingRow / removeTruckingRows /
 * matchTruckingDriver / truckingHasInjectedRow) against an in-memory mock of the
 * `sql` tagged-template. Verifies:
 *   - a trucking entry autofills a Truck Tracking row (driver/date/hours/customer
 *     /start/end) with haul_fee + division left blank,
 *   - the row is mirrored into the truck_division_entries table,
 *   - injection is idempotent (a retried approve replaces the prior injected row),
 *   - manual (non-injected) rows are never touched,
 *   - un-approve removes the injected row from both the blob and the table,
 *   - the driver best-effort matches the trucking roster.
 *
 * No DB or server required.
 */

const { _test } = require('../api/timesheet-entries.js');
const {
  truckingRowIdPrefix, matchTruckingDriver, insertTruckingRow,
  removeTruckingRows, truckingHasInjectedRow, truckingSplitForEntry,
  validateTruckingInjection, TRUCK_DIVISION_BLOB,
} = _test;
const { truckingJobs } = require('../api/timesheet-jobs.js')._test;

const LISTS_BLOB = 'fct_truck_division_lists';

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}`); }
}

// ── In-memory mock of the neon `sql` tagged template ────────────────────────
// Backs three surfaces the helpers touch: app_data (blobs), dropdown_lists
// (driver roster), and truck_division_entries (mirror table).
function makeSql(initial = {}) {
  const store = {
    appData:         new Map(Object.entries(initial.appData || {})),  // key → JS value
    driversMirror:   (initial.drivers   || []).slice(),   // dropdown_lists truck_drivers
    customersMirror: (initial.customers || []).slice(),   // dropdown_lists truck_customers
    tde:             new Map(),                            // id → row object
  };
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();

    // dropdown_lists mirror reads (fallback path)
    if (q.includes('FROM dropdown_lists')) {
      if (q.includes('truck_drivers'))   return Promise.resolve(store.driversMirror.map(v => ({ value: v })));
      if (q.includes('truck_customers')) return Promise.resolve(store.customersMirror.map(v => ({ value: v })));
      return Promise.resolve([]);
    }
    // app_data reads. The key may be interpolated (${scoped}) or a hardcoded
    // literal (legacy keys, e.g. key = 'fct_truck_division_lists') — mirror how
    // api/truck-division.js writes those queries.
    if (q.startsWith('SELECT value FROM app_data WHERE key =')) {
      let key = values[0];
      if (key === undefined) { const m = q.match(/key = '([^']*)'/); key = m ? m[1] : undefined; }
      const v = store.appData.has(key) ? store.appData.get(key) : null;
      return Promise.resolve(v == null ? [] : [{ value: v }]);
    }
    // writeBlobArray  (VALUES (${scoped}, ${JSON.stringify(arr)}, NOW()))
    if (q.startsWith('INSERT INTO app_data')) {
      const key = values[0];
      const arr = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
      store.appData.set(key, arr);
      return Promise.resolve([]);
    }
    // DELETE FROM truck_division_entries ... id = ANY(${ids})
    if (q.startsWith('DELETE FROM truck_division_entries')) {
      const ids = values[values.length - 1] || [];
      ids.forEach(id => store.tde.delete(id));
      return Promise.resolve([]);
    }
    // upsertTruckDivisionEntry
    if (q.startsWith('INSERT INTO truck_division_entries')) {
      // values order: id, companyCode, task_number, actual_date, driver, unit,
      // actual_start, actual_end, total_hours, haul_fee, customer, description,
      // division, notes, qb_invoice, invoiced_date, invoice_sent_date,
      // invoice_status, date_paid
      const [id, , task_number, actual_date, driver, unit, actual_start, actual_end,
             total_hours, haul_fee, customer, description, division] = values;
      store.tde.set(id, {
        id, task_number, actual_date, driver, unit, actual_start, actual_end,
        total_hours, haul_fee, customer, description, division,
      });
      return Promise.resolve([]);
    }
    throw new Error('Unexpected query in mock: ' + q.slice(0, 80));
  };
  return { sql, store };
}

const CO = 'ACME';
const BLOB_KEY = `${CO}:${TRUCK_DIVISION_BLOB}`;

// Raw timesheet_entries row shape (as returned by RETURNING *)
function entry(over = {}) {
  return {
    id: 42, company_code: CO, username: 'smith', entry_type: 'daily',
    division: 'trucking', work_date: '2026-07-06',
    job_id: 'Acme Materials', job_label: 'Acme Materials',
    start_time: '07:00', end_time: '15:30', computed_hours: 8.0,
    notes: 'gravel run', truck_unit: '634', truck_description: 'Haul 2b from Derry to HC Quarry',
    ...over,
  };
}

(async () => {
  console.log('Trucking injection helpers\n');

  // ── matchTruckingDriver ──
  {
    const { sql } = makeSql({ drivers: ['John Smith', 'Dave Jones'] });
    assert('driver: exact match wins',
      (await matchTruckingDriver(sql, CO, 'John Smith')) === 'John Smith');
    assert('driver: unambiguous last-name suffix match',
      (await matchTruckingDriver(sql, CO, 'smith')) === 'John Smith');
  }
  {
    const { sql } = makeSql({ drivers: ['John Smith', 'Ray Smith'] });
    assert('driver: ambiguous suffix falls back to raw name',
      (await matchTruckingDriver(sql, CO, 'smith')) === 'smith');
  }
  {
    const { sql } = makeSql({ drivers: [] });
    assert('driver: empty roster keeps raw name',
      (await matchTruckingDriver(sql, CO, 'smith')) === 'smith');
  }
  {
    // Blob is the source of truth — it must win over a stale dropdown_lists mirror.
    const { sql } = makeSql({
      appData: { [`${CO}:${LISTS_BLOB}`]: { drivers: ['Al Smith'], customers: [], units: [] } },
      drivers: ['WRONG Person'],  // stale mirror that must be ignored
    });
    assert('driver: matches from the lists blob, not the stale mirror',
      (await matchTruckingDriver(sql, CO, 'smith')) === 'Al Smith');
  }

  // ── truckingJobs: the customer picker mirrors the managed list (blob) ──
  {
    // Managed list (blob) holds distinct-cased dupes + an exact dupe + a blank.
    const managed = ['Bell Supply', 'Force', 'FORCE', 'Arcadis', 'Arcadis', '', 'CNX'];
    const { sql } = makeSql({
      appData: { [`${CO}:${LISTS_BLOB}`]: { drivers: [], customers: managed, units: [] } },
      customers: ['STALE ONLY'],  // dropdown_lists mirror must be ignored when the blob exists
    });
    const jobs = await truckingJobs(sql, CO);
    const labels = jobs.map(j => j.label);
    assert('jobs: reads the blob, not the stale mirror', !labels.includes('STALE ONLY'));
    assert('jobs: keeps distinct-cased customers ("Force" and "FORCE")',
      labels.includes('Force') && labels.includes('FORCE'));
    assert('jobs: drops blanks and exact duplicates',
      labels.filter(l => l === 'Arcadis').length === 1 && !labels.includes(''));
    assert('jobs: sorted alphabetically (localeCompare)',
      JSON.stringify(labels) === JSON.stringify([...labels].sort((a, b) => a.localeCompare(b))));
    assert('jobs: id equals the customer name', jobs.every(j => j.id === j.label));
  }
  {
    // Legacy unscoped blob is used when the scoped key is absent.
    const { sql } = makeSql({
      appData: { [LISTS_BLOB]: { drivers: [], customers: ['Legacy Co'], units: [] } },
    });
    const jobs = await truckingJobs(sql, CO);
    assert('jobs: falls back to the legacy unscoped blob',
      jobs.length === 1 && jobs[0].label === 'Legacy Co');
  }
  {
    // No blob at all → fall back to the dropdown_lists mirror.
    const { sql } = makeSql({ customers: ['Mirror Co', 'Mirror Co', 'Zeta'] });
    const jobs = await truckingJobs(sql, CO);
    const labels = jobs.map(j => j.label);
    assert('jobs: falls back to the dropdown_lists mirror when no blob',
      labels.length === 2 && labels.includes('Mirror Co') && labels.includes('Zeta'));
  }

  // ── insertTruckingRow: autofill mapping ──
  {
    const { sql, store } = makeSql({ drivers: ['Al Smith'] });
    const row = await insertTruckingRow(sql, CO, entry());
    const blob = store.appData.get(BLOB_KEY);
    assert('insert: one row written to the fct_truck_division blob', blob && blob.length === 1);
    assert('insert: id carries the tst-<entryId>- prefix',
      row.id.startsWith(truckingRowIdPrefix(42)));
    assert('insert: driver autofilled from roster (last-name match)', row.driver === 'Al Smith');
    assert('insert: actual_date ← work_date', row.actual_date === '2026-07-06');
    assert('insert: start/end ← entry times', row.actual_start === '07:00' && row.actual_end === '15:30');
    assert('insert: total_hours ← computed (lunch-deducted) hours', row.total_hours === 8.0);
    assert('insert: customer ← job_label', row.customer === 'Acme Materials');
    assert('insert: notes carried over', row.notes === 'gravel run');
    assert('insert: unit ← timesheet truck_unit', row.unit === '634');
    assert('insert: description ← timesheet truck_description', row.description === 'Haul 2b from Derry to HC Quarry');
    assert('insert: haul_fee LEFT BLANK for the trucking office', row.haul_fee === '');
    assert('insert: division column LEFT BLANK for the trucking office', row.division === '');
    assert('insert: invoice_status defaults to Unpaid', row.invoice_status === 'Unpaid');
    // mirror table
    const mirrored = store.tde.get(row.id);
    assert('mirror: row upserted into truck_division_entries', !!mirrored);
    assert('mirror: total_hours stored as a number', mirrored.total_hours === 8.0);
    assert('mirror: haul_fee stored as null (blank → NULL)', mirrored.haul_fee === null);
  }

  // ── time normalization (DB TIME could return HH:MM:SS) ──
  {
    const { sql } = makeSql({ drivers: [] });
    const row = await insertTruckingRow(sql, CO, entry({ start_time: '07:00:00', end_time: '15:30:00' }));
    assert('insert: HH:MM:SS times normalized to HH:MM',
      row.actual_start === '07:00' && row.actual_end === '15:30');
  }

  // ── idempotency: a retried approve replaces the prior injected row ──
  {
    const { sql, store } = makeSql({ drivers: [] });
    const r1 = await insertTruckingRow(sql, CO, entry());
    const r2 = await insertTruckingRow(sql, CO, entry({ computed_hours: 9.5 }));
    const blob = store.appData.get(BLOB_KEY);
    const injected = blob.filter(x => String(x.id).startsWith(truckingRowIdPrefix(42)));
    assert('idempotent: still exactly one injected row after re-approve', injected.length === 1);
    assert('idempotent: the surviving row reflects the latest hours', injected[0].total_hours === 9.5);
    assert('idempotent: stale mirror row cleaned up', !store.tde.has(r1.id) || r1.id === r2.id);
    assert('idempotent: fresh mirror row present', store.tde.has(r2.id));
  }

  // ── manual rows are never touched ──
  {
    const manual = { id: 'TR-0001', driver: 'Manny', total_hours: '3', haul_fee: '120', division: 'turf' };
    const { sql, store } = makeSql({ appData: { [BLOB_KEY]: [manual] }, drivers: [] });
    await insertTruckingRow(sql, CO, entry());
    let blob = store.appData.get(BLOB_KEY);
    assert('manual: manual row preserved alongside injected row',
      blob.length === 2 && blob.some(x => x.id === 'TR-0001'));

    // truckingHasInjectedRow
    assert('detect: truckingHasInjectedRow true after inject',
      (await truckingHasInjectedRow(sql, CO, entry())) === true);

    // un-approve removes only the injected row
    const removed = await removeTruckingRows(sql, CO, entry());
    blob = store.appData.get(BLOB_KEY);
    assert('remove: returns count of removed injected rows', removed === 1);
    assert('remove: injected row gone, manual row intact',
      blob.length === 1 && blob[0].id === 'TR-0001');
    assert('detect: truckingHasInjectedRow false after remove',
      (await truckingHasInjectedRow(sql, CO, entry())) === false);
    assert('remove: returns 0 when nothing to remove',
      (await removeTruckingRows(sql, CO, entry())) === 0);
  }

  // ── customer falls back to job_id when job_label is missing ──
  {
    const { sql } = makeSql({ drivers: [] });
    const row = await insertTruckingRow(sql, CO, entry({ job_label: '', job_id: 'Bar Haul' }));
    assert('insert: customer falls back to job_id', row.customer === 'Bar Haul');
  }

  // ── unit/description default to blank when the entry has none (older rows) ──
  {
    const { sql } = makeSql({ drivers: [] });
    const row = await insertTruckingRow(sql, CO, entry({ truck_unit: null, truck_description: null }));
    assert('insert: missing unit → blank', row.unit === '');
    assert('insert: missing description → blank', row.description === '');
  }

  // ── payroll-entered haul fee + division ──
  {
    const { sql, store } = makeSql({ drivers: [] });
    const row = await insertTruckingRow(sql, CO, entry(), { haul_fee: 121, division: 'Paving' });
    assert('fields: haul_fee set from payroll', row.haul_fee === 121);
    assert('fields: division set from payroll', row.division === 'Paving');
    const mirror = store.tde.get(row.id);
    assert('fields: mirror stores haul_fee as a number', mirror.haul_fee === 121);
    assert('fields: mirror stores division', mirror.division === 'Paving');
    assert('fields: haul_fee blank when omitted', (await insertTruckingRow(sql, CO, entry())).haul_fee === '');
  }

  // ── validateTruckingInjection ──
  {
    assert('validate: numeric haul fee accepted', validateTruckingInjection({ haul_fee: '115.5' }).fields.haul_fee === 115.5);
    assert('validate: blank haul fee → blank', validateTruckingInjection({ haul_fee: '' }).fields.haul_fee === '');
    assert('validate: missing body → blank fee', validateTruckingInjection(undefined).fields.haul_fee === '');
    assert('validate: negative haul fee rejected', !!validateTruckingInjection({ haul_fee: -5 }).error);
    assert('validate: non-numeric haul fee rejected', !!validateTruckingInjection({ haul_fee: 'abc' }).error);
    assert('validate: division trimmed', validateTruckingInjection({ division: '  Paving  ' }).fields.division === 'Paving');
  }

  // ── truckingSplitForEntry: re-edit pre-fill ──
  {
    const { sql } = makeSql({ drivers: [] });
    await insertTruckingRow(sql, CO, entry(), { haul_fee: 90, division: 'Turf' });
    const { row } = await truckingSplitForEntry(sql, CO, entry());
    assert('split: returns the injected row for re-edit', !!row && row.haul_fee === 90 && row.division === 'Turf');
    const empty = await truckingSplitForEntry(sql, CO, entry({ id: 999 }));
    assert('split: null when no injected row', empty.row === null);
  }

  // ── resplit: updates fee/division, keeps autofill, stays a single row ──
  {
    const { sql, store } = makeSql({ drivers: [] });
    await insertTruckingRow(sql, CO, entry(), { haul_fee: 100, division: '' });
    await insertTruckingRow(sql, CO, entry(), { haul_fee: 130, division: 'Quarry' });
    const blob = store.appData.get(BLOB_KEY);
    const injected = blob.filter(x => String(x.id).startsWith(truckingRowIdPrefix(42)));
    assert('resplit: still exactly one injected row', injected.length === 1);
    assert('resplit: haul fee updated', injected[0].haul_fee === 130);
    assert('resplit: division updated', injected[0].division === 'Quarry');
    assert('resplit: autofill preserved (unit)', injected[0].unit === '634');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
