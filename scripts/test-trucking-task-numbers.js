#!/usr/bin/env node
'use strict';
/**
 * Every Truck Tracking row has a task number — including payroll's.
 *
 * Run: node scripts/test-trucking-task-numbers.js
 *
 * The gap this closes: the Truck Tracking tab numbers every row it creates
 * itself ("TR-####", from nextTaskNum / the CSV import in trucking.html), but a
 * row injected from an approved timesheet entry was written with an empty
 * task_number. So the hauls the office bills out of payroll were the only ones
 * with nothing to call them — a "← Timesheet" badge and a blank in the column
 * that names a haul on an invoice, in Intercompany billing and in the executive
 * report.
 *
 * The numbers are minted server-side because the tab cannot mint them:
 * injected-blob-guard replays only TRUCK_TAB_FIELDS off a client save and takes
 * every other column from the server's copy, so a number written by the page
 * would vanish on its next PUT.
 *
 * Covers the pure numbering rules, the number minted at injection (and what
 * happens to it across a re-approval), the read-time backfill for rows injected
 * before any of this existed, and the two wiring points that make it visible.
 * No DB or server required.
 */

const path = require('path');
const fs   = require('fs');

const {
  taskNumberSeq, formatTaskNumber, maxTaskNumber, numberInjectedRows,
  backfillInjectedTaskNumbers, truckingRowId, truckingRowIdPrefix,
  TRUCK_DIVISION_BLOB, TRUCK_TAB_FIELDS,
} = require('../api/lib/truck-injected.js');
const { insertTruckingRow, insertTruckingRows } = require('../api/timesheet-entries.js')._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const CO        = 'ACME';
const BLOB_KEY  = `${CO}:${TRUCK_DIVISION_BLOB}`;

// ── In-memory mock of the neon `sql` tagged template ────────────────────────
// Same shape as the other injection suites: app_data blobs plus the
// truck_division_entries mirror. The two task-number statements are dispatched
// ahead of the generic blob rewrites, since they touch the same table.
function makeSql(initial = {}) {
  const store = {
    appData: new Map(Object.entries(initial.appData || {})),
    tde:     new Map((initial.tde || []).map(r => [r.id, { ...r }])),
    queries: [],
  };
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    store.queries.push(q);

    if (q.includes('FROM dropdown_lists')) return Promise.resolve([]);

    if (q.startsWith('SELECT value FROM app_data WHERE key =')) {
      let key = values[0];
      if (key === undefined) { const m = q.match(/key = '([^']*)'/); key = m ? m[1] : undefined; }
      const v = store.appData.has(key) ? store.appData.get(key) : null;
      return Promise.resolve(v == null ? [] : [{ value: v }]);
    }
    if (q.startsWith('INSERT INTO app_data')) {
      const arr = typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1];
      store.appData.set(values[0], arr);
      return Promise.resolve([]);
    }
    // setTruckBlobTaskNumbers: patch (twice) then the scoped key. Blank-only,
    // exactly as the CASE in the real statement is.
    if (q.startsWith('UPDATE app_data') && q.includes('task_number')) {
      const patch = JSON.parse(values[0]);
      const key   = values[values.length - 1];
      const cur   = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([]);
      store.appData.set(key, cur.map(t => {
        if (!t || typeof t !== 'object') return t;
        const num = patch[String(t.id || '')];
        return (num && !String(t.task_number || '')) ? { ...t, task_number: num } : t;
      }));
      return Promise.resolve([]);
    }
    if (q.startsWith('UPDATE app_data') && q.includes('jsonb_array_elements')) {
      const [ids, key] = values;                          // deleteTruckBlobRows
      const cur = store.appData.get(key);
      if (Array.isArray(cur)) store.appData.set(key, cur.filter(t => !(t && ids.includes(String(t.id || '')))));
      return Promise.resolve([]);
    }
    // The mirror half of the backfill: ids, nums, companyCode.
    if (q.startsWith('UPDATE truck_division_entries')) {
      const [ids, nums] = values;
      ids.forEach((id, i) => {
        const row = store.tde.get(id);
        if (row && !String(row.task_number || '')) row.task_number = nums[i];
      });
      return Promise.resolve([]);
    }
    if (q.startsWith('INSERT INTO truck_division_entries')) {
      // Positional, so it tracks upsertTruckDivisionEntry's column list —
      // haul_fee is followed there by the backup-fee pair.
      const [id, , task_number, actual_date, driver, unit, actual_start, actual_end,
             total_hours, haul_fee, , , customer] = values;
      store.tde.set(id, {
        id, task_number, actual_date, driver, unit, actual_start, actual_end,
        total_hours, haul_fee, customer,
      });
      return Promise.resolve([]);
    }
    if (q.startsWith('DELETE FROM truck_division_entries')) {
      (values[values.length - 1] || []).forEach(id => store.tde.delete(id));
      return Promise.resolve([]);
    }
    if (q.startsWith('WITH hits AS')) return Promise.resolve([{ removed: 0 }]);
    if (q.startsWith('DELETE FROM intercompany_billing_entries')) return Promise.resolve([]);

    throw new Error('Unexpected query in mock: ' + q.slice(0, 90));
  };
  return { sql, store };
}

