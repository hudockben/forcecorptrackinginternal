#!/usr/bin/env node
'use strict';
/**
 * api/fuel-statement-matches.js — saving a reconciliation, and what saving
 * it makes visible.
 *
 * Run: node scripts/test-fuel-statement-matches.js
 * No DB or server required — the neon driver and the auth module are stubbed
 * at require time. scripts/test-fuel-statement-matches-sql.js drives the same
 * handler against a real PostgreSQL, where the upsert and the history rollup
 * are actually exercised.
 *
 * A saved match is a RECORD, not a cache. Two rules follow from that and both
 * are easy to break without noticing:
 *
 *   - the stored totals are what the statement said on the day it was
 *     reconciled. Re-deriving them later from fuel entries that have since
 *     been corrected would rewrite what somebody signed off.
 *   - re-matching a month REPLACES its saved match rather than stacking a
 *     second one beside it, and the ticks made while chasing trucks down
 *     survive that replacement. Losing them is losing the work, and the
 *     month would have to be walked again from the top.
 */

const path   = require('path');
const Module = require('module');

const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office',      fuelAdmin: true  };
const FIELD = { companyCode: 'FCT', userId: 7,  username: 'strickallen', fuelAdmin: false };

let CURRENT_SQL = null;
let NEXT_AUTH   = ADMIN;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      requireDivision: () => null,
      hasDivisionAccess: (p, area) => (area === 'fuel_admin' ? !!(p && p.fuelAdmin) : true),
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'fuel-statement-matches.js'));
const { normalizeMatch, monthOfPeriod } = handler._test;

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const LINES = [
  { truck_number: 412, ours: 300,  statement: 304.5, difference: -4.5, fills: 3, verdict: 'variance' },
  { truck_number: 77,  ours: 45,   statement: 45,    difference: 0,    fills: 1, verdict: 'match' },
  { truck_number: 55,  ours: null, statement: 75,    difference: null, fills: 0, verdict: 'not-in-ours' },
  { truck_number: 999, ours: 33,   statement: null,  difference: null, fills: 1, verdict: 'not-on-statement' },
];

const SAVE = {
  account: 'Guttman',
  period_start: '2026-07-01', period_end: '2026-07-31',
  ours_total: 378, statement_total: 424.5, difference: -46.5,
  source_note: 'guttman-july.csv',
  lines: LINES,
};

// ── 1. monthOfPeriod ────────────────────────────────────────────────────────
function monthTests() {
  console.log('\n[Is this period one whole month?]');
  // Worth storing rather than deriving: it is the difference between a saved
  // match that answers "how did July look" and one that answers "how did some
  // 47-day window look", and only the first compares month to month.
  assert('a full July is July',       monthOfPeriod('2026-07-01', '2026-07-31') === '2026-07');
  assert('February gets its length right', monthOfPeriod('2026-02-01', '2026-02-28') === '2026-02');
  assert('and a leap February too',   monthOfPeriod('2024-02-01', '2024-02-29') === '2024-02');
  assert('a part month is not a month', monthOfPeriod('2026-07-01', '2026-07-30') === null);
  assert('nor one that starts late',  monthOfPeriod('2026-07-02', '2026-07-31') === null);
  assert('nor a quarter',             monthOfPeriod('2026-07-01', '2026-09-30') === null);
  assert('nor nothing at all',        monthOfPeriod(null, null) === null);
}

