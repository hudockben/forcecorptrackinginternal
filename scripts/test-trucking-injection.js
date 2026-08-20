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

const path = require('path');
const { _test } = require('../api/timesheet-entries.js');
const {
  truckingRowIdPrefix, matchTruckingDriver, insertTruckingRow, insertTruckingRows,
  removeTruckingRows, truckingHasInjectedRow, truckingSplitForEntry,
  validateTruckingInjection, TRUCK_DIVISION_BLOB, needsTruckTrackingRow,
  normalizeEntryBody,
} = _test;
const {
  truckingRowId, truckRowLegIndex, findStaleTruckRows, MAX_INJECTED_LEGS,
} = require('../api/lib/truck-injected.js');
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
    icMirror:        new Map(Object.entries(initial.icMirror || {})), // intercompany_billing_entries
    entries:         new Map((initial.entries || []).map(e => [Number(e.id), e])), // timesheet_entries
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
    // removeIcBillingEntries — drop the billing entries for a set of source ids
    // from the shared blob and its mirror. Params in template order:
    // key, source, ids, source, ids, key.
    if (q.startsWith('WITH hits AS') && q.includes('jsonb_array_elements')) {
      const [key, source, ids] = values;
      const cur = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([{ removed: 0 }]);
      const hit = e => e && e.source === source && ids.includes(String(e.source_id || ''));
      const next = cur.filter(e => !hit(e));
      const removed = cur.length - next.length;
      if (removed) store.appData.set(key, next);
      return Promise.resolve([{ removed }]);
    }
    if (q.startsWith('DELETE FROM intercompany_billing_entries')) {
      const ids = values[values.length - 1] || [];
      ids.forEach(id => store.icMirror.delete(id));
      return Promise.resolve([]);
    }
    // The two single-statement blob rewrites: clearIcSuppression drops one
    // (source, source_id) pair, deleteTruckBlobRows drops a set of row ids.
    if (q.startsWith('UPDATE app_data') && q.includes('jsonb_array_elements')) {
      if (q.includes("t->>'id'")) {                       // deleteTruckBlobRows
        const [ids, key] = values;
        const cur = store.appData.get(key);
        if (!Array.isArray(cur)) return Promise.resolve([]);
        store.appData.set(key, cur.filter(t => !(t && ids.includes(String(t.id || '')))));
        return Promise.resolve([]);
      }
      const [source, sourceId, key] = values;             // clearIcSuppression
      const cur = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([]);
      const next = cur.filter(t => !(t && t.source === source && t.source_id === sourceId));
      if (next.length === cur.length) return Promise.resolve([]);
      store.appData.set(key, next);
      return Promise.resolve([{ cleared: 1 }]);
    }
    // The sweep's one lookup: which of these entries still exist and stand.
    if (q.startsWith('SELECT id, status, entry_type, division, job_id FROM timesheet_entries')) {
      const ids = values[values.length - 1] || [];
      return Promise.resolve(ids.map(id => store.entries.get(Number(id))).filter(Boolean));
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

// A dust day's hauls, as the injection flags carry them. Only a haul billed off
// Other Billing posts a Truck Tracking row — a haul billed off Dust Control
// Tracking is the dust office's from end to end — so the dust cases below that
// are about the ROW SHAPE pass an Other Billing day, and the cases about the
// destination gate pass whichever they mean. A trucking entry ignores these
// entirely; it has no dust side to ask.
const obDay = (n = 1) => ({ dustLegs: Array.from({ length: n }, () => ({ dest: 'ob' })) });
const ubDay = (n = 1) => ({ dustLegs: Array.from({ length: n }, () => ({ dest: 'dust' })) });

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

  // ── concatenated logins ──────────────────────────────────────────────────
  // The real logins on this roster are "lastnamefirstname" with no separator.
  // Before this they matched nothing and the driver column showed the login.
  {
    const roster = ['Mike Barr', 'Colton McMillan', 'George Oakes'];
    const { sql } = makeSql({ drivers: roster });
    assert('driver: barrmike → Mike Barr',
      (await matchTruckingDriver(sql, CO, 'barrmike')) === 'Mike Barr');
    assert('driver: mcmillancolton → Colton McMillan',
      (await matchTruckingDriver(sql, CO, 'mcmillancolton')) === 'Colton McMillan');
    assert('driver: oakesgeorge → George Oakes',
      (await matchTruckingDriver(sql, CO, 'oakesgeorge')) === 'George Oakes');
    // The other convention resolves too — companies build logins both ways.
    assert('driver: mikebarr → Mike Barr',
      (await matchTruckingDriver(sql, CO, 'mikebarr')) === 'Mike Barr');
    // And the shapes that already worked still do.
    assert('driver: surname alone still resolves',
      (await matchTruckingDriver(sql, CO, 'oakes')) === 'George Oakes');
    assert('driver: initial+surname resolves',
      (await matchTruckingDriver(sql, CO, 'goakes')) === 'George Oakes');
    assert('driver: full name still resolves',
      (await matchTruckingDriver(sql, CO, 'George Oakes')) === 'George Oakes');
    assert('driver: case and punctuation ignored',
      (await matchTruckingDriver(sql, CO, 'BARR.MIKE')) === 'Mike Barr');
    assert('driver: a name on nobody stays verbatim',
      (await matchTruckingDriver(sql, CO, 'nunezandy')) === 'nunezandy');
  }
  {
    // "marksann" IS Mark Sann's name run together, and is also Ann Marks's run
    // together backwards. The cascade is ordered by confidence, so the exact
    // spelling wins outright and the reversal never gets a say.
    const { sql } = makeSql({ drivers: ['Ann Marks', 'Mark Sann'] });
    assert('driver: an exact concatenation beats a reversed one',
      (await matchTruckingDriver(sql, CO, 'marksann')) === 'Mark Sann');
  }
  {
    // A genuine tie WITHIN a stage: both of these reverse to "marksann" and
    // neither spells it forwards, so nothing separates them. Resolving to
    // either would put the wrong driver on a billed row, so it stays a login.
    const { sql } = makeSql({ drivers: ['Ann Marks', 'Ann Marie Marks'] });
    assert('driver: an unbreakable tie falls back to raw',
      (await matchTruckingDriver(sql, CO, 'marksann')) === 'marksann');
  }
  {
    // Doubled letters are where the roster and the login disagree in practice.
    const { sql } = makeSql({ drivers: ['Matt Shufstall'] });
    assert('driver: doubled-letter spelling still matches',
      (await matchTruckingDriver(sql, CO, 'shuffstallmatt')) === 'Matt Shufstall');
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

  // ── The payroll-entered Unit ─────────────────────────────────────────────
  // A driver can submit a haul with no unit — every dust haul from before the
  // Unit field existed has none — and the trucking office needs one on the row.
  // The approve modal pre-fills the box from the timesheet and sends it back, so
  // payroll can supply what is missing. The distinction that carries the whole
  // feature: an ABSENT key means "keep the entry's own unit" (that is what bulk
  // approve sends, since one unit can't speak for a group of drivers), while a
  // PRESENT blank means "payroll cleared it". Collapse the two and a bulk
  // approve wipes the unit off every row it touches.
  console.log('\n[payroll-entered unit]');
  {
    assert('validate: unit absent → null (keep the timesheet\'s)',
      validateTruckingInjection({ haul_fee: 121 }).fields.unit === null);
    assert('validate: unit present → the string typed',
      validateTruckingInjection({ unit: '1000' }).fields.unit === '1000');
    assert('validate: unit trimmed', validateTruckingInjection({ unit: '  635  ' }).fields.unit === '635');
    assert('validate: unit present but blank → \'\' (clear it), not null',
      validateTruckingInjection({ unit: '' }).fields.unit === '');
    // An explicit JSON null is "no opinion", not "clear it" — a caller that
    // spells absence that way must not wipe the unit off every row it touches.
    assert('validate: unit null → treated as absent, not as a clear',
      validateTruckingInjection({ unit: null }).fields.unit === null);
    assert('validate: whitespace-only unit → \'\' too',
      validateTruckingInjection({ unit: '   ' }).fields.unit === '');
    assert('validate: missing body → unit null', validateTruckingInjection(undefined).fields.unit === null);
    assert('validate: unit capped at 100 chars',
      validateTruckingInjection({ unit: 'x'.repeat(150) }).fields.unit.length === 100);

    const { sql, store } = makeSql({ drivers: [] });
    // The case this exists for: a dust haul submitted with no unit, approved
    // with one typed in the modal.
    const noUnit = entry({ id: 60, division: 'dust', job_id: 'CNX', job_label: 'CNX', truck_unit: '' });
    const filled = await insertTruckingRow(sql, CO, noUnit, { haul_fee: 121, unit: '1000' }, obDay());
    assert('insert: payroll unit lands on the row', filled.unit === '1000');
    assert('insert: and on the mirror row', store.tde.get(filled.id).unit === '1000');

    // Payroll correcting a unit the driver did enter.
    const fixed = await insertTruckingRow(sql, CO, entry({ id: 61 }), { unit: '2773' });
    assert('insert: payroll unit overrides the timesheet\'s', fixed.unit === '2773');

    // Absent → the timesheet's own unit, exactly as before this field existed.
    const kept = await insertTruckingRow(sql, CO, entry({ id: 62 }), { haul_fee: 121 });
    assert('insert: no unit sent → timesheet unit kept (bulk approve)', kept.unit === '634');

    // Present-but-blank clears it — the approver emptied a pre-filled box.
    const cleared = await insertTruckingRow(sql, CO, entry({ id: 63 }), { unit: '' });
    assert('insert: blank unit sent → row unit cleared', cleared.unit === '');

    // End to end through the validator, the way the handler runs it.
    const { fields } = validateTruckingInjection({ haul_fee: '121', division: '', unit: ' 1000 ' });
    const viaValidator = await insertTruckingRow(sql, CO, noUnit, fields, obDay());
    assert('insert: validator → injection carries the unit', viaValidator.unit === '1000');
    assert('insert: …and still defaults dust\'s division column', viaValidator.division === 'Dust');
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

  // ── The routing gate: which entries inject a Truck Tracking row ──────────
  // Trucking has always injected. Dust customer work injects too, because that
  // work is hauling — but only when it names a customer, and never when it is
  // one of the two standing EES activities (those go to the dust EES Other tab).
  console.log('\n[routing gate]');
  {
    assert('trucking daily            → injects', needsTruckTrackingRow(entry()));
    assert('dust + a customer         → injects',
      needsTruckTrackingRow(entry({ division: 'dust', job_id: 'Antero', job_label: 'Antero' })));
    assert('dust + pre loading        → does NOT inject',
      !needsTruckTrackingRow(entry({ division: 'dust', job_id: 'ees:preloading' })));
    assert('dust + washing            → does NOT inject',
      !needsTruckTrackingRow(entry({ division: 'dust', job_id: 'ees:washing' })));
    assert('dust + no job             → does NOT inject',
      !needsTruckTrackingRow(entry({ division: 'dust', job_id: '' })));
    assert('turf                      → does NOT inject',
      !needsTruckTrackingRow(entry({ division: 'turf' })));
    assert('quarry                    → does NOT inject',
      !needsTruckTrackingRow(entry({ division: 'quarry' })));
    assert('time off                  → does NOT inject',
      !needsTruckTrackingRow(entry({ entry_type: 'time_off' })));
    assert('null entry                → does NOT inject', !needsTruckTrackingRow(null));

    // Dust routes to exactly one destination. If both gates ever answered true
    // for the same entry the approve path's if/else would silently drop one
    // injection, so the disjointness is the invariant, not the ordering.
    const SRC = require('fs').readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
    const GATE = require('fs').readFileSync(path.resolve(__dirname, '../api/lib/truck-injected.js'), 'utf8');
    const m = /const EES_JOB_IDS = (\[[^\]]*\])/.exec(GATE);
    const eesIds = m ? JSON.parse(m[1].replace(/'/g, '"')) : [];
    const needsEes = e => e.entry_type === 'daily' && e.division === 'dust' && eesIds.includes(String(e.job_id || ''));
    const dustCases = ['Antero', 'ees:preloading', 'ees:washing', ''];
    assert('dust never routes to both tabs at once',
      dustCases.every(job => {
        const e = entry({ division: 'dust', job_id: job });
        return !(needsTruckTrackingRow(e) && needsEes(e));
      }));

    // The gate is one function called at four sites (approve, resplit,
    // un-approve, the edit guard). Inlining it at any of them is how an
    // injected row starts outliving the entry that made it.
    const calls = (SRC.match(/needsTruckTrackingRow\(existing\)/g) || []).length;
    assert('approve, resplit, un-approve and the edit guard share the gate',
      calls === 4, `found ${calls}`);
  }

  // ── payroll.html must agree on the gate ─────────────────────────────────
  // The page decides whether to open the haul-fee modal. If it disagrees with
  // the server, payroll approves a dust haul without ever being asked for a
  // fee and the injected row bills nothing until somebody notices. The page is
  // static and cannot require the module, so this is the only thing holding
  // the two together.
  console.log('\n[payroll.html mirrors the gate]');
  {
    const SRC  = require('fs').readFileSync(path.resolve(__dirname, '../api/lib/truck-injected.js'), 'utf8');
    const PAGE = require('fs').readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
    const sm = /const EES_JOB_IDS = (\[[^\]]*\])/.exec(SRC);
    const pm = /const EES_JOB_IDS = (\[[^\]]*\])/.exec(PAGE);
    assert('payroll.html declares EES_JOB_IDS', !!pm);
    assert('and names exactly the same jobs as the server',
      !!sm && !!pm && sm[1].replace(/\s+/g, '') === pm[1].replace(/\s+/g, ''),
      `page ${pm && pm[1]} vs server ${sm && sm[1]}`);

    // Run the page's own predicate against the same cases the server answered.
    const fn = /function entryNeedsTrucking\(e\) \{([\s\S]*?)\n    \}/.exec(PAGE);
    assert('entryNeedsTrucking is still a findable function', !!fn);
    if (fn) {
      const pageGate = new Function('e', 'EES_JOB_IDS', fn[1]);
      const ids = JSON.parse(pm[1].replace(/'/g, '"'));
      const cases = [
        entry(),
        entry({ division: 'dust', job_id: 'Antero' }),
        entry({ division: 'dust', job_id: 'ees:preloading' }),
        entry({ division: 'dust', job_id: 'ees:washing' }),
        entry({ division: 'dust', job_id: '' }),
        entry({ division: 'turf' }),
        entry({ entry_type: 'time_off' }),
      ];
      assert('page and server agree on every case',
        cases.every(e => !!pageGate(e, ids) === !!needsTruckTrackingRow(e)));
    }
  }

  // ── the server keeps the unit on exactly those entries ───────────────────
  // The page decides what to ASK for; this decides what is stored. They are
  // gated on the same predicate, so a unit typed on a dust haul survives and a
  // unit posted against anything else is dropped rather than leaking across.
  console.log('\n[the server keeps the unit on the right entries]');
  {
    const body = over => ({
      entry_type: 'daily', work_date: '2026-08-12',
      division: 'dust', job_id: 'Antero', job_label: 'Antero',
      start_time: '05:00', end_time: '17:30', supervisor_name: 'Scott Reefer',
      truck_unit: '634', truck_description: 'dust run',
      ...over,
    });
    const norm = over => normalizeEntryBody(body(over)).data;

    const dustHaul = norm({});
    assert('dust customer: unit kept',        dustHaul && dustHaul.truck_unit === '634');
    assert('dust customer: description kept', dustHaul && dustHaul.truck_description === 'dust run');

    const trucking = norm({ division: 'trucking', job_id: 'Acme Materials' });
    assert('trucking: unit kept', trucking && trucking.truck_unit === '634');

    const ees = norm({ job_id: 'ees:preloading' });
    assert('dust EES: unit dropped', ees && ees.truck_unit === null);

    // A jobless daily entry never gets as far as the gate — it is rejected
    // outright. So needsTruckTrackingRow's job check is not reachable from a
    // fresh submit; it guards the approve/un-approve/delete paths, which run
    // the predicate against stored rows where the job can be null.
    const jobless = normalizeEntryBody(body({ job_id: '', job_label: '' }));
    assert('dust, no job: rejected before the gate',
      !jobless.data && /job_id and job_label are required/.test(jobless.error || ''));

    const turf = norm({ division: 'turf', job_id: '26053' });
    assert('turf: unit dropped', turf && turf.truck_unit === null);
  }

  // ── timesheet.html asks for the unit on exactly those entries ────────────
  // The Unit + Description are only kept for entries that inject a Truck
  // Tracking row. If the page reveals them on a selection the server discards,
  // a driver types a unit into a void; if it hides them on one the server
  // keeps, the row loses a unit nobody knew to enter.
  console.log('\n[timesheet.html asks for the unit on the right entries]');
  {
    const PAGE = require('fs').readFileSync(path.resolve(__dirname, '../timesheet.html'), 'utf8');
    const fn = /function isTruckSelection\(i = 0\) \{([\s\S]*?)\n    \}/.exec(PAGE);
    assert('isTruckSelection is still a findable function', !!fn);
    const pm = /const EES_JOB_IDS = (\[[^\]]*\])/.exec(PAGE);
    assert('timesheet.html still declares EES_JOB_IDS', !!pm);
    if (fn && pm) {
      const ids = JSON.parse(pm[1].replace(/'/g, '"'));
      // The page reads its two values out of the DOM; feed it a stub so the
      // real body runs against the same cases the server answered.
      const run = (division, job) => {
        const bel = (_i, key) => ({ value: key === 'division' ? division : job });
        return !!new Function('bel', 'EES_JOB_IDS', 'i', fn[1])(bel, ids, 0);
      };
      const cases = [
        ['trucking', 'Acme Materials'],
        ['dust',     'Antero'],
        ['dust',     'ees:preloading'],
        ['dust',     'ees:washing'],
        ['dust',     ''],
        ['turf',     'Juniata College Baseball'],
        ['quarry',   'daily:1'],
        ['',         ''],
      ];
      assert('page and server agree on every selection',
        cases.every(([division, job]) =>
          run(division, job) === needsTruckTrackingRow({ entry_type: 'daily', division, job_id: job })));
      // The reveal has to be driven by the job, not just the division, or a
      // dust worker never sees the field: the division is picked first and the
      // job only afterwards.
      assert('dust reveal depends on the job', run('dust', 'Antero') && !run('dust', 'ees:washing'));
    }
  }

  // ── a dust haul injects the same row shape, tagged to the Dust division ──
  console.log('\n[dust customer haul]');
  {
    const { sql, store } = makeSql({ drivers: ['Mike Barr'] });
    const dust = entry({
      id: 77, username: 'barrmike', division: 'dust',
      job_id: 'Antero', job_label: 'Antero',
      work_date: '2026-08-12', start_time: '05:00', end_time: '17:30',
      // Dust logs the drive outside the clock window: 3h out + 3h back on top
      // of 05:00–17:30. Barr's real entry.
      computed_hours: 12.5, travel_to_site_hours: 3.0, travel_to_shop_hours: 3.0,
      travel_hours: 6.0, notes: 'dust control',
      // A dust timesheet never captures these — they are trucking-only columns.
      truck_unit: null, truck_description: null,
    });
    const row = await insertTruckingRow(sql, CO, dust, {}, obDay());

    // The login is "lastnamefirstname"; the roster reads "Mike Barr". The
    // driver column shows the driver, not the login.
    assert('driver resolved off the roster',  row.driver === 'Mike Barr');
    assert('date autofilled',                 row.actual_date === '2026-08-12');
    assert('customer ← job label',            row.customer === 'Antero');
    assert('hours ← work + travel',           row.total_hours === 18.5);
    assert('start/end autofilled',            row.actual_start === '05:00' && row.actual_end === '17:30');
    assert('notes carried over',              row.notes === 'dust control');
    assert('division defaults to Dust',       row.division === 'Dust');
    assert('unit blank (not on a dust sheet)', row.unit === '');
    assert('description blank',               row.description === '');
    assert('haul fee left for payroll',       row.haul_fee === '');
    assert('invoice status defaults Unpaid',  row.invoice_status === 'Unpaid');

    assert('mirrored into truck_division_entries', store.tde.has(row.id));
    assert('mirror carries the Dust division', store.tde.get(row.id).division === 'Dust');

    // The surname on its own resolves to the same driver, so a company that
    // builds logins either way lands on one name in the column.
    const { sql: sql2 } = makeSql({ drivers: ['Mike Barr'] });
    const named = await insertTruckingRow(sql2, CO, entry({
      id: 80, division: 'dust', job_id: 'Antero', username: 'barr',
    }), {}, obDay());
    assert('last-name login still resolves', named.driver === 'Mike Barr');

    assert('the guard sees the injected row',
      await truckingHasInjectedRow(sql, CO, dust));
    const removed = await removeTruckingRows(sql, CO, dust);
    assert('un-approve removes it', removed === 1);
    assert('and clears the mirror row', !store.tde.has(row.id));
  }

  // ── total_hours = work + travel, on every Truck Tracking row ─────────────
  // The haul fee bills against this column, so the drive has to be in it. The
  // rule is not dust-specific: the travel fields are on the shared timesheet
  // form for every division, and one column that meant "work only" on some
  // rows and "work + travel" on others would be unauditable in a tab that
  // shows them side by side.
  console.log('\n[travel hours count toward the total]');
  {
    const { sql } = makeSql({ drivers: [] });
    const withTravel = await insertTruckingRow(sql, CO, entry({
      id: 90, computed_hours: 8.0, travel_hours: 1.5,
    }), {});
    assert('trucking: 8.00 work + 1.50 travel → 9.50', withTravel.total_hours === 9.5);

    const noTravel = await insertTruckingRow(sql, CO, entry({
      id: 91, computed_hours: 8.0, travel_hours: 0,
    }), {});
    assert('trucking: no travel → work hours unchanged', noTravel.total_hours === 8);

    // travel_hours is nullable, and a NUMERIC comes back from the driver as a
    // string — neither may turn the total into NaN or string concatenation.
    const nullTravel = await insertTruckingRow(sql, CO, entry({
      id: 92, computed_hours: 8.0, travel_hours: null,
    }), {});
    assert('null travel → work hours, not NaN', nullTravel.total_hours === 8);

    const strTravel = await insertTruckingRow(sql, CO, entry({
      id: 93, computed_hours: '8.00', travel_hours: '1.50',
    }), {});
    assert('numeric strings add, never concatenate', strTravel.total_hours === 9.5);

    // Rounds to 2dp like every other money/hours field here.
    const oddTravel = await insertTruckingRow(sql, CO, entry({
      id: 94, computed_hours: 7.333, travel_hours: 1.333,
    }), {});
    assert('rounded to 2dp', oddTravel.total_hours === 8.67);

    // And the mirror column carries the same figure the blob does — the two
    // are written by separate statements, so they can disagree.
    const { sql: sql3, store } = makeSql({ drivers: [] });
    const mirrored = await insertTruckingRow(sql3, CO, entry({
      id: 95, computed_hours: 12.5, travel_hours: 6.0,
    }), {});
    assert('mirror total_hours agrees with the blob',
      store.tde.get(mirrored.id).total_hours === mirrored.total_hours);
    assert('mirror stores it as a number', store.tde.get(mirrored.id).total_hours === 18.5);
  }

  // ── payroll can still override the Dust default ──────────────────────────
  {
    const { sql } = makeSql({ drivers: [] });
    const dust = entry({ id: 78, division: 'dust', job_id: 'Antero', job_label: 'Antero' });
    const row = await insertTruckingRow(sql, CO, dust, { haul_fee: 95, division: 'Paving' }, obDay());
    assert('explicit division beats the Dust default', row.division === 'Paving');
    assert('haul fee still applied', row.haul_fee === 95);
    // And a trucking entry is unaffected by the dust default.
    const truck = await insertTruckingRow(sql, CO, entry({ id: 79 }), {});
    assert('trucking division column still defaults blank', truck.division === '');
  }

  // ── An Intercompany removal survives an Edit Row ─────────────────────────
  // A dust customer haul posts a row in BOTH tabs, billing on two different
  // bases, so whoever reconciles Intercompany suppresses one of the pair. That
  // choice has to outlast a routine haul-fee correction, or the customer is
  // billed twice. Approving is still the one action that overrules it — that is
  // the case clearIcSuppression was written for, since un-approve leaves the
  // removal record behind and a re-approved row would otherwise stay suppressed
  // forever.
  console.log('\n[an Intercompany removal survives an Edit Row]');
  {
    const REMOVED = `${CO}:fct_intercompany_removed_entries`;
    const suppressed = () => ({
      drivers: [],
      appData: { [REMOVED]: [{ source: 'trucking', source_id: 'tst-42-row' }] },
    });

    const a = makeSql(suppressed());
    await insertTruckingRow(a.sql, CO, entry(), { haul_fee: 95 }, { clearSuppression: true });
    assert('approving clears the suppression',
      (a.store.appData.get(REMOVED) || []).length === 0);

    const b = makeSql(suppressed());
    await insertTruckingRow(b.sql, CO, entry(), { haul_fee: 110 });
    assert('an Edit Row leaves it in place',
      (b.store.appData.get(REMOVED) || []).length === 1);
    assert('…and the correction still lands on the row',
      (await truckingSplitForEntry(b.sql, CO, entry())).row.haul_fee === 110);
  }

  // ── A day split across two customers posts one row per haul ──────────────
  // The Truck Tracking half of the same split the Dust Control Tracking tab
  // gets: 4,000 gallons to one customer for five hours, 2,000 to another for
  // five, off one timesheet entry. The driver, unit and description are the day
  // and repeat; the customer, the window, the hours and the fee are the haul.
  {
    console.log('\n[one day, two hauls]');
    const { sql, store } = makeSql({ drivers: [] });
    // 07:00–15:30 with a half-hour lunch: computed_hours 8.0 against an 8.5 h
    // window, plus an hour of travel logged outside it.
    const day = entry({ travel_hours: 1 });
    const rows = await insertTruckingRows(sql, CO, day, {
      haul_fee: 135, division: 'Dust', unit: '4000',
      rows: [
        { company: 'CNX',    start_time: '07:00', end_time: '11:15' },
        { company: 'Antero', start_time: '11:15', end_time: '15:30', haul_fee: 145 },
      ],
    });
    assert('two rows are posted', rows.length === 2);
    assert('leg 1 keeps the historic id, leg 2 gets its own',
      rows[0].id === truckingRowId(42) && rows[1].id === truckingRowId(42, 2));
    assert('each row bills the customer that haul was for',
      rows[0].customer === 'CNX' && rows[1].customer === 'Antero');
    assert('each row carries its own window',
      rows[0].actual_start === '07:00' && rows[0].actual_end === '11:15' &&
      rows[1].actual_start === '11:15' && rows[1].actual_end === '15:30');
    // 4.25 h window − 0.5 h lunch + 1 h travel = 4.75; 4.25 h for the second.
    assert('the lunch break and the travel both land on the first haul',
      rows[0].total_hours === 4.75 && rows[1].total_hours === 4.25);
    assert('the hauls still add up to the day payroll approved',
      rows[0].total_hours + rows[1].total_hours === 9);
    assert('a haul can bill at its own fee',
      rows[0].haul_fee === 135 && rows[1].haul_fee === 145);
    assert('the unit, division and description are the day, not the haul',
      rows[1].unit === '4000' && rows[1].division === 'Dust' &&
      rows[1].description === rows[0].description);
    const blob = store.appData.get(BLOB_KEY).filter(x => String(x.id).startsWith(truckingRowIdPrefix(42)));
    assert('both reached the blob', blob.length === 2);
    assert('and both are mirrored', store.tde.has(rows[0].id) && store.tde.has(rows[1].id));

    // Re-editing reads both back, in leg order, for the modal to re-fill.
    const back = await truckingSplitForEntry(sql, CO, day);
    assert('both hauls read back in order',
      back.rows.length === 2 && back.rows[0].customer === 'CNX' && back.rows[1].customer === 'Antero');
    assert('a page that only knows one row still gets the first haul',
      back.row && back.row.id === truckingRowId(42));

    // Correcting back down to one customer must take the second row — and its
    // billing entry — with it.
    const after = await insertTruckingRows(sql, CO, day, { haul_fee: 135 });
    assert('dropping a haul leaves one row', after.length === 1);
    const left = store.appData.get(BLOB_KEY).filter(x => String(x.id).startsWith(truckingRowIdPrefix(42)));
    assert('and takes the dropped haul out of the blob',
      left.length === 1 && left[0].id === truckingRowId(42));
    assert('out of the mirror too', !store.tde.has(truckingRowId(42, 2)));
    assert('and the whole day is back on the surviving row', after[0].total_hours === 9);
  }

  // ── Which of a dust day's hauls reach this tab at all ────────────────────
  // A haul billed off Dust Control Tracking is the dust office's from end to
  // end — recorded, priced and invoiced on its own grid — so it posts nothing
  // here. A haul billed off Other Billing still does: that grid prices the
  // material, and the hauling of it is the trucking office's line.
  {
    console.log('\n[a dust day posts only its material hauls]');
    const dustDay = over => entry({
      id: 90, division: 'dust', job_id: 'Antero', job_label: 'Antero',
      travel_hours: 1, ...over,
    });
    const legs = [
      { company: 'CNX',    start_time: '07:00', end_time: '11:15' },
      { company: 'Antero', start_time: '11:15', end_time: '15:30', haul_fee: 145 },
    ];

    {
      const { sql, store } = makeSql({ drivers: [] });
      const rows = await insertTruckingRows(sql, CO, dustDay(), { haul_fee: 135, rows: legs },
        { dustLegs: [{ dest: 'dust' }, { dest: 'dust' }] });
      assert('an all-UB day posts nothing here', rows.length === 0);
      assert('and writes nothing at all — no blob to race the tab over',
        !store.appData.has(BLOB_KEY));
    }
    {
      // Leg 1 UB, leg 2 material. One row, and it keeps leg 2's id: the id is
      // the haul's place in the DAY, and Intercompany keys its billing entry off
      // it, so renumbering it into leg 1's slot would move one customer's
      // billing history onto another customer's haul.
      const { sql, store } = makeSql({ drivers: [] });
      const rows = await insertTruckingRows(sql, CO, dustDay(), { haul_fee: 135, rows: legs },
        { dustLegs: [{ dest: 'dust' }, { dest: 'ob' }] });
      assert('a mixed day posts only the material haul', rows.length === 1);
      assert('under the id of the leg it actually is',
        rows[0].id === truckingRowId(90, 2), rows[0].id);
      assert('billing that haul\'s own customer and window',
        rows[0].customer === 'Antero' && rows[0].actual_start === '11:15');
      // 11:15–15:30 is 4.25 h. The lunch came off leg 1 and the travel rode on
      // it, exactly as they would have unfiltered — a haul bills its own window
      // whichever grid its neighbours went to.
      assert('and its own hours, unchanged by what leg 1 billed off',
        rows[0].total_hours === 4.25, String(rows[0].total_hours));
      const blob = store.appData.get(BLOB_KEY).filter(x => String(x.id).startsWith(truckingRowIdPrefix(90)));
      assert('one row in the blob', blob.length === 1);
      assert('and one in the mirror', store.tde.has(rows[0].id) && !store.tde.has(truckingRowId(90)));

      // Re-editing that haul back onto UB has to take the row with it. Nothing
      // else ever would: the tab refuses to delete payroll's rows.
      const after = await insertTruckingRows(sql, CO, dustDay(), { haul_fee: 135, rows: legs },
        { dustLegs: [{ dest: 'dust' }, { dest: 'dust' }] });
      assert('re-pointing it at UB takes the row back', after.length === 0);
      assert('out of the blob',
        !store.appData.get(BLOB_KEY).some(x => String(x.id).startsWith(truckingRowIdPrefix(90))));
      assert('and out of the mirror', !store.tde.has(truckingRowId(90, 2)));
    }
    {
      // Bulk approve names no hauls at all. The dust default is the tracking
      // grid, so it posts nothing here — a caller that cannot say where a haul
      // bills must not be read as saying "everywhere".
      const { sql } = makeSql({ drivers: [] });
      const rows = await insertTruckingRows(sql, CO, dustDay({ id: 91 }), { haul_fee: 135 }, {});
      assert('a dust day approved with no hauls given posts nothing here', rows.length === 0);
    }
    {
      // A trucking entry has no dust side, so nothing is filtered — every leg
      // posts, exactly as it always has.
      const { sql } = makeSql({ drivers: [] });
      const rows = await insertTruckingRows(sql, CO, entry({ id: 92 }), { haul_fee: 135, rows: legs }, {});
      assert('a trucking day still posts every leg', rows.length === 2);
    }
  }

  // ── An unsplit day sends one leg and must bill exactly as it always did ──
  // The payroll modal sends trucking.rows for every entry that can be split,
  // one element when it wasn't. That element carries the day's own window, and
  // the day's window is NOT how an unsplit row bills — computed_hours is, and it
  // is lunch-deducted. Billing the window would quietly pay back every lunch
  // break in the division.
  {
    console.log('\n[one leg is the day, not a split]');
    const { sql } = makeSql({ drivers: [] });
    const day = entry({ travel_hours: 1 });          // 07:00–15:30 window, 8.0 h work
    const noRows  = await insertTruckingRows(sql, CO, day, { haul_fee: 90 });
    const oneRow  = await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, rows: [{ start_time: '07:00', end_time: '15:30', haul_fee: 90 }],
    });
    assert('one leg posts one row', oneRow.length === 1 && noRows.length === 1);
    assert('and bills the entry\'s own hours, lunch deducted, not its window',
      oneRow[0].total_hours === 9 && noRows[0].total_hours === 9);
    assert('every other column matches the no-rows form',
      oneRow[0].id === noRows[0].id && oneRow[0].customer === noRows[0].customer &&
      oneRow[0].actual_start === noRows[0].actual_start &&
      oneRow[0].actual_end === noRows[0].actual_end &&
      oneRow[0].haul_fee === noRows[0].haul_fee);
    // The window is all-or-nothing with the hours. A single leg carrying some
    // other window — which is what removing the first haul of a split leaves
    // behind — must not stamp a row "11:15-15:30" against the day's nine hours.
    const oddWindow = await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, rows: [{ start_time: '11:15', end_time: '15:30' }],
    });
    assert('an unsplit row keeps the entry\'s own window, whatever the leg says',
      oddWindow[0].actual_start === '07:00' && oddWindow[0].actual_end === '15:30',
      `${oddWindow[0].actual_start}-${oddWindow[0].actual_end}`);
    assert('and still bills the day', oddWindow[0].total_hours === 9);
    // A trucking entry's leg can still name another customer without splitting.
    const renamed = await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, rows: [{ company: 'Somebody Else' }],
    });
    assert('a single leg can still re-point the customer',
      renamed[0].customer === 'Somebody Else' && renamed[0].total_hours === 9);
    const ownFee = await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, rows: [{ haul_fee: 111 }],
    });
    assert('and can still set its own fee', ownFee[0].haul_fee === 111);
    const blank = await insertTruckingRows(sql, CO, day, { haul_fee: 90, rows: [{ company: '' }] });
    assert('and a blank customer falls back to the timesheet job',
      blank[0].customer === 'Acme Materials');
  }

  // ── A trucking day split across customers ────────────────────────────────
  {
    console.log('\n[a trucking day split across customers]');
    const { sql, store } = makeSql({ drivers: [] });
    const day = entry();                              // 07:00–15:30, 8.0 h, no travel
    const rows = await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, unit: '634',
      rows: [
        { company: 'Acme Materials', start_time: '07:00', end_time: '11:15' },
        { company: 'Derry Stone',    start_time: '11:15', end_time: '15:30', haul_fee: 105 },
      ],
    });
    assert('two rows, one per customer',
      rows.length === 2 && rows[0].customer === 'Acme Materials' && rows[1].customer === 'Derry Stone');
    assert('the lunch break comes off the first haul',
      rows[0].total_hours === 3.75 && rows[1].total_hours === 4.25);
    assert('and the day still adds up to what payroll approved',
      rows[0].total_hours + rows[1].total_hours === 8);
    assert('the second haul bills at its own fee',
      rows[0].haul_fee === 90 && rows[1].haul_fee === 105);
    assert('the division column stays blank for a trucking entry',
      rows[0].division === '' && rows[1].division === '');
    assert('both are mirrored', store.tde.has(rows[0].id) && store.tde.has(rows[1].id));
  }

  // ── An invoice belongs to a haul, not to a slot ──────────────────────────
  // Leg ids are positional: remove the first haul of a two-haul day and the
  // second is rewritten under the first one's id. The office's QB number and
  // paid date must not ride along to a customer who was never invoiced.
  {
    console.log('\n[the invoice stays with the haul it was raised for]');
    const { sql, store } = makeSql({ drivers: [] });
    const day = entry();
    await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, rows: [
        { company: 'Acme Materials', start_time: '07:00', end_time: '11:15' },
        { company: 'Derry Stone',    start_time: '11:15', end_time: '15:30' },
      ],
    });
    // The office invoices haul 1 and marks it paid.
    const blobRows = store.appData.get(BLOB_KEY);
    const first = blobRows.find(r => r.id === truckingRowId(42));
    Object.assign(first, { qb_invoice: 'QB-1234', invoice_status: 'Paid', date_paid: '2026-07-10' });
    store.appData.set(BLOB_KEY, blobRows);

    // Correcting the day's hours must not disturb it — same customer, same slot.
    const same = await insertTruckingRows(sql, CO, day, {
      haul_fee: 95, rows: [
        { company: 'Acme Materials', start_time: '07:00', end_time: '11:15' },
        { company: 'Derry Stone',    start_time: '11:15', end_time: '15:30' },
      ],
    });
    assert('a correction keeps the invoice on the haul it belongs to',
      same[0].qb_invoice === 'QB-1234' && same[0].invoice_status === 'Paid' && same[0].date_paid === '2026-07-10');

    // Now haul 1 is removed. Derry Stone slides into its id — and must arrive
    // with a clean invoice sub-row, not Acme's paid one.
    const moved = await insertTruckingRows(sql, CO, day, {
      haul_fee: 95, rows: [{ company: 'Derry Stone', start_time: '07:00', end_time: '15:30' }],
    });
    assert('the surviving haul takes the vacated id', moved[0].id === truckingRowId(42));
    assert('but not the invoice raised against the haul that left',
      moved[0].qb_invoice === '' && moved[0].date_paid === '' && moved[0].invoice_status === 'Unpaid',
      JSON.stringify([moved[0].qb_invoice, moved[0].invoice_status, moved[0].date_paid]));
    assert('and it is the customer that was left', moved[0].customer === 'Derry Stone');
  }

  // ── A removal in Intercompany describes a haul, not a slot ──────────────
  {
    console.log('\n[the customer who arrives is not the one who was removed]');
    const REMOVED = `${CO}:fct_intercompany_removed_entries`;
    const { sql, store } = makeSql({
      drivers: [],
      // Somebody removed haul 1 — Acme's — from Intercompany billing.
      appData: { [REMOVED]: [{ source: 'trucking', source_id: 'tst-42-row' }] },
    });
    const day = entry();
    await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, rows: [
        { company: 'Acme Materials', start_time: '07:00', end_time: '11:15' },
        { company: 'Derry Stone',    start_time: '11:15', end_time: '15:30' },
      ],
    });
    assert('an edit leaves that removal alone while the haul is still Acme\'s',
      (store.appData.get(REMOVED) || []).length === 1);

    // Haul 1 is removed, so Derry Stone is rewritten under tst-42-row. It has
    // never been billed, and must not inherit Acme's removal.
    await insertTruckingRows(sql, CO, day, {
      haul_fee: 90, rows: [{ company: 'Derry Stone', start_time: '07:00', end_time: '15:30' }],
    });
    assert('but the customer who moves in does not inherit it',
      (store.appData.get(REMOVED) || []).length === 0,
      JSON.stringify(store.appData.get(REMOVED)));
  }

  // ── The lunch break has to come off SOMEWHERE ────────────────────────────
  {
    console.log('\n[a lunch break bigger than the first haul]');
    const { sql } = makeSql({ drivers: [] });
    // 07:00–15:30 is 8.5 h of clock; computed_hours 8.0 means half an hour of
    // lunch. Split so the first haul is shorter than the break itself.
    const rows = await insertTruckingRows(sql, CO, entry(), {
      haul_fee: 90, rows: [
        { start_time: '07:00', end_time: '07:15' },   // 0.25 h — cannot absorb 0.5
        { company: 'Derry Stone', start_time: '07:15', end_time: '15:30' },
      ],
    });
    assert('the first haul bills nothing rather than negative hours', rows[0].total_hours === 0);
    assert('and what it could not absorb comes off the next haul',
      rows[1].total_hours === 8, String(rows[1].total_hours));
    assert('so the day still adds up to what payroll approved',
      rows[0].total_hours + rows[1].total_hours === 8);
  }

  // ── Blank is blank, whitespace included ──────────────────────────────────
  {
    console.log('\n[a fee nobody has set yet]');
    assert('an empty fee stays empty', validateTruckingInjection({ haul_fee: '' }).fields.haul_fee === '');
    assert('a whitespace-only fee is empty too, not $0/hr',
      validateTruckingInjection({ haul_fee: '  ' }).fields.haul_fee === '',
      JSON.stringify(validateTruckingInjection({ haul_fee: '  ' }).fields.haul_fee));
    assert('and a real zero is still a real zero',
      validateTruckingInjection({ haul_fee: '0' }).fields.haul_fee === 0);
  }

  // ── Bulk approve must stay out of the split ──────────────────────────────
  // One card covers a week of days for a whole crew: one unit, one window or one
  // customer cannot speak for them, so its body carries the fee and the division
  // column and nothing else. A `rows` key here would post a bulk-approved week
  // against one leg's window; a `unit` key would stamp one driver's truck on
  // every entry.
  {
    console.log('\n[bulk approve sends no hauls]');
    const SRC = require('fs').readFileSync(path.resolve(__dirname, '../payroll.html'), 'utf8');
    const body = SRC.match(/return \{ trucking: \{[^}]*\} \};/);
    assert('the bulk trucking body still carries only the fee and the division',
      !!body && /haul_fee: g\.template\.haul_fee/.test(body[0])
             && /division: g\.template\.division_col/.test(body[0])
             && !/rows/.test(body[0]) && !/unit/.test(body[0]), body && body[0]);
    // …and the server reads that absence as "one row for the day".
    const { sql } = makeSql({ drivers: [] });
    const bulk = await insertTruckingRows(sql, CO, entry({ travel_hours: 1 }), { haul_fee: 90, division: '' });
    assert('which posts exactly one row, billing the whole day',
      bulk.length === 1 && bulk[0].total_hours === 9);
  }

  // ── The sweep must not read a second haul as a duplicate ─────────────────
  {
    console.log('\n[the read-time sweep knows a haul from a duplicate]');
    const approved = { id: 42, status: 'approved', entry_type: 'daily', division: 'dust', job_id: 'co-cnx' };
    const byId = new Map([[42, approved]]);
    const stale = findStaleTruckRows(
      [{ id: truckingRowId(42) }, { id: truckingRowId(42, 2) }, { id: 'manual-1' }], byId,
    );
    assert('both hauls survive', stale.length === 0);
    // A Date.now()-stamped leftover is still a duplicate of leg 1, and still goes.
    const withLegacy = findStaleTruckRows(
      [{ id: truckingRowId(42) }, { id: 'tst-42-1737059382000' }, { id: truckingRowId(42, 2) }], byId,
    );
    assert('a legacy stamped row is still swept',
      withLegacy.length === 1 && withLegacy[0] === 'tst-42-1737059382000');
    assert('leg indexes read back from the ids',
      truckRowLegIndex(truckingRowId(42)) === 1 && truckRowLegIndex(truckingRowId(42, 3)) === 3);
    assert('a Date.now() stamp is not mistaken for a leg',
      truckRowLegIndex('tst-42-1737059382000') === 1);
  }

  // ── validateTruckingInjection: the split payload ─────────────────────────
  {
    console.log('\n[the split payload]');
    const ok = validateTruckingInjection({
      haul_fee: 135, unit: '4000',
      rows: [{ company: 'CNX', start_time: '07:00', end_time: '11:15' },
             { company: 'Antero', haul_fee: 145 }],
    });
    assert('both legs come back, in order',
      ok.fields.rows.length === 2 && ok.fields.rows[0].company === 'CNX');
    assert('a leg fee is kept apart from the day fee',
      ok.fields.haul_fee === 135 && ok.fields.rows[1].haul_fee === 145);
    assert('no rows key at all still means one row',
      validateTruckingInjection({ haul_fee: 90 }).fields.rows === undefined);
    assert('a bad leg time is rejected',
      !!validateTruckingInjection({ rows: [{ start_time: '25:00' }] }).error);
    assert('a bad leg fee is rejected',
      !!validateTruckingInjection({ rows: [{ haul_fee: -5 }] }).error);
    assert('no legs at all is rejected', !!validateTruckingInjection({ rows: [] }).error);
    assert('past the leg cap is rejected',
      !!validateTruckingInjection({ rows: Array.from({ length: MAX_INJECTED_LEGS + 1 }, () => ({})) }).error);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
