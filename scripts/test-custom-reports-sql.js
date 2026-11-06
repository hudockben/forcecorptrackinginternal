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
 *
 * And for Custom Reporting v2:
 *   - the CUSTOM REPORTING V2 schema section splits and runs the run-schema
 *     way, twice, on this database and on a fresh one holding only the schema
 *     before it, and its CHECKs and unique index hold;
 *   - definitions v1 and v2 are both saved, and a v1 save over a v2 report is
 *     refused (409 client_outdated) before it can strip anything;
 *   - a job's send history (?project_id=) is every division user's to see,
 *     the general history still only the caller's own, both paged 100 at a
 *     time on a cursor that never skips or repeats, with the GIN index used;
 *   - one run (?run=) and its archived HTML (&archive=1) follow the visibility
 *     rules exactly — an internal archive only for its sender and admins /
 *     level3 — and the archive round-trips gzip byte for byte;
 *   - a resend keeps the run it repeated only when the sender could see it;
 *   - send-report archives the sanitized HTML it delivered, never fails a send
 *     over the archive, and heads the email with the company's current name;
 *   - the Email modal's defaultRecipients, contacts, run_kind passthrough and
 *     archived flag.
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
// send-report reads these when it loads; the Resend SDK itself is stubbed
// below, so nothing leaves the box.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'reports@example.com';
// send-report reads the company's current name only when there is a database
// to ask; the driver below is the test's, whatever this says.
process.env.DATABASE_URL = process.env.DATABASE_URL || URL;

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
// What reached the (stubbed) Resend SDK, and a switch to make the history
// write fail the way a database blip would.
const RESEND = { sent: [] };
const DB = { failRunInsert: false, failArchiveInsert: false, failCompanyName: false };
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => {
      const sql = makeSql(client);
      return (strings, ...values) => {
        const text = strings.join('?');
        if (DB.failRunInsert && text.includes('INSERT INTO custom_report_runs')) {
          return Promise.reject(new Error('connection reset'));
        }
        if (DB.failArchiveInsert && text.includes('INSERT INTO custom_report_run_archives')) {
          return Promise.reject(new Error('disk full'));
        }
        if (DB.failCompanyName && text.includes('LEFT JOIN company_branding')) {
          return Promise.reject(new Error('relation "company_branding" does not exist'));
        }
        return sql(strings, ...values);
      };
    } };
  }
  if (request === 'resend') {
    return { Resend: class {
      constructor() { this.emails = { send: async opts => { RESEND.sent.push(opts); return { data: { id: 'stub-' + RESEND.sent.length }, error: null }; } }; }
    } };
  }
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
// scripts/run-schema.js's split: drop lines starting with '--', split on ';'.
const splitSql = text => text.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  .split(';').map(x => x.trim()).filter(Boolean);

