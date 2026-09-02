#!/usr/bin/env node
'use strict';
/**
 * The division override: payroll can send part of an approved day's cost to a
 * division the driver did not name.
 *
 * Run: node scripts/test-split-division-override.js
 *
 * A driver picks one division on his timesheet and the whole day used to follow
 * it. When he picks wrong — a truck driver filing a customer haul against the
 * turf job he happened to be hauling for, or a turf hand who spent half a day
 * at the quarry — payroll had two ways out and neither fitted: send the day
 * back, or move the WHOLE entry with the Edit modal. Neither can say "six of
 * these hours were turf and four were a haul for EAI".
 *
 * So a split row may now name its own destination. The hours are untouched —
 * the grid still balances against the entry's own clock to the cent, and the
 * driver is still paid for the day he worked — but WHERE each row's cost lands
 * is the approver's to say.
 *
 * The three daily_tracking divisions take a row whole. The three blob
 * divisions are written by their own injectors, which is what this file is
 * mostly about: each of them rewrites every row it owns for an entry in one
 * pass, so a fan-out that called them once per destination would have each call
 * delete the one before it.
 *
 * No DB or server required: the neon driver and the auth module are stubbed at
 * require time, and the sql tagged template is an in-memory mock with a real
 * key/value store behind app_data so the blob round-trips are exercised.
 */

const path   = require('path');
const Module = require('module');

let CURRENT_SQL = null;
const ADMIN = { companyCode: 'FCT', userId: 1, username: 'admin', payrollAdmin: true };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => ADMIN,
      requireDivision: () => null,
      hasDivisionAccess: (p, area) => (area === 'payroll' ? !!(p && p.payrollAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};

const TS = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));
const {
  SPLIT_DEST_DIVISIONS, validateSplit, normalizeSplitDest, splitDestOf,
  blobBoundSplitRows, injectSplitDestinations, removeSplitDestinationRows,
  quarryHasInjectedRow,
} = TS._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// Two rosters. Cam is on turf's; paving has never heard of him, which is the
// case the rate fallback exists for.
const TURF_ROSTER = [
  { name: 'Cam Rising', job_class: 'Driver', non_prevailing_rate: 31, prevailing_rate: 55 },
];
const PAVING_ROSTER = [
  { name: 'Matt Shuffstall', job_class: 'Operator', non_prevailing_rate: 38, prevailing_rate: 61 },
];

const LISTS_BLOB = {
  'FCT:fct_lists':        { employees: TURF_ROSTER,   equipment: [{ name: 'Triaxle Dump', unit_cost: 121 }] },
  'FCT:fct_paving_lists': { employees: PAVING_ROSTER, equipment: [] },
  'FCT:fct_kiewit_lists': { employees: [],            equipment: [] },
};

/**
 * Mock sql with a real key/value store behind app_data, so a blob written by
 * one injector is read back by the next. Everything else answers empty, which
 * is what the roster/driver lookups do on a company that has not filled them
 * in — the injectors are all written to survive that.
 */
