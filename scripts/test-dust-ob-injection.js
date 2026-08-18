#!/usr/bin/env node
'use strict';
/**
 * Dust timesheet → "Other Billing" injection tests.
 *
 * Run: node scripts/test-dust-ob-injection.js
 *
 * A dust customer haul is either UB on a well pad or a delivery of material,
 * and the dust office invoices those off two different grids on two different
 * bases. Which one a haul bills off is answered PER HAUL in the payroll approve
 * modal, so one approved day can post rows in both. This exercises that routing
 * against an in-memory mock of the `sql` tagged template. Verifies:
 *   - a leg marked dest:'ob' posts an Other Billing row and NOT a tracking row,
 *     and a leg left alone still posts a tracking row and no Other Billing row,
 *   - the row autofills date, driver, truck and customer from the timesheet and
 *     takes material, quantity, MU, price, trailer and trucking rate from the
 *     modal,
 *   - trucking hours come from the leg's own clock window, wrapping at midnight
 *     the way dust.html's own calc() does,
 *   - the destination follows the customer's pads and carries the state with it,
 *   - leg ids number by position in the DAY, so a mixed day interleaves and a
 *     haul re-pointed at the other grid keeps its place,
 *   - flipping a leg's destination MOVES the row: the old grid's row and its
 *     Intercompany billing entry go, the new grid's appears,
 *   - injection is idempotent and preserves the invoice columns the dust office
 *     owns, but starts clean when the slot's customer changed,
 *   - un-approve removes the rows and their Intercompany billing entries,
 *   - the read-time sweep drops rows whose entry is gone, un-approved or moved,
 *   - the blob guard keeps the tab's own saves from dropping or rewriting one.
 *
 * No DB or server required.
 */

const fs   = require('fs');
const path = require('path');
const { _test } = require('../api/timesheet-entries.js');
const {
  legDest, legHours, validateDustInjection, dustOptionsForEntry,
  insertDustTrackingRows, insertObRows, removeObRows, obHasInjectedRow,
  obSplitForEntry, dustSplitForEntry, matchDustEmployee, OB_BLOB_KEY,
} = _test;
const {
  obRowId, obRowIndexFromId, isInjectedObRowId, findStaleObRows,
  sweepInjectedObRows, needsObRow, OB_TAB_FIELDS, MAX_OB_ROWS,
} = require('../api/lib/dust-ob-injected.js');
const { mergeInjectedRows, guardConfigFor } = require('../api/lib/injected-blob-guard.js');