async function cleanUp() {
  for (const co of [CO, CO2]) {
    await client.query('DELETE FROM custom_report_run_archives WHERE company_code = $1', [co]).catch(() => {});
    await client.query('DELETE FROM company_branding WHERE company_code = $1', [co]).catch(() => {});
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
  const THROT  = await mk('throttler', { paving: 'level1', turf: 'level1' });

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
    await client.query('DELETE FROM custom_reports WHERE company_code = $1', [CO]);

    // The section is split and run the way scripts/run-schema.js does it — on
    // every ';' once lines starting with '--' are gone — and each statement
    // run twice, so a ';' in a trailing comment or a non-idempotent statement
    // fails here rather than in a deploy.
    // The section runs from its own header to the CUSTOM REPORTING V2 header
    // (which has its own block below), not to the end of the file.
    const file = fs.readFileSync(path.join(ROOT, 'neon-schema.sql'), 'utf8');
    const at = file.indexOf('CUSTOM REPORTS (Analytics');
    const v2At = file.indexOf('\n-- CUSTOM REPORTING V2');
    const v2Start = v2At < 0 ? file.length : file.lastIndexOf('\n-- ─', v2At);
    const section = at < 0 ? '' : file.slice(file.lastIndexOf('\n-- ─', at), v2Start);
    const stmts = splitSql(section);
    let okRuns = 0, firstErr = '';
    for (let pass = 0; pass < 2; pass++) {
      for (const s of stmts) {
        try { await client.query(s); okRuns++; } catch (e) { firstErr = firstErr || `${e.message} in: ${s.slice(0, 80)}`; }
      }
    }
    assert(`neon-schema.sql's section splits into ${stmts.length} statements that each run, twice, the run-schema way`,
      stmts.length === 9 && okRuns === 18 && stmts.every(s => /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/.test(s)),
      firstErr || `${stmts.length} statements, ${okRuns} ran`);
    // Checked after the section has run, as a deploy runs it on top of the
    // database that is already there.
    const idx = (await client.query(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('custom_reports','custom_report_runs') ORDER BY indexname")).rows.map(r => r.indexname);
    assert('the list index, both name indexes and the four run indexes exist',
      ['idx_custom_reports_list', 'uq_custom_reports_shared_name', 'uq_custom_reports_private_name',
        'idx_custom_report_runs_company', 'idx_custom_report_runs_report', 'idx_custom_report_runs_user',
        'idx_custom_report_runs_snapshot'].every(n => idx.includes(n)), idx.join(','));

    // ── CUSTOM REPORTING V2 ─────────────────────────────────────────────
    const v2 = v2At < 0 ? '' : file.slice(v2Start);
    const v2Stmts = splitSql(v2);
    const v2Comments = v2.split('\n').filter(l => l.trim().startsWith('--'));
    assert('neon-schema.sql ends with the CUSTOM REPORTING V2 section, after CUSTOM REPORTS',
      v2At > at && at > 0 && !/\n-- ─+\n-- (?!CUSTOM REPORTING V2)[A-Z]{2}/.test(v2), String(v2At));
    assert('…with no DO $$ block and no \';\' inside a comment (run-schema splits on every one)',
      !/DO\s*\$\$/i.test(v2) && v2Comments.every(l => !l.includes(';')), v2Comments.filter(l => l.includes(';')).join(' | '));
    let v2Ok = 0, v2Err = '';
    for (let pass = 0; pass < 2; pass++) {
      for (const st of v2Stmts) {
        try { await client.query(st); v2Ok++; } catch (e) { v2Err = v2Err || `${e.message} in: ${st.slice(0, 80)}`; }
      }
    }
    assert(`…which splits into 18 statements that each run, twice, the run-schema way`,
      v2Stmts.length === 18 && v2Ok === 36, v2Err || `${v2Stmts.length} statements, ${v2Ok} ran`);
    assert('…every one CREATE … IF NOT EXISTS or ALTER TABLE … ADD COLUMN IF NOT EXISTS',
      v2Stmts.every(st => /^(CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS)/.test(st)),
      v2Stmts.filter(st => !/^(CREATE|ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS)/.test(st)).join(' | ').slice(0, 300));
    const cols = async (table) => (await client.query(
      'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1', [table])).rows
      .reduce((m, c) => { m[c.column_name] = c; return m; }, {});
    const runCols = await cols('custom_report_runs');
    assert('custom_report_runs gains run_kind (NOT NULL, default user), schedule_id and resent_from_run_id',
      runCols.run_kind && runCols.run_kind.is_nullable === 'NO' && /'user'/.test(runCols.run_kind.column_default || '')
        && runCols.schedule_id && runCols.schedule_id.data_type === 'bigint'
        && runCols.resent_from_run_id && runCols.resent_from_run_id.data_type === 'bigint', JSON.stringify(runCols.run_kind));
    const schedCols = await cols('report_schedules');
    assert('report_schedules gains custom_report_id, emails (jsonb, NOT NULL), use_job_contacts (NOT NULL) and jobs_mode',
      schedCols.custom_report_id && schedCols.emails && schedCols.emails.data_type === 'jsonb' && schedCols.emails.is_nullable === 'NO'
        && schedCols.use_job_contacts && schedCols.use_job_contacts.is_nullable === 'NO' && schedCols.jobs_mode, Object.keys(schedCols).join(','));
    assert('report_schedule_runs gains report_name', Boolean((await cols('report_schedule_runs')).report_name));
    const fks = (await client.query(`SELECT count(*)::int AS n FROM pg_constraint
      WHERE conrelid = 'report_schedules'::regclass AND contype = 'f' AND confrelid = 'custom_reports'::regclass`)).rows[0].n;
    assert('running it twice leaves ONE foreign key from report_schedules to custom_reports, not two', fks === 1, String(fks));
    const v2Idx = (await client.query('SELECT indexname, indexdef FROM pg_indexes')).rows
      .reduce((m, r) => { m[r.indexname] = r.indexdef; return m; }, {});
    assert('the contact, archive, project and schedule indexes exist',
      ['uq_report_contacts_live', 'idx_report_contacts_project', 'idx_report_contacts_client', 'idx_cr_run_archives_company',
        'idx_custom_report_runs_projects', 'idx_report_schedules_custom'].every(n => v2Idx[n]), Object.keys(v2Idx).filter(n => /contact|archive|projects|schedules_custom/.test(n)).join(','));
    assert('…the project index is a GIN index on project_ids', /USING gin \(project_ids\)/i.test(v2Idx.idx_custom_report_runs_projects || ''),
      v2Idx.idx_custom_report_runs_projects);
    const fails2 = async (q, args, code) => { try { await client.query(q, args); return false; } catch (e) { return e.code === code; } };
    const ins2 = (div, pid, ckey, email) => client.query(
      'INSERT INTO report_contacts (company_code, division, project_id, client_key, email) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [CO, div, pid, ckey, email]);
    assert('report_contacts refuses a division without Custom Reporting (CHECK)',
      await fails2('INSERT INTO report_contacts (company_code, division, project_id, email) VALUES ($1, \'dust\', \'p\', \'a@x.com\')', [CO], '23514'));
    assert('…and a contact on neither a job nor a client (CHECK)',
      await fails2('INSERT INTO report_contacts (company_code, division, email) VALUES ($1, \'paving\', \'a@x.com\')', [CO], '23514'));
    const c1 = (await ins2('paving', 'job-1', null, 'Owner@Example.com')).rows[0].id;
    assert('…and the same address twice on one job, whatever its case (unique, live rows)',
      await fails2('INSERT INTO report_contacts (company_code, division, project_id, email) VALUES ($1, \'paving\', \'job-1\', \'owner@example.COM\')', [CO], '23505'));
    let okIns = true;
    try {
      await ins2('paving', null, 'acme', 'owner@example.com');
      await ins2('turf', 'job-1', null, 'owner@example.com');
      await client.query('UPDATE report_contacts SET deleted_at = NOW() WHERE id = $1', [c1]);
      await ins2('paving', 'job-1', null, 'owner@example.com');
    } catch (e) { okIns = e.message; }
    assert('…while the same address on the client, in another division, or after the first is deleted is fine', okIns === true, okIns);
    await client.query('DELETE FROM report_contacts WHERE company_code = $1', [CO]);
    assert('company_branding refuses a logo that is not PNG or JPEG (CHECK)',
      await fails2('INSERT INTO company_branding (company_code, division, logo_mime) VALUES ($1, \'\', \'image/svg+xml\')', [CO], '23514'));
    await client.query('INSERT INTO company_branding (company_code) VALUES ($1)', [CO]);
    assert('…its division defaults to \'\' (the company default) and is part of the key',
      (await client.query('SELECT division FROM company_branding WHERE company_code = $1', [CO])).rows[0].division === ''
        && await fails2('INSERT INTO company_branding (company_code, division) VALUES ($1, \'\')', [CO], '23505'));
    await client.query('DELETE FROM company_branding WHERE company_code = $1', [CO]);
    const bareRun = (await client.query("INSERT INTO custom_report_runs (company_code, division, report_name, action) VALUES ($1, 'paving', 'bare', 'print') RETURNING run_kind, id", [CO])).rows[0];
    assert('a run written without run_kind is a user run', bareRun.run_kind === 'user');
    await client.query('INSERT INTO custom_report_run_archives (run_id, company_code, html_gzip_b64, html_bytes) VALUES ($1, $2, \'x\', 1)', [bareRun.id, CO]);
    await client.query('DELETE FROM custom_report_runs WHERE id = $1', [bareRun.id]);
    assert('an archive goes with its run (ON DELETE CASCADE)',
      (await client.query('SELECT count(*)::int AS n FROM custom_report_run_archives WHERE run_id = $1', [bareRun.id])).rows[0].n === 0);
    assert('report_builder_usage is keyed by company, user and day',
      await (async () => {
        await client.query("INSERT INTO report_builder_usage (company_code, user_id, day) VALUES ($1, 1, '2026-11-06')", [CO]);
        const dup = await fails2("INSERT INTO report_builder_usage (company_code, user_id, day) VALUES ($1, 1, '2026-11-06')", [CO], '23505');
        await client.query('DELETE FROM report_builder_usage WHERE company_code = $1', [CO]);
        return dup;
      })());

    // A database deployed before v2: the whole file up to the V2 header, a
    // run already logged, then the full file applied — twice — on top.
    const freshName = `${dbName}_v2fresh_${process.pid}`;
    let created = false;
    try { await client.query(`CREATE DATABASE "${freshName}"`); created = true; }
    catch (e) { console.log(`  ~ fresh-database check skipped: ${e.message}`); }
    if (created) {
      const fresh = new Client({ connectionString: URL.replace(/\/[^/?]+(\?|$)/, `/${freshName}$1`) });
      let errs = [], ran = 0;
      try {
        await fresh.connect();
        const apply = async (text) => { for (const st of splitSql(text)) { try { await fresh.query(st); ran++; } catch (e) { errs.push(`${e.message} in: ${st.slice(0, 60)}`); } } };
        await apply(fs.readFileSync(path.join(ROOT, 'auth-schema.sql'), 'utf8'));
        await apply(file.slice(0, v2Start));
        const before = errs.length;
        await fresh.query("INSERT INTO companies (code, name) VALUES ('OLD', 'Old Co')");
        await fresh.query("INSERT INTO custom_report_runs (company_code, division, report_name, action) VALUES ('OLD', 'paving', 'pre-v2', 'email')");
        await apply(file);
        await apply(file);
        const old = (await fresh.query("SELECT run_kind, schedule_id, resent_from_run_id FROM custom_report_runs WHERE report_name = 'pre-v2'")).rows[0];
        assert('on a fresh database holding the pre-v2 schema, the full file then applies twice without an error',
          before === 0 && errs.length === 0 && ran > 300, errs.slice(0, 3).join(' | ') || `${ran} statements`);
        assert('…and a run logged before v2 reads as a user run with no schedule or resend',
          old && old.run_kind === 'user' && old.schedule_id === null && old.resent_from_run_id === null, JSON.stringify(old));
      } finally {
        await fresh.end().catch(() => {});
        await client.query(`DROP DATABASE IF EXISTS "${freshName}"`).catch(e => console.error('drop failed:', e.message));
      }
    }
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
    assert('v: 2 is a saved report too (201), stored as v2', r.statusCode === 201 && r.body.report.definition.v === 2, show(r));
    r = await create(ALICE, { name: 'v3', definition: { v: 3 } });
    assert('v: 3 → 400, naming the versions it takes',
      r.statusCode === 400 && /expected v: 1 or 2/.test(r.body.error), show(r));
    r = await create(ALICE, { name: 'v string', definition: { v: '1' } });
    assert('v: "1" → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'v string 2', definition: { v: '2' } });
    assert('v: "2" → 400', r.statusCode === 400, show(r));
    r = await create(ALICE, { name: 'v float', definition: { v: 2.5 } });
    assert('v: 2.5 → 400', r.statusCode === 400, show(r));
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
    r = await run(ALICE, { recipients: Array.from({ length: 201 }, (_, i) => `r${i}@example.com`) });
    assert('201 recipients → 400 (a scheduled send may name up to 200)', r.statusCode === 400 && /max 200/.test(r.body.error), show(r));
    r = await run(ALICE, { recipients: Array.from({ length: 200 }, (_, i) => `r${i}@example.com`) });
    assert('200 recipients are all kept', r.statusCode === 201 && r.body.run.recipients.length === 200, show(r));
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
    r = await run(ALICE, { included_internal: false, report_name: 'Claims safe', action: 'email', definition: DEF({
      includeInternal: true,
      sections: [{ id: 's1', type: 'daily_production', title: '', columns: ['date', 'employee', 'rate', 'labor_cost'], labels: {}, options: {} }] }) });
    assert('a run whose snapshot has internal data on is logged as internal, whatever the flag says',
      r.statusCode === 201 && r.body.run.included_internal === true && (await dbRun(r.body.run.id)).included_internal === true, show(r));
    r = await run(ALICE, { included_internal: false, report_name: 'Really safe' });
    assert('…and a customer-safe snapshot with the flag off stays customer-safe',
      r.statusCode === 201 && r.body.run.included_internal === false, show(r));
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
    assert('the history comes 100 runs a page, with the cursor for the next',
      r.body.runs.length === 100 && r.body.next_before_id === r.body.runs[99].id, `${r.body.runs && r.body.runs.length} ${r.body.next_before_id}`);
    const p2 = await call('GET', { division: 'kiewit', runs: '1', before_id: String(r.body.next_before_id) }, null, KIEWIT);
    const p3 = await call('GET', { division: 'kiewit', runs: '1', before_id: String(p2.body.next_before_id) }, null, KIEWIT);
    const all = [...r.body.runs, ...p2.body.runs, ...p3.body.runs].map(x => x.id);
    assert('…three pages hold all 205, each once, and the last says there is no more',
      p2.body.runs.length === 100 && p3.body.runs.length === 5 && p3.body.next_before_id === null
        && new Set(all).size === 205, `${p2.body.runs.length} ${p3.body.runs.length} ${p3.body.next_before_id} ${new Set(all).size}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe run log cannot be flooded, and old snapshots are let go');
  {
    const countFor = async uid => Number((await client.query(
      'SELECT count(*) AS n FROM custom_report_runs WHERE run_by_user_id = $1', [uid])).rows[0].n);
    let ok = 0;
    for (let i = 0; i < 30; i++) {
      const r = await run(THROT, { report_name: 'Flood ' + i });
      if (r.statusCode === 201) ok++;
    }
    assert('30 runs in a row are all logged', ok === 30, `${ok} of 30`);
    let r = await run(THROT, { report_name: 'Flood 31' });
    assert('the 31st within the minute → 429, saying to wait', r.statusCode === 429 && /try again in a minute/i.test(r.body.error), show(r));
    assert('…and writes no row', (await countFor(THROT.userId)) === 30);
    r = await run(THROT, { report_name: 'Turf flood' }, 'turf');
    assert('…in any division of the company (the limit is per person)', r.statusCode === 429, show(r));
    r = await run(BOB, { report_name: 'Bob is fine' });
    assert('another user is not held back', r.statusCode === 201, show(r));
    await client.query("UPDATE custom_report_runs SET created_at = created_at - interval '2 minutes' WHERE run_by_user_id = $1", [THROT.userId]);
    r = await run(THROT, { report_name: 'A minute later' });
    assert('a minute later they can log again', r.statusCode === 201, show(r));

    // Snapshots over two years old are emptied as runs come in — for this
    // company and division only, and never the row itself.
    const mkOld = async (division, auth, years) => {
      const id = (await run(auth, { report_name: `Old ${division} ${years}y`, definition: DEF({ title: 'Old snapshot' }) }, division)).body.run.id;
      await client.query(`UPDATE custom_report_runs SET created_at = NOW() - make_interval(days => $2) WHERE id = $1`, [id, Math.round(years * 365)]);
      return id;
    };
    const oldPav  = await mkOld('paving', BOB, 3);
    const newPav  = await mkOld('paving', BOB, 1);
    const oldTurf = await mkOld('turf', BOSS, 3);
    const oldRiv  = await mkOld('paving', RIVAL, 3);
    r = await run(BOB, { report_name: 'Triggers the prune' });
    assert('a new run still logs (201)', r.statusCode === 201, show(r));
    const snap = async id => (await dbRun(id)).definition;
    assert('a paving snapshot three years old is emptied, its row kept',
      JSON.stringify(await snap(oldPav)) === '{}' && (await dbRun(oldPav)).report_name === 'Old paving 3y');
    assert('…one a year old is kept', (await snap(newPav)).title === 'Old snapshot');
    assert('…as are another division\'s and another company\'s', (await snap(oldTurf)).title === 'Old snapshot'
      && (await snap(oldRiv)).title === 'Old snapshot');
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
      // v2: a saved custom report can be scheduled — through Custom Reporting's
      // own schedule dialog (api/custom-report-schedules.js), customer-safe only.
      const sched = catalog.SCHEDULABLE[type];
      assert('…and one a schedule can send, as a custom report of that division',
        sched && sched.customReport === true && sched.division === division && sched.scope === 'custom', JSON.stringify(sched));
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
  console.log('\nAn emailed custom report goes out as typed and logs itself');
  {
    const vm = require('vm');
    const ectx = vm.createContext({});
    ectx.window = ectx;
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'custom-reports-engine.js'), 'utf8'), ectx);
    const E = ectx.FCTReportEngine;
    const job = { id: 'm1', 'project-name': 'Route 30 Resurfacing', client: 'Acme Township', bidItems: [],
      dailyRows: [{ date: '2026-11-02', cost_code: 'Paving', sub_code: 'Base', quantity: '10', labor_hours: '8', rate: '40', employee: 'Pat' }] };
    const htmlFor = internal => {
      const def = E.normalizeDefinition({ title: 'Weekly', includeInternal: internal, sections: [Object.assign(E.newSection('daily_production'),
        { columns: internal ? ['date', 'quantity', 'employee', 'rate'] : ['date', 'quantity'] })] });
      return E.buildReportHtml(def, E.makeContext(def, { getProjects: () => [job], perm: {} }, { pickedIds: ['m1'], today: '2026-11-05' }));
    };
    const internalHtml = htmlFor(true), safeHtml = htmlFor(false);
    assert('the engine marks an internal report data-cr-internal, and only an internal one',
      /data-cr-internal="1"/.test(internalHtml) && !/data-cr-internal/.test(safeHtml));

    const rep = (await create(ALICE, { name: 'Emailed one' })).body.report;
    const send = (body, auth = ALICE) => call('POST', {}, {
      report_type: 'paving_custom_report', recipients: ['Owner@Example.com', 'gc@example.com'],
      subject: 'Acme Township: weekly progress', project_name: null, attach_pdf: false, html: safeHtml, ...body,
    }, auth, { h: sendReport });
    const runsNamed = async name => (await client.query(
      "SELECT *, to_char(date_from, 'YYYY-MM-DD') AS df FROM custom_report_runs WHERE company_code = $1 AND report_name = $2 ORDER BY id", [CO, name])).rows;

    RESEND.sent = [];
    let r = await send({ html: internalHtml, custom_report: {
      report_id: rep.id, report_name: 'Emailed one', project_ids: ['m1'], project_names: ['Route 30 Resurfacing'],
      date_from: '2026-11-02', date_to: '2026-11-08', included_internal: false, definition: DEF({ title: 'Emailed snapshot' }) } });
    assert('the send answers 200, logged by the server', r.statusCode === 200 && r.body.ok && r.body.logged === true && r.body.run_id, show(r));
    assert('the subject the user typed is the one that went out, and the one returned',
      RESEND.sent.length === 1 && RESEND.sent[0].subject === 'Acme Township: weekly progress' && r.body.subject === 'Acme Township: weekly progress',
      `${RESEND.sent[0] && RESEND.sent[0].subject} / ${r.body.subject}`);
    let rows = await runsNamed('Emailed one');
    assert('exactly one history row, an email, against the report',
      rows.length === 1 && rows[0].action === 'email' && Number(rows[0].report_id) === rep.id && Number(rows[0].id) === Number(r.body.run_id), rows.length);
    assert('…with the recipients as sent, the subject as sent, the jobs and the dates',
      rows[0] && JSON.stringify(rows[0].recipients) === '["owner@example.com","gc@example.com"]'
        && rows[0].subject === 'Acme Township: weekly progress' && JSON.stringify(rows[0].project_names) === '["Route 30 Resurfacing"]'
        && rows[0].df === '2026-11-02' && rows[0].definition.title === 'Emailed snapshot' && rows[0].run_by_user_id === ALICE.userId, JSON.stringify(rows[0]));
    assert('…marked internal off the HTML, though the browser said customer-safe', rows[0] && rows[0].included_internal === true);
    assert('the report\'s run count moves', (await dbRow(rep.id)).run_count === 1);

    r = await send({ custom_report: { report_name: 'Emailed safe', included_internal: false } });
    rows = await runsNamed('Emailed safe');
    assert('a customer-safe email is logged customer-safe', r.statusCode === 200 && rows.length === 1 && rows[0].included_internal === false, show(r));

    r = await send({ subject: '', custom_report: { report_name: 'Emailed blank subject' } });
    rows = await runsNamed('Emailed blank subject');
    assert('an empty subject goes out as the label, and that is what is returned and logged',
      r.body.subject === 'Custom Report — Paving' && RESEND.sent[RESEND.sent.length - 1].subject === 'Custom Report — Paving'
        && rows[0] && rows[0].subject === 'Custom Report — Paving', `${r.body.subject} / ${rows[0] && rows[0].subject}`);

    r = await send({ custom_report: { report_name: 'Emailed too many', project_ids: Array.from({ length: 501 }, (_, i) => 'p' + i) } });
    rows = await runsNamed('Emailed too many');
    assert('a description that will not store still logs the email, without it',
      r.statusCode === 200 && r.body.logged === true && rows.length === 1 && rows[0].project_ids.length === 0, show(r));

    r = await send({ custom_report: undefined });
    rows = await runsNamed('Custom Report — Paving');
    assert('a send with no description at all is logged under the report\'s label', r.body.logged === true && rows.length === 1, show(r));

    DB.failRunInsert = true;
    r = await send({ custom_report: { report_name: 'Emailed DB down' } });
    DB.failRunInsert = false;
    assert('when the history cannot be written the email still went: 200, logged false',
      r.statusCode === 200 && r.body.ok === true && r.body.logged === false && (await runsNamed('Emailed DB down')).length === 0, show(r));

    r = await call('POST', {}, { report_type: 'paving_daily_pm', recipients: ['a@example.com'], subject: 'PM', attach_pdf: false,
      html: '<p>x</p>' }, BOSS, { h: sendReport });
    assert('other report types are not logged here (no logged key), but do return the subject',
      r.statusCode === 200 && !('logged' in r.body) && r.body.subject === 'PM', show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe Email modal tells Custom Reporting what was sent (onSent)');
  {
    const { JSDOM } = require('jsdom');
    const src = fs.readFileSync(path.join(ROOT, 'report-email.js'), 'utf8');
    const tick = () => new Promise(r => setTimeout(r, 10));
    async function sendWith({ reply, onSent, status = 200, closeMidSend = false, text, customReport }) {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const w = dom.window;
      w.localStorage.setItem('fct_token', 'test-token');
      w.localStorage.setItem('fct_user', JSON.stringify({ role: 'level1' }));
      const posts = [];
      w.fetch = async (url, opts = {}) => {
        if (String(url).startsWith('/api/email/send-report')) {
          posts.push(JSON.parse(opts.body));
          if (closeMidSend) await new Promise(r => setTimeout(r, 50));
          // A platform error page is text, not JSON.
          if (text !== undefined) return { ok: false, status, text: async () => text, json: async () => JSON.parse(text) };
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
      if (customReport !== undefined) opts.customReport = customReport;
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

    calls = [];
    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true, subject: 'Custom Report — Paving', logged: true, run_id: 41 },
      onSent: info => calls.push(info), customReport: { report_id: 9, report_name: 'Weekly', project_ids: ['p1'] } });
    assert('onSent records the subject the server says it sent, not just what was typed',
      calls.length === 1 && calls[0].subject === 'Custom Report — Paving', JSON.stringify(calls[0]));
    assert('…and whether the server logged the send itself (with its run id)',
      calls[0] && calls[0].logged === true && calls[0].runId === 41, JSON.stringify(calls[0]));
    assert('customReport rides along to send-report as custom_report',
      m.posts[0] && m.posts[0].custom_report && m.posts[0].custom_report.report_id === 9
        && JSON.stringify(m.posts[0].custom_report.project_ids) === '["p1"]', JSON.stringify(m.posts[0] && m.posts[0].custom_report));
    calls = [];
    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true }, onSent: info => calls.push(info) });
    assert('an older server that returns no subject: onSent falls back to the typed one, logged false',
      calls[0] && calls[0].subject === 'Weekly — 2 jobs' && calls[0].logged === false && !('custom_report' in m.posts[0]), JSON.stringify(calls[0]));

    calls = [];
    m = await sendWith({ text: 'Request Entity Too Large\nFUNCTION_PAYLOAD_TOO_LARGE', status: 413, onSent: info => calls.push(info) });
    assert('a plain-text 413 from the host reads as "too large to email", not a JSON parse error',
      /Send failed: The report is too large to email/.test(m.status) && !/Unexpected token|JSON/.test(m.status) && calls.length === 0, m.status);
    m = await sendWith({ reply: { ok: false, error: 'Report HTML is too large' }, status: 413 });
    assert('…and so does send-report\'s own 413, with what to do about it',
      /Send failed: The report is too large to email — narrow the date range, pick fewer jobs/.test(m.status), m.status);
    m = await sendWith({ text: '<html>Gateway Timeout</html>', status: 504 });
    assert('another non-JSON failure says its HTTP status', /Send failed: HTTP 504/.test(m.status) && m.sendDisabled === false, m.status);

    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true } });
    assert('without onSent the modal sends exactly as it always has', /^Sent to 2 recipients\. PDF attached/.test(m.status) && m.posts.length === 1, m.status);
    m = await sendWith({ reply: { ok: true, recipientCount: 2, pdfAttached: true }, onSent: 'not a function' });
    assert('an onSent that is not a function is ignored', /^Sent to 2 recipients/.test(m.status), m.status);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nDefinitions v1 and v2: a stale builder cannot strip a v2 report');
  {
    const V2 = (over = {}) => ({ ...DEF(), v: 2, filters: { costCodes: [], subCodes: ['Turf Install'] },
      header: { ...DEF().header, branding: 'company', showPmContact: true, contactName: 'Pat', contactPhone: '', contactEmail: '' }, ...over });
    let r = await create(ALICE, { name: 'Born v2', definition: V2() });
    const born = r.body.report;
    assert('a v2 report saves, every v2 field kept', r.statusCode === 201 && born.definition.v === 2
      && born.definition.filters.subCodes[0] === 'Turf Install' && born.definition.header.showPmContact === true, show(r));
    r = await put(ALICE, born.id, { definition: DEF({ title: 'v1 over v2' }), version: 1 });
    assert('a v1 save over it → 409 client_outdated, with a message to reload',
      r.statusCode === 409 && r.body.error === 'client_outdated' && /reload/i.test(r.body.message), show(r));
    let row = await dbRow(born.id);
    assert('…and nothing changed: still v2, still version 1, filters intact',
      row.version === 1 && row.definition.v === 2 && row.definition.filters.subCodes[0] === 'Turf Install');
    r = await put(ALICE, born.id, { definition: DEF(), version: 7 });
    assert('a v1 save from a stale version is told client_outdated too (reloading answers both)',
      r.statusCode === 409 && r.body.error === 'client_outdated', show(r));
    r = await put(ALICE, born.id, { name: 'Born v2 renamed', version: 1 });
    assert('a save with no definition (a rename) goes through and keeps the v2 definition',
      r.statusCode === 200 && r.body.report.name === 'Born v2 renamed' && r.body.report.definition.v === 2, show(r));
    r = await put(ALICE, born.id, { definition: V2({ title: 'v2 again' }), version: 2 });
    assert('a v2 save over a v2 report goes through', r.statusCode === 200 && r.body.report.definition.title === 'v2 again', show(r));
    const old = (await create(ALICE, { name: 'Born v1' })).body.report;
    r = await put(ALICE, old.id, { definition: V2({ title: 'Upgraded' }), version: 1 });
    assert('a v2 save over a v1 report upgrades it', r.statusCode === 200 && r.body.report.definition.v === 2, show(r));
    r = await put(ALICE, (await create(ALICE, { name: 'Still v1' })).body.report.id, { definition: DEF({ title: 'v1 on v1' }), version: 1 });
    assert('a v1 save over a v1 report is as it always was', r.statusCode === 200 && r.body.report.definition.v === 1, show(r));
    r = await create(ALICE, { name: 'v2 internal', definition: V2({ includeInternal: true, jobs: { mode: 'saved', ids: ['j1'] } }) });
    assert('kind and customer_safe come from a v2 definition the same way', r.body.report.customer_safe === false && r.body.report.kind === 'report', show(r));
    r = await run(ALICE, { definition: V2(), report_name: 'v2 run' });
    assert('a v2 snapshot logs', r.statusCode === 201 && (await dbRun(r.body.run.id)).definition.v === 2, show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nCustomer history: a job\'s runs, one run, and what it emailed');
  const lib = require(path.join(ROOT, 'api/lib/custom-report-runs.js'));
  const sqlT = makeSql(client);
  const H1  = await mk('hist1', { paving: 'level1', turf: 'level1' });
  const H2  = await mk('hist2', { paving: 'level1' });
  const HL2 = await mk('histl2', { paving: 'level2' });
  const HL3 = await mk('histl3', { paving: 'level3' });
  const HA  = await mk('histadmin', { paving: 'admin', turf: 'admin' });
  const runsQ = (q, auth, division = 'paving') => call('GET', { division, runs: '1', ...q }, null, auth);
  const oneRun = (id, auth, extra = {}, division = 'paving') => call('GET', { division, run: String(id), ...extra }, null, auth);
  const logRun = async (auth, body, division = 'paving') => {
    const r = await run(auth, body, division);
    if (r.statusCode !== 201) throw new Error('could not log a run: ' + show(r));
    return r.body.run;
  };
  const idsOf = r => (r.body && Array.isArray(r.body.runs) ? r.body.runs.map(x => x.id) : []);
  let safeA, intA, printA, safeB, noJobs, turfA, rivalA, nearA;
  {
    safeA  = await logRun(H1, { action: 'email', report_name: 'Hist safe A', project_ids: ['job-A'], project_names: ['Maple Ave'], recipients: ['owner@example.com'], subject: 'Maple weekly' });
    intA   = await logRun(H1, { action: 'email', report_name: 'Hist internal A', project_ids: ['job-A', 'job-B'], project_names: ['Maple Ave', 'Oak St'], included_internal: true, recipients: ['boss@example.com'] });
    printA = await logRun(H2, { action: 'print', report_name: 'Hist print A', project_ids: ['job-A'] });
    safeB  = await logRun(H2, { action: 'email', report_name: 'Hist safe B', project_ids: ['job-B'], recipients: ['gc@example.com'] });
    noJobs = await logRun(H1, { action: 'email', report_name: 'Hist no jobs', project_ids: [], recipients: ['x@example.com'] });
    turfA  = await logRun(HA, { action: 'email', report_name: 'Hist turf A', project_ids: ['job-A'] }, 'turf');
    rivalA = await logRun(RIVAL, { action: 'email', report_name: 'Hist rival A', project_ids: ['job-A'] });
    nearA  = await logRun(H2, { action: 'email', report_name: 'Hist near A', project_ids: ['job-A1'] });

    let r = await runsQ({ project_id: 'job-A' }, H2);
    const got = idsOf(r);
    assert('a level1 user sees EVERY run for a job — colleagues\' too — in its history',
      r.statusCode === 200 && [safeA.id, intA.id, printA.id].every(id => got.includes(id)), show(r));
    assert('…and nothing else: not another job, not job-A1, not turf\'s, not another company\'s, not a run about no job',
      ![safeB.id, nearA.id, turfA.id, rivalA.id, noJobs.id].some(id => got.includes(id)), got.join(','));
    const rowA = r.body.runs.find(x => x.id === safeA.id);
    assert('…each row saying how it started, which schedule and resend, and whether it was archived',
      rowA && rowA.run_kind === 'user' && rowA.schedule_id === null && rowA.resent_from_run_id === null && rowA.has_archive === false
        && !('definition' in rowA), JSON.stringify(rowA));
    for (const [who, auth] of [['a level2', HL2], ['a level3', HL3], ['an admin', HA]]) {
      r = await runsQ({ project_id: 'job-A' }, auth);
      assert(`…and so does ${who}, the same runs`, JSON.stringify(idsOf(r).filter(id => [safeA.id, intA.id, printA.id].includes(id)).sort())
        === JSON.stringify([safeA.id, intA.id, printA.id].sort()) && !idsOf(r).includes(safeB.id), show(r));
    }
    r = await runsQ({}, H2);
    assert('without project_id a level1 user\'s history is still their own runs only',
      idsOf(r).includes(printA.id) && !idsOf(r).includes(safeA.id) && r.body.runs.every(x => x.run_by_user_id === H2.userId), idsOf(r).join(','));
    r = await runsQ({ project_id: 'job-A', action: 'email' }, H2);
    assert('?action=email narrows a job\'s history to what was emailed',
      idsOf(r).includes(safeA.id) && idsOf(r).includes(intA.id) && !idsOf(r).includes(printA.id) && r.body.runs.every(x => x.action === 'email'), idsOf(r).join(','));
    r = await runsQ({ project_id: 'job-A', kind: 'resend' }, H2);
    assert('?kind=resend: none yet', r.statusCode === 200 && r.body.runs.length === 0, show(r));
    r = await runsQ({ project_id: 'job-B' }, H1);
    assert('a run about two jobs is in both jobs\' histories', idsOf(r).includes(intA.id) && idsOf(r).includes(safeB.id), idsOf(r).join(','));
    r = await runsQ({ project_id: 'job-A' }, SALES);
    assert('sales is refused a job\'s history (403)', r.statusCode === 403, show(r));
    r = await runsQ({ project_id: 'job-A' }, TURFPM);
    assert('a turf-only user is refused paving\'s (403)', r.statusCode === 403, show(r));
    r = await runsQ({ project_id: 'job-A' }, RIVAL);
    assert('another company\'s admin sees only their own company\'s job-A runs', JSON.stringify(idsOf(r)) === JSON.stringify([rivalA.id]), idsOf(r).join(','));
    r = await runsQ({ project_id: 'job-A' }, HA, 'turf');
    assert('turf\'s job-A history is turf\'s run only', JSON.stringify(idsOf(r)) === JSON.stringify([turfA.id]), idsOf(r).join(','));
    for (const [q, what] of [[{ action: 'fax' }, 'an unknown action'], [{ kind: 'bogus' }, 'an unknown kind'],
      [{ before_id: 'abc' }, 'a junk before_id'], [{ before_id: '0' }, 'before_id 0'],
      [{ project_id: 'x'.repeat(121) }, 'a 121-character project_id'], [{ project_id: ['a', 'b'] }, 'project_id given twice']]) {
      r = await runsQ(q, H2);
      assert(`${what} → 400`, r.statusCode === 400, show(r));
    }

    // Paging: 230 runs on one job, three to a timestamp, so the cursor has to
    // break ties on id to neither skip nor repeat one.
    await client.query(`
      INSERT INTO custom_report_runs (company_code, division, report_name, action, project_ids, run_by_user_id, run_by_username, created_at)
      SELECT $1, 'paving', 'Page ' || g, 'email', '["job-P"]'::jsonb, $2, 'hist1', TIMESTAMPTZ '2026-01-01' + make_interval(mins => g / 3)
        FROM generate_series(1, 230) g`, [CO, H1.userId]);
    const pages = [];
    let cursor;
    for (let i = 0; i < 5; i++) {
      r = await runsQ(cursor ? { project_id: 'job-P', before_id: String(cursor) } : { project_id: 'job-P' }, H2);
      pages.push(r.body.runs);
      cursor = r.body.next_before_id;
      if (!cursor) break;
    }
    const flat = pages.flat();
    const sorted = flat.every((x, i) => i === 0 || (() => {
      const a = flat[i - 1], ta = new Date(a.created_at).getTime(), tb = new Date(x.created_at).getTime();
      return ta > tb || (ta === tb && a.id > x.id);
    })());
    assert('a job\'s history pages 100, 100, 30 and then says there is no more',
      pages.map(p => p.length).join(',') === '100,100,30' && cursor === null, pages.map(p => p.length).join(','));
    assert('…every run exactly once, newest first, ties broken by id', new Set(flat.map(x => x.id)).size === 230 && sorted);
    r = await runsQ({ project_id: 'job-P', before_id: String(rivalA.id) }, H2);
    assert('a cursor from another company returns nothing rather than another company\'s place', r.statusCode === 200 && r.body.runs.length === 0, show(r));

    await client.query('SET enable_seqscan = off');
    const plan = (await client.query(
      "EXPLAIN SELECT id FROM custom_report_runs WHERE project_ids @> jsonb_build_array('job-A'::text)")).rows.map(x => x['QUERY PLAN']).join('\n');
    await client.query('RESET enable_seqscan');
    assert('the job filter can use the GIN index on project_ids', /idx_custom_report_runs_projects/.test(plan), plan);

    // One run.
    r = await oneRun(safeA.id, H2);
    assert('one run of a job, for a level1 user who did not send it: 200 with its definition and recipients',
      r.statusCode === 200 && r.body.run.id === safeA.id && r.body.run.definition && Array.isArray(r.body.run.definition.sections)
        && JSON.stringify(r.body.run.recipients) === '["owner@example.com"]' && r.body.run.has_archive === false
        && r.body.run.run_kind === 'user' && r.body.run.subject === 'Maple weekly', show(r));
    for (const [who, auth, want] of [['its sender', H1, 200], ['another level1', H2, 404], ['a level2', HL2, 404],
      ['a level3', HL3, 200], ['an admin', HA, 200]]) {
      r = await oneRun(noJobs.id, auth);
      assert(`a run about no job, asked for by ${who} → ${want}`, r.statusCode === want, show(r));
    }
    r = await oneRun(safeA.id, RIVAL);
    assert('another company asking for this company\'s run → 404', r.statusCode === 404, show(r));
    r = await oneRun(safeA.id, HA, {}, 'turf');
    assert('asked for through another division → 404', r.statusCode === 404, show(r));
    r = await oneRun('abc', H2);
    assert('a junk run id → 400', r.statusCode === 400, show(r));
    r = await oneRun(987654321, H2);
    assert('a run that does not exist → 404', r.statusCode === 404 && r.body.error === 'Run not found', show(r));
    r = await oneRun(safeA.id, SALES);
    assert('sales → 403', r.statusCode === 403, show(r));

    // The archive.
    const htmlA = '<!doctype html><html><body><h1>Maple Ave — 1,234 SY · é ✓ 漢字 😀</h1>' + '<p>row</p>'.repeat(20000) + '</body></html>';
    assert('insertArchive keeps an emailed run\'s HTML', await lib.insertArchive(sqlT, { runId: safeA.id, company: CO, html: htmlA }) === true);
    assert('…once: a second archive for the same run is not written', await lib.insertArchive(sqlT, { runId: safeA.id, company: CO, html: '<p>other</p>' }) === false);
    const arow = (await client.query('SELECT * FROM custom_report_run_archives WHERE run_id = $1', [safeA.id])).rows[0];
    const gzBuf = Buffer.from(arow.html_gzip_b64, 'base64');
    assert('…gzipped (1f 8b) and base64, much smaller than the page, with its byte count',
      gzBuf[0] === 0x1f && gzBuf[1] === 0x8b && arow.html_gzip_b64.length < Buffer.byteLength(htmlA) / 10
        && arow.html_bytes === Buffer.byteLength(htmlA, 'utf8') && arow.company_code === CO,
      `${arow.html_gzip_b64.length} vs ${Buffer.byteLength(htmlA)} / ${arow.html_bytes}`);
    assert('…and it gunzips to the exact HTML', require('zlib').gunzipSync(gzBuf).toString('utf8') === htmlA);
    assert('insertArchive will not file HTML under another company\'s run', await lib.insertArchive(sqlT, { runId: rivalA.id, company: CO, html: '<p>x</p>' }) === false
      && (await client.query('SELECT count(*)::int AS n FROM custom_report_run_archives WHERE run_id = $1', [rivalA.id])).rows[0].n === 0);
    assert('…nor archive nothing, nor a junk run id, nor more than 4 MB',
      await lib.insertArchive(sqlT, { runId: printA.id, company: CO, html: '' }) === false
        && await lib.insertArchive(sqlT, { runId: 'abc', company: CO, html: '<p>x</p>' }) === false
        && await lib.insertArchive(sqlT, { runId: printA.id, company: CO, html: 'x'.repeat(4 * 1024 * 1024 + 1) }) === false);
    assert('readArchive answers only for the run\'s own company', await lib.readArchive(sqlT, { runId: safeA.id, company: CO2 }) === null
      && await lib.readArchive(sqlT, { runId: safeA.id, company: CO }) === htmlA);

    r = await oneRun(safeA.id, H2, { archive: '1' });
    assert('a level1 user opens a customer-safe run\'s archive: exactly the HTML that was kept',
      r.statusCode === 200 && r.body.html === htmlA, `${r.statusCode} ${r.body && r.body.error} ${r.body && r.body.html && r.body.html.length}`);
    r = await runsQ({ project_id: 'job-A' }, H2);
    assert('…and the history says it has one', r.body.runs.find(x => x.id === safeA.id).has_archive === true
      && r.body.runs.find(x => x.id === printA.id).has_archive === false);
    r = await oneRun(safeA.id, H2);
    assert('…and so does the run itself', r.body.run.has_archive === true);

    await lib.insertArchive(sqlT, { runId: intA.id, company: CO, html: '<p>Our cost: $91,000</p>' });
    for (const [who, auth, want] of [['another level1', H2, 403], ['a level2', HL2, 403], ['its sender (a level1)', H1, 200],
      ['a level3', HL3, 200], ['an admin', HA, 200]]) {
      r = await oneRun(intA.id, auth, { archive: '1' });
      assert(`an INTERNAL run's archive, asked for by ${who} → ${want}${want === 403 ? ' internal_archive' : ''}`,
        r.statusCode === want && (want === 403 ? r.body.error === 'internal_archive' && !('html' in r.body) : r.body.html === '<p>Our cost: $91,000</p>'), show(r));
    }
    const intNoArch = await logRun(H1, { action: 'email', report_name: 'Hist internal, no archive', project_ids: ['job-A'], included_internal: true });
    r = await oneRun(intNoArch.id, H2, { archive: '1' });
    assert('an internal run with NO archive is still 403 for them — the answer never depends on whether one was kept',
      r.statusCode === 403 && r.body.error === 'internal_archive', show(r));
    r = await oneRun(intNoArch.id, H1, { archive: '1' });
    assert('…and 404 no_archive for its sender', r.statusCode === 404 && r.body.error === 'no_archive', show(r));
    r = await oneRun(safeB.id, H1, { archive: '1' });
    assert('a customer-safe run never archived → 404 no_archive (the page rebuilds it instead)', r.statusCode === 404 && r.body.error === 'no_archive', show(r));
    r = await oneRun(noJobs.id, H2, { archive: '1' });
    assert('the archive of a run they cannot see → 404 Run not found', r.statusCode === 404 && r.body.error === 'Run not found', show(r));
    r = await oneRun(rivalA.id, H2, { archive: '1' });
    assert('…nor another company\'s', r.statusCode === 404, show(r));

    // Archives two years old go as runs come in — this company's only.
    await lib.insertArchive(sqlT, { runId: printA.id, company: CO, html: '<p>old</p>' });
    await lib.insertArchive(sqlT, { runId: safeB.id, company: CO, html: '<p>newer</p>' });
    await lib.insertArchive(sqlT, { runId: rivalA.id, company: CO2, html: '<p>rival</p>' });
    await client.query("UPDATE custom_report_run_archives SET created_at = NOW() - interval '731 days' WHERE run_id = ANY($1::bigint[])", [[printA.id, rivalA.id]]);
    await client.query("UPDATE custom_report_run_archives SET created_at = NOW() - interval '729 days' WHERE run_id = $1", [safeB.id]);
    r = await run(H2, { report_name: 'Prune trigger' });
    const left = (await client.query('SELECT run_id FROM custom_report_run_archives WHERE run_id = ANY($1::bigint[])',
      [[printA.id, safeB.id, rivalA.id, safeA.id]])).rows.map(x => Number(x.run_id));
    assert('logging a run deletes this company\'s archives over two years old, and only those',
      r.statusCode === 201 && !left.includes(printA.id) && left.includes(safeB.id) && left.includes(rivalA.id) && left.includes(safeA.id), left.join(','));
    await client.query('DELETE FROM custom_report_run_archives WHERE run_id = ANY($1::bigint[])', [[safeB.id, printA.id]]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nResends, and the kinds only the schedule runner may claim');
  {
    const resend = async (auth, from, extra = {}, division = 'paving') => (await run(auth, {
      action: 'email', report_name: 'Resend', run_kind: 'resend', resent_from_run_id: from, project_ids: ['job-A'], ...extra,
    }, division)).body.run;
    let x = await resend(H2, safeA.id);
    assert('a level1 user resending a colleague\'s email to a job: logged as a resend of it',
      x.run_kind === 'resend' && x.resent_from_run_id === safeA.id, JSON.stringify(x));
    x = await resend(H2, noJobs.id);
    assert('…of a run they could not open: still a resend, the reference dropped', x.run_kind === 'resend' && x.resent_from_run_id === null, JSON.stringify(x));
    x = await resend(H1, noJobs.id);
    assert('…of their own run about no job: kept', x.resent_from_run_id === noJobs.id, JSON.stringify(x));
    x = await resend(HA, noJobs.id);
    assert('…by an admin, who can see every run: kept', x.resent_from_run_id === noJobs.id, JSON.stringify(x));
    x = await resend(H2, turfA.id);
    assert('…of another division\'s run: dropped', x.resent_from_run_id === null, JSON.stringify(x));
    x = await resend(H2, rivalA.id);
    assert('…of another company\'s run: dropped', x.resent_from_run_id === null, JSON.stringify(x));
    x = await resend(H2, 987654321);
    assert('…of a run that does not exist: dropped', x.resent_from_run_id === null, JSON.stringify(x));
    x = await resend(H2, 'abc');
    assert('…of junk: dropped', x.resent_from_run_id === null && x.run_kind === 'resend', JSON.stringify(x));
    x = await resend(H2, safeA.id, { run_kind: 'user' });
    assert('a user run carrying a resent_from_run_id does not keep it', x.run_kind === 'user' && x.resent_from_run_id === null, JSON.stringify(x));
    x = await resend(H2, null, { run_kind: 'schedule', schedule_id: 12 });
    assert('a browser claiming a scheduled run is logged as a user run, without the schedule', x.run_kind === 'user' && x.schedule_id === null, JSON.stringify(x));
    x = await resend(H2, null, { run_kind: 'send_now', schedule_id: 12 });
    assert('…and so is send_now', x.run_kind === 'user' && x.schedule_id === null, JSON.stringify(x));
    x = await resend(H2, null, { run_kind: 'bogus' });
    assert('…and junk', x.run_kind === 'user', JSON.stringify(x));
    let r = await runsQ({ project_id: 'job-A', kind: 'resend' }, HL2);
    assert('?kind=resend lists the job\'s resends', r.body.runs.length >= 6 && r.body.runs.every(y => y.run_kind === 'resend'), show(r));

    // The schedule runner's path: readRun with every kind allowed, then insertRun.
    const rr = lib.readRun({ action: 'email', report_name: 'Weekly (scheduled)', run_kind: 'schedule', schedule_id: 77,
      project_ids: ['job-A'], recipients: Array.from({ length: 120 }, (_, i) => `s${i}@example.com`), included_internal: false,
      definition: DEF() }, { kinds: lib.RUN_KINDS });
    assert('readRun with the runner\'s kinds keeps schedule and schedule_id', !rr.error && rr.value.runKind === 'schedule' && rr.value.scheduleId === 77, JSON.stringify(rr));
    let ins = await lib.insertRun(sqlT, { company: CO, division: 'paving', me: { userId: HL3.userId, username: 'histl3' }, run: rr.value });
    assert('…and insertRun writes it as a scheduled run of that schedule, all 120 recipients named',
      ins.run_kind === 'schedule' && ins.schedule_id === 77 && ins.recipients.length === 120 && ins.resent_from_run_id === null, JSON.stringify(ins).slice(0, 300));
    const sn = lib.readRun({ action: 'email', report_name: 'Send now', run_kind: 'send_now', schedule_id: '78' }, { kinds: lib.RUN_KINDS });
    ins = await lib.insertRun(sqlT, { company: CO, division: 'paving', me: { userId: HL3.userId, username: 'histl3' }, run: sn.value });
    assert('…send_now too', ins.run_kind === 'send_now' && ins.schedule_id === 78, JSON.stringify(ins));
    ins = await lib.insertRun(sqlT, { company: CO, division: 'paving', me: { userId: HL3.userId, username: 'histl3' },
      run: { action: 'email', reportName: 'Hand-built', projectIds: ['job-A'], recipients: ['a@example.com'], includedInternal: false } });
    assert('a run object built by hand (no kind, no dates, no definition) is a plain user run',
      ins.run_kind === 'user' && ins.schedule_id === null && ins.report_name === 'Hand-built' && ins.date_from === null, JSON.stringify(ins));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nsend-report v2: the archive, resends and the company\'s name');
  {
    const { sanitizeReportHtml } = require(path.join(ROOT, 'api/lib/email.js'));
    const dirty = '<!doctype html><html><head><style>.t{color:red}</style></head><body>'
      + '<div class="masthead" data-dw-brand>Acme</div><p>Maple Ave — 1,234 SY</p>'
      + '<script>alert(1)</script><p onclick="steal()">Totals</p><a href="javascript:alert(2)">x</a></body></html>';
    const send = (body, auth = H2) => call('POST', {}, {
      report_type: 'paving_custom_report', recipients: ['owner@example.com'], subject: 'Maple weekly',
      attach_pdf: false, html: dirty, ...body,
    }, auth, { h: sendReport });
    const archiveOf = async id => {
      const a = (await client.query('SELECT html_gzip_b64 FROM custom_report_run_archives WHERE run_id = $1', [id])).rows[0];
      return a ? require('zlib').gunzipSync(Buffer.from(a.html_gzip_b64, 'base64')).toString('utf8') : null;
    };

    RESEND.sent = [];
    let r = await send({ custom_report: { report_name: 'Archived one', project_ids: ['job-A'], project_names: ['Maple Ave'] } });
    const kept = r.body && r.body.run_id ? await archiveOf(r.body.run_id) : null;
    assert('a logged custom-report email answers archived: true', r.statusCode === 200 && r.body.logged === true && r.body.archived === true, show(r));
    assert('…and what is kept is the sanitized HTML — no script, no handler, no javascript: link',
      kept === sanitizeReportHtml(dirty) && !/<script|onclick|javascript:/i.test(kept), kept && kept.slice(0, 200));
    assert('…the very document the email carried', RESEND.sent.length === 1 && RESEND.sent[0].html.includes(kept));
    r = await oneRun(r.body.run_id, HL2, { archive: '1' });
    assert('…which Customer History opens for any division user', r.statusCode === 200 && r.body.html === kept, show(r));

    const PIXEL = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200010005fe02fea70000000049454e44ae426082';
    r = await send({ html: dirty.replace('<p>Maple', '<img src="cid:co-logo" alt="logo"><p>Maple'),
      attachments: [{ filename: 'logo.png', contentId: 'co-logo', content: Buffer.from(PIXEL, 'hex').toString('base64') }],
      custom_report: { report_name: 'Archived with an image' } });
    const withImg = await archiveOf(r.body.run_id);
    assert('a cid: image in the report is kept inline in the archive, so it opens on its own',
      r.body.archived === true && withImg.includes('src="data:image/png;base64,' + Buffer.from(PIXEL, 'hex').toString('base64') + '"')
        && !withImg.includes('cid:co-logo'), withImg && withImg.slice(0, 300));

    DB.failArchiveInsert = true;
    r = await send({ custom_report: { report_name: 'Archive down' } });
    DB.failArchiveInsert = false;
    const downRun = r.body && r.body.run_id;
    assert('when the archive cannot be written the email still went and was logged: 200, archived false',
      r.statusCode === 200 && r.body.ok === true && r.body.logged === true && r.body.archived === false && downRun
        && (await archiveOf(downRun)) === null, show(r));
    DB.failRunInsert = true;
    r = await send({ custom_report: { report_name: 'Log down' } });
    DB.failRunInsert = false;
    assert('when the log cannot be written: 200, logged false, archived false', r.statusCode === 200 && r.body.logged === false && r.body.archived === false, show(r));
    r = await call('POST', {}, { report_type: 'paving_daily_pm', recipients: ['a@example.com'], subject: 'PM', attach_pdf: false, html: '<p>x</p>' }, HA, { h: sendReport });
    assert('other report types say nothing about an archive', r.statusCode === 200 && !('archived' in r.body), show(r));

    r = await send({ custom_report: { report_name: 'Resent', project_ids: ['job-A'], run_kind: 'resend', resent_from_run_id: safeA.id } });
    let row = await dbRun(r.body.run_id);
    assert('a resend through the Email modal is logged as a resend of the run it repeated',
      row.run_kind === 'resend' && Number(row.resent_from_run_id) === safeA.id, JSON.stringify({ k: row.run_kind, f: row.resent_from_run_id }));
    r = await send({ custom_report: { report_name: 'Resent unseen', run_kind: 'resend', resent_from_run_id: noJobs.id } });
    row = await dbRun(r.body.run_id);
    assert('…of a run the sender could not open: the reference is dropped', row.run_kind === 'resend' && row.resent_from_run_id === null);
    // A sales login cannot open Custom Reporting, so it has no custom report
    // to send — and nothing it sends lands in a job's customer history, or in
    // an archive an admin there would open.
    const runsBefore = (await client.query('SELECT COUNT(*)::int AS n FROM custom_report_runs WHERE company_code = $1', [CO])).rows[0].n;
    const archBefore = (await client.query('SELECT COUNT(*)::int AS n FROM custom_report_run_archives WHERE company_code = $1', [CO])).rows[0].n;
    const mailsBefore = RESEND.sent.length;
    r = await send({ html: '<p>x</p><img src=x/onerror="alert(1)">',
      custom_report: { report_name: 'Sales resend', project_ids: ['job-A'], run_kind: 'resend', resent_from_run_id: safeA.id } }, SALES);
    const runsAfter = (await client.query('SELECT COUNT(*)::int AS n FROM custom_report_runs WHERE company_code = $1', [CO])).rows[0].n;
    const archAfter = (await client.query('SELECT COUNT(*)::int AS n FROM custom_report_run_archives WHERE company_code = $1', [CO])).rows[0].n;
    assert('…and a sales login (which cannot open Custom Reporting) is refused a custom-report send: 403, nothing mailed, no run, no archive',
      r.statusCode === 403 && /sales login/.test(r.body.error) && RESEND.sent.length === mailsBefore && runsAfter === runsBefore && archAfter === archBefore,
      show(r) + ` runs ${runsBefore}->${runsAfter} archives ${archBefore}->${archAfter}`);
    r = await call('POST', {}, { report_type: 'paving_daily_pm', recipients: ['a@example.com'], subject: 'PM', attach_pdf: false, html: '<p>x</p>' }, SALES, { h: sendReport });
    assert('…while a sales login\'s other paving reports still go (the refusal is custom reports only)', r.statusCode === 200 && r.body.ok === true, show(r));
    r = await send({ custom_report: { report_name: 'Fake schedule', run_kind: 'schedule', schedule_id: 9 } });
    row = await dbRun(r.body.run_id);
    assert('…and a browser cannot log an email as a scheduled send', row.run_kind === 'user' && row.schedule_id === null);

    // The name in the email's header.
    const headerName = () => {
      const html = RESEND.sent[RESEND.sent.length - 1].html;
      const m = /letter-spacing:0\.08em;text-transform:uppercase;font-weight:600;">([^<]*)</.exec(html);
      return m ? m[1] : null;
    };
    const stale = { ...H2, companyName: 'Stale Name Inc' };
    await send({}, stale);
    assert('the email is headed with the company\'s name as it is now, not the sign-in token\'s',
      headerName() === 'Custom Reports test', headerName());
    await client.query("INSERT INTO company_branding (company_code, division, display_name) VALUES ($1, '', 'Acme Paving & Sons')", [CO]);
    await client.query("INSERT INTO company_branding (company_code, division, display_name) VALUES ($1, 'paving', 'Division Override')", [CO]);
    await send({}, stale);
    assert('…its branding display name when it has one (escaped), and the company default row only',
      headerName() === 'Acme Paving &amp; Sons', headerName());
    await call('POST', {}, { report_type: 'paving_daily_pm', recipients: ['a@example.com'], subject: 'PM', attach_pdf: false, html: '<p>x</p>' }, stale, { h: sendReport });
    assert('…on every report type, not only custom reports', headerName() === 'Acme Paving &amp; Sons', headerName());
    await client.query("UPDATE company_branding SET display_name = '   ' WHERE company_code = $1 AND division = ''", [CO]);
    await send({}, stale);
    assert('…a blank display name falls back to the company name', headerName() === 'Custom Reports test', headerName());
    DB.failCompanyName = true;
    r = await send({}, stale);
    DB.failCompanyName = false;
    assert('…and when the database cannot say, the token\'s copy is used and the send still goes',
      r.statusCode === 200 && headerName() === 'Stale Name Inc', `${r.statusCode} ${headerName()}`);
    await client.query('DELETE FROM company_branding WHERE company_code = $1', [CO]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe Email modal: defaultRecipients, contacts, resend and archived');
  {
    const { JSDOM } = require('jsdom');
    const src = fs.readFileSync(path.join(ROOT, 'report-email.js'), 'utf8');
    const tick = () => new Promise(res => setTimeout(res, 10));
    async function modal(opts, { groups = [], gate = null, reply = { ok: true, recipientCount: 1, pdfAttached: true } } = {}) {
      const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const w = dom.window;
      w.localStorage.setItem('fct_token', 'test-token');
      w.localStorage.setItem('fct_user', JSON.stringify({ role: 'level1' }));
      const posts = [], gets = [];
      w.fetch = async (url, o = {}) => {
        if (String(url).startsWith('/api/email/send-report')) { posts.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => reply }; }
        gets.push(String(url));
        if (gate) await gate;
        return { ok: true, status: 200, json: async () => ({ ok: true, isAdmin: false, groups }) };
      };
      w.eval(src);
      w.openReportEmailModal({ reportType: 'paving_custom_report', getHTML: () => '<p>report</p>', ...opts });
      const $ = id => w.document.getElementById(id);
      const chips = () => [...w.document.querySelectorAll('#rem-chips > span')].map(c => ({
        text: c.firstChild ? c.firstChild.textContent.trim() : '', email: c.getAttribute('data-email'), title: c.getAttribute('title'),
        save: Boolean(c.querySelector('.rem-chip-save')),
      }));
      return { w, $, posts, gets, chips, status: () => ($('rem-status') || {}).textContent || '' };
    }
    const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

    let gateOpen;
    let m = await modal({ defaultRecipients: ['A@Example.com', 'b@example.com', 'bad@@example', 'a@example.com'] },
      { gate: new Promise(res => { gateOpen = res; }) });
    assert('defaultRecipients are filled in as the modal opens, before the groups arrive, each once, lower-cased',
      JSON.stringify(m.chips().map(c => c.email)) === '["a@example.com","b@example.com"]', JSON.stringify(m.chips()));
    assert('…and one the send would refuse is left off and named', m.status() === 'Left off bad@@example — not a valid email address.', m.status());
    gateOpen(); await settle(); m.w.close();

    const P1 = { id: 5, name: 'Maple Ave group', project_id: 'P1', report_type: null, emails: ['b@example.com', 'c@example.com'] };
    m = await modal({ projectId: 'P1', defaultRecipients: ['a@example.com', 'b@example.com'] }, { groups: [P1] });
    await settle();
    assert('the job\'s own group still auto-adds on top of them, merged without duplicates',
      JSON.stringify(m.chips().map(c => c.email)) === '["a@example.com","b@example.com","c@example.com"]', JSON.stringify(m.chips()));
    m.w.close();
    m = await modal({ projectId: 'P1' }, { groups: [P1] });
    await settle();
    assert('with nothing filled in, the job\'s group auto-adds as it always has', JSON.stringify(m.chips().map(c => c.email)) === '["b@example.com","c@example.com"]', JSON.stringify(m.chips()));
    m.w.close();
    m = await modal({ projectId: 'P1' }, { groups: [P1], gate: new Promise(res => { gateOpen = res; }) });
    m.$('rem-input').value = 'me@example.com';
    m.$('rem-add').click();
    gateOpen(); await settle();
    assert('…and an address the user typed before the groups arrived still stops it', JSON.stringify(m.chips().map(c => c.email)) === '["me@example.com"]', JSON.stringify(m.chips()));
    m.w.close();

    const contacts = [
      { email: 'Jane@Acme.com', name: 'Jane Smith', source: 'job', label: 'Job contact — Maple Ave' },
      { email: 'gc@example.com', source: 'client' },
      { email: 'nope', name: 'Bad Address', source: 'job' },
      { email: 'jane@acme.com', name: 'Duplicate Jane', source: 'client' },
      { email: 'x@example.com', name: '<img src=x onerror=alert(1)>', label: '"><b>bold</b>' },
    ];
    m = await modal({ contacts, defaultRecipients: ['jane@acme.com'] });
    await settle();
    const ch = m.chips();
    assert('saved contacts are filled in, each address once (one already in defaultRecipients included)',
      JSON.stringify(ch.map(c => c.email)) === '["jane@acme.com","gc@example.com","x@example.com"]', JSON.stringify(ch));
    assert('…a contact\'s chip shows the name, its tooltip the label, the address beside it',
      ch[0].text === 'Jane Smith' && ch[0].title === 'Job contact — Maple Ave'
        && m.w.document.querySelector('#rem-chips .rem-chip-addr').textContent === 'jane@acme.com', JSON.stringify(ch[0]));
    assert('…with no name it shows the address, and the tooltip says where it comes from', ch[1].text === 'gc@example.com' && ch[1].title === 'Client contact', JSON.stringify(ch[1]));
    assert('…a name and label are text, never markup', ch[2].text === '<img src=x onerror=alert(1)>' && ch[2].title === '"><b>bold</b>'
      && !m.w.document.querySelector('#rem-chips img') && !m.w.document.querySelector('#rem-chips b'), m.w.document.getElementById('rem-chips').innerHTML.slice(0, 300));
    assert('…and a contact whose address the send would refuse is left off, said so', m.status() === 'Left off nope — not a valid email address. Fix it in Contacts.', m.status());
    assert('with no contactContext there is no "Save as contact"', ch.every(c => !c.save));
    m.w.document.querySelector('#rem-chips .rem-chip-x').click();
    assert('a chip\'s × still removes it', JSON.stringify(m.chips().map(c => c.email)) === '["gc@example.com","x@example.com"]', JSON.stringify(m.chips()));
    m.w.close();

    m = await modal({ contacts: contacts.slice(0, 1), defaultRecipients: ['typed@example.com'],
      contactContext: { division: 'paving', projectIds: ['P1'], clients: [], canEdit: false } });
    assert('contactContext without canEdit offers no "Save as contact"', m.chips().every(c => !c.save), JSON.stringify(m.chips()));
    m.w.close();
    m = await modal({ contacts: contacts.slice(0, 1), defaultRecipients: ['typed@example.com'],
      contactContext: { division: 'paving', projectIds: ['P1'], clients: [], canEdit: true } });
    assert('…with canEdit, every address that is not a saved contact offers it, and the contact does not',
      JSON.stringify(m.chips().map(c => [c.email, c.save])) === '[["typed@example.com",true],["jane@acme.com",false]]', JSON.stringify(m.chips()));
    m.w.close();

    const sent = [];
    m = await modal({ defaultRecipients: ['owner@example.com'], defaultSubject: 'Maple weekly',
      customReport: { report_id: 3, report_name: 'Weekly', run_kind: 'resend', resent_from_run_id: 41 }, onSent: info => sent.push(info) },
    { reply: { ok: true, recipientCount: 1, pdfAttached: true, logged: true, run_id: 50, archived: true } });
    m.$('rem-send').click();
    for (let i = 0; i < 50 && !sent.length; i++) await tick();
    assert('a Resend sends straight to the run\'s recipients with its subject, run_kind and resent_from_run_id riding along',
      m.posts[0] && JSON.stringify(m.posts[0].recipients) === '["owner@example.com"]' && m.posts[0].subject === 'Maple weekly'
        && m.posts[0].custom_report.run_kind === 'resend' && m.posts[0].custom_report.resent_from_run_id === 41, JSON.stringify(m.posts[0]));
    assert('onSent is told the server archived it', sent[0] && sent[0].archived === true && sent[0].runId === 50, JSON.stringify(sent[0]));
    m.w.close();
    sent.length = 0;
    m = await modal({ defaultRecipients: ['owner@example.com'], onSent: info => sent.push(info) });
    m.$('rem-send').click();
    for (let i = 0; i < 50 && !sent.length; i++) await tick();
    assert('…and archived: false when the server says nothing of one', sent[0] && sent[0].archived === false, JSON.stringify(sent[0]));
    m.w.close();
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
