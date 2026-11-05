#!/usr/bin/env node
'use strict';
/**
 * Custom Reporting, against a real Postgres: api/custom-reports.js and the two
 * tables it keeps (custom_reports, custom_report_runs), plus the backend's two
 * small hooks elsewhere — the report types send-report.js accepts, and the
 * Email modal's onSent callback that feeds the send history.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-custom-reports-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * as the other *-sql.js suites. Refuses a database whose name does not look
 * like a test database; it creates and removes two companies of its own.
 *
 * What a stub cannot show, and this does:
 *   - the name rules are the unique indexes' to enforce, trimmed and without
 *     case, separately for private reports and shared templates — and a
 *     deleted row is outside them, so restoring can collide;
 *   - the optimistic lock holds when two saves race, not just when one is
 *     stale before it starts;
 *   - every query is scoped by company AND division, against the real WHERE
 *     clauses;
 *   - a run bumps its report's counters and writes its history row in one
 *     statement, and never fails over a report the caller cannot see;
 *   - the 90-day purge takes only that company's and division's old rows, and
 *     leaves their history pointing at nothing rather than deleting it.
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

process.env.JWT_SECRET = process.env.JWT_SECRET || 'custom-reports-test-secret';

const CO  = 'CRTEST';
const CO2 = 'CRTEST2';
const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

const ROOT = path.resolve(__dirname, '..');
const realAuth = require(path.join(ROOT, 'api/lib/auth.js'));

// Who is asking is the test's to say; what they may do is the real rule. With
// REAL_AUTH set the real guard runs instead, on a real token, reading the
// account from the users table — the path production takes.
let AUTH = null;
let REAL_AUTH = false;
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  const from = parent && parent.filename ? parent.filename : '';
  if (request === './lib/auth' && /api[\\/]custom-reports\.js$/.test(from)) {
    return {
      ...realAuth,
      requireDivision: async (req, res, opts = {}) => {
        if (REAL_AUTH) return realAuth.requireDivision(req, res, opts);
        if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        const division = realAuth.normalizeDivision((req.query && req.query.division) || (req.body && req.body.division));
        if (!division) {
          if (opts.required) { res.status(400).json({ error: 'division query param is required' }); return null; }
          return { payload: AUTH, division: 'turf' };
        }
        if (!realAuth.hasDivisionAccess(AUTH, division)) {
          res.status(403).json({ error: 'You do not have access to this division' });
          return null;
        }
        return { payload: AUTH, division };
      },
    };
  }
  if (request === '../lib/auth' && /api[\\/]email[\\/]send-report\.js$/.test(from)) {
    return {
      ...realAuth,
      requireAuth: (req, res) => {
        if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        return AUTH;
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const handler    = require(path.join(ROOT, 'api/custom-reports.js'));
const sendReport = require(path.join(ROOT, 'api/email/send-report.js'));
const catalog    = require(path.join(ROOT, 'api/lib/report-catalog.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}

async function call(method, query, body, auth, { token, h = handler } = {}) {
  AUTH = auth;
  REAL_AUTH = token !== undefined;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }, end() { return this; },
  };
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  await h({ method, query: query || {}, body: body === undefined ? {} : body, headers }, res);
  REAL_AUTH = false;
  return res;
}

const P = (extra = {}) => ({ division: 'paving', ...extra });
const DEF = (over = {}) => ({
  v: 1, title: '', jobs: { mode: 'pick', ids: [] }, layout: 'separate', pageBreakPerJob: false,
  dates: { preset: 'job_to_date', from: '', to: '' }, includeInternal: false, orientation: 'portrait',
  header: { preparedFor: '', preparedBy: '', intro: '', footer: '', showGenerated: true },
  sections: [{ id: 's1', type: 'bid_progress', title: 'Progress', columns: ['cost_code', 'bid_qty'], labels: {}, options: {} }],
  ...over,
});
const create = (auth, body = {}, division = 'paving') =>
  call('POST', { division }, { definition: DEF(), ...body }, auth);
const put = (auth, id, body, division = 'paving') => call('PUT', { division, id: String(id) }, body, auth);
const del = (auth, id, division = 'paving') => call('DELETE', { division, id: String(id) }, null, auth);
const restore = (auth, id, division = 'paving') => call('POST', { division, action: 'restore', id: String(id) }, {}, auth);
const run = (auth, body, division = 'paving') => call('POST', { division, action: 'run' }, {
  report_name: 'Weekly', action: 'print', project_ids: [], project_names: [], recipients: [],
  included_internal: false, definition: DEF(), ...body,
}, auth);
const list = async (auth, extra = {}) => call('GET', P(extra), null, auth);
const ids = r => (r.body && Array.isArray(r.body.reports) ? r.body.reports.map(x => x.id) : []);
const dbRow = async id => (await client.query('SELECT * FROM custom_reports WHERE id = $1', [id])).rows[0];
const dbRun = async id => (await client.query(
  "SELECT *, to_char(date_from, 'YYYY-MM-DD') AS df, to_char(date_to, 'YYYY-MM-DD') AS dt FROM custom_report_runs WHERE id = $1", [id])).rows[0];
const show = r => `${r.statusCode} ${JSON.stringify(r.body)}`;

async function cleanUp() {
  for (const co of [CO, CO2]) {
    await client.query('DELETE FROM custom_report_runs WHERE company_code = $1', [co]);
    await client.query('DELETE FROM custom_reports WHERE company_code = $1', [co]);
    await client.query('DELETE FROM users WHERE company_code = $1', [co]);
    await client.query('DELETE FROM companies WHERE code = $1', [co]);
  }
}

(async () => {
  await client.connect();
  await cleanUp();
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Custom Reports test', '{turf,paving,kiewit,dust}')", [CO]);
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Rival Co', '{turf,paving}')", [CO2]);

  // Real rows, so the ids the handler stores are real logins and the real
  // auth path below has accounts to read.
  const mk = async (username, roles, { co = CO, platform = false } = {}) => {
    const id = (await client.query(
      "INSERT INTO users (username, company_code, password_hash, role, division_roles, is_platform_admin) VALUES ($1, $2, 'x', 'level1', $3, $4) RETURNING id",
      [username, co, JSON.stringify(roles), platform])).rows[0].id;
    return { companyCode: co, userId: id, username, role: 'level1', divisionRoles: roles, isPlatformAdmin: platform };
  };
  const BOSS   = await mk('boss',   { paving: 'admin', turf: 'admin', kiewit: 'admin' });
  const PM     = await mk('pm3',    { paving: 'level3' });
  const ALICE  = await mk('alice',  { paving: 'level1', turf: 'level1' });
  const BOB    = await mk('bob',    { paving: 'level1' });
  const FOREMAN= await mk('foreman',{ paving: 'level2' });
  const SALES  = await mk('salesguy', { paving: 'sales', turf: 'sales' });
  const TURFPM = await mk('turfpm', { turf: 'level3' });
  const DUSTY  = await mk('dusty',  { dust: 'admin' });
  const KIEWIT = await mk('kpm',    { kiewit: 'level3' });
  const PLAT   = await mk('platform', {}, { platform: true });
  const RIVAL  = await mk('rival',  { paving: 'admin', turf: 'admin' }, { co: CO2 });

  // ─────────────────────────────────────────────────────────────────────
  console.log('The database itself');
  {
    const ins = (over = {}) => {
      const r = { company_code: CO, division: 'paving', name: 'DB check', visibility: 'private', owner_user_id: ALICE.userId, ...over };
      return client.query(
        'INSERT INTO custom_reports (company_code, division, name, visibility, owner_user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [r.company_code, r.division, r.name, r.visibility, r.owner_user_id]);
    };
    const fails = async (fn, code) => { try { await fn(); return false; } catch (e) { return e.code === code; } };
    const first = (await ins()).rows[0];
    assert('a bare row gets the defaults: private template, customer-safe, version 1, no runs',
      first.visibility === 'private' && first.kind === 'template' && first.customer_safe === true
        && first.version === 1 && first.run_count === 0 && first.deleted_at === null
        && JSON.stringify(first.definition) === '{}', JSON.stringify(first));
    assert('the same owner cannot hold the name twice, however it is spaced or cased',
      await fails(() => ins({ name: '  db CHECK ' }), '23505'));
    assert('…but another owner can', !(await fails(() => ins({ owner_user_id: BOB.userId }), '23505')));
    assert('a blank name is refused by the table, not just the API', await fails(() => ins({ name: '   ' }), '23514'));
    assert('a 121-character name is refused by the table', await fails(() => ins({ name: 'x'.repeat(121) }), '23514'));
    assert('a division without Custom Reporting is refused by the table', await fails(() => ins({ division: 'dust', name: 'Dust' }), '23514'));
    assert('so is a visibility that is neither private nor shared', await fails(() => ins({ visibility: 'public', name: 'Pub' }), '23514'));
    assert('a run action other than print / email / excel is refused by the table', await fails(() => client.query(
      "INSERT INTO custom_report_runs (company_code, division, report_name, action) VALUES ($1, 'paving', 'x', 'fax')", [CO]), '23514'));
    const idx = (await client.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('custom_reports','custom_report_runs') ORDER BY indexname")).rows.map(r => r.indexname);
    assert('the list index, both name indexes and both run indexes exist',
      ['idx_custom_reports_list', 'uq_custom_reports_shared_name', 'uq_custom_reports_private_name',
        'idx_custom_report_runs_company', 'idx_custom_report_runs_report'].every(n => idx.includes(n)), idx.join(','));
    await client.query('DELETE FROM custom_reports WHERE company_code = $1', [CO]);

    // The section is split and run the way scripts/run-schema.js does it — on
    // every ';' once lines starting with '--' are gone — and each statement
    // run twice, so a ';' in a trailing comment or a non-idempotent statement
    // fails here rather than in a deploy.
    const file = fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8');
    const at = file.indexOf('CUSTOM REPORTS (Analytics');
    const section = at < 0 ? '' : file.slice(file.lastIndexOf('\n-- ─', at));
    const stmts = section.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.trim()).filter(Boolean);
    let okRuns = 0, firstErr = '';
    for (let pass = 0; pass < 2; pass++) {
      for (const s of stmts) {
        try { await client.query(s); okRuns++; } catch (e) { firstErr = firstErr || `${e.message} in: ${s.slice(0, 80)}`; }
      }
    }
    assert(`neon-schema.sql's section splits into ${stmts.length} statements that each run, twice, the run-schema way`,
      stmts.length === 7 && okRuns === 14 && stmts.every(s => /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/.test(s)),
      firstErr || `${stmts.length} statements, ${okRuns} ran`);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nPrivate reports: create, list, edit');
  let aliceWeekly;
  {
    let r = await create(ALICE, { name: '  Weekly Update  ', description: '  For the owner  ' });
    aliceWeekly = r.body && r.body.report;
    assert('a level1 user saves a private report (201)', r.statusCode === 201 && aliceWeekly, show(r));
    assert('…named as typed, trimmed', aliceWeekly.name === 'Weekly Update' && aliceWeekly.description === 'For the owner');
    assert('…private, a template, customer-safe, version 1, theirs and editable',
      aliceWeekly.visibility === 'private' && aliceWeekly.kind === 'template' && aliceWeekly.customer_safe === true
        && aliceWeekly.version === 1 && aliceWeekly.mine === true && aliceWeekly.can_edit === true, JSON.stringify(aliceWeekly));
    assert('…owned by their login, and saved by them',
      aliceWeekly.owner_user_id === ALICE.userId && aliceWeekly.owner_username === 'alice' && aliceWeekly.updated_by_username === 'alice');
    assert('…with the definition stored as sent', aliceWeekly.definition && aliceWeekly.definition.sections[0].type === 'bid_progress');
    const row = await dbRow(aliceWeekly.id);
    assert('the row is in the database, scoped to company and division',
      row && row.company_code === CO && row.division === 'paving' && row.definition.v === 1);

    r = await list(ALICE);
    assert('their list has it, with canShare false and who they are',
      r.statusCode === 200 && ids(r).includes(aliceWeekly.id) && r.body.canShare === false
        && r.body.me && r.body.me.userId === ALICE.userId && r.body.me.username === 'alice', show(r));
    const listed = r.body.reports.find(x => x.id === aliceWeekly.id);
    assert('each listed report carries the fields the builder reads',
      ['id', 'name', 'description', 'visibility', 'kind', 'customer_safe', 'definition', 'version', 'owner_user_id',
        'owner_username', 'updated_by_username', 'created_at', 'updated_at', 'last_run_at', 'run_count', 'mine', 'can_edit']
        .every(k => Object.prototype.hasOwnProperty.call(listed, k)), Object.keys(listed).join(','));
    assert('another level1 user does not see it', !ids(await list(BOB)).includes(aliceWeekly.id));
    assert('nor does an admin — a private report is its owner\'s alone', !ids(await list(BOSS)).includes(aliceWeekly.id));

    r = await put(ALICE, aliceWeekly.id, { name: 'Weekly Update — Owner', version: 1 });
    assert('its owner saves a change: version 2, new name, definition kept',
      r.statusCode === 200 && r.body.report.version === 2 && r.body.report.name === 'Weekly Update — Owner'
        && r.body.report.definition.sections.length === 1, show(r));
    assert('…and updated_at moves', new Date(r.body.report.updated_at) > new Date(aliceWeekly.updated_at));
    aliceWeekly = r.body.report;
    r = await put(ALICE, aliceWeekly.id, { description: null, version: 2 });
    assert('a description can be cleared', r.statusCode === 200 && r.body.report.description === null, show(r));
    aliceWeekly = r.body.report;
    r = await put(BOB, aliceWeekly.id, { name: 'Hijack', version: 3 });
    assert('someone else cannot save over it — it is not there for them (404)', r.statusCode === 404, show(r));
    r = await del(BOB, aliceWeekly.id);
    assert('…nor delete it (404)', r.statusCode === 404 && !(await dbRow(aliceWeekly.id)).deleted_at, show(r));

    const second = (await create(ALICE, { name: 'Second' })).body.report;
    await put(ALICE, aliceWeekly.id, { name: aliceWeekly.name, version: aliceWeekly.version });
    aliceWeekly = (await list(ALICE)).body.reports.find(x => x.id === aliceWeekly.id);
    r = await list(ALICE);
    assert('the list is newest change first', ids(r).indexOf(aliceWeekly.id) < ids(r).indexOf(second.id), ids(r).join(','));

    r = await create(ALICE, { name: '' });
    assert('no name → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: '   ' });
    assert('a name of spaces → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'x'.repeat(121) });
    assert('a 121-character name → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'y'.repeat(120) });
    assert('a 120-character name is fine', r.statusCode === 201, show(r));
    r = await create(ALICE, { name: 'Desc', description: 'd'.repeat(501) });
    assert('a 501-character description → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'Vis', visibility: 'public' });
    assert('a visibility that is not private or shared → 400', r.statusCode === 400, show(r));
    r = await call('POST', P(), { name: 'No def' }, ALICE);
    assert('no definition → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'Array def', definition: [1, 2] });
    assert('a definition that is a list, not an object → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'Bad\u0000Name\nhere', definition: DEF({ title: 'Nul\u0000title \ud800' }) });
    assert('a NUL or half a surrogate pair in what is sent is dropped, not a 500',
      r.statusCode === 201 && r.body.report.name === 'BadName here' && r.body.report.definition.title === 'Nultitle ', show(r));
    let deep = { v: 1 };
    for (let i = 0, cur = deep; i < 40; i++) { cur.x = {}; cur = cur.x; }
    r = await create(ALICE, { name: 'Deep', definition: deep });
    assert('a definition nested 40 deep → 400, not a stack overflow', r.statusCode === 400, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nShared templates: admins and level3 only');
  let shared;
  {
    let r = await create(ALICE, { name: 'Office Template', visibility: 'shared' });
    assert('a level1 user cannot share (403)', r.statusCode === 403, show(r));
    r = await create(FOREMAN, { name: 'Office Template', visibility: 'shared' });
    assert('nor can a level2 (403)', r.statusCode === 403, show(r));
    r = await create(PM, { name: 'Office Template', visibility: 'shared' });
    shared = r.body.report;
    assert('a level3 can (201)', r.statusCode === 201 && shared.visibility === 'shared' && shared.can_edit === true, show(r));
    r = await create(BOSS, { name: 'Boss Template', visibility: 'shared' });
    assert('an admin can (201)', r.statusCode === 201, show(r));
    const bossTpl = r.body.report;
    r = await create(PLAT, { name: 'Platform Template', visibility: 'shared' });
    assert('a platform admin with no paving role of their own can (201)', r.statusCode === 201, show(r));

    r = await list(ALICE);
    const seen = r.body.reports.find(x => x.id === shared.id);
    assert('everyone in the division sees a shared template', seen && ids(r).includes(bossTpl.id));
    assert('…a level1 user as not theirs and not editable', seen && seen.mine === false && seen.can_edit === false, JSON.stringify(seen));
    r = await list(BOSS);
    assert('an admin gets canShare true and may edit any shared template',
      r.body.canShare === true && r.body.reports.find(x => x.id === shared.id).can_edit === true);
    r = await list(PM);
    assert('so does a level3', r.body.canShare === true);
    r = await call('GET', { division: 'paving' }, null, PLAT);
    assert('so does a platform admin', r.body.canShare === true);
    r = await call('GET', { division: 'paving' }, null, FOREMAN);
    assert('a level2 does not', r.body.canShare === false);
  }

  console.log('\nlevel1 cannot share or edit shared');
  {
    let r = await put(ALICE, shared.id, { name: 'Mine now', version: shared.version });
    assert('a level1 user cannot save over a shared template (403)', r.statusCode === 403, show(r));
    r = await del(ALICE, shared.id);
    assert('…nor delete one (403)', r.statusCode === 403 && !(await dbRow(shared.id)).deleted_at, show(r));
    r = await put(ALICE, aliceWeekly.id, { visibility: 'shared', version: aliceWeekly.version });
    assert('…nor share their own private report (403), which stays private',
      r.statusCode === 403 && (await dbRow(aliceWeekly.id)).visibility === 'private', show(r));
    r = await put(BOSS, shared.id, { name: 'Office Template v2', version: shared.version });
    assert('an admin may edit a level3\'s shared template; the owner stays the level3',
      r.statusCode === 200 && r.body.report.owner_user_id === PM.userId && r.body.report.updated_by_username === 'boss', show(r));
    shared = r.body.report;

    const pmPrivate = (await create(PM, { name: 'PM Draft' })).body.report;
    r = await put(PM, pmPrivate.id, { visibility: 'shared', version: 1 });
    assert('a level3 may share their own private report', r.statusCode === 200 && r.body.report.visibility === 'shared', show(r));
    assert('…and now a level1 user sees it', ids(await list(ALICE)).includes(pmPrivate.id));

    const bossTpl2 = (await create(BOSS, { name: 'Boss Shared', visibility: 'shared' })).body.report;
    r = await put(PM, bossTpl2.id, { visibility: 'private', version: 1 });
    assert('a level3 making an admin\'s template private hands it back to the admin, its author',
      r.statusCode === 200 && r.body.report.visibility === 'private' && r.body.report.owner_user_id === BOSS.userId
        && r.body.report.mine === false && r.body.report.can_edit === false, show(r));
    assert('…so it leaves the level3\'s list and the division\'s', !ids(await list(PM)).includes(bossTpl2.id) && !ids(await list(ALICE)).includes(bossTpl2.id));
    r = await list(BOSS);
    const back = r.body.reports.find(x => x.id === bossTpl2.id);
    assert('…and is in the admin\'s as their own private report', back && back.mine === true && back.can_edit === true);

    // Its author has left the division since: private to them would be
    // private to nobody who can see it.
    const gone = await mk('leaver', { paving: 'level3' });
    const orphan = (await create(gone, { name: 'Leaver Template', visibility: 'shared' })).body.report;
    await client.query('UPDATE users SET division_roles = $1 WHERE id = $2', [JSON.stringify({ turf: 'level1' }), gone.userId]);
    r = await put(PM, orphan.id, { visibility: 'private', version: 1 });
    assert('a template whose author can no longer open the division goes to whoever makes it private, rather than vanishing',
      r.statusCode === 200 && r.body.report.owner_user_id === PM.userId && r.body.report.mine === true && ids(await list(PM)).includes(orphan.id), show(r));
    const demoted = await mk('demoted', { paving: 'level3' });
    const salesTpl = (await create(demoted, { name: 'Demoted Template', visibility: 'shared' })).body.report;
    await client.query('UPDATE users SET division_roles = $1 WHERE id = $2', [JSON.stringify({ paving: 'sales' }), demoted.userId]);
    r = await put(PM, salesTpl.id, { visibility: 'private', version: 1 });
    assert('…so does one whose author is sales there now, and so cannot open Custom Reporting',
      r.statusCode === 200 && r.body.report.owner_user_id === PM.userId, show(r));
    const orphan2 = (await create(BOSS, { name: 'Orphan Two', visibility: 'shared' })).body.report;
    await client.query('UPDATE custom_reports SET owner_user_id = $1, owner_username = $2 WHERE id = $3', [999999, 'deleted-user', orphan2.id]);
    r = await put(PM, orphan2.id, { visibility: 'private', version: 1 });
    assert('…and so does one whose author\'s login is gone', r.statusCode === 200 && r.body.report.owner_user_id === PM.userId, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nSales: no Analytics, no Custom Reporting');
  {
    let r = await call('GET', P(), null, SALES);
    assert('a sales login is refused the list (403)', r.statusCode === 403, show(r));
    r = await create(SALES, { name: 'Sneaky' });
    assert('…and cannot save one (403)', r.statusCode === 403, show(r));
    r = await run(SALES, {});
    assert('…or log a run (403)', r.statusCode === 403, show(r));
    r = await call('GET', { division: 'turf' }, null, SALES);
    assert('…in turf either', r.statusCode === 403, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nOther companies and other divisions');
  {
    let r = await call('GET', P(), null, RIVAL);
    assert('another company\'s admin sees none of this company\'s reports',
      r.statusCode === 200 && !r.body.reports.some(x => x.id === shared.id), show(r));
    r = await put(RIVAL, shared.id, { name: 'Pwned', version: shared.version });
    assert('…cannot save over one (404)', r.statusCode === 404 && (await dbRow(shared.id)).name === shared.name, show(r));
    r = await del(RIVAL, shared.id);
    assert('…cannot delete one (404)', r.statusCode === 404, show(r));
    r = await create(RIVAL, { name: shared.name, visibility: 'shared' });
    assert('…and may use the same template name in their own company', r.statusCode === 201, show(r));

    r = await call('GET', { division: 'turf' }, null, BOSS);
    assert('the same admin in turf sees none of paving\'s reports', r.statusCode === 200 && !r.body.reports.some(x => x.id === shared.id), show(r));
    r = await put(BOSS, shared.id, { name: 'Moved', version: shared.version }, 'turf');
    assert('a paving report cannot be saved through turf (404)', r.statusCode === 404, show(r));
    r = await del(BOSS, shared.id, 'turf');
    assert('…nor deleted through turf (404)', r.statusCode === 404 && !(await dbRow(shared.id)).deleted_at, show(r));
    r = await create(BOSS, { name: shared.name, visibility: 'shared' }, 'turf');
    assert('turf may have a template of the same name', r.statusCode === 201 && (await dbRow(r.body.report.id)).division === 'turf', show(r));
    r = await call('GET', P(), null, TURFPM);
    assert('a turf-only user is refused paving (403)', r.statusCode === 403, show(r));
    r = await call('GET', { division: 'kiewit' }, null, KIEWIT);
    assert('kiewit has Custom Reporting too', r.statusCode === 200 && r.body.canShare === true, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nName clashes, per scope');
  {
    let r = await create(BOB, { name: 'Clash Test' });
    const bobClash = r.body.report;
    assert('a private name is free', r.statusCode === 201, show(r));
    r = await create(BOB, { name: '  clash TEST ' });
    assert('the same owner again, spaced and cased differently → 409 name_taken',
      r.statusCode === 409 && r.body.error === 'name_taken', show(r));
    r = await create(ALICE, { name: 'Clash Test' });
    assert('another owner may use it privately', r.statusCode === 201, show(r));
    r = await create(PM, { name: 'clash test', visibility: 'shared' });
    const sharedClash = r.body.report;
    assert('a shared template may use it — shared names are their own scope', r.statusCode === 201, show(r));
    r = await create(BOSS, { name: ' CLASH Test', visibility: 'shared' });
    assert('a second shared template of that name → 409 name_taken', r.statusCode === 409 && r.body.error === 'name_taken', show(r));
    const bobOther = (await create(BOB, { name: 'Other Name' })).body.report;
    r = await put(BOB, bobOther.id, { name: 'CLASH test', version: 1 });
    assert('renaming onto a taken name → 409 name_taken, and nothing changes',
      r.statusCode === 409 && r.body.error === 'name_taken' && (await dbRow(bobOther.id)).name === 'Other Name'
        && (await dbRow(bobOther.id)).version === 1, show(r));
    const pmOwn = (await create(PM, { name: 'Clash Test' })).body.report;
    r = await put(PM, pmOwn.id, { visibility: 'shared', version: 1 });
    assert('sharing a private report whose name a template already has → 409 name_taken',
      r.statusCode === 409 && r.body.error === 'name_taken' && (await dbRow(pmOwn.id)).visibility === 'private', show(r));
    r = await put(PM, sharedClash.id, { visibility: 'private', version: 1 });
    assert('…and making a template private when its author already has a private report of that name → 409',
      r.statusCode === 409 && r.body.error === 'name_taken', show(r));
    assert('(Bob\'s report is untouched by all of it)', (await dbRow(bobClash.id)).version === 1);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nOptimistic locking');
  {
    const cur = (await list(ALICE)).body.reports.find(x => x.id === aliceWeekly.id);
    let r = await put(ALICE, cur.id, { name: 'Fresh', version: cur.version });
    assert('a save from the version it opened succeeds', r.statusCode === 200 && r.body.report.version === cur.version + 1, show(r));
    r = await put(ALICE, cur.id, { name: 'Stale', version: cur.version });
    assert('a save from an older version → 409 version_conflict', r.statusCode === 409 && r.body.error === 'version_conflict', show(r));
    assert('…carrying the copy that is there now', r.body.report && r.body.report.name === 'Fresh' && r.body.report.version === cur.version + 1
      && r.body.report.can_edit === true, JSON.stringify(r.body.report));
    assert('…and the stale save changed nothing', (await dbRow(cur.id)).name === 'Fresh');
    r = await put(ALICE, cur.id, { name: 'No version' });
    assert('a save with no version → 400', r.statusCode === 400, show(r));
    r = await put(ALICE, cur.id, { name: 'Junk version', version: 'abc' });
    assert('a save with a junk version → 400', r.statusCode === 400, show(r));
    r = await call('PUT', P(), { name: 'x', version: 1 }, ALICE);
    assert('a save with no id → 400', r.statusCode === 400, show(r));

    // Two people press Save on the same template at once. Both read version
    // N; the database lets exactly one through.
    const tpl = (await create(PM, { name: 'Race', visibility: 'shared' })).body.report;
    const [a, b] = await Promise.all([
      put(PM, tpl.id, { name: 'Race — PM', version: 1 }),
      put(BOSS, tpl.id, { name: 'Race — Boss', version: 1 }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort().join(',');
    const winner = a.statusCode === 200 ? a : b;
    const loser  = a.statusCode === 200 ? b : a;
    assert('two saves racing from one version: one wins, the other gets 409', codes === '200,409', `${show(a)} | ${show(b)}`);
    assert('…the loser is shown the winner\'s copy', loser.body.error === 'version_conflict' && loser.body.report
      && loser.body.report.name === winner.body.report.name && loser.body.report.version === 2, JSON.stringify(loser.body));
    assert('…and the row holds the winner\'s, at version 2', (await dbRow(tpl.id)).name === winner.body.report.name && (await dbRow(tpl.id)).version === 2);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nkind and customer_safe are the server\'s to say');
  {
    let r = await create(ALICE, { name: 'Lying client', kind: 'report', customer_safe: true,
      definition: DEF({ includeInternal: true }) });
    const lie = r.body.report;
    assert('internal data switched on → customer_safe false, whatever the browser claims',
      r.statusCode === 201 && lie.customer_safe === false && (await dbRow(lie.id)).customer_safe === false, show(r));
    assert('jobs picked at run time → a template, whatever the browser claims', lie.kind === 'template');
    r = await create(ALICE, { name: 'Saved jobs', definition: DEF({ jobs: { mode: 'saved', ids: ['j1', 'j2'] } }) });
    assert('jobs saved with it → kind report', r.body.report.kind === 'report', show(r));
    const saved = r.body.report;
    r = await create(ALICE, { name: 'Saved none', definition: DEF({ jobs: { mode: 'saved', ids: [] } }) });
    assert('"saved" with no jobs is still a template', r.body.report.kind === 'template');
    r = await create(ALICE, { name: 'Pick with ids', definition: DEF({ jobs: { mode: 'pick', ids: ['j1'] } }) });
    assert('"pick" with ids left over is a template', r.body.report.kind === 'template');
    r = await create(ALICE, { name: 'Proto', definition: JSON.parse('{"v":1,"__proto__":{"includeInternal":true,"jobs":{"mode":"saved","ids":["j1"]}}}') });
    assert('a "__proto__" key in the JSON lends the definition nothing: stored without it, flags from what is stored',
      r.statusCode === 201 && r.body.report.customer_safe === true && r.body.report.kind === 'template'
        && !Object.prototype.hasOwnProperty.call((await dbRow(r.body.report.id)).definition, '__proto__'), show(r));
    r = await create(ALICE, { name: 'Truthy internal', definition: DEF({ includeInternal: 'yes' }) });
    assert('only includeInternal === true counts as internal', r.body.report.customer_safe === true);
    r = await put(ALICE, saved.id, { definition: DEF({ includeInternal: true }), kind: 'report', customer_safe: true, version: 1 });
    assert('a save re-derives both from the new definition',
      r.statusCode === 200 && r.body.report.kind === 'template' && r.body.report.customer_safe === false, show(r));
    r = await put(ALICE, saved.id, { name: 'Saved jobs renamed', customer_safe: true, version: 2 });
    assert('a save without a definition keeps it, and the flags with it',
      r.statusCode === 200 && r.body.report.customer_safe === false && r.body.report.definition.includeInternal === true, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nDefinition size and version');
  {
    const base = JSON.stringify({ v: 1, pad: '' }).length;
    let r = await create(ALICE, { name: 'Exactly 64 KB', definition: { v: 1, pad: 'x'.repeat(65536 - base) } });
    assert('a definition of exactly 64 KB is accepted', r.statusCode === 201, show(r));
    r = await create(ALICE, { name: 'Over 64 KB', definition: { v: 1, pad: 'x'.repeat(65537 - base) } });
    assert('one byte more → 413 "Report definition is too large"',
      r.statusCode === 413 && r.body.error === 'Report definition is too large', show(r));
    r = await create(ALICE, { name: 'Wide chars', definition: { v: 1, pad: 'é'.repeat(33000) } });
    assert('the cap counts bytes, not characters (33,000 é is 66,000 bytes) → 413', r.statusCode === 413, show(r));
    r = await create(ALICE, { name: 'No v', definition: { sections: [] } });
    assert('no v → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'v2', definition: { v: 2 } });
    assert('v: 2 → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'v string', definition: { v: '1' } });
    assert('v: "1" → 400', r.statusCode === 400, show(r));
    const tgt = (await create(ALICE, { name: 'Size target' })).body.report;
    r = await put(ALICE, tgt.id, { definition: { v: 1, pad: 'x'.repeat(70000) }, version: 1 });
    assert('a save over the cap → 413, and the report is unchanged',
      r.statusCode === 413 && (await dbRow(tgt.id)).version === 1, show(r));
    r = await put(ALICE, tgt.id, { definition: { v: 3 }, version: 1 });
    assert('a save with the wrong v → 400, and the report is unchanged', r.statusCode === 400 && (await dbRow(tgt.id)).version === 1, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nDelete, Recently Deleted, restore');
  {
    const doomed = (await create(ALICE, { name: 'Doomed' })).body.report;
    let r = await del(ALICE, doomed.id);
    assert('its owner deletes it: soft, with who and when',
      r.statusCode === 200 && r.body.report && r.body.report.deleted_at && r.body.report.deleted_by_username === 'alice', show(r));
    const row = await dbRow(doomed.id);
    assert('…the row is still there, marked', row && row.deleted_at && row.deleted_by_username === 'alice');
    assert('…and gone from the list', !ids(await list(ALICE)).includes(doomed.id));
    r = await list(ALICE, { deleted: '1' });
    const inBin = r.body.reports.find(x => x.id === doomed.id);
    assert('Recently Deleted has it, with deleted_at and deleted_by_username',
      r.statusCode === 200 && inBin && inBin.deleted_at && inBin.deleted_by_username === 'alice', show(r));
    assert('…and nothing live', r.body.reports.every(x => x.deleted_at));
    assert('another user\'s Recently Deleted does not', !ids(await list(BOB, { deleted: '1' })).includes(doomed.id));
    r = await put(ALICE, doomed.id, { name: 'Zombie', version: 1 });
    assert('a deleted report cannot be saved (404)', r.statusCode === 404, show(r));
    r = await del(ALICE, doomed.id);
    assert('…or deleted again (404)', r.statusCode === 404, show(r));
    r = await restore(BOB, doomed.id);
    assert('someone else cannot restore it (404)', r.statusCode === 404 && (await dbRow(doomed.id)).deleted_at, show(r));
    r = await restore(ALICE, doomed.id);
    assert('its owner restores it', r.statusCode === 200 && r.body.report.id === doomed.id && !r.body.report.deleted_at, show(r));
    assert('…back in the list, out of the bin', ids(await list(ALICE)).includes(doomed.id) && !ids(await list(ALICE, { deleted: '1' })).includes(doomed.id));
    r = await restore(ALICE, doomed.id);
    assert('restoring twice (a double click) is answered with the report, not an error', r.statusCode === 200 && r.body.report.id === doomed.id, show(r));

    const tpl = (await create(PM, { name: 'Shared Doomed', visibility: 'shared' })).body.report;
    await del(PM, tpl.id);
    assert('a deleted shared template is in an admin\'s Recently Deleted', ids(await list(BOSS, { deleted: '1' })).includes(tpl.id));
    assert('…not a level1 user\'s, who could not restore it', !ids(await list(ALICE, { deleted: '1' })).includes(tpl.id));
    r = await restore(ALICE, tpl.id);
    assert('a level1 user cannot restore a shared template (403)', r.statusCode === 403, show(r));
    r = await restore(BOSS, tpl.id);
    assert('an admin can', r.statusCode === 200 && r.body.report.visibility === 'shared' && r.body.report.updated_by_username === 'boss', show(r));

    const old = (await create(ALICE, { name: 'Restore Clash' })).body.report;
    await del(ALICE, old.id);
    r = await create(ALICE, { name: 'restore clash' });
    assert('a deleted report\'s name is free again', r.statusCode === 201, show(r));
    r = await restore(ALICE, old.id);
    assert('restoring it while that name is live again → 409 name_taken', r.statusCode === 409 && r.body.error === 'name_taken', show(r));
    assert('…and it stays deleted', Boolean((await dbRow(old.id)).deleted_at));

    const stale = (await create(ALICE, { name: 'Long gone' })).body.report;
    await del(ALICE, stale.id);
    await client.query("UPDATE custom_reports SET deleted_at = NOW() - interval '31 days' WHERE id = $1", [stale.id]);
    assert('a report deleted 31 days ago is out of Recently Deleted', !ids(await list(ALICE, { deleted: '1' })).includes(stale.id));
    r = await restore(ALICE, stale.id);
    assert('…and cannot be restored (404)', r.statusCode === 404 && (await dbRow(stale.id)).deleted_at, show(r));
    r = await call('POST', P({ action: 'restore' }), {}, ALICE);
    assert('restore with no id → 400', r.statusCode === 400, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe 90-day purge');
  let purgedRunId;
  {
    const mkDel = async (name, days, { division = 'paving', auth = ALICE } = {}) => {
      const rep = (await create(auth, { name }, division)).body.report;
      await client.query(`UPDATE custom_reports SET deleted_at = NOW() - make_interval(days => $2), deleted_by_username = 'x' WHERE id = $1`, [rep.id, days]);
      return rep.id;
    };
    const old91   = await mkDel('Purge 91', 91);
    const old89   = await mkDel('Purge 89', 89);
    const turf91  = await mkDel('Turf 91', 91, { division: 'turf', auth: BOSS });
    const rival91 = await mkDel('Rival 91', 91, { auth: RIVAL });
    // A run against the report that is about to go, logged while it was live.
    await client.query('UPDATE custom_reports SET deleted_at = NULL WHERE id = $1', [old91]);
    purgedRunId = (await run(ALICE, { report_id: old91, report_name: 'Purge 91' })).body.run.id;
    await client.query("UPDATE custom_reports SET deleted_at = NOW() - interval '91 days' WHERE id = $1", [old91]);

    const trigger = (await create(ALICE, { name: 'Purge trigger' })).body.report;
    const r = await del(ALICE, trigger.id);
    assert('a delete still answers 200', r.statusCode === 200, show(r));
    assert('…and takes this division\'s rows deleted over 90 days ago with it', !(await dbRow(old91)));
    assert('…but not one deleted 89 days ago', Boolean(await dbRow(old89)));
    assert('…nor another division\'s', Boolean(await dbRow(turf91)));
    assert('…nor another company\'s', Boolean(await dbRow(rival91)));
    const hist = await dbRun(purgedRunId);
    assert('its run history stays, pointing at no report', hist && hist.report_id === null && hist.report_name === 'Purge 91');
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe run log');
  {
    const mine = (await create(ALICE, { name: 'Run me' })).body.report;
    let r = await run(ALICE, {
      report_id: mine.id, report_name: 'Run me', action: 'email',
      project_ids: ['p1', 'p2'], project_names: ['Maple Ave', 'Oak St'],
      date_from: '2026-10-01', date_to: '2026-10-31',
      recipients: [' Owner@Example.com', 'owner@example.com', 'gc@example.com'],
      subject: 'October update — 2 jobs', included_internal: false,
      definition: DEF({ title: 'Snapshot title' }),
    });
    const logged = r.body.run;
    assert('logging a send answers 201 with the run', r.statusCode === 201 && logged && logged.id, show(r));
    assert('…against the report', logged.report_id === mine.id && logged.action === 'email' && logged.report_name === 'Run me');
    assert('…with the jobs, by id and name, in order',
      JSON.stringify(logged.project_ids) === '["p1","p2"]' && JSON.stringify(logged.project_names) === '["Maple Ave","Oak St"]');
    assert('…the dates as YYYY-MM-DD', logged.date_from === '2026-10-01' && logged.date_to === '2026-10-31', JSON.stringify(logged));
    assert('…recipients trimmed, lower-cased, once each',
      JSON.stringify(logged.recipients) === '["owner@example.com","gc@example.com"]', JSON.stringify(logged.recipients));
    assert('…subject, internal flag and who sent it',
      logged.subject === 'October update — 2 jobs' && logged.included_internal === false
        && logged.run_by_user_id === ALICE.userId && logged.run_by_username === 'alice');
    const stored = await dbRun(logged.id);
    assert('the definition is snapshotted on the run as sent', stored.definition.title === 'Snapshot title'
      && stored.company_code === CO && stored.division === 'paving' && stored.df === '2026-10-01');
    let rep = await dbRow(mine.id);
    assert('the report\'s run count and last run move', rep.run_count === 1 && rep.last_run_at);
    assert('…without touching its version or updated_at, so an open editor\'s next save is not a false conflict',
      rep.version === 1 && new Date(rep.updated_at).getTime() === new Date(mine.updated_at).getTime());
    r = await put(ALICE, mine.id, { name: 'Run me (edited)', version: 1 });
    assert('…as the save that follows shows', r.statusCode === 200, show(r));

    r = await run(ALICE, { report_id: shared.id, action: 'excel' });
    assert('a run of a shared template a level1 user can see counts against it',
      r.statusCode === 201 && r.body.run.report_id === shared.id && (await dbRow(shared.id)).run_count === 1, show(r));
    const bobsPrivate = (await create(BOB, { name: 'Bob only' })).body.report;
    r = await run(ALICE, { report_id: bobsPrivate.id, action: 'print' });
    assert('a report_id the caller cannot see is logged as no report — never a 404',
      r.statusCode === 201 && r.body.run.report_id === null && (await dbRow(bobsPrivate.id)).run_count === 0, show(r));
    const gone = (await create(ALICE, { name: 'Deleted run' })).body.report;
    await del(ALICE, gone.id);
    r = await run(ALICE, { report_id: gone.id });
    assert('…so is a deleted one', r.statusCode === 201 && r.body.run.report_id === null && (await dbRow(gone.id)).run_count === 0, show(r));
    const rivalRep = (await create(RIVAL, { name: 'Rival run' })).body.report;
    r = await run(ALICE, { report_id: rivalRep.id });
    assert('…and another company\'s', r.statusCode === 201 && r.body.run.report_id === null && (await dbRow(rivalRep.id)).run_count === 0, show(r));
    r = await run(ALICE, { report_id: 'abc' });
    assert('…and junk', r.statusCode === 201 && r.body.run.report_id === null, show(r));
    r = await run(ALICE, { report_id: undefined, report_name: '', definition: undefined });
    assert('a run of an unsaved report, unnamed, with no definition, is still logged',
      r.statusCode === 201 && r.body.run.report_id === null && r.body.run.report_name === 'Untitled report', show(r));
    r = await run(ALICE, { project_names: ['Bad\u0000Job \udc00'] });
    assert('a NUL in a job name does not fail the log', r.statusCode === 201 && r.body.run.project_names[0] === 'BadJob', show(r));

    r = await run(ALICE, { action: 'fax' });
    assert('an action other than print / email / excel → 400', r.statusCode === 400, show(r));
    r = await run(ALICE, { action: undefined });
    assert('no action → 400', r.statusCode === 400, show(r));
    r = await run(ALICE, { project_ids: Array.from({ length: 501 }, (_, i) => 'p' + i) });
    assert('501 jobs → 400', r.statusCode === 400, show(r));
    r = await run(ALICE, { project_ids: Array.from({ length: 500 }, (_, i) => 'p' + i) });
    assert('500 jobs is fine', r.statusCode === 201 && r.body.run.project_ids.length === 500, show(r));
    r = await run(ALICE, { project_names: Array.from({ length: 501 }, (_, i) => 'n' + i) });
    assert('501 job names → 400', r.statusCode === 400, show(r));
    r = await run(ALICE, { recipients: Array.from({ length: 51 }, (_, i) => `r${i}@example.com`) });
    assert('51 recipients → 400', r.statusCode === 400, show(r));
    r = await run(ALICE, { project_ids: 'p1' });
    assert('jobs that are not a list → 400', r.statusCode === 400, show(r));
    for (const bad of ['2026-13-01', '2026-02-30', '10/01/2026', '2026-1-5', 20261001]) {
      r = await run(ALICE, { date_from: bad });
      assert(`date ${JSON.stringify(bad)} → 400`, r.statusCode === 400, show(r));
    }
    r = await run(ALICE, { date_from: '', date_to: null });
    assert('empty dates are no dates', r.statusCode === 201 && r.body.run.date_from === null && r.body.run.date_to === null, show(r));
    r = await run(ALICE, { definition: { pad: 'x'.repeat(70000) } });
    assert('a definition snapshot over 64 KB → 413', r.statusCode === 413, show(r));
    r = await run(ALICE, { included_internal: true, report_name: 'Internal one' });
    assert('the internal flag is kept', r.statusCode === 201 && r.body.run.included_internal === true, show(r));
    await run(BOB, { report_name: 'Bob print' });
    await run(BOSS, { report_name: 'Turf run' }, 'turf');

    r = await call('GET', P({ runs: '1' }), null, ALICE);
    const aliceRuns = r.body.runs || [];
    assert('a level1 user\'s history is their own runs only',
      r.statusCode === 200 && aliceRuns.length > 5 && aliceRuns.every(x => x.run_by_user_id === ALICE.userId), show(r));
    assert('…newest first', aliceRuns.every((x, i) => i === 0 || new Date(aliceRuns[i - 1].created_at) >= new Date(x.created_at)));
    assert('…without the definition snapshots (the history stays small)', aliceRuns.every(x => !('definition' in x)));
    r = await call('GET', P({ runs: '1' }), null, BOB);
    assert('…and another level1 user\'s is theirs', r.body.runs.length >= 1 && r.body.runs.every(x => x.run_by_user_id === BOB.userId));
    r = await call('GET', P({ runs: '1' }), null, PM);
    const allRuns = r.body.runs || [];
    assert('a level3 sees every run in the division',
      allRuns.some(x => x.run_by_user_id === ALICE.userId) && allRuns.some(x => x.run_by_user_id === BOB.userId));
    assert('…and none from another division', !allRuns.some(x => x.report_name === 'Turf run'));
    r = await call('GET', P({ runs: '1', report_id: String(shared.id) }), null, PM);
    assert('?report_id narrows it to one report', r.body.runs.length === 1 && r.body.runs[0].report_id === shared.id, show(r));
    r = await call('GET', P({ runs: '1', report_id: String(shared.id) }), null, BOB);
    assert('…still only the caller\'s own for a level1 user', r.body.runs.length === 0, show(r));
    r = await call('GET', P({ runs: '1', report_id: 'x' }), null, PM);
    assert('a junk report_id → 400', r.statusCode === 400, show(r));
    r = await call('GET', P({ runs: '1' }), null, RIVAL);
    assert('another company sees none of these runs', !r.body.runs.some(x => x.run_by_user_id === ALICE.userId), show(r));
    r = await call('GET', { division: 'turf', runs: '1' }, null, BOSS);
    assert('turf\'s history has turf\'s run only', r.body.runs.length === 1 && r.body.runs[0].report_name === 'Turf run', show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nCaps');
  {
    await client.query(`
      INSERT INTO custom_reports (company_code, division, name, owner_user_id, owner_username, updated_at)
      SELECT $1, 'kiewit', 'Bulk ' || g, $2, 'kpm', NOW() - make_interval(secs => g)
        FROM generate_series(1, 505) g`, [CO, KIEWIT.userId]);
    let r = await call('GET', { division: 'kiewit' }, null, KIEWIT);
    assert('the list stops at 500, newest change first',
      r.body.reports.length === 500 && r.body.reports[0].name === 'Bulk 1' && r.body.reports[499].name === 'Bulk 500', show({ statusCode: r.statusCode, body: r.body.reports.length }));
    await client.query(`
      INSERT INTO custom_report_runs (company_code, division, report_name, action, run_by_user_id, run_by_username)
      SELECT $1, 'kiewit', 'Bulk run ' || g, 'print', $2, 'kpm' FROM generate_series(1, 205) g`, [CO, KIEWIT.userId]);
    r = await call('GET', { division: 'kiewit', runs: '1' }, null, KIEWIT);
    assert('the history stops at 200', r.body.runs.length === 200, r.body.runs && r.body.runs.length);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nDivisions, methods, actions');
  {
    let r = await call('GET', { division: 'dust' }, null, DUSTY);
    assert('a division without Custom Reporting → 400, saying so',
      r.statusCode === 400 && r.body.error === 'Custom reports are not available for this division', show(r));
    r = await call('GET', { division: 'quarry' }, null, PLAT);
    assert('…even for a platform admin', r.statusCode === 400 && r.body.error === 'Custom reports are not available for this division', show(r));
    r = await call('GET', {}, null, BOSS);
    assert('no division → 400 (never a silent default to turf)', r.statusCode === 400, show(r));
    r = await call('GET', { division: 'nonsense' }, null, BOSS);
    assert('an unknown division → 400', r.statusCode === 400, show(r));
    r = await call('POST', {}, { division: 'paving', name: 'Body division', definition: DEF() }, ALICE);
    assert('the division may come in the body instead', r.statusCode === 201 && (await dbRow(r.body.report.id)).division === 'paving', show(r));
    r = await call('PATCH', P(), {}, ALICE);
    assert('PATCH → 405', r.statusCode === 405, show(r));
    r = await call('HEAD', P(), {}, ALICE);
    assert('HEAD → 405', r.statusCode === 405, show(r));
    r = await call('OPTIONS', P(), {}, null);
    assert('OPTIONS → 200 without a login', r.statusCode === 200);
    r = await call('POST', P({ action: 'bogus' }), {}, ALICE);
    assert('an unknown POST action → 400, not a create', r.statusCode === 400 && r.body.error === 'Unknown action', show(r));
    r = await call('GET', P(), null, null);
    assert('no login → 401', r.statusCode === 401, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe real sign-in path');
  {
    const jwt = require('jsonwebtoken');
    // Alice's token claims she is a paving admin. Her users row says level1,
    // and the row is what counts — as it is on every other endpoint.
    const token = jwt.sign({ userId: ALICE.userId, username: 'alice', companyCode: CO, role: 'admin',
      divisionRoles: { paving: 'admin' }, isPlatformAdmin: false }, process.env.JWT_SECRET);
    let r = await call('GET', P(), null, null, { token });
    assert('a real token reaches the list, as the account it belongs to',
      r.statusCode === 200 && r.body.me.userId === ALICE.userId && r.body.canShare === false, show(r));
    r = await call('POST', P(), { name: 'Token share', visibility: 'shared', definition: DEF() }, null, { token });
    assert('…and cannot share on the strength of a stale claim (403)', r.statusCode === 403, show(r));
    r = await call('GET', P(), null, null, { token: 'not-a-token' });
    assert('a bad token → 401', r.statusCode === 401, show(r));
    const salesToken = jwt.sign({ userId: SALES.userId, username: 'salesguy', companyCode: CO, role: 'level1' }, process.env.JWT_SECRET);
    r = await call('GET', P(), null, null, { token: salesToken });
    assert('a sales account is refused through the real path too (403)', r.statusCode === 403, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe Email Report button\'s report types');
  {
    const want = { turf_custom_report: ['turf', 'Custom Report — Turf'],
      paving_custom_report: ['paving', 'Custom Report — Paving'],
      kiewit_custom_report: ['kiewit', 'Custom Report — Kiewit Pinetree'] };
    for (const [type, [division, label]] of Object.entries(want)) {
      const t = catalog.REPORT_TYPES[type];
      assert(`${type} is an emailable report type of ${division}`, t && t.division === division && t.label === label, JSON.stringify(t));
      assert(`…and not one Auto Reports offers`, !catalog.SCHEDULABLE[type]);
    }
    const email = (type, auth) => call('POST', {}, { report_type: type, recipients: [], html: '<p>x</p>' }, auth, { h: sendReport });
    let r = await email('paving_custom_report', ALICE);
    assert('send-report takes a paving custom report from a paving user (on to checking recipients)',
      r.statusCode === 400 && /recipient/i.test(r.body.error), show(r));
    r = await email('kiewit_custom_report', ALICE);
    assert('…and refuses a kiewit one from someone without kiewit (403)', r.statusCode === 403, show(r));

    const src = fs.readFileSync(path.join(ROOT, 'report-email.js'), 'utf8');
    for (const [type, [, label]] of Object.entries(want)) {
      assert(`report-email.js labels ${type} "${label}"`, src.includes(`${type}: '${label}'`) || new RegExp(`${type}:\\s*'${label}'`).test(src));
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe Email modal tells Custom Reporting what was sent (onSent)');
  {
    const { JSDOM } = require('jsdom');
    const src = fs.readFileSync(path.join(ROOT, 'report-email.js'), 'utf8');
    const tick = () => new Promise(r => setTimeout(r, 10));
    async function sendWith({ reply, onSent, status = 200, closeMidSend = false }) {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const w = dom.window;
      w.localStorage.setItem('fct_token', 'test-token');
      w.localStorage.setItem('fct_user', JSON.stringify({ role: 'level1' }));
      const posts = [];
      w.fetch = async (url, opts = {}) => {
        if (String(url).startsWith('/api/email/send-report')) {
          posts.push(JSON.parse(opts.body));
          if (closeMidSend) await new Promise(r => setTimeout(r, 50));
          return { ok: status === 200, status, json: async () => reply };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, isAdmin: false, groups: [] }) };
      };
      const warns = [];
      w.console.warn = (...a) => warns.push(a.join(' '));
      w.eval(src);
      const opts = { reportType: 'paving_custom_report', projectId: null, projectName: '2 jobs',
        defaultSubject: 'Weekly — 2 jobs', getHTML: () => '<p>report</p>' };
      if (onSent !== undefined) opts.onSent = onSent;
      w.openReportEmailModal(opts);
      const $ = id => w.document.getElementById(id);
      $('rem-input').value = 'Owner@Example.com, gc@example.com';
      $('rem-add').click();
      $('rem-subject').value = '  Weekly — 2 jobs  ';
      const label = (w.document.querySelector('#' + 'report-email-modal [role="dialog"]') || {}).textContent || '';
      $('rem-send').click();
      if (closeMidSend) {
        // Closed while the request is out: the email still goes.
        $('rem-close').click();
        for (let i = 0; i < 20; i++) await tick();
        const gone = { status: null, sendDisabled: null, posts, warns, label, modalOpen: Boolean($('rem-send')) };
        w.close();
        return gone;
      }
      for (let i = 0; i < 100 && !/Sent to|Send failed/.test(($('rem-status') || {}).textContent || ''); i++) await tick();
      await tick();
      const out = { status: $('rem-status').textContent, sendDisabled: $('rem-send').disabled, posts, warns, label };
      w.close();
      return out;
    }

    let calls = [];
    let m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true, pdfPages: 3 }, onSent: info => calls.push(info) });
    assert('the modal labels the report "Custom Report — Paving"', m.label.includes('Custom Report — Paving'), m.label.slice(0, 120));
    assert('a send that went out calls onSent once', calls.length === 1 && /^Sent to 2 recipients/.test(m.status), `${calls.length} ${m.status}`);
    assert('…with the recipients, the subject as sent, the count and the PDF flag',
      calls[0] && JSON.stringify(calls[0].recipients) === '["owner@example.com","gc@example.com"]'
        && calls[0].subject === 'Weekly — 2 jobs' && calls[0].subject === m.posts[0].subject
        && calls[0].recipientCount === 2 && calls[0].pdfAttached === true, JSON.stringify(calls[0]));

    calls = [];
    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: false, warning: 'The PDF could not be made.' }, onSent: info => calls.push(info) });
    assert('a send that went out with a warning calls it too, PDF flag false',
      calls.length === 1 && calls[0].pdfAttached === false && /The PDF could not be made/.test(m.status), `${calls.length} ${m.status}`);
    assert('…and Send stays disabled, as before', m.sendDisabled === true);

    calls = [];
    m = await sendWith({ reply: { ok: false, error: 'Resend is down' }, status: 502, onSent: info => calls.push(info) });
    assert('a send that failed does not call it', calls.length === 0 && /Send failed: Resend is down/.test(m.status), m.status);
    assert('…and Send comes back for a retry', m.sendDisabled === false);

    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true }, onSent: () => { throw new Error('history down'); } });
    assert('an onSent that throws does not turn a sent email into "Send failed"',
      /^Sent to 2 recipients/.test(m.status) && m.sendDisabled === true, m.status);
    assert('…it is logged as a warning', m.warns.some(x => /onSent failed: history down/.test(x)), m.warns.join(' | '));

    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true }, onSent: async () => { throw new Error('async history down'); } });
    await tick();
    assert('an onSent that rejects is caught and logged too',
      /^Sent to 2 recipients/.test(m.status) && m.warns.some(x => /onSent failed: async history down/.test(x)), `${m.status} | ${m.warns.join(' | ')}`);

    calls = [];
    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true }, onSent: info => calls.push(info), closeMidSend: true });
    assert('closing the modal while the send is out still records the email that went',
      m.modalOpen === false && m.posts.length === 1 && calls.length === 1
        && JSON.stringify(calls[0].recipients) === '["owner@example.com","gc@example.com"]' && calls[0].subject === 'Weekly — 2 jobs',
      `${m.modalOpen} ${m.posts.length} ${JSON.stringify(calls)}`);

    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true } });
    assert('without onSent the modal sends exactly as it always has', /^Sent to 2 recipients\. PDF attached/.test(m.status) && m.posts.length === 1, m.status);
    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true }, onSent: 'not a function' });
    assert('an onSent that is not a function is ignored', /^Sent to 2 recipients/.test(m.status), m.status);
  }

  await cleanUp();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await cleanUp(); await client.end(); } catch { /* already reporting the real failure */ }
  process.exit(1);
});