const IC_BLOB         = 'fct_intercompany_billing_entries';
const IC_REMOVED_BLOB = 'fct_intercompany_removed_entries';

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── In-memory mock of the neon `sql` tagged template ────────────────────────
// Same surfaces test-dust-injection.js backs, plus the app_data blob the Other
// Billing grid lives in and the dropdown lists the modal is offered.
function makeSql(initial = {}) {
  const store = {
    companies: (initial.companies || []).slice(),
    men:       (initial.men       || []).slice(),
    locations: (initial.locations || []).slice(),
    equipment: (initial.equipment || []).slice(),
    dce:       new Map((initial.dce || []).map(r => [r.id, r])),
    appData:   new Map(Object.entries(initial.appData || {})),
    icMirror:  new Map(Object.entries(initial.icMirror || {})),
    entries:   new Map((initial.entries || []).map(e => [Number(e.id), e])),
    lists:     Object.assign({}, initial.lists || {}),
    audits:    [],
  };
  const like = (v, pattern) => String(v).startsWith(String(pattern).replace(/%$/, ''));

  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();

    if (q.startsWith('SELECT id, name, v1_rate, v2_rate FROM dust_companies') && !q.includes('ORDER BY name')) {
      const [, needle] = values;
      const byId = q.includes('AND id =');
      return Promise.resolve(store.companies.filter(c => (byId ? c.id : c.name) === needle));
    }
    if (q.startsWith('SELECT id, name, v1_rate, v2_rate FROM dust_companies')) {
      return Promise.resolve(store.companies.slice().sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (q.startsWith('SELECT name FROM dust_company_personnel')) {
      return Promise.resolve(store.men.filter(m => m.dust_company_id === values[0]));
    }
    if (q.startsWith('SELECT name, state FROM dust_company_locations')) {
      return Promise.resolve(store.locations.filter(l => l.dust_company_id === values[0]));
    }
    if (q.startsWith('SELECT name, unit_number, vehicle_rate FROM dust_equipment')) {
      return Promise.resolve(store.equipment.slice());
    }
    if (q.startsWith('SELECT vehicle2 FROM dust_control_entries')) {
      const [, company, minePrefix] = values;
      const hits = [...store.dce.values()]
        .filter(r => r.company === company && r.vehicle2 && !like(r.id, minePrefix))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      return Promise.resolve(hits.length ? [{ vehicle2: hits[0].vehicle2 }] : []);
    }
    if (q.startsWith('SELECT * FROM dust_control_entries') && q.includes('AND id =')) {
      const r = store.dce.get(values[1]);
      return Promise.resolve(r ? [r] : []);
    }
    if (q.startsWith('SELECT * FROM dust_control_entries') && q.includes('AND id LIKE')) {
      return Promise.resolve([...store.dce.values()].filter(r => like(r.id, values[1])));
    }
    if (q.startsWith('SELECT id FROM dust_control_entries') && q.includes('id LIKE')) {
      return Promise.resolve([...store.dce.values()].filter(r => like(r.id, values[1])).map(r => ({ id: r.id })));
    }
    if (q.startsWith('INSERT INTO dust_control_entries')) {
      const [id, , date, start_time, end_time, company, company_man, location, state,
             vehicle1, v1_unit, v1_rate, vehicle2, v2_unit, v2_rate, gallons_ub,
             inv_number, inv_sent, inv_received, inv_status, cm_approval, inv_location] = values;
      store.dce.set(id, {
        id, date, start_time, end_time, company, company_man, location, state,
        vehicle1, v1_unit, v1_rate, vehicle2, v2_unit, v2_rate, gallons_ub,
        inv_number, inv_sent, inv_received, inv_status, cm_approval, inv_location,
      });
      return Promise.resolve([]);
    }
    if (q.startsWith('DELETE FROM dust_control_entries')) {
      (values[values.length - 1] || []).forEach(id => store.dce.delete(id));
      return Promise.resolve([]);
    }
    if (q.startsWith('INSERT INTO dust_control_audit_log')) {
      store.audits.push({ row_id: values[1], action: values[2] });
      return Promise.resolve([]);
    }
    // removeIcBillingEntries: key, source, ids, source, ids, key
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
      (values[values.length - 1] || []).forEach(id => store.icMirror.delete(id));
      return Promise.resolve([]);
    }
    // Two UPDATE app_data shapes share the jsonb_array_elements rebuild; the
    // column they filter on is what tells them apart — the same discriminator
    // test-trucking-injection.js uses.
    if (q.startsWith('UPDATE app_data') && q.includes("t->>'id'")) {
      // deleteObRows: ids, key
      const [ids, key] = values;
      const cur = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([]);
      store.appData.set(key, cur.filter(r => !(r && ids.includes(String(r.id)))));
      return Promise.resolve([]);
    }
    if (q.startsWith('UPDATE app_data') && q.includes('jsonb_array_elements')) {
      // clearIcSuppression: source, sourceId, key
      const [source, sourceId, key] = values;
      const cur = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([]);
      const next = cur.filter(t => !(t && t.source === source && t.source_id === sourceId));
      if (next.length === cur.length) return Promise.resolve([]);
      store.appData.set(key, next);
      return Promise.resolve([{ cleared: 1 }]);
    }
    if (q.startsWith('SELECT value FROM dropdown_lists')) {
      return Promise.resolve((store.lists[values[1]] || []).map(v => ({ value: v })));
    }
    if (q.startsWith('SELECT value FROM app_data')) {
      const key = values[0];
      return Promise.resolve(store.appData.has(key) ? [{ value: store.appData.get(key) }] : []);
    }
    if (q.startsWith('INSERT INTO app_data')) {
      store.appData.set(values[0], JSON.parse(values[1]));
      return Promise.resolve([]);
    }
    if (q.startsWith('SELECT id, status, entry_type, division, job_id FROM timesheet_entries')) {
      const ids = values[values.length - 1] || [];
      return Promise.resolve(ids.map(id => store.entries.get(Number(id))).filter(Boolean));
    }
    throw new Error('Unexpected query in mock: ' + q.slice(0, 100));
  };
  return { sql, store };
}

const CO      = 'ACME';
const OB_KEY  = `${CO}:${OB_BLOB_KEY}`;
const ENTRY   = {
  id: 41, username: 'jdoe', division: 'dust', entry_type: 'daily', status: 'approved',
  job_id: 'co-1', job_label: 'CNX', work_date: '2026-08-04',
  start_time: '06:00', end_time: '16:00', computed_hours: 9.5,
  truck_unit: 'Distributor Truck 4000', notes: 'two loads of ClearFrac',
};

