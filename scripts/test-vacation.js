#!/usr/bin/env node
'use strict';
/**
 * Vacation banks: a login's hours for a calendar year, and what is left.
 *
 * Run: node scripts/test-vacation.js
 *
 * THE ARITHMETIC (api/vacation.js). Vacation rows dated in the year that are
 * submitted or approved, at the hours payroll pays — leaveHoursOf: a row that
 * does not say is 8, a half day 4, an unpaid day 0. Drafts and other kinds of
 * time off count nothing. Left may go negative: a request past the bank is
 * allowed and flagged, not refused. For Payroll, what each WAITING request
 * leaves — approved days first, then the waiting ones in date order — so the
 * one that goes over is the one flagged.
 *
 * WHO. Anyone signed in reads their own; company admins read the tab and set
 * the hours; payroll approvers read the banks the review grid needs. Hours
 * are 0–1000 and stopping is said out loud, never read into a missing field.
 *
 * THE PAGES. Manage System → Vacation saves a box on Enter or leaving it, puts
 * it back on Escape without closing the window, asks before an emptied box
 * stops tracking, and copies last year's hours on request. The Timesheet says
 * what is left under the name and, on Vacation, what the request leaves —
 * per year, when a range crosses New Year. Payroll draws the flag per request
 * and puts the overage in the approve confirm.
 *
 * No DB, server or browser required: the neon driver and the auth module are
 * stubbed and the pages run in jsdom. scripts/test-vacation-sql.js runs the
 * statements against a real Postgres, and scripts/test-vacation-browser.js
 * clicks it all through in Chrome.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { JSDOM } = require('jsdom');

let CURRENT_SQL = null;
const ADMIN   = { companyCode: 'FCT', userId: 1, username: 'hudockben', role: 'admin', isPlatformAdmin: false };
const PLATFORM = { companyCode: 'FCT', userId: 2, username: 'platform', role: 'level1', isPlatformAdmin: true };
const PAYROLL = { companyCode: 'FCT', userId: 3, username: 'payclerk', role: 'level1', isPlatformAdmin: false, canApprove: true };
const CODER   = { companyCode: 'FCT', userId: 4, username: 'foreman', role: 'level1', isPlatformAdmin: false, canApprove: false };
const FIELD   = { companyCode: 'FCT', userId: 9, username: 'brewerzach', role: 'level1', isPlatformAdmin: false };
let NEXT_AUTH = ADMIN;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth' || request === '../lib/auth') {
    return {
      requireAuth: (req, res) => {
        if (!NEXT_AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        return NEXT_AUTH;
      },
      payrollAccess: p => ({ canCode: !!p.canApprove, canApprove: !!p.canApprove || !!p.isPlatformAdmin, isCoder: false }),
    };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const handler = require(path.join(ROOT, 'api', 'vacation.js'));
const T = handler._test;
const { leaveHoursOf } = require(path.join(ROOT, 'api', 'lib', 'payroll-metrics.js'));
const { requireFn, sliceSource } = require(path.join(__dirname, 'lib', 'fn-source.js'));
const DIVS = fs.readFileSync(path.join(ROOT, 'divisions.html'), 'utf8');
const TS   = fs.readFileSync(path.join(ROOT, 'timesheet.html'), 'utf8');
const PAY  = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');
const scriptOf = html => html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const DIVS_SCRIPT = scriptOf(DIVS), TS_SCRIPT = scriptOf(TS), PAY_SCRIPT = scriptOf(PAY);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const eq = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

/** A tagged-template sql stub that records every statement and answers via `reply`. */
function recordingSql(reply = () => []) {
  const calls = [];
  const sql = (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, values });
    try { return Promise.resolve(reply(text, values)); } catch (err) { return Promise.reject(err); }
  };
  sql.calls = calls;
  return sql;
}

async function call(method, query, body, auth, sql) {
  NEXT_AUTH = auth;
  CURRENT_SQL = sql || recordingSql();
  let status = 200, out = null;
  const res = { status(s) { status = s; return this; }, json(b) { out = b; return this; }, setHeader() {}, end() { return this; } };
  await handler({ method, query: query || {}, body: body === undefined ? {} : body, headers: {} }, res);
  return { status, body: out, sql: CURRENT_SQL };
}

const vac = (id, date, status, hours, extra) => ({ id, user_id: 9, entry_type: 'time_off', status, work_date: date, time_off_hours: hours, ...(extra || {}) });

