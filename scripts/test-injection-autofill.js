#!/usr/bin/env node
'use strict';
/**
 * Payroll approval → daily_tracking auto-fill: rate, job class, equipment cost.
 *
 * Run: node scripts/test-injection-autofill.js
 *
 * An injected cost row is only worth anything if it carries money. Two lookups
 * feed that, and both were failing quietly — a row landed with the raw login in
 * the employee column, no job class, rate 0 and equipment unit cost 0, so the
 * labor and equipment cost both read $0.00 in the tracking tab.
 *
 *   Employee   The roster blob stores display names ("Zach Brewer"); the
 *              timesheet carries the login. The old matcher tried the name
 *              verbatim and then a " surname" suffix, which only ever covered a
 *              surname login. A "brewerzach" or "zachbrewer" login matched
 *              nothing, so there was no rate to copy.
 *
 *   Equipment  Cost came from the division's list blob alone, but the payroll
 *              modal offers a wider set — api/equipment.js serves the
 *              equipment_list table and the split modal adds the project's
 *              assigned_equipment. Anything offerable but absent from the blob
 *              resolved to $0.
 *
 * No DB or server required: the neon driver and the auth module are stubbed at
 * require time, and the sql tagged template is an in-memory mock that records
 * every statement so the INSERT's values can be asserted directly.
 */

const path   = require('path');
const Module = require('module');

let CURRENT_SQL = null;
// Set to override the identity the handler sees on the next call — used to
// prove a non-admin cannot reach the backfill.
let NEXT_AUTH = null;
const ADMIN = { companyCode: 'FCT', userId: 1, username: 'admin', payrollAdmin: true };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH || ADMIN,
      requireDivision: () => null,
      // Mirror the real gate: payroll admin is what canAdmin is built from
      // (hasDivisionAccess(payload, 'payroll')). A stub that always says yes
      // would let the permission test pass without a permission check.
      hasDivisionAccess: (p, area) => (area === 'payroll' ? !!(p && p.payrollAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};

const { matchRosterEmployee, insertSplitRows } =
  require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'))._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const ROSTER = [
  { name: 'Zach Brewer',  job_class: 'Operator', non_prevailing_rate: 32.5, prevailing_rate: 58 },
  { name: 'Jamey Boring', job_class: 'Laborer',  non_prevailing_rate: 26,   prevailing_rate: 47 },
  { name: 'Steve Travis', job_class: 'Foreman',  non_prevailing_rate: 41,   prevailing_rate: 66 },
  { name: 'Lucas Mowery', job_class: 'Laborer',  non_prevailing_rate: 25,   prevailing_rate: 45 },
];

// ── 1) Roster matching ──────────────────────────────────────────────────────
function rosterTests() {
  console.log('\n[matchRosterEmployee]');
  const hit = login => { const m = matchRosterEmployee(ROSTER, login); return m && m.name; };

  // The shapes actually in use on this rollout.
  assert('surname + first name  ("brewerzach")',  hit('brewerzach')  === 'Zach Brewer');
  assert('surname + first name  ("boringjamey")', hit('boringjamey') === 'Jamey Boring');
  assert('surname + first name  ("travissteve")', hit('travissteve') === 'Steve Travis');
  // The shapes that already worked, which must keep working.
  assert('surname alone         ("mowery")',      hit('mowery')      === 'Lucas Mowery');
  assert('the full name itself  ("Zach Brewer")', hit('Zach Brewer') === 'Zach Brewer');
  // Other common conventions.
  assert('first + surname       ("zachbrewer")',  hit('zachbrewer')  === 'Zach Brewer');
  assert('initial + surname     ("zbrewer")',     hit('zbrewer')     === 'Zach Brewer');
  assert('surname + initial     ("brewerz")',     hit('brewerz')     === 'Zach Brewer');
  assert('case and punctuation are ignored',      hit('Brewer.Zach') === 'Zach Brewer');

  // Never guess. A wrong guess copies someone else's pay rate onto the row.
  assert('an unknown login matches nothing',      hit('nobody') === undefined || hit('nobody') === null);
  assert('a blank login matches nothing',         matchRosterEmployee(ROSTER, '')   === null);
  assert('a null login matches nothing',          matchRosterEmployee(ROSTER, null) === null);
  assert('an empty roster matches nothing',       matchRosterEmployee([], 'brewerzach')   === null);
  assert('a missing roster matches nothing',      matchRosterEmployee(null, 'brewerzach') === null);

  const twoBrewers = [
    { name: 'Zach Brewer', job_class: 'A' },
    { name: 'Zeb Brewer',  job_class: 'B' },
  ];
  assert('an ambiguous surname is refused, not guessed',
    matchRosterEmployee(twoBrewers, 'brewer') === null);
  assert('an ambiguous initial+surname is refused',
    matchRosterEmployee([{ name: 'Zach Brewer' }, { name: 'Zeb Brewer' }], 'zbrewer') === null);
  assert('an exact full name still wins over the ambiguity',
    matchRosterEmployee(twoBrewers, 'zebbrewer').name === 'Zeb Brewer');

  // Names the parser must not choke on.
  assert('a hyphenated name resolves',  matchRosterEmployee([{ name: 'Mary-Jane Olsen' }], 'olsenmaryjane').name === 'Mary-Jane Olsen');
  assert('an apostrophe resolves',      matchRosterEmployee([{ name: "Sean O'Brien" }],    'obriensean').name    === "Sean O'Brien");
  assert('a middle name resolves',      matchRosterEmployee([{ name: 'Ana Del Rio' }],     'riodel')             === null);
  assert('first+last across a middle name resolves',
    matchRosterEmployee([{ name: 'Ana Maria Rio' }], 'rioana').name === 'Ana Maria Rio');
  assert('a one-word roster entry is not mangled',
    matchRosterEmployee([{ name: 'Mowery' }], 'mowery').name === 'Mowery');
}

