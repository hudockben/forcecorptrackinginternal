#!/usr/bin/env node
'use strict';
/**
 * Dust timesheet → Dust Control Tracking injection tests.
 *
 * Run: node scripts/test-dust-injection.js
 *
 * A dust customer haul posts TWO rows when payroll approves it: the Truck
 * Tracking row (covered by test-trucking-injection.js) and the Dust Control
 * Tracking row the dust office bills from. This exercises the second one against
 * an in-memory mock of the `sql` tagged template. Verifies:
 *   - the row autofills date / times / customer from the timesheet, and takes
 *     the company man, location and gallons from the approve modal,
 *   - the state follows the location, and each vehicle's rate follows the
 *     customer's default before the vehicle's own — the cascade dust.html runs,
 *   - Vehicle 1 defaults to the unit the driver logged, Vehicle 2 to the escort
 *     that customer usually gets, and only when they carry an escort rate,
 *   - an absent modal field derives, a blank one is obeyed (bulk approve vs a
 *     deliberately cleared box),
 *   - injection is idempotent, and preserves the invoice columns the dust office
 *     owns across a re-approval,
 *   - un-approve removes the row and its Intercompany billing entry,
 *   - the tab's own saves can neither drop a payroll row nor resurrect one,
 *   - the read-time sweep drops rows whose entry is gone, un-approved or moved.
 *
 * No DB or server required.
 */

const path = require('path');
const { _test } = require('../api/timesheet-entries.js');
const {
  needsDustTrackingRow, dustRowId, validateDustInjection, dustOptionsForEntry,
  insertDustTrackingRow, removeDustTrackingRows, dustHasInjectedRow, dustSplitForEntry,
} = _test;
const {
  findStaleDustRows, mergeInjectedDustRows, sweepInjectedDustRows,
  isInjectedDustRowId, DUST_TAB_FIELDS,
} = require('../api/lib/dust-injected.js');