// Raw timesheet_entries row shape (as returned by RETURNING *)
const entry = (over = {}) => ({
  id: 42, company_code: CO, username: 'barrmike', entry_type: 'daily',
  division: 'trucking', status: 'approved', work_date: '2026-08-12',
  job_id: 'Antero', job_label: 'Antero',
  start_time: '07:00', end_time: '15:30', computed_hours: 8.0,
  notes: '', truck_unit: '4000 SPRAY', truck_description: 'Water haul',
  ...over,
});

const manual = (num, over = {}) => ({
  id: `uuid-${num}`, task_number: num, actual_date: '2026-07-30',
  driver: 'Becker, Ben', customer: 'CNX', ...over,
});

const injected = (entryId, leg, over = {}) => ({
  id: truckingRowId(entryId, leg), task_number: '', actual_date: '2026-08-12',
  driver: 'Barr, Michael', customer: 'Antero', ...over,
});

(async () => {
  console.log('Truck Tracking task numbers\n');

  // ── the series ─────────────────────────────────────────────────────────
  console.log('[reading and writing a TR-####]');
  {
    assert('a task number parses to its sequence',    taskNumberSeq('TR-1016') === 1016);
    assert('surrounding whitespace is tolerated',      taskNumberSeq('  TR-0007 ') === 7);
    assert('a blank is 0, not NaN',                    taskNumberSeq('') === 0);
    assert('so is null/undefined',                     taskNumberSeq(null) === 0 && taskNumberSeq(undefined) === 0);
    assert('a number in some other format is 0',       taskNumberSeq('T-1') === 0 && taskNumberSeq('1016') === 0);
    assert('numbers are minted four-wide',             formatTaskNumber(7) === 'TR-0007');
    assert('and are not truncated past four',          formatTaskNumber(12345) === 'TR-12345');
    assert('the high-water mark spans the whole tab',
      maxTaskNumber([manual('TR-0009'), injected(42, 1), manual('TR-1016')]) === 1016);
    assert('an empty list has no high-water mark',     maxTaskNumber([]) === 0);
    assert('and junk in the list does not break it',
      maxTaskNumber([null, 'nope', { task_number: 'TR-0003' }]) === 3);
  }

  // ── the pure numbering rule ────────────────────────────────────────────
  console.log('\n[numbering a list]');
  {
    const list = [manual('TR-1016'), injected(42, 1), injected(43, 1), manual('TR-1015')];
    const { entries, assigned } = numberInjectedRows(list);
    assert('every blank payroll row is numbered', assigned.length === 2);
    assert('continuing the tab\'s own series, one series for the division',
      assigned[0].task_number === 'TR-1017' && assigned[1].task_number === 'TR-1018');
    assert('in list order, so the older approval takes the lower number',
      assigned[0].id === truckingRowId(42) && assigned[1].id === truckingRowId(43));
    assert('the rows come back carrying them',
      entries[1].task_number === 'TR-1017' && entries[2].task_number === 'TR-1018');
    assert('row order is untouched', entries.map(e => e.id).join() === list.map(e => e.id).join());
    assert('manual rows are left exactly alone',
      entries[0].task_number === 'TR-1016' && entries[3].task_number === 'TR-1015');
    assert('and the caller\'s rows are not mutated in place', list[1].task_number === '');

    // Idempotent: a number that has been shown to the office — or invoiced
    // under — must never be re-issued on the next read.
    const again = numberInjectedRows(entries);
    assert('a second pass mints nothing', again.assigned.length === 0);
    assert('and hands back the same numbers',
      again.entries[1].task_number === 'TR-1017' && again.entries[2].task_number === 'TR-1018');
  }
  {
    const held = numberInjectedRows([injected(42, 1, { task_number: 'TR-0500' })]);
    assert('a payroll row that already has a number keeps it',
      held.assigned.length === 0 && held.entries[0].task_number === 'TR-0500');

    // A manual row without a number is the tab's business — it mints its own on
    // add and on import, and renumbering one here would move a number the
    // office chose.
    const mine = numberInjectedRows([{ id: 'uuid-x', task_number: '' }]);
    assert('a blank manual row is not ours to number', mine.assigned.length === 0);

    assert('an empty list is a no-op', numberInjectedRows([]).assigned.length === 0);
    assert('so is a non-array', numberInjectedRows(null).entries.length === 0);
  }

  // ── minted at injection ────────────────────────────────────────────────
  console.log('\n[a newly approved entry arrives numbered]');
  {
    const { sql, store } = makeSql({ appData: { [BLOB_KEY]: [manual('TR-1016'), manual('TR-1015')] } });
    const row = await insertTruckingRow(sql, CO, entry(), { haul_fee: 121, division: 'Dust' });
    assert('the injected row has a task number', row.task_number === 'TR-1017');
    assert('taken from the tab\'s series, above every row already in it',
      maxTaskNumber(store.appData.get(BLOB_KEY)) === 1017);
    assert('the blob carries it', (store.appData.get(BLOB_KEY).find(r => r.id === row.id) || {}).task_number === 'TR-1017');
    assert('so does the mirror table', (store.tde.get(row.id) || {}).task_number === 'TR-1017');
    assert('manual rows are untouched by the injection',
      store.appData.get(BLOB_KEY).filter(r => r.task_number === 'TR-1016' || r.task_number === 'TR-1015').length === 2);
  }
  {
    const { sql } = makeSql({ appData: { [BLOB_KEY]: [] } });
    const row = await insertTruckingRow(sql, CO, entry());
    assert('an empty tab starts the series at TR-0001', row.task_number === 'TR-0001');
  }
  {
    // A split day is several hauls, and each is billed on its own line — so
    // each needs its own number, in leg order.
    const { sql, store } = makeSql({ appData: { [BLOB_KEY]: [manual('TR-0100')] } });
    const rows = await insertTruckingRows(sql, CO, entry({ id: 55 }), {
      haul_fee: 135,
      rows: [
        { company: 'CNX',    start_time: '07:00', end_time: '11:15' },
        { company: 'Antero', start_time: '11:15', end_time: '15:30' },
      ],
    });
    assert('each haul of a split day is numbered',
      rows[0].task_number === 'TR-0101' && rows[1].task_number === 'TR-0102');
    assert('no two hauls share a number',
      new Set(store.appData.get(BLOB_KEY).map(r => r.task_number)).size === 3);
  }

  // ── across a re-approval ───────────────────────────────────────────────
  console.log('\n[a correction does not renumber the haul]');
  {
    const { sql, store } = makeSql({ appData: { [BLOB_KEY]: [manual('TR-0100')] } });
    const first = await insertTruckingRow(sql, CO, entry({ id: 60 }), { haul_fee: 121 });
    // The office invoices it, then payroll corrects the hours and re-approves.
    const blob = store.appData.get(BLOB_KEY);
    blob.find(r => r.id === first.id).qb_invoice = 'INV-900';
    const again = await insertTruckingRow(sql, CO, entry({ id: 60, computed_hours: 12.5 }), { haul_fee: 121 });
    assert('the corrected row keeps the number it was invoiced under',
      again.task_number === first.task_number, `${first.task_number} → ${again.task_number}`);
    assert('the invoice number rides along with it', again.qb_invoice === 'INV-900');
    assert('and the series has not advanced',
      maxTaskNumber(store.appData.get(BLOB_KEY)) === taskNumberSeq(first.task_number));
  }
  {
    // Remove the first haul of a two-haul day and the second is rewritten under
    // the first one's id. That slot is different work now — it starts its
    // invoice sub-row clean, and it must not inherit the number the office
    // billed the first customer under either.
    const { sql } = makeSql({ appData: { [BLOB_KEY]: [] } });
    const before = await insertTruckingRows(sql, CO, entry({ id: 61 }), {
      haul_fee: 135,
      rows: [{ company: 'CNX' }, { company: 'Antero' }],
    });
    const after = await insertTruckingRows(sql, CO, entry({ id: 61 }), {
      haul_fee: 135,
      rows: [{ company: 'Antero' }],
    });
    assert('a leg whose customer changed takes a fresh number',
      after[0].id === before[0].id && after[0].task_number !== before[0].task_number,
      `${before[0].task_number} → ${after[0].task_number}`);
    assert('and never inherits one already billed to somebody else',
      ![before[0].task_number, before[1].task_number].includes(after[0].task_number));
  }

  // ── the read-time backfill ─────────────────────────────────────────────
  console.log('\n[rows injected before any of this get numbered on read]');
  {
    const stale = [
      manual('TR-1016'),
      injected(70, 1),                                     // blank, pre-dates the mint
      injected(71, 1, { task_number: 'TR-0004' }),         // already numbered
    ];
    const { sql, store } = makeSql({
      appData: { [BLOB_KEY]: stale.map(r => ({ ...r })) },
      tde: stale.map(r => ({ ...r })),
    });
    const { entries, assigned } = await backfillInjectedTaskNumbers(sql, CO, store.appData.get(BLOB_KEY));
    assert('the blank payroll row is numbered', assigned.length === 1 && assigned[0].task_number === 'TR-1017');
    assert('the served list carries it, so the tab shows it on the same load',
      entries.find(r => r.id === truckingRowId(70)).task_number === 'TR-1017');
    assert('the blob is patched, so the number is the same on the next load',
      store.appData.get(BLOB_KEY).find(r => r.id === truckingRowId(70)).task_number === 'TR-1017');
    assert('the mirror table is patched too — the report and IC read it directly',
      store.tde.get(truckingRowId(70)).task_number === 'TR-1017');
    assert('a payroll row that already had a number is left alone',
      store.appData.get(BLOB_KEY).find(r => r.id === truckingRowId(71)).task_number === 'TR-0004');
    assert('and so is every manual row',
      store.appData.get(BLOB_KEY).find(r => r.id === 'uuid-TR-1016').task_number === 'TR-1016');

    // Steady state is every load after the first, and it must not write.
    const before = store.queries.length;
    const second = await backfillInjectedTaskNumbers(sql, CO, store.appData.get(BLOB_KEY));
    assert('a list with nothing blank writes nothing at all',
      second.assigned.length === 0 && store.queries.length === before);
  }
  {
    // The blob patch only ever fills a blank, so a number minted by a
    // concurrent read (or by payroll re-injecting) is never overwritten.
    const { sql, store } = makeSql({ appData: { [BLOB_KEY]: [injected(72, 1)] } });
    const list = store.appData.get(BLOB_KEY).map(r => ({ ...r }));
    store.appData.set(BLOB_KEY, [{ ...list[0], task_number: 'TR-0777' }]);   // someone got there first
    await backfillInjectedTaskNumbers(sql, CO, list);
    assert('a number that landed mid-flight is not overwritten',
      store.appData.get(BLOB_KEY)[0].task_number === 'TR-0777');
  }

  // ── the wiring ─────────────────────────────────────────────────────────
  console.log('\n[the two places this has to be plugged in]');
  {
    const DIV = fs.readFileSync(path.resolve(__dirname, '../api/truck-division.js'), 'utf8');
    assert('api/truck-division runs the backfill on read',
      /backfillInjectedTaskNumbers\(sql, companyCode, entries\)/.test(DIV));
    assert('on both the blob and the normalized-table paths',
      (DIV.match(/backfillInjectedTaskNumbers\(sql, companyCode, entries\)/g) || []).length === 2);
    assert('non-fatally — a numbering that fails must not take the tab with it',
      /catch \(err\) \{\s*console\.error\('\[truck-division\] task-number backfill failed/.test(DIV));

    const PAGE = fs.readFileSync(path.resolve(__dirname, '../trucking.html'), 'utf8');
    assert('trucking.html renders the number beside the Timesheet badge',
      /const tsTaskCell = `<div[^`]*\$\{tsBadge\}\$\{\s*\n?\s*e\.task_number \? `<span>\$\{esc\(e\.task_number\)\}<\/span>` : ''\}/.test(PAGE));
    assert('and the Task Number cell is that pair, not the badge alone',
      /<td class="td-task-num">\$\{tsTaskCell\}<\/td>/.test(PAGE));

    // task_number is payroll's to mint. On TRUCK_TAB_FIELDS the tab could write
    // it, and injected-blob-guard would replay whatever the page sent — which
    // is how a number would start drifting between the two writers.
    assert('and a tab save cannot move it', !TRUCK_TAB_FIELDS.includes('task_number'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