function makeSql() {
  const store = new Map(Object.entries(LISTS_BLOB).map(([k, v]) => [k, v]));
  const inserts = [];   // daily_tracking INSERTs, values in column order
  const dustRows = [];  // dust_control_entries INSERTs
  const log = [];
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    log.push({ q, values });

    if (q.startsWith('INSERT INTO daily_tracking')) {
      inserts.push({
        row_id: values[0], project_id: values[1], division: values[3],
        field_type: values[5], employee: values[6],
        cost_code: values[7], sub_code: values[8], job_class: values[9],
        rate: values[10], labor_hours: values[11], equipment: values[12],
        equip_unit_cost: values[13], equip_hours: values[14],
        quantity: values[21], timesheet_entry_id: values[22],
      });
      return Promise.resolve([]);
    }
    // Batched project-blob read (prevailingWageByJob).
    if (q.startsWith('SELECT key, value FROM app_data')) {
      const keys = Array.isArray(values[0]) ? values[0] : [];
      return Promise.resolve(keys.map(k => ({ key: k, value: { prevailing_wage: false } })));
    }
    if (q.startsWith('SELECT value FROM app_data')) {
      const k = String(values[0] || '');
      return Promise.resolve(store.has(k) ? [{ value: store.get(k) }] : []);
    }
    if (q.startsWith('INSERT INTO app_data')) {
      store.set(String(values[0]), JSON.parse(values[1]));
      return Promise.resolve([]);
    }
    if (q.startsWith('INSERT INTO dust_control_entries')) {
      dustRows.push({ id: values[0], values });
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  sql.store = store;
  sql.inserts = inserts;
  sql.dustRows = dustRows;
  sql.log = log;
  sql.blob = key => {
    const v = store.get(`FCT:${key}`);
    return Array.isArray(v) ? v : [];
  };
  return sql;
}

const ENTRY = {
  id: 900, company_code: 'FCT', username: 'risingcam', entry_type: 'daily',
  division: 'turf', job_id: 'p-frank', job_label: 'Franklin Regional Multi',
  work_date: '2026-09-01', start_time: '06:00', end_time: '16:30',
  computed_hours: 10, travel_hours: 0, haul_type: null, truck_unit: '4021',
};

const row = (o = {}) => Object.assign({
  cost_code: 'Earthwork', sub_code: 'Excess Cut - Off Site', equipment: '',
  labor_hours: 0, equip_hours: 0, quantity: 0, is_travel: false, dest: null,
}, o);

// ── 1) What a destination is allowed to be ─────────────────────────────────
function destValidationTests() {
  console.log('\n[normalizeSplitDest]');

  assert('every division is a legal destination',
    ['turf', 'paving', 'kiewit', 'trucking', 'dust', 'quarry']
      .every(d => SPLIT_DEST_DIVISIONS.includes(d)));

  assert('no destination at all is the ordinary row',
    normalizeSplitDest(undefined, 0).dest === null);
  assert('and so is a destination naming no division',
    normalizeSplitDest({ division: '' }, 0).dest === null);

  assert('an unknown division is refused',
    /must be one of/.test(normalizeSplitDest({ division: 'shop', job_id: 'x' }, 0).error || ''));
  // Without a job there is nothing to post the row against, and every injector
  // downstream reads it off the entry it is handed.
  assert('a destination with no job is refused',
    /names no job/.test(normalizeSplitDest({ division: 'paving' }, 2).error || ''));
  assert('and the error names the row',
    /split\[2\]/.test(normalizeSplitDest({ division: 'paving' }, 2).error || ''));

  const paving = normalizeSplitDest({ division: 'paving', job_id: 'pv-8', job_label: 'ACMH' }, 0).dest;
  assert('a daily_tracking destination carries its job', paving.job_id === 'pv-8');
  assert('and its label', paving.job_label === 'ACMH');
  assert('a destination with no label falls back to the id',
    normalizeSplitDest({ division: 'paving', job_id: 'pv-8' }, 0).dest.job_label === 'pv-8');

  // Quarry encodes the tab in the job id. Without one there is no tab to land
  // in, which is the same demand the quarry approve path makes of an entry.
  assert('a quarry job with no activity is refused',
    /no Daily\/Crushing activity/.test(
      normalizeSplitDest({ division: 'quarry', job_id: 'homer-city' }, 0).error || ''));
  // The quarry tab renders an injected row read-only and owns no column on it,
  // so unlike a haul — which falls back to the customer's agreed rate and can be
  // re-priced by the office afterwards — a quarry row that lands at rate 0 is a
  // $0 cost row nobody downstream is able to correct.
  assert('a quarry destination with no rate is refused',
    /give this row an hourly rate/.test(
      normalizeSplitDest({ division: 'quarry', job_id: 'crushing:hc' }, 0).error || ''));
  assert('and so is one whose rate is zero',
    !!normalizeSplitDest({ division: 'quarry', job_id: 'daily:hc', quarry: { rate: 0 } }, 0).error);
  const q = normalizeSplitDest(
    { division: 'quarry', job_id: 'crushing:hc', job_label: 'Crushing — Homer City', quarry: { hourlyRate: 95 } }, 0).dest;
  assert('a quarry destination resolves its activity', q.activity === 'crushing');
  assert('and carries the rate it was given', q.extras.hourlyRate === 95);
  assert('the crushing tab reads its rate from hourlyRate, the daily tab from rate',
    normalizeSplitDest({ division: 'quarry', job_id: 'daily:hc', quarry: { rate: 88 } }, 0).dest.extras.rate === 88);
  assert('the numbers only that office can know still default to zero',
    q.extras.fuelGallons === 0 && q.extras.tonsPerLoad === 0);

  // Half a window is worse than none: insertTruckingRows fills the missing
  // boundary from the whole day, stamping a four-hour haul 06:00-16:30.
  assert('a haul given only a start time is refused',
    /half a time window/.test(
      normalizeSplitDest({ division: 'trucking', job_id: 'c-eai', trucking: { start_time: '06:00' } }, 0).error || ''));
  assert('and one given only an end time',
    /half a time window/.test(
      normalizeSplitDest({ division: 'trucking', job_id: 'c-eai', trucking: { end_time: '10:00' } }, 0).error || ''));
  assert('a whole window is fine',
    !normalizeSplitDest({ division: 'trucking', job_id: 'c-eai', trucking: { start_time: '06:00', end_time: '10:00' } }, 0).error);
  assert('and so is none at all — the hours come from the grid',
    !normalizeSplitDest({ division: 'trucking', job_id: 'c-eai' }, 0).error);

  // The extras are validated by the DESTINATION's own validator, so a rule
  // that holds on a trucking day holds on a trucking-bound override too.
  assert('a bad haul fee is refused by trucking\'s own validator',
    !!normalizeSplitDest({ division: 'trucking', job_id: 'EAI', trucking: { haul_fee: 'lots' } }, 0).error);
  const t = normalizeSplitDest({ division: 'trucking', job_id: 'c-eai', job_label: 'EAI' }, 0).dest;
  assert('the customer on the row is the job the override named', t.extras.company === 'EAI');
  assert('a bad dust destination is refused by dust\'s own validator',
    !!normalizeSplitDest({ division: 'dust', job_id: 'co-cnx', dust: { dest: 'nowhere' } }, 0).error);
}

// ── 2) The cost code rule ──────────────────────────────────────────────────
function costCodeTests() {
  console.log('\n[a cost code is a daily_tracking idea]');
  const entry = { computed_hours: 4, travel_hours: 0 };
  const bare = { labor_hours: 4, cost_code: '', sub_code: '' };

  assert('a row staying on this division still needs one',
    /needs at least a cost code/.test(validateSplit([bare], entry).error || ''));
  assert('and so does one sent to another daily_tracking division',
    /needs at least a cost code/.test(
      validateSplit([{ ...bare, dest: { division: 'paving', job_id: 'pv-8' } }], entry).error || ''));
  // A Truck Tracking row is a customer, a window and a fee. There is no column
  // for a cost code, so demanding one would make the override impossible.
  assert('a row sent to Truck Tracking does not',
    !validateSplit([{ ...bare, dest: { division: 'trucking', job_id: 'c-eai' } }], entry).error);
  assert('nor one sent to the quarry',
    !validateSplit([{ ...bare, dest: { division: 'quarry', job_id: 'daily:hc', quarry: { rate: 74 } } }], entry).error);

  // The hours rule is untouched: the split still has to add up to the day.
  assert('the day must still balance, override or not',
    /must equal computed_hours/.test(validateSplit(
      [{ ...bare, labor_hours: 3, dest: { division: 'trucking', job_id: 'c-eai' } }], entry).error || ''));
}

// ── 3) Which rows count as "sent somewhere" ────────────────────────────────
function homeTests() {
  console.log('\n[an override naming this entry\'s own job is not one]');
  const same = splitDestOf(ENTRY, row({ dest: { division: 'turf', job_id: 'p-frank', job_label: 'x' } }));
  assert('same division and job reads as home', same.home === true);
  assert('a different job on the same division does not',
    splitDestOf(ENTRY, row({ dest: { division: 'turf', job_id: 'p-other' } })).home === false);
  assert('and neither does another division',
    splitDestOf(ENTRY, row({ dest: { division: 'paving', job_id: 'pv-8' } })).home === false);
  assert('no destination at all reads as home',
    splitDestOf(ENTRY, row()).home === true);

  // Only the blob-bound rows are stored on the entry: a daily_tracking row can
  // be read back off the cost itself, and may have been re-coded since.
  const rows = [
    row({ labor_hours: 3 }),
    row({ labor_hours: 3, dest: { division: 'paving', job_id: 'pv-8', job_label: 'ACMH', extras: {} } }),
    row({ labor_hours: 4, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: {} } }),
  ];
  const stored = blobBoundSplitRows(ENTRY, rows);
  assert('only the blob-bound row is stored for read-back', stored.length === 1);
  assert('and it carries its destination', stored[0].dest.division === 'trucking');
  assert('with the hours the grid gave it', stored[0].labor_hours === 4);
}