const IC_BLOB = 'fct_intercompany_billing_entries';
const IC_REMOVED_BLOB = 'fct_intercompany_removed_entries';

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── In-memory mock of the neon `sql` tagged template ────────────────────────
// Backs the surfaces the dust helpers touch: the dust config tables, the
// dust_control_entries table itself, app_data (the shared IC blobs), the IC
// mirror table, and timesheet_entries (for the sweep).
function makeSql(initial = {}) {
  const store = {
    companies: (initial.companies || []).slice(),   // {id,name,v1_rate,v2_rate}
    men:       (initial.men       || []).slice(),   // {dust_company_id,name}
    locations: (initial.locations || []).slice(),   // {dust_company_id,name,state}
    equipment: (initial.equipment || []).slice(),   // {name,unit_number,vehicle_rate}
    dce:       new Map((initial.dce || []).map(r => [r.id, r])),  // dust_control_entries
    appData:   new Map(Object.entries(initial.appData || {})),
    icMirror:  new Map(Object.entries(initial.icMirror || {})),
    entries:   new Map((initial.entries || []).map(e => [Number(e.id), e])),
    audits:    [],
  };
  const like = (v, pattern) => String(v).startsWith(String(pattern).replace(/%$/, ''));

  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();

    if (q.startsWith('SELECT id, name, v1_rate, v2_rate FROM dust_companies')) {
      const [, needle] = values;
      const byId = q.includes('AND id =');
      return Promise.resolve(store.companies.filter(c => (byId ? c.id : c.name) === needle));
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
    // The learned escort: newest non-blank vehicle2 for this customer.
    if (q.startsWith('SELECT vehicle2 FROM dust_control_entries')) {
      const [, company] = values;
      const hits = [...store.dce.values()]
        .filter(r => r.company === company && r.vehicle2)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
      return Promise.resolve(hits.length ? [{ vehicle2: hits[0].vehicle2 }] : []);
    }
    if (q.startsWith('SELECT * FROM dust_control_entries') && q.includes('AND id =')) {
      const r = store.dce.get(values[1]);
      return Promise.resolve(r ? [r] : []);
    }
    if (q.startsWith('SELECT id FROM dust_control_entries') && q.includes('id LIKE')) {
      return Promise.resolve([...store.dce.values()].filter(r => like(r.id, values[1])).map(r => ({ id: r.id })));
    }
    if (q.startsWith('SELECT 1 AS found FROM dust_control_entries')) {
      const hit = [...store.dce.values()].some(r => like(r.id, values[1]));
      return Promise.resolve(hit ? [{ found: 1 }] : []);
    }
    if (q.startsWith('SELECT * FROM dust_control_entries') && q.includes("id LIKE 'tsd-%'")) {
      return Promise.resolve([...store.dce.values()].filter(r => isInjectedDustRowId(r.id)));
    }
    if (q.startsWith('INSERT INTO dust_control_entries')) {
      // Template order mirrors insertDustTrackingRow's VALUES list.
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
    // clearIcSuppression: source, sourceId, key
    if (q.startsWith('UPDATE app_data') && q.includes('jsonb_array_elements')) {
      const [source, sourceId, key] = values;
      const cur = store.appData.get(key);
      if (!Array.isArray(cur)) return Promise.resolve([]);
      const next = cur.filter(t => !(t && t.source === source && t.source_id === sourceId));
      if (next.length === cur.length) return Promise.resolve([]);
      store.appData.set(key, next);
      return Promise.resolve([{ cleared: 1 }]);
    }
    if (q.startsWith('SELECT id, status, entry_type, division, job_id FROM timesheet_entries')) {
      const ids = values[values.length - 1] || [];
      return Promise.resolve(ids.map(id => store.entries.get(Number(id))).filter(Boolean));
    }
    throw new Error('Unexpected query in mock: ' + q.slice(0, 90));
  };
  return { sql, store };
}

const CO = 'ACME';

// The dust config a company like the one in the screenshots would have: CNX
// takes an escort (V2 default set), Northeast does not.
const CONFIG = {
  companies: [
    { id: 'co-cnx',  name: 'CNX',   v1_rate: 130, v2_rate: 60 },
    { id: 'co-ne',   name: 'Northeast Natural Energy', v1_rate: 130, v2_rate: null },
  ],
  men: [
    { dust_company_id: 'co-cnx', name: 'Steve Quinn' },
    { dust_company_id: 'co-ne',  name: 'Chris Patterson' },
  ],
  locations: [
    { dust_company_id: 'co-cnx', name: 'Deer Lick Compressor', state: 'PA' },
    { dust_company_id: 'co-cnx', name: 'Mamont Lay Down Yard', state: 'PA' },
    { dust_company_id: 'co-ne',  name: 'Sullivan Lease',       state: 'WV' },
  ],
  equipment: [
    { name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 99 },
    { name: 'Escort Vehicle 7549',    unit_number: '7549', vehicle_rate: 50 },
  ],
  // One historical CNX row, so the escort can be learned from it.
  dce: [{
    id: 'manual-1', company: 'CNX', date: '2026-08-10',
    vehicle1: 'Distributor Truck 4000', vehicle2: 'Escort Vehicle 7549',
  }],
};

// Raw timesheet_entries row shape (as returned by RETURNING *)
function entry(over = {}) {
  return {
    id: 42, company_code: CO, username: 'barrmike', entry_type: 'daily',
    division: 'dust', work_date: '2026-08-13',
    job_id: 'co-cnx', job_label: 'CNX',
    start_time: '06:30', end_time: '15:30', computed_hours: 9.0, travel_hours: 0,
    notes: '', truck_unit: 'Distributor Truck 4000', truck_description: '',
    ...over,
  };
}

(async () => {
  console.log('Dust Control Tracking injection helpers\n');

  // ── The gate ─────────────────────────────────────────────────────────────
  console.log('[which entries post a dust tracking row]');
  {
    assert('dust customer haul        → posts', needsDustTrackingRow(entry()));
    assert('dust EES pre-loading      → does NOT', !needsDustTrackingRow(entry({ job_id: 'ees:preloading' })));
    assert('dust EES washing          → does NOT', !needsDustTrackingRow(entry({ job_id: 'ees:washing' })));
    assert('dust with no job          → does NOT', !needsDustTrackingRow(entry({ job_id: null })));
    assert('trucking entry            → does NOT', !needsDustTrackingRow(entry({ division: 'trucking' })));
    assert('time off                  → does NOT', !needsDustTrackingRow(entry({ entry_type: 'time_off' })));
    assert('null entry                → does NOT', !needsDustTrackingRow(null));
    // The gate is one function called at four sites (approve, resplit,
    // un-approve, the edit guard). Inlining it at any of them is how an injected
    // row starts outliving the entry that made it.
    const SRC = require('fs').readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
    const calls = (SRC.match(/needsDustTrackingRow\(existing\)/g) || []).length;
    assert('approve, resplit, un-approve and the edit guard share the gate',
      calls === 4, `found ${calls}`);
  }

  // ── validateDustInjection: absent vs blank ───────────────────────────────
  console.log('\n[absent means derive, blank means blank]');
  {
    const { fields } = validateDustInjection({});
    assert('bulk approve sends nothing → every field absent',
      Object.keys(fields).length === 0);
    const cleared = validateDustInjection({ vehicle2: '', gallons_ub: '' }).fields;
    assert('a cleared box is present and empty, not absent',
      cleared.vehicle2 === '' && cleared.gallons_ub === '');
    assert('an explicit null is treated as no opinion',
      Object.keys(validateDustInjection({ vehicle2: null }).fields).length === 0);
    assert('gallons round to 4dp', validateDustInjection({ gallons_ub: '1234.56789' }).fields.gallons_ub === 1234.5679);
    assert('a negative rate is rejected', !!validateDustInjection({ v1_rate: -1 }).error);
    assert('a non-numeric gallons figure is rejected', !!validateDustInjection({ gallons_ub: 'lots' }).error);
    assert('a rate past the cap is rejected', !!validateDustInjection({ v2_rate: 1e9 }).error);
  }

  // ── dustOptionsForEntry ──────────────────────────────────────────────────
  console.log('\n[what the approve modal is offered]');
  {
    const { sql } = makeSql(CONFIG);
    const o = await dustOptionsForEntry(sql, CO, entry());
    assert('customer resolved by job_id', o.known && o.company === 'CNX');
    assert('its company men are offered', o.men.join() === 'Steve Quinn');
    assert('its locations are offered, with states',
      o.locations.length === 2 && o.locations[0].state === 'PA');
    assert('the division equipment list is offered', o.equipment.length === 2);
    assert('the customer V1/V2 defaults come back', o.v1_rate === 130 && o.v2_rate === 60);
    assert('the escort is learned from that customer\'s rows',
      o.usual_vehicle2 === 'Escort Vehicle 7549');

    // A customer renamed since the driver submitted still resolves by label.
    const o2 = await dustOptionsForEntry(sql, CO, entry({ job_id: 'gone', job_label: 'CNX' }));
    assert('falls back to matching the customer by name', o2.known && o2.company === 'CNX');

    // No escort rate configured → no escort suggested.
    const o3 = await dustOptionsForEntry(sql, CO, entry({ job_id: 'co-ne', job_label: 'Northeast Natural Energy' }));
    assert('a customer with no V2 rate is offered no escort', o3.usual_vehicle2 === '');

    const o4 = await dustOptionsForEntry(sql, CO, entry({ job_id: 'nope', job_label: 'Someone Else' }));
    assert('an unknown customer still returns the equipment list',
      !o4.known && o4.company === 'Someone Else' && o4.equipment.length === 2);
  }

  // ── The injected row ─────────────────────────────────────────────────────
  console.log('\n[the row a supervisor\'s approval posts]');
  {
    const { sql, store } = makeSql(CONFIG);
    const row = await insertDustTrackingRow(sql, CO, entry(), {
      company_man: 'Steve Quinn',
      location:    'Deer Lick Compressor',
      state:       'PA',
      vehicle1:    'Distributor Truck 4000',
      v1_rate:     130,
      vehicle2:    'Escort Vehicle 7549',
      v2_rate:     60,
      gallons_ub:  1660,
    });
    assert('id is stable and derived from the entry', row.id === dustRowId(42));
    assert('date comes off the timesheet',   row.date === '2026-08-13');
    assert('times come off the timesheet',   row.start_time === '06:30' && row.end_time === '15:30');
    assert('customer comes off the timesheet', row.company === 'CNX');
    assert('company man is the approver\'s',  row.company_man === 'Steve Quinn');
    assert('location is the approver\'s',     row.location === 'Deer Lick Compressor');
    assert('gallons are the approver\'s',     row.gallons_ub === 1660);
    assert('unit numbers are filled from the equipment list',
      row.v1_unit === '4000' && row.v2_unit === '7549');
    assert('it reached the table', store.dce.has(dustRowId(42)));
    assert('the dust audit log records where it came from',
      store.audits.length === 1 && store.audits[0].action === 'INSERT');
    // No hours column: the tab derives Total Time from start and end, and a
    // stored figure would be a second source of truth for the same number.
    assert('no hours are stored on the row', !('total_hours' in row));
  }

  // ── The cascades, when the modal leaves it to the customer ───────────────
  console.log('\n[state, rates and the escort follow the customer]');
  {
    const { sql } = makeSql(CONFIG);
    // Only what the supervisor genuinely knows — everything else absent.
    const row = await insertDustTrackingRow(sql, CO, entry(), {
      company_man: 'Steve Quinn', location: 'Deer Lick Compressor', gallons_ub: 1660,
    });
    assert('state follows the location', row.state === 'PA');
    assert('vehicle 1 defaults to the unit the driver logged',
      row.vehicle1 === 'Distributor Truck 4000');
    assert('vehicle 2 defaults to the customer\'s usual escort',
      row.vehicle2 === 'Escort Vehicle 7549');
    assert('the customer\'s V1 default beats the vehicle\'s own rate (130, not 99)',
      row.v1_rate === 130);
    assert('the customer\'s V2 default beats the vehicle\'s own rate (60, not 50)',
      row.v2_rate === 60);
  }
  {
    // A customer with no rate of its own falls back to the vehicle's.
    const cfg = JSON.parse(JSON.stringify(CONFIG));
    cfg.companies[0].v1_rate = null;
    const { sql } = makeSql(cfg);
    const row = await insertDustTrackingRow(sql, CO, entry(), { location: 'Deer Lick Compressor' });
    assert('with no customer default, the vehicle\'s own rate is used', row.v1_rate === 99);
  }
  {
    const { sql } = makeSql(CONFIG);
    // A box the supervisor deliberately cleared must stay cleared — the escort
    // suggestion is a default, not a correction.
    const row = await insertDustTrackingRow(sql, CO, entry(), { vehicle2: '', v2_rate: '' });
    assert('a cleared escort stays cleared', row.vehicle2 === '' && row.v2_rate === '');
    assert('and its unit is not invented either', row.v2_unit === '');
  }
  {
    const { sql } = makeSql(CONFIG);
    // The tab multiplies rate x hours without looking at the vehicle NAME, so a
    // rate left behind after the vehicle was cleared is a real charge for a
    // truck that never rolled.
    const row = await insertDustTrackingRow(sql, CO, entry(), {
      vehicle1: '', v1_rate: 130, vehicle2: '', v2_rate: 60,
    });
    assert('an emptied slot bills nothing, whatever rate was left in the box',
      row.v1_rate === '' && row.v2_rate === '');
    assert('and carries no unit either', row.v1_unit === '' && row.v2_unit === '');
  }
  {
    // The columns are NUMERIC(10,4): six integer digits. A ceiling wider than
    // that does not reject a fat-fingered figure, it lets Postgres 22003 roll
    // the whole approval back with a 500.
    assert('a rate past what NUMERIC(10,4) holds is rejected up front',
      !!validateDustInjection({ v1_rate: 1000000 }).error);
    assert('so are gallons past it',
      !!validateDustInjection({ gallons_ub: 1000000 }).error);
    assert('the widest storable figure is still accepted',
      validateDustInjection({ gallons_ub: 999999.9999 }).fields.gallons_ub === 999999.9999);
    assert('a realistic gallons figure is unaffected',
      validateDustInjection({ gallons_ub: 4730 }).fields.gallons_ub === 4730);
  }
  {
    const { sql } = makeSql(CONFIG);
    // Bulk approve: nothing entered at all.
    const row = await insertDustTrackingRow(sql, CO, entry(), {});
    assert('bulk approve still fills in what the customer implies',
      row.vehicle1 === 'Distributor Truck 4000' && row.v1_rate === 130 &&
      row.vehicle2 === 'Escort Vehicle 7549'    && row.v2_rate === 60);
    assert('and leaves what only the supervisor knows blank',
      row.company_man === '' && row.location === '' && row.state === '' && row.gallons_ub === '');
  }
  {
    const { sql } = makeSql(CONFIG);
    // An explicit state beats the location's — a job across a state line.
    const row = await insertDustTrackingRow(sql, CO, entry(), {
      location: 'Deer Lick Compressor', state: 'OH',
    });
    assert('an explicit state overrides the location\'s', row.state === 'OH');
  }

  // ── Idempotence + the office's own columns ───────────────────────────────
  console.log('\n[re-approving keeps the office\'s invoice work]');
  {
    const { sql, store } = makeSql(CONFIG);
    await insertDustTrackingRow(sql, CO, entry(), { location: 'Deer Lick Compressor', gallons_ub: 1660 });
    // The dust office bills it.
    const stored = store.dce.get(dustRowId(42));
    stored.inv_number = 'INV-1001';
    stored.inv_sent   = '2026-08-14';
    stored.inv_status = 'sent';
    stored.cm_approval = 'SQ';

    // Payroll corrects the hours and re-injects.
    const again = await insertDustTrackingRow(sql, CO, entry({ end_time: '16:00' }),
      { location: 'Deer Lick Compressor', gallons_ub: 1700 });
    assert('re-injection replaces, never duplicates', store.dce.size === 2); // the manual row + ours
    assert('the correction landed', again.end_time === '16:00' && again.gallons_ub === 1700);
    for (const f of DUST_TAB_FIELDS.filter(f => ['inv_number', 'inv_sent', 'inv_status', 'cm_approval'].includes(f))) {
      assert(`the office's ${f} survives`, !!again[f]);
    }
    assert('the row keeps its identity', again.id === dustRowId(42));
  }

  // ── Approving undoes an Intercompany removal ─────────────────────────────
  console.log('\n[approving overrules an earlier IC removal]');
  {
    const { sql, store } = makeSql({
      ...CONFIG,
      appData: { [`${CO}:${IC_REMOVED_BLOB}`]: [{ source: 'dust', source_id: dustRowId(42) }] },
    });
    await insertDustTrackingRow(sql, CO, entry(), {});
    assert('the suppression is cleared',
      store.appData.get(`${CO}:${IC_REMOVED_BLOB}`).length === 0);
  }

  // ── Un-approve ───────────────────────────────────────────────────────────
  console.log('\n[un-approve takes the row and its billing back]');
  {
    const { sql, store } = makeSql({
      ...CONFIG,
      appData: { [`${CO}:${IC_BLOB}`]: [
        { source: 'dust',     source_id: dustRowId(42), total: 945 },
        { source: 'dust',     source_id: 'manual-1',    total: 380 },
        { source: 'trucking', source_id: 'tst-42-row',  total: 1089 },
      ] },
      icMirror: { [dustRowId(42)]: {}, 'manual-1': {} },
    });
    await insertDustTrackingRow(sql, CO, entry(), {});
    assert('the guard sees the injected row', await dustHasInjectedRow(sql, CO, entry()));

    const removed = await removeDustTrackingRows(sql, CO, entry());
    assert('one row removed', removed === 1);
    assert('it is gone from the table', !store.dce.has(dustRowId(42)));
    assert('the manual row is untouched', store.dce.has('manual-1'));

    const ic = store.appData.get(`${CO}:${IC_BLOB}`);
    assert('its dust billing entry went with it',
      !ic.some(e => e.source === 'dust' && e.source_id === dustRowId(42)));
    assert('the other customer\'s billing entry is untouched',
      ic.some(e => e.source_id === 'manual-1'));
    assert('the Truck Tracking billing entry is left to its own un-approve',
      ic.some(e => e.source === 'trucking'));
    assert('the IC mirror row is cleared too', !store.icMirror.has(dustRowId(42)));
    assert('the guard no longer sees a row', !(await dustHasInjectedRow(sql, CO, entry())));
  }

  // ── Re-edit pre-fill ─────────────────────────────────────────────────────
  console.log('\n[Edit Row reads the posted row back]');
  {
    const { sql } = makeSql(CONFIG);
    await insertDustTrackingRow(sql, CO, entry(), {
      company_man: 'Steve Quinn', location: 'Deer Lick Compressor', gallons_ub: 1660,
    });
    const { row } = await dustSplitForEntry(sql, CO, entry());
    assert('every box comes back filled',
      row.company_man === 'Steve Quinn' && row.location === 'Deer Lick Compressor' &&
      row.state === 'PA' && row.vehicle1 === 'Distributor Truck 4000' &&
      row.v1_rate === '130' && row.gallons_ub === '1660');
    const { row: none } = await dustSplitForEntry(sql, CO, entry({ id: 99 }));
    assert('an entry with no row reads back null', none === null);
  }

  // ── The tab's own saves ──────────────────────────────────────────────────
  console.log('\n[the dust tab has no authority over a payroll row]');
  {
    const server = [{
      id: dustRowId(42), company: 'CNX', gallons_ub: '1660',
      inv_number: '', inv_status: '',
    }];
    // The tab saves a stale copy that never saw the injection AND tries to edit
    // the payroll columns while filling in its own.
    const incoming = [
      { id: 'manual-1', company: 'Antero' },
      { id: dustRowId(42), company: 'WRONG', gallons_ub: '1', inv_number: 'INV-9', inv_status: 'sent' },
    ];
    const merged = mergeInjectedDustRows(server, incoming);
    const mine   = merged.find(r => r.id === dustRowId(42));
    assert('the tab\'s own row is saved exactly as sent',
      merged.find(r => r.id === 'manual-1').company === 'Antero');
    assert('payroll\'s columns are taken from the server, not the save',
      mine.company === 'CNX' && mine.gallons_ub === '1660');
    assert('the office\'s invoice columns are replayed from the save',
      mine.inv_number === 'INV-9' && mine.inv_status === 'sent');

    // A save made before an injection must not drop the new row.
    const late = mergeInjectedDustRows(server, [{ id: 'manual-1' }]);
    assert('a row injected after the client read is kept',
      late.some(r => r.id === dustRowId(42)));

    // A save made before an un-approval must not put the row back.
    const zombie = mergeInjectedDustRows([], [{ id: 'manual-1' }, { id: dustRowId(42) }]);
    assert('a row payroll withdrew is not resurrected',
      !zombie.some(r => r.id === dustRowId(42)) && zombie.length === 1);
  }

  // ── The read-time sweep ──────────────────────────────────────────────────
  console.log('\n[rows that outlived their entry are swept on read]');
  {
    const rows = [
      { id: 'manual-1' },                 // not ours — never a candidate
      { id: dustRowId(1) },               // entry approved and still a dust haul
      { id: dustRowId(2) },               // entry un-approved
      { id: dustRowId(3) },               // entry deleted
      { id: dustRowId(4) },               // entry moved onto an EES job
      { id: dustRowId(5) },               // entry moved to another division
    ];
    const byId = new Map([
      [1, { id: 1, status: 'approved',  entry_type: 'daily', division: 'dust',     job_id: 'co-cnx' }],
      [2, { id: 2, status: 'submitted', entry_type: 'daily', division: 'dust',     job_id: 'co-cnx' }],
      [4, { id: 4, status: 'approved',  entry_type: 'daily', division: 'dust',     job_id: 'ees:washing' }],
      [5, { id: 5, status: 'approved',  entry_type: 'daily', division: 'trucking', job_id: 'x' }],
    ]);
    const stale = findStaleDustRows(rows, byId);
    assert('the live row survives',        !stale.includes(dustRowId(1)));
    assert('the un-approved one is swept',  stale.includes(dustRowId(2)));
    assert('the deleted one is swept',      stale.includes(dustRowId(3)));
    assert('the EES-job one is swept',      stale.includes(dustRowId(4)));
    assert('the re-divisioned one is swept', stale.includes(dustRowId(5)));
    assert('a manual row is never swept',  !stale.includes('manual-1'));

    const { sql, store } = makeSql({
      dce: rows.map(r => ({ ...r })),
      entries: [...byId.values()],
      appData: { [`${CO}:${IC_BLOB}`]: [{ source: 'dust', source_id: dustRowId(2) }] },
    });
    const out = await sweepInjectedDustRows(sql, CO, rows.map(r => ({ ...r })));
    assert('the sweep returns the surviving rows', out.rows.length === 2);
    assert('and deletes the rest from the table', store.dce.size === 2);
    assert('and their billing entries with them',
      store.appData.get(`${CO}:${IC_BLOB}`).length === 0);

    const quiet = await sweepInjectedDustRows(sql, CO, [{ id: 'manual-1' }]);
    assert('a list with no injected rows costs nothing', quiet.removed.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
