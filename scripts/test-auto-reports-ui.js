#!/usr/bin/env node
'use strict';
/**
 * Manage Users → Auto Reports, clicked through in a real browser, against the
 * real API and a real Postgres.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-auto-reports-ui.js
 *      (skips cleanly without a Chrome; set CHROME_EXECUTABLE_PATH, or have
 *       Playwright's Chromium at /opt/pw-browsers)
 *
 * The tab is the whole of what an admin sees of this feature, so it is
 * driven the way an admin drives it: the flag on Manage Users before anything
 * is opened, a division card's "+ Add", the weekday buttons, Save, the switch,
 * Send now, a new recipient group, Delete — and each step checked in the
 * database, not just on screen. The page's own requests go to the real
 * handlers (auth included: the token is signed and the account read back).
 * The one thing replaced is the send itself (runner.runSchedule), which
 * test-auto-report-browser.js covers.
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');
const Module = require('module');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const CHROME = [
  process.env.CHROME_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.log('no Chrome/Chromium on this box — skipping'); process.exit(0); }
process.env.CHROME_EXECUTABLE_PATH = CHROME;

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) { console.error(`Refusing to run: "${dbName}" does not look like a test database.`); process.exit(1); }

process.env.JWT_SECRET   = 'auto-reports-ui-secret';
process.env.DATABASE_URL = URL;

const client = new Pool({ connectionString: URL, max: 4 });
function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  return origLoad.apply(this, arguments);
};

const jwt     = require('jsonwebtoken');
const runner  = require(path.join(ROOT, 'api/lib/report-schedule-runner.js'));
const { launchBrowser } = require(path.join(ROOT, 'api/lib/pdf.js'));
const ROUTES = {
  '/api/auth/verify':             require(path.join(ROOT, 'api/auth/verify.js')),
  '/api/email/report-schedules':  require(path.join(ROOT, 'api/email/report-schedules.js')),
  '/api/email/recipient-groups':  require(path.join(ROOT, 'api/email/recipient-groups.js')),
  '/api/company/users':           require(path.join(ROOT, 'api/company/users.js')),
};

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(d).slice(0, 300) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Vercel's (req, res) on top of node's.
function adapt(handler) {
  return (req, res, body) => {
    const u = new globalThis.URL(req.url, 'http://x');
    const vreq = { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body };
    const vres = {
      statusCode: 200,
      setHeader: (k, v) => res.setHeader(k, v),
      status(c) { this.statusCode = c; return this; },
      json(o) { res.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); return this; },
      end() { res.writeHead(this.statusCode); res.end(); return this; },
    };
    return Promise.resolve(handler(vreq, vres)).catch(err => { res.writeHead(500); res.end(String(err.message)); });
  };
}

let failJobList = false;   // the editor's job list read fails while this is set
let slowListMs = 0;        // the tab's list read takes this long
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new globalThis.URL(req.url, 'http://x').pathname);
  if (failJobList && /[?&]projects=/.test(req.url)) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Database unavailable' }));
  }
  if (slowListMs && p === '/api/email/report-schedules' && req.method === 'GET' && !/[?&]projects=/.test(req.url)) {
    const wait = slowListMs;
    let raw0 = '';
    req.on('data', c => { raw0 += c; });
    req.on('end', () => setTimeout(() => adapt(ROUTES[p])(req, res, {}), wait));
    return;
  }
  if (ROUTES[p]) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => { let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {} adapt(ROUTES[p])(req, res, body); });
    return;
  }
  if (p.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
  const f = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(f));
});

const CO = 'ARUI';
const db = {
  q: (t, v) => client.query(t, v).then(r => r.rows),
  schedules: () => client.query('SELECT * FROM report_schedules WHERE company_code = $1 ORDER BY id', [CO]).then(r => r.rows),
};

async function cleanUp() {
  await client.query('DELETE FROM report_schedules WHERE company_code = $1', [CO]);
  await client.query('DELETE FROM report_recipient_groups WHERE company_code = $1', [CO]);
  await client.query('DELETE FROM app_data WHERE key LIKE $1', [CO + ':%']);
  await client.query('DELETE FROM companies WHERE code = $1', [CO]);
}

(async () => {
  await cleanUp();
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Force Corp UI test', '{turf,paving}')", [CO]);
  const roles = { turf: 'admin', paving: 'admin', dust: 'admin', executive: 'admin', payroll: 'admin' };
  const adminId = (await client.query(
    "INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ('benadmin', $1, 'x', 'admin', $2) RETURNING id",
    [CO, JSON.stringify(roles)])).rows[0].id;
  const g1 = Number((await client.query("INSERT INTO report_recipient_groups (company_code, name, emails) VALUES ($1, 'Paving PMs', $2) RETURNING id",
    [CO, JSON.stringify(['pm@example.com', 'super@example.com'])])).rows[0].id);
  await client.query("INSERT INTO app_data (key, value) VALUES ($1, $2)", [CO + ':fct_paving_projects_index', JSON.stringify(['pv1', 'pv2'])]);
  await client.query("INSERT INTO app_data (key, value) VALUES ($1, $2)", [CO + ':fct_paving_project_pv1', JSON.stringify({ id: 'pv1', 'project-name': 'Route 30 Overlay', 'job-number': '26201', status: 'In Progress' })]);
  await client.query("INSERT INTO app_data (key, value) VALUES ($1, $2)", [CO + ':fct_paving_project_pv2', JSON.stringify({ id: 'pv2', 'project-name': 'Mall Lot', 'job-number': '25110', status: 'Complete' })]);
  // A turf report that failed this morning — the flag should be up before anything is opened.
  await client.query(`INSERT INTO report_schedules
      (company_code, report_type, division, project_id, project_name, frequency, send_time, group_ids, run_as_user_id, run_as_username,
       next_run_at, last_run_at, last_status, last_message)
    VALUES ($1, 'turf_daily_pm', 'turf', '*', NULL, 'weekdays', '06:30', $2, $3, 'benadmin',
       NOW() + interval '20 hours', NOW() - interval '3 hours', 'failed', 'Maple Ave: the report is too large to email.')`,
    [CO, JSON.stringify([g1]), adminId]);

  const token = jwt.sign({ userId: adminId, username: 'benadmin', companyCode: CO, companyName: 'Force Corp UI test',
    role: 'admin', divisionRoles: roles, allowedDivisions: Object.keys(roles), isPlatformAdmin: false },
    process.env.JWT_SECRET, { expiresIn: '1h' });
  const userBlob = JSON.stringify({ username: 'benadmin', companyCode: CO, companyName: 'Force Corp UI test', role: 'admin',
    divisionRoles: roles, allowedDivisions: Object.keys(roles), isPlatformAdmin: false });

  let sendNowCalls = 0;
  let sendGate = null;   // while set, a send waits on it — a send still going
  runner.runSchedule = async () => {
    sendNowCalls++;
    if (sendGate) await sendGate;
    return { status: 'sent', sent: 1, total: 1, recipientCount: 2, message: 'Sent to 2 recipients.' };
  };

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser();
  const shots = process.env.SHOT_DIR || '';
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
    // Seeded once: the page refreshes fct_user from /api/auth/verify and
    // reloads, and re-seeding on that reload would loop it forever.
    await page.evaluateOnNewDocument((t, u) => {
      if (localStorage.getItem('fct_token')) return;
      localStorage.setItem('fct_token', t);
      localStorage.setItem('fct_user', u);
    }, token, userBlob);
    await page.goto(base + '/divisions.html', { waitUntil: 'domcontentloaded' });
    await sleep(1500);   // the permissions refresh may reload the page once

    if (process.env.DEBUG_UI) {
      page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('  [nav]', f.url()); });
      page.on('response', r => { if (r.url().includes('/api/')) console.log('  [api]', r.status(), r.url()); });
      await sleep(3000);
    }
    console.log('The flag, before anything is opened');
    await page.waitForFunction(() => document.getElementById('addUserBtn').classList.contains('has-flag'), { timeout: 8000 }).catch(() => {});
    ok('a failed report puts a dot on Manage Users', await page.$eval('#addUserBtn', b => b.classList.contains('has-flag')));
    ok('…and says why on hover', /1 scheduled report needs attention/.test(await page.$eval('#addUserBtn', b => b.title)));

    await page.click('#addUserBtn');
    await page.waitForFunction(() => document.getElementById('muTabCountReports').textContent === '1', { timeout: 8000 }).catch(() => {});
    ok('the Auto Reports tab carries the count', await page.$eval('#muTabCountReports', e => e.textContent) === '1');

    console.log('\nThe tab');
    await page.click('#muTabBtnReports');
    await page.waitForSelector('.ar-div', { timeout: 8000 });
    const cards = await page.$$eval('.ar-div .ar-div-name', els => els.map(e => e.textContent));
    ok('one card per division the admin can open, in order', JSON.stringify(cards) === '["Turf Management","Paving","Dust Control","Executive","Payroll"]', JSON.stringify(cards));
    const failedRow = await page.$eval('.ar-row', r => ({ cls: r.className, text: r.innerText }));
    ok('the failed report is flagged red, with its reason',
      /flag-bad/.test(failedRow.cls) && /FAILED/i.test(failedRow.text) && /too large to email/.test(failedRow.text), failedRow.text);
    ok('…and reads as what it is: every In Progress job, weekdays at 6:30',
      /Every In Progress job/.test(failedRow.text) && /Weekdays · 6:30 AM/.test(failedRow.text) && /Paving PMs \(2\)/.test(failedRow.text), failedRow.text);
    if (shots) await page.screenshot({ path: path.join(shots, 'ar-list.png'), fullPage: false });

    console.log('\nScheduling a Paving report');
    await page.evaluate(() => [...document.querySelectorAll('.ar-div')].find(d => d.querySelector('.ar-div-name').textContent === 'Paving').querySelector('.mu-tool-btn').click());
    await page.waitForFunction(() => document.getElementById('ar-form').classList.contains('open'));
    ok('+ Add opens the form on that division', await page.$eval('#ar-division', s => s.value) === 'paving');
    await page.waitForFunction(() => [...document.querySelectorAll('#ar-job option')].some(o => o.value === 'pv1'), { timeout: 8000 }).catch(() => {});
    const jobs = await page.$$eval('#ar-job option', os => os.map(o => o.textContent));
    ok('the job picker offers every In Progress job, then the jobs by status',
      jobs[0] === 'Every In Progress job — one email each' && jobs.includes('Route 30 Overlay (26201)') && jobs.includes('Mall Lot (25110) — Complete'),
      JSON.stringify(jobs));
    await page.select('#ar-job', 'pv1');
    await page.click('#ar-freq button[data-f="weekly"]');
    // Monday is on by default; add Wednesday and Friday.
    await page.click('#ar-dow button[aria-label="Wed"]');
    await page.click('#ar-dow button[aria-label="Fri"]');
    await page.$eval('#ar-time', el => { el.value = '07:15'; el.dispatchEvent(new Event('change')); });
    await page.click(`#ar-groups input[value="${g1}"]`);
    const summary = await page.$eval('#ar-summary', e => e.textContent);
    ok('the form says in one sentence what Save will do',
      /Sends the Daily PM Report for Route 30 Overlay \(26201\) every Mon, Wed, Fri at 7:15 AM Eastern, to Paving PMs/.test(summary), summary);
    if (shots) await page.screenshot({ path: path.join(shots, 'ar-form.png'), fullPage: false });
    await page.click('#ar-save');
    await page.waitForFunction(() => !document.getElementById('ar-form').classList.contains('open'), { timeout: 8000 }).catch(() => {});
    let rows = await db.schedules();
    const made = rows.find(r => r.division === 'paving');
    ok('Save writes the schedule',
      made && made.report_type === 'paving_daily_pm' && made.project_id === 'pv1' && made.project_name === 'Route 30 Overlay'
        && made.frequency === 'weekly' && JSON.stringify(made.days_of_week) === '[1,3,5]' && made.send_time === '07:15'
        && JSON.stringify(made.group_ids) === JSON.stringify([g1]) && made.enabled === true,
      JSON.stringify(made));
    ok('…for its next Monday, Wednesday or Friday', made && [1, 3, 5].includes(new Date(new Date(made.next_run_at).getTime() - 4 * 3600e3).getUTCDay()));
    ok('…and says when that is', /Saved\. Next send: /.test(await page.$eval('#ar-status', e => e.textContent)));
    await page.waitForFunction(id => document.querySelector(`.ar-row[data-id="${id}"]`), {}, made.id);
    ok('the Paving card shows it', /Mon, Wed, Fri · 7:15 AM/.test(await page.$eval(`.ar-row[data-id="${made.id}"]`, r => r.innerText)));

    console.log('\nEditing it');
    await page.click(`.ar-row[data-id="${made.id}"] .user-edit-btn`);
    await page.waitForFunction(() => document.getElementById('ar-form').classList.contains('open'));
    await page.waitForFunction(() => document.getElementById('ar-job').value === 'pv1', { timeout: 8000 }).catch(() => {});
    ok('Edit opens on the saved job and days',
      await page.$eval('#ar-job', s => s.value) === 'pv1'
        && JSON.stringify(await page.$$eval('#ar-dow button.on', bs => bs.map(b => b.getAttribute('aria-label')))) === '["Mon","Wed","Fri"]');
    await page.click('#ar-freq button[data-f="monthly"]');
    await page.select('#ar-dom', '-1');
    await page.click('#ar-save');
    await page.waitForFunction(() => !document.getElementById('ar-form').classList.contains('open'), { timeout: 8000 }).catch(() => {});
    rows = await db.schedules();
    const edited = rows.find(r => r.id === made.id);
    ok('…and the change is saved', edited.frequency === 'monthly' && edited.day_of_month === -1, JSON.stringify(edited));

    console.log('\nThe switch');
    await page.click(`.ar-row[data-id="${made.id}"] .sup-toggle`);
    await sleep(600);
    ok('switching it off stops it', (await db.schedules()).find(r => r.id === made.id).enabled === false);
    ok('…and the row says Off', /OFF/i.test(await page.$eval(`.ar-row[data-id="${made.id}"] .ar-badge`, b => b.textContent)));
    await page.click(`.ar-row[data-id="${made.id}"] .sup-toggle`);
    await sleep(600);
    ok('switching it back on gives it a next send', (await db.schedules()).find(r => r.id === made.id).next_run_at !== null);

    console.log('\nWhen its time comes');
    await db.q("UPDATE report_schedules SET next_run_at = NOW() - interval '1 minute' WHERE id = $1", [made.id]);
    await page.select('#ar-filter-state', '');
    await page.evaluate(() => loadAutoReports());
    await page.waitForFunction(id => /Due now/i.test((document.querySelector(`.ar-row[data-id="${id}"] .ar-badge`) || {}).textContent || ''), { timeout: 8000 }, made.id).catch(() => {});
    const due = await page.$eval(`.ar-row[data-id="${made.id}"]`, r => ({ cls: r.className, text: r.innerText }));
    ok('a report whose time has come is flagged Due now', /flag-due/.test(due.cls) && /DUE NOW/i.test(due.text), due.text);
    await page.select('#ar-filter-state', 'attention');
    const attention = await page.$$eval('.ar-row', rs => rs.map(r => r.dataset.id));
    ok('Needs attention shows the due one and the failed one', attention.length === 2, JSON.stringify(attention));
    await page.select('#ar-filter-state', '');

    console.log('\nSend now');
    dialogs.length = 0;
    await page.click(`.ar-row[data-id="${made.id}"] .ar-send-btn`);
    await page.waitForFunction(() => /Sent/.test(document.getElementById('ar-status').textContent), { timeout: 8000 }).catch(() => {});
    ok('asks before sending to real people', dialogs.length === 1 && /Send Daily PM Report now to Paving PMs/.test(dialogs[0]), JSON.stringify(dialogs));
    ok('sends it and says how it went', sendNowCalls === 1 && /Sent to 2 recipients/.test(await page.$eval('#ar-status', e => e.textContent)));
    await page.waitForFunction(() => /Send now · benadmin/.test(document.getElementById('ar-hist-body').innerText), { timeout: 8000 }).catch(() => {});
    ok('…and it is in Recent sends', /Send now · benadmin/.test(await page.$eval('#ar-hist-body', b => b.innerText)));

    console.log('\nSend now, pressed again while it is still going');
    let release;
    sendGate = new Promise(r => { release = r; });
    dialogs.length = 0;
    const callsBefore = sendNowCalls;
    await page.click(`.ar-row[data-id="${made.id}"] .ar-send-btn`);
    await page.waitForFunction(() => /Building/.test(document.getElementById('ar-status').textContent), { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => loadAutoReports({ quiet: true }));   // the 30-second refresh, mid-send
    await sleep(500);
    const mid = await page.$eval(`.ar-row[data-id="${made.id}"]`, r => ({ text: r.innerText, disabled: r.querySelector('.ar-send-btn').disabled }));
    ok('a refresh mid-send keeps the row Sending…, its button off', /SENDING/i.test(mid.text) && mid.disabled === true, JSON.stringify(mid));
    await page.evaluate(id => arSendNow(id), Number(made.id));   // a second press, past the button
    await sleep(300);
    ok('…and a second press asks nothing and sends nothing', dialogs.length === 1 && sendNowCalls === callsBefore + 1,
      JSON.stringify({ dialogs, calls: sendNowCalls - callsBefore }));
    release();
    sendGate = null;
    await page.waitForFunction(id => /Send now/.test(document.querySelector(`.ar-row[data-id="${id}"] .ar-send-btn`).textContent), { timeout: 8000 }, made.id).catch(() => {});
    ok('…then, once it is sent, the button comes back',
      await page.$eval(`.ar-row[data-id="${made.id}"] .ar-send-btn`, b => !b.disabled && b.textContent === 'Send now'));

    console.log('\nA run that was cut off');
    await db.q(`UPDATE report_schedules SET last_status = 'sending', last_run_at = NOW() - interval '40 minutes',
        claimed_at = NOW() - interval '40 minutes', claim_token = 'gone', next_run_at = NOW() + interval '1 day' WHERE id = $1`, [made.id]);
    await page.evaluate(() => loadAutoReports({ quiet: true }));
    await page.waitForFunction(id => /Interrupted/i.test((document.querySelector(`.ar-row[data-id="${id}"] .ar-badge`) || {}).textContent || ''), { timeout: 8000 }, made.id).catch(() => {});
    const cut = await page.$eval(`.ar-row[data-id="${made.id}"]`, r => ({ cls: r.className, text: r.innerText }));
    ok('reads Interrupted, flagged red, not Sending… forever',
      /flag-bad/.test(cut.cls) && /INTERRUPTED/i.test(cut.text) && !/SENDING/i.test(cut.text), cut.text);
    ok('…and says some of it may have gone out', /Some of its emails may have gone out/.test(cut.text), cut.text);
    await db.q("UPDATE report_schedules SET claimed_at = NULL, claim_token = NULL WHERE id = $1", [made.id]);

    console.log('\nThe job list, when it cannot be read');
    await page.evaluate(() => { delete arProjects.paving; });
    failJobList = true;
    await page.click(`.ar-row[data-id="${made.id}"] .user-edit-btn`);
    await page.waitForFunction(() => /Could not load the job list/.test(document.getElementById('ar-form-result').textContent), { timeout: 8000 }).catch(() => {});
    const failedPick = await page.$eval('#ar-job', s => ({ value: s.value, text: s.selectedOptions[0] && s.selectedOptions[0].textContent }));
    ok('Edit says so, and stays on the saved job — not "every job"',
      failedPick.value === 'pv1' && /Route 30 Overlay/.test(failedPick.text), JSON.stringify(failedPick));
    await page.click('#ar-save');
    await page.waitForFunction(() => !document.getElementById('ar-form').classList.contains('open'), { timeout: 8000 }).catch(() => {});
    const kept = (await db.schedules()).find(r => r.id === made.id);
    ok('…and Save keeps the schedule on that job', kept && kept.project_id === 'pv1', JSON.stringify(kept && kept.project_id));
    failJobList = false;

    console.log('\nA new recipient group, from the form');
    await page.evaluate(() => arNew('dust'));
    await page.click('#ar-newgroup-btn');
    await page.type('#ar-ng-name', 'Dust Office');
    await page.type('#ar-ng-emails', 'dust@example.com, Billing@Example.com');
    await page.evaluate(() => arSaveNewGroup());
    await page.waitForFunction(() => [...document.querySelectorAll('#ar-groups label')].some(l => /Dust Office/.test(l.textContent)), { timeout: 8000 }).catch(() => {});
    const ng = await db.q("SELECT * FROM report_recipient_groups WHERE company_code = $1 AND name = 'Dust Office'", [CO]);
    ok('is saved with its addresses', ng.length === 1 && JSON.stringify(ng[0].emails) === '["dust@example.com","billing@example.com"]', JSON.stringify(ng[0] && ng[0].emails));
    ok('…and ticked on the schedule being made', await page.evaluate(id => document.querySelector(`#ar-groups input[value="${id}"]`).checked, Number(ng[0] && ng[0].id)));
    ok('the dust report offers its period, defaulting to last week', await page.$eval('#ar-period', s => s.value) === 'prev_week'
      && await page.$eval('#ar-job-wrap', e => e.style.display === 'none'));
    await page.click('#ar-save');
    await page.waitForFunction(() => !document.getElementById('ar-form').classList.contains('open'), { timeout: 8000 }).catch(() => {});
    ok('and the dust schedule saves', (await db.schedules()).some(r => r.report_type === 'dust_tracking_summary' && r.options.period === 'prev_week'));

    console.log('\nA payroll report');
    await page.evaluate(() => arNew('payroll'));
    await page.waitForFunction(() => document.getElementById('ar-form').classList.contains('open'));
    const rangeShown = await page.$eval('#ar-range-wrap', e => e.style.display !== 'none');
    const ranges = await page.$$eval('#ar-range option', os => os.map(o => o.textContent));
    ok('offers payroll\'s own weeks and pay cycles, last week first',
      rangeShown && ranges[0] === 'Last week (Mon–Sun)' && ranges.includes('Last pay cycle')
        && await page.$eval('#ar-range', s => s.value) === 'last_week', JSON.stringify(ranges));
    ok('…and no job or period picker', await page.$eval('#ar-job-wrap', e => e.style.display === 'none')
      && await page.$eval('#ar-period-wrap', e => e.style.display === 'none'));
    await page.select('#ar-range', 'last_biweekly');
    await page.click(`#ar-groups input[value="${g1}"]`);
    ok('the sentence says what it covers', /covering last pay cycle/.test(await page.$eval('#ar-summary', e => e.textContent)),
      await page.$eval('#ar-summary', e => e.textContent));
    await page.click('#ar-save');
    await page.waitForFunction(() => !document.getElementById('ar-form').classList.contains('open'), { timeout: 8000 }).catch(() => {});
    const payRow = (await db.schedules()).find(r => r.report_type === 'payroll_hours');
    ok('saves with its range', payRow && payRow.options.range === 'last_biweekly', JSON.stringify(payRow && payRow.options));
    await page.waitForFunction(id => document.querySelector(`.ar-row[data-id="${id}"]`), { timeout: 8000 }, payRow && payRow.id).catch(() => {});
    ok('…and its row reads as all employees, last pay cycle',
      payRow && /All employees[\s\S]*Last pay cycle/.test(await page.$eval(`.ar-row[data-id="${payRow.id}"]`, r => r.innerText)));

    console.log('\nA Send now on a report that failed last time');
    const failedId = Number((await db.q("SELECT id FROM report_schedules WHERE company_code = $1 AND report_type = 'turf_daily_pm'", [CO]))[0].id);
    let release2;
    sendGate = new Promise(r => { release2 = r; });
    await page.click(`.ar-row[data-id="${failedId}"] .ar-send-btn`);
    await page.waitForFunction(id => /Sending/i.test(document.querySelector(`.ar-row[data-id="${id}"] .ar-badge`).textContent), { timeout: 8000 }, failedId).catch(() => {});
    const sendingMsg = await page.$eval(`.ar-row[data-id="${failedId}"]`, r => {
      const m = r.querySelector('.ar-msg');
      return m ? { text: m.textContent, bad: m.classList.contains('bad') } : null;
    });
    ok('while it sends, its line says so in plain colours, not the failure red',
      sendingMsg && /Building and sending now/.test(sendingMsg.text) && !sendingMsg.bad, JSON.stringify(sendingMsg));
    release2();
    sendGate = null;
    await page.waitForFunction(id => /Send now/.test(document.querySelector(`.ar-row[data-id="${id}"] .ar-send-btn`).textContent), { timeout: 8000 }, failedId).catch(() => {});

    console.log('\nA report handed to the next pass');
    await db.q(`UPDATE report_schedules SET last_status = 'continuing', last_run_at = NOW(),
        last_message = 'Sent 11 reports to 2 recipients so far. 4 more jobs go out at the next pass, in a few minutes.',
        next_run_at = NOW() - interval '1 minute' WHERE id = $1`, [failedId]);
    await page.evaluate(() => loadAutoReports({ quiet: true }));
    await page.waitForFunction(id => /next pass/.test(document.querySelector(`.ar-row[data-id="${id}"]`).innerText), { timeout: 8000 }, failedId).catch(() => {});
    const cont = await page.$eval(`.ar-row[data-id="${failedId}"]`, r => ({ cls: r.className, text: r.innerText }));
    ok('reads as due, with what is left — not flagged as a failure',
      /DUE NOW/i.test(cont.text) && /4 more jobs go out at the next pass/.test(cont.text) && !/flag-bad/.test(cont.cls), JSON.stringify(cont));
    // Retimed before the next pass came (the server's own rewrite raced): the rest never went.
    await db.q("UPDATE report_schedules SET next_run_at = NOW() + interval '1 day' WHERE id = $1", [failedId]);
    await page.evaluate(() => loadAutoReports({ quiet: true }));
    await page.waitForFunction(id => /did not go out/.test(document.querySelector(`.ar-row[data-id="${id}"]`).innerText), { timeout: 8000 }, failedId).catch(() => {});
    const stale = await page.$eval(`.ar-row[data-id="${failedId}"]`, r => ({ cls: r.className, text: r.innerText }));
    ok('…and once it is no longer due, it no longer promises the rest',
      /NOT FINISHED/i.test(stale.text) && /did not go out/.test(stale.text) && !/next pass, in a few minutes/.test(stale.text) && /flag-bad/.test(stale.cls),
      JSON.stringify(stale));

    console.log('\nA switch flipped while the list is reloading');
    const dustId = Number((await db.q("SELECT id FROM report_schedules WHERE company_code = $1 AND report_type = 'dust_tracking_summary'", [CO]))[0].id);
    slowListMs = 1500;
    dialogs.length = 0;
    await page.click(`.ar-row[data-id="${dustId}"] .user-del-btn`);
    await sleep(300);   // the delete is in, its list reload on the way
    await page.click(`.ar-row[data-id="${payRow.id}"] .sup-toggle`);
    await sleep(4500);
    slowListMs = 0;
    const after = await page.evaluate((d, pid) => ({
      deletedShown: Boolean(document.querySelector(`.ar-row[data-id="${d}"]`)),
      toggledOff: !document.querySelector(`.ar-row[data-id="${pid}"] .sup-toggle input, .ar-row[data-id="${pid}"] input.sup-toggle`)
        ? null : !(document.querySelector(`.ar-row[data-id="${pid}"] .sup-toggle input, .ar-row[data-id="${pid}"] input.sup-toggle`).checked),
    }), dustId, Number(payRow.id));
    ok('a schedule deleted just before is gone from the list, not left there by the switch',
      !after.deletedShown && !(await db.schedules()).some(r => Number(r.id) === dustId), JSON.stringify(after));
    ok('…and the switch is off, on screen and saved', (await db.schedules()).find(r => Number(r.id) === Number(payRow.id)).enabled === false,
      JSON.stringify(after));

    console.log('\nDelete');
    dialogs.length = 0;
    await page.click(`.ar-row[data-id="${made.id}"] .user-del-btn`);
    await page.waitForFunction(id => !document.querySelector(`.ar-row[data-id="${id}"]`), { timeout: 8000 }, made.id).catch(() => {});
    ok('asks, then deletes', dialogs.length === 1 && !(await db.schedules()).some(r => r.id === made.id));

    console.log('\nOn a phone');
    await page.setViewport({ width: 390, height: 844 });
    await sleep(300);
    const fit = await page.evaluate(() => {
      const b = document.getElementById('muBody');
      return { sw: b.scrollWidth, cw: b.clientWidth };
    });
    ok('the tab fits the screen with no sideways scroll', fit.sw <= fit.cw + 1, JSON.stringify(fit));
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.mu-subtab-btn')].map(b => {
      const r = b.getBoundingClientRect();
      return { text: b.innerText.trim(), h: Math.round(r.height), right: Math.round(r.right) };
    }));
    ok('the four tabs stay on one line each, all on screen',
      tabs.every(t => t.h <= tabs[0].h && t.right <= 390), JSON.stringify(tabs));
    if (shots) await page.screenshot({ path: path.join(shots, 'ar-phone.png'), fullPage: false });

    ok('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    server.close();
    await cleanUp();
    await client.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
