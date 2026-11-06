#!/usr/bin/env node
'use strict';
/**
 * Custom Reporting, end to end, in a real browser: the division page, the
 * builder, the report engine and the real /api/custom-reports handler against
 * a real Postgres — the whole chain a PM goes through to send a customer an
 * update.
 *
 * Run: node scripts/test-custom-reports-browser.js
 *      PG_TEST_URL defaults to postgres://fct_test_user:test@localhost/fct_test
 *      (auth-schema.sql then neon-schema.sql applied). Skips cleanly when
 *      Playwright or its Chromium is missing, or when there is no test
 *      database to talk to. Refuses a database whose name has no "test" in it.
 *      CR_SCREENS=<dir> also writes design-review screenshots there.
 *
 * Every other Custom Reporting suite stops at a seam: the engine suite feeds
 * the engine page helpers lifted out of paving.html, the UI suite runs the
 * builder in jsdom against a stand-in API, the SQL suite calls the handler
 * with a hand-made req. Each seam can be right on both sides and still wrong
 * where they meet — a field the API sends as a string, a promise the page
 * hands over before boot has replaced it, a print window that never gets its
 * report. So this runs them together, the way production does:
 *
 *   - paving.html boots over HTTP against a fake data API (jobs, daily rows,
 *     the backfill of rows older than 90 days), signed in with a REAL token
 *     the REAL auth guard checks against the users table;
 *   - /api/custom-reports is the real handler on the test database, so the
 *     saved report, its version and the run log are real rows;
 *   - Playwright clicks through it as a person would: a starter, two jobs,
 *     the lock on an internal column, switching internal data on, Save, a
 *     reload, reopening the report, Print, Excel and Email.
 *
 * The customer-safe promise is checked where it matters most — in the HTML
 * the browser actually renders: no employee name, no cost, no INTERNAL tag
 * until someone deliberately switches internal data on.
 *
 * The print is also made to race the backfill: on the reload the older daily
 * rows are held back for several seconds, and the job-to-date figures on the
 * printout must still include them. That is the page's `ready` hand-over and
 * the builder's wait working together; a print that went out early would
 * quietly under-report work to a customer.
 *
 * Custom Reporting v2 runs the same way, every handler real on the test
 * database (branding, contacts, schedules, the AI builder, send-report):
 *   - Turf: a sub-code report built by hand — Turf Install on every In
 *     Progress job, combined — with Planned vs Actual, Division Rates and a
 *     chart, every figure checked against numbers worked out here (scheduled
 *     % on the page's own holiday calendar), in the preview and the print;
 *   - Paving: tons a day and tons per load off a trucking ticket, a chart in
 *     the print;
 *   - branding saved in divisions.html (a real PNG through the logo picker),
 *     then the masthead, the PM line from the Team Directory and the footer;
 *   - a job contact added in Contacts, pre-filled in the email, and a typed
 *     address saved from the email window;
 *   - Customer History: the archived copy opened, and resent;
 *   - a schedule made from the builder, and Send now running the REAL report
 *     robot (headless Chrome on paving.html) into the run log and archive —
 *     then refused, in plain words, once the report carries internal data;
 *   - the AI builder with only the model stubbed (the SDK, server side): a
 *     sub-code report applied, undone, and a request for costs that shows the
 *     "Turn on internal data…" button without switching anything on.
 * CR_SCREENS=<dir> writes desktop (1440) and phone (390) screenshots of each.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const http   = require('http');
const zlib   = require('zlib');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('Playwright is not installed — skipping the Custom Reporting browser checks'); process.exit(0); }

let Client;
try { ({ Client } = require('pg')); }
catch { console.log('pg is not installed — skipping the Custom Reporting browser checks'); process.exit(0); }

const PG_URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (PG_URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}

process.env.JWT_SECRET   = process.env.JWT_SECRET || 'custom-reports-browser-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://stubbed';
// The real send-report handler runs too; only the Resend SDK at the very end
// of it is stubbed, so nothing leaves the box.
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test-resend-key';
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'reports@example.com';
const RESENT = [];   // what reached the (stubbed) Resend SDK
// The AI builder's model is the one thing of it replaced: the SDK, server
// side. Every request body is kept; each answer is the next canned one.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';
const SDK_CALLS = [];
const AI_ANSWERS = [];
class FakeAnthropic {
  constructor() {
    this.messages = {
      stream: (body, opts) => {
        SDK_CALLS.push({ body: JSON.parse(JSON.stringify(body)), opts });
        return { finalMessage: async () => {
          const next = AI_ANSWERS.shift();
          const out = typeof next === 'function' ? next(body) : next;
          return { id: 'msg_test', type: 'message', role: 'assistant', stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(out || {}) }], usage: { input_tokens: 1, output_tokens: 1 } };
        } };
      },
    };
  }
}
// The report robot behind "Send now" is the runner's own headless Chrome.
const ROBOT_CHROME = [
  process.env.CHROME_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  '/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(p => p && fs.existsSync(p));
if (ROBOT_CHROME) process.env.CHROME_EXECUTABLE_PATH = ROBOT_CHROME;
if (process.env.CHROME_SINGLE_PROCESS == null) process.env.CHROME_SINGLE_PROCESS = '0';
for (const k of ['APP_BASE_URL', 'VERCEL_ENV', 'VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) delete process.env[k];
const SCREENS = process.env.CR_SCREENS ? path.resolve(process.env.CR_SCREENS) : '';

const db = new Client({ connectionString: PG_URL });

// The handler and the auth guard both ask the Neon driver for a tagged-template
// `sql`. Here it is the test database, through pg — nothing else is stubbed:
// the token is verified and the account read exactly as in production.
function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(db) };
  if (request === '@anthropic-ai/sdk') return FakeAnthropic;
  if (request === 'resend') {
    return { Resend: class {
      constructor() { this.emails = { send: async o => { RESENT.push(o); return { data: { id: 'stub-' + RESENT.length }, error: null }; } }; }
    } };
  }
  return origLoad.apply(this, arguments);
};
const handler = require(path.join(ROOT, 'api/custom-reports.js'));
const sendReport = require(path.join(ROOT, 'api/email/send-report.js'));
// The v2 handlers, real, on the same test database.
const ROUTES = {
  '/api/company/branding':        require(path.join(ROOT, 'api/company/branding.js')),
  '/api/report-contacts':         require(path.join(ROOT, 'api/report-contacts.js')),
  '/api/custom-report-schedules': require(path.join(ROOT, 'api/custom-report-schedules.js')),
  '/api/ai/report-builder':       require(path.join(ROOT, 'api/ai/report-builder.js')),
  '/api/email/recipient-groups':  require(path.join(ROOT, 'api/email/recipient-groups.js')),
  '/api/email/report-schedules':  require(path.join(ROOT, 'api/email/report-schedules.js')),
};
const API_CALLS = [];   // every request to one of ROUTES: { path, method, query, body }
const jwt     = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
const ok = (label, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail !== undefined && detail !== '' ? '  — ' + String(detail).slice(0, 500) : '')); }
};

// ── Fixtures: the same three jobs on each division page ───────────────────
const today = new Date();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysFrom = n => { const d = new Date(today); d.setDate(d.getDate() + n); return ymd(d); };
const LONG_AGO = daysFrom(-200);   // outside the boot's 90-day window: only the backfill brings it

const JOB1 = 'Maple Ave Resurfacing';
const JOB2 = 'Oak St Parking Lot';
const JOB3 = 'Pine Rd Closeout';
// Things only an internal report may show. Planted in the daily rows; looked
// for in everything the customer-safe report renders.
const SECRET_NAME = 'Kowalski';
const SECRET_RATE = '41.25';

// The Team Directory the builder reads PM phone numbers and "Prepared by"
// from (GET /api/employees?view=people). Maria runs Maple Ave; Pat is the
// person behind the signed-in login.
const PM_NAME = 'Maria Rivera', PM_PHONE = '(717) 555-0142', PM_EMAIL = 'maria.rivera@keystone.example';
const PEOPLE = [
  { name: PM_NAME, phone: PM_PHONE, email: PM_EMAIL, logins: [] },
  { name: 'Pat Quinn', phone: '(717) 555-0199', email: 'pat.quinn@keystone.example', logins: ['pat.admin'] },
];
// Turf Install, planned per day, on both In Progress turf jobs.
const TURF = { p1: { qty: 20000, rate: 2500, start: -10, target: 20 }, p2: { qty: 12000, rate: 1000, start: -6, target: 30 } };

function divisionData(keyPfx, div) {
  const projects = [
    { id: 'p1', 'project-name': JOB1, 'job-number': '26101', status: 'In Progress', client: 'Borough of Maple', pm: 'Rivera, Maria',
      gc: 'Keystone GC', address: '12 Maple Ave', 'city-state': 'Maple, PA', 'start-date': daysFrom(-240),
      'end-date': daysFrom(60), 'contract-amount': 250000,
      bidItems: [
        { id: 'p1-b1', cost_code: '0100', sub_code: 'Milling', description: 'Mill existing surface', unit: 'SY',
          quantity: 1000, unit_cost: 4.5, start_date: daysFrom(-30), target_date: daysFrom(20) },
        { id: 'p1-b2', cost_code: '0200', sub_code: 'Base Course', description: 'Stone base', unit: 'TON',
          quantity: 400, unit_cost: 85, start_date: daysFrom(-10), target_date: daysFrom(30),
          change_orders: [{ date: daysFrom(-5), qty_delta: 50, note: 'Driveway apron added' }] },
      ] },
    { id: 'p2', 'project-name': JOB2, 'job-number': '26102', status: 'In Progress', client: 'Oak Holdings LLC', pm: 'Tom Becker',
      address: '400 Oak St', 'city-state': 'Oakdale, PA', 'start-date': daysFrom(-20), 'end-date': daysFrom(40),
      'contract-amount': 120000,
      bidItems: [{ id: 'p2-b1', cost_code: '0300', sub_code: 'Surface Course', unit: 'SY', quantity: 2500, unit_cost: 18,
        start_date: daysFrom(-15), target_date: daysFrom(25) }] },
    { id: 'p3', 'project-name': JOB3, 'job-number': '25009', status: 'Complete', client: 'Pine Township',
      bidItems: [] },
  ];
  const store = {
    [`${keyPfx}projects_index`]: projects.map(p => p.id),
    [`${keyPfx}lists`]: { employees: [{ name: 'Sam ' + SECRET_NAME }], equipment: [], cost_codes: [], job_classes: [] },
  };
  projects.forEach(p => { store[`${keyPfx}project_${p.id}`] = p; });
  const row = (id, pid, date, cc, sc, qty, cost, emp, hrs) => ({ id, _projectId: pid, date, cost_code: cc, sub_code: sc,
    quantity: qty, total_cost: cost, employee: emp, rate: SECRET_RATE, labor_hours: hrs, job_class: 'Operator',
    field_type: 'Production' });
  const rows = [
    row('1', 'p1', daysFrom(-1), '0100', 'Milling', 120, 1500, 'Sam ' + SECRET_NAME, 8),
    row('2', 'p1', LONG_AGO,     '0100', 'Milling', 77, 900, 'Sam ' + SECRET_NAME, 6),
    row('3', 'p1', daysFrom(-3), '0200', 'Base Course', 60, 3100, 'Dale Brennan', 9),
    row('4', 'p2', daysFrom(-2), '0300', 'Surface Course', 800, 5200, 'Dale Brennan', 10),
  ];
  let trucking = [];
  if (div === 'turf') {
    for (const id of ['p1', 'p2']) {
      const t = TURF[id];
      projects.find(p => p.id === id).bidItems.push({ id: id + '-turf', cost_code: '0400', sub_code: 'Turf Install', description: 'Install sod',
        unit: 'SF', quantity: t.qty, unit_cost: 0.9, planned_rate: t.rate, start_date: daysFrom(t.start), target_date: daysFrom(t.target) });
    }
    rows.push(row('t1', 'p1', daysFrom(-4), '0400', 'Turf Install', 2000, 1100, 'Sam ' + SECRET_NAME, 8),
      row('t2', 'p1', daysFrom(-1), '0400', 'Turf Install', 3000, 1300, 'Sam ' + SECRET_NAME, 9),
      row('t3', 'p2', daysFrom(-3), '0400', 'Turf Install', 1500, 800, 'Dale Brennan', 7));
  }
  if (div === 'kiewit') {
    projects[0].bidItems.push({ id: 'p1-homes', cost_code: '0500', sub_code: 'Home Set', description: 'Set modular homes', unit: 'EA',
      quantity: 40, unit_cost: 9000, planned_rate: 2, start_date: daysFrom(-10), target_date: daysFrom(30) });
    rows.push(row('k1', 'p1', daysFrom(-4), '0500', 'Home Set', 2, 2200, 'Sam ' + SECRET_NAME, 10),
      row('k2', 'p1', daysFrom(-2), '0500', 'Home Set', 3, 2600, 'Dale Brennan', 10));
  }
  if (div === 'paving') {
    // Three loads of stone on the day the base course went down.
    trucking = [{ id: 'tk1', project_id: 'p1', date: daysFrom(-3), tr_number: 'T-101', truck_type: 'Tri-axle', material_hauled: '2A stone',
      loads: 3, status: 'approved', cost_code: '0200', sub_code: 'Base Course', driver: 'Ray ' + SECRET_NAME, hours: 6, rate: 95 }];
  }
  return { store, rows, projects, trucking };
}
const PAGES = {
  paving: { file: 'paving.html',          label: 'Paving',          data: divisionData('fct_paving_', 'paving') },
  turf:   { file: 'tracker.html',         label: 'Turf Management', data: divisionData('fct_', 'turf') },
  kiewit: { file: 'kiewit-pinetree.html', label: 'Kiewit Pinetree', data: divisionData('fct_kiewit_', 'kiewit') },
};
const STORE = Object.assign({}, PAGES.paving.data.store, PAGES.turf.data.store, PAGES.kiewit.data.store);

// ── The server: the repo's files, a fake data API, the real custom-reports ─
const CR_CALLS = [];     // every /api/custom-reports request: method + query
const EMAILS = [];       // bodies POSTed to /api/email/send-report
let BACKFILL_DELAY = 0;  // ms to hold back the full daily-row history

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

// Vercel hands a function req.query / req.body and a res with status().json().
async function runHandler(req, res, u, fn = handler, log = CR_CALLS, p) {
  const raw = await readBody(req);
  let body;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  const query = Object.fromEntries(u.searchParams);
  log.push(fn === handler ? { method: req.method, query, body } : p ? { path: p, method: req.method, query, body } : body);
  let status = 200;
  const out = {
    setHeader() {},
    status(c) { status = c; return out; },
    json(o) { json(res, o, status); return out; },
    end() { res.writeHead(status); res.end(); return out; },
  };
  try { await fn({ method: req.method, query, body, headers: req.headers }, out); }
  catch (err) { json(res, { error: 'handler threw: ' + err.message }, 500); }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname);
  if (p === '/api/custom-reports') return runHandler(req, res, u);
  if (ROUTES[p]) return runHandler(req, res, u, ROUTES[p], API_CALLS, p);
  if (p.startsWith('/api/')) {
    if (p === '/api/email/send-report' && req.method === 'POST') return runHandler(req, res, u, sendReport, EMAILS);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return json(res, { ok: true });
    if (!/^Bearer .+\..+\..+/.test(String(req.headers.authorization || ''))) return json(res, { error: 'Unauthorized' }, 401);
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',').filter(Boolean);
      return json(res, { values: Object.fromEntries(keys.filter(k => k in STORE).map(k => [k, STORE[k]])) });
    }
    if (p === '/api/data/_keys') return json(res, { keys: [] });
    if (p.startsWith('/api/data/')) {
      const key = p.slice('/api/data/'.length);
      return json(res, { value: key in STORE ? STORE[key] : null });
    }
    if (p === '/api/daily-rows') {
      const d = PAGES[u.searchParams.get('division') || 'turf'];
      const since = u.searchParams.get('since');
      const rows = (d ? d.data.rows : []).filter(r => !since || r.date >= since);
      const send = () => json(res, { rows, hasMore: false });
      if (!since && BACKFILL_DELAY) return setTimeout(send, BACKFILL_DELAY);
      return send();
    }
    if (p === '/api/purchase-orders') return json(res, { purchaseOrders: [] });
    if (p === '/api/trucking') {
      const d = PAGES[u.searchParams.get('division') || 'turf'];
      return json(res, { truckingEntries: d ? d.data.trucking : [] });
    }
    if (p === '/api/employees') return json(res, { employees: PEOPLE });
    return json(res, {});
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
});

// ── Reading what came out ────────────────────────────────────────────────
// A .xlsx is a zip. Read its central directory; stored and deflated entries.
function unzip(buf) {
  const out = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    out[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    off += 46 + nlen + xlen + clen;
  }
  return out;
}
const xmlParser = new (new JSDOM('').window.DOMParser)();
function xmlOk(text) {
  const doc = xmlParser.parseFromString(text, 'application/xml');
  return !doc.getElementsByTagName('parsererror').length;
}
// Text as a reader sees it: each cell and block its own word, so "197" in one
// cell and "803" in the next do not run together into "197803".
const textOf = html => new JSDOM(html.replace(/<\/(td|th|div|p|h[1-6]|li|span)>/gi, ' $&'))
  .window.document.body.textContent.replace(/\s+/g, ' ');

// ── Driving the page ─────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OUR_FILES = /custom-reports|FCTCustomReports|FCTReportEngine|\[custom-reports\]/;

async function openPage(browser, baseUrl, div, session, viewport) {
  const ctx = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = { page: [], console: [] };
  page.on('pageerror', e => errors.page.push(String(e && (e.stack || e.message) || e)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = m.location() || {};
    errors.console.push(`${m.text()} @ ${loc.url || ''}`);
  });
  await page.addInitScript(([s, d]) => {
    if (location.pathname.endsWith('.html')) {
      // The page's assistant greets once per tab; seen already, so it stays
      // out of the screenshots.
      try { sessionStorage.setItem('fct_mathis_nudge_' + d, '1'); } catch (_) { /* fine */ }
      localStorage.setItem('fct_token', s.token);
      localStorage.setItem('fct_user', JSON.stringify(s.user));
      localStorage.setItem('fct_division', d);
      localStorage.setItem('fct_company_code', s.user.companyCode);
    }
  }, [session, div]);
  await page.goto(`${baseUrl}/${PAGES[div].file}`, { waitUntil: 'domcontentloaded' });
  await waitBooted(page);
  return { ctx, page, errors };
}
async function waitBooted(page) {
  await page.waitForFunction(() => typeof projectsList !== 'undefined' && projectsList.length === 3
    && window.FCTCustomReports && window.FCTReportEngine, null, { timeout: 30000 });
}
async function openTab(page, phone) {
  if (phone) {
    // Analytics is desktop-only on phones; the tab itself still has to work.
    await page.evaluate(() => analyticsSwitchTab('customrpt'));
  } else {
    await page.hover('#analytics-tab-btn');
    await page.click('#analytics-item-customrpt');
    await page.mouse.move(700, 880);   // off the menu, so it folds away again
  }
  await page.waitForSelector('#cr-content .cr-root', { timeout: 15000 });
  // The saved-report list has come back from the API.
  await page.waitForFunction(() => window.FCTCustomReports._internals.state().loaded, null, { timeout: 15000 });
}
const srcdoc = page => page.$eval('#cr-content .cr-frame', f => f.getAttribute('srcdoc') || '');
async function waitPreview(page, test, label) {
  try {
    await page.waitForFunction(fnSrc => {
      const f = document.querySelector('#cr-content .cr-frame');
      const s = f && f.getAttribute('srcdoc');
      return !!s && new Function('s', 'return ' + fnSrc)(s);
    }, test, { timeout: 10000 });
    return true;
  } catch { ok(label || 'the preview redraws', false, (await srcdoc(page)).slice(0, 300)); return false; }
}
async function startStarter(page, id) {
  // The home page's card, or (with a report open) the rail's Start-from list.
  const card = page.locator(`#cr-content .cr-card[data-starter="${id}"]`);
  if (await card.count() && await card.first().isVisible()) await card.first().click();
  else {
    // Leaving an unsaved report asks first.
    const yes = d => d.accept().catch(() => {});
    page.once('dialog', yes);
    await page.click(`#cr-content .cr-rail [data-act="starter"][data-starter="${id}"]`);
    await sleep(300);
    page.off('dialog', yes);
  }
  await page.waitForSelector('#cr-content .cr-edit');
}
async function pickJob(page, id) {
  await page.check(`#cr-content .cr-job input[data-bind="job"][value="${id}"]`);
}
async function sectionByLabel(page, label) {
  return page.locator('#cr-content .cr-sec', { has: page.locator('.cr-sec-type', { hasText: label }) }).first();
}
async function expandSection(page, label) {
  const sec = await sectionByLabel(page, label);
  const t = sec.locator('[data-act="sec-toggle"]');
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  return sectionByLabel(page, label);
}
// The browser logs every 4xx/5xx response as a console error. The 409s this
// suite provokes on purpose (the version conflict) are not faults.
function ourErrors(errors) {
  return errors.page.concat(errors.console.filter(t => OUR_FILES.test(t)
    && !/^Failed to load resource: the server responded with a status of 409\b/.test(t)));
}
async function shot(page, name, opts) {
  if (!SCREENS) return;
  // From the top, so the page's sticky header sits where a person sees it.
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await page.screenshot(Object.assign({ path: path.join(SCREENS, name + '.png') }, opts || {}));
}

