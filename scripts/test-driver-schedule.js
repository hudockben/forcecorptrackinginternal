#!/usr/bin/env node
'use strict';
/**
 * /api/driver/schedule — a driver's own hauls, and what they report back.
 *
 * Run: node scripts/test-driver-schedule.js
 *
 * A driver holds the 'driver' division and nothing else, so this endpoint is
 * the only thing standing between a phone and the whole trucking board. What
 * it must never do is hand back a row that does not name the caller, and what
 * it must never accept is a report filed against someone else's haul.
 *
 * Verifies:
 *   - an unmapped login gets mapped:false and an empty schedule, never a
 *     guess at who they might be,
 *   - the username → driver map is matched case-insensitively,
 *   - only the caller's assignments come back, and only inside the range,
 *   - an existing report is attached to the assignment it answers,
 *   - a POST against another driver's haul is refused,
 *   - a POST against an id that is on no schedule at all is refused,
 *   - a POST from an unmapped login is refused,
 *   - numbers and times are validated rather than passed through,
 *   - and a user with neither 'driver' nor 'trucking' is turned away.
 *
 * No DB or server required.
 */

const Module = require('module');

let AUTH  = { companyCode: 'FCT', userId: 7, username: 'kirkd' };
let ACCESS = { driver: true, trucking: false };
let CAPTURED = [];

// app_data blobs the endpoint reads, plus the report rows it queries.
let BLOBS = {};
let REPORT_ROWS = [];