// ── 4) The fan-out ─────────────────────────────────────────────────────────
async function fanOutTests() {
  console.log('\n[a day that stays where it was]');
  {
    const sql = makeSql();
    const dests = await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 6 }), row({ labor_hours: 4, equipment: 'Triaxle Dump', equip_hours: 4 }),
    ]);
    assert('posts both rows to daily_tracking', sql.inserts.length === 2);
    assert('under the entry\'s own division', sql.inserts.every(r => r.division === 'turf'));
    assert('and its own job', sql.inserts.every(r => r.project_id === 'p-frank'));
    assert('priced from the turf roster', sql.inserts[0].rate === 31);
    assert('with the job class off the same roster', sql.inserts[0].job_class === 'Driver');
    assert('and reports no destinations at all', dests.length === 0);
    assert('touching no blob', sql.blob('fct_truck_division').length === 0);
  }

  console.log('\n[half the day sent to another daily_tracking division]');
  {
    const sql = makeSql();
    const dests = await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 6 }),
      row({ labor_hours: 4, dest: { division: 'paving', job_id: 'pv-8', job_label: 'ACMH', extras: {} } }),
    ]);
    assert('both rows still post', sql.inserts.length === 2);
    const moved = sql.inserts.find(r => r.division === 'paving');
    assert('one lands on paving', !!moved);
    assert('against the paving job', moved && moved.project_id === 'pv-8');
    assert('the other stays on turf', sql.inserts.some(r => r.division === 'turf' && r.project_id === 'p-frank'));
    // Two calls into insertSplitRows, and the row ids must not collide — the
    // index counts across them, or the second row is swallowed by the
    // ON CONFLICT DO NOTHING.
    assert('the row ids are distinct', sql.inserts[0].row_id !== sql.inserts[1].row_id);
    assert('both still point back at the entry',
      sql.inserts.every(r => r.timesheet_entry_id === 900));
    assert('and the destination is reported', dests.length === 1 && dests[0].division === 'paving');
    assert('with the hours that went there', dests[0].hours === 4);
  }

  console.log('\n[the man is priced off his own roster, not the destination\'s]');
  {
    const sql = makeSql();
    // Cam is on turf's roster and not on paving's. Pricing him from the
    // destination alone posts a $0 labour row that reads, on the paving tab,
    // as a rate lookup that failed.
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 10, dest: { division: 'paving', job_id: 'pv-8', job_label: 'ACMH', extras: {} } }),
    ]);
    assert('the row carries his turf rate', sql.inserts[0].rate === 31);
    assert('and his turf job class', sql.inserts[0].job_class === 'Driver');
    assert('and the roster\'s spelling of his name', sql.inserts[0].employee === 'Cam Rising');
  }
  {
    const sql = makeSql();
    // …but a man the destination DOES know is priced by the office running
    // that job, because that is the rate it agreed to.
    const shuff = { ...ENTRY, username: 'shuffstallmatt' };
    await injectSplitDestinations(sql, 'FCT', shuff, [
      row({ labor_hours: 8, dest: { division: 'paving', job_id: 'pv-8', job_label: 'ACMH', extras: {} } }),
    ]);
    assert('a man on the destination roster is priced by it', sql.inserts[0].rate === 38);
  }

  console.log('\n[hours sent to Truck Tracking]');
  {
    const sql = makeSql();
    const dests = await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 6 }),
      row({ labor_hours: 4, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } }),
    ]);
    assert('the turf half still posts to daily_tracking',
      sql.inserts.length === 1 && sql.inserts[0].division === 'turf');
    const truck = sql.blob('fct_truck_division');
    assert('and one Truck Tracking row is written', truck.length === 1);
    assert('billing the hours the grid gave it, not the whole day',
      truck[0] && truck[0].total_hours === 4);
    assert('against the customer the override named', truck[0] && truck[0].customer === 'EAI');
    assert('carrying the unit off the timesheet', truck[0] && truck[0].unit === '4021');
    assert('and keyed to the entry so un-approve can find it',
      truck[0] && String(truck[0].id).startsWith('tst-900-'));
    assert('the destination is reported', dests.some(d => d.division === 'trucking' && d.hours === 4));
  }

  console.log('\n[a day split across two trucking customers]');
  {
    const sql = makeSql();
    // One call, two legs. Once per customer would have the second call delete
    // the first customer's row — Truck Tracking rewrites every row it owns for
    // an entry in one pass.
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 6, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } }),
      row({ labor_hours: 4, dest: { division: 'trucking', job_id: 'c-ees', job_label: 'EES', extras: { company: 'EES' } } }),
    ]);
    const truck = sql.blob('fct_truck_division');
    assert('both hauls survive', truck.length === 2);
    assert('each billing its own hours',
      truck.map(r => r.total_hours).sort().join() === '4,6',
      truck.map(r => `${r.customer}:${r.total_hours}`).join(' '));
    assert('and naming its own customer',
      truck.map(r => r.customer).sort().join() === 'EAI,EES');
    assert('the two rows have distinct ids', truck[0].id !== truck[1].id);
  }

  console.log('\n[hours sent to the quarry]');
  {
    const sql = makeSql();
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 7 }),
      row({ labor_hours: 3, dest: {
        division: 'quarry', job_id: 'daily:hc', job_label: 'Daily — Homer City',
        activity: 'daily', extras: { equipmentId: '', equipmentName: '', taskId: '', taskName: '', rate: 74, fuelGallons: 0, ppg: 0 },
      } }),
    ]);
    const daily = sql.blob('fct_quarry_daily');
    assert('one quarry Daily row is written', daily.length === 1);
    assert('for the hours the grid allocated', daily[0] && daily[0].hours === 3);
    assert('at the location the override named', daily[0] && daily[0].locationId === 'hc');
    assert('and keyed to the entry', daily[0] && String(daily[0].id).startsWith('tsq-900-'));
    assert('the Crushing blob is untouched', sql.blob('fct_quarry_crushing').length === 0);
  }

  console.log('\n[a day split across both quarry tabs]');
  {
    const sql = makeSql();
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 4, dest: {
        division: 'quarry', job_id: 'daily:hc', job_label: 'Daily — Homer City', activity: 'daily',
        extras: { equipmentId: '', equipmentName: '', taskId: '', taskName: '', rate: 74, fuelGallons: 0, ppg: 0 },
      } }),
      row({ labor_hours: 6, dest: {
        division: 'quarry', job_id: 'crushing:hc', job_label: 'Crushing — Homer City', activity: 'crushing',
        extras: { hourlyRate: 95, hoursCrushing: 0, fuelGallons: 0, fuelCost: 0, loadsToCrusher: 0, tonsPerLoad: 0, comments: '' },
      } }),
    ]);
    assert('the Daily tab gets its row', sql.blob('fct_quarry_daily').length === 1);
    assert('the Crushing tab gets its own', sql.blob('fct_quarry_crushing').length === 1);
    assert('each with its own hours',
      sql.blob('fct_quarry_daily')[0].hours === 4 && sql.blob('fct_quarry_crushing')[0].hours === 6);
    assert('and distinct ids across the two blobs',
      sql.blob('fct_quarry_daily')[0].id !== sql.blob('fct_quarry_crushing')[0].id);
  }

  console.log('\n[a day spread over three divisions at once]');
  {
    const sql = makeSql();
    const dests = await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 3 }),
      row({ labor_hours: 3, dest: { division: 'paving', job_id: 'pv-8', job_label: 'ACMH', extras: {} } }),
      row({ labor_hours: 4, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } }),
    ]);
    assert('daily_tracking holds the turf and paving halves', sql.inserts.length === 2);
    assert('Truck Tracking holds the haul', sql.blob('fct_truck_division').length === 1);
    assert('and every destination is reported once', dests.length === 2);
    const hours = dests.reduce((s, d) => s + d.hours, 0);
    assert('the reported hours are the ones that left this division', hours === 7);
  }
}

