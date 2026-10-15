#!/usr/bin/env node
'use strict';
/**
 * Vacation banks, clicked through in a real browser, against the real API and
 * a real Postgres: the admin sets the hours in Manage System → Vacation, the
 * man sees what is left on his Timesheet and is told before he goes over, and
 * Payroll sees which waiting request goes past the bank.
 *
 * Run: PG_TEST_URL=postgres://user:pass@localhost/fct_test node scripts/test-vacation-browser.js
 *      (skips cleanly without a Chrome; set CHROME_EXECUTABLE_PATH, or have
 *       Playwright's Chromium at /opt/pw-browsers). SHOT_DIR=<dir> keeps
 *       screenshots of each screen.
 *
 * The page requests go to the real handlers — auth included: the token is
 * signed and the account read back — so what is checked on screen is checked
 * again in the database.
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

process.env.JWT_SECRET   = 'vacation-browser-secret';
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

const jwt = require('jsonwebtoken');
const { launchBrowser } = require(path.join(ROOT, 'api/lib/pdf.js'));
const ROUTES = {
  '/api/auth/verify':           require(path.join(ROOT, 'api/auth/verify.js')),
  '/api/vacation':              require(path.join(ROOT, 'api/vacation.js')),
  '/api/company/users':         require(path.join(ROOT, 'api/company/users.js')),
  '/api/employees':             require(path.join(ROOT, 'api/employees.js')),
  '/api/timesheet-entries':     require(path.join(ROOT, 'api/timesheet-entries.js')),
  '/api/timesheet-supervisors': require(path.join(ROOT, 'api/timesheet-supervisors.js')),
};

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + String(d).slice(0, 400) : '')); }
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

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new globalThis.URL(req.url, 'http://x').pathname);
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

const CO = 'VACUI';
const q = (t, v) => client.query(t, v).then(r => r.rows);
async function cleanUp() {
  await client.query('DELETE FROM app_data WHERE key LIKE $1', [CO + ':%']);
  await client.query('DELETE FROM companies WHERE code = $1', [CO]);   // users, entries and banks go with it
}

const Y = new Date().getFullYear();
const pad = n => String(n).padStart(2, '0');
// The first Monday of March this year, and the Thursday after: four weekdays.
const MON = (() => { const d = new Date(Date.UTC(Y, 2, 1)); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d; })();
const dayAfter = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };
const RANGE = [0, 1, 2, 3].map(n => dayAfter(MON, n));

(async () => {
  await cleanUp();
  await client.query("INSERT INTO companies (code, name, allowed_divisions) VALUES ($1, 'Vacation UI test', '{turf}')", [CO]);
  const user = async (username, role, roles) => (await client.query(
    'INSERT INTO users (username, company_code, password_hash, role, division_roles) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, CO, 'x', role, JSON.stringify(roles)])).rows[0].id;
  const ADMIN_ROLES = { turf: 'admin', payroll: 'level3', timesheet: 'level1' };
  const FIELD_ROLES = { timesheet: 'level1' };
  const adminId = await user('benadmin', 'admin', ADMIN_ROLES);
  const zachId  = await user('brewerzach', 'level1', FIELD_ROLES);
  const zach2Id = await user('zbrewer', 'level1', FIELD_ROLES);
  // Allen also has turf, so his Timesheet header carries Switch as well.
  const ALLEN_ROLES = { timesheet: 'level1', turf: 'level1' };
  const allenId = await user('strickallen', 'level1', ALLEN_ROLES);
  await client.query(`INSERT INTO employees (company_code, name, is_supervisor) VALUES
      ($1, 'Zach Brewer', FALSE), ($1, 'Allen Strick', FALSE), ($1, 'benadmin', TRUE)`, [CO]);
  const entry = (uid, username, date, status, hours) => q(
    `INSERT INTO timesheet_entries (company_code, user_id, username, entry_type, work_date, status, time_off_type, time_off_hours, supervisor_name)
     VALUES ($1, $2, $3, 'time_off', $4, $5, 'vacation', $6, 'benadmin') RETURNING id`, [CO, uid, username, date, status, hours]);
  await entry(zachId, 'brewerzach', `${Y}-01-05`, 'approved', null);   // says nothing: a full 8
  const [feb] = await entry(zachId, 'brewerzach', `${Y}-02-02`, 'submitted', 8);
  await client.query('INSERT INTO vacation_allowances (company_code, user_id, year, hours) VALUES ($1, $2, $3, 80)', [CO, allenId, Y - 1]);

  const sign = (id, username, role, roles) => ({
    token: jwt.sign({ userId: id, username, companyCode: CO, companyName: 'Vacation UI test', role, divisionRoles: roles,
      allowedDivisions: Object.keys(roles), isPlatformAdmin: false }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    user: JSON.stringify({ username, companyCode: CO, companyName: 'Vacation UI test', role, divisionRoles: roles,
      allowedDivisions: Object.keys(roles), isPlatformAdmin: false }),
  });
  const ADMIN = sign(adminId, 'benadmin', 'admin', ADMIN_ROLES);
  const FIELD = sign(zachId, 'brewerzach', 'level1', FIELD_ROLES);
  const ALLEN = sign(allenId, 'strickallen', 'level1', ALLEN_ROLES);

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser();
  const shots = process.env.SHOT_DIR || '';
  const errors = [];
  const dialogs = [];
  let answer = 'accept';      // what the next confirm() gets
  async function open(who, page0, viewport) {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    await page.setViewport(viewport || { width: 1440, height: 1000 });
    page.on('pageerror', e => errors.push(`${page0}: ${e.message}`));
    page.on('dialog', d => { dialogs.push(d.message()); (answer === 'accept' ? d.accept() : d.dismiss()).catch(() => {}); });
    // Seeded once: a page that refreshes fct_user and reloads must not be re-seeded.
    await page.evaluateOnNewDocument((t, u) => {
      if (localStorage.getItem('fct_token')) return;
      localStorage.setItem('fct_token', t);
      localStorage.setItem('fct_user', u);
    }, who.token, who.user);
    await page.goto(base + '/' + page0, { waitUntil: 'domcontentloaded' });
    await sleep(1200);
    return page;
  }
  const rowOf = (page, uid) => page.$eval(`#vacListBody tr[data-uid="${uid}"]`, tr => ({
    name: tr.querySelector('.dir-name').innerText.trim(),
    sub:  (tr.querySelector('.sch-sub') || {}).innerText || '',
    box:  tr.querySelector('input.vac-input').value,
    left: tr.cells[2].innerText.replace(/\s+/g, ' ').trim(),
  })).catch(() => null);
  const bank = async (uid, year) => {
    const r = await q('SELECT hours::float8 AS h FROM vacation_allowances WHERE company_code = $1 AND user_id = $2 AND year = $3', [CO, uid, year]);
    return r.length ? r[0].h : null;
  };

  try {
    // ── Manage System → Vacation ───────────────────────────────────────────
    console.log('Manage System → Vacation');
    const admin = await open(ADMIN, 'divisions.html');
    await admin.click('#addUserBtn');
    await admin.click('#muTabBtnVacation');
    await admin.waitForSelector(`#vacListBody tr[data-uid="${zachId}"]`, { timeout: 8000 }).catch(() => {});
    let z = await rowOf(admin, zachId);
    ok('a login shows as the person it is', z && z.name === 'Zach Brewer', JSON.stringify(z));
    ok('  with its login, what it has filed, and its other login',
      z && /login: brewerzach/.test(z.sub) && /8 h approved, 8 h waiting for approval/.test(z.sub) && /also files as zbrewer/.test(z.sub), z && z.sub);
    ok('  not tracked until somebody says', z && z.box === '' && z.left === 'Not tracked', JSON.stringify(z));
    ok('the column says which year', (await admin.$eval('#mu-panel-vacation thead', t => t.innerText)).includes(`HOURS FOR ${Y}`.toUpperCase()) ||
      (await admin.$eval('#mu-panel-vacation thead', t => t.textContent)).includes(`Hours for ${Y}`));

    await admin.click(`#vacListBody tr[data-uid="${zachId}"] input.vac-input`);
    await admin.keyboard.type('40');
    await admin.keyboard.press('Enter');
    await admin.waitForFunction(() => /h left\.$/.test(document.getElementById('vac-result').textContent), { timeout: 8000 }).catch(() => {});
    ok('Enter saves it', await bank(zachId, Y) === 40, await bank(zachId, Y));
    ok('  and says what is left', (await admin.$eval('#vac-result', e => e.textContent)) === `Zach Brewer: 40 h for ${Y}, 24 h left.`,
      await admin.$eval('#vac-result', e => e.textContent));
    z = await rowOf(admin, zachId);
    ok('  the row shows 24 h left, 3 days', z && z.left === '24 h 3 days' && z.box === '40', JSON.stringify(z));

    await admin.click(`#vacListBody tr[data-uid="${allenId}"] input.vac-input`);
    await admin.keyboard.type('99');
    await admin.keyboard.press('Escape');
    await sleep(300);
    ok('Escape puts a box back', (await rowOf(admin, allenId)).box === '', JSON.stringify(await rowOf(admin, allenId)));
    ok('  without closing the window', await admin.$eval('#userModalBackdrop', b => b.classList.contains('open')));
    ok('  or saving anything', await bank(allenId, Y) === null);

    const copyText = await admin.$eval('#vac-copy-btn', b => b.style.display !== 'none' ? b.textContent : '');
    ok('last year’s hours can be copied to the one person without any', copyText === `Copy ${Y - 1} hours to 1 person`, copyText);
    answer = 'accept';
    await admin.click('#vac-copy-btn');
    await admin.waitForFunction(() => /^Copied/.test(document.getElementById('vac-result').textContent), { timeout: 8000 }).catch(() => {});
    ok('  asked first, saying it copies the number as it stands', /copied as it stands, including any hours carried over/.test(dialogs[dialogs.length - 1] || ''), dialogs[dialogs.length - 1]);
    ok('  and copies it', await bank(allenId, Y) === 80);
    ok('  the button goes once nobody is left to copy to', await admin.$eval('#vac-copy-btn', b => b.style.display === 'none'));

    answer = 'dismiss';
    await admin.focus(`#vacListBody tr[data-uid="${zachId}"] input.vac-input`);
    await admin.keyboard.down('Control'); await admin.keyboard.press('KeyA'); await admin.keyboard.up('Control');
    await admin.keyboard.press('Backspace');
    ok('  (the box is empty before Enter)', await admin.$eval(`#vacListBody tr[data-uid="${zachId}"] input.vac-input`, i => i.value) === '');
    await admin.keyboard.press('Enter');
    await sleep(400);
    ok('emptying a box asks before it stops tracking', /Stop tracking vacation for Zach Brewer in \d{4}\?/.test(dialogs[dialogs.length - 1] || ''), dialogs[dialogs.length - 1]);
    ok('  and saying no keeps the hours', (await rowOf(admin, zachId)).box === '40' && await bank(zachId, Y) === 40);
    answer = 'accept';

    await admin.click('.vac-step[aria-label="Previous year"]');
    await admin.waitForFunction(y => document.getElementById('vac-year-label').textContent === String(y), { timeout: 4000 }, Y - 1).catch(() => {});
    await sleep(500);
    const allenPrev = await rowOf(admin, allenId);
    ok('‹ steps back a year', allenPrev && allenPrev.box === '80', JSON.stringify(allenPrev));
    await admin.click('.vac-step[aria-label="Next year"]');
    await sleep(600);
    if (shots) await admin.screenshot({ path: path.join(shots, 'vacation-tab.png') });

    console.log('\nOn a phone');
    await admin.setViewport({ width: 390, height: 844 });
    await sleep(400);
    const tabs = await admin.evaluate(() => [...document.querySelectorAll('.mu-subtab-btn')].map(b => {
      const r = b.getBoundingClientRect();
      return { text: b.innerText.trim(), h: Math.round(r.height), right: Math.round(r.right) };
    }));
    ok('all five tabs on one line and on screen', tabs.length === 5 && tabs.every(t => t.h <= tabs[0].h && t.right <= 390), JSON.stringify(tabs));
    const fit = await admin.evaluate(() => { const b = document.getElementById('muBody'); return { sw: b.scrollWidth, cw: b.clientWidth }; });
    ok('the tab fits the screen with no sideways scroll', fit.sw <= fit.cw + 1, JSON.stringify(fit));
    if (shots) await admin.screenshot({ path: path.join(shots, 'vacation-tab-phone.png') });
    await admin.setViewport({ width: 1440, height: 1000 });

    // ── The Timesheet ──────────────────────────────────────────────────────
    console.log('\nThe Timesheet');
    const field = await open(FIELD, 'timesheet.html', { width: 390, height: 844 });
    await field.waitForFunction(() => !document.getElementById('vacChip').hidden, { timeout: 8000 }).catch(() => {});
    ok('what is left sits under his name', await field.$eval('#vacChip', e => e.hidden ? '' : e.textContent) === 'Vacation: 24 h left',
      await field.$eval('#vacChip', e => e.outerHTML));
    await field.click('#tab-time-off');
    await field.click('#off-pills .pill[data-val="sick"]');
    ok('nothing about vacation on a sick day', await field.$eval('#off-vac-hint', e => e.hidden));
    await field.click('#off-pills .pill[data-val="vacation"]');
    const hint0 = await field.$eval('#off-vac-hint', e => e.hidden ? '' : e.textContent);
    ok('on Vacation the form says what a full day leaves', hint0 === `Vacation for ${Y}: 24 h left (3 days). This takes 8 h, leaving 16 h (2 days).`, hint0);
    await field.click('#seg-off-len button[data-val="range"]');
    await field.evaluate((a, b) => {
      document.getElementById('f-off-date').value = a;
      document.getElementById('f-off-date-end').value = b;
      onOffDatesChange();
    }, RANGE[0], RANGE[3]);
    const hint1 = await field.$eval('#off-vac-hint', e => ({ text: e.textContent, over: e.classList.contains('over') }));
    ok('four days that go past it are said, in amber',
      hint1.over && hint1.text === `Vacation for ${Y}: 24 h left (3 days). This takes 32 h, which puts you 8 h over. You can still send it — the office will see it.`,
      JSON.stringify(hint1));
    await field.select('#f-off-supervisor', await field.$eval('#f-off-supervisor', s => [...s.options].find(o => o.textContent === 'benadmin').value));
    answer = 'accept';
    const before = dialogs.length;
    await field.click('#btn-submit');
    await field.waitForFunction(() => /Submitted 4 entries/.test(document.getElementById('formMsg').textContent), { timeout: 15000 }).catch(() => {});
    ok('the submit confirm says it goes over, and lets it', dialogs.length > before
      && /This puts you 8 h over your vacation for \d{4} \(24 h left, this takes 32 h\)\. You can still send it/.test(dialogs[dialogs.length - 1]),
      dialogs[dialogs.length - 1]);
    ok('  and the four days go in', /Submitted 4 entries/.test(await field.$eval('#formMsg', e => e.textContent)), await field.$eval('#formMsg', e => e.textContent));
    await field.waitForFunction(() => /over/.test(document.getElementById('vacChip').textContent), { timeout: 8000 }).catch(() => {});
    ok('the header now says 8 h over, in amber', await field.$eval('#vacChip', e => e.textContent + '|' + e.classList.contains('over')) === 'Vacation: 8 h over|true',
      await field.$eval('#vacChip', e => e.textContent));
    const hdr = await field.evaluate(() => { const h = document.querySelector('header'); return { sw: h.scrollWidth, cw: h.clientWidth, h: h.getBoundingClientRect().height }; });
    ok('  and the header still fits a phone', hdr.sw <= hdr.cw + 1 && hdr.h < 80, JSON.stringify(hdr));
    // The longest line it is likely to say, on the narrowest phones that show it.
    const longest = [];
    for (const width of [341, 360, 375, 390]) {
      await field.setViewport({ width, height: 844 });
      longest.push(await field.evaluate(w => {
        document.getElementById('vacChip').textContent = 'Vacation: 123.25 h over';
        const b = [...document.querySelectorAll('header .icon-btn')].find(x => x.offsetParent);
        const page = document.documentElement;
        return { w, signOutH: Math.round(b.getBoundingClientRect().height), sideways: page.scrollWidth > page.clientWidth };
      }, width));
    }
    ok('  even "Vacation: 123.25 h over" leaves Sign Out on one line, with no sideways scroll',
      longest.every(m => m.signOutH <= 34 && !m.sideways), JSON.stringify(longest));
    await field.setViewport({ width: 390, height: 844 });
    await field.evaluate(() => renderVacationChip());
    if (shots) await field.screenshot({ path: path.join(shots, 'vacation-timesheet.png') });
    const filed = await q(`SELECT id, work_date::text AS d, status FROM timesheet_entries WHERE company_code = $1 AND user_id = $2
                           AND work_date >= $3::date AND work_date <= $4::date ORDER BY work_date`, [CO, zachId, RANGE[0], RANGE[3]]);
    ok('  four submitted rows, one a day', filed.length === 4 && filed.every(r => r.status === 'submitted'), JSON.stringify(filed));

    console.log('\nThe Timesheet, with Switch in the header too');
    for (const width of [390, 430]) {
      const allen = await open(ALLEN, 'timesheet.html', { width, height: 844 });
      await allen.waitForFunction(() => document.getElementById('vacChip').textContent !== '', { timeout: 8000 }).catch(() => {});
      const m = await allen.evaluate(() => {
        const btns = [...document.querySelectorAll('header .icon-btn')].filter(b => b.offsetParent);
        const chip = document.getElementById('vacChip');
        return { switchShown: btns.length === 2, btnH: Math.max(...btns.map(b => Math.round(b.getBoundingClientRect().height))),
                 headerH: Math.round(document.querySelector('header').getBoundingClientRect().height),
                 chip: chip.hidden || getComputedStyle(chip).display === 'none' ? '' : chip.textContent };
      });
      ok(`at ${width}px Switch and Sign Out stay one line each`, m.switchShown && m.btnH <= 34, JSON.stringify(m));
      if (width === 390) ok('  and on a 390px phone the vacation line gives way to them', m.chip === '', JSON.stringify(m));
      else ok('  and at 430px there is room for it', m.chip === 'Vacation: 80 h left', JSON.stringify(m));
      if (shots) await allen.screenshot({ path: path.join(shots, `vacation-timesheet-switch-${width}.png`), clip: { x: 0, y: 0, width, height: 120 } });
    }

    // ── Payroll ────────────────────────────────────────────────────────────
    console.log('\nPayroll');
    const pay = await open(ADMIN, 'payroll.html');
    await pay.evaluate(y => {
      document.getElementById('flt-from').value = `${y}-01-01`;
      document.getElementById('flt-to').value   = `${y}-12-31`;
      applyFilters();
    }, Y);
    const noteOf = id => pay.evaluate(i => {
      const box = document.querySelector(`#rowsBody input[data-id="${i}"]`);
      const n = box && box.closest('tr').querySelector('.vac-note');
      return n ? (n.classList.contains('over') ? 'OVER ' : '') + n.textContent : '';
    }, String(id));
    await pay.waitForFunction(() => document.querySelectorAll('#rowsBody .vac-note').length >= 5, { timeout: 10000 }).catch(() => {});
    // 40 − 8 approved = 32; then Feb 2 → 24, and the four March days 16, 8, 0, −8.
    const notes = [];
    notes.push(await noteOf(feb.id));
    for (const r of filed) notes.push(await noteOf(r.id));
    ok('each waiting day says what it leaves, and the one past the bank is red', JSON.stringify(notes) === JSON.stringify([
      `Leaves 24 h of ${Y} vacation`, `Leaves 16 h of ${Y} vacation`, `Leaves 8 h of ${Y} vacation`,
      `Leaves 0 h of ${Y} vacation`, `OVER 8 h over ${Y} vacation`]), JSON.stringify(notes));
    if (shots) await pay.screenshot({ path: path.join(shots, 'vacation-payroll.png') });

    answer = 'accept';
    let n0 = dialogs.length;
    await pay.evaluate(id => approveOne(id), String(filed[3].id));
    await sleep(300);
    ok('approving the day that goes over says so first', dialogs.length > n0
      && /This vacation day goes past the hours set in Manage System:\n• brewerzach, .+: 8 h over \d{4} vacation/.test(dialogs[dialogs.length - 1]),
      dialogs[dialogs.length - 1]);
    await pay.waitForFunction(id => {
      const box = document.querySelector(`#rowsBody input[data-id="${id}"]`);
      const n = box && box.closest('tr').querySelector('.vac-note');
      return n && n.classList.contains('over');
    }, { timeout: 8000 }, String(filed[2].id)).catch(() => {});
    ok('  once it is approved it comes off first, and the day before it is now the one over',
      await noteOf(filed[2].id) === `OVER 8 h over ${Y} vacation`, await noteOf(filed[2].id));

    n0 = dialogs.length;
    await pay.evaluate(id => deleteEntry(id), String(filed[2].id));
    await pay.waitForFunction(() => !document.querySelector('#rowsBody .vac-note.over'), { timeout: 8000 }).catch(() => {});
    ok('deleting a request (denying it) gives its hours back: nothing is over', await pay.evaluate(() => !document.querySelector('#rowsBody .vac-note.over')));
    ok('  and the rest read again', await noteOf(filed[1].id) === `Leaves 0 h of ${Y} vacation`, await noteOf(filed[1].id));

    n0 = dialogs.length;
    await pay.evaluate(id => approveOne(id), String(feb.id));
    await sleep(300);
    ok('approving a day that fits asks only the usual question', dialogs[dialogs.length - 1] === 'Approve this entry?', dialogs[dialogs.length - 1]);
    await sleep(800);

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