function fakeSql(strings, ...vals) {
  const q = strings.join('?');
  CAPTURED.push({ q, vals });
  if (/FROM app_data/.test(q)) {
    const key = vals[0];
    return Promise.resolve(BLOBS[key] ? [{ value: BLOBS[key] }] : []);
  }
  if (/FROM trucking_driver_reports/.test(q)) return Promise.resolve(REPORT_ROWS);
  if (/INSERT INTO trucking_driver_reports/.test(q)) return Promise.resolve([]);
  return Promise.resolve([]);
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => fakeSql };
  if (request === '../lib/auth') {
    return {
      requireAuth: () => AUTH,
      hasDivisionAccess: (_p, d) => !!ACCESS[d],
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require('../api/driver/schedule.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else { failed++; console.log('  FAIL  ' + label + (detail ? '  → ' + detail : '')); }
}

function call(method, { query = {}, body = {} } = {}) {
  return new Promise(resolve => {
    const res = {
      _status: 200,
      setHeader() {},
      status(c) { this._status = c; return this; },
      json(b) { resolve({ status: this._status, body: b }); return this; },
      end() { resolve({ status: this._status, body: null }); return this; },
    };
    handler({ method, query, body, headers: {} }, res);
  });
}

const D1 = '2026-08-26', D2 = '2026-08-27', FAR = '2026-12-01';

function seed() {
  BLOBS = {
    'FCT:fct_trucking_driver_logins': { version: 1, map: { 'KirkD': 'Kirk, Dan', 'rankinc': 'Rankin, Canyon' } },
    'FCT:fct_trucking_schedule': {
      version: 1,
      assignments: {
        [D1]: [
          { id: 'mine-1',  driver: 'Kirk, Dan',      customer: 'Kiewit',   unit: 'T-101', start: '06:00', end: '14:00', notes: 'stone',
            location: 'Pinetree Pit', address: '1400 Quarry Rd, Somerset PA' },
          { id: 'theirs-1', driver: 'Rankin, Canyon', customer: 'Turf Div', unit: 'T-202', start: '07:00', end: '15:00', notes: '' },
        ],
        [D2]: [{ id: 'mine-2', driver: 'Kirk, Dan', customer: 'Pinetree', unit: 'T-303', start: '05:30', end: '13:00', notes: '' }],
        [FAR]: [{ id: 'mine-far', driver: 'Kirk, Dan', customer: 'Later', unit: 'T-9', start: '06:00', end: '10:00', notes: '' }],
      },
    },
  };
  REPORT_ROWS = [];
  AUTH = { companyCode: 'FCT', userId: 7, username: 'kirkd' };
  ACCESS = { driver: true, trucking: false };
  CAPTURED = [];
}

(async () => {
  console.log('\n── identity ──');
  {
    seed();
    // 'kirkd' vs the map's 'KirkD' — sign-in boxes are not case sensitive.
    const r = await call('GET', { query: { from: D1, to: D2 } });
    assert('case-insensitive username match resolves the driver',
      r.body.mapped === true && r.body.driver === 'Kirk, Dan', JSON.stringify(r.body).slice(0, 120));

    seed();
    AUTH = { companyCode: 'FCT', userId: 9, username: 'someone-new' };
    const u = await call('GET', { query: { from: D1, to: D2 } });
    assert('unmapped login → mapped:false and no days',
      u.body.mapped === false && u.body.driver === null && u.body.days.length === 0,
      JSON.stringify(u.body).slice(0, 120));
  }

  console.log('\n── what comes back ──');
  {
    seed();
    const r = await call('GET', { query: { from: D1, to: D2 } });
    const ids = r.body.days.flatMap(d => d.assignments.map(a => a.id));
    assert('only my assignments', JSON.stringify(ids) === JSON.stringify(['mine-1', 'mine-2']), JSON.stringify(ids));
    assert('another driver\'s haul is absent', !ids.includes('theirs-1'));
    assert('out-of-range day is absent', !ids.includes('mine-far'));
    // The driver is the one navigating, so the address has to reach the phone.
    const first = r.body.days[0].assignments[0];
    assert('the haul carries its address and location',
      first.address === '1400 Quarry Rd, Somerset PA' && first.location === 'Pinetree Pit',
      JSON.stringify(first));
    assert('a haul with no address comes back with empty strings, not undefined',
      r.body.days[1].assignments[0].address === '' && r.body.days[1].assignments[0].location === '',
      JSON.stringify(r.body.days[1].assignments[0]));

    assert('days are dated and ordered',
      r.body.days.map(d => d.date).join(',') === `${D1},${D2}`, r.body.days.map(d => d.date).join(','));

    seed();
    REPORT_ROWS = [{ assignment_id: 'mine-1', tons: 24.5, loads: 3, actual_start: '06:05',
                     actual_end: '14:20', tickets: 'T-8891', notes: 'ok', submitted_at: 'x', updated_at: 'y' }];
    const w = await call('GET', { query: { from: D1, to: D2 } });
    const a1 = w.body.days[0].assignments[0];
    assert('an existing report is attached to its assignment',
      a1.id === 'mine-1' && a1.report && Number(a1.report.tons) === 24.5, JSON.stringify(a1).slice(0, 140));
    assert('an unreported haul carries report:null',
      w.body.days[1].assignments[0].report === null);
  }

  console.log('\n── reporting back ──');
  {
    seed();
    const ok = await call('POST', { body: { assignment_id: 'mine-1', tons: '24.5', loads: '3',
      actual_start: '06:05', actual_end: '14:20', tickets: 'T-8891', notes: 'clean run' } });
    assert('a report against my own haul is accepted',
      ok.status === 200 && ok.body.ok === true && ok.body.work_date === D1, JSON.stringify(ok.body));
    const ins = CAPTURED.find(c => /INSERT INTO trucking_driver_reports/.test(c.q));
    assert('tons and loads are stored as numbers',
      ins && ins.vals.includes(24.5) && ins.vals.includes(3), ins && JSON.stringify(ins.vals));
    assert('the driver name is taken from the map, not the request',
      ins && ins.vals.includes('Kirk, Dan'));

    seed();
    const theirs = await call('POST', { body: { assignment_id: 'theirs-1', tons: '99' } });
    assert('a report against another driver\'s haul is refused',
      theirs.status === 404, 'status ' + theirs.status);
    assert('  …and nothing was written',
      !CAPTURED.some(c => /INSERT INTO trucking_driver_reports/.test(c.q)));

    seed();
    const ghost = await call('POST', { body: { assignment_id: 'no-such-id', tons: '5' } });
    assert('a report against an unknown id is refused', ghost.status === 404, 'status ' + ghost.status);

    seed();
    AUTH = { companyCode: 'FCT', userId: 9, username: 'someone-new' };
    const un = await call('POST', { body: { assignment_id: 'mine-1', tons: '5' } });
    assert('an unmapped login cannot report at all', un.status === 403, 'status ' + un.status);

    seed();
    await call('POST', { body: { assignment_id: 'mine-1', tons: 'abc', loads: '-4',
      actual_start: '25:99', actual_end: '', tickets: '', notes: '' } });
    const bad = CAPTURED.find(c => /INSERT INTO trucking_driver_reports/.test(c.q));
    const nulls = bad.vals.slice(6, 12);   // tons, loads, start, end, tickets, notes
    assert('junk numbers and times land as NULL, not as text',
      nulls.every(v => v === null), JSON.stringify(nulls));

    seed();
    const missing = await call('POST', { body: { tons: '5' } });
    assert('a POST with no assignment_id is refused', missing.status === 400, 'status ' + missing.status);
  }

  console.log('\n── access ──');
  {
    seed();
    ACCESS = { driver: false, trucking: false };
    const r = await call('GET', { query: { from: D1, to: D2 } });
    assert('no driver and no trucking access → 403', r.status === 403, 'status ' + r.status);

    seed();
    ACCESS = { driver: false, trucking: true };
    const o = await call('GET', { query: { from: D1, to: D2 } });
    assert('the trucking office may read it too', o.status === 200, 'status ' + o.status);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('FATAL', err); process.exit(1); });