// ── 5) Taking it all back ──────────────────────────────────────────────────
async function teardownTests() {
  console.log('\n[un-approve has to find it wherever it went]');
  const sql = makeSql();
  await injectSplitDestinations(sql, 'FCT', ENTRY, [
    row({ labor_hours: 4, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } }),
    row({ labor_hours: 6, dest: {
      division: 'quarry', job_id: 'daily:hc', job_label: 'Daily — Homer City', activity: 'daily',
      extras: { equipmentId: '', equipmentName: '', taskId: '', taskName: '', rate: 74, fuelGallons: 0, ppg: 0 },
    } }),
  ]);
  assert('the rows are there to start with',
    sql.blob('fct_truck_division').length === 1 && sql.blob('fct_quarry_daily').length === 1);
  assert('and the quarry row is visible to the edit guard',
    (await quarryHasInjectedRow(sql, 'FCT', ENTRY)) === true);

  // The sweep is keyed on the entry id alone — it never asks what division the
  // entry says it is, which is the whole reason the override can be undone.
  const removed = await removeSplitDestinationRows(sql, 'FCT', ENTRY);
  assert('the sweep reports what it took', removed === 2, `removed ${removed}`);
  assert('the Truck Tracking row is gone', sql.blob('fct_truck_division').length === 0);
  assert('the quarry row is gone', sql.blob('fct_quarry_daily').length === 0);
  assert('and the edit guard agrees',
    (await quarryHasInjectedRow(sql, 'FCT', ENTRY)) === false);

  // A turf entry that never used the override sweeps nothing and breaks
  // nothing — which is what makes it safe to run unconditionally.
  const clean = makeSql();
  assert('an entry that never used the override sweeps nothing',
    (await removeSplitDestinationRows(clean, 'FCT', ENTRY)) === 0);

  // Another entry's rows are never touched: every id carries its own entry.
  const shared = makeSql();
  await injectSplitDestinations(shared, 'FCT', ENTRY, [
    row({ labor_hours: 10, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } }),
  ]);
  await removeSplitDestinationRows(shared, 'FCT', { ...ENTRY, id: 901 });
  assert('sweeping a different entry leaves this one alone',
    shared.blob('fct_truck_division').length === 1);
}