// ── 2) The injected row's money fields ──────────────────────────────────────
// Mock sql: serves the project blob, the lists blob and the equipment_list
// table, and records every statement.
function makeSql({ equipmentBlob = [], equipmentTable = [], prevailingWage = false } = {}) {
  const log = [];
  const sql = (strings, ...values) => {
    const q = strings.join(' ').replace(/\s+/g, ' ').trim();
    log.push({ q, values });
    // The division list blob — a single-key read.
    if (q.startsWith('SELECT value FROM app_data')) {
      return Promise.resolve([{ value: { employees: ROSTER, equipment: equipmentBlob } }]);
    }
    // Project blobs — batched with key = ANY(...) so one read covers every job
    // in the set. Mirrors prevailingWageByJob's actual query.
    if (q.startsWith('SELECT key, value FROM app_data')) {
      const keys = Array.isArray(values[0]) ? values[0] : [];
      return Promise.resolve(keys.map(k => ({ key: k, value: { prevailing_wage: prevailingWage } })));
    }
    if (q.includes('FROM equipment_list')) return Promise.resolve(equipmentTable);
    return Promise.resolve([]);
  };
  sql.log = log;
  sql.inserted = () => {
    const ins = log.find(e => e.q.startsWith('INSERT INTO daily_tracking'));
    if (!ins) return null;
    const v = ins.values;
    // Column order in insertSplitRows' INSERT.
    return {
      row_id: v[0], project_id: v[1], company_code: v[2], division: v[3], date: v[4],
      employee: v[6], cost_code: v[7], sub_code: v[8], job_class: v[9],
      rate: v[10], labor_hours: v[11], equipment: v[12],
      equip_unit_cost: v[13], equip_hours: v[14],
    };
  };
  sql.equipmentReads = () => log.filter(e => e.q.includes('FROM equipment_list')).length;
  return sql;
}

const ENTRY = { id: 99, job_id: 'J1', work_date: '2026-08-03' };
const splitRow = over => Object.assign({
  cost_code: 'General', sub_code: 'General Time',
  equipment: '', labor_hours: 8, equip_hours: 0, quantity: 0,
}, over);