// ── v2 helpers ───────────────────────────────────────────────────────────
// A real PNG, built by hand: w × h of one colour with a darker band, so the
// logo picker has a genuine image to decode, shrink and re-encode.
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makePng(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3, band = y > h / 3 && y < (2 * h) / 3;
      raw[o] = band ? 20 : 30; raw[o + 1] = band ? 83 : 120; raw[o + 2] = band ? 45 : 200;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const docOf = html => new JSDOM(html).window.document;
const cellText = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
// A section's table as { head: [labels], rows: [{ cls, cells: { label: text } }] }.
function tableIn(doc, type) {
  const t = doc.querySelector(`section.sec-${type} table`);
  if (!t) return null;
  const head = [...t.querySelectorAll('thead th')].map(cellText);
  const rows = [...t.querySelectorAll('tbody tr')].map(tr => {
    const tds = [...tr.children];
    const cells = {};
    if (tds.length === head.length) head.forEach((hd, i) => { cells[hd] = cellText(tds[i]); });
    return { cls: tr.className || '', first: cellText(tds[0]), cells };
  });
  return { head, rows };
}
// Division Rates: each strip's heading and its figures, { title: { label: value } }.
function strips(doc) {
  const out = {};
  const sec = doc.querySelector('section.sec-rate_summary');
  if (!sec) return out;
  let title = '';
  [...sec.children].forEach(el => {
    if (el.classList.contains('kpi-h')) title = cellText(el);
    if (el.classList.contains('sum-bar')) {
      const m = {};
      el.querySelectorAll('.sum-metric').forEach(x => { m[cellText(x.querySelector('.sum-label'))] = cellText(x.querySelector('.sum-val')); });
      out[title || '(job)'] = m;
    }
  });
  return out;
}
const fmtN = (v, dp = 2) => Number(v).toLocaleString('en-US', { maximumFractionDigits: dp });
// Nothing in a chart that can fetch, run or link.
function svgSafe(html) {
  const svgs = html.match(/<svg[\s\S]*?<\/svg>/g) || [];
  return svgs.length > 0 && svgs.every(x => !/url\(|<image|<foreignObject|<script|\son[a-z]+\s*=|href/i.test(x));
}
// Desktop (1440) and phone (390) screenshots of what is on screen now.
async function shotPair(page, name, opts) {
  if (!SCREENS) return;
  const vp = page.viewportSize() || { width: 1440, height: 900 };
  const o = opts || {};
  if (!o.keepToast) await page.evaluate(() => document.querySelectorAll('.cr-toast').forEach(t => t.remove())).catch(() => {});
  const take = async tag => {
    if (tag === 'phone' && o.phoneBefore) await o.phoneBefore();
    else if (o.before) await o.before();
    else { await page.evaluate(() => window.scrollTo(0, 0)); }
    await sleep(500);
    const target = o.selector ? page.locator(o.selector).first() : null;
    if (target && await target.count()) await target.screenshot({ path: path.join(SCREENS, `${tag}-${name}.png`) });
    else await page.screenshot({ path: path.join(SCREENS, `${tag}-${name}.png`), fullPage: !!o.fullPage });
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await take('desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await take('phone');
  await page.setViewportSize(vp);
  await sleep(300);
}
// Working days a..b, both ends, on the page's own calendar (its _usHolidays):
// the figure the plan's scheduled % is held to, worked out without the engine.
async function pageWorkdays(page, a, b) {
  return page.evaluate(([a, b]) => {
    if (b < a) return 0;
    let n = 0;
    const hol = {};
    for (let t = new Date(a + 'T12:00:00'); ; t.setDate(t.getDate() + 1)) {
      const y = t.getFullYear();
      const d = `${y}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      if (d > b) break;
      if (!hol[y]) hol[y] = _usHolidays(y);
      const w = t.getDay();
      if (w !== 0 && w !== 6 && !hol[y].has(d)) n++;
    }
    return n;
  }, [a, b]);
}
async function toastText(page) {
  return page.evaluate(() => { const t = document.querySelector('.cr-toast'); return t ? t.textContent : ''; });
}
async function waitFor(fn, ms, every = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(every);
  }
}
async function printFrom(page) {
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#cr-content [data-act="print"]')]);
  try {
    await popup.waitForFunction(() => !!document.querySelector('[data-dw-brand]'), null, { timeout: 25000 });
    return { popup, html: await popup.content() };
  } catch (err) { return { popup, html: '', err }; }
}
async function printedShots(browser, html, name) {
  if (!SCREENS || !html) return;
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
    const pctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const pp = await pctx.newPage();
    await pp.setContent(html.replace(/<script>window\.onload[\s\S]*?<\/script>/, ''));
    await sleep(300);
    await pp.screenshot({ path: path.join(SCREENS, `${tag}-${name}.png`), fullPage: true });
    await pctx.close();
  }
}

// ── The run ──────────────────────────────────────────────────────────────
const CO = 'CRBROWSER';
async function cleanUp() {
  await db.query('DELETE FROM report_schedule_runs WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM report_schedules WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM custom_report_run_archives WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM report_contacts WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM company_branding WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM report_builder_usage WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM report_recipient_groups WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM custom_report_runs WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM custom_reports WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM users WHERE company_code = $1', [CO]);
  await db.query('DELETE FROM companies WHERE code = $1', [CO]);
}

(async () => {
  try { await db.connect(); await db.query('SELECT 1 FROM custom_reports LIMIT 0'); }
  catch (err) {
    console.log(`no test Postgres with custom_reports at ${PG_URL.replace(/:[^:@/]*@/, ':***@')} (${err.message}) — skipping`);
    process.exit(0);
  }
  let browser;
  try { browser = await chromium.launch(); }
  catch (err) {
    console.log('Playwright could not start Chromium (' + String(err.message).split('\n')[0] + ') — skipping');
    await db.end();
    process.exit(0);
  }
  if (SCREENS) fs.mkdirSync(SCREENS, { recursive: true });

  await cleanUp();
  await db.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Browser test', '{turf,paving,kiewit}')", [CO]);
  const roles = { turf: 'admin', paving: 'admin', kiewit: 'admin' };
  const userId = (await db.query(
    "INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('pat.admin', $1, 'x', 'admin', $2) RETURNING id",
    [CO, JSON.stringify(roles)])).rows[0].id;
  // What signing in hands the browser: the token and the user object, as login.js shapes them.
  const user = { username: 'pat.admin', companyCode: CO, companyName: 'Browser test', role: 'admin',
    divisionRoles: roles, allowedDivisions: Object.keys(roles), isPlatformAdmin: false };
  const session = { token: jwt.sign(Object.assign({ userId }, user), process.env.JWT_SECRET, { expiresIn: '1h' }), user };

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-browser-'));
  const REPORT = 'Maple & Oak — weekly <update>';
  const TITLE = 'Progress <b>Update</b> & Schedule';

  try {
    // ─────────────────────────────────────────────────────────────────
    console.log('\nPaving — build, save, reopen, print, Excel, email');
    let { ctx, page, errors } = await openPage(browser, baseUrl, 'paving', session);
    await openTab(page);
    let text = await page.textContent('#cr-content');
    ok('Analytics → Custom Reporting opens the builder with the starters listed',
      /Customer Progress Update/.test(text) && /Start from/.test(text), text.slice(0, 200));
    ok('the list was asked of the real API, for this division, with the real token',
      CR_CALLS.some(c => c.method === 'GET' && c.query.division === 'paving'), JSON.stringify(CR_CALLS.slice(-3)));
    await shot(page, 'desktop-a-welcome');

    await startStarter(page, 'customer_progress');
    await pickJob(page, 'p1');
    await pickJob(page, 'p2');
    ok('two jobs picked', /2 jobs selected/.test(await page.textContent('#cr-content .cr-count')));
    let good = await waitPreview(page, `s.includes(${JSON.stringify(JOB1)}) && s.includes(${JSON.stringify(JOB2)}) && s.includes('data-dw-brand')`,
      'the preview shows both jobs under the DataWatch masthead');
    if (good) {
      const html = await srcdoc(page);
      ok('the preview shows both jobs under the DataWatch masthead',
        /class="masthead" data-dw-brand/.test(html) && /DataWatch/.test(html) && /Paving Division/.test(html));
      ok('…and the bid items with their progress', html.includes('Milling') && html.includes('Surface Course'));
      ok('customer-safe: no employee name, rate, cost or INTERNAL tag anywhere in the rendered report',
        !html.includes(SECRET_NAME) && !html.includes(SECRET_RATE) && !html.includes('1,500') && !html.includes('2,400')
          && !/INTERNAL/.test(html), html.match(/.{60}(Kowalski|41\.25|INTERNAL).{60}/) || '');
    }
    await shot(page, 'desktop-b-starter-jobs-preview');

    // Step ②: the lock, then internal data on.
    await page.click('#cr-content [data-act="step"][data-step="2"]');
    let sec = await expandSection(page, 'Bid Item Progress');
    const lockedBox = sec.locator('.cr-col.locked input[data-key="actual_cost"]');
    ok('an internal column (Actual Cost) is shown locked while customer-safe',
      await lockedBox.count() === 1 && await lockedBox.isDisabled());
    ok('…with the lock explained', /Include internal data/.test(await sec.locator('.cr-col.locked').first().getAttribute('title') || ''));
    let confirmText = '';
    page.once('dialog', d => { confirmText = d.message(); d.accept(); });
    await page.click("#cr-content label.cr-switch");
    await page.waitForSelector('#cr-content .cr-banner-int', { timeout: 5000 });
    ok('switching internal data on asks first, in plain words', /Don't send it to a customer/.test(confirmText), confirmText);
    ok('…and a red INTERNAL banner stays up while it is on', await page.isVisible('#cr-content .cr-banner-int'));
    sec = await sectionByLabel(page, 'Bid Item Progress');
    const box = sec.locator('input[data-bind="col"][data-key="actual_cost"]');
    ok('the column unlocks', await box.count() === 1 && !(await box.isDisabled()));
    await box.check();
    good = await waitPreview(page, "s.includes('INTERNAL') && s.includes('$')", 'the preview picks up the internal column');
    if (good) {
      const html = await srcdoc(page);
      ok('the preview now carries the INTERNAL tag and the Actual Cost column',
        /INTERNAL — contains cost data/.test(html) && /Actual/.test(html));
    }
    await shot(page, 'desktop-c-sections-internal');
    // The preview is the sheet scaled to the pane: a wide table fits on it.
    const fit = await page.$eval('#cr-content .cr-frame', f => {
      const doc = f.contentDocument;
      const wrap = f.parentElement.getBoundingClientRect(), r = f.getBoundingClientRect();
      return { paged: f.classList.contains('paged'), frameW: Math.round(r.width), wrapW: Math.round(wrap.width),
        overflow: doc ? doc.documentElement.scrollWidth - doc.documentElement.clientWidth : -1 };
    });
    ok('at 1440 px the preview is the whole sheet scaled to the pane, with no table running off it',
      fit.paged && Math.abs(fit.frameW - fit.wrapW) <= 2 && fit.overflow <= 0, JSON.stringify(fit));

    // Step ③: a printed heading with markup in it — it must print as text.
    await page.click('#cr-content [data-act="step"][data-step="3"]');
    await page.fill('#cr-content [data-bind="title"]', TITLE);

    // Step ①: keep the jobs with the report, then Save.
    await page.click('#cr-content [data-act="step"][data-step="1"]');
    await page.check('#cr-content input[data-bind="save-jobs"]');
    await page.click('#cr-content [data-act="save"]');
    await page.waitForSelector('.cr-modal #cr-m-name');
    await page.fill('.cr-modal #cr-m-name', REPORT);
    await page.click('.cr-modal [data-m="ok"]');
    await page.waitForSelector('.cr-modal', { state: 'detached', timeout: 10000 }).catch(() => {});
    let row = (await db.query('SELECT * FROM custom_reports WHERE company_code = $1', [CO])).rows[0];
    ok('Save writes one real row, named as typed', row && row.name === REPORT, row && row.name);
    ok('…private to its owner, version 1', row && row.visibility === 'private' && row.owner_user_id === userId && row.version === 1);
    ok('…flagged by the server as not customer-safe, with its jobs saved',
      row && row.customer_safe === false && row.kind === 'report'
        && row.definition.jobs.mode === 'saved' && JSON.stringify(row.definition.jobs.ids) === JSON.stringify(['p1', 'p2']),
      row && JSON.stringify({ cs: row.customer_safe, kind: row.kind, jobs: row.definition.jobs }));
    ok('…with the ticked internal column in the stored definition',
      row && row.definition.sections.some(s => s.type === 'bid_progress' && s.columns.includes('actual_cost')));
    ok('the saved report is in My Reports straight away',
      (await page.textContent('#cr-content .cr-rail')).includes(REPORT));
    ok('the builder is clean after the save', await page.isHidden('#cr-content .cr-dirty')
      && await page.isDisabled('#cr-content [data-act="save"]'));
    const reportId = row && String(row.id);

    // ── Reload, with the old daily rows held back ──
    BACKFILL_DELAY = 6000;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitBooted(page);
    await openTab(page);
    const item = page.locator('#cr-content .cr-item-open[data-act="open"]', { hasText: REPORT });
    ok('after a reload the saved report is listed in My Reports, its name shown as text',
      await item.count() === 1 && (await item.locator('.cr-item-name').textContent()) === REPORT);
    ok('…badged Private · Saved jobs · Internal', /Private/.test(await item.textContent())
      && /Saved jobs/.test(await item.textContent()) && /Internal/.test(await item.textContent()));
    await item.click();
    await page.waitForSelector('#cr-content .cr-edit');
    ok('opening it brings back its two jobs', /2 jobs selected/.test(await page.textContent('#cr-content .cr-count')));
    ok('…and its internal setting', await page.isVisible('#cr-content .cr-banner-int'));
    ok('…with nothing unsaved', await page.isHidden('#cr-content .cr-dirty'));

    // Print, before the backfill has landed.
    const backfillPending = await page.evaluate(() => !window.FCTCustomReports._internals.state().readyDone);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#cr-content [data-act="print"]')]);
    let printHtml = '';
    try {
      await popup.waitForFunction(() => !!document.querySelector('[data-dw-brand]'), null, { timeout: 25000 });
      printHtml = await popup.content();
    } catch (err) { ok('the print window gets its report', false, err.message); }
    if (printHtml) {
      const t = textOf(printHtml);
      ok('Print opens a window and writes the report into it (masthead once)',
        (printHtml.match(/data-dw-brand/g) || []).length === 1 && /DataWatch/.test(t));
      const heading = await popup.$eval('.mast-rpt', el => el.textContent).catch(() => '');
      ok('…headed with the title typed in step ③, printed as text rather than markup',
        heading === TITLE && !printHtml.includes('<b>Update</b>'), heading);
      ok('…with the INTERNAL tag in the masthead', /INTERNAL — contains cost data/.test(t));
      ok('…both jobs', t.includes(JOB1) && t.includes(JOB2));
      ok(`the print waited for the older daily rows${backfillPending ? ' (it was clicked before they arrived)' : ''}: `
        + '197 installed, 803 left, 19.7% on Milling', /\b197\b/.test(t) && /\b803\b/.test(t) && t.includes('19.7%'),
      t.match(/Milling.{0,160}/) || t.slice(0, 300));
      ok('…and the Actual Cost to date includes them: $2,400.00', t.includes('$2,400.00'), t.match(/Milling.{0,200}/) || '');
      ok('…the print dialog is asked for once it has loaded', /window\.print\(\)/.test(printHtml));
    }
    if (SCREENS && printHtml) {
      for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'phone']]) {
        const pctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
        const pp = await pctx.newPage();
        await pp.setContent(printHtml.replace(/<script>window\.onload[\s\S]*?<\/script>/, ''));
        await pp.screenshot({ path: path.join(SCREENS, `${tag}-d-printed-report.png`), fullPage: true });
        await pctx.close();
      }
    }
    await popup.close().catch(() => {});

    // Excel. An internal workbook asks first, like Email.
    let excelAsk = '';
    page.once('dialog', d => { excelAsk = d.message(); d.accept(); });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cr-content [data-act="excel"]')]);
    ok('Excel of an internal report asks before downloading', /workbook includes internal data/.test(excelAsk), excelAsk);
    const xlsxPath = path.join(tmp, 'report.xlsx');
    await dl.saveAs(xlsxPath);
    ok('Excel downloads a .xlsx named after the report and today',
      new RegExp(`-INTERNAL-${ymd(today)}\\.xlsx$`).test(dl.suggestedFilename()) && !/[<>:"/\\|?*]/.test(dl.suggestedFilename()),
      dl.suggestedFilename());
    let parts = null;
    try { parts = unzip(fs.readFileSync(xlsxPath)); } catch (err) { ok('the workbook unzips', false, err.message); }
    if (parts) {
      const names = Object.keys(parts);
      ok('the workbook unzips into a real workbook',
        names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml') && names.some(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)),
        names.join(', '));
      const bad = names.filter(n => /\.(xml|rels)$/.test(n) && !xmlOk(parts[n].toString('utf8')));
      ok('every part parses as XML', bad.length === 0, bad.join(', '));
      const sheets = names.filter(n => /^xl\/worksheets\//.test(n)).map(n => parts[n].toString('utf8')).join('\n');
      ok('…holding both jobs and the internal column it was asked for',
        sheets.includes(JOB1) && sheets.includes(JOB2) && /Actual/.test(sheets));
      ok('…with quantities as numbers, not text', /<c [^>]*>\s*<v>197<\/v>/.test(sheets));
    }

    // Email, through the real modal and the real send-report handler, with a
    // subject written for the customer.
    page.once('dialog', d => d.accept());   // "includes internal data — email it anyway?"
    await page.click('#cr-content [data-act="email"]');
    await page.waitForSelector('#rem-input', { timeout: 10000 });
    ok('the email modal offers "<title> — 2 jobs" as the subject', (await page.inputValue('#rem-subject')) === `${TITLE} — 2 jobs`,
      await page.inputValue('#rem-subject'));
    await page.fill('#rem-input', 'owner@maple.example');
    await page.press('#rem-input', 'Enter');
    await page.fill('#rem-subject', 'Maple Township: weekly progress');
    await page.uncheck('#rem-pdf');   // no Chrome-in-Chrome here; the PDF path has its own suite
    const runPostsBefore = CR_CALLS.filter(c => c.method === 'POST' && c.query.action === 'run').length;
    await page.click('#rem-send');
    await page.waitForFunction(() => /sent|recipient|failed/i.test((document.getElementById('rem-status') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
    const mail = EMAILS[EMAILS.length - 1];
    ok('Email goes out as a paving_custom_report with the branded report in it',
      mail && mail.report_type === 'paving_custom_report' && /data-dw-brand/.test(mail.html || ''),
      mail && JSON.stringify({ type: mail.report_type, len: (mail.html || '').length }));
    ok('…with the subject the user typed and no project name for the server to swap it for',
      mail && mail.subject === 'Maple Township: weekly progress' && !mail.project_name, mail && JSON.stringify({ s: mail.subject, p: mail.project_name }));
    ok('…and that subject is what reached the mail service',
      RESENT.length > 0 && RESENT[RESENT.length - 1].subject === 'Maple Township: weekly progress', RESENT.length && RESENT[RESENT.length - 1].subject);

    // The send history, as rows.
    let runs = [];
    for (let i = 0; i < 20; i++) {
      runs = (await db.query('SELECT * FROM custom_report_runs WHERE company_code = $1 ORDER BY id', [CO])).rows;
      if (runs.length >= 3) break;
      await sleep(250);
    }
    ok('every output is logged: print, excel, email', runs.map(r => r.action).join(',') === 'print,excel,email',
      runs.map(r => r.action).join(','));
    ok('…against the saved report, with both jobs and the date range',
      runs.length > 0 && runs.every(r => String(r.report_id) === reportId
        && JSON.stringify(r.project_names) === JSON.stringify([JOB1, JOB2]) && r.report_name === REPORT));
    ok('…each marked as carrying internal data', runs.length > 0 && runs.every(r => r.included_internal === true));
    const mailRun = runs.find(r => r.action === 'email');
    ok('…and the email row has who it went to and the subject that went out',
      mailRun && JSON.stringify(mailRun.recipients) === JSON.stringify(['owner@maple.example']) && mailRun.subject === 'Maple Township: weekly progress',
      mailRun && JSON.stringify({ to: mailRun.recipients, subject: mailRun.subject }));
    ok('…written once, by the server as it sent the email (the browser did not log it again)',
      runs.filter(r => r.action === 'email').length === 1
        && CR_CALLS.filter(c => c.method === 'POST' && c.query.action === 'run').length === runPostsBefore,
      `${runs.filter(r => r.action === 'email').length} email rows`);
    row = (await db.query('SELECT run_count, last_run_at FROM custom_reports WHERE id = $1', [reportId])).rows[0];
    ok('the report counts its runs', row && row.run_count === 3 && row.last_run_at, row && row.run_count);
    ok('every custom-reports call carried ?division=paving',
      CR_CALLS.length > 0 && CR_CALLS.every(c => c.query.division === 'paving'),
      CR_CALLS.filter(c => c.query.division !== 'paving').map(c => c.method).join(','));

    // Edit and save again: a PUT with the version, version 2 in the database.
    await page.click('#cr-content [data-act="step"][data-step="3"]');
    await page.fill('#cr-content [data-bind="h-intro"]', 'Milling is ahead of plan.');
    await page.waitForSelector('#cr-content .cr-dirty', { state: 'visible' });
    await page.keyboard.press('Control+s');
    await page.waitForSelector('#cr-content .cr-dirty', { state: 'hidden', timeout: 10000 }).catch(() => {});
    row = (await db.query('SELECT version, definition FROM custom_reports WHERE id = $1', [reportId])).rows[0];
    ok('Ctrl+S saves the edit over the report: version 2, intro stored',
      row && row.version === 2 && row.definition.header.intro === 'Milling is ahead of plan.', row && row.version);

    // Someone else saves it in between: the next save is a version conflict.
    await db.query('UPDATE custom_reports SET version = version + 1, name = name WHERE id = $1', [reportId]);
    await page.fill('#cr-content [data-bind="h-intro"]', 'Milling is well ahead of plan.');
    await page.click('#cr-content [data-act="save"]');
    let conflict = '';
    try {
      await page.waitForSelector('.cr-modal', { timeout: 8000 });
      conflict = await page.textContent('.cr-modal');
    } catch { /* reported below */ }
    ok('a save over someone else\'s newer save asks what to do (409 version_conflict)',
      /Someone else saved this report/i.test(conflict), conflict.slice(0, 200));
    if (conflict) {
      await page.click('.cr-modal [data-choice="1"]');   // Load their version
      await page.waitForSelector('.cr-modal', { state: 'detached', timeout: 8000 }).catch(() => {});
      const st = await page.evaluate(() => {
        const d = window.FCTCustomReports._internals.state().doc;
        return d && { version: d.version, intro: d.def.header.intro };
      });
      ok('…and "Load their version" opens the copy that is in the database (version 3, their intro)',
        st && st.version === 3 && st.intro === 'Milling is ahead of plan.', JSON.stringify(st));
    }

    // Back to customer-safe with Actual Cost still chosen in the definition:
    // the column is kept for later, and nothing of it reaches the page.
    await page.click('#cr-content [data-act="internal-off"]');
    await page.waitForSelector('#cr-content .cr-banner-int', { state: 'detached', timeout: 5000 }).catch(() => {});
    good = await waitPreview(page, "!s.includes('INTERNAL') && s.includes('data-dw-brand')", 'the preview drops the internal data');
    if (good) {
      const html = await srcdoc(page);
      const kept = await page.evaluate(() => window.FCTCustomReports._internals.state().doc.def.sections
        .some(s => s.type === 'bid_progress' && s.columns.includes('actual_cost')));
      ok('"Make it customer-safe" keeps Actual Cost in the report but prints none of it',
        kept && !/Actual Cost/i.test(html) && !html.includes('$2,400.00') && !html.includes('$5,500.00'),
        html.match(/.{60}(Actual|\$2,400).{60}/) || String(kept));
    }

    // Leaving with an unsaved report: the browser asks first.
    await page.click('#cr-content [data-act="step"][data-step="3"]');
    await page.fill('#cr-content [data-bind="h-footer"]', 'Unsaved footer');
    await page.waitForSelector('#cr-content .cr-dirty', { state: 'visible' });
    let leaveAsk = '';
    page.once('dialog', d => { leaveAsk = d.type(); d.dismiss().catch(() => {}); });
    await page.click('button:has-text("Switch Division")', { noWaitAfter: true });
    await sleep(800);
    ok('"Switch Division" with an unsaved report raises the browser\'s leave-page question, and staying keeps it',
      leaveAsk === 'beforeunload' && /paving\.html/.test(page.url())
        && (await page.inputValue('#cr-content [data-bind="h-footer"]')) === 'Unsaved footer', `${leaveAsk} ${page.url()}`);

    const ours = ourErrors(errors);
    ok('no page errors, and no console errors from the Custom Reporting files', ours.length === 0, ours.slice(0, 3).join(' | '));
    const others = errors.console.filter(t => !ours.includes(t));
    if (others.length) console.log(`    (other console messages at error level, not from these files: ${others.map(t => t.slice(0, 120)).join(' | ')})`);
    await ctx.close();
    BACKFILL_DELAY = 0;

    // ── Phone width: the same screens stack ──
    if (SCREENS) {
      ({ ctx, page, errors } = await openPage(browser, baseUrl, 'paving', session, { width: 390, height: 844 }));
      await openTab(page, true);
      await shot(page, 'phone-a-welcome', { fullPage: true });
      await startStarter(page, 'customer_progress');
      await pickJob(page, 'p1');
      await pickJob(page, 'p2');
      await waitPreview(page, `s.includes(${JSON.stringify(JOB2)})`);
      await shot(page, 'phone-b-starter-jobs-preview', { fullPage: true });
      await page.click('#cr-content [data-act="step"][data-step="2"]');
      page.once('dialog', d => d.accept());
      await page.click("#cr-content label.cr-switch");
      await page.waitForSelector('#cr-content .cr-banner-int');
      await expandSection(page, 'Bid Item Progress');
      await shot(page, 'phone-c-sections-internal', { fullPage: true });
      const over = await page.evaluate(() => {
        const r = document.querySelector('#cr-content .cr-root');
        return Math.max(0, Math.round(r.scrollWidth - r.clientWidth), Math.round(r.getBoundingClientRect().right - window.innerWidth));
      });
      ok('phone width: the builder itself does not run off the side of the screen', over <= 1, over + 'px');
      await ctx.close();
    }

    // ── Turf and Kiewit: the tab opens and a starter previews ──
    for (const div of ['turf', 'kiewit']) {
      console.log(`\n${PAGES[div].label} — ${PAGES[div].file}`);
      ({ ctx, page, errors } = await openPage(browser, baseUrl, div, session));
      await openTab(page);
      ok('Analytics → Custom Reporting opens with the starters', /Customer Progress Update/.test(await page.textContent('#cr-content')));
      await startStarter(page, 'customer_progress');
      await pickJob(page, 'p1');
      good = await waitPreview(page, `s.includes(${JSON.stringify(JOB1)}) && s.includes('data-dw-brand')`, 'the starter previews with the masthead');
      if (good) {
        const html = await srcdoc(page);
        ok(`the starter previews the job under the ${PAGES[div].label} masthead`,
          html.includes(`${PAGES[div].label} Division`) && /DataWatch/.test(html) && html.includes('Milling'));
        ok('…customer-safe', !html.includes(SECRET_NAME) && !/INTERNAL/.test(html));
      }
      ok(`the list was asked for division=${div}`, CR_CALLS.some(c => c.query.division === div));
      if (div === 'turf') {
        // A double-clicked Save: the dialog the first click opens stays open.
        await page.dblclick('#cr-content [data-act="save"]');
        await sleep(200);
        ok('a double-clicked Save leaves its name dialog open', await page.locator('.cr-modal').count() === 1);
        await page.keyboard.press('Escape');
      }
      const o = ourErrors(errors);
      ok('no page errors, and no console errors from the Custom Reporting files', o.length === 0, o.slice(0, 3).join(' | '));
      await ctx.close();
    }
    // ═════════════════════════════════════════════════════════════════
    // Custom Reporting v2
    // ═════════════════════════════════════════════════════════════════
    // ── (a) Turf: a sub-code report, built by hand ──
    console.log('\nTurf — Turf Install on every In Progress job: Planned vs Actual, Division Rates, a chart');
    ({ ctx, page, errors } = await openPage(browser, baseUrl, 'turf', session));
    await openTab(page);
    await startStarter(page, 'sub_code_production');
    ok('the Sub-Code Production starter opens with the sub-code search focused',
      await page.evaluate(() => (document.activeElement && document.activeElement.getAttribute('data-bind')) === 'filter-search'));
    await page.click('#cr-content [data-act="jobs-active"]');
    ok('"All In Progress" picks both In Progress jobs (not the complete one)', /2 jobs selected/.test(await page.textContent('#cr-content .cr-count')));
    await page.fill('#cr-content [data-bind="filter-search"]', 'turf');
    const scBox = page.locator('#cr-content input[data-bind="filter-sc"][value="Turf Install"]');
    ok('the sub-code search finds Turf Install on the picked jobs, shown as "code — description (unit)"',
      await scBox.count() === 1 && /Turf Install — Install sod \(SF\)/.test(await page.textContent('#cr-content .cr-flist')),
      await page.textContent('#cr-content .cr-flist'));
    await scBox.check();
    await page.check('#cr-content input[data-bind="layout"][value="combined"]');
    await page.selectOption('#cr-content [data-bind="preset"]', 'last_30');
    good = await waitPreview(page, "s.includes('sec-plan_vs_actual') && s.includes('All jobs') && s.includes('<svg') && s.includes('2,166.67')",
      'the preview shows Planned vs Actual, Division Rates and the chart for Turf Install');
    const turfToday = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
    const range30 = await page.evaluate(t => window.FCTReportEngine.resolveDateRange({ preset: 'last_30' }, t), turfToday);
    const asOf = range30.to && range30.to < turfToday ? range30.to : turfToday;
    const schedPct = async t => {
      const S = daysFrom(t.start), T = daysFrom(t.target);
      if (asOf < S) return 0;
      if (asOf >= T) return 100;
      return 100 * (await pageWorkdays(page, S, asOf)) / (await pageWorkdays(page, S, T));
    };
    const sp1 = await schedPct(TURF.p1), sp2 = await schedPct(TURF.p2);
    const pct1 = v => fmtN(v, 1).replace(/^(\d+)$/, '$1.0') + '%';
    const checkTurf = (html, where) => {
      const doc = docOf(html);
      const t = tableIn(doc, 'plan_vs_actual');
      const r1 = t && t.rows.find(r => r.first.startsWith(JOB1) && r.cells['Sub Code'] === 'Turf Install');
      const r2 = t && t.rows.find(r => r.first.startsWith(JOB2) && r.cells['Sub Code'] === 'Turf Install');
      const tot = t && t.rows.find(r => /\btot\b/.test(r.cls));
      ok(`${where}: Planned vs Actual lists Turf Install only, one line per job`,
        t && t.rows.filter(r => !/grp|tot/.test(r.cls)).length === 2 && !/Milling|Base Course|Surface Course/.test(cellText(doc.querySelector('section.sec-plan_vs_actual'))),
        t && JSON.stringify(t.rows.map(r => r.first + ':' + (r.cells['Sub Code'] || ''))));
      ok(`${where}: ${JOB1} — 20,000 SF bid, 5,000 in; planned 2,500 a day (typed), actual 2,500 a day (5,000 over 2 days): 100% of plan, 25% earned`,
        r1 && r1.cells['Bid Qty'] === '20,000' && r1.cells['Installed to Date'] === '5,000' && r1.cells['Planned / Day'] === '2,500'
          && r1.cells['Actual / Day'] === '2,500' && r1.cells['% of Planned Rate'] === '100.0%' && r1.cells['Earned %'] === '25.0%', r1 && JSON.stringify(r1.cells));
      ok(`${where}: ${JOB2} — 1,500 in one day against 1,000 planned: 150% of plan, 12.5% earned`,
        r2 && r2.cells['Bid Qty'] === '12,000' && r2.cells['Installed to Date'] === '1,500' && r2.cells['Planned / Day'] === '1,000'
          && r2.cells['Actual / Day'] === '1,500' && r2.cells['% of Planned Rate'] === '150.0%' && r2.cells['Earned %'] === '12.5%', r2 && JSON.stringify(r2.cells));
      ok(`${where}: Scheduled % on the page's holiday calendar — ${pct1(sp1)} and ${pct1(sp2)} (working days from Start to ${asOf}, over Start to Target)`,
        r1 && r2 && r1.cells['Scheduled %'] === pct1(sp1) && r2.cells['Scheduled %'] === pct1(sp2),
        r1 && r2 && `${r1.cells['Scheduled %']} / ${r2.cells['Scheduled %']}`);
      ok(`${where}: the Totals compare like with like — 2,000 planned a day for the days worked, 2,166.67 actual, 108.3%`,
        tot && tot.cells['Bid Qty'] === '32,000' && tot.cells['Installed to Date'] === '6,500' && tot.cells['Planned / Day'] === '2,000'
          && tot.cells['Actual / Day'] === '2,166.67' && tot.cells['% of Planned Rate'] === '108.3%', tot && JSON.stringify(tot.cells));
      const st = strips(doc);
      const s1 = st[`${JOB1} · 26101`], s2 = st[`${JOB2} · 26102`];
      ok(`${where}: Division Rates — SF Installed / SF a day / work days per job, and All jobs`,
        s1 && s1['SF Installed'] === '5,000' && s1['SF / Day'] === '2,500' && s1['Work Days'] === '2'
          && s2 && s2['SF Installed'] === '1,500' && s2['SF / Day'] === '1,500' && s2['Work Days'] === '1'
          && st['All jobs'] && st['All jobs']['SF Installed'] === '6,500' && st['All jobs']['Work Days'] === '3' && st['All jobs']['SF / Day'] === '2,166.67',
        JSON.stringify(st));
      ok(`${where}: …customer-safe — no SF per man-hour, no crew-hour rate, no employee name`,
        !/Man-Hour|Crew-Hour|Avg Crew/.test(cellText(doc.body)) && !html.includes(SECRET_NAME) && !/data-cr-internal="1"/.test(html));
      const figs = [...doc.querySelectorAll('section.sec-chart figure.crc')];
      ok(`${where}: one chart per job (combined), each captioned with its job and the planned rate the table shows`,
        figs.length === 2 && figs.every(f => f.querySelector('svg')) && /Maple Ave/.test(cellText(figs[0].querySelector('figcaption')))
          && /planned 2,500 SF a day/.test(cellText(figs[0].querySelector('figcaption'))) && /planned 1,000 SF a day/.test(cellText(figs[1].querySelector('figcaption'))),
        figs.map(f => cellText(f.querySelector('figcaption'))).join(' | '));
      ok(`${where}: the chart SVG can fetch, run and link nothing`, svgSafe(html));
    };
    if (good) { const h0 = await srcdoc(page); if (process.env.CR_DUMP) fs.writeFileSync(process.env.CR_DUMP, h0); checkTurf(h0, 'preview'); }
    await shotPair(page, 'e-plan-chart-preview', {
      // On a phone the panes stack: the preview is below the editor.
      phoneBefore: () => page.evaluate(() => { const f = document.querySelector('#cr-content .cr-frame'); if (f) f.scrollIntoView({ block: 'start' }); }),
    });
    let pr = await printFrom(page);
    if (pr.html) checkTurf(pr.html, 'print');
    else ok('the print window gets the sub-code report', false, pr.err && pr.err.message);
    await pr.popup.close().catch(() => {});
    // The workbook: the same figures as numbers, and the chart's data.
    {
      const [dlx] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#cr-content [data-act="excel"]')]);
      const xp = path.join(tmp, 'turf.xlsx');
      await dlx.saveAs(xp);
      let parts = null;
      try { parts = unzip(fs.readFileSync(xp)); } catch (err) { ok('the sub-code workbook unzips', false, err.message); }
      if (parts) {
        const wb = parts['xl/workbook.xml'] ? parts['xl/workbook.xml'].toString('utf8') : '';
        const sheets = Object.keys(parts).filter(n => /^xl\/worksheets\//.test(n)).map(n => parts[n].toString('utf8')).join('\n');
        const strs = parts['xl/sharedStrings.xml'] ? parts['xl/sharedStrings.xml'].toString('utf8') : '';
        const all = sheets + strs;
        ok('Excel: a "Chart data" sheet per chart section, and every part parses',
          /name="Chart data/.test(wb) && Object.keys(parts).filter(n => /\.(xml|rels)$/.test(n)).every(n => xmlOk(parts[n].toString('utf8'))), wb.slice(0, 300));
        ok('…the planned and actual rates as numbers (2,500 and 1,000 planned a day)', /<v>2500<\/v>/.test(sheets) && /<v>1000<\/v>/.test(sheets) && /<v>5000<\/v>/.test(sheets));
        ok('…customer-safe like the page: no man-hour or crew-hour figure, no employee name',
          !/Man-Hour|Crew-Hour|Avg Crew/.test(all) && !all.includes(SECRET_NAME));
      }
    }
    let o = ourErrors(errors);
    ok('no page errors, and no console errors from the Custom Reporting files', o.length === 0, o.slice(0, 3).join(' | '));

    // ── (g) The AI builder, model stubbed server side ──
    console.log('\nTurf — the AI builder (the model stubbed in the SDK, everything else real)');
    await startStarter(page, 'customer_progress');
    await pickJob(page, 'p1');
    await waitPreview(page, `s.includes(${JSON.stringify(JOB1)})`);
    const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.FCTCustomReports._internals.state().doc.def.sections.map(x => x.type))));
    AI_ANSWERS.push({
      reply: 'Built a Turf Install report for both In Progress jobs over the last 30 days, with planned vs actual and an S-curve.',
      changes: ['Picked Maple Ave Resurfacing and Oak St Parking Lot', 'Filtered every section to Turf Install', 'Planned vs Actual and an S-curve', 'Last 30 days, one combined report'],
      needs_internal: false, clarifying_question: null,
      definition: { title: 'Turf Install — <b>active</b> jobs', description: '', jobs: { mode: 'pick', ids: ['p1', 'p2', 'p404'] }, layout: 'combined',
        pageBreakPerJob: false, orientation: 'portrait', dates: { preset: 'last_30', from: '', to: '' },
        filters: { costCodes: [], subCodes: ['turf install', 'Not A Code'] },
        header: { preparedFor: '', intro: '', footer: '', showGenerated: true, branding: 'company', showPmContact: true },
        sections: [
          { type: 'plan_vs_actual', title: 'Planned vs Actual', columns: ['sub_code', 'bid_qty', 'installed_to_date', 'planned_rate', 'actual_rate', 'pct_of_plan', 'sched_pct', 'earned_pct', 'plan_status'], labels: [], options: { totals: true } },
          { type: 'chart', title: 'Turf Install S-curve', columns: ['installed', 'plan'], labels: [], options: { chart: 's_curve', basis: 'pct', showPlan: true } },
        ] },
    });
    await page.click('#cr-content [data-act="ai-toggle"]');
    await page.waitForSelector('.cr-ai-drawer .crai-in', { timeout: 10000 });
    ok('"✨ AI Builder" opens the drawer with the chat', await page.isVisible('.cr-ai-drawer .crai-in'));
    const fitAi = await page.$eval('#cr-content .cr-frame', f => {
      const wrap = f.parentElement.getBoundingClientRect(), r = f.getBoundingClientRect();
      return { frameR: Math.round(r.right), wrapR: Math.round(wrap.right), scroll: f.parentElement.classList.contains('cr-scroll') };
    });
    ok('…and the builder\'s preview is fitted again to the narrower pane (scaled to fit, or scrollable at full size — never cut off)',
      fitAi.scroll || fitAi.frameR <= fitAi.wrapR + 2, JSON.stringify(fitAi));
    await page.fill('.cr-ai-drawer .crai-in', 'Turf Install on all active jobs, last 30 days, with a chart');
    const sendTop = await page.evaluate(() => {
      const b = document.querySelector('.cr-ai-drawer .crai-send').getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit ? (hit.closest('.crai-send') ? 'send' : (hit.id || hit.className || hit.tagName)) : 'nothing';
    });
    ok('…and its Send button is not covered by anything (the page\'s floating assistant button sits beside it)', sendTop === 'send', sendTop);
    await page.click('.cr-ai-drawer .crai-send');
    await page.waitForSelector('.cr-ai-drawer [data-crai-act="undo"]', { timeout: 20000 }).catch(() => {});
    const req = SDK_CALLS[SDK_CALLS.length - 1];
    const reqText = req ? JSON.stringify(req.body.messages) : '';
    ok('the request reached the model through the real endpoint: its model, adaptive thinking, a JSON-schema answer with no includeInternal',
      req && req.body.model === ROUTES['/api/ai/report-builder'].MODEL && req.body.thinking && req.body.thinking.type === 'adaptive'
        && req.body.output_config && req.body.output_config.format && req.body.output_config.format.type === 'json_schema'
        && !JSON.stringify(req.body.output_config.format.schema).includes('includeInternal'), req && JSON.stringify(Object.keys(req.body)));
    ok('…the system prompt is one cached block, with no job in it', req && Array.isArray(req.body.system) && req.body.system.length === 1
      && req.body.system[0].cache_control && !JSON.stringify(req.body.system).includes(JOB1));
    ok('…and the jobs went as id, name, number, client and status only — no contract, PM or dates', req && reqText.includes(JOB1)
      && !reqText.includes('250000') && !/contract-amount|contract_value/.test(reqText) && !reqText.includes('Rivera') && !reqText.includes(daysFrom(60)),
      ['250000', 'contract-amount', 'Rivera', daysFrom(60)].filter(x => reqText.includes(x)).map(x => x + ' @ ' + reqText.slice(Math.max(0, reqText.indexOf(x) - 80), reqText.indexOf(x) + 40)).join(' | '));
    const st1 = await page.evaluate(() => { const d = window.FCTCustomReports._internals.state().doc; return JSON.parse(JSON.stringify({ def: d.def, picked: d.picked, name: d.name })); });
    ok('the answer is applied: both jobs (the unknown one dropped), the Turf Install filter (the junk code dropped), its two sections',
      JSON.stringify(st1.picked) === '["p1","p2"]' && JSON.stringify(st1.def.filters.subCodes) === '["Turf Install"]'
        && st1.def.sections.map(x => x.type).join() === 'plan_vs_actual,chart' && st1.def.layout === 'combined' && st1.def.dates.preset === 'last_30',
      JSON.stringify({ picked: st1.picked, f: st1.def.filters, s: st1.def.sections.map(x => x.type) }));
    ok('…customer-safe, as it was', st1.def.includeInternal === false);
    const aiText = await page.textContent('.cr-ai-drawer');
    ok('the drawer shows the reply and what changed', /Built a Turf Install report/.test(aiText) && /Filtered every section to Turf Install/.test(aiText));
    good = await waitPreview(page, "s.includes('sec-plan_vs_actual') && s.includes('Turf Install') && s.includes('<svg')", 'the preview redraws with the AI\'s report');
    if (good) {
      const html = await srcdoc(page);
      ok('…the title prints as text', html.includes('Turf Install — &lt;b&gt;active&lt;/b&gt; jobs') && !html.includes('<b>active</b>'));
    }
    await shotPair(page, 'f-ai-panel-reply');
    await page.click('.cr-ai-drawer [data-crai-act="undo"]');
    await sleep(400);
    const st2 = await page.evaluate(() => { const d = window.FCTCustomReports._internals.state().doc; return JSON.parse(JSON.stringify({ s: d.def.sections.map(x => x.type), picked: d.picked, f: d.def.filters })); });
    ok('Undo puts the report back as it was: its sections, its one job, no filter',
      JSON.stringify(st2.s) === JSON.stringify(before) && JSON.stringify(st2.picked) === '["p1"]' && st2.f.subCodes.length === 0, JSON.stringify(st2));
    // Costs asked for: the AI can add the column, never switch internal data on.
    AI_ANSWERS.push(body => ({
      reply: 'Added crew-hour rates. They are internal — switch on internal data yourself to see them.',
      changes: ['Added Units / Crew-Hour to Planned vs Actual'], needs_internal: true, clarifying_question: null,
      definition: { title: 'Turf crew rates', description: '', jobs: { mode: 'pick', ids: ['p1'] }, layout: 'separate', pageBreakPerJob: false,
        orientation: 'portrait', dates: { preset: 'last_30', from: '', to: '' }, filters: { costCodes: [], subCodes: [] },
        header: { preparedFor: '', intro: '', footer: '', showGenerated: true, branding: 'company', showPmContact: true },
        sections: [{ type: 'plan_vs_actual', title: 'Planned vs Actual', columns: ['sub_code', 'planned_rate', 'actual_rate', 'units_per_crew_hr'], labels: [], options: {} }] },
    }));
    await page.fill('.cr-ai-drawer .crai-in', 'Add the crew-hour rate and what it cost');
    await page.click('.cr-ai-drawer .crai-send');
    await page.waitForSelector('.cr-ai-drawer [data-crai-act="internal"]', { timeout: 20000 }).catch(() => {});
    ok('a request for costs shows "Turn on internal data…"', await page.locator('.cr-ai-drawer [data-crai-act="internal"]').count() === 1);
    let st3 = await page.evaluate(() => window.FCTCustomReports._internals.state().doc.def.includeInternal);
    ok('…and internal data stays off', st3 === false);
    good = await waitPreview(page, "s.includes('sec-plan_vs_actual') && !s.includes('Turf Install S-curve')", 'the preview redraws');
    if (good) ok('…so the crew-hour column is locked out of the preview', !/Crew-Hour/.test(await srcdoc(page)) && !/INTERNAL/.test(await srcdoc(page)));
    let askedInternal = '';
    page.once('dialog', d => { askedInternal = d.message(); d.dismiss().catch(() => {}); });
    await page.click('.cr-ai-drawer [data-crai-act="internal"]');
    await sleep(500);
    st3 = await page.evaluate(() => window.FCTCustomReports._internals.state().doc.def.includeInternal);
    ok('the button asks through the builder\'s own confirm; saying no leaves internal data off',
      /costs, rates, hours, employee names and profit/.test(askedInternal) && st3 === false, askedInternal);
    o = ourErrors(errors);
    ok('no page errors, and no console errors from the Custom Reporting files', o.length === 0, o.slice(0, 3).join(' | '));
    await ctx.close();

    // ── Kiewit: homes a day on the Home Set line ──
    console.log('\nKiewit — homes a day on the Home Set line');
    ({ ctx, page, errors } = await openPage(browser, baseUrl, 'kiewit', session));
    await openTab(page);
    await startStarter(page, 'sub_code_production');
    await pickJob(page, 'p1');
    await page.check('#cr-content input[data-bind="filter-sc"][value="Home Set"]');
    await page.selectOption('#cr-content [data-bind="preset"]', 'last_30');
    good = await waitPreview(page, "s.includes('Homes Set') && s.includes('sec-plan_vs_actual')", 'the Kiewit preview shows Homes Set');
    if (good) {
      const doc = docOf(await srcdoc(page));
      const st = strips(doc);
      const m = Object.values(st)[0] || {};
      ok('Division Rates on Kiewit: 5 homes set over 2 days, 2.5 a day; no tons or square feet on a Kiewit report',
        m['Homes Set'] === '5' && m['Homes / Day'] === '2.5' && m['Work Days'] === '2' && !/Tons|SF Installed/.test(cellText(doc.querySelector('section.sec-rate_summary'))),
        JSON.stringify(st));
      const t = tableIn(doc, 'plan_vs_actual');
      const r = t && t.rows.find(x => x.cells['Sub Code'] === 'Home Set');
      ok('…and Planned vs Actual: 2 a day planned (typed), 2.5 actual, 125%', r && r.cells['Planned / Day'] === '2' && r.cells['Actual / Day'] === '2.5'
        && r.cells['% of Planned Rate'] === '125.0%', r && JSON.stringify(r.cells));
    }
    o = ourErrors(errors);
    ok('no page errors, and no console errors from the Custom Reporting files', o.length === 0, o.slice(0, 3).join(' | '));
    await ctx.close();

    // ── (b) Paving: tons a day, tons per load, a chart in the print ──
    console.log('\nPaving — tons a day and tons per load off the trucking ticket, a chart in the print');
    ({ ctx, page, errors } = await openPage(browser, baseUrl, 'paving', session));
    await openTab(page);
    await startStarter(page, 'paving_tonnage');
    await pickJob(page, 'p1');
    await page.selectOption('#cr-content [data-bind="preset"]', 'last_30');
    await page.click('#cr-content [data-act="step"][data-step="2"]');
    await page.click('#cr-content [data-act="add-menu"]');
    await page.click('.cr-menu [data-act="add-section"][data-type="chart"]');
    const checkPaving = (html, where) => {
      const doc = docOf(html);
      const m = Object.values(strips(doc))[0] || {};
      ok(`${where}: Division Rates — 60 tons placed on 1 day: 60 a day; 3 loads off the ticket: 20 tons a load`,
        m['Tons Placed'] === '60' && m['Tons / Day'] === '60' && m['Work Days'] === '1' && m['Loads'] === '3' && m['Tons / Load'] === '20',
        JSON.stringify(m));
      ok(`${where}: …customer-safe — no crew-hour or equipment-hour rate, no driver, no ticket cost`,
        !/Crew-Hour|Equip-Hour|Avg Crew/.test(cellText(doc.body)) && !html.includes(SECRET_NAME) && !html.includes('$570'));
      const t = tableIn(doc, 'production_kpis');
      const r = t && t.rows.find(x => x.cells['Sub Code'] === 'Base Course');
      ok(`${where}: Production Rates shows Per Load on the Base Course line: 60 ÷ 3 = 20`, r && r.cells['Per Load'] === '20', r && JSON.stringify(r.cells));
      const tk = tableIn(doc, 'trucking');
      ok(`${where}: the haul log has the ticket's 3 loads`, tk && tk.rows.some(x => x.cells['Loads'] === '3'), tk && JSON.stringify(tk.rows.map(x => x.cells)));
      ok(`${where}: the chart is drawn as inline SVG that can fetch, run and link nothing`,
        doc.querySelectorAll('section.sec-chart figure.crc svg').length === 1 && svgSafe(html));
    };
    good = await waitPreview(page, "s.includes('Tons / Load') && s.includes('<svg')", 'the paving preview shows the rates and the chart');
    if (good) checkPaving(await srcdoc(page), 'preview');
    pr = await printFrom(page);
    if (pr.html) checkPaving(pr.html, 'print');
    else ok('the print window gets the paving report', false, pr.err && pr.err.message);
    await pr.popup.close().catch(() => {});
    o = ourErrors(errors);
    ok('no page errors, and no console errors from the Custom Reporting files', o.length === 0, o.slice(0, 3).join(' | '));
    await ctx.close();

    // ── (c) Branding: saved in divisions.html, worn by the report ──
    console.log('\nBranding — set in divisions.html (a real PNG through the logo picker), worn by the report');
    const BRAND = 'Keystone Paving & Sealcoating <Co>';
    const dctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const dpage = await dctx.newPage();
    const derr = [];
    dpage.on('pageerror', e => derr.push(String(e && e.message || e)));
    await dpage.addInitScript(([s]) => {
      // Seeded once: the page may reload itself after refreshing permissions.
      if (location.pathname.endsWith('.html') && !localStorage.getItem('fct_token')) {
        localStorage.setItem('fct_token', s.token);
        localStorage.setItem('fct_user', JSON.stringify(s.user));
      }
    }, [session]);
    await dpage.goto(`${baseUrl}/divisions.html`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await dpage.click('#addUserBtn');
    await dpage.click('#muTabBtnBranding');
    let brandReady = true;
    try { await dpage.waitForFunction(() => !document.getElementById('br-name').disabled, null, { timeout: 10000 }); }
    catch { brandReady = false; }
    ok('Manage System → Branding opens, editable for a company admin', brandReady && await dpage.isVisible('#mu-panel-branding'));
    await dpage.fill('#br-name', BRAND);
    await dpage.fill('#br-phone', '(717) 555-0100');
    await dpage.fill('#br-email', 'office@keystone.example');
    await dpage.fill('#br-website', 'www.keystone.example');
    await dpage.fill('#br-address', '12 Mill Rd\nYork, PA 17401');
    await dpage.setInputFiles('#br-logo-file', { name: 'logo.png', mimeType: 'image/png', buffer: makePng(900, 300) });
    await dpage.waitForFunction(() => /Logo ready/.test(document.getElementById('br-result').textContent), null, { timeout: 10000 }).catch(() => {});
    const brResultText = await dpage.textContent('#br-result');
    ok('the logo picker shrinks a 900 × 300 PNG to fit 600 × 200 and says so', /Logo ready — 600 × 200/.test(brResultText), brResultText);
    ok('…and the panel previews the masthead with the name (as text) and the logo',
      (await dpage.textContent('#br-preview .br-mast-co')) === BRAND && await dpage.locator('#br-preview img.br-mast-logo').count() === 1);
    await shotPair(dpage, 'g-branding-panel', { before: () => dpage.evaluate(() => { const el = document.getElementById('mu-panel-branding'); if (el) el.scrollIntoView({ block: 'start' }); }) });
    await dpage.click('#br-save');
    await dpage.waitForFunction(() => /Saved/.test(document.getElementById('br-result').textContent), null, { timeout: 10000 }).catch(() => {});
    const brow = (await db.query("SELECT * FROM company_branding WHERE company_code = $1 AND division = ''", [CO])).rows[0];
    ok('Save writes the company\'s branding: the name, a 600 × 200 PNG, the contact line (website made a web address)',
      brow && brow.display_name === BRAND && brow.logo_mime === 'image/png' && brow.logo_width === 600 && brow.logo_height === 200
        && brow.phone === '(717) 555-0100' && brow.website === 'https://www.keystone.example' && brow.updated_by_username === 'pat.admin',
      brow && JSON.stringify(Object.assign({}, brow, { logo_base64: (brow.logo_base64 || '').length })));
    ok('no page errors on divisions.html', derr.length === 0, derr.slice(0, 3).join(' | '));
    await dctx.close();

    ({ ctx, page, errors } = await openPage(browser, baseUrl, 'paving', session));
    await openTab(page);
    await startStarter(page, 'customer_progress');
    await pickJob(page, 'p1');
    good = await waitPreview(page, "s.includes('class=\"mast-logo\"') && s.includes('class=\"jb-pm\"') && s.includes('Questions? Maria')", 'the preview wears the branding');
    const checkBrand = (html, where) => {
      const doc = docOf(html);
      const img = doc.querySelector('.masthead img.mast-logo');
      ok(`${where}: the masthead carries the logo as a PNG data URI, its alt the company name`,
        img && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(img.getAttribute('src')) && img.getAttribute('alt') === BRAND);
      ok(`${where}: …and the company name, as text`, cellText(doc.querySelector('.masthead .mast-co')) === BRAND && !html.includes('<Co>'));
      ok(`${where}: one masthead, and the logo is the only image source in the document`,
        doc.querySelectorAll('[data-dw-brand]').length === 1 && (html.match(/\ssrc=/g) || []).length === 1);
      ok(`${where}: the job band names the project manager from the Team Directory ("Rivera, Maria" on the job)`,
        cellText(doc.querySelector('.jb-pm')) === `Project Manager: ${PM_NAME} · ${PM_PHONE} · ${PM_EMAIL}`, cellText(doc.querySelector('.jb-pm')));
      ok(`${where}: "Prepared by" is the person behind the login`, /Prepared by Pat Quinn/.test(cellText(doc.querySelector('.meta'))), cellText(doc.querySelector('.meta')));
      const foot = cellText(doc.querySelector('.rpt-foot'));
      ok(`${where}: the footer: Questions? the job's PM, the company's address and phone, Prepared with DataWatch`,
        foot.includes(`Questions? ${PM_NAME} · ${PM_PHONE} · ${PM_EMAIL}`) && foot.includes('12 Mill Rd, York, PA 17401 · (717) 555-0100')
          && /Prepared with DataWatch$/.test(foot), foot);
    };
    if (good) checkBrand(await srcdoc(page), 'preview');
    pr = await printFrom(page);
    if (pr.html) {
      checkBrand(pr.html, 'print');
      const shown = await pr.popup.$eval('.masthead img.mast-logo', i => ({ w: i.naturalWidth, h: i.naturalHeight })).catch(() => null);
      ok('print: the logo actually loads in the print window (600 × 200)', shown && shown.w === 600 && shown.h === 200, JSON.stringify(shown));
      await printedShots(browser, pr.html, 'k-printed-branded-report');
    } else ok('the print window gets the branded report', false, pr.err && pr.err.message);
    await pr.popup.close().catch(() => {});

    // ── (d) Contacts: a job contact, the email pre-fill, "Save as contact" ──
    console.log('\nContacts — a job contact, pre-filled in the email; a typed address saved from the email window');
    await page.click('#cr-content [data-act="contacts"]');
    await page.waitForSelector('#cr-content [data-act="ct-add"]', { timeout: 10000 });
    await page.click('#cr-content [data-act="ct-add"]');
    await page.selectOption('#cr-ct-job', 'p1');
    await page.fill('#cr-ct-email', 'Owner@Maple.example');
    await page.fill('#cr-ct-name', 'Olivia <Owner>');
    await page.fill('#cr-ct-title', 'Borough Manager');
    await page.selectOption('#cr-ct-role', 'owner');
    await page.click('#cr-content [data-act="ct-save"]');
    await page.waitForFunction(() => /Olivia <Owner>/.test((document.querySelector('#cr-content .cr-ct-list') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
    let crow = (await db.query('SELECT * FROM report_contacts WHERE company_code = $1 ORDER BY id', [CO])).rows;
    ok('Add contact writes it for the job: lower-cased address, name, role, auto-add on',
      crow.length === 1 && crow[0].project_id === 'p1' && crow[0].email === 'owner@maple.example' && crow[0].name === 'Olivia <Owner>'
        && crow[0].role === 'owner' && crow[0].auto_add === true && crow[0].division === 'paving' && crow[0].created_by_username === 'pat.admin',
      JSON.stringify(crow));
    ok('…and the Contacts list shows it under the job, the name as text',
      /Maple Ave Resurfacing/.test(await page.textContent('#cr-content .cr-ct-list')) && await page.locator('#cr-content .cr-ct-list b', { hasText: 'Olivia <Owner>' }).count() === 1);
    await shotPair(page, 'h-contacts-manager');
    await page.click('#cr-content [data-act="back"]');
    await page.waitForSelector('#cr-content .cr-edit');
    await page.click('#cr-content [data-act="step"][data-step="1"]');
    await page.waitForFunction(() => /1 contact/.test((document.querySelector('#cr-content .cr-job-ct') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    ok('step ① badges the job "1 contact"', /1 contact/.test(await page.textContent('#cr-content .cr-job-ct').catch(() => '')));
    await page.click('#cr-content [data-act="email"]');
    await page.waitForSelector('#rem-input', { timeout: 10000 });
    await page.waitForSelector('.rem-chip[data-email="owner@maple.example"]', { timeout: 8000 }).catch(() => {});
    const chip = page.locator('.rem-chip[data-email="owner@maple.example"]');
    ok('the email starts with the job\'s saved contact, by name, labelled where it came from',
      await chip.count() === 1 && /Olivia <Owner>/.test(await chip.textContent()) && /Job contact — Maple Ave Resurfacing/.test(await chip.getAttribute('title') || ''),
      await chip.count() && (await chip.textContent()) + ' / ' + (await chip.getAttribute('title')));
    await page.fill('#rem-input', 'super@keystone.example');
    await page.press('#rem-input', 'Enter');
    const saveBtn = page.locator('.rem-chip[data-email="super@keystone.example"] .rem-chip-save');
    ok('a typed address offers "☆ Save as contact"', await saveBtn.count() === 1 && /Save as contact/.test(await saveBtn.textContent()));
    await saveBtn.click();
    await page.waitForSelector('#rem-contact-name', { timeout: 5000 });
    await page.fill('#rem-contact-name', 'Sam Super');
    await page.selectOption('#rem-contact-role', 'gc');
    await page.click('#rem-contact-save');
    await page.waitForFunction(() => /Saved super@keystone\.example as a contact for this job/.test(document.getElementById('rem-status').textContent), null, { timeout: 8000 }).catch(() => {});
    crow = (await db.query('SELECT * FROM report_contacts WHERE company_code = $1 ORDER BY id', [CO])).rows;
    ok('"Save as contact" files it for this job, through the real /api/report-contacts',
      crow.length === 2 && crow[1].email === 'super@keystone.example' && crow[1].name === 'Sam Super' && crow[1].role === 'gc' && crow[1].project_id === 'p1',
      JSON.stringify(crow.map(c => [c.email, c.name, c.role, c.project_id])));
    ok('…and the chip says Saved', /Saved/.test(await page.locator('.rem-chip[data-email="super@keystone.example"]').textContent()));
    const SUBJECT = 'Maple Ave — weekly progress';
    await page.fill('#rem-subject', SUBJECT);
    await page.uncheck('#rem-pdf');
    await page.click('#rem-send');
    await page.waitForFunction(() => /sent|recipient|failed/i.test((document.getElementById('rem-status') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const sentRun = await waitFor(async () => (await db.query(
      "SELECT r.*, (a.run_id IS NOT NULL) AS archived FROM custom_report_runs r LEFT JOIN custom_report_run_archives a ON a.run_id = r.id WHERE r.company_code = $1 AND r.subject = $2 ORDER BY r.id", [CO, SUBJECT])).rows[0], 8000);
    ok('the email went to both contacts, customer-safe, logged as a user send of the job',
      sentRun && JSON.stringify([...sentRun.recipients].sort()) === '["owner@maple.example","super@keystone.example"]' && sentRun.run_kind === 'user'
        && sentRun.included_internal === false && JSON.stringify(sentRun.project_ids) === '["p1"]', sentRun && JSON.stringify(sentRun.recipients));
    ok('…and send-report archived exactly what it delivered', sentRun && sentRun.archived === true);
    const mailed = RESENT[RESENT.length - 1];
    ok('…which is what reached the mail service, under the company\'s own name', mailed && mailed.subject === SUBJECT
      && JSON.stringify([].concat(mailed.to).map(String).sort()) === '["owner@maple.example","super@keystone.example"]'
      && String(mailed.html || '').includes('Keystone Paving &amp; Sealcoating &lt;Co&gt;') && !String(mailed.html || '').includes('Browser test'),
      mailed && JSON.stringify({ to: mailed.to, s: mailed.subject }));

    // ── (e) Customer History: open the archived copy, resend it ──
    console.log('\nCustomer History — open exactly what was sent, and resend it');
    await page.click('#cr-content [data-act="customer"]');
    await page.waitForSelector('#cr-content [data-bind="cust-job"]');
    if ((await page.inputValue('#cr-content [data-bind="cust-job"]')) !== 'p1') await page.selectOption('#cr-content [data-bind="cust-job"]', 'p1');
    await page.waitForFunction(s => [...document.querySelectorAll('#cr-content .cr-cust tbody tr')].some(r => r.textContent.includes(s)), SUBJECT, { timeout: 10000 }).catch(() => {});
    const histRow = page.locator('#cr-content .cr-cust tbody tr', { hasText: SUBJECT });
    const histText = await histRow.count() ? await histRow.first().textContent() : '';
    ok('the job\'s history lists the email: subject, both recipients, who sent it, customer-safe',
      /owner@maple\.example, super@keystone\.example|super@keystone\.example, owner@maple\.example/.test(histText) && /pat\.admin/.test(histText) && /Customer-safe/.test(histText), histText);
    ok('…and only emails: the print and Excel runs of the first report are not in it',
      (await page.locator('#cr-content .cr-cust tbody tr').count()) === (await db.query("SELECT 1 FROM custom_report_runs WHERE company_code = $1 AND action = 'email' AND project_ids @> '[\"p1\"]'", [CO])).rows.length);
    await shotPair(page, 'i-customer-history');
    // What an opened copy is: the window's own document (the shell) and the
    // copy in its frame, read without running anything in either.
    const openCopy = async runId => {
      const [win] = await Promise.all([page.waitForEvent('popup'), page.click(`#cr-content [data-act="cust-open"][data-id="${runId}"]`)]);
      await win.waitForFunction(() => { const f = document.querySelector('iframe'); return !!(f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.childNodes.length); },
        null, { timeout: 15000 }).catch(() => {});
      await sleep(500);
      const seen = await win.evaluate(() => {
        const f = document.querySelector('iframe');
        const d = f && f.contentDocument;
        return { headFirst: document.head && document.head.firstElementChild ? document.head.firstElementChild.outerHTML : '',
          frames: document.querySelectorAll('iframe').length, sandbox: f ? f.getAttribute('sandbox') : null,
          copy: d && d.documentElement ? d.documentElement.outerHTML : '', shellRan: document.documentElement.getAttribute('data-ran'),
          copyRan: d && d.documentElement ? d.documentElement.getAttribute('data-ran') : null, pw: window.__pw, opener: window.opener === null,
          brandInShell: !!document.querySelector('body > [data-dw-brand]') };
      }).catch(err => ({ err: err.message }));
      return { win, seen };
    };
    const { win: opened, seen: os } = await openCopy(sentRun && sentRun.id);
    const openedHtml = os.copy || '';
    if (!openedHtml) ok('Open writes the archived copy into a window', false, JSON.stringify(os).slice(0, 300));
    const archived = sentRun && (await db.query('SELECT html_gzip_b64 FROM custom_report_run_archives WHERE run_id = $1', [sentRun.id])).rows[0];
    const archivedHtml = archived ? zlib.gunzipSync(Buffer.from(archived.html_gzip_b64, 'base64')).toString('utf8') : '';
    if (openedHtml) {
      ok('Open shows the archived copy — the branded report as it went, no "rebuilt" banner',
        textOf(openedHtml).includes(BRAND) && textOf(openedHtml).includes(JOB1) && !/Rebuilt from current data/.test(openedHtml)
          && textOf(openedHtml).replace(/\s+/g, ' ').trim() === textOf(archivedHtml).replace(/\s+/g, ' ').trim());
      ok('…in a frame sandboxed without scripts, in a window whose first word is a CSP of default-src none',
        os.frames === 1 && os.sandbox !== null && !/allow-scripts/.test(os.sandbox) && /^<meta http-equiv="Content-Security-Policy" content="default-src 'none'/.test(os.headFirst)
          && !os.brandInShell, JSON.stringify({ h: os.headFirst, s: os.sandbox }));
      const logo = await opened.evaluate(() => { const i = document.querySelector('iframe').contentDocument.querySelector('img.mast-logo'); return i ? i.naturalWidth : -1; }).catch(() => -2);
      ok('…the logo still shows in it (a data: image)', logo === 600, String(logo));
    }
    await opened.close().catch(() => {});

    // Copies that try to run something: an archive written before today's
    // sanitizer, or one a pattern-matcher missed. Put straight into the
    // archive table, past the sanitizer, as a level 1 login's sends to the
    // job; an admin opens each from the job's history. The only thing each
    // tries is to leave a mark — on its own document, the window around it,
    // or the app page that opened it.
    {
      const mark = "document.documentElement.setAttribute('data-ran','1');try{parent.document.documentElement.setAttribute('data-ran','1')}catch(e){}try{top.opener.__pw=1}catch(e){}try{window.__pw=1}catch(e){}";
      const HOSTILE = [
        ['comment-head', `<!--<head>--><img src="x"/onerror="${mark}"><p>Hostile comment-head</p>`],
        ['bare-fragment', `<p>Hostile bare-fragment</p><img src="x"/onerror="${mark}">`],
        ['script-space-close', `<script>${mark}</script ><head></head><p>Hostile script-space-close</p>`],
      ];
      const l1 = (await db.query(
        "INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('lee.level1', $1, 'x', 'level1', $2) RETURNING id",
        [CO, JSON.stringify({ paving: 'level1' })])).rows[0].id;
      const ids = [];
      for (const [name, html] of HOSTILE) {
        const run = (await db.query(`INSERT INTO custom_report_runs (company_code, division, report_name, action, project_ids, project_names, recipients, subject,
            included_internal, run_by_user_id, run_by_username, run_kind)
          VALUES ($1, 'paving', 'Looks normal', 'email', '["p1"]'::jsonb, $2::jsonb, '["owner@maple.example"]'::jsonb, $3, false, $4, 'lee.level1', 'user') RETURNING id`,
        [CO, JSON.stringify([JOB1]), 'Hostile ' + name, l1])).rows[0].id;
        const raw = Buffer.from(html, 'utf8');
        await db.query('INSERT INTO custom_report_run_archives (run_id, company_code, html_gzip_b64, html_bytes) VALUES ($1, $2, $3, $4)',
          [run, CO, zlib.gzipSync(raw).toString('base64'), raw.length]);
        ids.push([name, run]);
      }
      await page.click('#cr-content [data-act="cust-refresh"]').catch(() => {});
      await page.waitForFunction(() => /Hostile script-space-close/.test((document.querySelector('#cr-content .cr-cust') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
      for (const [name, run] of ids) {
        const { win, seen } = await openCopy(run);
        const appMark = await page.evaluate(() => window.__pw);
        ok(`a hostile archive (${name}) opened from the history runs nothing: no mark on the app page, the window or the copy`,
          appMark === undefined && seen.pw === undefined && seen.shellRan === null && seen.copyRan === null && seen.frames === 1
            && !/allow-scripts/.test(seen.sandbox || 'allow-scripts') && /^<meta http-equiv="Content-Security-Policy"/.test(seen.headFirst || '')
            && new RegExp('Hostile ' + name).test(seen.copy || ''), JSON.stringify(Object.assign({}, seen, { copy: (seen.copy || '').slice(0, 120) })));
        await win.close().catch(() => {});
      }
      await db.query('DELETE FROM custom_report_runs WHERE company_code = $1 AND run_by_username = $2', [CO, 'lee.level1']);
      await db.query('DELETE FROM users WHERE id = $1', [l1]);
      await page.click('#cr-content [data-act="cust-refresh"]').catch(() => {});
      await page.waitForFunction(() => !/Hostile/.test((document.querySelector('#cr-content .cr-cust') || {}).textContent || ''), null, { timeout: 10000 }).catch(() => {});
    }
    await page.click(`#cr-content [data-act="cust-resend"][data-id="${sentRun && sentRun.id}"]`);
    await page.waitForSelector('#rem-input', { timeout: 10000 });
    await page.waitForSelector('.rem-chip[data-email="super@keystone.example"]', { timeout: 5000 }).catch(() => {});
    ok('Resend opens the email with the same recipients and subject',
      (await page.inputValue('#rem-subject')) === SUBJECT && await page.locator('.rem-chip[data-email="owner@maple.example"]').count() === 1
        && await page.locator('.rem-chip[data-email="super@keystone.example"]').count() === 1, await page.inputValue('#rem-subject'));
    const resentBefore = RESENT.length;
    await page.uncheck('#rem-pdf');
    await page.click('#rem-send');
    await page.waitForFunction(() => /sent|recipient|failed/i.test((document.getElementById('rem-status') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const resend = await waitFor(async () => (await db.query(
      "SELECT r.*, (a.run_id IS NOT NULL) AS archived FROM custom_report_runs r LEFT JOIN custom_report_run_archives a ON a.run_id = r.id WHERE r.company_code = $1 AND r.run_kind = 'resend' ORDER BY r.id", [CO])).rows[0], 8000);
    ok('the resend is logged as run_kind resend, pointing at the email it repeats, and archived',
      resend && sentRun && Number(resend.resent_from_run_id) === Number(sentRun.id) && resend.subject === SUBJECT && resend.archived === true
        && JSON.stringify([...resend.recipients].sort()) === '["owner@maple.example","super@keystone.example"]', resend && JSON.stringify({ from: resend.resent_from_run_id, s: resend.subject }));
    ok('…and what went out the second time is the archived copy, unchanged',
      RESENT.length === resentBefore + 1 && textOf(String(RESENT[RESENT.length - 1].html || '')).includes(BRAND));
    await page.waitForFunction(() => /Resent/.test((document.querySelector('#cr-content .cr-cust tbody tr') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    ok('the history reloads with the resend on top, marked Resent', /Resent/.test(await page.textContent('#cr-content .cr-cust tbody tr').catch(() => '')));

    // ── (f) Schedules: made from the builder, Send now runs the real robot ──
    console.log('\nSchedules — made from the builder; Send now runs the real report robot (headless Chrome on paving.html)');
    await page.click('#cr-content [data-act="back"]');
    await page.waitForSelector('#cr-content .cr-edit');
    const SCHED_REPORT = 'Maple Ave — owner update';
    await page.click('#cr-content [data-act="step"][data-step="1"]');
    await page.check('#cr-content input[data-bind="save-jobs"]');
    await page.click('#cr-content [data-act="save"]');
    await page.waitForSelector('.cr-modal #cr-m-name');
    await page.fill('.cr-modal #cr-m-name', SCHED_REPORT);
    await page.click('.cr-modal [data-m="ok"]');
    await page.waitForSelector('.cr-modal', { state: 'detached', timeout: 10000 }).catch(() => {});
    const sr = (await db.query('SELECT * FROM custom_reports WHERE company_code = $1 AND name = $2', [CO, SCHED_REPORT])).rows[0];
    ok('the report is saved customer-safe, with its job', sr && sr.customer_safe === true && sr.kind === 'report', sr && JSON.stringify({ cs: sr.customer_safe, kind: sr.kind }));
    await page.waitForFunction(() => { const b = document.querySelector('#cr-content [data-act="schedule"]'); return b && !b.disabled; }, null, { timeout: 8000 }).catch(() => {});
    ok('Schedule… is on for a saved, customer-safe report', !(await page.isDisabled('#cr-content [data-act="schedule"]')));
    await page.click('#cr-content [data-act="schedule"]');
    await page.waitForSelector('.cr-modal #cr-s-freq', { timeout: 10000 });
    ok('the dialog sends the saved jobs, with each job\'s contacts on (one customer)',
      /The report’s saved jobs/.test(await page.textContent('.cr-modal')) && await page.isChecked('#cr-s-contacts') && !(await page.isDisabled('#cr-s-contacts')));
    ok('Weekly shows its day checkboxes and not the day of the month', await page.isVisible('#cr-s-days') && !(await page.isVisible('#cr-s-dom-row')));
    await page.selectOption('#cr-s-freq', 'monthly');
    ok('…Monthly the other way round', !(await page.isVisible('#cr-s-days')) && await page.isVisible('#cr-s-dom-row'));
    await page.selectOption('#cr-s-freq', 'weekly');
    await page.fill('#cr-s-email', 'pm@keystone.example');
    await page.press('#cr-s-email', 'Enter');
    await page.uncheck('#cr-s-pdf');
    await page.fill('#cr-s-subject', 'Maple Ave — owner update');
    await shotPair(page, 'j-schedules-dialog', { selector: '.cr-modal .cr-modal-box' });
    await page.click('.cr-modal [data-s="save"]');
    await page.waitForSelector('.cr-modal', { state: 'detached', timeout: 10000 }).catch(() => {});
    const sched = (await db.query('SELECT * FROM report_schedules WHERE company_code = $1', [CO])).rows[0];
    ok('Create writes the schedule: the custom report type, the saved report, its jobs mode, recipients, weekly Monday 7:00, run as the saver',
      sched && sched.report_type === 'paving_custom_report' && String(sched.custom_report_id) === String(sr && sr.id) && sched.jobs_mode === 'saved'
        && JSON.stringify(sched.emails) === '["pm@keystone.example"]' && sched.use_job_contacts === true && sched.frequency === 'weekly'
        && JSON.stringify(sched.days_of_week) === '[1]' && sched.send_time === '07:00' && sched.attach_pdf === false && sched.run_as_username === 'pat.admin'
        && sched.enabled === true && !!sched.next_run_at, sched && JSON.stringify(Object.assign({}, sched, { options: undefined })));
    await page.waitForFunction(n => (document.querySelector('#cr-content .cr-rail') || {}).textContent.includes(n), SCHED_REPORT, { timeout: 8000 }).catch(() => {});
    const railText = await page.textContent('#cr-content .cr-rail');
    ok('the rail\'s Schedules lists it with its cadence and next send', /Weekly Mon at 7:00 AM Eastern/.test(railText) && /Next /.test(railText), railText.slice(-300));
    const sendNow = async () => {
      // The rail redraws when the schedules list comes back; open the menu
      // on the settled rail.
      for (let i = 0; i < 5; i++) {
        // On screen first: a menu closes on any scroll, and Playwright
        // scrolling the button into view as it clicks would close it.
        await page.evaluate(id => document.querySelector(`#cr-content [data-act="sched-menu"][data-id="${id}"]`).scrollIntoView({ block: 'center', behavior: 'instant' }), sched.id);
        await sleep(400);
        await page.click(`#cr-content [data-act="sched-menu"][data-id="${sched.id}"]`);
        if (await page.waitForSelector('.cr-menu [data-act="sched-send"]', { timeout: 2000 }).then(() => true, () => false)) break;
      }
      page.once('dialog', d => d.accept().catch(() => {}));
      await page.click('.cr-menu [data-act="sched-send"]');
    };
    const mailsBefore = RESENT.length;
    if (!ROBOT_CHROME) console.log('  (no Chrome for the robot on this box — Send now is not exercised)');
    else {
      await sendNow();
      const status = await waitFor(async () => {
        const r = (await db.query('SELECT last_status, last_message FROM report_schedules WHERE id = $1', [sched.id])).rows[0];
        return r && r.last_status && !/sending|running/.test(r.last_status) ? r : null;
      }, 240000, 1000);
      const runs = (await db.query(`SELECT r.*, a.html_gzip_b64 FROM custom_report_runs r LEFT JOIN custom_report_run_archives a ON a.run_id = r.id
        WHERE r.company_code = $1 AND r.schedule_id = $2 ORDER BY r.id`, [CO, sched.id])).rows;
      ok('Send now ran the real robot and sent it', status && status.last_status === 'sent', status && JSON.stringify(status));
      const run = runs[0];
      ok('…logged in the send history as run_kind send_now, an email, customer-safe, for the saved report and its job',
        runs.length === 1 && run.run_kind === 'send_now' && run.action === 'email' && run.included_internal === false
          && String(run.report_id) === String(sr && sr.id) && JSON.stringify(run.project_ids) === '["p1"]', run && JSON.stringify({ k: run.run_kind, a: run.action }));
      ok('…to the schedule\'s address and each saved contact of the job',
        run && JSON.stringify([...run.recipients].sort()) === '["owner@maple.example","pm@keystone.example","super@keystone.example"]', run && JSON.stringify(run.recipients));
      const robotHtml = run && run.html_gzip_b64 ? zlib.gunzipSync(Buffer.from(run.html_gzip_b64, 'base64')).toString('utf8') : '';
      ok('…with the HTML archived: the page\'s own build, branded, customer-safe',
        textOf(robotHtml).includes(BRAND) && textOf(robotHtml).includes(JOB1) && !/data-cr-internal="1"/.test(robotHtml)
          && !robotHtml.includes(SECRET_NAME) && /Project Manager: Maria Rivera/.test(textOf(robotHtml)), robotHtml.slice(0, 200));
      const robotMail = RESENT[RESENT.length - 1];
      ok('…and the mail service got one email, with the schedule\'s subject', RESENT.length === mailsBefore + 1 && robotMail
        && /Maple Ave — owner update/.test(robotMail.subject), robotMail && robotMail.subject);
      ok('…headed with the company\'s branding name, as a hand-sent email is (not the account\'s company name)',
        robotMail && !String(robotMail.html || '').includes('Browser test'),
        robotMail && (String(robotMail.html || '').match(/.{80}Browser test.{40}/) || [''])[0]);
      await page.waitForFunction(() => /Sent/.test((document.querySelector('.cr-toast') || {}).textContent || '') || /Last: sent/.test((document.querySelector('#cr-content .cr-rail') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
      ok('the builder says it went', /Last: sent/.test(await page.textContent('#cr-content .cr-rail')));

      // Internal data on: the next run is refused, in plain words.
      await page.click('#cr-content [data-act="step"][data-step="2"]');
      let intAsk = '';
      page.once('dialog', d => { intAsk = d.message(); d.accept().catch(() => {}); });
      await page.click('#cr-content label.cr-switch');
      await page.waitForSelector('#cr-content .cr-banner-int', { timeout: 5000 }).catch(() => {});
      ok('switching internal data on for a scheduled report says the scheduled sends will stop',
        /This report is scheduled — scheduled sends will stop until it is customer-safe again\./.test(intAsk), intAsk);
      await page.keyboard.press('Control+s');
      await waitFor(async () => (await db.query('SELECT customer_safe FROM custom_reports WHERE id = $1', [sr.id])).rows[0].customer_safe === false, 8000);
      const mails2 = RESENT.length;
      await sendNow();
      const refused = await waitFor(async () => {
        const r = (await db.query('SELECT last_status, last_message FROM report_schedules WHERE id = $1', [sched.id])).rows[0];
        return r && r.last_status === 'failed' ? r : null;
      }, 120000, 1000);
      ok('the next Send now fails, saying why in plain words', refused && /internal data/.test(refused.last_message) && /customer-safe only/.test(refused.last_message),
        refused && refused.last_message);
      ok('…nothing was sent, nothing logged', RESENT.length === mails2
        && (await db.query('SELECT COUNT(*)::int AS n FROM custom_report_runs WHERE schedule_id = $1', [sched.id])).rows[0].n === 1);
      await page.waitForFunction(() => /customer-safe only/.test((document.querySelector('.cr-toast') || {}).textContent || '')
        || /customer-safe only/.test((document.querySelector('#cr-content .cr-rail') || {}).textContent || ''), null, { timeout: 15000 }).catch(() => {});
      ok('…and the builder shows the reason', /customer-safe only/.test((await toastText(page)) + (await page.textContent('#cr-content .cr-rail'))));
    }
    o = ourErrors(errors);
    ok('no page errors, and no console errors from the Custom Reporting files', o.length === 0, o.slice(0, 3).join(' | '));
    await ctx.close();

    // ── The same schedule in divisions.html → Auto Reports: read-only there ──
    console.log('\nAuto Reports (divisions.html) — the custom schedule, shown and managed elsewhere');
    const actx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const apage = await actx.newPage();
    const aerr = [];
    apage.on('pageerror', e => aerr.push(String(e && e.message || e)));
    await apage.addInitScript(([s]) => {
      if (location.pathname.endsWith('.html') && !localStorage.getItem('fct_token')) {
        localStorage.setItem('fct_token', s.token);
        localStorage.setItem('fct_user', JSON.stringify(s.user));
      }
    }, [session]);
    await apage.goto(`${baseUrl}/divisions.html`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    await apage.click('#addUserBtn');
    await apage.click('#muTabBtnReports');
    await apage.waitForFunction(n => [...document.querySelectorAll('.ar-row')].some(r => r.textContent.includes(n)), SCHED_REPORT, { timeout: 10000 }).catch(() => {});
    const arRow = apage.locator('.ar-row', { hasText: SCHED_REPORT });
    const arText = await arRow.count() ? (await arRow.first().textContent()).replace(/\s+/g, ' ') : '';
    ok('the Paving card lists it by the saved report\'s name, who it goes to and "Managed in Analytics → Custom Reporting"',
      /Custom Report/.test(arText) && /Managed in Analytics → Custom Reporting/.test(arText) && /To 1 address, each job's saved contacts/.test(arText), arText);
    ok('…with the refusal that stopped its last send, in the same plain words', /now includes internal data — scheduled sends are customer-safe only/.test(arText));
    ok('…its Edit is off, and there is no Send now there', await arRow.count() === 1 && await arRow.first().locator('.user-edit-btn').isDisabled()
      && await arRow.first().locator('.ar-send-btn').count() === 0);
    ok('no page errors on divisions.html', aerr.length === 0, aerr.slice(0, 3).join(' | '));
    await actx.close();

  } catch (err) {
    ok('the run finished without an exception', false, err.stack || err.message);
  } finally {
    await browser.close().catch(() => {});
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* fine */ }
    await cleanUp().catch(() => {});
    await db.end().catch(() => {});
  }

  if (SCREENS) console.log(`\nscreenshots: ${SCREENS}`);
  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