// ── 6) Re-saving the split moves the cost rather than duplicating it ───────
async function resplitTests() {
  console.log('\n[re-saving a split moves the cost, it does not duplicate it]');
  const sql = makeSql();
  const eai = row({ labor_hours: 10, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } });
  await injectSplitDestinations(sql, 'FCT', ENTRY, [eai]);
  assert('the first save posts one haul', sql.blob('fct_truck_division').length === 1);

  // What resplit does: sweep, then re-inject. Pointed at a different customer
  // this time.
  await removeSplitDestinationRows(sql, 'FCT', ENTRY);
  await injectSplitDestinations(sql, 'FCT', ENTRY, [
    row({ labor_hours: 10, dest: { division: 'trucking', job_id: 'c-ees', job_label: 'EES', extras: { company: 'EES' } } }),
  ]);
  const truck = sql.blob('fct_truck_division');
  assert('the second save leaves exactly one haul', truck.length === 1, `found ${truck.length}`);
  assert('and it is the new customer', truck[0] && truck[0].customer === 'EES');

  // And moving it out of trucking entirely takes the row with it.
  await removeSplitDestinationRows(sql, 'FCT', ENTRY);
  await injectSplitDestinations(sql, 'FCT', ENTRY, [row({ labor_hours: 10 })]);
  assert('moving the hours home empties Truck Tracking',
    sql.blob('fct_truck_division').length === 0);
  assert('and posts them to daily_tracking instead',
    sql.inserts.length === 1 && sql.inserts[0].division === 'turf');
}