async function injectionTests() {
  console.log('\n[insertSplitRows — labor]');
  {
    const sql = makeSql();
    await insertSplitRows(sql, [splitRow()], ENTRY, 'turf', 'FCT', 'brewerzach');
    const r = sql.inserted();
    assert('the roster name replaces the raw login', r.employee === 'Zach Brewer');
    assert('job class is filled in',                 r.job_class === 'Operator');
    assert('the non-prevailing rate is filled in',   r.rate === 32.5);
    assert('labor cost is no longer $0',             r.rate * r.labor_hours === 260);
  }
  {
    const sql = makeSql({ prevailingWage: true });
    await insertSplitRows(sql, [splitRow()], ENTRY, 'turf', 'FCT', 'brewerzach');
    assert('a prevailing-wage job takes the prevailing rate', sql.inserted().rate === 58);
  }
  {
    const sql = makeSql();
    await insertSplitRows(sql, [splitRow()], ENTRY, 'turf', 'FCT', 'ghost');
    const r = sql.inserted();
    assert('an unmatched login still injects the row', !!r);
    assert('an unmatched login keeps the login as the label', r.employee === 'ghost');
    assert('an unmatched login gets rate 0, not a wrong rate', r.rate === 0 && r.job_class === null);
  }

  console.log('\n[insertSplitRows — equipment]');
  {
    const sql = makeSql({ equipmentBlob: [{ name: 'Skid Steer', unit_cost: 45 }] });
    await insertSplitRows(sql, [splitRow({ equipment: 'Skid Steer', equip_hours: 3 })], ENTRY, 'turf', 'FCT', 'brewerzach');
    assert('the division blob supplies the unit cost', sql.inserted().equip_unit_cost === 45);
    assert('a blob hit costs no extra query',          sql.equipmentReads() === 0);
  }
  {
    // The reported case: the machine is offerable in the modal but absent from
    // the blob, so the cost has to come from the equipment_list table.
    const sql = makeSql({
      equipmentBlob:  [{ name: 'Skid Steer', unit_cost: 45 }],
      equipmentTable: [{ name: 'Pickup Truck', unit_cost: 18.75 }],
    });
    await insertSplitRows(sql, [splitRow({ equipment: 'Pickup Truck', equip_hours: 2 })], ENTRY, 'turf', 'FCT', 'brewerzach');
    const r = sql.inserted();
    assert('a machine missing from the blob falls back to the table', r.equip_unit_cost === 18.75);
    assert('equipment cost is no longer $0', r.equip_unit_cost * r.equip_hours === 37.5);
  }
  {
    const sql = makeSql({
      equipmentBlob:  [{ name: 'Pickup Truck', unit_cost: 0 }],
      equipmentTable: [{ name: 'Pickup Truck', unit_cost: 18.75 }],
    });
    await insertSplitRows(sql, [splitRow({ equipment: 'Pickup Truck', equip_hours: 2 })], ENTRY, 'turf', 'FCT', 'brewerzach');
    assert('a priced entry beats one listed at zero', sql.inserted().equip_unit_cost === 18.75);
  }
  {
    const sql = makeSql({
      equipmentBlob:  [{ name: 'Skid Steer', unit_cost: 45 }],
      equipmentTable: [{ name: 'Skid Steer', unit_cost: 99 }],
    });
    await insertSplitRows(sql, [splitRow({ equipment: 'Skid Steer', equip_hours: 3 })], ENTRY, 'turf', 'FCT', 'brewerzach');
    assert("the division's own price wins when it has one", sql.inserted().equip_unit_cost === 45);
  }
  {
    const sql = makeSql({ equipmentBlob: [{ name: 'Skid Steer', unit_cost: 45 }] });
    await insertSplitRows(sql, [splitRow({ equipment: '  skid steer ', equip_hours: 1 })], ENTRY, 'turf', 'FCT', 'brewerzach');
    assert('case and stray spaces do not zero the cost', sql.inserted().equip_unit_cost === 45);
  }
  {
    const sql = makeSql({ equipmentTable: [{ name: 'Pickup Truck', unit_cost: 18.75 }] });
    await insertSplitRows(sql, [splitRow()], ENTRY, 'turf', 'FCT', 'brewerzach');
    assert('a row with no equipment costs no extra query', sql.equipmentReads() === 0);
    assert('a row with no equipment has unit cost 0',      sql.inserted().equip_unit_cost === 0);
  }
  {
    // A table read that blows up must not take the approval down with it.
    const sql = makeSql({ equipmentTable: [] });
    const boom = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      if (q.includes('FROM equipment_list')) return Promise.reject(new Error('connection reset'));
      return sql(strings, ...values);
    };
    boom.log = sql.log;
    await insertSplitRows(boom, [splitRow({ equipment: 'Pickup Truck', equip_hours: 2 })], ENTRY, 'turf', 'FCT', 'brewerzach');
    assert('a failed cost lookup still injects the row', !!sql.inserted());
    assert('a failed cost lookup falls back to 0',       sql.inserted().equip_unit_cost === 0);
  }
}

