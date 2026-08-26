#!/usr/bin/env node
'use strict';
/**
 * A division tab's whole-blob save must not destroy payroll's rows.
 *
 * Run: node scripts/test-injected-blob-guard.js
 *
 * Trucking and the two quarry tabs keep their cost tracking in a JSON blob that
 * the tab saves WHOLE, and payroll writes into those same blobs on approval.
 * The tab's copy is always the stale one — it was read before the approval it
 * is about to overwrite — so before the guard:
 *
 *   - payroll approved while the tab was open, the tab's next cell edit saved
 *     the list it had loaded, and the injected row was GONE. The entry still
 *     read 'approved' in payroll, so nothing flagged it: the hours never
 *     reached cost tracking or billing, and the tab refuses to let anyone add
 *     the row back by hand.
 *   - payroll un-approved while the tab was open, and the same stale save put
 *     the row back, re-billing work that had been withdrawn.
 *
 * Also covers the third defect found in the same audit: re-injecting a
 * corrected entry rebuilt the Truck Tracking row from scratch, wiping the QB
 * invoice number and invoiced/sent/paid dates the trucking office had entered
 * on it. The dust EES injector already preserved its one tab-owned column;
 * trucking preserved none.
 *
 * No DB or server required.
 */

const path = require('path');
const fs   = require('fs');
const {
  INJECTED_BLOBS, TRUCK_TAB_FIELDS, guardConfigFor,
  mergeInjectedRows, guardInjectedBlobWrite,
} = require('../api/lib/injected-blob-guard.js');
const { insertTruckingRow, TRUCK_DIVISION_BLOB } = require('../api/timesheet-entries.js')._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const TRUCK = guardConfigFor('fct_truck_division');
const QUARRY = guardConfigFor('fct_quarry_daily');

const office = (id, over = {}) => ({ id, driver: 'Nick', total_hours: 8, haul_fee: 121, customer: 'Kinkead', ...over });
const payroll = (id, over = {}) => ({ id, driver: 'Mike Barr', total_hours: 12.5, haul_fee: 121,
  customer: 'Antero', qb_invoice: '', invoiced_date: '', invoice_sent_date: '',
  invoice_status: 'Unpaid', date_paid: '', ...over });