(async () => {
  console.log('Vacation banks\n');

  // ── The arithmetic ────────────────────────────────────────────────────────
  console.log('[the arithmetic]');
  {
    const rows = [
      vac(1, '2026-01-05', 'approved', null),     // says nothing: a full day
      vac(2, '2026-01-06', 'approved', 4),        // a half day
      vac(3, '2026-01-07', 'approved', 0),        // unpaid: takes nothing
      vac(4, '2026-02-02', 'submitted', '8.00'),  // NUMERIC as the driver sends it
      vac(5, '2026-02-03', 'draft', 8),           // never sent
      vac(6, '2026-02-04', 'approved', 30),       // more than a day can pay
      vac(7, '2026-02-05', 'approved', -3),       // unreadable
    ];
    for (const r of rows) {
      if (r.status === 'draft') continue;
      eq(`  a ${r.time_off_hours == null ? 'blank' : r.time_off_hours} h row counts what payroll pays (${leaveHoursOf(r)})`,
        T.balanceOf(100, [r]).approved + T.balanceOf(100, [r]).pending, leaveHoursOf(r));
    }
    eq('the year’s bank: approved, waiting, left', T.balanceOf('100.00', rows),
      { hours: 100, approved: 8 + 4 + 0 + 24 + 8, pending: 8, left: 100 - 44 - 8 });
    eq('a draft counts nothing', T.balanceOf(10, [vac(5, '2026-02-03', 'draft', 8)]), { hours: 10, approved: 0, pending: 0, left: 10 });
    eq('not tracked: no left, but what was filed is still said', T.balanceOf(null, rows.slice(0, 2)), { hours: null, approved: 12, pending: 0, left: null });
    eq('left goes negative rather than stopping at zero', T.balanceOf(8, [vac(1, '2026-03-02', 'submitted', 8), vac(2, '2026-03-03', 'submitted', 8)]).left, -8);
    const dust = [0.1, 0.2, 0.3].map((h, i) => vac(i + 1, '2026-03-0' + (i + 1), 'approved', h));
    eq('float dust does not make an exactly spent bank read over', T.balanceOf(0.6, dust).left, 0);
    assert('  and it is +0, not −0', Object.is(T.balanceOf(0.6, dust).left, 0));

    // Approved first, then waiting in date order; ids compared as numbers.
    const after = T.leftAfterEach(28, [
      vac('10', '2026-08-10', 'submitted', 8),
      vac('9',  '2026-08-10', 'submitted', 8),     // same day, filed first
      vac('3',  '2026-12-31', 'approved', 8),
      vac('2',  '2026-06-15', 'submitted', 8),
      vac('1',  '2026-03-02', 'approved', null),
    ]);
    eq('each waiting request: what is left once it is taken', after, { 2: 4, 9: -4, 10: -12 });
    eq('  nothing when the bank is not set', T.leftAfterEach(null, [vac(1, '2026-01-01', 'submitted', 8)]), {});
  }

  console.log('\n[reading what the page sends]');
  {
    eq('years', ['2026', ' 2026 ', '26', '1999', '2101', 'abcd', '', null, 2027].map(T.parseYear), [2026, 2026, null, null, null, null, null, null, 2027]);
    eq('hours', [{ hours: 80 }, { hours: '7.5' }, { hours: 0 }, { hours: null }, { hours: '' }, { hours: '  ' }].map(T.parseHours),
      [{ hours: 80 }, { hours: 7.5 }, { hours: 0 }, { hours: null }, { hours: null }, { hours: null }]);
    for (const bad of [{}, null, { hours: -1 }, { hours: 1000.5 }, { hours: 'ten' }, { hours: true }, { hours: [8] }, { hours: Infinity }]) {
      assert(`  ${JSON.stringify(bad)} is refused`, !!T.parseHours(bad).error, JSON.stringify(T.parseHours(bad)));
    }
    eq('a Timesheet grant is an explicit one', [{ timesheet: 'level1' }, '{"timesheet":"level2"}', { timesheet: 'no_access' }, { turf: 'admin' }, null, 'not json'].map(T.hasTimesheetGrant),
      [true, true, false, false, false, false]);
    eq('company admin: role admin or platform admin', [ADMIN, PLATFORM, PAYROLL, FIELD, null].map(T.isCompanyAdmin), [true, true, false, false, false]);
  }

  // ── The endpoint ──────────────────────────────────────────────────────────
  console.log('\n[who may do what]');
  {
    const matrix = [
      ['GET',  { mine: '1', years: '2026' }, FIELD,    200],
      ['GET',  { year: '2026' },             FIELD,    403],
      ['GET',  { year: '2026' },             PAYROLL,  403],
      ['GET',  { year: '2026' },             ADMIN,    200],
      ['GET',  { year: '2026' },             PLATFORM, 200],
      ['GET',  { year: '2026', view: 'payroll' }, FIELD,   403],
      ['GET',  { year: '2026', view: 'payroll' }, CODER,   403],
      ['GET',  { year: '2026', view: 'payroll' }, PAYROLL, 200],
      ['GET',  { year: '2026', view: 'payroll' }, ADMIN,   200],
      ['PUT',  { user_id: '9', year: '2026' },     PAYROLL, 403],
      ['PUT',  { user_id: '9', year: '2026' },     FIELD,   403],
      ['POST', { action: 'copy', from: '2025', to: '2026' }, PAYROLL, 403],
      ['POST', { action: 'copy', from: '2025', to: '2026' }, ADMIN,   200],
      ['POST', {},                            ADMIN,    405],
      ['DELETE', { user_id: '9', year: '2026' }, ADMIN, 405],
    ];
    for (const [m, qy, who, want] of matrix) {
      const r = await call(m, qy, m === 'PUT' ? { hours: 8 } : undefined, who);
      eq(`  ${m} ${JSON.stringify(qy)} as ${who.username}`, r.status, want);
    }
    const none = await call('GET', { mine: '1', years: '2026' }, undefined, null);
    eq('  nobody signed in: 401', none.status, 401);
    const refused = await call('PUT', { user_id: '9', year: '2026' }, { hours: 8 }, FIELD);
    eq('  a refusal reaches no SQL', refused.sql.calls.length, 0);
  }

  console.log('\n[what it refuses before the database]');
  {
    for (const [qy, body, why] of [
      [{ user_id: '9', year: '26' },   { hours: 8 },    'a year that is not a year'],
      [{ user_id: 'x', year: '2026' }, { hours: 8 },    'a user that is not a number'],
      [{ year: '2026' },               { hours: 8 },    'no user'],
      [{ user_id: '9', year: '2026' }, {},              'no hours at all'],
      [{ user_id: '9', year: '2026' }, { hours: 2000 }, 'too many hours'],
    ]) {
      const r = await call('PUT', qy, body, ADMIN);
      assert(`  PUT: ${why} → 400, no SQL`, r.status === 400 && r.sql.calls.length === 0, `${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const [qy, why] of [
      [{ mine: '1', years: '2026,2027,2028,2029,2030' }, 'more than four years'],
      [{ mine: '1', years: '2026,x' }, 'a bad year among them'],
      [{ mine: '1' }, 'no year'],
      [{ year: 'next' }, 'the tab with no year'],
      [{ action: 'copy' }, ''],
    ]) {
      if (!why) continue;
      const r = await call('GET', qy, undefined, ADMIN);
      assert(`  GET: ${why} → 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
    }
    const same = await call('POST', { action: 'copy', from: '2026', to: '2026' }, undefined, ADMIN);
    eq('  copy onto the same year → 400', same.status, 400);
    const missing = await call('PUT', { user_id: '77', year: '2026' }, { hours: 8 }, ADMIN, recordingSql(() => []));
    eq('  a login not in the company → 404, nothing written', [missing.status, missing.sql.calls.some(c => /INSERT|DELETE/.test(c.text))], [404, false]);
    const broken = await call('GET', { mine: '1', years: '2026' }, undefined, FIELD, recordingSql(() => { throw new Error('connection reset'); }));
    eq('  a database failure is a 500 that says only that', [broken.status, broken.body.error], [500, 'Database error']);
  }

  console.log('\n[the statements]');
  {
    let r = await call('PUT', { user_id: '9', year: '2026' }, { hours: '40' }, ADMIN, recordingSql((text) => {
      if (/FROM users WHERE id = \?/.test(text)) return [{ id: 9, username: 'brewerzach' }];
      if (/INSERT INTO vacation_allowances/.test(text)) return [{ hours: '40.00', set_by_name: 'hudockben', updated_at: '2026-10-15T12:00:00Z' }];
      if (/FROM timesheet_entries/.test(text)) return [vac(1, '2026-03-02', 'approved', '8.00'), vac(2, '2026-03-03', 'submitted', null)];
      return [];
    }));
    eq('PUT answers with the bank, NUMERIC strings read as numbers',
      { s: r.status, hours: r.body.hours, approved: r.body.approved, pending: r.body.pending, left: r.body.left, by: r.body.set_by },
      { s: 200, hours: 40, approved: 8, pending: 8, left: 24, by: 'hudockben' });
    const lookup = r.sql.calls.find(c => /FROM users WHERE id = \?/.test(c.text));
    eq('  the login is looked up in the caller’s company', lookup.values, [9, 'FCT']);
    const ins = r.sql.calls.find(c => /INSERT INTO vacation_allowances/.test(c.text));
    eq('  and the bank written with who set it', ins.values, ['FCT', 9, 2026, 40, 1, 'hudockben']);
    assert('  as one row per login and year', /ON CONFLICT \(company_code, user_id, year\) DO UPDATE/.test(ins.text));
    const use = r.sql.calls.find(c => /FROM timesheet_entries/.test(c.text));
    assert('  usage: vacation only, submitted and approved, the year by date',
      /time_off_type = 'vacation'/.test(use.text) && /status IN \('submitted', 'approved'\)/.test(use.text)
      && JSON.stringify(use.values) === JSON.stringify(['FCT', 9, '2026-01-01', '2026-12-31']), use.text + ' ' + JSON.stringify(use.values));
    assert('  and entry_type is read — leaveHoursOf counts nothing without it', /SELECT id, user_id, status, entry_type/.test(use.text));

    r = await call('PUT', { user_id: '9', year: '2026' }, { hours: null }, ADMIN, recordingSql((text) => {
      if (/FROM users WHERE id = \?/.test(text)) return [{ id: 9, username: 'brewerzach' }];
      return [];
    }));
    const del = r.sql.calls.find(c => /DELETE FROM vacation_allowances/.test(c.text));
    eq('PUT null deletes that one year’s bank', del && del.values, ['FCT', 9, 2026]);
    eq('  and answers not tracked', { hours: r.body.hours, left: r.body.left }, { hours: null, left: null });

    r = await call('POST', { action: 'copy', from: '2025', to: '2026' }, undefined, ADMIN, recordingSql(() => [{ user_id: 9 }, { user_id: 12 }]));
    const cp = r.sql.calls[0];
    assert('copy fills only what is missing', /ON CONFLICT \(company_code, user_id, year\) DO NOTHING/.test(cp.text) && /WHERE company_code = \? AND year = \?/.test(cp.text), cp.text);
    eq('  from this company’s old year, stamped with who copied it', cp.values, [2026, 1, 'hudockben', 'FCT', 2025]);
    eq('  and says how many', r.body.copied, 2);

    r = await call('GET', { mine: '1', years: '2027,2026' }, undefined, FIELD, recordingSql((text) => {
      if (/FROM vacation_allowances/.test(text)) return [{ year: 2026, hours: '16.00' }];
      if (/FROM timesheet_entries/.test(text)) return [vac(1, '2026-12-31', 'submitted', 8), vac(2, '2027-01-01', 'submitted', 8)];
      return [];
    }));
    eq('mine: each year its own bank; a year not set is just "not tracked"', r.body.balances,
      { 2026: { tracked: true, hours: 16, approved: 0, pending: 8, left: 8 }, 2027: { tracked: false } });
    const mineSql = r.sql.calls.find(c => /FROM vacation_allowances/.test(c.text));
    eq('  read for the caller only', mineSql.values, ['FCT', 9, 2026, 2027]);

    r = await call('GET', { year: '2026', view: 'payroll' }, undefined, PAYROLL, recordingSql((text) => {
      if (/FROM vacation_allowances/.test(text)) return [{ user_id: 9, hours: '16.00' }];
      if (/FROM timesheet_entries/.test(text)) return [vac('5', '2026-03-02', 'submitted', 8), vac('6', '2026-03-03', 'submitted', 8), vac('7', '2026-03-04', 'submitted', 8),
        { ...vac('8', '2026-03-02', 'submitted', 8), user_id: 10 }];
      return [];
    }));
    eq('payroll: only the banks that are set, with what each waiting day leaves', r.body.balances,
      { 9: { hours: 16, approved: 0, pending: 24, left: -8, after: { 5: 8, 6: 0, 7: -8 } } });
    assert('  and no names or logins it does not need', !/people/.test(JSON.stringify(r.body)) && !r.sql.calls.some(c => /FROM users/.test(c.text)));
  }

  // ── Manage System → Vacation ──────────────────────────────────────────────
  console.log('\n[Manage System → Vacation]');
  {
    const Y = new Date().getFullYear();
    const PEOPLE = () => [
      { user_id: 9,  username: 'brewerzach', person: 'Zach Brewer', also: ['zbrewer'], timesheet: true, hours: 40, approved: 8, pending: 8, left: 24, set_by: 'hudockben', prev: { hours: 24, left: 16 } },
      { user_id: 11, username: 'zbrewer',    person: 'Zach Brewer', also: ['brewerzach'], timesheet: true, hours: null, approved: 8, pending: 0, left: null, prev: null },
      { user_id: 12, username: 'strickallen', person: 'Allen Strick', also: [], timesheet: true, hours: null, approved: 0, pending: 0, left: null, prev: { hours: 80, left: 80 } },
      { user_id: 13, username: 'reeferscott', person: null, also: [], timesheet: false, hours: 8, approved: 16, pending: 0, left: -8, prev: null },
    ];
    function buildTab(answer) {
      const dom = new JSDOM(DIVS, { runScripts: 'outside-only' });
      const w = dom.window;
      const calls = [];
      w.fetch = async (url, opts) => {
        calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body ? JSON.parse(opts.body) : null });
        const a = answer(String(url), opts || {});
        return { ok: a.status === 200, status: a.status, json: async () => a.body };
      };
      w.confirmAnswers = [];
      w.confirmed = [];
      w.confirm = msg => { w.confirmed.push(msg); return w.confirmAnswers.length ? w.confirmAnswers.shift() : true; };
      w.eval("var token = 'test-token'; var muActiveSubTab = 'users'; var supervisorsLoaded = true;");
      w.eval(requireFn(DIVS_SCRIPT, 'escHtml'));
      w.eval(DIVS_SCRIPT.match(/const MU_SUBTABS = \{[^}]*\};/)[0].replace('const ', 'var '));
      w.eval('function loadSupervisorList() {} function loadSchedulerList() {} function loadAutoReports() {} function arStartPolling() {} function arStopPolling() {}');
      w.eval(requireFn(DIVS_SCRIPT, 'switchUserSubTab'));
      w.eval(sliceSource(DIVS_SCRIPT, '// ── Vacation sub-panel (inside Manage Users modal)', '// ── Excel export ─', 'the Vacation sub-panel', 'vacCopyLastYear'));
      return { w, doc: w.document, calls };
    }
    const okList = (people) => (url, opts) => {
      if (/\/api\/vacation\?year=/.test(url) && (!opts.method || opts.method === 'GET')) return { status: 200, body: { ok: true, people: people || PEOPLE(), copyable: 1 } };
      return { status: 404, body: { ok: false, error: 'not stubbed' } };
    };
    const rowsOf = doc => [...doc.querySelectorAll('#vacListBody tr[data-uid]')].map(tr => ({
      uid: tr.dataset.uid,
      name: tr.querySelector('.dir-name').textContent.trim(),
      sub: (tr.querySelector('.sch-sub') || {}).textContent || '',
      box: tr.querySelector('input.vac-input').value,
      // Each line of the cell, as a reader sees them: "24 h", then "3 days".
      left: [...tr.cells[2].querySelectorAll('div, span')].map(e => e.textContent.trim()).join(' '),
    }));

    let { w, doc, calls } = buildTab(okList());
    const markup = new JSDOM(DIVS).window.document;
    eq('a fifth tab, after Auto Reports', [...markup.querySelectorAll('.mu-subtabs .mu-subtab-btn')].map(b => b.textContent.trim()),
      ['Users', 'Roles', 'Scheduler', 'Auto Reports', 'Vacation']);
    assert('  inside Manage System, which only admins can open', !!markup.getElementById('mu-panel-vacation').closest('#userModalBackdrop'));
    w.eval("switchUserSubTab('vacation')");
    await settle();
    eq('opening it reads this year', calls.map(c => `${c.method} ${c.url}`), [`GET /api/vacation?year=${Y}`]);
    eq('  and says which year it is about', [doc.getElementById('vac-year-label').textContent, ...[...doc.querySelectorAll('#mu-panel-vacation .vac-year-word')].map(e => e.textContent)],
      [String(Y), String(Y), String(Y)]);
    const rows = rowsOf(doc);
    eq('one row a login, by the person it is', rows.map(r => r.name), ['Zach Brewer', 'Zach Brewer', 'Allen Strick', 'reeferscott']);
    eq('  his row: login, what is filed, last year, his other login',
      rows[0].sub, `login: brewerzach · 8 h approved, 8 h waiting for approval · ${Y - 1}: 24 h, 16 h unused · also files as zbrewer`);
    eq('  the hours, and what is left in hours and days', [rows[0].box, rows[0].left], ['40', '24 h 3 days']);
    eq('  not tracked says so', rows[1].left, 'Not tracked');
    eq('  over says how far, and a login off the Timesheet says that', [rows[3].left, /not on the Timesheet/.test(rows[3].sub)], ['8 h over 1 day', true]);
    eq('the count', doc.getElementById('vac-count').textContent, '2 of 4 tracked · 1 over');
    eq('Copy offers last year’s hours to whoever had them and has none', [doc.getElementById('vac-copy-btn').style.display, doc.getElementById('vac-copy-btn').textContent],
      ['', `Copy ${Y - 1} hours to 1 person`]);
    doc.getElementById('vac-over-only').checked = true;
    w.renderVacationList();
    eq('Over only', rowsOf(doc).map(r => r.uid), ['13']);
    doc.getElementById('vac-over-only').checked = false;
    doc.getElementById('vac-search').value = 'ZBREW';
    w.renderVacationList();
    eq('search finds a person by any of his logins', rowsOf(doc).map(r => r.uid), ['9', '11']);
    eq('  and the count says so', doc.getElementById('vac-count').textContent, '2 of 4 people');
    doc.getElementById('vac-search').value = '';
    w.renderVacationList();

    // Saving a box.
    ({ w, doc, calls } = buildTab((url, opts) => {
      if (opts.method === 'PUT') {
        return { status: 200, body: { ok: true, user_id: 12, year: Y, hours: 80, approved: 0, pending: 0, left: 80, set_by: 'hudockben' } };
      }
      return okList()(url, opts);
    }));
    w.eval("switchUserSubTab('vacation')");
    await settle();
    let box = doc.querySelector('#vacListBody tr[data-uid="12"] input.vac-input');
    const other = doc.querySelector('#vacListBody tr[data-uid="9"] input.vac-input');
    box.value = '80';
    other.focus();
    await w.vacSave(box);
    const put = calls.find(c => c.method === 'PUT');
    eq('a box saves its number to that login and year', [put.url, put.body], [`/api/vacation?user_id=12&year=${Y}`, { hours: 80 }]);
    eq('  the row redrawn with what is left', rowsOf(doc).find(r => r.uid === '12').left, '80 h 10 days');
    eq('  the result line says it', doc.getElementById('vac-result').textContent, `Allen Strick: 80 h for ${Y}, 80 h left.`);
    assert('  the box the admin moved to keeps its focus', doc.activeElement === other);
    eq('  and Copy has nobody left to copy to', doc.getElementById('vac-copy-btn').style.display, 'none');
    const n = calls.length;
    box = doc.querySelector('#vacListBody tr[data-uid="12"] input.vac-input');
    await w.vacSave(box);
    eq('an unchanged box sends nothing', calls.length, n);

    // A refused save puts the box back.
    ({ w, doc, calls } = buildTab((url, opts) => opts.method === 'PUT'
      ? { status: 403, body: { ok: false, error: 'Company admin access required' } } : okList()(url, opts)));
    w.eval("switchUserSubTab('vacation')");
    await settle();
    box = doc.querySelector('#vacListBody tr[data-uid="9"] input.vac-input');
    box.value = '55';
    await w.vacSave(box);
    eq('a refused save puts the box back and says why', [box.value, box.disabled, doc.getElementById('vac-result').textContent], ['40', false, 'Company admin access required']);

    // Bad numbers never leave the page.
    box.value = '1500';
    const before = calls.length;
    await w.vacSave(box);
    eq('more than 1000 is refused on the page', [calls.length - before, box.value, doc.getElementById('vac-result').textContent],
      [0, '40', 'Vacation hours must be a number from 0 to 1000.']);

    // Emptying a box asks.
    ({ w, doc, calls } = buildTab((url, opts) => opts.method === 'PUT'
      ? { status: 200, body: { ok: true, hours: null, approved: 8, pending: 8, left: null } } : okList()(url, opts)));
    w.eval("switchUserSubTab('vacation')");
    await settle();
    box = doc.querySelector('#vacListBody tr[data-uid="9"] input.vac-input');
    box.value = '';
    w.confirmAnswers.push(false);
    await w.vacSave(box);
    eq('emptying a box asks first; no keeps it', [calls.filter(c => c.method === 'PUT').length, box.value], [0, '40']);
    assert('  the question names who and which year', /^Stop tracking vacation for Zach Brewer in \d{4}\?/.test(w.confirmed[0]), w.confirmed[0]);
    box.value = '';
    w.confirmAnswers.push(true);
    await w.vacSave(box);
    eq('  yes sends null', calls.filter(c => c.method === 'PUT').map(c => c.body), [{ hours: null }]);
    eq('  and the row says not tracked', rowsOf(doc).find(r => r.uid === '9').left, 'Not tracked');

    // Escape.
    ({ w, doc, calls } = buildTab(okList()));
    w.eval("switchUserSubTab('vacation')");
    await settle();
    let reached = 0;
    doc.addEventListener('keydown', () => { reached++; });
    box = doc.querySelector('#vacListBody tr[data-uid="9"] input.vac-input');
    // jsdom runs no inline handlers here: wire the box's onkeydown as the page does.
    assert('the box hands its keys to vacKey', /onkeydown="vacKey\(event, this\)"/.test(w.vacRowHtml({ user_id: 9, username: 'brewerzach', person: null, also: [], timesheet: true, hours: 40, approved: 0, pending: 0, left: 40, prev: null })));
    box.addEventListener('keydown', e => w.vacKey(e, box));
    box.value = '99';
    box.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    eq('Escape puts the box back and goes no further than the box', [box.value, reached], ['40', 0]);

    // The year stepper and Copy.
    ({ w, doc, calls } = buildTab((url, opts) => opts.method === 'POST'
      ? { status: 200, body: { ok: true, copied: 1 } } : okList()(url, opts)));
    w.eval("switchUserSubTab('vacation')");
    await settle();
    w.vacStepYear(-1);
    await settle();
    eq('‹ reads the year before', calls[calls.length - 1].url, `/api/vacation?year=${Y - 1}`);
    w.vacStepYear(1);
    await settle();
    w.confirmAnswers.push(true);
    await w.vacCopyLastYear();
    const post = calls.find(c => c.method === 'POST');
    eq('Copy asks, then copies last year into this one, then reads it again',
      [post && post.url, calls[calls.length - 1].url], [`/api/vacation?action=copy&from=${Y - 1}&to=${Y}`, `/api/vacation?year=${Y}`]);
    assert('  having said it copies each number as it stands', /copied as it stands, including any hours carried over into it/.test(w.confirmed[w.confirmed.length - 1]));
    eq('  and says how many', doc.getElementById('vac-result').textContent, `Copied ${Y - 1} hours to 1 person for ${Y}.`);

    ({ w, doc, calls } = buildTab(() => ({ status: 500, body: { ok: false, error: 'Database error' } })));
    w.eval("switchUserSubTab('vacation')");
    await settle();
    eq('a failed read says so in the table', doc.querySelector('#vacListBody td').textContent, 'Database error');
  }

  // ── The Timesheet ─────────────────────────────────────────────────────────
  console.log('\n[the Timesheet]');
  {
    const TODAY = '2026-12-28';   // a Monday, in the week New Year falls in
    function buildSheet(answers) {
      const dom = new JSDOM(`<!doctype html><div class="user-chip" id="userChip"><strong>brewerzach</strong><span class="vac-chip" id="vacChip" hidden></span></div>
        <input type="date" id="f-off-date"><input type="date" id="f-off-date-end"><input id="f-off-hours">
        <div class="hint vac-hint" id="off-vac-hint" hidden></div>`, { runScripts: 'outside-only' });
      const w = dom.window;
      const asked = [];
      w.fetch = async url => {
        asked.push(String(url));
        const a = answers(String(url), asked.length);
        if (a instanceof Promise) return a;
        return { ok: a.status === 200, status: a.status, json: async () => a.body };
      };
      w.eval(`var offType = null; var offLen = 'full'; var OFF_LEN_HOURS = { full: 8, half: 4 };
        function todayStr() { return '${TODAY}'; } function authHeaders() { return {}; }`);
      w.eval(requireFn(TS_SCRIPT, 'offRangeDays').replace('function offRangeDays', 'const MAX_OFF_RANGE_DAYS = 31; function offRangeDays'));
      w.eval(requireFn(TS_SCRIPT, 'offHoursValue'));
      w.eval(sliceSource(TS_SCRIPT, '// ── Vacation left ─', '// ── How long the day off is', 'the vacation balance', 'renderVacationHint'));
      return { w, doc: w.document, asked };
    }
    const bank = b => (url) => {
      const years = (url.match(/years=([\d,]+)/) || [])[1].split(',');
      const balances = {};
      for (const y of years) balances[y] = b[y] || { tracked: false };
      return { status: 200, body: { ok: true, balances } };
    };
    const B26 = { tracked: true, hours: 40, approved: 8, pending: 8, left: 24 };

    let { w, doc, asked } = buildSheet(bank({ 2026: B26 }));
    await w.refreshVacation();
    eq('it reads this year', asked, ['/api/vacation?mine=1&years=2026']);
    const chip = doc.getElementById('vacChip');
    eq('the header says what is left, quietly', [chip.hidden, chip.textContent, chip.classList.contains('over')], [false, 'Vacation: 24 h left', false]);
    assert('  and the sum behind it on hover', chip.title === '2026: 40 h for the year − 8 h approved − 8 h waiting for approval = 24 h left (3 days)', chip.title);
    const hint = doc.getElementById('off-vac-hint');
    w.eval("offType = 'sick'"); w.renderVacationHint();
    assert('nothing on a sick day', hint.hidden);
    doc.getElementById('f-off-date').value = '2026-12-29';
    w.eval("offType = 'vacation'"); w.renderVacationHint();
    eq('a full day of vacation', hint.textContent, 'Vacation for 2026: 24 h left (3 days). This takes 8 h, leaving 16 h (2 days).');
    w.eval("offLen = 'half'"); w.renderVacationHint();
    eq('a half day', hint.textContent, 'Vacation for 2026: 24 h left (3 days). This takes 4 h, leaving 20 h (2.5 days).');
    w.eval("offLen = 'custom'"); doc.getElementById('f-off-hours').value = '0'; w.renderVacationHint();
    eq('an unpaid day takes nothing', hint.textContent, 'Vacation for 2026: 24 h left (3 days).');
    w.eval("offLen = 'full'");
    doc.getElementById('f-off-date').value = '';
    w.renderVacationHint();
    eq('no date yet: just what is left', hint.textContent, 'Vacation for 2026: 24 h left (3 days).');

    // A range across New Year: each day comes out of its own year.
    w.eval("offLen = 'range'");
    doc.getElementById('f-off-date').value = '2026-12-28';
    doc.getElementById('f-off-date-end').value = '2027-01-04';
    w.renderVacationHint();
    await settle();
    eq('a range into next year asks for next year too', asked.slice(1), ['/api/vacation?mine=1&years=2027']);
    eq('  and, next year not being set, takes only this year’s days off this year’s bank',
      hint.textContent, 'Vacation for 2026: 24 h left (3 days). This takes 32 h, which puts you 8 h over. You can still send it — the office will see it.');
    assert('  in amber', hint.classList.contains('over'));
    eq('the submit confirm learns the same', w.vacationOverage(), [{ year: 2026, left: 24, take: 32, after: -8 }]);

    ({ w, doc, asked } = buildSheet(bank({ 2026: B26, 2027: { tracked: true, hours: 80, approved: 0, pending: 0, left: 80 } })));
    w.eval("offType = 'vacation'; offLen = 'range'");
    doc.getElementById('f-off-date').value = '2026-12-31';
    doc.getElementById('f-off-date-end').value = '2027-01-01';
    w.renderVacationHint();
    await settle();
    eq('both years set: both said, each with its own days',
      doc.getElementById('off-vac-hint').textContent,
      'Vacation for 2026: 24 h left (3 days). This takes 8 h, leaving 16 h (2 days). Vacation for 2027: 80 h left (10 days). This takes 8 h, leaving 72 h (9 days).');

    // Not tracked, or not readable: nothing, and no asking again in a loop.
    ({ w, doc, asked } = buildSheet(() => ({ status: 500, body: { ok: false } })));
    w.eval("offType = 'vacation'");
    doc.getElementById('f-off-date').value = '2026-12-29';
    w.renderVacationHint();
    await settle();
    w.renderVacationHint(); w.renderVacationHint();
    await settle();
    eq('a failed read shows nothing, and is not retried on every keystroke', [doc.getElementById('off-vac-hint').hidden, doc.getElementById('vacChip').hidden, asked.length], [true, true, 1]);
    ({ w, doc, asked } = buildSheet(bank({})));
    await w.refreshVacation();
    w.eval("offType = 'vacation'"); w.renderVacationHint();
    eq('not tracked: nothing anywhere', [doc.getElementById('off-vac-hint').hidden, doc.getElementById('vacChip').hidden], [true, true]);

    // Answers out of order: the later ask owns the year.
    let release;
    const slow = new Promise(r => { release = r; });
    ({ w, doc, asked } = buildSheet((url, n) => n === 1
      ? slow.then(() => ({ ok: true, status: 200, json: async () => ({ ok: true, balances: { 2026: { tracked: true, hours: 40, approved: 0, pending: 0, left: 40 } } }) }))
      : { status: 200, body: { ok: true, balances: { 2026: B26 } } }));
    const first = w.refreshVacation();
    await w.refreshVacation();
    release();
    await first;
    eq('an answer from before a submit does not land over the one from after', doc.getElementById('vacChip').textContent, 'Vacation: 24 h left');

    const over = buildSheet(bank({ 2026: { tracked: true, hours: 8, approved: 16, pending: 0, left: -8 } }));
    await over.w.refreshVacation();
    eq('over, in amber, in the header', [over.doc.getElementById('vacChip').textContent, over.doc.getElementById('vacChip').classList.contains('over')], ['Vacation: 8 h over', true]);

    const submit = requireFn(TS_SCRIPT, 'submitEntry');
    assert('the submit confirm adds the overage, and still lets it go', /for \(const o of vacationOverage\(\)\)/.test(submit) && /You can still send it/.test(submit));
    assert('every load of the list reads the banks again', /refreshVacation\(\);/.test(requireFn(TS_SCRIPT, 'loadEntries')));
    assert('picking a type, a date or a length redraws it',
      /renderVacationHint\(\)/.test(requireFn(TS_SCRIPT, 'setOffType')) && /renderVacationHint\(\)/.test(requireFn(TS_SCRIPT, 'onOffDatesChange'))
      && /id="f-off-hours"[^>]*oninput="renderVacationHint\(\)"/.test(TS));
  }

  // ── Payroll ───────────────────────────────────────────────────────────────
  console.log('\n[Payroll]');
  {
    function buildPay(answer) {
      const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
      const w = dom.window;
      const asked = [];
      w.fetch = async url => { asked.push(String(url)); const a = answer(String(url)); return { ok: a.status === 200, status: a.status, json: async () => a.body }; };
      w.eval("var allEntries = []; var currentTab = 'pending'; var renders = 0; function renderRows() { renders++; maybeRefreshVacation(); } function authHeaders() { return {}; }");
      // var, not const: each eval is its own scope for let and const.
      w.eval(PAY_SCRIPT.match(/const PAID_LEAVE_HOURS = [^;]+;/)[0].replace('const ', 'var '));
      const maxLeave = PAY_SCRIPT.match(/const MAX_LEAVE_HOURS = [^;]+;/);
      if (maxLeave) w.eval(maxLeave[0].replace('const ', 'var '));
      w.eval(requireFn(PAY_SCRIPT, 'leaveHoursOf'));
      w.eval(requireFn(PAY_SCRIPT, 'escapeHtml'));
      w.eval(requireFn(PAY_SCRIPT, 'prettyDate'));
      // vacBanks lifted to var so the test can reach in and shape a bank.
      w.eval(sliceSource(PAY_SCRIPT, '// ── Vacation banks ─', 'function prettyDate(s)', 'the vacation flags', 'vacationOverConfirm')
        .replace('let vacBanks', 'var vacBanks'));
      return { w, asked };
    }
    const E = (id, date, status, hours, extra) => ({ id: String(id), user_id: 9, username: 'brewerzach', entry_type: 'time_off', time_off_type: 'vacation',
      work_date: date, status, time_off_hours: hours, ...(extra || {}) });
    const BANK = { ok: true, year: 2026, balances: { 9: { hours: 16, approved: 0, pending: 24, left: -8, after: { 5: 8, 6: 0, 7: -8 } } } };
    let { w, asked } = buildPay(url => /year=2026/.test(url) ? { status: 200, body: BANK } : { status: 200, body: { ok: true, balances: {} } });
    w.allEntries = [E(5, '2026-03-02', 'submitted', 8), E(6, '2026-03-03', 'submitted', 8), E(7, '2026-03-04', 'submitted', 8),
      E(8, '2026-03-02', 'submitted', 8, { time_off_type: 'sick' }), { id: '9', entry_type: 'daily', work_date: '2025-06-01', status: 'submitted' }];
    w.eval('allEntries = window.allEntries');
    w.renderRows();
    await settle();
    eq('it reads the banks for the years with vacation in them, once', asked, ['/api/vacation?view=payroll&year=2026']);
    eq('  and redraws when they arrive, without asking again', [w.eval('renders'), asked.length], [2, 1]);
    const note = id => { const d = w.document.createElement('div'); d.innerHTML = w.vacationNoteHtml(w.allEntries.find(e => e.id === String(id))); const n = d.firstElementChild; return n ? (n.classList.contains('over') ? 'OVER ' : '') + n.textContent : ''; };
    eq('each waiting day: what it leaves, or how far over it goes', [note(5), note(6), note(7)],
      ['Leaves 8 h of 2026 vacation', 'Leaves 0 h of 2026 vacation', 'OVER 8 h over 2026 vacation']);
    eq('  nothing on a sick day', note(8), '');
    const half = E(10, '2026-03-05', 'submitted', 4);
    eq('a half day past the bank is over by its own four hours, not by the whole shortfall',
      (() => { w.eval("vacBanks['2026']['9'].after['10'] = -12"); w.allEntries.push(half); return note(10); })(), 'OVER 4 h over 2026 vacation');
    eq('an approved day carries no note', w.vacationNoteHtml(E(5, '2026-03-02', 'approved', 8)), '');
    eq('a login with no bank carries none', w.vacationNoteHtml({ ...E(5, '2026-03-02', 'submitted', 8), user_id: 99 }), '');
    const msg = w.vacationOverConfirm(w.allEntries.filter(e => e.id === '5' || e.id === '7'));
    assert('the approve confirm names the day that goes over, only that one',
      /^\n\nThis vacation day goes past the hours set in Manage System:\n• brewerzach, .+: 8 h over 2026 vacation$/.test(msg), JSON.stringify(msg));
    eq('  and adds nothing when nothing is over', w.vacationOverConfirm([w.allEntries[0]]), '');
    const many = Array.from({ length: 10 }, (_, i) => E(100 + i, '2026-04-0' + (i % 9 + 1), 'submitted', 8));
    w.eval("for (let i = 0; i < 10; i++) vacBanks['2026']['9'].after[String(100 + i)] = -8");
    const big = w.vacationOverConfirm(many);
    assert('  ten over: eight named and "2 more"', /^\n\n10 of these vacation days go past/.test(big) && (big.match(/^•/gm) || []).length === 9 && /• and 2 more$/.test(big), big);

    w.renderRows();            // the half day added above is a change: read once for it
    await settle();
    const base = asked.length;
    w.renderRows();
    await settle();
    eq('a redraw with nothing changed asks nothing', asked.length, base);
    w.allEntries.splice(0, 1);
    w.renderRows();
    await settle();
    eq('a request deleted (denied) reads the banks again', asked.length, base + 1);
    w.allEntries[0].status = 'approved';
    w.renderRows();
    await settle();
    eq('so does one approved', asked.length, base + 2);

    ({ w, asked } = buildPay(() => ({ status: 403, body: { ok: false, error: 'Payroll approval access required' } })));
    w.allEntries = [E(5, '2026-03-02', 'submitted', 8)];
    w.eval('allEntries = window.allEntries');
    w.renderRows();
    await settle();
    eq('a refused read draws nothing, and nothing breaks', w.vacationNoteHtml(w.allEntries[0]), '');

    const grid = requireFn(PAY_SCRIPT, 'renderRows');
    assert('the grid draws the note under the type, and reads the banks on every redraw',
      /<td>\$\{type\}\$\{vacationNoteHtml\(e\)\}<\/td>/.test(grid) && /maybeRefreshVacation\(\);/.test(grid));
    assert('both approve confirms carry it',
      /confirm\('Approve this entry\?' \+ vacationOverConfirm\(\[e\]\)\)/.test(requireFn(PAY_SCRIPT, 'approveOne'))
      && /vacationOverConfirm\(entries\)/.test(requireFn(PAY_SCRIPT, 'routeBulkApprove')));
  }

  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
