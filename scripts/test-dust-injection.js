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
  insertDustTrackingRow, insertDustTrackingRows, removeDustTrackingRows,
  dustHasInjectedRow, dustSplitForEntry, dustCompanyDirectory,
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

    // One customer, by id or by name. The whole-directory read (ORDER BY name,
    // no id/name predicate) is a different query — see below.
    if (q.startsWith('SELECT id, name, v1_rate, v2_rate FROM dust_companies') && !q.includes('ORDER BY name')) {
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
    // The learned escort: newest non-blank vehicle2 for this customer, never one
    // of the rows this very entry is about to rewrite.
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
    // Every leg of one entry. Not the guard's "id LIKE 'tsd-%'" sweep, whose
    // pattern is a literal rather than a bound value — that one is below.
    if (q.startsWith('SELECT * FROM dust_control_entries')
        && q.includes('AND id LIKE') && !q.includes("'tsd-%'")) {
      return Promise.resolve([...store.dce.values()].filter(r => like(r.id, values[1])));
    }
    // dustCompanyDirectory: every customer, with its men and pads.
    if (q.startsWith('SELECT id, name, v1_rate, v2_rate FROM dust_companies') && q.includes('ORDER BY name')) {
      return Promise.resolve(store.companies.slice().sort((a, b) => a.name.localeCompare(b.name)));
    }
    if (q.startsWith('SELECT p.dust_company_id, p.name FROM dust_company_personnel')) {
      return Promise.resolve(store.men.map(m => ({ ...m })));
    }
    if (q.startsWith('SELECT l.dust_company_id, l.name, l.state FROM dust_company_locations')) {
      return Promise.resolve(store.locations.map(l => ({ ...l })));
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
    const one = raw => validateDustInjection(raw).rows[0];
    const fields = one({});
    assert('bulk approve sends nothing → every field absent',
      Object.keys(fields).length === 0);
    assert('no dust key at all is one derived row',
      validateDustInjection(undefined).rows.length === 1);
    const cleared = one({ vehicle2: '', gallons_ub: '' });
    assert('a cleared box is present and empty, not absent',
      cleared.vehicle2 === '' && cleared.gallons_ub === '');
    assert('an explicit null is treated as no opinion',
      Object.keys(one({ vehicle2: null })).length === 0);
    assert('gallons round to 4dp', one({ gallons_ub: '1234.56789' }).gallons_ub === 1234.5679);
    assert('a negative rate is rejected', !!validateDustInjection({ v1_rate: -1 }).error);
    assert('a non-numeric gallons figure is rejected', !!validateDustInjection({ gallons_ub: 'lots' }).error);
    assert('a rate past the cap is rejected', !!validateDustInjection({ v2_rate: 1e9 }).error);
  }

  // ── validateDustInjection: the split payload ─────────────────────────────
  console.log('\n[a day split across customers]');
  {
    const split = validateDustInjection({
      rows: [
        { company: 'CNX',    start_time: '05:00', end_time: '10:00', gallons_ub: 4000 },
        { company: 'Antero', start_time: '10:00', end_time: '15:00', gallons_ub: 2000 },
      ],
    });
    assert('both legs come back, in order',
      split.rows.length === 2 && split.rows[0].company === 'CNX' && split.rows[1].company === 'Antero');
    assert('each leg keeps its own window and gallons',
      split.rows[1].start_time === '10:00' && split.rows[1].gallons_ub === 2000);
    // The flat object shape is what a payroll page cached from before the split
    // existed still sends, and what bulk approve's absence resolves to.
    assert('the old flat shape is still one leg',
      validateDustInjection({ gallons_ub: 10 }).rows.length === 1);
    assert('a bare array of legs is accepted too',
      validateDustInjection([{ gallons_ub: 1 }, { gallons_ub: 2 }]).rows.length === 2);
    assert('a leg with a bad time is rejected',
      !!validateDustInjection({ rows: [{ start_time: '25:00' }] }).error);
    assert('a cleared time is kept as a deliberate blank',
      validateDustInjection({ rows: [{ end_time: '' }] }).rows[0].end_time === '');
    assert('no legs at all is rejected', !!validateDustInjection({ rows: [] }).error);
    assert('past the leg cap is rejected',
      !!validateDustInjection({ rows: Array.from({ length: 7 }, () => ({})) }).error);
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
      validateDustInjection({ gallons_ub: 999999.9999 }).rows[0].gallons_ub === 999999.9999);
    assert('a realistic gallons figure is unaffected',
      validateDustInjection({ gallons_ub: 4730 }).rows[0].gallons_ub === 4730);
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

    // Preserving them by reading them back and echoing them into the UPDATE is
    // not enough: there is no transaction on Neon, so an invoice number the
    // office typed between that read and this write would be echoed away again.
    // The six columns must simply not appear in the DO UPDATE SET list at all.
    const SRC = require('fs').readFileSync(path.resolve(__dirname, '../api/timesheet-entries.js'), 'utf8');
    const upsert = SRC.slice(SRC.indexOf('INSERT INTO dust_control_entries'));
    const setList = upsert.slice(upsert.indexOf('DO UPDATE SET'), upsert.indexOf('updated_at   = NOW()'));
    for (const f of DUST_TAB_FIELDS) {
      assert(`an UPDATE never rewrites ${f}`, !setList.includes(`${f} `.trim() + ' ='));
    }
    assert('…while the payroll columns still are rewritten',
      setList.includes('gallons_ub') && setList.includes('company_man') && setList.includes('v1_rate'));
  }

  // ── Approving undoes an Intercompany removal; editing does not ───────────
  console.log('\n[approving overrules an earlier IC removal — editing does not]');
  {
    const suppressed = () => ({
      ...CONFIG,
      appData: { [`${CO}:${IC_REMOVED_BLOB}`]: [{ source: 'dust', source_id: dustRowId(42) }] },
    });
    // Approving is the deliberate statement that this work counts.
    const a = makeSql(suppressed());
    await insertDustTrackingRow(a.sql, CO, entry(), {}, { clearSuppression: true });
    assert('approving clears the suppression',
      a.store.appData.get(`${CO}:${IC_REMOVED_BLOB}`).length === 0);

    // Editing the row is not. Nothing was deleted and nothing needs recovering,
    // so correcting a gallons figure must not silently un-delete an entry
    // somebody removed in Intercompany — the money would just reappear.
    const b = makeSql(suppressed());
    await insertDustTrackingRow(b.sql, CO, entry(), { gallons_ub: 1700 });
    assert('an Edit Row leaves the suppression in place',
      b.store.appData.get(`${CO}:${IC_REMOVED_BLOB}`).length === 1);
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

  // ── One day, two customers ───────────────────────────────────────────────
  // The case this whole split exists for: ten hours, 4,000 gallons to the
  // customer on the timesheet and 2,000 to another, each its own invoice line.
  console.log('\n[a day split across two customers posts two rows]');
  {
    const { sql, store } = makeSql({
      ...CONFIG,
      companies: [...CONFIG.companies, { id: 'co-ant', name: 'Antero', v1_rate: 145, v2_rate: null }],
      locations: [...CONFIG.locations, { dust_company_id: 'co-ant', name: 'Bear Hollow', state: 'WV' }],
      men:       [...CONFIG.men,       { dust_company_id: 'co-ant', name: 'Maximus Lockerbie' }],
    });
    const day = entry({ start_time: '05:00', end_time: '15:00' });
    const rows = await insertDustTrackingRows(sql, CO, day, [
      { location: 'Deer Lick Compressor', start_time: '05:00', end_time: '10:00', gallons_ub: 4000 },
      { company: 'Antero', company_man: 'Maximus Lockerbie', location: 'Bear Hollow',
        start_time: '10:00', end_time: '15:00', gallons_ub: 2000 },
    ]);
    assert('two rows are posted', rows.length === 2);
    assert('leg 1 keeps the historic id, leg 2 gets its own',
      rows[0].id === dustRowId(42) && rows[1].id === dustRowId(42, 2));
    assert('each leg bills its own window',
      rows[0].start_time === '05:00' && rows[0].end_time === '10:00' &&
      rows[1].start_time === '10:00' && rows[1].end_time === '15:00');
    assert('each leg bills its own gallons',
      rows[0].gallons_ub === 4000 && rows[1].gallons_ub === 2000);
    assert('leg 1 stays with the timesheet customer', rows[0].company === 'CNX');
    assert('leg 2 goes to the customer it names',     rows[1].company === 'Antero');
    // The whole point of resolving a leg's options by ITS company: Antero's own
    // V1 default, and its own pad's state — not CNX's.
    assert('leg 2 takes its rate from the customer it named',
      rows[1].v1_rate === 145 && rows[0].v1_rate === 130);
    assert('leg 2\'s state follows its own pad', rows[1].state === 'WV' && rows[0].state === 'PA');
    assert('a customer with no escort rate is sent no escort', rows[1].vehicle2 === '');
    assert('both reached the table', store.dce.has(dustRowId(42)) && store.dce.has(dustRowId(42, 2)));

    // Re-editing reads both back, in leg order, for the modal to re-fill.
    const back = await dustSplitForEntry(sql, CO, day);
    assert('both legs read back in order',
      back.rows.length === 2 && back.rows[0].company === 'CNX' && back.rows[1].company === 'Antero');
    assert('their windows read back too',
      back.rows[0].end_time === '10:00' && back.rows[1].start_time === '10:00');
    assert('a page that only knows one row still gets the first leg',
      back.row && back.row.id === dustRowId(42));

    // Correcting the day back down to one customer must take leg 2's row — and
    // its billing entry — with it, or Antero keeps being invoiced for a haul the
    // timesheet no longer says happened.
    const after = await insertDustTrackingRows(sql, CO, day, [
      { location: 'Deer Lick Compressor', start_time: '05:00', end_time: '15:00', gallons_ub: 6000 },
    ]);
    assert('dropping a leg leaves one row', after.length === 1);
    assert('and takes the dropped leg out of the table',
      store.dce.has(dustRowId(42)) && !store.dce.has(dustRowId(42, 2)));
    assert('the surviving leg is rewritten in place',
      store.dce.get(dustRowId(42)).gallons_ub === 6000);
  }

  // ── The invoice stays with the haul it was raised for ───────────────────
  {
    console.log('\n[a removed haul does not hand its invoice to the next one]');
    const { sql, store } = makeSql({
      ...CONFIG,
      companies: [...CONFIG.companies, { id: 'co-ant', name: 'Antero', v1_rate: 145, v2_rate: null }],
    });
    const day = entry({ start_time: '05:00', end_time: '15:00' });
    await insertDustTrackingRows(sql, CO, day, [
      { location: 'Deer Lick Compressor', start_time: '05:00', end_time: '10:00', gallons_ub: 4000 },
      { company: 'Antero', start_time: '10:00', end_time: '15:00', gallons_ub: 2000 },
    ]);
    // The dust office invoices haul 1.
    Object.assign(store.dce.get(dustRowId(42)), {
      inv_number: 'INV-77', inv_status: 'sent', cm_approval: 'MB',
    });
    // A correction on the same customer keeps it…
    const same = await insertDustTrackingRows(sql, CO, day, [
      { location: 'Deer Lick Compressor', start_time: '05:00', end_time: '10:00', gallons_ub: 4500 },
      { company: 'Antero', start_time: '10:00', end_time: '15:00', gallons_ub: 2000 },
    ]);
    assert('a correction keeps the invoice on its own haul',
      same[0].inv_number === 'INV-77' && same[0].inv_status === 'sent');
    // …but Antero sliding into the vacated id does not inherit CNX's invoice.
    const moved = await insertDustTrackingRows(sql, CO, day, [
      { company: 'Antero', location: 'Bear Hollow', start_time: '05:00', end_time: '15:00', gallons_ub: 6000 },
    ]);
    assert('the surviving haul takes the vacated id', moved[0].id === dustRowId(42));
    assert('with a clean invoice sub-row',
      moved[0].inv_number === '' && moved[0].inv_status === '' && moved[0].cm_approval === '',
      JSON.stringify([moved[0].inv_number, moved[0].inv_status, moved[0].cm_approval]));
    assert('and it is the customer that was left', moved[0].company === 'Antero');
  }

  // ── A stray id is not a haul ─────────────────────────────────────────────
  {
    console.log('\n[rows under an id that names no haul]');
    const { sql, store } = makeSql(CONFIG);
    await insertDustTrackingRows(sql, CO, entry(), [{ location: 'Deer Lick Compressor' }]);
    // A Date.now()-stamped leftover, or a row a failed prune left behind.
    store.dce.set('tsd-42-1737059382000', {
      id: 'tsd-42-1737059382000', company: 'CNX', gallons_ub: '9999',
    });
    const back = await dustSplitForEntry(sql, CO, entry());
    assert('the day still reads as one haul',
      back.rows.length === 1 && back.rows[0].id === dustRowId(42),
      JSON.stringify(back.rows.map(r => r.id)));
    assert('the stray row is not offered as a second one',
      !back.rows.some(r => r.gallons_ub === '9999'));
    // …and the next save prunes it, like any row this split no longer has.
    await insertDustTrackingRows(sql, CO, entry(), [{ location: 'Deer Lick Compressor' }]);
    assert('and it is taken out of the table on the next save',
      !store.dce.has('tsd-42-1737059382000'));
  }

  // ── Blank is blank, whitespace included ──────────────────────────────────
  {
    console.log('\n[a gallons figure nobody has set yet]');
    assert('a whitespace-only gallons figure is blank, not zero',
      validateDustInjection({ gallons_ub: '  ' }).rows[0].gallons_ub === '');
    assert('a whitespace-only rate is blank too',
      validateDustInjection({ v1_rate: ' ' }).rows[0].v1_rate === '');
    assert('and a real zero still means zero',
      validateDustInjection({ gallons_ub: '0' }).rows[0].gallons_ub === 0);
  }

  // ── The customer picker a split leg chooses from ─────────────────────────
  console.log('\n[the customers a leg can be pointed at]');
  {
    const { sql } = makeSql(CONFIG);
    const dir = await dustCompanyDirectory(sql, CO);
    assert('every customer comes back', dir.length === 2);
    assert('with their own men and pads',
      dir.find(c => c.name === 'CNX').men.join() === 'Steve Quinn' &&
      dir.find(c => c.name === 'CNX').locations.length === 2 &&
      dir.find(c => c.name === 'Northeast Natural Energy').locations[0].state === 'WV');
    assert('and their default rates',
      dir.find(c => c.name === 'CNX').v1_rate === 130 &&
      dir.find(c => c.name === 'Northeast Natural Energy').v2_rate === null);
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