// ── 7) The bugs a review caught, pinned so they cannot come back ───────────
async function regressionTests() {
  console.log('\n[two rows for one customer are two hauls, not one]');
  {
    const sql = makeSql();
    // Grouping the fan-out by destination folded these into a single leg: the
    // hours were summed but only the FIRST row's window survived, so the tab
    // showed one 06:00-10:00 haul billing seven hours.
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 4, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI',
        extras: { company: 'EAI', start_time: '06:00', end_time: '10:00' } } }),
      row({ labor_hours: 6, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI',
        extras: { company: 'EAI', start_time: '11:00', end_time: '17:00' } } }),
    ]);
    const truck = sql.blob('fct_truck_division');
    assert('both hauls are written', truck.length === 2, `found ${truck.length}`);
    assert('each billing its own hours',
      truck.map(r => r.total_hours).sort().join() === '4,6');
    assert('and stamped with its own window',
      truck.map(r => `${r.actual_start}-${r.actual_end}`).sort().join(' ') === '06:00-10:00 11:00-17:00',
      truck.map(r => `${r.actual_start}-${r.actual_end}`).join(' '));
  }
  {
    const sql = makeSql();
    // Worse on the dust side: a dust row has no hours column, so the window IS
    // what it bills. A folded leg lost the second pad's hours outright.
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 4, dest: { division: 'dust', job_id: 'co-cnx', job_label: 'CNX',
        extras: { company: 'CNX', start_time: '06:00', end_time: '10:00' } } }),
      row({ labor_hours: 3, dest: { division: 'dust', job_id: 'co-cnx', job_label: 'CNX',
        extras: { company: 'CNX', start_time: '13:00', end_time: '16:00' } } }),
      row({ labor_hours: 3 }),
    ]);
    assert('both pads are billed', sql.dustRows.length === 2, `found ${sql.dustRows.length}`);
    assert('and the afternoon one is not the morning one again',
      new Set(sql.dustRows.map(r => r.id)).size === 2);
  }

  console.log('\n[a row with only equipment hours still bills them]');
  {
    const sql = makeSql();
    // validateSplit accepts a row carrying equipment hours alone. Counting only
    // labour posted a haul of 0 hours against a real fee.
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 10 }),
      row({ labor_hours: 0, equip_hours: 8, equipment: 'Triaxle Dump',
        dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } }),
    ]);
    const truck = sql.blob('fct_truck_division');
    assert('the haul bills the hours the truck ran', truck[0] && truck[0].total_hours === 8,
      truck[0] && String(truck[0].total_hours));
  }

  console.log('\n[the cap the destination tabs can actually read back]');
  {
    const entry = { computed_hours: 7, travel_hours: 0 };
    const haul = i => ({
      labor_hours: 1, cost_code: '', sub_code: '',
      dest: { division: 'trucking', job_id: `c-${i}`, job_label: `C${i}` },
    });
    const six   = Array.from({ length: 6 }, (_, i) => haul(i));
    six[0].labor_hours = 2;
    assert('six hauls are fine', !validateSplit(six, entry).error);
    const seven = Array.from({ length: 7 }, (_, i) => haul(i));
    // Past the cap the leg index encoded in the row id stops round-tripping:
    // truckRowLegIndex collapses everything above six onto leg 1, where the
    // read-time sweep deletes all but one as duplicates.
    assert('seven are refused rather than written and swept away',
      /at most 6 Truck Tracking rows/.test(validateSplit(seven, entry).error || ''),
      validateSplit(seven, entry).error);
  }

  console.log('\n[a re-split must not blank the invoice the office already sent]');
  {
    const sql = makeSql();
    const dest = { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } };
    await injectSplitDestinations(sql, 'FCT', ENTRY, [row({ labor_hours: 10, dest })]);
    // The trucking office invoices it.
    const blob = sql.blob('fct_truck_division');
    blob[0].qb_invoice = 'QB-8891';
    blob[0].invoice_status = 'Paid';
    sql.store.set('FCT:fct_truck_division', blob);

    // Payroll reopens Edit Split and saves. The sweep must leave trucking alone,
    // because insertTruckingRows is about to rewrite that row and carry the
    // office's own columns across — deleting it first throws them away.
    const keep = TS._test.splitDestinationDivisions(ENTRY, [row({ labor_hours: 10, dest })]);
    await removeSplitDestinationRows(sql, 'FCT', ENTRY, { keep });
    await injectSplitDestinations(sql, 'FCT', ENTRY, [row({ labor_hours: 10, dest })]);
    const after = sql.blob('fct_truck_division');
    assert('the haul is still one row', after.length === 1);
    assert('the invoice number survived the re-split', after[0].qb_invoice === 'QB-8891',
      String(after[0] && after[0].qb_invoice));
    assert('and so did its status', after[0].invoice_status === 'Paid');
  }
  {
    const sql = makeSql();
    // …but a destination the split no longer posts to IS swept, or the old row
    // stands beside the new one.
    await injectSplitDestinations(sql, 'FCT', ENTRY, [
      row({ labor_hours: 10, dest: { division: 'trucking', job_id: 'c-eai', job_label: 'EAI', extras: { company: 'EAI' } } }),
    ]);
    const keep = TS._test.splitDestinationDivisions(ENTRY, [row({ labor_hours: 10 })]);
    assert('a split with no blob destinations keeps nothing', keep.size === 0);
    await removeSplitDestinationRows(sql, 'FCT', ENTRY, { keep });
    assert('so the haul is taken back', sql.blob('fct_truck_division').length === 0);
  }
}

