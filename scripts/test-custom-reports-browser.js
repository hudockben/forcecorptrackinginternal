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
  if (request === 'resend') {
    return { Resend: class {
      constructor() { this.emails = { send: async o => { RESENT.push(o); return { data: { id: 'stub-' + RESENT.length }, error: null }; } }; }
    } };
  }
  return origLoad.apply(this, arguments);
};
const handler = require(path.join(ROOT, 'api/custom-reports.js'));
const sendReport = require(path.join(ROOT, 'api/email/send-report.js'));
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

function divisionData(keyPfx) {
  const projects = [
    { id: 'p1', 'project-name': JOB1, 'job-number': '26101', status: 'In Progress', client: 'Borough of Maple',
      gc: 'Keystone GC', address: '12 Maple Ave', 'city-state': 'Maple, PA', 'start-date': daysFrom(-240),
      'end-date': daysFrom(60), 'contract-amount': 250000,
      bidItems: [
        { id: 'p1-b1', cost_code: '0100', sub_code: 'Milling', description: 'Mill existing surface', unit: 'SY',
          quantity: 1000, unit_cost: 4.5, start_date: daysFrom(-30), target_date: daysFrom(20) },
        { id: 'p1-b2', cost_code: '0200', sub_code: 'Base Course', description: 'Stone base', unit: 'TON',
          quantity: 400, unit_cost: 85, start_date: daysFrom(-10), target_date: daysFrom(30),
          change_orders: [{ date: daysFrom(-5), qty_delta: 50, note: 'Driveway apron added' }] },
      ] },
    { id: 'p2', 'project-name': JOB2, 'job-number': '26102', status: 'In Progress', client: 'Oak Holdings LLC',
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
  return { store, rows, projects };
}
const PAGES = {
  paving: { file: 'paving.html',          label: 'Paving',          data: divisionData('fct_paving_') },
  turf:   { file: 'tracker.html',         label: 'Turf Management', data: divisionData('fct_') },
  kiewit: { file: 'kiewit-pinetree.html', label: 'Kiewit Pinetree', data: divisionData('fct_kiewit_') },
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
async function runHandler(req, res, u, fn = handler, log = CR_CALLS) {
  const raw = await readBody(req);
  let body;
  if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
  const query = Object.fromEntries(u.searchParams);
  log.push(fn === handler ? { method: req.method, query, body } : body);
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
    if (p === '/api/trucking')        return json(res, { truckingEntries: [] });
    return json(res, {});
  }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
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
  await page.click(`.cr-card[data-starter="${id}"]`);
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

// ── The run ──────────────────────────────────────────────────────────────
const CO = 'CRBROWSER';
async function cleanUp() {
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
