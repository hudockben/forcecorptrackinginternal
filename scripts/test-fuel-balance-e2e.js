#!/usr/bin/env node
'use strict';
process.env.TZ = 'Europe/Berlin';
/**
 * The whole balancing loop, end to end, against a real database.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-fuel-balance-e2e.js
 *      FUEL_TEST_SHEET=/path/to/rows.json   to drive it with a real export
 *
 * DESTRUCTIVE: truncates the fuel tables. Refuses to run against a database
 * whose name doesn't look like a test database.
 *
 * Every other fuel suite tests one piece. This one is the only thing that
 * answers the question the feature exists for — CAN A MONTH ACTUALLY BE
 * BALANCED — and it answers it by doing it:
 *
 *   1. build the roster through /api/fuel-vehicles
 *   2. import a month through /api/fuel-submissions?action=import
 *   3. read them back through the real list endpoint
 *   4. build the report with fuel-admin.html's own buildReportModel
 *   5. read the statement with its own readStatementRows / aggregateByRef /
 *      resolveStatementRefs, and compare with its own matchStatement
 *   6. save the reconciliation through /api/fuel-statement-matches
 *   7. mark the agreeing trucks' fills balanced through ?action=balance
 *   8. check the DATABASE, not the response
 *
 * Then it breaks the month on purpose — corrects a gallons figure the way an
 * office would — and checks that the correction un-balances what it changed,
 * that the next match reports the variance, and that flagging it as an issue
 * lands on the right rows.
 *
 * The page code is LIFTED from fuel-admin.html rather than reimplemented, so
 * what runs here is what ships. The one seam is the workbook: the zip and XML
 * layer needs a DOM the repo has no dependency for, so this starts from the
 * cell grid readWorkbook produces — which scripts/test-fuel-vehicles.js
 * already drives from the real headers. Point FUEL_TEST_SHEET at a JSON dump
 * of a real export's rows to run the same loop over one.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}

const client = new Client({ connectionString: URL });
const makeSql = c => (strings, ...values) => {
  let text = '';
  strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
  return c.query(text, values).then(r => r.rows);
};

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

const submissions = require(path.resolve(__dirname, '..', 'api', 'fuel-submissions.js'));
const vehiclesApi = require(path.resolve(__dirname, '..', 'api', 'fuel-vehicles.js'));
const matchesApi  = require(path.resolve(__dirname, '..', 'api', 'fuel-statement-matches.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const ADMIN = { companyCode: 'FCT', userId: 42, username: 'office', divisionRoles: { fuel: 'level1', fuel_admin: 'level3' } };

async function call(handler, method, query, body, auth) {
  AUTH = auth || ADMIN;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query: query || {}, body: body || {} }, res);
  return res;
}

// ── The page's own report and match code ────────────────────────────────────
function liftFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`fuel-admin.html no longer defines ${name}()`);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`could not find the end of ${name}()`);
}
function liftConst(src, name) {
  const m = new RegExp(`^\\s{0,6}const ${name} = ([\\s\\S]*?);\\n`, 'm').exec(src);
  if (!m) throw new Error(`fuel-admin.html no longer declares ${name}`);
  return m[0];
}

const SRC  = fs.readFileSync(path.resolve(__dirname, '..', 'fuel-admin.html'), 'utf8');
const page = new Function(`
  function val() { return ''; }
  let vmSort = { col: 'truck', dir: 1 };
  ${['FUEL_CARDS', 'CARD_COLUMN_ORDER', 'STATEMENT_COLUMNS'].map(n => liftConst(SRC, n)).join('\n')}
  ${['gallonsFromMeters', 'meterFlagged', 'zeroGallons', 'n1', 'n2', 'monthOf', 'buildReportModel',
     'excelSerialToYmd', 'detectColumns', 'readStatementRows', 'refKey', 'refDigits', 'vinTail',
     'aggregateByRef', 'resolveStatementRefs', 'matchStatement']
     .map(n => liftFn(SRC, n)).join('\n')}
  return { buildReportModel, readStatementRows, aggregateByRef, resolveStatementRefs, matchStatement };
`)();

// ── The month ───────────────────────────────────────────────────────────────
// A statement as it comes off the account: transaction level, one row per
// fill, several per truck, with the vehicle written the account's way.
const HEADER = {
  A: 'Status', G: 'Driver ID Description', J: 'Vehicle Number', M: 'Site description',
  P: 'Site city', Q: 'Site state', T: 'Transaction odometer', U: 'Transaction date',
  X: 'Transaction quantity', Z: 'Product category', AB: 'Product description',
};

// ref, date, gallons, driver, odometer, product
const FILLS = [
  ['5894',   '2026-05-01', 24.221, 'KEN STEWART',     31011, 'ULS Diesel'],
  ['5894',   '2026-05-14', 21.731, 'KEN STEWART',     32668, 'ULS Diesel'],
  ['2913',   '2026-05-02', 30.500, 'CORY ADAMS',     197024, 'ULS Diesel'],
  ['2913',   '2026-05-19', 28.250, 'CORY ADAMS',     198073, 'ULS Diesel'],
  ['0392',   '2026-05-03', 12.400, 'Phil Rodgers',   198791, 'Unleaded E10 Reg'],
  ['0392',   '2026-05-21', 11.152, 'AARON TODD',     199187, 'Unleaded E10 Reg'],
  ['PT4336', '2026-05-05', 20.329, 'ADAM BOTSFORD',   39363, 'Unleaded E10 Reg'],
  ['PT4336', '2026-05-18', 18.740, 'ADAM BOTSFORD',   38029, 'Unleaded E10 Reg'],
  ['0266',   '2026-05-07', 28.060, 'Ben Becker',     184021, 'Unleaded E10 Reg'],
  ['TK6410', '2026-05-09', 19.500, 'Nate Brewer',    109623, 'Unleaded E10 Reg'],
  ['9999',   '2026-05-11', 40.000, 'Sue Force',       50000, 'Unleaded E10 Reg'],
];

function sheetRows() {
  if (process.env.FUEL_TEST_SHEET) {
    return JSON.parse(fs.readFileSync(process.env.FUEL_TEST_SHEET, 'utf8'));
  }
  return [HEADER].concat(FILLS.map(([ref, date, qty, driver, odo, product]) => ({
    A: 'POSTED', G: driver, J: ref, M: 'SHEETZ 0369', P: 'HOMER CITY', Q: 'PA',
    T: String(odo), U: `${date} 08:00:00.0`, X: String(qty), Z: 'FUEL', AB: product,
  })))
  // Both of the shapes the real export ships that must never be counted.
  .concat([{ A: 'DECLINED', J: '2458', U: '2026-05-29 05:13:26.0', X: '', Z: 'NON-FUEL', AB: 'Regular' }]);
}

async function seed() {
  await client.query(`TRUNCATE fuel_submissions, fuel_audit_log, fuel_vehicles,
                               fuel_statement_matches, fuel_statement_lines, fuel_match_audit_log
                      RESTART IDENTITY CASCADE`);
  await client.query(`DELETE FROM users WHERE id = 42`);
  await client.query(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await client.query(`INSERT INTO users (id, company_code, username, password_hash, role)
                      VALUES (42,'FCT','office','x','admin')`);
}

/**
 * The entry a driver would have filed for a statement line.
 *
 * Derived from the statement rather than written out beside it, so the same
 * run works over a real export. The point is not that the two agree by
 * construction — it is that everything BETWEEN them (the import's
 * validation, the report, the resolver, the matcher, the balance write) can
 * carry a month from one end to the other without losing or moving a gallon.
 */