// ── 8) The read-time sweeps must not treat an override row as an orphan ────
function sweepTests() {
  console.log('\n[the tabs sweep rows whose entry no longer justifies them]');
  const { findStaleTruckRows } = require(path.resolve(__dirname, '..', 'api', 'lib', 'truck-injected.js'));
  const { findStaleDustRows }  = require(path.resolve(__dirname, '..', 'api', 'lib', 'dust-injected.js'));
  const { findStaleObRows }    = require(path.resolve(__dirname, '..', 'api', 'lib', 'dust-ob-injected.js'));

  const turf = extra => new Map([[900, Object.assign(
    { id: 900, status: 'approved', entry_type: 'daily', division: 'turf', job_id: 'p-frank' }, extra)]]);
  const sentTo = division => turf({
    split_destinations: [{ labor_hours: 4, dest: { division, job_id: 'x', job_label: 'X' } }],
  });

  // A turf entry with no override has no business owning these rows, and the
  // sweep taking them back is the behaviour that keeps a stranded row from
  // outliving its entry. That must not change.
  assert('a turf entry that sent nothing still loses a stray haul',
    findStaleTruckRows([{ id: 'tst-900-row' }], turf()).length === 1);
  assert('and a stray dust row',
    findStaleDustRows([{ id: 'tsd-900-row' }], turf()).length === 1);
  assert('and a stray Other Billing row',
    findStaleObRows([{ id: 'tso-900-1' }], turf()).length === 1);

  // But one the override put there is payroll's, and deleting it on a page load
  // takes the Intercompany billing entry with it.
  assert('a turf entry that sent hours to trucking keeps its haul',
    findStaleTruckRows([{ id: 'tst-900-row' }], sentTo('trucking')).length === 0);
  assert('a turf entry that sent hours to dust keeps its dust row',
    findStaleDustRows([{ id: 'tsd-900-row' }], sentTo('dust')).length === 0);
  assert('and its Other Billing row',
    findStaleObRows([{ id: 'tso-900-1' }], sentTo('dust')).length === 0);

  // The record is read as data, not trusted blindly: a split that went to dust
  // does not justify a Truck Tracking row.
  assert('sending to dust does not justify a haul row',
    findStaleTruckRows([{ id: 'tst-900-row' }], sentTo('dust')).length === 1);
  // And it stops mattering the moment the entry is no longer approved.
  const unapproved = new Map([[900, {
    id: 900, status: 'submitted', entry_type: 'daily', division: 'turf',
    split_destinations: [{ dest: { division: 'trucking', job_id: 'x' } }],
  }]]);
  assert('an un-approved entry loses the row whatever it once sent',
    findStaleTruckRows([{ id: 'tst-900-row' }], unapproved).length === 1);
  // JSONB read back as text must not silently disable the whole rule.
  const asText = new Map([[900, {
    id: 900, status: 'approved', entry_type: 'daily', division: 'turf',
    split_destinations: JSON.stringify([{ dest: { division: 'trucking', job_id: 'x' } }]),
  }]]);
  assert('the record is understood even when it arrives as text',
    findStaleTruckRows([{ id: 'tst-900-row' }], asText).length === 0);
}

(async () => {
  console.log('Split division override\n');
  destValidationTests();
  costCodeTests();
  homeTests();
  await fanOutTests();
  await teardownTests();
  await resplitTests();
  await regressionTests();
  sweepTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('Harness error:', err);
  process.exit(1);
});
