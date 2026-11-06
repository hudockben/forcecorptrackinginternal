#!/usr/bin/env node
'use strict';
/**
 * Scheduled custom reports, against a real Postgres — and once in a real
 * headless Chrome against paving.html.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-custom-report-schedules.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test; the
 *       robot section needs Chrome: CHROME_EXECUTABLE_PATH, or Playwright's
 *       Chromium under /opt/pw-browsers — it is skipped, saying so, without)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * as the other *-sql.js suites. The CUSTOM REPORTING V2 statements this suite
 * needs are applied again here, idempotently. Refuses a database whose name
 * does not look like a test database; it creates and removes two companies.
 *
 * What it holds the feature to:
 *   - api/custom-report-schedules.js: sales refused, level1/2 see nothing and
 *     change nothing, admin/level3 do everything; a private report is only
 *     its owner's to schedule; customer-safe only; no fixed dates; the jobs
 *     mode fits the report's kind; recipients from groups, addresses or the
 *     jobs' contacts, capped; the cadence rules; the shared 200 cap; who a
 *     schedule runs as; switching off/on without re-pointing it;
 *   - api/email/report-schedules.js lists custom schedules by name, refuses
 *     to create or edit them, but lets an admin switch one off/on or delete it;
 *   - the runner's custom path: the saved report read again before every run
 *     (deleted, hidden, internal, fixed dates, sales — each a plain message,
 *     nothing built), the definition handed to the page with internal data
 *     off, recipients = groups ∪ addresses ∪ each job's saved contacts, the
 *     engine's internal mark refused before anything is sent, every send in
 *     the report's history (run_kind schedule / send_now) with its HTML
 *     archived, and the report's name on the schedule's own history;
 *   - a report about several customers' jobs never goes to those customers'
 *     contacts (refused when saved, and checked again at send time), and an
 *     item the page built for jobs it was not asked for is not sent at all;
 *   - hand-backs and saves keep a run's progress only for the same report;
 *   - Send now through the new endpoint, end to end;
 *   - one real robot run of a scheduled custom report against paving.html.
 *
 * The runner's own browser is stood in for (outside the robot section) by a
 * page object that runs the real auto-report.js in a vm, with a builder that
 * keeps the pages' contract (spec §7) — so the runner, auto-report.js and the
 * database are all real, and only Chrome and the division page are not.
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const vm     = require('vm');
const zlib   = require('zlib');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'custom-report-schedules-secret';
// api/lib/email.js reads these at load; the Resend SDK is stubbed below.
process.env.RESEND_API_KEY     = process.env.RESEND_API_KEY     || 'test-key';
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'reports@datawatch.test';
process.env.DATABASE_URL       = process.env.DATABASE_URL || URL;
for (const k of ['APP_BASE_URL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_AUTOMATION_BYPASS_SECRET']) delete process.env[k];

const ROOT = path.resolve(__dirname, '..');
const CO  = 'CRSTEST';
const CO2 = 'CRSTEST2';
const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

// ── Stubs: who is asking, the mail service, the runner's own Chrome ────────
const realAuth = require(path.join(ROOT, 'api/lib/auth.js'));
const realPdf  = require(path.join(ROOT, 'api/lib/pdf.js'));
let AUTH = null;
let REAL_AUTH = false;
const SENT = [];
const DB = { failRunInsert: false };
const MAIL = { failAt: 0, tries: 0 };
const FAKE = { browser: null, launched: 0 };

const stubDivision = async (req, res, opts = {}) => {
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
};
const stubAuth = async (req, res) => {
  if (REAL_AUTH) return realAuth.requireAuth(req, res);
  if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return AUTH;
};

const origLoad = Module._load;
Module._load = function (request, parent) {
  const from = parent && parent.filename ? parent.filename : '';
  if (request === '@neondatabase/serverless') {
    return { neon: () => {
      const sql = makeSql(client);
      return (strings, ...values) => {
        if (DB.failRunInsert && strings.join('?').includes('INSERT INTO custom_report_runs')) {
          return Promise.reject(new Error('connection reset'));
        }
        return sql(strings, ...values);
      };
    } };
  }
  if (request === 'resend') {
    return { Resend: class {
      // MAIL.failAt = n: the n-th email of the run is refused, as the mail
      // service does on a bad moment (one batch of a long list, say).
      constructor() { this.emails = { send: async o => {
        if (MAIL.failAt && ++MAIL.tries === MAIL.failAt) return { data: null, error: { message: 'Resend 500: internal error' } };
        SENT.push(o); return { data: { id: 'stub-' + SENT.length }, error: null };
      } }; }
    } };
  }
  if ((request === './lib/auth' && /api[\\/](custom-report-schedules|custom-reports)\.js$/.test(from))
    || (request === '../lib/auth' && /api[\\/]email[\\/]report-schedules\.js$/.test(from))) {
    return { ...realAuth, requireDivision: stubDivision, requireAuth: stubAuth };
  }
  // Send now launches its own Chrome; here it gets the stand-in page.
  if (request === './pdf' && /report-schedule-runner\.js$/.test(from)) {
    return { ...realPdf, launchBrowser: async () => { FAKE.launched++; return FAKE.browser; } };
  }
  return origLoad.apply(this, arguments);
};

const crsHandler = require(path.join(ROOT, 'api/custom-report-schedules.js'));
const arsHandler = require(path.join(ROOT, 'api/email/report-schedules.js'));
const runner     = require(path.join(ROOT, 'api/lib/report-schedule-runner.js'));
const catalog    = require(path.join(ROOT, 'api/lib/report-catalog.js'));
const T          = require(path.join(ROOT, 'api/lib/report-schedule-time.js'));
const { sanitizeReportHtml } = require(path.join(ROOT, 'api/lib/email.js'));
const jwt        = require('jsonwebtoken');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined && detail !== '' ? '  — ' + String(detail).slice(0, 600) : ''}`); }
}
const show = r => `${r.statusCode} ${JSON.stringify(r.body).slice(0, 400)}`;

async function call(h, method, query, body, auth, opts = {}) {
  AUTH = auth;
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  const headers = { host: 'datawatch.test' };
  if (opts.token) headers.authorization = 'Bearer ' + opts.token;
  await h({ method, query: query || {}, body: body === undefined ? {} : body, headers }, res);
  return res;
}
const crs = (method, query, body, auth) => call(crsHandler, method, { division: 'paving', ...(query || {}) }, body, auth);
const ars = (method, query, body, auth) => call(arsHandler, method, query, body, auth);

// The CUSTOM REPORTING V2 statements the schedules need (spec §2), exactly,
// for a test database set up before them. Idempotent.
const V2_DDL = [
  `CREATE TABLE IF NOT EXISTS report_contacts (
    id BIGSERIAL PRIMARY KEY,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    division TEXT NOT NULL CHECK (division IN ('turf','paving','kiewit')),
    project_id TEXT, client_key TEXT, client_name TEXT, name TEXT, title TEXT, organization TEXT,
    email TEXT NOT NULL, phone TEXT, role TEXT, auto_add BOOLEAN NOT NULL DEFAULT TRUE,
    created_by_user_id INTEGER, created_by_username TEXT, updated_by_username TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ, CHECK (project_id IS NOT NULL OR client_key IS NOT NULL))`,
  `CREATE TABLE IF NOT EXISTS custom_report_run_archives (
    run_id BIGINT PRIMARY KEY REFERENCES custom_report_runs(id) ON DELETE CASCADE,
    company_code TEXT NOT NULL, html_gzip_b64 TEXT NOT NULL, html_bytes INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  "ALTER TABLE custom_report_runs ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'user'",
  'ALTER TABLE custom_report_runs ADD COLUMN IF NOT EXISTS schedule_id BIGINT',
  'ALTER TABLE custom_report_runs ADD COLUMN IF NOT EXISTS resent_from_run_id BIGINT',
  'ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS custom_report_id BIGINT REFERENCES custom_reports(id) ON DELETE SET NULL',
  "ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS emails JSONB NOT NULL DEFAULT '[]'::jsonb",
  'ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS use_job_contacts BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE report_schedules ADD COLUMN IF NOT EXISTS jobs_mode TEXT',
  'CREATE INDEX IF NOT EXISTS idx_report_schedules_custom ON report_schedules (custom_report_id) WHERE custom_report_id IS NOT NULL',
  'ALTER TABLE report_schedule_runs ADD COLUMN IF NOT EXISTS report_name TEXT',
];

async function cleanUp() {
  for (const co of [CO, CO2]) {
    await client.query('DELETE FROM report_schedules WHERE company_code = $1', [co]);
    await client.query('DELETE FROM custom_report_runs WHERE company_code = $1', [co]);
    await client.query('DELETE FROM custom_reports WHERE company_code = $1', [co]);
    await client.query('DELETE FROM report_contacts WHERE company_code = $1', [co]);
    await client.query('DELETE FROM report_recipient_groups WHERE company_code = $1', [co]);
    await client.query('DELETE FROM app_data WHERE key LIKE $1', [co + ':%']);
    await client.query('DELETE FROM users WHERE company_code = $1', [co]);
    await client.query('DELETE FROM companies WHERE code = $1', [co]);
  }
}

const row = async id => (await client.query('SELECT * FROM report_schedules WHERE id = $1', [id])).rows[0];
const crRuns = async schedId => (await client.query(
  `SELECT r.*, a.html_gzip_b64 IS NOT NULL AS has_archive, a.html_gzip_b64
     FROM custom_report_runs r LEFT JOIN custom_report_run_archives a ON a.run_id = r.id
    WHERE r.schedule_id = $1 ORDER BY r.id`, [schedId])).rows;
const schedRuns = async id => (await client.query('SELECT * FROM report_schedule_runs WHERE schedule_id = $1 ORDER BY id', [id])).rows;
const gunzip = b64 => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
const sortJ = a => JSON.stringify([...a].sort());

// ── The stand-in browser: the real auto-report.js in a vm ──────────────────
const AUTO_SRC = fs.readFileSync(path.join(ROOT, 'auto-report.js'), 'utf8');
const PAVING_JOBS = [
  { id: 'p1', name: 'Paving Maple Ave', client: 'Acme Township', status: 'In Progress' },
  { id: 'p2', name: 'Paving Oak St',    client: 'Beta Co',       status: 'In Progress' },
  { id: 'p3', name: 'Paving Done Job',  client: 'Acme Township', status: 'Complete'    },
];
const PAGE = { specs: [], opened: 0, mark: false, flagInternal: false, noClients: false, throwFor: null, stray: null };
function resetPage() { Object.assign(PAGE, { specs: [], opened: 0, mark: false, flagInternal: false, noClients: false, throwFor: null, stray: null }); }

// What the division page's builder hands back (spec §7): the report built
// from spec.customReport for the jobs the mode means, and its log record.
function pageBuild(spec) {
  PAGE.specs.push(JSON.parse(JSON.stringify(spec)));
  const cr = spec.customReport || {};
  const def = cr.definition || {};
  if (PAGE.throwFor && spec.projectId === PAGE.throwFor) throw new Error('boom');
  const ids = (spec.jobsMode === 'each' ? [spec.projectId]
    : spec.jobsMode === 'all_in_progress' ? PAVING_JOBS.filter(j => j.status === 'In Progress').map(j => j.id)
      : ((def.jobs && def.jobs.ids) || [])).concat(PAGE.stray ? [PAGE.stray] : []);
  const jobs = ids.map(id => PAVING_JOBS.find(j => j.id === id) || { id, name: 'Job ' + id, client: '' });
  const internal = PAGE.mark || def.includeInternal === true;
  const html = `<!doctype html><html><head><style>.t{color:#111}</style><script>window.print()</script></head><body>`
    + `<div class="masthead" data-dw-brand${internal ? ' data-cr-internal="1"' : ''}>${cr.name}</div>`
    + jobs.map(j => `<h2>${j.name}</h2><table><tr><td>0100</td><td>120 CY</td></tr></table>`).join('')
    + '</body></html>';
  return {
    html,
    subject: `${cr.name} — ${jobs.length === 1 ? jobs[0].name : jobs.length + ' jobs'}`,
    projectId: spec.jobsMode === 'each' ? spec.projectId : null,
    projectName: null,
    customReport: {
      report_id: cr.id, report_name: cr.name,
      project_ids: jobs.map(j => j.id), project_names: jobs.map(j => j.name),
      ...(PAGE.noClients ? {} : { clients: jobs.map(j => j.client) }),
      date_from: '2026-10-26', date_to: '2026-11-01', definition: def,
      included_internal: PAGE.flagInternal === true,
    },
  };
}

const viaWindow = (win, fn, arg) => {
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  const prev = global.window;
  global.window = win;
  try { return fn(arg === undefined ? undefined : JSON.parse(JSON.stringify(arg))); }
  finally { if (had) global.window = prev; else delete global.window; }
};
function fakePage() {
  PAGE.opened++;
  const win = vm.createContext({ setTimeout, clearTimeout, console });
  win.window = win;
  vm.runInContext(AUTO_SRC, win);
  win.dwAutoReport.ready(Promise.resolve());
  win.dwAutoReport.jobs(() => PAVING_JOBS.filter(j => j.status === 'In Progress').map(j => ({ id: j.id, name: j.name })));
  win.dwAutoReport.register('paving_custom_report', async s => pageBuild(s), { perJob: true });
  let at = 'about:blank';
  return {
    createCDPSession: async () => ({ send: async () => ({}) }),
    setViewport: async () => {}, emulateTimezone: async () => {}, setRequestInterception: async () => {},
    on() {}, evaluateOnNewDocument: async () => {}, setDefaultTimeout() {},
    goto: async url => { at = url; return { status: () => 200 }; },
    url: () => at,
    waitForFunction: async (fn, opts, arg) => {
      if (viaWindow(win, fn, arg)) return true;
      throw Object.assign(new Error('waiting failed'), { name: 'TimeoutError' });
    },
    // Serialized both ways, as Puppeteer does.
    evaluate: async (fn, arg) => JSON.parse(JSON.stringify(await viaWindow(win, fn, arg) ?? null)),
    close: async () => {},
  };
}
FAKE.browser = { newPage: async () => fakePage(), close: async () => {}, process: () => null, connected: true };

// ── The main run ────────────────────────────────────────────────────────────
(async () => {
  await client.connect();
  const sql = makeSql(client);
  for (const ddl of V2_DDL) await client.query(ddl);
  await cleanUp();
  await client.query("INSERT INTO companies (code, name) VALUES ($1, 'Schedules test'), ($2, 'Other company')", [CO, CO2]);

  const mkUser = async (username, roles, co = CO, extra = {}) => (await client.query(
    `INSERT INTO users (username, company_code, password_hash, role, division_roles, is_platform_admin)
     VALUES ($1, $2, 'x', $4, $3, $5) RETURNING id`,
    [username, co, JSON.stringify(roles), extra.role || 'level1', Boolean(extra.platform)])).rows[0].id;
  const P = (id, username, roles, extra = {}) => ({ companyCode: extra.co || CO, userId: id, username, role: extra.role || 'level1',
    divisionRoles: roles, ...(extra.platform ? { isPlatformAdmin: true } : {}) });

  const adminId = await mkUser('padmin', { paving: 'admin' });
  const l3Id    = await mkUser('pl3',    { paving: 'level3' });
  const l2Id    = await mkUser('pl2',    { paving: 'level2' });
  const l1Id    = await mkUser('pl1',    { paving: 'level1' });
  const salesId = await mkUser('psales', { paving: 'sales' });
  const turfId  = await mkUser('turfadm', { turf: 'admin' });
  const bossId  = await mkUser('boss',   { paving: 'admin', turf: 'admin' });
  const otherId = await mkUser('otheradm', { paving: 'admin' }, CO2);
  const salesAdmId = await mkUser('salesadm', { paving: 'sales', turf: 'admin' });
  const ADMIN = P(adminId, 'padmin', { paving: 'admin' });
  const L3    = P(l3Id, 'pl3', { paving: 'level3' });
  const L2    = P(l2Id, 'pl2', { paving: 'level2' });
  const L1    = P(l1Id, 'pl1', { paving: 'level1' });
  const SALES = P(salesId, 'psales', { paving: 'sales' });
  const TURF  = P(turfId, 'turfadm', { turf: 'admin' });
  const BOSS  = P(bossId, 'boss', { paving: 'admin', turf: 'admin' });
  const PLAT  = P(adminId, 'padmin', {}, { platform: true, role: 'admin' });
  const OTHER = P(otherId, 'otheradm', { paving: 'admin' }, { co: CO2 });
  const SALESADM = P(salesAdmId, 'salesadm', { paving: 'sales', turf: 'admin' });

  const def = (over = {}) => ({
    v: 2, title: '', jobs: { mode: 'pick', ids: [] }, layout: 'separate', dates: { preset: 'last_week', from: '', to: '' },
    includeInternal: false, filters: { costCodes: [], subCodes: [] },
    sections: [{ type: 'job_info' }, { type: 'bid_progress' }], ...over,
  });
  const mkReport = async (name, o = {}) => {
    const d = o.definition || def();
    const savesJobs = d.jobs && d.jobs.mode === 'saved' && Array.isArray(d.jobs.ids) && d.jobs.ids.length > 0;
    return Number((await client.query(
      `INSERT INTO custom_reports (company_code, division, name, visibility, kind, definition, customer_safe, owner_user_id, owner_username, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [o.co || CO, o.division || 'paving', name, o.visibility || 'shared', savesJobs ? 'report' : 'template', JSON.stringify(d),
        o.customerSafe !== undefined ? o.customerSafe : d.includeInternal !== true, o.owner || adminId, o.ownerName || 'padmin',
        o.deleted ? new Date() : null])).rows[0].id);
  };
  const TPL      = await mkReport('Owner Update');
  const REP      = await mkReport('Route 30 Weekly', { definition: def({ jobs: { mode: 'saved', ids: ['p1', 'p2'] } }) });
  const PRIV_L3  = await mkReport('My Draft', { visibility: 'private', owner: l3Id, ownerName: 'pl3' });
  const PRIV_AD  = await mkReport('Admin Private', { visibility: 'private', owner: adminId });
  const INTERNAL = await mkReport('Cost Review', { definition: def({ includeInternal: true }) });
  const SNEAKY   = await mkReport('Sneaky', { definition: def({ includeInternal: true }), customerSafe: true });
  const FIXED    = await mkReport('October Only', { definition: def({ dates: { preset: 'custom', from: '2026-10-01', to: '2026-10-31' } }) });
  const DELETED  = await mkReport('Gone Report', { deleted: true });
  const TURF_R   = await mkReport('Turf Update', { division: 'turf' });
  const CO2_R    = await mkReport('Other Co Update', { co: CO2, owner: otherId, ownerName: 'otheradm' });
  const TPL2     = await mkReport('Second Template');
  // Two of one customer's jobs (Acme Township's), saved.
  const REP_ACME = await mkReport('Acme Jobs', { definition: def({ jobs: { mode: 'saved', ids: ['p1', 'p3'] } }) });

  const grp = async (name, emails, co = CO, reportType = null) => Number((await client.query(
    'INSERT INTO report_recipient_groups (company_code, name, emails, report_type) VALUES ($1, $2, $3, $4) RETURNING id',
    [co, name, JSON.stringify(emails), reportType])).rows[0].id);
  const G1  = await grp('Paving PMs', ['pm1@example.com', 'Owner@Example.com']);
  const G2  = await grp('Office', ['office@example.com']);
  const GD  = await grp('Daily PM group', ['dpm@example.com'], CO, 'turf_daily_pm');
  const GO  = await grp('Other co', ['x@other.com'], CO2);

  const contact = (o) => client.query(
    `INSERT INTO report_contacts (company_code, division, project_id, client_key, client_name, name, email, auto_add, deleted_at)
     VALUES ($1, 'paving', $2, $3, $4, $5, $6, $7, $8)`,
    [CO, o.project_id || null, o.client_key || null, o.client_name || null, o.name || null, o.email, o.auto_add !== false, o.deleted ? new Date() : null]);
  await contact({ project_id: 'p1', name: 'Jo Engineer', email: 'jobcontact@acme.test' });
  await contact({ project_id: 'p1', name: 'Quiet Person', email: 'quiet@acme.test', auto_add: false });
  await contact({ project_id: 'p1', name: 'Left Company', email: 'left@acme.test', deleted: true });
  await contact({ client_key: 'acme township', client_name: 'Acme Township', name: 'Twp Manager', email: 'client@acme.test' });
  // Already on a group: sent once.
  await contact({ project_id: 'p1', name: 'Owner', email: 'owner@example.com' });
  // The jobs as the server holds them, for a page that does not say their clients.
  for (const j of PAVING_JOBS) {
    await client.query('INSERT INTO app_data (key, value) VALUES ($1, $2)',
      [`${CO}:fct_paving_project_${j.id}`, JSON.stringify({ id: j.id, 'project-name': j.name, client: j.client, status: j.status })]);
  }

  const base = {
    custom_report_id: TPL, jobs_mode: 'each', frequency: 'weekly', days_of_week: [1], send_time: '07:00',
    timezone: 'America/New_York', group_ids: [G1], emails: [], use_job_contacts: false,
    subject: null, note: null, attach_pdf: false, enabled: true,
  };

  // ─────────────────────────────────────────────────────────────────────
  console.log('The catalog');
  {
    for (const [div, page, label] of [['turf', 'tracker.html', 'Custom Report — Turf'], ['paving', 'paving.html', 'Custom Report — Paving'],
      ['kiewit', 'kiewit-pinetree.html', 'Custom Report — Kiewit Pinetree']]) {
      const d = catalog.SCHEDULABLE[`${div}_custom_report`];
      assert(`${div}_custom_report is schedulable: scope custom, built on ${page}, no period of its own`,
        d && d.scope === 'custom' && d.customReport === true && d.name === 'Custom Report' && d.page === page && d.label === label
          && d.division === div && !d.period && !d.periods && !d.day && typeof d.blurb === 'string' && d.blurb.length > 20, JSON.stringify(d));
    }
    assert('isCustomType / customTypeFor know them, and nothing else',
      catalog.isCustomType('kiewit_custom_report') && !catalog.isCustomType('paving_daily_pm') && !catalog.isCustomType('__proto__')
        && catalog.customTypeFor('paving') === 'paving_custom_report' && catalog.customTypeFor('dust') === null);
    assert('the jobs modes', JSON.stringify(catalog.JOBS_MODES) === '["saved","each","all_in_progress"]');
    const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).functions;
    assert('vercel.json gives the new endpoint 300 s and 2 GB, like Auto Reports',
      JSON.stringify(vj['api/custom-report-schedules.js']) === '{"includeFiles":"api/**","memory":2048,"maxDuration":300}');
    assert('…and the AI builder 60 s and 1 GB',
      JSON.stringify(vj['api/ai/report-builder.js']) === '{"includeFiles":"api/**","memory":1024,"maxDuration":60}');
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nWho may use it');
  {
    let r = await crs('GET', {}, null, null);
    assert('nobody signed in → 401', r.statusCode === 401, show(r));
    r = await call(crsHandler, 'GET', {}, null, ADMIN);
    assert('no division → 400', r.statusCode === 400, show(r));
    r = await call(crsHandler, 'GET', { division: 'dust' }, null, PLAT);
    assert('a division without Custom Reporting → 400', r.statusCode === 400 && r.body.error === 'division', show(r));
    r = await crs('GET', {}, null, TURF);
    assert('a division the user cannot open → 403', r.statusCode === 403, show(r));
    r = await crs('GET', {}, null, SALES);
    assert('sales → 403, with a reason', r.statusCode === 403 && r.body.error === 'sales' && /sales login/.test(r.body.message), show(r));
    r = await crs('POST', {}, base, SALES);
    assert('…and cannot create one', r.statusCode === 403, show(r));
    for (const [who, auth] of [['level1', L1], ['level2', L2]]) {
      r = await crs('GET', {}, null, auth);
      assert(`${who} sees no schedules and may not schedule (not an error)`,
        r.statusCode === 200 && Array.isArray(r.body.schedules) && r.body.schedules.length === 0 && r.body.canSchedule === false
          && Array.isArray(r.body.groups) && r.body.groups.length === 0, show(r));
      r = await crs('POST', {}, base, auth);
      assert(`${who} cannot create one (403)`, r.statusCode === 403 && r.body.error === 'forbidden', show(r));
    }
    r = await crs('GET', {}, null, L3);
    assert('level3 may schedule', r.statusCode === 200 && r.body.canSchedule === true, show(r));
    r = await crs('GET', {}, null, ADMIN);
    assert('admin may schedule', r.statusCode === 200 && r.body.canSchedule === true, show(r));
    const gnames = (r.body.groups || []).map(g => g.name);
    assert('…offered the company\'s general groups with their sizes, not another report type\'s or another company\'s',
      gnames.includes('Paving PMs') && gnames.includes('Office') && !gnames.includes('Daily PM group') && !gnames.includes('Other co')
        && r.body.groups.find(g => g.name === 'Paving PMs').count === 2, JSON.stringify(r.body.groups));
    r = await crs('GET', {}, null, PLAT);
    assert('a platform admin with no paving role of their own may too', r.statusCode === 200 && r.body.canSchedule === true, show(r));
    // The real guard, on a real token, reading the account from the database.
    REAL_AUTH = true;
    const tok = jwt.sign({ userId: salesId, username: 'psales', companyCode: CO, role: 'level1' }, process.env.JWT_SECRET);
    r = await call(crsHandler, 'GET', { division: 'paving' }, null, null, { token: tok });
    assert('sales is refused through the real sign-in path too', r.statusCode === 403, show(r));
    const tokA = jwt.sign({ userId: adminId, username: 'padmin', companyCode: CO, role: 'level1' }, process.env.JWT_SECRET);
    r = await call(crsHandler, 'GET', { division: 'paving' }, null, null, { token: tokA });
    assert('…and an admin let in', r.statusCode === 200 && r.body.canSchedule === true, show(r));
    REAL_AUTH = false;
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nWhat may be scheduled');
  {
    const bad = async (label, body, code, auth = ADMIN, status = 400) => {
      const r = await crs('POST', {}, body, auth);
      assert(label, r.statusCode === status && r.body.error === code && typeof r.body.message === 'string' && r.body.message.length > 5, show(r));
      return r;
    };
    await bad('no report → report_required', { ...base, custom_report_id: null }, 'report_required');
    await bad('a report that does not exist', { ...base, custom_report_id: 99999999 }, 'report_not_found');
    await bad('a deleted report', { ...base, custom_report_id: DELETED }, 'report_not_found');
    await bad('another division\'s report', { ...base, custom_report_id: TURF_R }, 'report_not_found');
    await bad('another company\'s report', { ...base, custom_report_id: CO2_R }, 'report_not_found');
    await bad('somebody else\'s private report — an admin included', { ...base, custom_report_id: PRIV_L3 }, 'report_not_found');
    let r = await crs('POST', {}, { ...base, custom_report_id: PRIV_L3 }, L3);
    assert('…which its owner may schedule', r.statusCode === 200 && r.body.schedule.custom_report_id === PRIV_L3, show(r));
    const privSched = r.body.schedule.id;
    r = await bad('a report with internal data → not_customer_safe', { ...base, custom_report_id: INTERNAL }, 'not_customer_safe');
    assert('…saying so, by name', /“Cost Review” includes internal data/.test(r.body.message) && /customer-safe only/.test(r.body.message), r.body.message);
    await bad('a report whose definition switches internal data on, whatever its flag says', { ...base, custom_report_id: SNEAKY }, 'not_customer_safe');
    r = await bad('fixed dates → fixed_dates', { ...base, custom_report_id: FIXED }, 'fixed_dates');
    assert('…with the message the builder shows', r.body.message.startsWith('Scheduled reports need a relative date range like Last week'), r.body.message);

    await bad('a saved-jobs report sent per job is refused', { ...base, custom_report_id: REP, jobs_mode: 'each' }, 'jobs_mode');
    await bad('…or for all In Progress jobs', { ...base, custom_report_id: REP, jobs_mode: 'all_in_progress' }, 'jobs_mode');
    await bad('a template sent as "saved jobs" is refused', { ...base, jobs_mode: 'saved' }, 'jobs_mode');
    await bad('a jobs mode that is not one', { ...base, jobs_mode: 'everyone' }, 'jobs_mode');
    await bad('more than 100 picked jobs', { ...base, picked_jobs: Array.from({ length: 101 }, (_, i) => ({ id: 'x' + i })) }, 'picked_jobs');
    await bad('picked jobs that are not a list', { ...base, picked_jobs: 'p1' }, 'picked_jobs');

    await bad('nobody to send to', { ...base, group_ids: [], emails: [], use_job_contacts: false }, 'recipients');
    r = await bad('an address the mail service would refuse, named', { ...base, emails: ['ok@example.com', 'abc@forcecorporation..com'] }, 'emails');
    assert('…by itself', /abc@forcecorporation\.\.com/.test(r.body.message), r.body.message);
    await bad('51 addresses', { ...base, emails: Array.from({ length: 51 }, (_, i) => `a${i}@example.com`) }, 'emails');
    await bad('addresses that are not a list', { ...base, emails: 'a@example.com' }, 'emails');
    await bad('an address that is not text', { ...base, emails: [{ email: 'a@example.com' }] }, 'emails');
    await bad('eleven groups', { ...base, group_ids: Array.from({ length: 11 }, (_, i) => i + 1) }, 'groups');
    await bad('a group that does not exist', { ...base, group_ids: [G1, 99999999] }, 'groups');
    await bad('another company\'s group', { ...base, group_ids: [GO] }, 'groups');
    await bad('groups that are not a list', { ...base, group_ids: G1 }, 'groups');

    await bad('a time that is not a time', { ...base, send_time: '25:00' }, 'cadence');
    await bad('a time off the five-minute mark', { ...base, send_time: '07:03' }, 'cadence');
    await bad('a time zone that does not exist', { ...base, timezone: 'Mars/Olympus_Mons' }, 'cadence');
    await bad('weekly with no day', { ...base, days_of_week: [] }, 'cadence');
    await bad('monthly on the 32nd', { ...base, frequency: 'monthly', day_of_month: 32 }, 'cadence');
    await bad('a frequency that is not one', { ...base, frequency: 'hourly' }, 'cadence');
    await bad('a subject over 200 characters', { ...base, subject: 'x'.repeat(201) }, 'subject');
    await bad('a note over 2000 characters', { ...base, note: 'x'.repeat(2001) }, 'note');

    r = await crs('POST', {}, { ...base, subject: 'S'.repeat(200), note: 'N'.repeat(2000), frequency: 'monthly', day_of_month: -1,
      timezone: 'America/Chicago', send_time: '06:30', emails: ['A@Example.com', 'a@example.com ', 'b@example.com'], group_ids: [G1, G1, G2] }, ADMIN);
    const s1 = r.body.schedule;
    assert('the limits themselves are fine: 200-character subject, 2000-character note, the last day of the month, Central',
      r.statusCode === 200 && s1.subject.length === 200 && s1.note.length === 2000 && s1.day_of_month === -1 && s1.timezone === 'America/Chicago', show(r));
    assert('addresses are kept once each, lower-cased; groups once each',
      JSON.stringify(s1.emails) === '["a@example.com","b@example.com"]' && JSON.stringify(s1.group_ids) === JSON.stringify([G1, G2]), JSON.stringify(s1));
    r = await crs('POST', {}, { ...base, group_ids: [], emails: [], use_job_contacts: true }, ADMIN);
    assert('the jobs\' saved contacts alone are someone to send to', r.statusCode === 200 && r.body.schedule.use_job_contacts === true
      && r.body.schedule.group_ids.length === 0, show(r));
    r = await crs('POST', {}, { ...base, group_ids: [], emails: ['solo@example.com'] }, ADMIN);
    assert('…and so is one address', r.statusCode === 200, show(r));

    // A report about several customers' jobs never goes to those customers.
    r = await bad('one report for every In Progress job cannot go to each job\'s contacts (each customer would see the others\')',
      { ...base, jobs_mode: 'all_in_progress', use_job_contacts: true }, 'job_contacts');
    assert('…saying why and what to do', /one email per job/.test(r.body.message), r.body.message);
    r = await bad('nor a saved report whose jobs belong to two customers',
      { ...base, custom_report_id: REP, jobs_mode: 'saved', use_job_contacts: true }, 'job_contacts');
    assert('…naming it', /“Route 30 Weekly” covers jobs of more than one customer/.test(r.body.message), r.body.message);
    r = await crs('POST', {}, { ...base, custom_report_id: REP_ACME, jobs_mode: 'saved', group_ids: [], use_job_contacts: true }, ADMIN);
    assert('a saved report of one customer\'s jobs may', r.statusCode === 200 && r.body.schedule.jobs_mode === 'saved', show(r));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [r.body.schedule.id]);
    r = await crs('POST', {}, { ...base, jobs_mode: 'all_in_progress', use_job_contacts: false }, ADMIN);
    assert('…and every In Progress job in one report may go to groups and addresses', r.statusCode === 200, show(r));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [r.body.schedule.id]);
    assert('one customer: one job, or several naming the same client (as contacts file it); a blank client among several is not',
      runner.oneCustomer(['Acme']) && runner.oneCustomer(['']) && runner.oneCustomer(['Acme Township', ' acme township '])
        && !runner.oneCustomer(['Acme', 'Beta']) && !runner.oneCustomer(['Acme', '']) && !runner.oneCustomer(['', '']));
    await client.query('DELETE FROM report_schedules WHERE id = ANY($1)', [[s1.id, privSched]]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nWhat is saved');
  let eachId, savedId;
  {
    const before = new Date();
    let r = await crs('POST', {}, { ...base, subject: 'Weekly update', note: 'Through Sunday.', emails: ['owner@example.com'], use_job_contacts: true,
      picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }, { id: 'p2', name: 'Paving Oak St' }, { id: 'p1' }, { id: '*' }, { id: '' }] }, ADMIN);
    assert('a template, one email per picked job, is saved', r.statusCode === 200 && r.body.ok, show(r));
    eachId = r.body.schedule.id;
    const s = await row(eachId);
    assert('…as a paving custom report for that saved report',
      s.report_type === 'paving_custom_report' && s.division === 'paving' && Number(s.custom_report_id) === TPL && s.jobs_mode === 'each', JSON.stringify(s));
    assert('…every job ("*") narrowed to the ones picked, each once',
      s.project_id === '*' && JSON.stringify(s.picked_jobs) === '[{"id":"p1","name":"Paving Maple Ave"},{"id":"p2","name":"Paving Oak St"}]', JSON.stringify(s.picked_jobs));
    assert('…with the report and mode in its options too',
      Object.keys(s.options).length === 3 && s.options.report_id === TPL && s.options.report_name === 'Owner Update' && s.options.jobs_mode === 'each',
      JSON.stringify(s.options));
    assert('…its recipients: the group, the address and the jobs\' contacts',
      JSON.stringify(s.group_ids) === JSON.stringify([G1]) && JSON.stringify(s.emails) === '["owner@example.com"]' && s.use_job_contacts === true);
    assert('…run as, and made by, the admin who saved it',
      s.run_as_user_id === adminId && s.run_as_username === 'padmin' && s.created_by === adminId && s.created_by_username === 'padmin');
    const want = T.nextRunAt({ frequency: 'weekly', days_of_week: [1], send_time: '07:00', timezone: 'America/New_York' }, before);
    assert('…its next send the next Monday at 7:00 Eastern', Math.abs(new Date(s.next_run_at) - want) < 1000,
      `${new Date(s.next_run_at).toISOString()} vs ${want.toISOString()}`);
    const keys = ['id', 'custom_report_id', 'report_name', 'jobs_mode', 'project_id', 'picked_jobs', 'frequency', 'days_of_week', 'day_of_month',
      'send_time', 'timezone', 'group_ids', 'emails', 'use_job_contacts', 'subject', 'note', 'attach_pdf', 'enabled', 'next_run_at',
      'last_run_at', 'last_status', 'last_message', 'run_as_username', 'created_by_username', 'updated_at'];
    const missing = keys.filter(k => !(k in r.body.schedule));
    assert('the row comes back in the documented shape', !missing.length && r.body.schedule.report_name === 'Owner Update', missing.join(','));

    r = await crs('POST', {}, { ...base, custom_report_id: REP, jobs_mode: undefined }, ADMIN);
    savedId = r.body.schedule && r.body.schedule.id;
    const sv = savedId && await row(savedId);
    assert('a saved-jobs report needs no mode: it is sent for its jobs, in one email, with no job on the schedule',
      r.statusCode === 200 && sv.jobs_mode === 'saved' && sv.project_id === null && sv.picked_jobs === null, show(r));
    r = await crs('POST', {}, { ...base, jobs_mode: 'all_in_progress', picked_jobs: [{ id: 'p1' }] }, ADMIN);
    const sa = r.body.schedule;
    assert('all In Progress jobs in one report takes no job and no picks',
      r.statusCode === 200 && sa.jobs_mode === 'all_in_progress' && sa.project_id === null && sa.picked_jobs === null, show(r));
    r = await crs('POST', {}, { ...base, jobs_mode: undefined, enabled: false }, ADMIN);
    const so = r.body.schedule;
    assert('a template with no mode is one email per job; saved switched off, it has no next send',
      r.statusCode === 200 && so.jobs_mode === 'each' && so.project_id === '*' && so.picked_jobs === null && so.enabled === false && so.next_run_at === null, show(r));
    await client.query('DELETE FROM report_schedules WHERE id = ANY($1)', [[sa.id, so.id]]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe list');
  let privId;
  {
    privId = (await crs('POST', {}, { ...base, custom_report_id: PRIV_L3 }, L3)).body.schedule.id;
    // A turf custom schedule and a paving Daily PM: neither is in the paving list.
    const turfSched = (await call(crsHandler, 'POST', { division: 'turf' }, { ...base, custom_report_id: TURF_R }, BOSS)).body.schedule;
    const pm = Number((await client.query(`INSERT INTO report_schedules (company_code, report_type, division, project_id, frequency, send_time, group_ids, run_as_user_id)
      VALUES ($1, 'paving_daily_pm', 'paving', 'p1', 'daily', '06:00', $2, $3) RETURNING id`, [CO, JSON.stringify([G1]), adminId])).rows[0].id);
    let r = await crs('GET', {}, null, L3);
    const ids = r.body.schedules.map(s => s.id);
    assert('level3 sees every paving custom schedule — the admin\'s too',
      ids.includes(eachId) && ids.includes(savedId) && ids.includes(privId), JSON.stringify(ids));
    assert('…and no other report type, and not another division\'s', !ids.includes(pm) && turfSched && !ids.includes(turfSched.id), JSON.stringify(ids));
    r = await crs('GET', {}, null, ADMIN);
    const priv = r.body.schedules.find(s => s.id === privId);
    assert('an admin sees a schedule of somebody\'s private report by name, marked not theirs to open',
      priv && priv.report_name === 'My Draft' && priv.report_visible === false && priv.report_deleted === false && priv.run_as_username === 'pl3', JSON.stringify(priv));
    const mine = r.body.schedules.find(s => s.id === eachId);
    assert('…and its own as openable and customer-safe', mine && mine.report_visible === true && mine.report_customer_safe === true);
    r = await call(crsHandler, 'GET', { division: 'turf' }, null, BOSS);
    assert('the turf list has the turf one', r.body.schedules.length === 1 && r.body.schedules[0].report_name === 'Turf Update', show(r));

    for (let i = 0; i < 30; i++) {
      await client.query(`INSERT INTO report_schedule_runs (schedule_id, company_code, run_kind, status, started_at, report_type, division, report_name)
        VALUES ($1, $2, 'schedule', 'sent', NOW() - ($3 || ' hours')::interval, 'paving_custom_report', 'paving', 'Owner Update')`, [eachId, CO, String(i)]);
    }
    r = await crs('GET', { runs: eachId }, null, L3);
    assert('a schedule\'s last 25 runs, newest first, with the report\'s name',
      r.statusCode === 200 && r.body.runs.length === 25 && r.body.runs[0].report_name === 'Owner Update'
        && new Date(r.body.runs[0].started_at) > new Date(r.body.runs[24].started_at), show(r));
    r = await crs('GET', { runs: pm }, null, ADMIN);
    assert('…not another report type\'s runs (404)', r.statusCode === 404, show(r));
    r = await crs('GET', { runs: eachId }, null, L1);
    assert('…and none for level1', r.statusCode === 200 && r.body.runs.length === 0, show(r));
    await client.query('DELETE FROM report_schedule_runs WHERE schedule_id = $1', [eachId]);
    await client.query('DELETE FROM report_schedules WHERE id = ANY($1)', [[pm, turfSched.id]]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nEditing, switching off and on');
  {
    let r = await crs('PUT', { id: eachId }, { ...base, subject: 'Edited by level 3', picked_jobs: [{ id: 'p2', name: 'Paving Oak St' }] }, L3);
    let s = await row(eachId);
    assert('level3 edits the admin\'s schedule; it now runs as level3',
      r.statusCode === 200 && s.subject === 'Edited by level 3' && s.run_as_user_id === l3Id && s.run_as_username === 'pl3'
        && JSON.stringify(s.picked_jobs) === '[{"id":"p2","name":"Paving Oak St"}]', show(r));
    r = await crs('PUT', { id: privId }, { ...base, custom_report_id: PRIV_L3, subject: 'Hijack' }, ADMIN);
    s = await row(privId);
    assert('an admin cannot save over a schedule of somebody\'s private report (it would run as someone who cannot see it)',
      r.statusCode === 400 && r.body.error === 'report_not_found' && s.subject === null && s.run_as_user_id === l3Id, show(r));
    r = await crs('PUT', { id: privId }, { enabled: false }, ADMIN);
    s = await row(privId);
    assert('…but can switch it off — and it still runs as its owner',
      r.statusCode === 200 && s.enabled === false && s.next_run_at === null && s.run_as_user_id === l3Id, show(r));
    // A whole schedule sent back switched ON is a save — checked, and run as
    // the saver — so the admin, who cannot see this private report, is refused.
    const whole = { ...base, custom_report_id: PRIV_L3, enabled: true };
    r = await crs('PUT', { id: privId }, whole, ADMIN);
    s = await row(privId);
    assert('a whole schedule sent back switched on is a save, not a switch: refused here (it would run as someone who cannot see the report)',
      r.statusCode === 400 && r.body.error === 'report_not_found' && s.enabled === false && s.run_as_user_id === l3Id, show(r));
    // The builder's Pause / Resume sends { enabled } alone.
    r = await crs('PUT', { id: privId }, { enabled: true }, ADMIN);
    s = await row(privId);
    assert('{ enabled } alone is the switch: back on, still running as its owner',
      r.statusCode === 200 && s.enabled === true && new Date(s.next_run_at) > new Date() && s.run_as_user_id === l3Id, show(r));
    await client.query("UPDATE custom_reports SET customer_safe = false, definition = jsonb_set(definition, '{includeInternal}', 'true') WHERE id = $1", [TPL]);
    const cur = await row(eachId);
    const asSent = { ...base, subject: cur.subject, picked_jobs: cur.picked_jobs, enabled: false };
    r = await crs('PUT', { id: eachId }, asSent, L3);
    assert('a schedule whose report has since gone internal can still be paused', r.statusCode === 200 && (await row(eachId)).enabled === false, show(r));
    r = await crs('PUT', { id: eachId }, { ...asSent, enabled: true, subject: 'Changed' }, L3);
    assert('…but not saved with changes until the report is customer-safe again', r.statusCode === 400 && r.body.error === 'not_customer_safe', show(r));
    await client.query("UPDATE custom_reports SET customer_safe = true, definition = jsonb_set(definition, '{includeInternal}', 'false') WHERE id = $1", [TPL]);
    await crs('PUT', { id: eachId }, { enabled: true }, L3);

    const pm = Number((await client.query(`INSERT INTO report_schedules (company_code, report_type, division, project_id, frequency, send_time, group_ids, run_as_user_id)
      VALUES ($1, 'paving_daily_pm', 'paving', 'p1', 'daily', '06:00', $2, $3) RETURNING id`, [CO, JSON.stringify([G1]), adminId])).rows[0].id);
    r = await crs('PUT', { id: pm }, base, ADMIN);
    assert('another report type\'s schedule cannot be edited here (404)', r.statusCode === 404 && (await row(pm)).report_type === 'paving_daily_pm', show(r));
    r = await crs('PUT', { id: pm }, { enabled: false }, ADMIN);
    assert('…nor switched off here', r.statusCode === 404 && (await row(pm)).enabled === true, show(r));
    r = await call(crsHandler, 'PUT', { division: 'turf', id: eachId }, { enabled: false }, BOSS);
    assert('a paving schedule cannot be reached through turf (404)', r.statusCode === 404, show(r));
    for (const [who, auth] of [['level1', L1], ['level2', L2]]) {
      r = await crs('PUT', { id: eachId }, { enabled: false }, auth);
      assert(`${who} cannot switch one off (403)`, r.statusCode === 403, show(r));
      r = await crs('DELETE', { id: eachId }, null, auth);
      assert(`…nor delete one (403)`, r.statusCode === 403 && Boolean(await row(eachId)), show(r));
      r = await crs('POST', { id: eachId, action: 'run' }, null, auth);
      assert(`…nor Send now (403)`, r.statusCode === 403, show(r));
    }
    r = await crs('DELETE', { id: pm }, null, ADMIN);
    assert('another report type\'s schedule is not deleted here', r.statusCode === 200 && r.body.deleted === false && Boolean(await row(pm)), show(r));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [pm]);

    // Saved while it is due: today's send stays due, and what earlier passes
    // sent is kept — only while it is the same report for the same jobs.
    const due = async (id, state) => client.query(
      `UPDATE report_schedules SET next_run_at = NOW() - interval '2 minutes', resume_state = $2::jsonb, resume_count = 1,
         last_status = 'continuing', last_message = '1 more job goes out at the next pass, in a few minutes.' WHERE id = $1`,
      [id, JSON.stringify(state)]);
    const state = { done: ['p1'], sent: 1, attempted: 1, problems: [], passes: 1, occurrence: new Date().toISOString() };
    const curE = await row(eachId);
    const sameBody = { ...base, picked_jobs: curE.picked_jobs, subject: curE.subject };
    await due(eachId, state);
    let dueAt = (await row(eachId)).next_run_at;
    await crs('PUT', { id: eachId }, { ...sameBody, note: 'typo fixed' }, ADMIN);
    s = await row(eachId);
    assert('a note fixed while it is due: still due, its progress kept',
      new Date(s.next_run_at).getTime() === new Date(dueAt).getTime() && s.resume_state && JSON.stringify(s.resume_state.done) === '["p1"]'
        && s.resume_count === 1 && s.last_status === 'continuing', JSON.stringify({ next: s.next_run_at, st: s.resume_state, ls: s.last_status }));
    await crs('PUT', { id: eachId }, { ...sameBody, custom_report_id: TPL2, note: 'typo fixed' }, ADMIN);
    s = await row(eachId);
    assert('pointed at another saved report: started over, and the rest of the last send said not to have gone',
      s.resume_state === null && s.resume_count === 0 && Number(s.custom_report_id) === TPL2 && s.options.report_name === 'Second Template'
        && s.last_status === 'partial' && /did not go out: it was changed/.test(s.last_message), JSON.stringify({ st: s.resume_state, ls: s.last_status, m: s.last_message }));
    await crs('PUT', { id: eachId }, { ...sameBody, note: 'typo fixed' }, ADMIN);
    await due(eachId, state);
    await crs('PUT', { id: eachId }, { ...sameBody, jobs_mode: 'all_in_progress', note: 'typo fixed' }, ADMIN);
    s = await row(eachId);
    assert('…and so with another jobs mode', s.resume_state === null && s.jobs_mode === 'all_in_progress');
    await crs('PUT', { id: eachId }, { ...sameBody, note: 'typo fixed' }, ADMIN);
    await due(eachId, state);
    dueAt = (await row(eachId)).next_run_at;
    await crs('PUT', { id: eachId }, { enabled: true }, ADMIN);
    s = await row(eachId);
    assert('switched "on" while already on and due: still due, progress kept',
      new Date(s.next_run_at).getTime() === new Date(dueAt).getTime() && s.resume_state && s.resume_count === 1);
    await crs('PUT', { id: eachId }, { ...sameBody, note: 'typo fixed', send_time: '16:00' }, ADMIN);
    s = await row(eachId);
    assert('retimed: on to its next time, nothing carried', new Date(s.next_run_at) > new Date() && s.resume_state === null && s.send_time === '16:00');
    await client.query("UPDATE report_schedules SET last_status = NULL, last_message = NULL WHERE id = $1", [eachId]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe 200-schedule cap, shared with Auto Reports');
  {
    const n = Number((await client.query('SELECT COUNT(*)::int AS n FROM report_schedules WHERE company_code = $1', [CO])).rows[0].n);
    const fill = await client.query(`INSERT INTO report_schedules (company_code, report_type, division, project_id, frequency, send_time, group_ids, run_as_user_id, enabled)
      SELECT $1, 'turf_daily_pm', 'turf', 'j1', 'daily', '06:00', '[]'::jsonb, $2, false FROM generate_series(1, $3) RETURNING id`, [CO, adminId, 200 - n]);
    let r = await crs('POST', {}, base, ADMIN);
    assert('with 200 Auto Reports and custom schedules between them, a 201st is refused', r.statusCode === 400 && r.body.error === 'cap', show(r));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [fill.rows[0].id]);
    r = await crs('POST', {}, base, ADMIN);
    assert('…and the 200th is fine', r.statusCode === 200, show(r));
    await client.query('DELETE FROM report_schedules WHERE id = ANY($1)', [[...fill.rows.map(x => x.id), r.body.schedule.id]]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nAuto Reports (Manage Users) and custom schedules');
  {
    await client.query("UPDATE custom_reports SET name = 'Owner Update (renamed)' WHERE id = $1", [TPL]);
    await crs('PUT', { id: eachId }, { ...base, picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }], emails: ['extra@example.com'], use_job_contacts: true }, L3);
    let r = await ars('GET', {}, null, BOSS);
    const shown = r.body.schedules.find(s => Number(s.id) === Number(eachId));
    assert('Auto Reports lists it, managed in Custom Reporting, under the report\'s name as it is now',
      shown && shown.managed_in === 'custom_reporting' && shown.report_name === 'Owner Update (renamed)' && shown.custom_report_id === TPL
        && shown.jobs_mode === 'each' && JSON.stringify(shown.emails) === '["extra@example.com"]' && shown.use_job_contacts === true, JSON.stringify(shown));
    const pav = r.body.divisions.find(d => d.key === 'paving');
    const cr = pav && pav.reports.find(x => x.type === 'paving_custom_report');
    assert('…and its report type, flagged so the editor offers it to nobody', cr && cr.customReport === true && cr.managed_in === 'custom_reporting' && cr.scope === 'custom');
    const daily = r.body.schedules.find(s => s.report_type !== 'paving_custom_report');
    assert('other rows carry no custom fields', !daily || !('managed_in' in daily));
    r = await ars('GET', {}, null, L3);
    assert('Auto Reports is still admins only (level3 refused there)', r.statusCode === 403);

    r = await ars('POST', {}, { report_type: 'paving_custom_report', frequency: 'daily', send_time: '06:00', group_ids: [G1] }, BOSS);
    assert('creating a custom schedule there is refused, pointing to Custom Reporting',
      r.statusCode === 400 && r.body.error === 'Manage custom report schedules in Analytics → Custom Reporting', show(r));
    const before = await row(eachId);
    r = await ars('PUT', { id: eachId }, { report_type: 'paving_daily_pm', project_id: 'p1', frequency: 'daily', send_time: '06:00', group_ids: [G1] }, BOSS);
    assert('editing one there is refused, even into another report', r.statusCode === 400 && /Custom Reporting/.test(r.body.error)
      && (await row(eachId)).report_type === 'paving_custom_report', show(r));
    r = await ars('PUT', { id: eachId }, { report_type: 'paving_custom_report', frequency: 'daily', send_time: '06:00', group_ids: [G1] }, BOSS);
    assert('…and as itself', r.statusCode === 400 && (await row(eachId)).frequency === before.frequency, show(r));
    const pm = (await ars('POST', {}, { report_type: 'paving_daily_pm', project_id: 'p1', frequency: 'daily', send_time: '06:00', group_ids: [G1] }, BOSS)).body.schedule;
    r = await ars('PUT', { id: pm.id }, { report_type: 'paving_custom_report', frequency: 'daily', send_time: '06:00', group_ids: [G1] }, BOSS);
    assert('…and a Daily PM cannot be turned into one there', r.statusCode === 400 && (await row(pm.id)).report_type === 'paving_daily_pm', show(r));
    r = await ars('PUT', { id: eachId }, { enabled: false }, BOSS);
    let s = await row(eachId);
    assert('an admin may switch one off there — it keeps running as the person who saved it',
      r.statusCode === 200 && s.enabled === false && s.next_run_at === null && s.run_as_user_id === l3Id && r.body.schedule.report_name === 'Owner Update (renamed)', show(r));
    r = await ars('PUT', { id: eachId }, { enabled: true }, BOSS);
    s = await row(eachId);
    assert('…and on again, everything else as it was',
      r.statusCode === 200 && s.enabled === true && s.run_as_user_id === l3Id && Number(s.custom_report_id) === TPL && s.use_job_contacts === true
        && JSON.stringify(s.emails) === '["extra@example.com"]' && s.jobs_mode === 'each', show(r));
    // Due, and part sent: switched "on" there keeps its progress (same saved report).
    await client.query(`UPDATE report_schedules SET next_run_at = NOW() - interval '1 minute', resume_state = '{"done":["p1"],"sent":1}'::jsonb, resume_count = 1 WHERE id = $1`, [eachId]);
    await ars('PUT', { id: eachId }, { enabled: true }, BOSS);
    s = await row(eachId);
    assert('…switched "on" there while due, its progress is kept', s.resume_state && s.resume_count === 1);
    const sameRep = arsHandler.sameCustomReport;
    assert('keepResume there compares the saved report (column, options copy) and jobs mode',
      sameRep({ custom_report_id: '5', options: { report_id: 5 }, jobs_mode: 'each' }, { custom_report_id: 5, options: { report_id: 5 }, jobs_mode: 'each' })
        && !sameRep({ custom_report_id: '5', options: { report_id: 5 } }, { custom_report_id: 6, options: { report_id: 6 } })
        && !sameRep({ custom_report_id: null, options: { report_id: 5 } }, { custom_report_id: null, options: { report_id: 6 } })
        && !sameRep({ custom_report_id: 5, jobs_mode: 'each' }, { custom_report_id: 5, jobs_mode: 'all_in_progress' })
        && sameRep({ options: {} }, { options: { period: 'prev_day' } }));
    await client.query('UPDATE report_schedules SET resume_state = NULL, resume_count = 0, next_run_at = NOW() + interval \'1 day\' WHERE id = $1', [eachId]);
    await runner.recordRun(sql, await row(eachId), { status: 'sent', sent: 1, total: 1, recipientCount: 3, message: 'Sent to 3 recipients.', reportName: 'Owner Update (renamed)' },
      { kind: 'manual', token: null, triggeredBy: 'boss', startedAt: new Date(), now: new Date() });
    r = await ars('GET', {}, null, BOSS);
    const hist = r.body.runs.find(x => Number(x.schedule_id) === Number(eachId));
    assert('its sends are in the Auto Reports history under the report\'s name',
      hist && hist.report_name === 'Owner Update (renamed)' && hist.project_name === 'Owner Update (renamed) — 1 picked job', JSON.stringify(hist));
    // An admin elsewhere who is sales in paving: Custom Reporting is not theirs.
    r = await ars('GET', {}, null, SALESADM);
    assert('an admin who is a sales login in paving does not see paving\'s custom schedules in Auto Reports',
      r.statusCode === 200 && !r.body.schedules.some(x => x.report_type === 'paving_custom_report')
        && !r.body.runs.some(x => x.report_type === 'paving_custom_report'), JSON.stringify(r.body.schedules.map(x => x.report_type)));
    for (const [what, method, q, body] of [['switch one off', 'PUT', { id: eachId }, { enabled: false }], ['delete one', 'DELETE', { id: eachId }, null],
      ['Send one now', 'POST', { id: eachId, action: 'run' }, null]]) {
      r = await ars(method, q, body, SALESADM);
      assert(`…nor ${what} (403)`, r.statusCode === 403 && /sales login/.test(r.body.error) && Boolean(await row(eachId)) && (await row(eachId)).enabled === true, show(r));
    }
    const throwaway = (await crs('POST', {}, base, ADMIN)).body.schedule.id;
    r = await ars('DELETE', { id: throwaway }, null, BOSS);
    assert('an admin may delete one there', r.statusCode === 200 && !(await row(throwaway)), show(r));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [pm.id]);
    await client.query('DELETE FROM report_schedule_runs WHERE schedule_id = $1', [eachId]);
    await client.query("UPDATE custom_reports SET name = 'Owner Update' WHERE id = $1", [TPL]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe run checks the saved report again, before anything is built');
  const mkSched = async (over = {}, auth = ADMIN) => {
    const r = await crs('POST', {}, { ...base, ...over }, auth);
    if (r.statusCode !== 200) throw new Error('could not set up a schedule: ' + show(r));
    return row(r.body.schedule.id);
  };
  // The runner's database, with the history write made to fail on demand.
  const runSql = (strings, ...values) => (DB.failRunInsert && strings.join('?').includes('INSERT INTO custom_report_runs')
    ? Promise.reject(new Error('connection reset')) : sql(strings, ...values));
  const run = (sched, ctx = {}) => runner.runSchedule(runSql, sched, { browser: FAKE.browser, baseUrl: 'http://app.test', now: new Date(), ...ctx });
  {
    const quiet = async (label, sched, re, prep) => {
      resetPage(); SENT.length = 0;
      if (prep) await prep();
      const res = await run(sched);
      assert(label, res.status === 'failed' && re.test(res.message) && PAGE.opened === 0 && SENT.length === 0, JSON.stringify(res));
      return res;
    };
    const tmp = await mkReport('Short Lived');
    let sched = await mkSched({ custom_report_id: tmp });
    await client.query('UPDATE custom_reports SET deleted_at = NOW() WHERE id = $1', [tmp]);
    await quiet('deleted since: "The saved report … was deleted", nothing built', sched, /^The saved report “Short Lived” was deleted\. Restore it in Custom Reporting, or delete this schedule\.$/);
    await client.query('DELETE FROM custom_reports WHERE id = $1', [tmp]);
    sched = await row(sched.id);
    assert('purged, the schedule keeps its row with no report', sched && sched.custom_report_id === null);
    await quiet('…and says so by the name it was saved with', sched, /^The saved report “Short Lived” was deleted/);

    const hideMe = await mkReport('Hide Me');
    sched = await mkSched({ custom_report_id: hideMe });
    await client.query("UPDATE custom_reports SET visibility = 'private', owner_user_id = $2 WHERE id = $1", [hideMe, l3Id]);
    const hidden = await quiet('made private to someone else since: "…is no longer shared with padmin"', sched, /^“Hide Me” is no longer shared with padmin, who this schedule runs as\./);
    // The schedules list says what the next send will find, in the run's words.
    const listed = async id => (await crs('GET', {}, null, ADMIN)).body.schedules.find(x => x.id === Number(id));
    let ls = await listed(sched.id);
    assert('…and the schedules list says so before the next send (report_blocked, the run\'s own words)', ls && ls.report_blocked === hidden.message, JSON.stringify(ls));

    const goesInternal = await mkReport('Goes Internal');
    sched = await mkSched({ custom_report_id: goesInternal });
    await client.query("UPDATE custom_reports SET customer_safe = false, definition = jsonb_set(definition, '{includeInternal}', 'true') WHERE id = $1", [goesInternal]);
    await quiet('switched to internal data since: customer-safe only', sched, /^“Goes Internal” now includes internal data — scheduled sends are customer-safe only\./);
    ls = await listed(sched.id);
    assert('…which the list carries in report_customer_safe, not report_blocked', ls && ls.report_customer_safe === false && ls.report_blocked === null, JSON.stringify(ls));
    await client.query("UPDATE custom_reports SET customer_safe = true WHERE id = $1", [goesInternal]);
    await quiet('…even when only its definition says so', sched, /now includes internal data/);

    const goesFixed = await mkReport('Goes Fixed');
    sched = await mkSched({ custom_report_id: goesFixed });
    await client.query(`UPDATE custom_reports SET definition = jsonb_set(definition, '{dates}', '{"preset":"custom","from":"2026-10-01","to":"2026-10-07"}') WHERE id = $1`, [goesFixed]);
    const fixedRes = await quiet('switched to fixed dates since: stopped, saying why', sched, /^“Goes Fixed” is set to fixed dates now/);
    ls = await listed(sched.id);
    assert('…and the list says so (report_blocked) while the report is still customer-safe', ls && ls.report_customer_safe === true
      && ls.report_blocked === fixedRes.message, JSON.stringify(ls));

    const losesJobs = await mkReport('Loses Jobs', { definition: def({ jobs: { mode: 'saved', ids: ['p1'] } }) });
    sched = await mkSched({ custom_report_id: losesJobs, jobs_mode: 'saved' });
    await client.query(`UPDATE custom_reports SET kind = 'template', definition = jsonb_set(definition, '{jobs}', '{"mode":"pick","ids":[]}') WHERE id = $1`, [losesJobs]);
    const lostRes = await quiet('a saved-jobs report that no longer saves its jobs: stopped, saying what to do', sched, /^“Loses Jobs” no longer saves its jobs/);
    ls = await listed(sched.id);
    assert('…and the list says so (report_blocked)', ls && ls.report_blocked === lostRes.message, JSON.stringify(ls));
    ls = await listed(eachId);
    assert('…while a schedule that will send has no report_blocked', ls && ls.report_blocked === null, JSON.stringify(ls));

    sched = await mkSched();
    await client.query("UPDATE users SET division_roles = $1 WHERE id = $2", [JSON.stringify({ paving: 'sales' }), adminId]);
    await quiet('the account it runs as made sales since: stopped, saying so', sched, /^padmin is a sales login in Paving now, and sales cannot open Custom Reporting\./);
    await client.query("UPDATE users SET division_roles = $1 WHERE id = $2", [JSON.stringify({ turf: 'admin' }), adminId]);
    await quiet('…or with paving taken away', sched, /^padmin no longer has access to Paving\./);
    await client.query("UPDATE users SET division_roles = $1 WHERE id = $2", [JSON.stringify({ paving: 'admin' }), adminId]);

    await client.query("UPDATE report_schedules SET custom_report_id = NULL WHERE id = $1", [sched.id]);
    resetPage(); SENT.length = 0;
    const res = await run(await row(sched.id));
    assert('with the column empty, the report named in its options is still found', res.status === 'sent' && SENT.length === 2, JSON.stringify(res));
    const noGroups = await mkSched({ group_ids: [], emails: ['solo@example.com'] });
    await client.query("UPDATE report_schedules SET emails = '[]'::jsonb WHERE id = $1", [noGroups.id]);
    resetPage();
    const res2 = await run(await row(noGroups.id));
    assert('nobody left to send to (no group, no address, no contacts): failed, saying what to add',
      res2.status === 'failed' && /nobody to send to/i.test(res2.message) && PAGE.opened === 0, JSON.stringify(res2));
    await client.query('DELETE FROM report_schedules WHERE company_code = $1 AND id <> ALL($2)', [CO, [eachId, savedId, privId]]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA long list goes in batches of 50; a later batch refused — the people it reached are in Customer History');
  {
    const g30 = await grp('Owner distribution', Array.from({ length: 30 }, (_, i) => `gc${i}@owner.test`));
    const extra = Array.from({ length: 30 }, (_, i) => `rep${i}@gc.test`);
    const sched = await mkSched({ jobs_mode: 'each', picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }], group_ids: [g30], emails: extra });
    resetPage(); SENT.length = 0;
    Object.assign(MAIL, { failAt: 2, tries: 0 });
    let res;
    try { res = await run(sched, { kind: 'manual' }); } finally { Object.assign(MAIL, { failAt: 0, tries: 0 }); }
    const reached = SENT.flatMap(o => [].concat(o.to));
    assert('the first batch of 50 went, the second was refused: the run reads partial, 1 sent to the 50 it reached, the failure named',
      res.status === 'partial' && res.sent === 1 && SENT.length === 1 && reached.length === 50 && res.recipientCount === 50
        && /50 of 60/.test(res.message) && /Resend 500/.test(res.message), JSON.stringify(res));
    assert('…and the message names who it did not reach', /Not reached: /.test(res.message) && /and \d+ more/.test(res.message), res.message);
    const rows = (await client.query(
      `SELECT r.*, (a.run_id IS NOT NULL) AS has_archive FROM custom_report_runs r LEFT JOIN custom_report_run_archives a ON a.run_id = r.id
        WHERE r.schedule_id = $1 ORDER BY r.id`, [sched.id])).rows;
    assert('…one send in the report\'s history, as the schedule\'s, with exactly the 50 addresses that got it, its HTML archived',
      rows.length === 1 && ['send_now', 'schedule'].includes(rows[0].run_kind) && rows[0].action === 'email' && rows[0].has_archive === true
        && JSON.stringify([...rows[0].recipients].sort()) === JSON.stringify([...reached].sort()), JSON.stringify(rows.map(r => [r.run_kind, r.recipients.length, r.has_archive])));
    const hist = await call(require(path.join(ROOT, 'api/custom-reports.js')), 'GET', { division: 'paving', runs: '1', project_id: 'p1' }, null, ADMIN);
    assert('…which the job\'s Customer History lists', hist.statusCode === 200 && Array.isArray(hist.body.runs)
      && hist.body.runs.some(x => rows[0] && Number(x.id) === Number(rows[0].id)), JSON.stringify(hist.body).slice(0, 300));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [sched.id]);
    await client.query('DELETE FROM report_recipient_groups WHERE id = $1', [g30]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nSaved with nothing changed, a schedule runs as whoever saved it — the fix its failed run names');
  {
    // The body the Edit dialog sends back when nothing was changed.
    const asShown = sched => ({ custom_report_id: Number(sched.custom_report_id), jobs_mode: sched.jobs_mode, picked_jobs: sched.picked_jobs,
      frequency: sched.frequency, days_of_week: sched.days_of_week, day_of_month: sched.day_of_month, send_time: sched.send_time,
      timezone: sched.timezone, group_ids: sched.group_ids, emails: sched.emails, use_job_contacts: sched.use_job_contacts,
      subject: sched.subject, note: sched.note, attach_pdf: sched.attach_pdf, enabled: sched.enabled });
    const vId = await mkUser('victimadm', { paving: 'admin' });
    let sched = await mkSched({}, P(vId, 'victimadm', { paving: 'admin' }));
    await client.query('UPDATE users SET division_roles = $1 WHERE id = $2', [JSON.stringify({ paving: 'sales' }), vId]);
    resetPage(); SENT.length = 0;
    let res = await run(sched);
    assert('runs as an admin made sales since: failed, telling someone to edit and save it',
      res.status === 'failed' && /victimadm is a sales login/.test(res.message) && /edit and save the schedule/.test(res.message), JSON.stringify(res));
    let r = await crs('PUT', { id: sched.id }, asShown(sched), L3);
    sched = await row(sched.id);
    assert('a level 3 saves it with nothing changed: 200, and it now runs as them',
      r.statusCode === 200 && sched.run_as_user_id === l3Id && sched.run_as_username === 'pl3' && sched.enabled === true, show(r));
    resetPage(); SENT.length = 0;
    res = await run(sched);
    assert('…so the next run sends', res.status === 'sent' && SENT.length > 0, JSON.stringify(res));
    // The account it ran as deleted.
    const goneId = await mkUser('goneadm', { paving: 'admin' });
    let gone = await mkSched({}, P(goneId, 'goneadm', { paving: 'admin' }));
    await client.query('DELETE FROM users WHERE id = $1', [goneId]);
    gone = await row(gone.id);
    resetPage(); SENT.length = 0;
    res = await run(gone);
    assert('runs as a deleted account: failed, saying to open it and save it', res.status === 'failed' && /save it/.test(res.message), JSON.stringify(res));
    r = await crs('PUT', { id: gone.id }, asShown(gone), ADMIN);
    gone = await row(gone.id);
    assert('…an admin saves it unchanged: it runs as the admin now', r.statusCode === 200 && gone.run_as_user_id === adminId && gone.run_as_username === 'padmin', show(r));
    resetPage(); SENT.length = 0;
    res = await run(gone);
    assert('…and sends', res.status === 'sent' && SENT.length > 0, JSON.stringify(res));
    // Paused from the dialog (the whole schedule, switched off): still a switch.
    r = await crs('PUT', { id: gone.id }, { ...asShown(gone), enabled: false }, L3);
    gone = await row(gone.id);
    assert('switched off from the dialog with nothing else changed: paused, and it still runs as the admin',
      r.statusCode === 200 && gone.enabled === false && gone.next_run_at === null && gone.run_as_user_id === adminId, show(r));
    await client.query('DELETE FROM report_schedules WHERE id = ANY($1)', [[sched.id, gone.id]]);
    await client.query('DELETE FROM users WHERE id = $1', [vId]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA recipient group deleted since the schedule was saved');
  {
    const asShown = sched => ({ custom_report_id: Number(sched.custom_report_id), jobs_mode: sched.jobs_mode, picked_jobs: sched.picked_jobs,
      frequency: sched.frequency, days_of_week: sched.days_of_week, day_of_month: sched.day_of_month, send_time: sched.send_time,
      timezone: sched.timezone, group_ids: sched.group_ids, emails: sched.emails, use_job_contacts: sched.use_job_contacts,
      subject: sched.subject, note: sched.note, attach_pdf: sched.attach_pdf, enabled: sched.enabled });
    const gGone = await grp('Owner Reps', ['rep@example.com']);
    let sched = await mkSched({ group_ids: [G1, gGone] });
    await client.query('DELETE FROM report_recipient_groups WHERE id = $1', [gGone]);
    // An edit sent back with the deleted group still on it (a page loaded
    // before the delete): saved, without that group, rather than refused.
    let r = await crs('PUT', { id: sched.id }, { ...asShown(sched), send_time: '08:00' }, ADMIN);
    let s = await row(sched.id);
    assert('saving a schedule that still names a group deleted since: 200, saved without it',
      r.statusCode === 200 && s.send_time === '08:00' && JSON.stringify(s.group_ids.map(Number)) === JSON.stringify([G1]), show(r));
    // A deleted group it never sent to is still refused, and named.
    const gNew = await grp('Never attached', ['n@example.com']);
    await client.query('DELETE FROM report_recipient_groups WHERE id = $1', [gNew]);
    r = await crs('PUT', { id: sched.id }, { ...asShown(await row(sched.id)), group_ids: [G1, gNew] }, ADMIN);
    assert('…a deleted group it never sent to is refused, and the refusal names it', r.statusCode === 400 && r.body.error === 'groups'
      && Array.isArray(r.body.missing) && r.body.missing.map(Number).join() === String(gNew), show(r));
    // Its only recipient was the deleted group: nobody left to send to.
    const gOnly = await grp('Only group', ['only@example.com']);
    const only = await mkSched({ group_ids: [gOnly] });
    await client.query('DELETE FROM report_recipient_groups WHERE id = $1', [gOnly]);
    r = await crs('PUT', { id: only.id }, asShown(only), ADMIN);
    assert('…and one whose only recipient was that group says there is nobody left to send to', r.statusCode === 400 && r.body.error === 'recipients'
      && /deleted/.test(r.body.message), show(r));
    await client.query('DELETE FROM report_schedules WHERE id = ANY($1)', [[sched.id, only.id]]);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA template scheduled per job, then saved with its own jobs, is not sent per job');
  {
    for (const mode of ['each', 'all_in_progress']) {
      const flip = await mkReport(`Flips To Report ${mode}`);
      const sched = await mkSched({ custom_report_id: flip, jobs_mode: mode, use_job_contacts: mode === 'each' });
      await client.query(`UPDATE custom_reports SET kind = 'report', name = 'Acme Township — Route 30 Weekly ' || $2,
        definition = jsonb_set(definition, '{jobs}', '{"mode":"saved","ids":["p1"]}') WHERE id = $1`, [flip, mode]);
      resetPage(); SENT.length = 0;
      const res = await run(await row(sched.id));
      assert(`${mode}: the run refuses, saying it now saves its own jobs and to save the schedule — nothing built, nothing sent`,
        res.status === 'failed' && /now saves its own jobs/.test(res.message) && /save it to send it for those jobs/.test(res.message)
          && PAGE.specs.length === 0 && SENT.length === 0, JSON.stringify(res));
      const ls = (await crs('GET', {}, null, ADMIN)).body.schedules.find(x => x.id === Number(sched.id));
      assert(`${mode}: …and the schedules list says so before any send (report_blocked)`, ls && ls.report_blocked === res.message, JSON.stringify(ls));
      // What the Edit dialog sends for a report that saves its jobs.
      const r = await crs('PUT', { id: sched.id }, { ...base, custom_report_id: flip, jobs_mode: 'saved', use_job_contacts: false }, ADMIN);
      resetPage(); SENT.length = 0;
      const again = await run(await row(sched.id));
      assert(`${mode}: …and once the schedule is saved, it sends the report for its own job only (the PUT's answer no longer blocked)`,
        r.statusCode === 200 && again.status === 'sent' && PAGE.specs.length === 1 && PAGE.specs[0].jobsMode === 'saved'
          && r.body.schedule.report_blocked === null, `${show(r)} ${JSON.stringify(again)}`);
      await client.query('DELETE FROM report_schedules WHERE id = $1', [sched.id]);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA picked job saved under a name it no longer has keeps the schedule\'s subject');
  {
    // p3 "Paving Done Job" is Complete, so the page cannot find it among the
    // In Progress jobs and labels it with the name the schedule saved — a
    // name it may no longer have ("Untitled job" is what the dialog saves for
    // a job with only a number). The subject still names it as the page does.
    for (const [label, over, want] of [
      ['renamed since, with a subject', { subject: 'Owner update', picked_jobs: [{ id: 'p3', name: 'Old name' }] }, 'Owner update — Paving Done Job'],
      ['renamed since, no subject (the page\'s own)', { subject: null, picked_jobs: [{ id: 'p3', name: 'Old name' }] }, 'Owner Update — Paving Done Job'],
      ['saved as "Untitled job", with a subject', { subject: 'Owner update', picked_jobs: [{ id: 'p3', name: 'Untitled job' }] }, 'Owner update — Paving Done Job'],
    ]) {
      resetPage(); SENT.length = 0;
      const sched = await mkSched({ ...over, attach_pdf: false });
      const res = await run(sched);
      const logged = await crRuns(sched.id);
      assert(`${label}: the email's subject is "${want}", and its history says the same (not "Custom Report — Paving — <old name>")`,
        res.status === 'sent' && SENT.length === 1 && SENT[0].subject === want && logged.length === 1 && logged[0].subject === want,
        JSON.stringify({ status: res.status, sent: SENT.map(m => m.subject), logged: logged.map(l => l.subject) }));
      await client.query('DELETE FROM report_schedules WHERE id = $1', [sched.id]);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nThe run: built customer-safe, sent to the right people, logged');
  {
    const runsBefore = Number((await client.query('SELECT run_count FROM custom_reports WHERE id = $1', [TPL])).rows[0].run_count);
    let sched = await mkSched({ subject: 'Weekly update', emails: ['Extra@Example.com', 'owner@example.com'], use_job_contacts: true,
      picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }, { id: 'p2', name: 'Paving Oak St' }] });
    // The definition as stored with internal data on is refused at save, so it
    // is set on the stored definition only after: forced off for the page.
    resetPage(); SENT.length = 0;
    const t0 = new Date('2026-11-09T12:05:00Z');
    let res = await run(sched, { now: t0, occurrence: new Date('2026-11-09T12:00:00Z') });
    assert('an every-picked-job schedule sends one email per job', res.status === 'sent' && res.sent === 2 && SENT.length === 2, JSON.stringify(res));
    const sp = PAGE.specs[0] || {};
    assert('the page is handed the saved report — id, name, version and definition — and the jobs mode',
      sp.type === 'paving_custom_report' && sp.customReport && sp.customReport.id === TPL && sp.customReport.name === 'Owner Update'
        && sp.customReport.version === 1 && sp.customReport.definition && sp.customReport.definition.dates.preset === 'last_week'
        && sp.jobsMode === 'each', JSON.stringify(sp));
    assert('…with internal data off in the definition it is given', PAGE.specs.every(x => x.customReport.definition.includeInternal === false));
    assert('…one job per build, the picked ones, and "today" the day it was due in its zone',
      JSON.stringify(PAGE.specs.map(x => x.projectId)) === '["p1","p2"]' && PAGE.specs.every(x => x.today === '2026-11-09'),
      JSON.stringify(PAGE.specs.map(x => [x.projectId, x.today])));
    const to1 = SENT.find(m => /Maple Ave/.test(m.subject)) || {};
    const to2 = SENT.find(m => /Oak St/.test(m.subject)) || {};
    assert('Maple Ave goes to the group, the schedule\'s addresses, its job contact and its client\'s contact — once each',
      sortJ(to1.to || []) === sortJ(['pm1@example.com', 'owner@example.com', 'extra@example.com', 'jobcontact@acme.test', 'client@acme.test']), JSON.stringify(to1.to));
    assert('…and not a contact switched off for auto-add, nor a deleted one', !(to1.to || []).includes('quiet@acme.test') && !(to1.to || []).includes('left@acme.test'));
    assert('Oak St (no saved contacts) goes to the group and the addresses only',
      sortJ(to2.to || []) === sortJ(['pm1@example.com', 'owner@example.com', 'extra@example.com']), JSON.stringify(to2.to));
    assert('each email\'s subject is the schedule\'s, with its job named',
      to1.subject === 'Weekly update — Paving Maple Ave' && to2.subject === 'Weekly update — Paving Oak St', `${to1.subject} | ${to2.subject}`);
    assert('the result counts everybody it reached', res.recipientCount === 5 && res.message === 'Sent 2 reports to 5 recipients.', JSON.stringify(res));
    assert('…and the body is the report, sanitized (no script)', /Paving Maple Ave/.test(to1.html || '') && !/window\.print/.test(to1.html || ''));

    const logged = await crRuns(sched.id);
    assert('both sends are in the report\'s history as scheduled emails',
      logged.length === 2 && logged.every(l => l.run_kind === 'schedule' && l.action === 'email' && Number(l.schedule_id) === Number(sched.id)
        && Number(l.report_id) === TPL && l.report_name === 'Owner Update' && l.included_internal === false && l.run_by_username === 'padmin'),
      JSON.stringify(logged.map(l => ({ k: l.run_kind, a: l.action, s: l.schedule_id, r: l.report_id, n: l.report_name, i: l.included_internal }))));
    const l1 = logged.find(l => JSON.stringify(l.project_ids) === '["p1"]');
    assert('…each with its job, dates, recipients, subject and the definition it was built from (internal off)',
      l1 && JSON.stringify(l1.project_names) === '["Paving Maple Ave"]' && l1.subject === 'Weekly update — Paving Maple Ave'
        && sortJ(l1.recipients) === sortJ(to1.to) && l1.definition.includeInternal === false && l1.definition.dates.preset === 'last_week'
        && String(l1.date_from).length > 0, JSON.stringify(l1 && { ids: l1.project_ids, df: l1.date_from, subj: l1.subject }));
    const arch = l1 && l1.has_archive ? gunzip(l1.html_gzip_b64) : '';
    assert('…and exactly what was emailed archived: the sanitized report',
      arch && arch === sanitizeReportHtml(pageBuild({ customReport: PAGE.specs[0].customReport, jobsMode: 'each', projectId: 'p1' }).html)
        && /Paving Maple Ave/.test(arch) && !/<script/i.test(arch), arch.slice(0, 200));
    PAGE.specs.pop();
    assert('…and the report\'s run count moved on by two',
      Number((await client.query('SELECT run_count FROM custom_reports WHERE id = $1', [TPL])).rows[0].run_count) === runsBefore + 2);
    await runner.recordRun(sql, sched, res, { kind: 'schedule', token: null, triggeredBy: null, startedAt: t0, now: new Date() });
    const hr = (await schedRuns(sched.id)).slice(-1)[0];
    assert('the schedule\'s own history names the report', hr && hr.report_name === 'Owner Update' && hr.project_name === 'Owner Update — 2 picked jobs'
      && hr.recipient_count === 5, JSON.stringify(hr && { n: hr.report_name, p: hr.project_name, c: hr.recipient_count }));

    // The jobs' clients read from the jobs when the page does not say them.
    resetPage(); SENT.length = 0; PAGE.noClients = true;
    res = await run(sched);
    const m1 = SENT.find(m => /Maple Ave/.test(m.subject)) || {};
    assert('a page that does not say its jobs\' clients: the client contact is still found, from the job itself',
      res.status === 'sent' && (m1.to || []).includes('client@acme.test'), JSON.stringify(m1.to));

    // Only the jobs' contacts.
    const contactsOnly = await mkSched({ group_ids: [], emails: [], use_job_contacts: true,
      picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }, { id: 'p2', name: 'Paving Oak St' }] });
    resetPage(); SENT.length = 0;
    res = await run(contactsOnly);
    assert('contacts only: the job with contacts gets its own email; the one without is skipped, by name',
      res.status === 'sent' && SENT.length === 1 && sortJ(SENT[0].to) === sortJ(['jobcontact@acme.test', 'client@acme.test', 'owner@example.com'])
        && /Skipped — No saved contacts for Paving Oak St/.test(res.message), JSON.stringify(res));
    const onlyOak = await mkSched({ group_ids: [], emails: [], use_job_contacts: true, picked_jobs: [{ id: 'p2', name: 'Paving Oak St' }] });
    resetPage(); SENT.length = 0;
    res = await run(onlyOak);
    assert('…and with no job that has any: nothing sent, "No saved contacts for …"',
      res.status === 'skipped' && SENT.length === 0 && res.message === 'Nothing to send — No saved contacts for Paving Oak St', JSON.stringify(res));
    assert('…and nothing logged for what was not sent', (await crRuns(onlyOak.id)).length === 0);

    // A saved contact the mail service would refuse (saved before the check).
    await client.query("INSERT INTO report_contacts (company_code, division, project_id, email) VALUES ($1, 'paving', 'p1', 'typo@acme..test')", [CO]);
    resetPage(); SENT.length = 0;
    res = await run(contactsOnly);
    assert('a saved contact that is not a valid address is left off, named, and the fix is the contacts',
      res.status === 'partial' && SENT.length === 1 && !SENT[0].to.includes('typo@acme..test')
        && /Left off typo@acme\.\.test \(contact on Paving Maple Ave\) — not a valid email address; fix it in the job's saved contacts\./.test(res.message), JSON.stringify(res));
    await client.query("DELETE FROM report_contacts WHERE email = 'typo@acme..test'");

    // Saved jobs, one report, one customer: every job's contacts.
    const acme = await mkSched({ custom_report_id: REP_ACME, jobs_mode: 'saved', use_job_contacts: true });
    resetPage(); SENT.length = 0;
    res = await run(acme);
    const svSpec = PAGE.specs[0] || {};
    assert('a saved-jobs report: one build with no job, its mode "saved"', svSpec.jobsMode === 'saved' && svSpec.projectId === null && PAGE.specs.length === 1,
      JSON.stringify(PAGE.specs.map(x => [x.jobsMode, x.projectId])));
    assert('…one email, to the group and the contacts of its jobs (one customer\'s)',
      res.status === 'sent' && SENT.length === 1 && sortJ(SENT[0].to) === sortJ(['pm1@example.com', 'owner@example.com', 'jobcontact@acme.test', 'client@acme.test']),
      JSON.stringify([res, SENT.map(m => m.to)]));
    const svRun = (await crRuns(acme.id))[0];
    assert('…logged with both jobs', svRun && JSON.stringify(svRun.project_ids) === '["p1","p3"]' && svRun.has_archive, JSON.stringify(svRun && svRun.project_ids));

    // Saved jobs that span two customers (the report changed after it was
    // scheduled): never to their contacts — the rest still get it, and the
    // row says why.
    const sv = await row(savedId);
    await client.query('UPDATE report_schedules SET use_job_contacts = true WHERE id = $1', [savedId]);
    resetPage(); SENT.length = 0;
    res = await run(await row(savedId));
    assert('a report covering two customers\' jobs does not go to their contacts, only to the group, and the row says why',
      res.status === 'partial' && SENT.length === 1 && sortJ(SENT[0].to) === sortJ(['pm1@example.com', 'owner@example.com'])
        && /not sent to the jobs' saved contacts — it covers more than one customer's jobs/.test(res.message), JSON.stringify([res, SENT.map(m => m.to)]));
    const svRun2 = (await crRuns(savedId))[0];
    assert('…logged with both jobs and only those recipients', svRun2 && JSON.stringify(svRun2.project_ids) === '["p1","p2"]'
      && sortJ(svRun2.recipients) === sortJ(['pm1@example.com', 'owner@example.com']), JSON.stringify(svRun2 && svRun2.recipients));
    await client.query("UPDATE report_schedules SET use_job_contacts = true, group_ids = '[]'::jsonb WHERE id = $1", [savedId]);
    resetPage(); SENT.length = 0;
    res = await run(await row(savedId));
    assert('…and with nobody else to send to, nothing goes', res.status === 'failed' && SENT.length === 0
      && /covers more than one customer's jobs/.test(res.message), JSON.stringify(res));
    await client.query('UPDATE report_schedules SET use_job_contacts = $2, group_ids = $3 WHERE id = $1', [savedId, sv.use_job_contacts, JSON.stringify(sv.group_ids)]);

    const allIp = await mkSched({ jobs_mode: 'all_in_progress' });
    resetPage(); SENT.length = 0;
    res = await run(allIp);
    assert('all In Progress jobs in one report: one build with no job', res.status === 'sent' && SENT.length === 1 && PAGE.specs.length === 1
      && PAGE.specs[0].jobsMode === 'all_in_progress' && PAGE.specs[0].projectId === null, JSON.stringify(res));

    // A definition saved without the flag at all still reaches the page
    // with internal data explicitly off.
    const noFlagDef = def();
    delete noFlagDef.includeInternal;
    const noFlag = await mkSched({ custom_report_id: await mkReport('No Flag', { definition: noFlagDef }), picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }] });
    resetPage(); SENT.length = 0;
    res = await run(noFlag);
    assert('a definition saved without an internal-data flag reaches the page with it explicitly off',
      res.status === 'sent' && PAGE.specs.length === 1 && PAGE.specs[0].customReport.definition.includeInternal === false, JSON.stringify(PAGE.specs[0] && PAGE.specs[0].customReport));

    // Round 6: report_blocked is the runner's own refusal, so a definition
    // whose flag is the string "true" (not the boolean every check reads)
    // lists no refusal — the run sends it, with internal data off.
    const stringy = await mkReport('Stringy', { definition: def({ includeInternal: 'true' }), customerSafe: true });
    const stR = await crs('POST', {}, { ...base, custom_report_id: stringy, picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }] }, ADMIN);
    assert('a report whose includeInternal is the string "true": scheduled, report_blocked null, report_customer_safe true',
      stR.statusCode === 200 && stR.body.schedule.report_blocked === null && stR.body.schedule.report_customer_safe === true, show(stR));
    const stLs = stR.statusCode === 200 && (await crs('GET', {}, null, ADMIN)).body.schedules.find(x => x.id === Number(stR.body.schedule.id));
    assert('…and the schedules list reads the same', stLs && stLs.report_blocked === null, JSON.stringify(stLs));
    resetPage(); SENT.length = 0;
    res = stR.statusCode === 200 ? await run(await row(stR.body.schedule.id)) : {};
    assert('…as the run agrees: it sends, with internal data off in the definition it is given',
      res.status === 'sent' && PAGE.specs.length === 1 && PAGE.specs[0].customReport.definition.includeInternal === false, JSON.stringify(res));

    // Every In Progress job, none picked.
    const every = await mkSched({});
    resetPage(); SENT.length = 0;
    res = await run(every);
    assert('every In Progress job, none picked: one email each for the two In Progress jobs',
      res.status === 'sent' && SENT.length === 2 && JSON.stringify(PAGE.specs.map(x => x.projectId)) === '["p1","p2"]', JSON.stringify(res));

    // The internal mark, refused whatever the page did.
    resetPage(); SENT.length = 0; PAGE.mark = true;
    const markSched = await mkSched({ picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }] });
    res = await run(markSched);
    assert('a report that comes back carrying the internal mark is not sent, and the run says why',
      res.status === 'failed' && SENT.length === 0 && /Paving Maple Ave: it carries internal data, and scheduled sends are customer-safe only — not sent\./.test(res.message),
      JSON.stringify(res));
    assert('…and nothing is logged as sent', (await crRuns(markSched.id)).length === 0);
    resetPage(); SENT.length = 0; PAGE.flagInternal = true;
    res = await run(markSched);
    assert('…nor one whose record says it included internal data', res.status === 'failed' && SENT.length === 0 && /customer-safe only/.test(res.message), JSON.stringify(res));

    // A page that builds other jobs than it was asked for: not sent, to anyone.
    resetPage(); SENT.length = 0; PAGE.stray = 'p3';
    res = await run(markSched);
    assert('an every-job report the page built for another job too is not sent, to anyone, and says so',
      res.status === 'failed' && SENT.length === 0 && /the page built it for p3, not the job it was asked for — not sent\./.test(res.message), JSON.stringify(res));
    resetPage(); SENT.length = 0; PAGE.stray = 'p2';
    res = await run(acme);
    assert('…nor a saved report built with a job it does not save', res.status === 'failed' && SENT.length === 0
      && /the page built it for p2, not the jobs it was asked for/.test(res.message), JSON.stringify(res));

    // A build that throws for one job: the other still goes.
    resetPage(); SENT.length = 0; PAGE.throwFor = 'p1';
    res = await run(every);
    assert('one job\'s build failing does not stop the next', res.status === 'partial' && SENT.length === 1 && /Paving Oak St/.test(SENT[0].subject)
      && /Paving Maple Ave: boom/.test(res.message), JSON.stringify(res));

    // Continuing where the last pass stopped.
    const occ = new Date(Date.now() - 60000);
    resetPage(); SENT.length = 0;
    res = await run(every, { occurrence: occ, resume: { occurrence: occ.toISOString(), done: ['p1'], sent: 1, attempted: 1, problems: [], passes: 1, total: 2 } });
    assert('a pass that continues an occurrence sends only the job not yet sent, and reports on the whole',
      res.status === 'sent' && SENT.length === 1 && /Oak St/.test(SENT[0].subject) && res.message === 'Sent 2 reports to 2 recipients (over 2 runs).',
      JSON.stringify(res));

    // The log failing never fails the send.
    resetPage(); SENT.length = 0; DB.failRunInsert = true;
    const failLog = await mkSched({ picked_jobs: [{ id: 'p2', name: 'Paving Oak St' }] });
    res = await run(failLog);
    DB.failRunInsert = false;
    assert('a history write that fails does not fail a send that went', res.status === 'sent' && SENT.length === 1 && !res.logged, JSON.stringify(res));
    assert('…and leaves nothing half-written (no row, so no archive)', (await crRuns(failLog.id)).length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nA run handed to the next pass keeps its progress only for the same report');
  {
    const sched = await mkSched({});
    const claim = async id => {
      const tok = runner.newClaimToken();
      const r = await client.query(`UPDATE report_schedules SET claimed_at = NOW(), claim_token = $2 WHERE id = $1
        RETURNING *, extract(epoch FROM updated_at)::text AS updated_epoch`, [id, tok]);
      return { sched: r.rows[0], tok };
    };
    const occ = new Date(Date.now() - 60000);
    const state = { done: ['p1'], sent: 1, attempted: 1, problems: [], passes: 1 };
    let c = await claim(sched.id);
    assert('unchanged: handed back with its progress',
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state }) === true && JSON.stringify((await row(sched.id)).resume_state.done) === '["p1"]');
    c = await claim(sched.id);
    await crs('PUT', { id: sched.id }, { ...base, custom_report_id: TPL2 }, ADMIN);
    assert('pointed at another saved report mid-send: handed back, but started over',
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state }) === true && (await row(sched.id)).resume_state === null);
    c = await claim(sched.id);
    await crs('PUT', { id: sched.id }, { ...base, custom_report_id: TPL2, jobs_mode: 'all_in_progress' }, ADMIN);
    assert('…and so with another jobs mode',
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state }) === true && (await row(sched.id)).resume_state === null);
    c = await claim(sched.id);
    await client.query('UPDATE report_schedules SET custom_report_id = NULL WHERE id = $1', [sched.id]);
    assert('…and when the report behind it is purged mid-send',
      await runner.handBack(sql, c.sched, c.tok, { occurrence: occ, state }) === true && (await row(sched.id)).resume_state === null);
    const label = runner.runLabel;
    assert('history labels: report name and the jobs it covered',
      label({ report_type: 'paving_custom_report', project_id: '*', picked_jobs: [{ id: 'a' }, { id: 'b' }], jobs_mode: 'each', options: { report_name: 'R' } }) === 'R — 2 picked jobs'
        && label({ report_type: 'paving_custom_report', project_id: '*', jobs_mode: 'each', options: { report_name: 'R' } }) === 'R — each In Progress job'
        && label({ report_type: 'paving_custom_report', project_id: null, jobs_mode: 'all_in_progress', options: { report_name: 'R' } }) === 'R — all In Progress jobs'
        && label({ report_type: 'paving_custom_report', project_id: null, jobs_mode: 'saved', options: { report_name: 'R' } }, 'Renamed') === 'Renamed'
        && label({ report_type: 'paving_daily_pm', project_id: 'p1', project_name: 'Maple' }) === 'Maple');
    const spec = runner.specFor({ report_type: 'paving_custom_report', project_id: '*', jobs_mode: 'each', picked_jobs: [{ id: 'p1', name: 'M' }], timezone: 'America/Chicago', options: {} },
      catalog.SCHEDULABLE.paving_custom_report, new Date('2026-11-10T03:00:00Z'));
    assert('the spec: one email per picked job, "today" in the schedule\'s zone, and no period of its own',
      spec.jobsMode === 'each' && spec.projectId === '*' && JSON.stringify(spec.pickedJobs) === '[{"id":"p1","name":"M"}]' && spec.today === '2026-11-09'
        && !('start' in spec) && !('end' in spec), JSON.stringify(spec));
    const spec2 = runner.specFor({ report_type: 'paving_custom_report', project_id: 'p9', jobs_mode: 'saved', options: {} }, catalog.SCHEDULABLE.paving_custom_report, new Date());
    assert('…and a saved-jobs one: no job, whatever the row says', spec2.jobsMode === 'saved' && spec2.projectId === null, JSON.stringify(spec2));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log('\nSend now, through the new endpoint');
  {
    const sched = await mkSched({ subject: 'Owner update', picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }] });
    const before = await row(sched.id);
    resetPage(); SENT.length = 0; FAKE.launched = 0;
    let r = await crs('POST', { id: sched.id, action: 'run' }, null, L3);
    assert('level3 presses Send now: it is built and sent inside the request, and the answer says how it went',
      r.statusCode === 200 && r.body.ok && r.body.result.status === 'sent' && r.body.result.sent === 1 && SENT.length === 1 && FAKE.launched === 1, show(r));
    assert('…to its recipients, with its subject', SENT[0] && SENT[0].subject === 'Owner update — Paving Maple Ave'
      && sortJ(SENT[0].to) === sortJ(['pm1@example.com', 'owner@example.com']), JSON.stringify(SENT[0] && [SENT[0].subject, SENT[0].to]));
    const after = await row(sched.id);
    assert('…the timetable left alone, the claim let go, the row saying it was sent',
      String(after.next_run_at) === String(before.next_run_at) && after.claimed_at === null && after.claim_token === null && after.last_status === 'sent');
    const hr = (await schedRuns(sched.id)).slice(-1)[0];
    assert('…recorded as a Send now by level3, under the report\'s name',
      hr && hr.run_kind === 'manual' && hr.triggered_by === 'pl3' && hr.report_name === 'Owner Update' && hr.status === 'sent', JSON.stringify(hr));
    const lr = await crRuns(sched.id);
    assert('…and in the report\'s own history as send_now, its HTML archived',
      lr.length === 1 && lr[0].run_kind === 'send_now' && Number(lr[0].schedule_id) === Number(sched.id) && lr[0].has_archive
        && /Paving Maple Ave/.test(gunzip(lr[0].html_gzip_b64)), JSON.stringify(lr.map(x => x.run_kind)));
    assert('…sent as the account the schedule runs as', lr[0] && lr[0].run_by_username === 'padmin');
    assert('…and the row comes back fresh', r.body.schedule && r.body.schedule.id === Number(sched.id) && r.body.schedule.last_status === 'sent', show(r));

    await client.query('UPDATE report_schedules SET claimed_at = NOW(), claim_token = $2 WHERE id = $1', [sched.id, 'someone-else']);
    r = await crs('POST', { id: sched.id, action: 'run' }, null, ADMIN);
    assert('while another run holds it: 409, nothing sent twice', r.statusCode === 409 && r.body.error === 'busy', show(r));
    await client.query('UPDATE report_schedules SET claimed_at = NULL, claim_token = NULL WHERE id = $1', [sched.id]);
    const pm = Number((await client.query(`INSERT INTO report_schedules (company_code, report_type, division, project_id, frequency, send_time, group_ids, run_as_user_id)
      VALUES ($1, 'paving_daily_pm', 'paving', 'p1', 'daily', '06:00', $2, $3) RETURNING id`, [CO, JSON.stringify([G1]), adminId])).rows[0].id);
    r = await crs('POST', { id: pm, action: 'run' }, null, ADMIN);
    assert('another report type cannot be sent through it (404)', r.statusCode === 404, show(r));
    await client.query('DELETE FROM report_schedules WHERE id = $1', [pm]);

    // Send now on a custom row from Manage Users → Auto Reports: logged as send_now too.
    resetPage(); SENT.length = 0;
    r = await ars('POST', { id: sched.id, action: 'run' }, null, BOSS);
    const lr2 = await crRuns(sched.id);
    assert('Send now from Auto Reports sends it too, logged as send_now',
      r.statusCode === 200 && r.body.result.status === 'sent' && lr2.length === 2 && lr2[1].run_kind === 'send_now'
        && r.body.schedule.managed_in === 'custom_reporting', show(r));
    r = await crs('DELETE', { id: sched.id }, null, ADMIN);
    assert('deleted through the new endpoint', r.statusCode === 200 && r.body.deleted === true && !(await row(sched.id)), show(r));
  }

  // ─────────────────────────────────────────────────────────────────────
  await robotRun(sql, { ADMIN, adminId, TPL, REP, G1 });

  await cleanUp();
  await client.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error(err);
  try { await cleanUp(); await client.end(); } catch { /* best effort */ }
  process.exit(1);
});

