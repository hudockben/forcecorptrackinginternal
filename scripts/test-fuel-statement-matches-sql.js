#!/usr/bin/env node
'use strict';
process.env.TZ = 'Europe/Berlin';
/**
 * SQL-level integration test for /api/fuel-statement-matches.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-fuel-statement-matches-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates fuel_statement_matches and fuel_statement_lines. It
 * refuses to run against a database whose name doesn't look like a test one.
 *
 * The mocked suite asserts what the handler intends to send. Everything worth
 * pinning here is what the DATABASE does with it, and none of it can be
 * checked against a stub:
 *
 *   - the unique index that makes the upsert an upsert. Without it ON CONFLICT
 *     has nothing to catch and a re-saved month becomes two saved months,
 *     each looking authoritative and each counted separately in the history.
 *   - lines cascading when a match is deleted, rather than being orphaned
 *     into the rollup forever.
 *   - the history rollup itself, which is a GROUP BY with four FILTER clauses
 *     and is the entire basis for calling a truck a repeat offender.
 *
 * Periods are built relative to today so the twelve-month history window
 * always contains them — pinning them to fixed dates would make this pass
 * this year and fail silently the next.
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script truncates tables. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

let AUTH = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth') {
    return {
      requireAuth: () => AUTH,
      requireDivision: () => null,
      hasDivisionAccess: (p, area) => {
        if (!p) return false;
        if (p.isPlatformAdmin) return true;
        return !!(p.divisionRoles && p.divisionRoles[area] && p.divisionRoles[area] !== 'no_access');
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'fuel-statement-matches.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office', divisionRoles: { fuel_admin: 'level3' } };

async function call(method, query, body) {
  AUTH = ADMIN;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query: query || {}, body: body || {} }, res);
  return res;
}

function ymd(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// Whole calendar months, counting back from this one.
function monthBack(n) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - n, 1);
  const last  = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { start: ymd(first), end: ymd(last), key: ymd(first).slice(0, 7) };
}

async function seed() {
  const q = (t, v) => client.query(t, v);
  await q(`TRUNCATE fuel_statement_lines, fuel_statement_matches RESTART IDENTITY CASCADE`);
  await q(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await q(`DELETE FROM users WHERE id = 42`);
  await q(`INSERT INTO users (id, company_code, username, password_hash, role)
           VALUES (42,'FCT','office','x','admin')`);
}

function saveBody(period, account, lines, note) {
  const ours = lines.reduce((n, l) => n + (l.ours || 0), 0);
  const them = lines.reduce((n, l) => n + (l.statement || 0), 0);
  return {
    account,
    period_start: period.start, period_end: period.end,
    ours_total: ours, statement_total: them, difference: ours - them,
    source_note: note || null,
    lines,
  };
}

async function run() {
  await client.connect();
  await seed();

  const jul = monthBack(0);
  const jun = monthBack(1);
  const may = monthBack(2);
  const apr = monthBack(3);

  console.log('\n[save]');
  const first = await call('POST', {}, saveBody(jul, 'Guttman', [
    { truck_number: 412, ours: 300, statement: 304.5, difference: -4.5, fills: 3, verdict: 'variance' },
    { truck_number: 77,  ours: 45,  statement: 45,    difference: 0,    fills: 1, verdict: 'match' },
    { truck_number: 55,  ours: null, statement: 75,   difference: null, fills: 0, verdict: 'not-in-ours' },
  ], 'guttman-july.csv'));
  assert('a match saves', first.statusCode === 200 && first.body.ok, JSON.stringify(first.body));
  const matchId = first.body.match.id;
  assert('a whole calendar month is stamped as one', first.body.match.period_month === jul.key,
    String(first.body.match.period_month));
  assert('the counts come back', first.body.match.variance_count === 1 && first.body.match.matched_count === 1);
  assert('its lines come back worst-first',
    first.body.lines[0].verdict === 'variance', first.body.lines.map(l => l.verdict).join(','));
  // 300 + 45 ours against 304.5 + 45 + 75 billed — truck 55 is on the
  // statement with no fuel entry behind it, which is most of the gap.
  assert('and the totals survive the round trip as numbers',
    first.body.match.ours_total === 345 && first.body.match.difference === -79.5,
    JSON.stringify([first.body.match.ours_total, first.body.match.difference]));
  assert('the person who saved it is recorded', first.body.match.created_by_name === 'office');

  console.log('\n[tick a truck off]');
  const line412 = first.body.lines.find(l => l.truck_number === 412);
  const ticked = await call('PATCH', { line_id: line412.id }, {
    resolved: true, resolution_note: 'driver used the wrong card on the 14th',
  });
  assert('a line can be ticked', ticked.statusCode === 200 && ticked.body.line.resolved === true);
  assert('with a note', /wrong card/.test(ticked.body.line.resolution_note || ''));

  console.log('\n[re-save the same month]');
  const again = await call('POST', {}, saveBody(jul, 'Guttman', [
    { truck_number: 412, ours: 304.5, statement: 304.5, difference: 0, fills: 4, verdict: 'match' },
    { truck_number: 77,  ours: 45,    statement: 45,    difference: 0, fills: 1, verdict: 'match' },
    { truck_number: 55,  ours: null,  statement: 75,    difference: null, fills: 0, verdict: 'not-in-ours' },
  ], 'guttman-july-v2.csv'));
  assert('it updates rather than creating a second', again.body.match.id === matchId,
    `${again.body.match.id} vs ${matchId}`);
  {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM fuel_statement_matches WHERE company_code = 'FCT'`);
    assert('there is still exactly one saved match for the month', rows[0].n === 1, String(rows[0].n));
  }
  {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM fuel_statement_lines WHERE match_id = $1`, [matchId]);
    assert('and exactly one line per truck', rows[0].n === 3, String(rows[0].n));
  }
  // Re-matching after correcting an entry must not throw away the work of
  // having chased the other trucks down.
  assert('the tick is carried across the re-save', again.body.carried_over === 1,
    String(again.body.carried_over));
  {
    const l = again.body.lines.find(x => x.truck_number === 412);
    assert('with its note intact', l.resolved === true && /wrong card/.test(l.resolution_note || ''),
      JSON.stringify(l));
    assert('and the corrected verdict applied over the top', l.verdict === 'match', l.verdict);
  }
  assert('the note on the match itself is updated too',
    again.body.match.source_note === 'guttman-july-v2.csv', String(again.body.match.source_note));

  console.log('\n[a different account is a different match]');
  const wex = await call('POST', {}, saveBody(jul, 'Wex', [
    { truck_number: 412, ours: 60, statement: 60, difference: 0, fills: 1, verdict: 'match' },
  ]));
  assert('Wex saves alongside Guttman', wex.body.match.id !== matchId);
  {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM fuel_statement_matches WHERE company_code = 'FCT'`);
    assert('so the month now holds two accounts', rows[0].n === 2, String(rows[0].n));
  }

  console.log('\n[a few months of history]');
  // Truck 412 short on Guttman three months running, right in the fourth.
  await call('POST', {}, saveBody(jun, 'Guttman', [
    { truck_number: 412, ours: 280, statement: 292, difference: -12, fills: 3, verdict: 'variance' },
    { truck_number: 77,  ours: 40,  statement: 40,  difference: 0,   fills: 1, verdict: 'match' },
  ]));
  await call('POST', {}, saveBody(may, 'Guttman', [
    { truck_number: 412, ours: 260, statement: 268, difference: -8, fills: 3, verdict: 'variance' },
    { truck_number: 77,  ours: 38,  statement: 38,  difference: 0,  fills: 1, verdict: 'match' },
  ]));
  await call('POST', {}, saveBody(apr, 'Guttman', [
    { truck_number: 412, ours: 250, statement: 250, difference: 0, fills: 3, verdict: 'match' },
    { truck_number: 77,  ours: 36,  statement: 36,  difference: 0, fills: 1, verdict: 'match' },
  ]));

  const hist = await call('GET', { action: 'history', months: '12' });
  assert('history answers', hist.statusCode === 200, JSON.stringify(hist.body));
  const t412 = hist.body.trucks.find(t => t.truck_number === 412);
  const t77  = hist.body.trucks.find(t => t.truck_number === 77);
  assert('truck 412 is counted across every saved month it appears in',
    t412.periods === 5, String(t412.periods));       // 4 Guttman + 1 Wex
  assert('with the months it was off',      t412.variances === 2, String(t412.variances));
  assert('and the months it agreed',        t412.agreed === 3, String(t412.agreed));
  assert('the net is the swing added up',   t412.net === -20, String(t412.net));
  // Truck 77 is on all four Guttman months and agrees every time.
  assert('a truck that always agrees shows no variance', t77.variances === 0 && t77.agreed === 4,
    JSON.stringify(t77));
  assert('and truck 55 is remembered as never having had an entry',
    hist.body.trucks.find(t => t.truck_number === 55).missing === 1);
  assert('the worst truck sorts first',
    hist.body.trucks[0].truck_number === 412, String(hist.body.trucks[0].truck_number));
  assert('last reconciled is the newest month it appears in',
    t412.last_seen === jul.end, `${t412.last_seen} vs ${jul.end}`);
  assert('last agreed is the newest month it came out right',
    t412.last_ok === jul.end, `${t412.last_ok} vs ${jul.end}`);

  console.log('\n[account filter]');
  const gutOnly = await call('GET', { action: 'history', months: '12', account: 'Guttman' });
  const g412 = gutOnly.body.trucks.find(t => t.truck_number === 412);
  assert('narrowing to Guttman drops the Wex month', g412.periods === 4, String(g412.periods));
  assert('and the variances are Guttman\'s alone', g412.variances === 2, String(g412.variances));

  console.log('\n[list and read back]');
  {
    const list = await call('GET', {});
    assert('every saved match lists', list.body.matches.length === 5, String(list.body.matches.length));
    assert('newest first', list.body.matches[0].period_end === jul.end,
      String(list.body.matches[0].period_end));
    const one = await call('GET', { account: 'Wex' });
    assert('and can be narrowed to one account', one.body.matches.length === 1);
  }
  {
    const got = await call('GET', { id: matchId });
    assert('a saved match reads back with its lines', got.body.lines.length === 3);
    assert('including the ticks', got.body.lines.some(l => l.resolved === true));
  }

  console.log('\n[delete]');
  {
    const gone = await call('DELETE', { id: matchId });
    assert('a saved match deletes', gone.statusCode === 200);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM fuel_statement_lines WHERE match_id = $1`, [matchId]);
    // Orphaned lines would keep counting towards the rollup forever, against
    // a month nobody can open any more.
    assert('and its lines go with it', rows[0].n === 0, String(rows[0].n));

    const after = await call('GET', { action: 'history', months: '12', account: 'Guttman' });
    const a412 = after.body.trucks.find(t => t.truck_number === 412);
    assert('the history drops that month too', a412.periods === 3, String(a412.periods));
    assert('and last agreed falls back to the month before',
      a412.last_ok === apr.end, `${a412.last_ok} vs ${apr.end}`);
  }

  console.log('\n────────────────────────────────────────');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('────────────────────────────────────────');
}

run()
  .then(() => client.end())
  .then(() => process.exit(failed ? 1 : 0))
  .catch(err => { console.error(err); client.end(); process.exit(1); });