const FIXTURE = {
  companies: [
    { id: 'co-1', name: 'CNX',    v1_rate: 130, v2_rate: 65 },
    { id: 'co-2', name: 'Antero', v1_rate: 140, v2_rate: null },
  ],
  men:       [{ dust_company_id: 'co-1', name: 'Bill Reed' }],
  locations: [
    { dust_company_id: 'co-1', name: 'Bear Hollow', state: 'PA' },
    { dust_company_id: 'co-2', name: 'Shale Run',   state: 'WV' },
  ],
  equipment: [
    { name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 120 },
    { name: 'Escort 12',              unit_number: '12',   vehicle_rate: 60 },
  ],
  lists: {
    dust_employees: ['John Doe', 'Pat Reilly'],
    dust_materials: ['ClearFrac', 'Calcium Chloride'],
    dust_mu:        ['GAL', 'BAG'],
  },
  entries: [{ id: 41, status: 'approved', entry_type: 'daily', division: 'dust', job_id: 'co-1' }],
};

const obRows = store => (store.appData.get(OB_KEY) || []);
const obRow  = (store, leg) => obRows(store).find(r => r.id === obRowId(ENTRY.id, leg)) || null;

console.log('Dust timesheet → Other Billing injection\n');

(async () => {

  // ── 1) Identity ───────────────────────────────────────────────────────────
  console.log('[row identity]');
  {
    assert('leg 1 is -1, not the tracking side\'s -row', obRowId(41, 1) === 'tso-41-1');
    assert('later legs number by position in the day', obRowId(41, 3) === 'tso-41-3');
    assert('an id round-trips to its leg', obRowIndexFromId('tso-41-3') === 3);
    assert('a leg past the cap is not a leg',
      obRowIndexFromId(`tso-41-${MAX_OB_ROWS + 1}`) === null);
    assert('a Date.now()-shaped leftover is not a leg',
      obRowIndexFromId('tso-41-1754308800000') === null);
    assert('a hand-added row is never ours', !isInjectedObRowId('m8x2p1'));
    assert('the tracking prefix is never ours', !isInjectedObRowId('tsd-41-row'));
    assert('the entry-level gate is the dust customer haul',
      needsObRow(ENTRY) === true
      && needsObRow({ ...ENTRY, job_id: 'ees:washing' }) === false
      && needsObRow({ ...ENTRY, job_id: '' }) === false
      && needsObRow({ ...ENTRY, division: 'trucking' }) === false);
  }

  // ── 2) The destination on a leg ───────────────────────────────────────────
  console.log('\n[which grid a haul bills off]');
  {
    assert('absent means the tracking grid', legDest({}) === 'dust');
    assert('bulk approve means the tracking grid', legDest(undefined) === 'dust');
    assert('ob is the only other answer', legDest({ dest: 'ob' }) === 'ob');
    const ok = validateDustInjection({ rows: [{ dest: 'ob' }, { dest: 'dust' }] });
    assert('both answers validate', !ok.error && ok.rows.length === 2, ok.error);
    assert('and are carried onto the legs',
      ok.rows[0].dest === 'ob' && ok.rows[1].dest === 'dust');
    const bad = validateDustInjection({ rows: [{ dest: 'other' }] });
    assert('a typo is refused rather than coerced', /dest must be/.test(bad.error || ''), bad.error);
    const nums = validateDustInjection({ rows: [{ dest: 'ob', gallons_bags: -1 }] });
    assert('a negative quantity is refused', /gallons_bags/.test(nums.error || ''), nums.error);
    const price = validateDustInjection({ rows: [{ dest: 'ob', price_per_unit: 'x' }] });
    assert('a non-numeric price is refused', /price_per_unit/.test(price.error || ''), price.error);
    const blank = validateDustInjection({ rows: [{ dest: 'ob', material: '', mu: '' }] });
    assert('a cleared box is present and empty, not absent',
      blank.rows[0].material === '' && blank.rows[0].mu === '');
  }

  // ── 3) Hours off the leg's own window ─────────────────────────────────────
  console.log('\n[trucking hours come from the haul\'s window]');
  {
    assert('a plain window', legHours('06:00', '16:00') === 10);
    assert('to the quarter hour', legHours('06:00', '11:45') === 5.75);
    assert('a night haul wraps at midnight the way the tab does',
      legHours('22:00', '02:00') === 4);
    assert('no window is no hours, not zero hours', legHours('', '16:00') === '');
    assert('a junk time is no hours', legHours('nope', '16:00') === '');
  }

  // ── 4) A single material haul ─────────────────────────────────────────────
  console.log('\n[one haul, billed as material]');
  {
    const { sql, store } = makeSql(FIXTURE);
    const legs = [{
      dest: 'ob', location: 'Bear Hollow', material: 'ClearFrac',
      gallons_bags: 4000, mu: 'GAL', price_per_unit: 0.42,
      trailer_number: 'TR-9', trucking_rate: 95,
    }];
    await insertDustTrackingRows(sql, CO, ENTRY, legs, { clearSuppression: true });
    await insertObRows(sql, CO, ENTRY, legs, { clearSuppression: true });

    const row = obRow(store, 1);
    assert('the Other Billing row is written', !!row);
    assert('and NO Dust Control Tracking row is', store.dce.size === 0, [...store.dce.keys()].join(','));
    assert('date comes off the timesheet', row.date === '2026-08-04');
    assert('driver is matched to the dust roster', row.driver === 'John Doe', row.driver);
    assert('customer is the one the driver picked', row.customer === 'CNX');
    assert('the truck is stored as its unit NUMBER', row.truck_number === '4000', row.truck_number);
    assert('trailer is the approver\'s', row.trailer_number === 'TR-9');
    assert('destination is the approver\'s', row.destination === 'Bear Hollow');
    assert('and carries the state with it', row.state === 'PA');
    assert('material, quantity, MU and price are the approver\'s',
      row.material === 'ClearFrac' && row.gallons_bags === 4000
      && row.mu === 'GAL' && row.price_per_unit === 0.42);
    assert('trucking rate is the approver\'s', row.trucking_rate === 95);
    assert('trucking hours are the haul\'s window', row.trucking_hrs === 10, String(row.trucking_hrs));
    assert('comments seed from the driver\'s notes', row.comments === 'two loads of ClearFrac');
    assert('the invoice number starts empty', row.inv_number === '');
    assert('the window is kept so a re-edit can restore it',
      row.start_time === '06:00' && row.end_time === '16:00');
  }

  // ── 5) A day across both grids ────────────────────────────────────────────
  console.log('\n[a day split across both dust grids]');
  {
    const { sql, store } = makeSql(FIXTURE);
    // UB first, material second, UB third — the interleaving is the point.
    const legs = [
      { dest: 'dust', start_time: '06:00', end_time: '09:00', location: 'Bear Hollow', gallons_ub: 3000 },
      { dest: 'ob',   start_time: '09:00', end_time: '13:00', company: 'Antero',
        location: 'Shale Run', material: 'Calcium Chloride', gallons_bags: 40, mu: 'BAG',
        price_per_unit: 12.5, trucking_rate: 95 },
      { dest: 'dust', start_time: '13:00', end_time: '16:00', location: 'Bear Hollow', gallons_ub: 2000 },
    ];
    await insertDustTrackingRows(sql, CO, ENTRY, legs, { clearSuppression: true });
    await insertObRows(sql, CO, ENTRY, legs, { clearSuppression: true });

    assert('the tracking grid takes legs 1 and 3',
      store.dce.has('tsd-41-row') && store.dce.has('tsd-41-3') && store.dce.size === 2,
      [...store.dce.keys()].join(','));
    assert('Other Billing takes leg 2 — its place in the DAY',
      obRows(store).length === 1 && !!obRow(store, 2), obRows(store).map(r => r.id).join(','));
    assert('the material leg bills its own customer', obRow(store, 2).customer === 'Antero');
    assert('and its own pad and state',
      obRow(store, 2).destination === 'Shale Run' && obRow(store, 2).state === 'WV');
    assert('and its own hours', obRow(store, 2).trucking_hrs === 4);

    const { rows: dustBack } = await dustSplitForEntry(sql, CO, ENTRY);
    const { rows: obBack }   = await obSplitForEntry(sql, CO, ENTRY);
    assert('the split lookup tags each tracking row with its leg',
      dustBack.map(r => r.leg).join(',') === '1,3', dustBack.map(r => r.leg).join(','));
    assert('and the Other Billing row with its own',
      obBack.length === 1 && obBack[0].leg === 2);
    assert('each side says which grid it came from',
      dustBack.every(r => r.dest === 'dust') && obBack.every(r => r.dest === 'ob'));
    assert('so the modal can rebuild the day in order',
      [...dustBack, ...obBack].sort((a, b) => a.leg - b.leg).map(r => r.dest).join(',')
        === 'dust,ob,dust');
  }

  // ── 6) Flipping a haul's destination ──────────────────────────────────────
  console.log('\n[re-pointing a haul at the other grid moves it]');
  {
    const { sql, store } = makeSql({
      ...FIXTURE,
      appData: { [`${CO}:${IC_BLOB}`]: [] },
    });
    const asUb = [{ dest: 'dust', location: 'Bear Hollow', gallons_ub: 4000 }];
    await insertDustTrackingRows(sql, CO, ENTRY, asUb, { clearSuppression: true });
    await insertObRows(sql, CO, ENTRY, asUb, { clearSuppression: true });
    assert('it starts as a tracking row', store.dce.size === 1 && obRows(store).length === 0);

    // Intercompany picked the tracking row up, the way the dust tab's auto-sync
    // would have; the flip has to take that billing entry with it.
    store.appData.set(`${CO}:${IC_BLOB}`, [{ source: 'dust', source_id: 'tsd-41-row', amount: 700 }]);

    const asMaterial = [{
      dest: 'ob', location: 'Bear Hollow', material: 'ClearFrac',
      gallons_bags: 4000, mu: 'GAL', price_per_unit: 0.42, trucking_rate: 95,
    }];
    await insertDustTrackingRows(sql, CO, ENTRY, asMaterial);
    await insertObRows(sql, CO, ENTRY, asMaterial);

    assert('the tracking row is gone', store.dce.size === 0, [...store.dce.keys()].join(','));
    assert('and so is its Intercompany billing entry',
      (store.appData.get(`${CO}:${IC_BLOB}`) || []).length === 0);
    assert('the Other Billing row has taken its place',
      obRows(store).length === 1 && !!obRow(store, 1));
    assert('at the same leg of the day', obRowIndexFromId(obRow(store, 1).id) === 1);

    // …and back again.
    store.appData.set(`${CO}:${IC_BLOB}`, [{ source: 'dust-other-billing', source_id: 'tso-41-1', amount: 2630 }]);
    await insertDustTrackingRows(sql, CO, ENTRY, asUb);
    await insertObRows(sql, CO, ENTRY, asUb);
    assert('flipping back restores the tracking row', store.dce.size === 1);
    assert('and takes the Other Billing row away', obRows(store).length === 0);
    assert('with its billing entry',
      (store.appData.get(`${CO}:${IC_BLOB}`) || []).length === 0,
      JSON.stringify(store.appData.get(`${CO}:${IC_BLOB}`)));
  }

  // ── 7) Re-injection ───────────────────────────────────────────────────────
  console.log('\n[re-approving is idempotent, and keeps the office\'s columns]');
  {
    const { sql, store } = makeSql(FIXTURE);
    const legs = [{ dest: 'ob', location: 'Bear Hollow', material: 'ClearFrac',
                    gallons_bags: 4000, mu: 'GAL', price_per_unit: 0.42, trucking_rate: 95 }];
    await insertObRows(sql, CO, ENTRY, legs);

    // The office invoices it and writes a note against the invoice.
    const list = obRows(store).slice();
    list[0] = { ...list[0], inv_number: 'INV-2210', comments: 'PO 8841' };
    store.appData.set(OB_KEY, list);

    // Payroll corrects the quantity and re-approves.
    await insertObRows(sql, CO, ENTRY, [{ ...legs[0], gallons_bags: 4200 }]);
    assert('still exactly one row', obRows(store).length === 1);
    assert('the correction lands', obRow(store, 1).gallons_bags === 4200);
    assert('the invoice number survives', obRow(store, 1).inv_number === 'INV-2210');
    assert('and the office\'s note with it', obRow(store, 1).comments === 'PO 8841');
    assert('those are exactly the office\'s columns',
      OB_TAB_FIELDS.join(',') === 'inv_number,comments');

    // The slot is re-pointed at another customer: it is a different haul now,
    // so the previous customer's invoice number must not ride along.
    await insertObRows(sql, CO, ENTRY, [{ ...legs[0], company: 'Antero', location: 'Shale Run' }]);
    assert('a slot whose customer changed starts clean',
      obRow(store, 1).inv_number === '' && obRow(store, 1).customer === 'Antero');
  }

  // ── 8) Pruning a shortened day ────────────────────────────────────────────
  console.log('\n[a day corrected to fewer hauls takes the rest back]');
  {
    const { sql, store } = makeSql({ ...FIXTURE, appData: { [`${CO}:${IC_BLOB}`]: [] } });
    const three = [1, 2, 3].map(n => ({
      dest: 'ob', start_time: '06:00', end_time: '09:00',
      material: 'ClearFrac', gallons_bags: n * 100, mu: 'GAL', price_per_unit: 1,
    }));
    await insertObRows(sql, CO, ENTRY, three);
    assert('three hauls, three rows', obRows(store).length === 3);

    store.appData.set(`${CO}:${IC_BLOB}`, [
      { source: 'dust-other-billing', source_id: 'tso-41-3', amount: 300 },
    ]);
    await insertObRows(sql, CO, ENTRY, three.slice(0, 2));
    assert('corrected to two, the third goes', obRows(store).length === 2);
    assert('and its Intercompany billing entry with it',
      (store.appData.get(`${CO}:${IC_BLOB}`) || []).length === 0);
    assert('the surviving two keep their legs',
      obRows(store).map(r => obRowIndexFromId(r.id)).sort().join(',') === '1,2');
  }

  // ── 9) A UB-only day never touches the blob ───────────────────────────────
  console.log('\n[a UB-only day leaves the Other Billing blob alone]');
  {
    const { sql, store } = makeSql(FIXTURE);
    store.appData.set(OB_KEY, [{ id: 'manual-1', customer: 'CNX', material: 'ClearFrac' }]);
    const written = await insertObRows(sql, CO, ENTRY, [{ dest: 'dust', gallons_ub: 4000 }]);
    assert('nothing is written', written.length === 0);
    assert('and the hand-added row is untouched',
      obRows(store).length === 1 && obRows(store)[0].id === 'manual-1');
    assert('the entry reports no injected row',
      (await obHasInjectedRow(sql, CO, ENTRY)) === false);
  }

  // ── 10) Un-approve ────────────────────────────────────────────────────────
  console.log('\n[un-approve takes the rows and their billing back]');
  {
    const { sql, store } = makeSql({ ...FIXTURE, appData: { [`${CO}:${IC_BLOB}`]: [] } });
    store.appData.set(OB_KEY, [{ id: 'manual-1', customer: 'Antero' }]);
    await insertObRows(sql, CO, ENTRY, [
      { dest: 'ob', material: 'ClearFrac', gallons_bags: 100, price_per_unit: 1 },
      { dest: 'ob', material: 'ClearFrac', gallons_bags: 200, price_per_unit: 1 },
    ]);
    assert('two rows posted, beside the hand-added one', obRows(store).length === 3);
    assert('the entry reports an injected row',
      (await obHasInjectedRow(sql, CO, ENTRY)) === true);

    store.appData.set(`${CO}:${IC_BLOB}`, [
      { source: 'dust-other-billing', source_id: 'tso-41-1', amount: 100 },
      { source: 'dust-other-billing', source_id: 'tso-41-2', amount: 200 },
      { source: 'dust-other-billing', source_id: 'manual-1', amount: 999 },
    ]);
    const n = await removeObRows(sql, CO, ENTRY);
    assert('both payroll rows are removed', n === 2);
    assert('the hand-added row survives',
      obRows(store).length === 1 && obRows(store)[0].id === 'manual-1');
    assert('their billing entries go with them',
      (store.appData.get(`${CO}:${IC_BLOB}`) || []).map(e => e.source_id).join(',') === 'manual-1');
  }

  // ── 11) Intercompany suppression ──────────────────────────────────────────
  console.log('\n[approving overrules an earlier Intercompany removal]');
  {
    const { sql, store } = makeSql({
      ...FIXTURE,
      appData: { [`${CO}:${IC_REMOVED_BLOB}`]: [
        { source: 'dust-other-billing', source_id: 'tso-41-1' },
        { source: 'dust-other-billing', source_id: 'tso-99-1' },
      ] },
    });
    await insertObRows(sql, CO, ENTRY, [{ dest: 'ob', material: 'ClearFrac' }], { clearSuppression: true });
    const left = store.appData.get(`${CO}:${IC_REMOVED_BLOB}`) || [];
    assert('this row\'s removal is cleared',
      !left.some(t => t.source_id === 'tso-41-1'), JSON.stringify(left));
    assert('somebody else\'s is left alone', left.some(t => t.source_id === 'tso-99-1'));

    // Without the flag — a plain Edit Row — a removal stands.
    store.appData.set(`${CO}:${IC_REMOVED_BLOB}`, [{ source: 'dust-other-billing', source_id: 'tso-41-1' }]);
    await insertObRows(sql, CO, ENTRY, [{ dest: 'ob', material: 'ClearFrac' }]);
    assert('an Edit Row does not overrule it',
      (store.appData.get(`${CO}:${IC_REMOVED_BLOB}`) || []).length === 1);
  }

  // ── 12) The read-time sweep ───────────────────────────────────────────────
  console.log('\n[rows that outlived their entry are swept on read]');
  {
    const live    = { id: 'tso-41-1', customer: 'CNX' };
    const unappr  = { id: 'tso-42-1', customer: 'CNX' };
    const deleted = { id: 'tso-43-1', customer: 'CNX' };
    const eesJob  = { id: 'tso-44-1', customer: 'CNX' };
    const moved   = { id: 'tso-45-1', customer: 'CNX' };
    const strayed = { id: 'tso-41-1754308800000', customer: 'CNX' };
    const manual  = { id: 'm8x2p1', customer: 'CNX' };
    const all = [live, unappr, deleted, eesJob, moved, strayed, manual];

    const entriesById = new Map([
      [41, { id: 41, status: 'approved',  entry_type: 'daily', division: 'dust',     job_id: 'co-1' }],
      [42, { id: 42, status: 'submitted', entry_type: 'daily', division: 'dust',     job_id: 'co-1' }],
      [44, { id: 44, status: 'approved',  entry_type: 'daily', division: 'dust',     job_id: 'ees:washing' }],
      [45, { id: 45, status: 'approved',  entry_type: 'daily', division: 'trucking', job_id: 'co-1' }],
    ]);
    const stale = findStaleObRows(all, entriesById);
    assert('the live row survives',      !stale.includes('tso-41-1'));
    assert('the un-approved one is swept', stale.includes('tso-42-1'));
    assert('the deleted one is swept',     stale.includes('tso-43-1'));
    assert('the EES-job one is swept',     stale.includes('tso-44-1'));
    assert('the re-divisioned one is swept', stale.includes('tso-45-1'));
    assert('a leftover naming no leg is swept', stale.includes('tso-41-1754308800000'));
    assert('a hand-added row is never swept', !stale.includes('m8x2p1'));

    const { sql, store } = makeSql({
      ...FIXTURE,
      appData: { [OB_KEY]: all, [`${CO}:${IC_BLOB}`]: [] },
      entries: [...entriesById.values()],
    });
    const swept = await sweepInjectedObRows(sql, CO, all);
    assert('the sweep returns the surviving rows',
      swept.rows.map(r => r.id).sort().join(',') === 'm8x2p1,tso-41-1');
    assert('and deletes the rest from the blob',
      obRows(store).map(r => r.id).sort().join(',') === 'm8x2p1,tso-41-1');
    const quiet = await sweepInjectedObRows(sql, CO, [manual]);
    assert('a list with no injected rows costs nothing', quiet.removed.length === 0);
  }

  // ── 13) The tab's own saves ───────────────────────────────────────────────
  console.log('\n[the tab cannot drop or rewrite a payroll row]');
  {
    const cfg = guardConfigFor('dust_other_billing_rows');
    assert('the blob is registered with the guard', !!cfg && cfg.prefix === 'tso-');
    assert('and the office keeps exactly its two columns',
      cfg.tabFields.join(',') === 'inv_number,comments');

    const server = [
      { id: 'tso-41-1', customer: 'CNX', material: 'ClearFrac', gallons_bags: 4200,
        price_per_unit: 0.42, inv_number: '', comments: '' },
      { id: 'tso-41-2', customer: 'Antero', material: 'Calcium Chloride' },
      { id: 'manual-1', customer: 'CNX', material: 'Sand' },
    ];
    // The stale save the tab makes: it never saw leg 2, it re-typed the money on
    // leg 1, and it filled in the invoice number and a note.
    const incoming = [
      { id: 'tso-41-1', customer: 'Somebody Else', material: 'Sand', gallons_bags: 1,
        price_per_unit: 99, inv_number: 'INV-77', comments: 'PO 12' },
      { id: 'manual-1', customer: 'CNX', material: 'Sand', gallons_bags: 12 },
      { id: 'tso-40-9', customer: 'Ghost' },
    ];
    const merged = mergeInjectedRows(server, incoming, cfg);
    const one = merged.find(r => r.id === 'tso-41-1');
    assert('payroll\'s columns are the server\'s',
      one.customer === 'CNX' && one.material === 'ClearFrac'
      && one.gallons_bags === 4200 && one.price_per_unit === 0.42);
    assert('the office\'s two columns are the tab\'s',
      one.inv_number === 'INV-77' && one.comments === 'PO 12');
    assert('a row the save never saw is kept', merged.some(r => r.id === 'tso-41-2'));
    assert('a row payroll no longer has is not resurrected',
      !merged.some(r => r.id === 'tso-40-9'));
    assert('the tab\'s own row saves exactly as sent',
      merged.find(r => r.id === 'manual-1').gallons_bags === 12);
  }

  // ── 14) The lists the modal is offered ────────────────────────────────────
  console.log('\n[the approve modal is offered the grid\'s own lists]');
  {
    const { sql } = makeSql(FIXTURE);
    const forModal = await dustOptionsForEntry(sql, CO, ENTRY, '', { withLists: true });
    assert('materials come from the dust list', forModal.materials.join(',') === 'ClearFrac,Calcium Chloride');
    assert('MU comes from the dust list', forModal.mu.join(',') === 'GAL,BAG');
    // …and ONLY for the modal. Each list costs three queries and this runs once
    // per distinct customer in both injection paths, inside the request that
    // rolls the approval back on failure — for lists no injection reads.
    const forInjection = await dustOptionsForEntry(sql, CO, ENTRY);
    assert('an injection is not charged for them',
      forInjection.materials.length === 0 && forInjection.mu.length === 0,
      JSON.stringify({ m: forInjection.materials, u: forInjection.mu }));
    assert('and still gets everything it does need',
      forInjection.company === 'CNX' && forInjection.equipment.length > 0
      && forInjection.locations.length > 0);
    assert('a name off the roster is left as typed',
      (await matchDustEmployee(sql, CO, 'Nobody At All')) === 'Nobody At All');
    assert('and a login resolves to the roster spelling',
      (await matchDustEmployee(sql, CO, 'preilly')) === 'Pat Reilly');
  }

  // ── 15) The tab renders a payroll row locked ──────────────────────────────
  console.log('\n[the Other Billing grid renders a payroll row locked]');
  {
    const DUST = fs.readFileSync(path.resolve(__dirname, '../dust.html'), 'utf8');
    assert('the tab knows a payroll row when it sees one',
      /function obIsInjectedRowId\(id\) \{\s*\n\s*return \/\^tso-\\d\+-\/\.test/.test(DUST));
    assert('and agrees with the server about which columns it owns',
      /const OB_TAB_FIELDS = \['inv_number', 'comments'\];/.test(DUST));
    assert('the delete button is a padlock on a payroll row',
      /obInjected\s*\n?\s*\? `<td class="del-col"><span title="\$\{obLockTitle\}"/.test(DUST));
    assert('and obDeleteRow refuses one that reaches it anyway',
      /if \(obIsInjectedRow\(obRows\[idx\]\)\) \{[\s\S]{0,200}?cannot be deleted here/.test(DUST));
    assert('a locked cell cannot be written through obSet',
      /if \(obIsInjectedRow\(obRows\[idx\]\) && !OB_TAB_FIELDS\.includes\(field\)\) return;/.test(DUST));
    assert('nor through the live number handler',
      (DUST.match(/if \(obIsInjectedRow\(obRows\[idx\]\) && !OB_TAB_FIELDS\.includes\(field\)\) return;/g) || []).length === 2);
    assert('nor through the customer / destination cascades',
      (DUST.match(/if \(obIsInjectedRow\(obRows\[idx\]\)\) return;/g) || []).length === 2);
    // Every payroll-owned column has to be read-only, or a box that looks
    // editable silently loses what is typed in it on the next save.
    for (const col of ['date', 'driver', 'truck_number', 'trailer_number', 'customer',
                       'destination', 'state', 'material', 'gallons_bags', 'mu',
                       'price_per_unit', 'trucking_hrs', 'trucking_rate']) {
      assert(`${col} renders read-only`, new RegExp(`obRo\\(row\\.${col},`).test(DUST));
    }
    assert('the invoice number stays editable',
      /placeholder="INV-…" oninput="obSet\(\$\{idx\},'inv_number'/.test(DUST));
    assert('and so does the comment',
      /placeholder="Notes…" oninput="obSet\(\$\{idx\},'comments'/.test(DUST));
    assert('the row is badged so the office can see where it came from',
      /obInjected \? `<div style="margin-top:0\.15rem">\$\{obTsBadge\}<\/div>` : ''/.test(DUST));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