// ── 2. normalizeMatch ───────────────────────────────────────────────────────
function normalizeTests() {
  console.log('\n[normalizeMatch]');

  assert('a period is required', normalizeMatch({ lines: LINES }).error != null);
  assert('a period that ends before it starts is refused',
    normalizeMatch({ period_start: '2026-07-31', period_end: '2026-07-01', lines: LINES }).error != null);
  // A match with no lines would count as a reconciled period in the history
  // rollup while saying nothing about any truck — worse than not saving it.
  assert('an empty match is refused',
    normalizeMatch({ period_start: '2026-07-01', period_end: '2026-07-31', lines: [] }).error != null);
  assert('an invented verdict is refused',
    normalizeMatch(Object.assign({}, SAVE, {
      lines: [{ truck_number: 1, verdict: 'probably fine' }],
    })).error != null);

  {
    const { data } = normalizeMatch(SAVE);
    assert('the counts are derived from the lines, not trusted from the body',
      data.matched_count === 1 && data.variance_count === 1 &&
      data.not_in_ours_count === 1 && data.not_on_statement_count === 1,
      JSON.stringify([data.matched_count, data.variance_count, data.not_in_ours_count, data.not_on_statement_count]));
    assert('the truck count is the number of lines', data.truck_count === 4);
    assert('a whole month is stamped as one', data.period_month === '2026-07');
  }
  {
    // '' is a real answer here — "all accounts together" — not a missing one.
    const { data } = normalizeMatch(Object.assign({}, SAVE, { account: '' }));
    assert('an empty account is stored, not refused', data && data.account === '');
  }
  {
    const { data } = normalizeMatch(Object.assign({}, SAVE, {
      period_start: '2026-07-01', period_end: '2026-08-15',
    }));
    assert('a range that is not a whole month has no month stamp', data.period_month === null);
  }
  {
    const { data } = normalizeMatch(Object.assign({}, SAVE, { ours_total: '378.005' }));
    assert('totals round to the hundredth', data.ours_total === 378.01, String(data.ours_total));
  }
  {
    // truck_number is INTEGER. A fuel-card number read off a statement as a
    // truck is thirteen digits, and letting it through means the INSERT dies
    // with "integer out of range" AFTER the save has cleared the previous
    // lines — taking the reconciliation and its ticks with it.
    const { error } = normalizeMatch(Object.assign({}, SAVE, {
      lines: [{ truck_number: 7001234567890, ours: 1, statement: 1, difference: 0, fills: 1, verdict: 'match' }],
    }));
    assert('a card-sized truck number is refused before it reaches the insert', error != null, String(error));
    assert('and the message points at the column rather than the number',
      /which column/.test(error || ''), String(error));
  }
  {
    const { data } = normalizeMatch(Object.assign({}, SAVE, {
      lines: [{ truck_number: 2147483647, ours: 1, statement: 1, difference: 0, fills: 1, verdict: 'match' }],
    }));
    assert('the largest number the column can hold is still a truck',
      data && data.lines[0].truck_number === 2147483647);
  }
  {
    // A truck the statement has never billed carries no number at all.
    const { data } = normalizeMatch(Object.assign({}, SAVE, {
      lines: [{ truck_number: null, ours: 1, statement: null, difference: null, fills: 1, verdict: 'not-on-statement' }],
    }));
    assert('and a line with no truck number is still storable', data && data.lines[0].truck_number === null);
  }
}

// ── 3. Routing and access ───────────────────────────────────────────────────
function makeRes() {
  return {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
}

async function call(method, query, body, auth = ADMIN, tables = {}) {
  NEXT_AUTH = auth;
  const seen = [];
  CURRENT_SQL = (strings, ...values) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    seen.push({ q, values });
    if (/^SELECT l\.truck_number/.test(q))                  return Promise.resolve(tables.history || []);
    if (/^SELECT \* FROM fuel_statement_matches/.test(q))   return Promise.resolve(tables.matches || []);
    if (/^SELECT \* FROM fuel_statement_lines/.test(q))     return Promise.resolve(tables.lines || []);
    if (/^SELECT truck_number, resolved/.test(q))           return Promise.resolve(tables.prior || []);
    if (/^INSERT INTO fuel_statement_matches/.test(q))      return Promise.resolve([tables.saved || { id: 1 }]);
    if (/^INSERT INTO fuel_statement_lines/.test(q))        return Promise.resolve([]);
    if (/^UPDATE fuel_statement_lines/.test(q))             return Promise.resolve([tables.updatedLine || { id: 9, verdict: 'variance' }]);
    if (/^DELETE/.test(q))                                  return Promise.resolve([]);
    return Promise.resolve([]);
  };
  const res = makeRes();
  await handler({ method, query: query || {}, body: body || {} }, res);
  return { res, seen };
}