// ── 3) The backfill: POST ?action=refresh-rates ─────────────────────────────
// Rates land on a cost row at approval time, so time approved before a rate
// existed keeps its zeros. This re-pulls them in place. What it must NOT do is
// as important as what it does: never overwrite a field the supervisor owns,
// never trade a real value for one it could not resolve, and never guess a rate
// for a login it cannot match.
async function refreshTests() {
  console.log('\n[POST ?action=refresh-rates]');
  const handler = require(path.resolve(__dirname, '..', 'api', 'timesheet-entries.js'));

  function run(rows, { equipmentTable = [], prevailingWage = false } = {}) {
    const updates = [];
    CURRENT_SQL = (strings, ...values) => {
      const q = strings.join(' ').replace(/\s+/g, ' ').trim();
      if (q.startsWith('SELECT value FROM app_data')) {
        return Promise.resolve([{ value: { employees: ROSTER, equipment: [] } }]);
      }
      if (q.startsWith('SELECT key, value FROM app_data')) {
        return Promise.resolve((values[0] || []).map(k => ({ key: k, value: { prevailing_wage: prevailingWage } })));
      }
      if (q.includes('FROM equipment_list'))   return Promise.resolve(equipmentTable);
      if (q.includes('FROM daily_tracking dt')) return Promise.resolve(rows);
      if (q.startsWith('UPDATE daily_tracking')) {
        updates.push({ employee: values[0], job_class: values[1], rate: values[2], equip_unit_cost: values[3], row_id: values[4] });
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    };
    const res = {
      statusCode: 200, body: null,
      setHeader() {}, status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; }, end() { return this; },
    };
    return handler({ method: 'POST', query: { action: 'refresh-rates' }, body: {} }, res)
      .then(() => ({ res, updates }));
  }

  const row = over => Object.assign({
    row_id: 'ts99-a-0-1', division: 'turf', employee: 'brewerzach', job_class: null,
    rate: 0, equipment: '', equip_unit_cost: 0, username: 'brewerzach', job_id: 'J1',
  }, over);

  {
    const { res, updates } = await run([row({ equipment: 'Pickup Truck' })],
      { equipmentTable: [{ name: 'Pickup Truck', unit_cost: 18.75 }] });
    assert('a zeroed row is repaired', updates.length === 1);
    assert('the roster name replaces the login', updates[0].employee === 'Zach Brewer');
    assert('the job class is filled in',         updates[0].job_class === 'Operator');
    assert('the rate is filled in',              updates[0].rate === 32.5);
    assert('the equipment price is filled in',   updates[0].equip_unit_cost === 18.75);
    assert('the response reports the work',      res.body.scanned === 1 && res.body.updated === 1);
  }
  {
    const { updates } = await run([row({ employee: 'Zach Brewer', job_class: 'Operator', rate: 32.5 })]);
    assert('a row already correct is not rewritten', updates.length === 0);
  }
  {
    // job_class is supervisor-editable in the division tab (see
    // INJECTED_EDITABLE_FIELDS) — a deliberate re-categorization must survive.
    const { updates } = await run([row({ job_class: 'Flagger' })]);
    assert('a supervisor-set job class is preserved', updates[0].job_class === 'Flagger');
    assert('but the rate is still corrected',         updates[0].rate === 32.5);
  }
  {
    const { res, updates } = await run([row({ username: 'ghostuser', employee: 'ghostuser' })]);
    assert('an unmatched login is left alone entirely', updates.length === 0);
    assert('and is reported so the roster gap is visible',
      res.body.unresolved.length === 1 && res.body.unresolved[0].username === 'ghostuser');
  }
  {
    const { updates } = await run([row({ equipment: 'Mystery Machine', equip_unit_cost: 55 })]);
    assert('an unresolvable machine keeps the price it has', updates[0].equip_unit_cost === 55);
  }
  {
    const { updates } = await run([row()], { prevailingWage: true });
    assert('a prevailing-wage job backfills the prevailing rate', updates[0].rate === 58);
  }
  {
    const { res } = await run([]);
    assert('an empty range is a clean no-op', res.body.ok && res.body.scanned === 0 && res.body.updated === 0);
  }
  {
    // Non-admins must not be able to rewrite cost data.
    const denied = { statusCode: 200, body: null, setHeader() {},
      status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
    NEXT_AUTH = { companyCode: 'FCT', userId: 2, username: 'field', payrollAdmin: false };
    await handler({ method: 'POST', query: { action: 'refresh-rates' }, body: {} }, denied);
    NEXT_AUTH = null;
    assert('a non-admin is refused', denied.statusCode === 403);
  }
}

(async () => {
  rosterTests();
  await injectionTests();
  await refreshTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