(async () => {
  console.log('Payroll rows survive a division tab save\n');

  // ── The row the tab never saw ───────────────────────────────────────────
  console.log('[a row injected after the tab loaded]');
  {
    const server   = [office('TR-1001'), payroll('tst-42-row')];
    const incoming = [office('TR-1001')];                       // loaded before the approval
    const merged   = mergeInjectedRows(server, incoming, TRUCK);
    assert('the payroll row is kept', merged.some(r => r.id === 'tst-42-row'));
    assert('the office row is kept too', merged.some(r => r.id === 'TR-1001'));
    assert('nothing else invented', merged.length === 2);
  }

  // ── The row payroll withdrew ────────────────────────────────────────────
  console.log('\n[a row payroll un-approved while the tab was open]');
  {
    const server   = [office('TR-1001')];                       // payroll already removed it
    const incoming = [office('TR-1001'), payroll('tst-42-row')];// tab still holds it
    const merged   = mergeInjectedRows(server, incoming, TRUCK);
    assert('the stale payroll row is NOT resurrected', !merged.some(r => r.id === 'tst-42-row'));
    assert('the office row is untouched', merged.length === 1 && merged[0].id === 'TR-1001');
  }

  // ── The tab still owns its own rows completely ──────────────────────────
  console.log('\n[the tab keeps full authority over its own rows]');
  {
    const server   = [office('TR-1001', { customer: 'OLD' }), office('TR-1002')];
    const incoming = [office('TR-1001', { customer: 'NEW', notes: 'called ahead' })];
    const merged   = mergeInjectedRows(server, incoming, TRUCK);
    assert('an edit to an office row lands', merged[0].customer === 'NEW');
    assert('a note added to an office row lands', merged[0].notes === 'called ahead');
    assert('an office row the save omitted is deleted, as intended',
      merged.length === 1, JSON.stringify(merged.map(r => r.id)));
  }

  // ── Payroll's columns vs the office's columns on one row ────────────────
  console.log('\n[who owns which column of a payroll row]');
  {
    const server   = [payroll('tst-42-row', { total_hours: 12.5, haul_fee: 121, customer: 'Antero' })];
    const incoming = [payroll('tst-42-row', {
      total_hours: 99, haul_fee: 1, customer: 'HACKED', driver: 'nobody',   // payroll's — must not land
      qb_invoice: 'QB-8891', invoiced_date: '2026-08-15',                    // office's  — must land
      invoice_sent_date: '2026-08-16', invoice_status: 'Paid', date_paid: '2026-08-20',
    })];
    const [row] = mergeInjectedRows(server, incoming, TRUCK);
    assert('hours stay payroll\'s',    Number(row.total_hours) === 12.5, String(row.total_hours));
    assert('haul fee stays payroll\'s', Number(row.haul_fee) === 121);
    assert('customer stays payroll\'s', row.customer === 'Antero');
    assert('driver stays payroll\'s',   row.driver === 'Mike Barr');
    assert('QB invoice number lands',   row.qb_invoice === 'QB-8891');
    assert('invoiced date lands',       row.invoiced_date === '2026-08-15');
    assert('sent date lands',           row.invoice_sent_date === '2026-08-16');
    assert('paid status lands',         row.invoice_status === 'Paid');
    assert('date paid lands',           row.date_paid === '2026-08-20');
  }

  // ── Quarry: the tab owns none of an injected row ────────────────────────
  console.log('\n[quarry rows are read-only in the tab, so entirely payroll\'s]');
  {
    const server   = [{ id: 'tsq-7-1755', hours: 8, rate: 32, employeeName: 'Jamey' }];
    const incoming = [{ id: 'tsq-7-1755', hours: 99, rate: 0, employeeName: 'someone else' }];
    const [row] = mergeInjectedRows(server, incoming, QUARRY);
    assert('every column comes back from the server',
      Number(row.hours) === 8 && Number(row.rate) === 32 && row.employeeName === 'Jamey');
    assert('a quarry save that omits the row still keeps it',
      mergeInjectedRows(server, [], QUARRY).length === 1);
  }

  // ── Ordering and edge cases ─────────────────────────────────────────────
  console.log('\n[ordering and edges]');
  {
    const server   = [office('TR-1'), payroll('tst-1-row'), office('TR-2'), payroll('tst-2-row')];
    const incoming = [office('TR-2'), payroll('tst-1-row'), office('TR-1')];
    const merged   = mergeInjectedRows(server, incoming, TRUCK);
    assert('the tab\'s own ordering is preserved',
      merged.slice(0, 3).map(r => r.id).join(',') === 'TR-2,tst-1-row,TR-1',
      merged.map(r => r.id).join(','));
    assert('a row the save never mentioned is appended',
      merged[3] && merged[3].id === 'tst-2-row', merged.map(r => r.id).join(','));
  }
  {
    const server = [payroll('tst-1-row')];
    assert('a duplicate payroll row in the save collapses to one',
      mergeInjectedRows(server, [payroll('tst-1-row'), payroll('tst-1-row')], TRUCK).length === 1);
    assert('an empty save still keeps payroll\'s rows',
      mergeInjectedRows(server, [], TRUCK).length === 1);
    assert('an empty server list drops the tab\'s stale payroll rows',
      mergeInjectedRows([], [payroll('tst-1-row')], TRUCK).length === 0);
    assert('non-object junk in the save is left alone',
      mergeInjectedRows(server, ['junk', 7], TRUCK).filter(r => r === 'junk' || r === 7).length === 2);
  }

  // ── guardInjectedBlobWrite: only touches the keys that need it ──────────
  console.log('\n[the guard stays out of the way]');
  {
    const store = new Map();
    let reads = 0;
    const sql = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT value FROM app_data')) {
        reads++;
        const v = store.get(values[0]);
        return Promise.resolve(v === undefined ? [] : [{ value: v }]);
      }
      throw new Error('unexpected query: ' + q);
    };
    const untouched = [{ id: 'x' }];
    const out = await guardInjectedBlobWrite(sql, 'ACME', 'fct_projects', untouched);
    assert('an unguarded key is passed straight through', out === untouched);
    assert('and costs no query', reads === 0);

    store.set('ACME:fct_truck_division', [office('TR-1')]);
    const same = await guardInjectedBlobWrite(sql, 'ACME', 'fct_truck_division', [office('TR-1')]);
    assert('a guarded key with no payroll rows is passed through', same.length === 1 && same[0].id === 'TR-1');

    store.set('ACME:fct_truck_division', [office('TR-1'), payroll('tst-9-row')]);
    const kept = await guardInjectedBlobWrite(sql, 'ACME', 'fct_truck_division', [office('TR-1')]);
    assert('a guarded key restores the omitted payroll row',
      kept.length === 2 && kept.some(r => r.id === 'tst-9-row'));

    const notArray = await guardInjectedBlobWrite(sql, 'ACME', 'fct_truck_division', { nope: true });
    assert('a non-array value is left alone', notArray && notArray.nope === true);
  }

  // ── Re-injection preserves the office's invoice columns ────────────────
  console.log('\n[correcting an entry keeps the invoice already raised against it]');
  {
    const CO = 'ACME', KEY = `${CO}:${TRUCK_DIVISION_BLOB}`;
    const store = new Map();
    const sql = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT value FROM app_data')) {
        let k = values[0];
        if (k === undefined) { const m = q.match(/key = '([^']*)'/); k = m ? m[1] : undefined; }
        const v = store.get(k);
        return Promise.resolve(v === undefined ? [] : [{ value: v }]);
      }
      if (q.startsWith('INSERT INTO app_data')) {
        store.set(values[0], typeof values[1] === 'string' ? JSON.parse(values[1]) : values[1]);
        return Promise.resolve([]);
      }
      if (q.includes('FROM dropdown_lists')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    const entry = {
      id: 42, company_code: CO, username: 'barrmike', entry_type: 'daily', division: 'trucking',
      work_date: '2026-08-12', job_id: 'Antero', job_label: 'Antero',
      start_time: '05:00', end_time: '17:30', computed_hours: 12.5, travel_hours: 6,
    };
    store.set(KEY, []);
    await insertTruckingRow(sql, CO, entry, { haul_fee: 121 });

    // the trucking office invoices the row
    const arr = store.get(KEY);
    Object.assign(arr[0], {
      qb_invoice: 'QB-8891', invoiced_date: '2026-08-13',
      invoice_sent_date: '2026-08-13', invoice_status: 'Paid', date_paid: '2026-08-20',
    });
    store.set(KEY, arr);

    // payroll corrects the hours and re-approves
    await insertTruckingRow(sql, CO, { ...entry, travel_hours: 0 }, { haul_fee: 121 });
    const [row] = store.get(KEY);
    assert('the correction lands', Number(row.total_hours) === 12.5, String(row.total_hours));
    assert('QB invoice number survives',  row.qb_invoice === 'QB-8891', row.qb_invoice);
    assert('invoiced date survives',      row.invoiced_date === '2026-08-13');
    assert('sent date survives',          row.invoice_sent_date === '2026-08-13');
    assert('paid status survives',        row.invoice_status === 'Paid', row.invoice_status);
    assert('date paid survives',          row.date_paid === '2026-08-20');
    assert('every office column is covered', TRUCK_TAB_FIELDS.length === 5, TRUCK_TAB_FIELDS.join(','));
  }

  // ── The write paths actually call the guard ─────────────────────────────
  console.log('\n[both whole-blob writers are wired to it]');
  {
    const td = fs.readFileSync(path.resolve(__dirname, '../api/truck-division.js'), 'utf8');
    assert('api/truck-division PUT guards the write',
      /stored = await guardInjectedBlobWrite\(sql, companyCode, 'fct_truck_division', entries\)/.test(td));
    assert('and stores the guarded value',
      /VALUES \(\$\{companyCode \+ ':fct_truck_division'\}, \$\{JSON\.stringify\(stored\)\}/.test(td));
    assert('and mirrors the guarded value',
      /_syncToTables\(sql, companyCode, stored, safeLists\)/.test(td));

    const dk = fs.readFileSync(path.resolve(__dirname, '../api/data/[key].js'), 'utf8');
    assert('api/data/[key] PUT guards the write',
      /stored = await guardInjectedBlobWrite\(sql, payload\.companyCode, key, value\)/.test(dk));
    assert('and stores the guarded value', /JSON\.stringify\(stored\)/.test(dk));
    assert('and mirrors the guarded value', /syncForKey\(sql, payload\.companyCode, key, stored\)/.test(dk));

    // Payroll injects into four of these. The fifth, fct_quarry_sales, is the
    // Quarry Sales form's — a different writer, the same race: Sales Tracking
    // saves the whole grid on a debounce, so a sale submitted while the tab is
    // open is one keystroke away from being erased.
    assert('every blob written from outside its tab is registered',
      Object.keys(INJECTED_BLOBS).sort().join(',') ===
      'dust_other_billing_rows,fct_quarry_crushing,fct_quarry_daily,fct_quarry_sales,fct_truck_division',
      Object.keys(INJECTED_BLOBS).join(','));
    // dust_ees_other_rows is the deliberate omission — it version-checks its own
    // writes and merges on conflict. If that ever stops being true it belongs here.
    const dust = fs.readFileSync(path.resolve(__dirname, '../dust.html'), 'utf8');
    assert('dust EES still version-checks its save instead',
      /body: JSON\.stringify\(\{ value: eeRows, baseUpdatedAt: eeUpdatedAt \}\)/.test(dust));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