async function routingTests() {
  console.log('\n[Access]');
  for (const [method, query, body] of [
    ['GET', {}, null], ['POST', {}, SAVE],
    ['PATCH', { line_id: '1' }, { resolved: true }], ['DELETE', { id: '1' }, null],
  ]) {
    const { res } = await call(method, query, body, FIELD);
    assert(`a field user cannot ${method} a saved match`, res.statusCode === 403);
  }

  console.log('\n[Save]');
  {
    const { res, seen } = await call('POST', {}, SAVE, ADMIN);
    assert('an admin can save one', res.statusCode === 200 && res.body.ok, JSON.stringify(res.body));
    const ins = seen.find(s => /^INSERT INTO fuel_statement_matches/.test(s.q));
    // Two saved matches for one month would each look authoritative.
    assert('a re-save replaces the month rather than stacking beside it',
      /ON CONFLICT \(company_code, account, period_start, period_end\) DO UPDATE/.test(ins.q),
      ins.q.slice(0, 140));
    // One statement, not one per truck. The insert follows a DELETE that has
    // already removed the previous lines, so the gap between them is the
    // window in which a saved reconciliation does not exist — a per-line loop
    // makes that window as long as the fleet, and a serverless function killed
    // partway through leaves a match header over a partial set of lines.
    const lineInserts = seen.filter(s => /^INSERT INTO fuel_statement_lines/.test(s.q));
    assert('every line goes in one statement', lineInserts.length === 1, String(lineInserts.length));
    assert('expanded by the database from one JSON parameter, not bound arrays',
      /jsonb_to_recordset/.test(lineInserts[0].q), lineInserts[0].q.slice(0, 140));
    assert('carrying all four trucks',
      JSON.parse(lineInserts[0].values.find(v => typeof v === 'string' && v.startsWith('['))).length === 4);
    assert('and the old lines are cleared first',
      seen.findIndex(s => /^DELETE FROM fuel_statement_lines/.test(s.q)) <
      seen.findIndex(s => /^INSERT INTO fuel_statement_lines/.test(s.q)));
  }
  {
    // The work of having chased a truck down must survive the month being
    // re-matched after one entry is corrected.
    const { res, seen } = await call('POST', {}, SAVE, ADMIN, {
      prior: [
        { truck_number: 412, resolved: true,  resolution_note: 'driver used the wrong card' },
        { truck_number: 77,  resolved: false, resolution_note: null },
      ],
    });
    assert('ticks are carried across a re-save', res.body.carried_over === 1, String(res.body.carried_over));
    const ins  = seen.find(s => /^INSERT INTO fuel_statement_lines/.test(s.q));
    const rows = JSON.parse(ins.values.find(v => typeof v === 'string' && v.startsWith('[')));
    const t412 = rows.find(r => r.truck_number === 412);
    assert('and land on the right truck',
      t412.resolved === true && t412.note === 'driver used the wrong card', JSON.stringify(t412));
    const t77 = rows.find(r => r.truck_number === 77);
    assert('a truck that was never ticked stays untouched',
      t77.resolved === false && t77.note === null, JSON.stringify(t77));
  }

  console.log('\n[Tick a line]');
  {
    const { res } = await call('PATCH', {}, { resolved: true }, ADMIN);
    assert('a tick with no line id is a 400', res.statusCode === 400);
  }
  {
    const { res } = await call('PATCH', { line_id: '9' }, { resolved: true }, ADMIN, { lines: [] });
    assert('ticking a line that is gone is a 404', res.statusCode === 404);
  }
  {
    const { seen } = await call('PATCH', { line_id: '9' }, { resolved: true }, ADMIN, {
      lines: [{ id: 9, resolved: false, resolution_note: 'left alone' }],
    });
    const upd = seen.find(s => /^UPDATE fuel_statement_lines/.test(s.q));
    // A body that says nothing about the note must not erase one.
    assert('ticking a line leaves its existing note alone',
      upd.values.includes('left alone'), JSON.stringify(upd.values));
  }
  {
    const { seen } = await call('PATCH', { line_id: '9' }, { resolution_note: '' }, ADMIN, {
      lines: [{ id: 9, resolved: true, resolution_note: 'old note' }],
    });
    const upd = seen.find(s => /^UPDATE fuel_statement_lines/.test(s.q));
    assert('but an explicitly empty note clears it', upd.values.includes(null), JSON.stringify(upd.values));
    assert('and the tick is left as it was', upd.values.includes(true), JSON.stringify(upd.values));
  }

  console.log('\n[History]');
  {
    const { res, seen } = await call('GET', { action: 'history' }, null, ADMIN, { history: [] });
    assert('history answers even with nothing saved', res.statusCode === 200 && Array.isArray(res.body.trucks));
    assert('and defaults to a year', res.body.months === 12, String(res.body.months));
    const q = seen.find(s => /^SELECT l\.truck_number/.test(s.q));
    // A month nobody reconciled says nothing about a truck either way, and
    // counting it as clean would make an unbalanced truck look like it came
    // right on its own.
    assert('it counts saved matches only, by joining them',
      /JOIN fuel_statement_matches/.test(q.q), q.q.slice(0, 120));
    assert('and ranks by what is still open, not by raw variance count',
      /ORDER BY \(COUNT\(\*\) FILTER \(WHERE l\.verdict <> 'match' AND NOT l\.resolved\)\) DESC/.test(q.q),
      q.q.slice(-200));
  }
  {
    const { res } = await call('GET', { action: 'history', months: '400' }, null, ADMIN, { history: [] });
    assert('an absurd window is capped', res.body.months === 60, String(res.body.months));
  }
  {
    const { res } = await call('GET', { action: 'history' }, null, ADMIN, {
      history: [{ truck_number: 412, periods: 4, agreed: 1, variances: 3, missing: 0, resolved: 1,
                  net: -18.5, abs_total: 18.5, last_seen: '2026-07-31', last_ok: '2026-04-30' }],
    });
    const t = res.body.trucks[0];
    assert('a truck comes back with its whole record',
      t.truck_number === 412 && t.periods === 4 && t.variances === 3 && t.resolved === 1,
      JSON.stringify(t));
    assert('and the dates are plain YYYY-MM-DD', t.last_seen === '2026-07-31' && t.last_ok === '2026-04-30');
  }

  console.log('\n[Read back]');
  {
    const { res } = await call('GET', { id: '1' }, null, ADMIN, { matches: [] });
    assert('a saved match that is gone is a 404', res.statusCode === 404);
  }
  {
    const { res } = await call('GET', { id: '1' }, null, ADMIN, {
      matches: [{ id: 1, account: 'Guttman', period_start: '2026-07-01', period_end: '2026-07-31',
                  period_month: '2026-07', ours_total: '378.00', statement_total: '424.50',
                  difference: '-46.50', truck_count: 4, matched_count: 1, variance_count: 1,
                  not_in_ours_count: 1, not_on_statement_count: 1 }],
      lines: [{ id: 9, match_id: 1, truck_number: 412, ours: '300.00', statement: '304.50',
                difference: '-4.50', fills: 3, verdict: 'variance', resolved: false }],
    });
    assert('it comes back with its lines', res.body.match && res.body.lines.length === 1);
    // NUMERIC arrives from the driver as a string; the page does arithmetic
    // on these, so they have to cross as numbers.
    assert('and every figure crosses as a number',
      res.body.match.ours_total === 378 && res.body.lines[0].difference === -4.5,
      JSON.stringify([res.body.match.ours_total, res.body.lines[0].difference]));
  }
  {
    const { res } = await call('DELETE', {}, null, ADMIN);
    assert('deleting with no id is a 400', res.statusCode === 400);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  monthTests();
  normalizeTests();
  await routingTests();

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────');
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