// ── The real robot: headless Chrome, paving.html, a fake data API ──────────
async function robotRun(sql, { TPL, REP, G1 }) {
  console.log('\nThe real robot: a scheduled custom report built in paving.html');
  if (process.env.SKIP_ROBOT === '1') { console.log('  (SKIP_ROBOT=1 — the robot section is skipped)'); return; }
  const CHROME = [
    process.env.CHROME_EXECUTABLE_PATH,
    '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
    '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].find(p => p && fs.existsSync(p));
  if (!CHROME) { console.log('  (no Chrome/Chromium on this box — the robot section is skipped)'); return; }
  process.env.CHROME_EXECUTABLE_PATH = CHROME;
  if (process.env.CHROME_SINGLE_PROCESS == null) process.env.CHROME_SINGLE_PROCESS = '0';

  const today = new Date();
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return ymd(d); };
  const proj = (id, name, status, job, clientName) => ({
    id, 'project-name': name, 'job-number': job, status, client: clientName,
    'start-date': daysAgo(250), 'end-date': ymd(new Date(today.getTime() + 60 * 864e5)), 'contract-amount': 250000,
    bidItems: [
      { id: id + '-b1', cost_code: '0100', sub_code: 'Excavation', unit: 'CY', quantity: 1000, unit_cost: 12, description: 'Excavation' },
      { id: id + '-b2', cost_code: '0200', sub_code: 'Stone Base', unit: 'TON', quantity: 400, unit_cost: 30, description: 'Stone' },
    ],
  });
  const projects = [
    proj('p1', 'Paving Maple Ave', 'In Progress', '26101', 'Acme Township'),
    proj('p2', 'Paving Oak St', 'In Progress', '26102', 'Beta Co'),
    proj('p3', 'Paving Done Job', 'Complete', '25009', 'Acme Township'),
  ];
  const STORE = {
    fct_paving_projects_index: projects.map(p => p.id),
    fct_paving_lists: { employees: [{ name: 'Sam' }], equipment: [], cost_codes: [], job_classes: [] },
  };
  projects.forEach(p => { STORE[`fct_paving_project_${p.id}`] = p; });
  // The same jobs on the Turf and Kiewit pages, for their own registrations.
  for (const pfx of ['fct_', 'fct_kiewit_']) {
    STORE[`${pfx}projects_index`] = projects.map(p => p.id);
    STORE[`${pfx}lists`] = STORE.fct_paving_lists;
    projects.forEach(p => { STORE[`${pfx}project_${p.id}`] = { ...p, 'project-name': p['project-name'].replace('Paving', pfx === 'fct_' ? 'Turf' : 'Kiewit') }; });
  }
  const ROWS = [];
  let n = 1;
  for (const p of projects.slice(0, 2)) {
    ROWS.push({ id: String(n++), _projectId: p.id, date: daysAgo(1), cost_code: '0100', sub_code: 'Excavation',
      quantity: 120, labor_hours: 32, equip_hours: 8, material_cost: 0, employee: 'Sam', job_class: 'Operator', rate: 45 });
    ROWS.push({ id: String(n++), _projectId: p.id, date: daysAgo(9), cost_code: '0100', sub_code: 'Excavation',
      quantity: 77, labor_hours: 20, equip_hours: 4, material_cost: 0, employee: 'Sam', job_class: 'Operator', rate: 45 });
  }

  // The page's own registration is the pages' (spec §7). Until it is there,
  // a stand-in that keeps the same contract is added to the served page —
  // only when the page has not registered the type itself.
  const pageSrc = fs.readFileSync(path.join(ROOT, 'paving.html'), 'utf8');
  const INJECT = `<script>
(function () {
  var AR = window.dwAutoReport;
  if (!AR || AR.has('paving_custom_report')) return;
  window.__crInjected = true;
  function g(n) { try { return (0, eval)(n); } catch (e) { return undefined; } }
  AR.register('paving_custom_report', async function (spec) {
    try { fetch('/__cr_stand_in_used').catch(function () {}); } catch (e) { /* only a marker */ }
    var E = window.FCTReportEngine;
    var cr = spec.customReport || {};
    var def = E.normalizeDefinition(cr.definition);
    def.includeInternal = false;
    var perm = g('perm') || {};
    var cfg = typeof g('_crEngineCfg') === 'function' ? g('_crEngineCfg')() : {
      division: g('DIVISION'), divisionLabel: 'Paving', apiBase: g('API_BASE'), user: g('fctUser'),
      perm: { role: perm.role, canSeeCosts: perm.canSeeCosts !== false, canSeeFinancials: !perm.visibleTabs || perm.visibleTabs.has('financials'),
        canShare: ['admin', 'level3'].indexOf(perm.role) >= 0 },
      areaUnit: 'SY',
      getProjects: function () { return g('projectsList') || []; },
      getPurchaseOrders: function () { return g('purchaseOrders') || []; },
      getTruckingEntries: function () { return g('truckingEntries') || []; },
      helpers: { dailyRowCost: g('dailyRowCost'), calcDaily: g('calcDaily'), bidItemComplete: g('bidItemComplete'), bidProjectPct: g('bidProjectPct'),
        bidGroupPct: g('bidGroupPct'), projForBidItem: g('projForBidItem'), projectedCostForProject: g('projectedCostForProject'),
        gpEarnedToDate: g('gpEarnedToDate'), bidContractFigures: g('bidContractFigures'), projIsDone: g('projIsDone'),
        lineAmt: g('_lineAmt'), lineTax: g('_lineTax'), addWorkingDays: g('_addWorkingDays') }
    };
    var list = g('projectsList') || [];
    var ids = spec.jobsMode === 'each' ? [spec.projectId]
      : spec.jobsMode === 'all_in_progress' ? list.filter(function (p) { return String(p.status || '').trim() === 'In Progress'; }).map(function (p) { return p.id; })
      : def.jobs.ids;
    var ctx = E.makeContext(def, cfg, { pickedIds: ids, today: spec.today, reportName: cr.name, userName: (g('fctUser') || {}).username });
    var html = E.buildReportHtml(def, ctx);
    if (E.hasInternal(def, cfg.perm, cfg.division) || /data-cr-internal="1"/.test(html)) {
      return { skip: 'Report has internal data — scheduled sends are customer-safe only' };
    }
    var jobs = ctx.jobs || [];
    return { html: html, subject: cr.name + ' — ' + (jobs.length === 1 ? jobs[0]['project-name'] : jobs.length + ' jobs'),
      projectId: spec.jobsMode === 'each' ? spec.projectId : null, projectName: null,
      customReport: { report_id: cr.id, report_name: cr.name, project_ids: jobs.map(function (j) { return String(j.id); }),
        project_names: jobs.map(function (j) { return j['project-name'] || ''; }), clients: jobs.map(function (j) { return j.client || ''; }),
        date_from: (ctx.range && ctx.range.from) || null, date_to: (ctx.range && ctx.range.to) || null, definition: def, included_internal: false } };
  }, { perJob: true });
})();
</script>`;
  // A page whose builder hands back a report with the internal mark on it —
  // to see the runner refuse it however it got there.
  const MARKED = `<script>
(function () {
  window.dwAutoReport.register('paving_custom_report', async function (spec) {
    return { html: '<div class="masthead" data-dw-brand data-cr-internal="1">Cost to date $123,456</div>', subject: 'Marked',
      customReport: { report_id: spec.customReport.id, report_name: spec.customReport.name, project_ids: [spec.projectId], project_names: ['Paving Maple Ave'] } };
  }, { perJob: true });
})();
</script>`;
  const MODE = { marked: false, standIn: 0 };
  const writes = [];
  const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const u = new (require('url').URL)(req.url, 'http://x');
    const p = decodeURIComponent(u.pathname);
    if (p === '/__cr_stand_in_used') { MODE.standIn++; res.writeHead(204); return res.end(); }
    if (p.startsWith('/api/')) {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { writes.push(req.method + ' ' + p); return json(res, { ok: true }); }
      if (!/^Bearer .+\..+\..+/.test(String(req.headers.authorization || ''))) return json(res, { error: 'Unauthorized' }, 401);
      if (p === '/api/data/_batch') {
        const keys = (u.searchParams.get('keys') || '').split(',').filter(Boolean);
        return json(res, { values: Object.fromEntries(keys.filter(k => k in STORE).map(k => [k, STORE[k]])) });
      }
      if (p === '/api/data/_keys') return json(res, { keys: [] });
      if (p.startsWith('/api/data/')) { const key = p.slice('/api/data/'.length); return json(res, { value: key in STORE ? STORE[key] : null }); }
      if (p === '/api/daily-rows') {
        const since = u.searchParams.get('since');
        return json(res, { rows: ['paving', 'turf', 'kiewit'].includes(u.searchParams.get('division') || 'turf') ? ROWS.filter(r => !since || r.date >= since) : [], hasMore: false });
      }
      if (p === '/api/purchase-orders') return json(res, { purchaseOrders: [] });
      if (p === '/api/trucking') return json(res, { truckingEntries: [] });
      if (p === '/api/deadlines') return json(res, { deadlines: [] });
      if (p === '/api/company/branding') return json(res, { ok: true, branding: null, canEdit: false });
      if (p === '/api/employees') return json(res, { ok: true, people: [] });
      if (p === '/api/custom-reports') return json(res, { ok: true, reports: [], canShare: true });
      if (p === '/api/report-contacts') return json(res, { ok: true, contacts: [], canEdit: false });
      return json(res, {});
    }
    if (p === '/paving.html') {
      const extra = INJECT + (MODE.marked ? MARKED : '');
      const html = pageSrc.includes('</body>') ? pageSrc.replace(/<\/body>(?![\s\S]*<\/body>)/, extra + '</body>') : pageSrc + extra;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await realPdf.launchBrowser();
  } catch (err) {
    server.close();
    assert('Chrome starts for the robot', false, err.message);
    return;
  }
  const crRunsOf = async id => (await client.query(
    `SELECT r.*, a.html_gzip_b64 FROM custom_report_runs r LEFT JOIN custom_report_run_archives a ON a.run_id = r.id
      WHERE r.schedule_id = $1 ORDER BY r.id`, [id])).rows;
  try {
    // The definition the robot builds: job card and progress, customer-safe.
    await client.query('UPDATE custom_reports SET definition = $2 WHERE id = $1', [TPL, JSON.stringify({
      v: 2, title: 'Owner Update', jobs: { mode: 'pick', ids: [] }, layout: 'separate', dates: { preset: 'job_to_date', from: '', to: '' },
      includeInternal: false, header: { preparedFor: 'Acme Township', showGenerated: true },
      sections: [{ type: 'job_info' }, { type: 'bid_progress' }],
    })]);
    const mk = async over => {
      const r = await crs('POST', {}, { ...base(), ...over }, (await adminAuth()));
      if (r.statusCode !== 200) throw new Error('robot schedule not saved: ' + show(r));
      return row(r.body.schedule.id);
    };
    function base() {
      return { custom_report_id: TPL, jobs_mode: 'each', frequency: 'weekly', days_of_week: [1], send_time: '07:00',
        timezone: 'America/New_York', group_ids: [G1], emails: ['super@example.com'], use_job_contacts: true,
        subject: 'Owner update', note: 'Numbers through yesterday.', attach_pdf: true, enabled: true };
    }
    async function adminAuth() {
      const id = (await client.query("SELECT id FROM users WHERE username = 'padmin' AND company_code = $1", [CO])).rows[0].id;
      return { companyCode: CO, userId: id, username: 'padmin', role: 'level1', divisionRoles: { paving: 'admin' } };
    }

    const sched = await mk({ picked_jobs: [{ id: 'p1', name: 'Paving Maple Ave' }] });
    SENT.length = 0; writes.length = 0;
    let res = await runner.runSchedule(sql, sched, { browser, baseUrl, now: new Date() });
    const m = SENT[0] || {};
    assert('the robot opens paving.html, builds the saved report for the job and sends it',
      res.status === 'sent' && res.sent === 1 && SENT.length === 1, JSON.stringify(res));
    const pdf = (m.attachments || []).find(a => a.contentType === 'application/pdf');
    assert('…as a real PDF', pdf && Buffer.from(pdf.content, 'base64').subarray(0, 5).toString() === '%PDF-', JSON.stringify((m.attachments || []).map(a => a.filename)));
    assert('…with the schedule\'s subject and note', m.subject === 'Owner update — Paving Maple Ave' && /Numbers through yesterday\./.test(m.html || ''), m.subject);
    assert('…to the group, the schedule\'s address and the job\'s and its client\'s saved contacts — once each',
      sortJ(m.to || []) === sortJ(['pm1@example.com', 'owner@example.com', 'super@example.com', 'jobcontact@acme.test', 'client@acme.test']), JSON.stringify(m.to));
    assert('…and the robot wrote nothing', writes.length === 0, writes.join(', '));
    const logged = await crRunsOf(sched.id);
    const l0 = logged[0] || {};
    const archived = l0.html_gzip_b64 ? gunzip(l0.html_gzip_b64) : '';
    assert('the report\'s history has the send: run_kind schedule, the job, internal off',
      logged.length === 1 && l0.run_kind === 'schedule' && l0.action === 'email' && JSON.stringify(l0.project_ids) === '["p1"]'
        && l0.included_internal === false && l0.definition && l0.definition.includeInternal === false && Number(l0.report_id) === TPL,
      JSON.stringify(logged.map(x => ({ k: x.run_kind, ids: x.project_ids, i: x.included_internal }))));
    assert('…and the archive holds the report the engine built in the page: the job card and its bid items, customer-safe',
      /Paving Maple Ave/.test(archived) && /0100/.test(archived) && /Excavation/.test(archived) && /data-dw-brand/.test(archived)
        && !/data-cr-internal/.test(archived) && !/<script/i.test(archived), archived.slice(0, 300));

    // includeInternal forced off by the page, whatever the definition says.
    const spec = {
      type: 'paving_custom_report', projectId: 'p1', projectName: 'Paving Maple Ave', options: {}, timezone: 'America/New_York',
      today: ymd(today), jobsMode: 'each',
      customReport: { id: TPL, name: 'Owner Update', version: 1, definition: {
        v: 2, title: 'Owner Update', jobs: { mode: 'pick', ids: [] }, dates: { preset: 'job_to_date' }, includeInternal: true,
        sections: [{ type: 'job_info', columns: ['project-name', 'contract'] }, { type: 'bid_progress', columns: ['cost_code', 'bid_qty', 'actual_cost', 'labor_hours'] }],
      } },
    };
    const built = await runner.buildInBrowser(browser, { baseUrl, def: catalog.SCHEDULABLE.paving_custom_report, acct: {
      userId: 1, username: 'padmin', companyCode: CO, companyName: 'Schedules test', role: 'level1', divisionRoles: { paving: 'admin' },
      allowedDivisions: ['paving'], isPlatformAdmin: false }, spec });
    const it = built.items[0];
    assert('handed a definition with internal data on, the page builds it with internal data off: no internal mark, no internal column',
      built.items.length === 1 && !/data-cr-internal/.test(it.html) && /Paving Maple Ave/.test(it.html)
        && !/Actual Cost|Labor Hours|Contract Value/i.test(it.html), JSON.stringify({ n: built.items.length, errs: built.errors, skipped: built.skipped }));
    assert('…and says so in the record it hands back', it && it.customReport && it.customReport.definition
      && it.customReport.definition.includeInternal === false && JSON.stringify(it.customReport.project_ids) === '["p1"]',
      JSON.stringify(it && it.customReport && { inc: it.customReport.definition && it.customReport.definition.includeInternal, ids: it.customReport.project_ids }));

    // A page that hands back the internal mark anyway: refused by the runner.
    MODE.marked = true;
    SENT.length = 0;
    res = await runner.runSchedule(sql, await row(sched.id), { browser, baseUrl, now: new Date() });
    MODE.marked = false;
    assert('a report that comes back from the page with the internal mark is refused, and nothing is sent',
      res.status === 'failed' && SENT.length === 0 && /carries internal data, and scheduled sends are customer-safe only/.test(res.message), JSON.stringify(res));
    assert('…nor logged', (await crRunsOf(sched.id)).length === 1);

    // An internal report is refused before the robot even opens the page.
    await client.query("UPDATE custom_reports SET customer_safe = false WHERE id = $1", [TPL]);
    SENT.length = 0;
    res = await runner.runSchedule(sql, await row(sched.id), { browser, baseUrl, now: new Date() });
    await client.query("UPDATE custom_reports SET customer_safe = true WHERE id = $1", [TPL]);
    assert('a report switched to internal data is not built at all', res.status === 'failed' && SENT.length === 0 && /customer-safe only/.test(res.message), res.message);

    // The saved-jobs report, both jobs in one email.
    await client.query('UPDATE custom_reports SET definition = $2 WHERE id = $1', [REP, JSON.stringify({
      v: 2, title: 'Route 30 Weekly', jobs: { mode: 'saved', ids: ['p1', 'p2'] }, layout: 'separate', dates: { preset: 'last_7' },
      includeInternal: false, sections: [{ type: 'job_info' }, { type: 'daily_production' }],
    })]);
    const saved = await mk({ custom_report_id: REP, jobs_mode: 'saved', use_job_contacts: false, subject: null });
    SENT.length = 0;
    res = await runner.runSchedule(sql, saved, { browser, baseUrl, now: new Date() });
    const sm = SENT[0] || {};
    const sl = (await crRunsOf(saved.id))[0] || {};
    assert('a saved-jobs report goes as one email covering both its jobs, under the page\'s subject',
      res.status === 'sent' && SENT.length === 1 && /Route 30 Weekly/.test(sm.subject || '')
        && JSON.stringify(sl.project_ids) === '["p1","p2"]' && /Paving Oak St/.test(sl.html_gzip_b64 ? gunzip(sl.html_gzip_b64) : ''),
      JSON.stringify({ res, subject: sm.subject, ids: sl.project_ids }));
    // Turf and Kiewit, once their pages register the type: the same build.
    for (const [div, page, label] of [['turf', 'tracker.html', 'Turf'], ['kiewit', 'kiewit-pinetree.html', 'Kiewit']]) {
      const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
      if (!src.includes(`'${div}_custom_report'`)) { console.log(`  (${page} does not register ${div}_custom_report yet — not built)`); continue; }
      const out = await runner.buildInBrowser(browser, { baseUrl, def: catalog.SCHEDULABLE[`${div}_custom_report`], acct: {
        userId: 1, username: 'padmin', companyCode: CO, companyName: 'Schedules test', role: 'admin', divisionRoles: { [div]: 'admin' },
        allowedDivisions: [div], isPlatformAdmin: false }, spec: { ...spec, type: `${div}_custom_report` } });
      const one = out.items[0];
      assert(`${page} builds a scheduled custom report too: the job, customer-safe, with its record`,
        out.items.length === 1 && new RegExp(`${label} Maple Ave`).test(one.html) && !/data-cr-internal/.test(one.html)
          && one.customReport && JSON.stringify(one.customReport.project_ids) === '["p1"]' && one.customReport.definition.includeInternal === false,
        JSON.stringify({ n: out.items.length, errors: out.errors, skipped: out.skipped }));
    }
    console.log(MODE.standIn
      ? `  (paving.html does not register paving_custom_report yet — the robot used this suite's stand-in registration ${MODE.standIn} time(s); re-run once the page has its own)`
      : '  (built by paving.html\'s own paving_custom_report registration)');
  } finally {
    try { await browser.close(); } catch { /* gone */ }
    server.close();
  }
}