function truckOf(ref) {
  const digits = (String(ref).match(/\d+/g) || []).sort((a, b) => b.length - a.length)[0];
  return digits ? Number(digits) : null;
}

function entryFor(row) {
  return {
    work_date: row.date,
    employee_username: row.driver || 'office',
    fuel_card: 'Guttman',
    fuel_type: /diesel/i.test(row.product || '') ? 'Diesel' : 'Gas',
    // Two decimals, because that is what the gallons column holds. A
    // statement carrying three is the normal case and the rounding it forces
    // is part of what this run is measuring.
    gallons: Math.round(row.gallons * 100) / 100,
    mileage: Number.isFinite(row.odometer) && row.odometer > 0 ? row.odometer : 1,
    truck_number: truckOf(row.ref),
    beginning_meter: 0,
    ending_meter: 0,
    fueling_site: row.site || 'Yard',
    city_fueled: 'HOMER CITY',
    state: 'PA',
    tank_number: 0,
  };
}

async function run() {
  await client.connect();
  await seed();

  const rows = sheetRows();

  // ── 1. Read the statement ─────────────────────────────────────────────────
  console.log('\n[the statement]');
  const read = page.readStatementRows(rows);
  assert('the columns are found by heading', !read.error, read.error);
  const agg = page.aggregateByRef(read.rows);
  const stmtTotal = [...agg.byRef.values()].reduce((n, a) => n + a.gallons, 0);
  console.log(`      ${read.rows.length} fuel lines, ${agg.byRef.size} vehicles, ${stmtTotal.toFixed(2)} gal`
    + (read.dropped.length ? `, ${read.dropped.length} dropped (${read.dropped.map(d => d.why).join(', ')})` : ''));
  // Whatever the account itself marked as not a posted fuel purchase must be
  // out of the total and IN the dropped list — counted, never silently gone.
  // Read off the DETECTED columns, not off fixed letters: Guttman ships a
  // Status in A and a category in Z, and Wex ships neither. An assertion
  // written against one account's layout passes on that account and calls
  // every line of the other one declined.
  const stCol  = read.columns.status;
  const catCol = read.columns.category;
  const notFuel = rows.slice(1).filter(r =>
    (stCol  && String(r[stCol]  || '').trim() && !/^posted$/i.test(String(r[stCol]).trim())) ||
    (catCol && String(r[catCol] || '').trim() && !/^fuel$/i.test(String(r[catCol]).trim()))).length;
  assert(`the ${notFuel} declined or non-fuel line${notFuel === 1 ? '' : 's'} are dropped and reported`,
    read.dropped.length === notFuel && read.rows.length + notFuel === rows.length - 1,
    `${read.dropped.length} dropped, ${read.rows.length} kept, ${rows.length - 1} lines`);

  // ── 2. The roster ─────────────────────────────────────────────────────────
  console.log('\n[the roster]');
  const trucks = [...new Set([...agg.byRef.keys()].map(truckOf))].filter(n => n != null).sort((a, b) => a - b);
  // The truck with the least fuel on it is deliberately left OFF the roster,
  // so the unmapped path is exercised by the same run rather than assumed —
  // and the least fuel so it costs the comparison the least.
  const byGallons = [...agg.byRef].sort((a, b) => a[1].gallons - b[1].gallons);
  const heldBack = truckOf(byGallons[0][0]);
  const onRoster = trucks.filter(t => t !== heldBack);
  for (const t of onRoster) {
    const res = await call(vehiclesApi, 'POST', {}, { truck_number: t, ifta: true, active: true });
    if (res.statusCode !== 200) { assert(`truck ${t} added`, false, JSON.stringify(res.body)); }
  }
  const vres = await call(vehiclesApi, 'GET', {}, null);
  assert(`${onRoster.length} trucks on the roster`, vres.body.vehicles.length === onRoster.length,
    String(vres.body.vehicles.length));

  // ── 3. Import the month ───────────────────────────────────────────────────
  console.log('\n[importing the month]');
  const toImport = read.rows.map(entryFor);
  const imp = await call(submissions, 'POST', { action: 'import' },
    { rows: toImport, status: 'approved', batch: 'e2e-may' });
  assert('the import is accepted', imp.statusCode === 200, JSON.stringify(imp.body));
  assert(`all ${toImport.length} entries created`, imp.body.created === toImport.length,
    `${imp.body.created} — rejected ${JSON.stringify(imp.body.rejected)}`);
  assert('and they are approved, ready to balance',
    imp.body.entries.every(e => e.status === 'approved' && e.balance_status === 'pending'));

  // ── 4. Build the report the page would ────────────────────────────────────
  console.log('\n[the report]');
  const listed = await call(submissions, 'GET',
    { scope: 'all', status: 'approved', from: '2026-05-01', to: '2026-05-31' }, null);
  const entries = listed.body.entries;
  assert('the entries come back through the real list endpoint',
    entries.length === toImport.length, String(entries.length));
  const fleet = new Map(vres.body.vehicles.map(v => [String(v.truck_number), v]));
  const model = page.buildReportModel(entries, vres.body.vehicles);
  model.from = '2026-05-01'; model.to = '2026-05-31';
  assert('the report totals what was imported',
    Math.abs(model.gallons - toImport.reduce((n, e) => n + e.gallons, 0)) < 0.005,
    `${model.gallons} vs ${toImport.reduce((n, e) => n + e.gallons, 0)}`);
  assert('and counts every one of them', model.count === toImport.length, String(model.count));

  // ── 5. Match ──────────────────────────────────────────────────────────────
  console.log('\n[matching Guttman]');
  const resolved = page.resolveStatementRefs(agg.byRef, 'Guttman', fleet);
  assert('every vehicle but the one held off the roster is placed',
    resolved.unmapped.length === 1 && truckOf(resolved.unmapped[0].ref) === heldBack,
    JSON.stringify(resolved.unmapped.map(u => u.ref)));
  console.log(`      matched by: ${JSON.stringify(resolved.counts)}`);

  let match = page.matchStatement(model, 'Guttman', {
    byTruck: resolved.byTruck, skipped: read.dropped.map(d => d.why), lines: rows.length - 1,
  });
  console.log(`      ours ${match.oursTotal.toFixed(2)} · statement ${match.statementTotal.toFixed(2)} `
    + `· agree ${match.matched} · variances ${match.variances.length} `
    + `· not on statement ${match.notOnStatement.length} · not in ours ${match.notInOurs.length}`);
  assert('every mapped truck agrees',
    match.matched === resolved.byTruck.size && match.variances.length === 0,
    JSON.stringify(match.variances.map(v => `truck ${v.truck}: ours ${v.ours} vs ${v.statement}`)));
  // The held-back truck's fuel WAS entered, so it shows as ours-only rather
  // than vanishing — the gallons have to land somewhere visible.
  assert('the truck missing from the roster shows as reported-but-not-billed',
    match.notOnStatement.length === 1 && match.notOnStatement[0].truck === heldBack,
    JSON.stringify(match.notOnStatement));
  const heldGallons = byGallons[0][1].gallons;
  assert('and the totals tie, off by exactly the truck nobody could place',
    Math.abs(match.oursTotal - match.statementTotal - heldGallons) < 0.05,
    `${match.oursTotal} vs ${match.statementTotal}, held back ${heldGallons}`);

  // ── 6. Save the reconciliation ────────────────────────────────────────────
  console.log('\n[saving it]');
  const saveBody = {
    account: 'Guttman', period_start: '2026-05-01', period_end: '2026-05-31',
    ours_total: match.oursTotal, statement_total: match.statementTotal,
    difference: Math.round((match.oursTotal - match.statementTotal) * 100) / 100,
    source_note: 'e2e', lines: match.rows.map(r => ({
      truck_number: r.truck, ours: r.ours, statement: r.statement,
      difference: r.difference, fills: r.fills, verdict: r.verdict,
    })),
  };
  const saved = await call(matchesApi, 'POST', {}, saveBody);
  assert('the match is saved', saved.statusCode === 200 && saved.body.ok, JSON.stringify(saved.body));
  assert('and stored as one whole month', saved.body.match.period_month === '2026-05',
    String(saved.body.match && saved.body.match.period_month));
  const lineCount = (await client.query('SELECT COUNT(*)::int n FROM fuel_statement_lines')).rows[0].n;
  assert('with a line per truck', lineCount === match.rows.length, String(lineCount));

  // ── 7. Carry the verdict through to the entries ───────────────────────────
  console.log('\n[marking the agreeing trucks balanced]');
  const agreeing = new Set(match.rows.filter(r => r.verdict === 'match').map(r => r.truck));
  const ids = entries.filter(e => agreeing.has(Number(e.truck_number))).map(e => e.id);
  const bal = await call(submissions, 'POST', { action: 'balance' },
    { ids, balance_status: 'balanced' });
  assert(`${ids.length} fill-ups marked in one go`, bal.body.updated === ids.length,
    `${bal.body.updated} of ${ids.length}`);
  assert('none were skipped', bal.body.skipped.length === 0, JSON.stringify(bal.body.skipped));

  // The database, not the response. Everything above could agree with itself
  // and still have written nothing.
  const inDb = await client.query(
    `SELECT truck_number, balance_status, balanced_by_name, balanced_at
     FROM fuel_submissions ORDER BY truck_number`);
  const balanced = inDb.rows.filter(r => r.balance_status === 'balanced');
  assert('the rows really are balanced in the table', balanced.length === ids.length,
    `${balanced.length} of ${inDb.rows.length}`);
  assert('stamped with who balanced them', balanced.every(r => r.balanced_by_name === 'office' && r.balanced_at));
  const untouched = inDb.rows.filter(r => Number(r.truck_number) === heldBack);
  assert('and the truck that did not agree is left pending',
    untouched.every(r => r.balance_status === 'pending'), JSON.stringify(untouched));

  const audit = await client.query(
    `SELECT action, COUNT(*)::int n FROM fuel_audit_log GROUP BY action ORDER BY action`);
  console.log(`      audit: ${audit.rows.map(a => `${a.action}×${a.n}`).join(', ')}`);
  assert('every balance is on the audit trail',
    (audit.rows.find(a => a.action === 'BALANCE') || {}).n === ids.length,
    JSON.stringify(audit.rows));

  // ── 8. Now break it, the way a month really breaks ────────────────────────
  console.log('\n[a correction after the fact]');
  // Whichever truck agreed and has the fewest fills — a correction to one of
  // them is the smallest change that can still un-balance a signed-off month.
  const correctable = [...agreeing].sort((a, b) =>
    entries.filter(e => Number(e.truck_number) === a).length
    - entries.filter(e => Number(e.truck_number) === b).length)[0];
  const target = entries.find(e => Number(e.truck_number) === correctable);
  const edited = await call(submissions, 'PUT', { id: target.id },
    Object.assign({}, target, { gallons: Number(target.gallons) + 9 }));
  assert('the correction is accepted', edited.statusCode === 200, JSON.stringify(edited.body));
  // A figure that was signed off cannot go on reading "balanced" once it has
  // moved underneath the sign-off.
  assert('changing the gallons un-balances that fill-up',
    edited.body.entry.balance_status === 'pending' && edited.body.entry.balanced_at === null,
    JSON.stringify(edited.body.entry.balance_status));
  const stillBalanced = (await client.query(
    `SELECT COUNT(*)::int n FROM fuel_submissions WHERE balance_status = 'balanced'`)).rows[0].n;
  assert('and only that one — the rest of the month stands',
    stillBalanced === ids.length - 1, String(stillBalanced));

  console.log('\n[re-matching after the correction]');
  const listed2 = await call(submissions, 'GET',
    { scope: 'all', status: 'approved', from: '2026-05-01', to: '2026-05-31' }, null);
  const model2 = page.buildReportModel(listed2.body.entries, vres.body.vehicles);
  model2.from = '2026-05-01'; model2.to = '2026-05-31';
  match = page.matchStatement(model2, 'Guttman', { byTruck: resolved.byTruck, skipped: [], lines: 0 });
  const v = match.variances.find(x => x.truck === correctable);
  assert('the corrected truck now reads as a variance', !!v, JSON.stringify(match.variances));
  assert('by exactly what was added', v && Math.abs(v.difference - 9) < 0.005, v && String(v.difference));
  assert('and it is the only one', match.variances.length === 1, JSON.stringify(match.variances));
  // Worst first — a reconciler should not have to look for the problem.
  assert('sorted to the top of the table', match.rows[0].truck === correctable, String(match.rows[0].truck));

  console.log('\n[flagging it]');
  const issueIds = listed2.body.entries.filter(e => Number(e.truck_number) === correctable).map(e => e.id);
  const flagged = await call(submissions, 'POST', { action: 'balance' },
    { ids: issueIds, balance_status: 'issue', balance_note: 'Statement is 9 gal short of what we reported.' });
  assert('the issue is recorded', flagged.body.updated === issueIds.length, JSON.stringify(flagged.body));
  const issues = await client.query(
    `SELECT truck_number, balance_status, balance_note FROM fuel_submissions WHERE balance_status = 'issue'`);
  assert('on the right truck, with the reason kept',
    issues.rows.length === issueIds.length
      && issues.rows.every(r => Number(r.truck_number) === correctable && /9 gal/.test(r.balance_note)),
    JSON.stringify(issues.rows));

  // What the Balancing tab is for: what is left to do.
  const left = await client.query(
    `SELECT balance_status, COUNT(*)::int n FROM fuel_submissions GROUP BY balance_status ORDER BY balance_status`);
  console.log(`      month now stands at: ${left.rows.map(r => `${r.balance_status} ${r.n}`).join(', ')}`);
  assert('nothing is unaccounted for',
    left.rows.reduce((n, r) => n + r.n, 0) === toImport.length, JSON.stringify(left.rows));

  console.log(`\n${'─'.repeat(40)}\n  ${passed} passed, ${failed} failed\n${'─'.repeat(40)}`);
  await client.end();
  process.exit(failed ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
