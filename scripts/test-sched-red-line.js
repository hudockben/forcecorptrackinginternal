#!/usr/bin/env node
'use strict';
/**
 * Approved off, red-lined: nobody on vacation gets put on a job by accident.
 *
 * Run: node scripts/test-sched-red-line.js
 *
 * Payroll shows Ken Stewart approved off on Oct 26. On the Scheduler's day
 * board for Oct 26 the crew panel dimmed Ken's name, said "free" in green, and
 * let it be dragged — the drop refused it, but only after the fact. Now:
 *
 * THE DAY OFF REACHES THE PERSON, FROM EVERY LOGIN. Time off is filed under the
 * login that sent it. The board used to move a login's days onto its person
 * only for logins with a roster row of their own — the ones flagged Supervisor
 * or Driver — so a laborer's approved vacation, sent from a login nobody had
 * flagged, never reached the person's name on the board at all. Every login now goes to
 * the person it is, by the same rules the crew list folds by: an admin's
 * answer first, then the one person the name points at, else nobody.
 *
 * THE CREW PANEL RED-LINES THE ROW. Approved off every day on screen: struck
 * through in red, "off" where "free" was, sunk to the bottom of the trade, and
 * not draggable; a click says why. A part day, a request, or some of a week's
 * days are said on the row, which still drags, because there is time left to
 * book — the drop refuses a whole day itself.
 *
 * A BOOKING ALREADY ON THE DAY IS FLAGGED. Struck through on the board, the day
 * hatched on By Crew, and the board note points at the Attention tab's list.
 *
 * No DB, server or browser required: the neon driver and the auth module are
 * stubbed, and the page runs in jsdom.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { JSDOM, VirtualConsole } = require('jsdom');

let CURRENT_SQL = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth' || request === '../lib/auth') {
    return { requireAuth: () => ({ companyCode: 'FCT', role: 'admin', username: 'hudockben' }), hasDivisionAccess: () => true,
             requireDivision: () => null, payrollAccess: () => ({ canCode: true, canApprove: true, isCoder: false }) };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const { foldLoginRows } = require(path.join(ROOT, 'api', 'lib', 'roster'));
const employeesHandler = require(path.join(ROOT, 'api', 'employees.js'));
const { buildBoard } = require(path.join(ROOT, 'api', 'scheduler', 'board.js'));
const SCHED = fs.readFileSync(path.join(ROOT, 'scheduler.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`); }
}
const eq = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

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
const row = (name, extra) => ({ id: null, name, job_class: null, is_supervisor: false, is_driver: false,
  phone: null, email: null, supervisor_name: null, source: 'employees', ...(extra || {}) });

// Ken's login is flagged Supervisor, so it has a row; the rest of these logins
// have none, which is true of most of a field crew.
const ROSTER = [
  row('Ken Stewart'), row('stewartken', { is_supervisor: true }),
  row('Zach Brewer', { job_class: 'Laborer' }),
  row('Aaron Todd'), row('Amy Todd'),
  row('Robert Becker', { job_class: 'Driver' }),
  row('Dale Smith'),
];
const LOGINS = ['stewartken', 'brewerzach', 'atodd', 'beckerbob', 'smithdale', 'secretlogin'];
const LINKS  = { beckerbob: { person: 'Robert Becker' },   // a nickname an admin placed by hand
                 smithdale: { none: true } };              // an admin said: nobody on the crew
const OCT26 = '2026-10-26', OCT27 = '2026-10-27';
const off = (username, date, status, hours) => ({ work_date: date, status, time_off_type: 'vacation', time_off_hours: hours == null ? null : hours, name: username });
const TIME_OFF = [
  off('stewartken', OCT26, 'approved'),            // Ken, through the flagged login
  off('brewerzach', OCT26, 'approved'),            // a laborer's login with no row
  off('brewerzach', OCT27, 'submitted'),           //   and a request the day after
  off('Zach Brewer', OCT27, 'approved'),           //   which an entry under the name approves
  off('atodd',      OCT26, 'approved'),            // Aaron or Amy: nobody can say
  off('beckerbob',  OCT26, 'approved'),            // placed by hand
  off('smithdale',  OCT26, 'approved'),            // said to be nobody on the crew
];
function boardSql() {
  return recordingSql((text, values) => {
    if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
    if (/SELECT username FROM users/.test(text)) return LOGINS.map(username => ({ username }));
    if (/SELECT value FROM app_data WHERE key = \?/.test(text) && values[0] === 'FCT:fct_login_links') return [{ value: { links: LINKS } }];
    if (/FROM timesheet_entries te/.test(text)) return TIME_OFF.map(r => ({ ...r }));
    return [];
  });
}

// ── The Scheduler, running ──────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const ds  = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const plus = n => { const x = new Date(); x.setDate(x.getDate() + n); return ds(x); };
// "Oct 26": a weekday four weeks out, whatever day this runs.
const D = (() => { let n = 27; while ([0, 6].includes(new Date(plus(n) + 'T12:00:00').getDay())) n++; return plus(n); })();
const WEEK = Array.from({ length: 7 }, (_, i) => { const x = new Date(D + 'T12:00:00'); x.setDate(x.getDate() + i); return ds(x); });
const whole = (status, type) => ({ status, type: type || 'vacation', hours: 8, partial: false });

function boardPayload() {
  const allWeek = {}; WEEK.forEach(d => { allWeek[d] = whole('approved'); });
  return {
    generatedAt: new Date().toISOString(),
    employees: [
      { name: 'Ken Stewart',  jobClass: '', isSupervisor: true,  isDriver: false },
      { name: 'Aaron Todd',   jobClass: '', isSupervisor: true,  isDriver: false },
      { name: 'Blake Hostetler', jobClass: 'Laborer', isSupervisor: false, isDriver: false },
      { name: 'Pat Doyle',    jobClass: 'Laborer', isSupervisor: false, isDriver: false },
      { name: 'Sam Reed',     jobClass: 'Laborer', isSupervisor: false, isDriver: false },
      { name: 'Vic Lane',     jobClass: 'Laborer', isSupervisor: false, isDriver: false },
    ],
    offScheduler: [],
    equipment: ['T-14'],
    jobs: [
      { division: 'turf', id: 'j1', name: 'Riverbend', jobNumber: '26001', status: 'Active', bidValue: 1, deadline: null,
        subCodes: [{ key: '3100||', costCode: '3100', subCode: '', description: 'Fine grade', status: 'on-track', bidQty: 10, runningQty: 1, pctComplete: 10, crew: [], equipment: [] }] },
    ],
    plannedAssignments: [],
    timeOff: {
      'Ken Stewart': { [D]: whole('approved') },                                   // Oct 26, approved
      'Pat Doyle':   { [D]: { status: 'approved', type: 'vacation', hours: 4, partial: true } },
      'Sam Reed':    { [D]: whole('submitted', 'sick') },
      'Vic Lane':    allWeek,
    },
    excludedJobs: 0, truckingAssignments: {},
    loginNames: {}, unmatchedLogins: [], manualLogins: [], offCrewLogins: [], loginGuesses: {},
    sourceDivisions: ['turf', 'paving', 'kiewit', 'dust', 'ees', 'trucking'], projectDivisions: ['turf', 'paving', 'kiewit'],
  };
}
// Ken was booked on Riverbend for the day before it was approved off.
const SAVED = () => ({ version: 1, siteTimes: {}, assignments: { [D]: [
  { id: 'k1', resource: 'Ken Stewart', kind: 'emp', division: 'turf', jobId: 'j1', jobName: 'Riverbend', costCode: '', half: false },
] } });
const SESSION = { fct_token: 'harness', fct_division: 'turf',
  fct_user: JSON.stringify({ userId: 1, username: 'harness', companyCode: 'FCT', isPlatformAdmin: true,
                             divisionRoles: { turf: 'level5', scheduler: 'level5' } }) };

function bootScheduler(opts = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/i.test(e.message || '')) errors.push(e.message); });
  const dom = new JSDOM(SCHED, {
    runScripts: 'dangerously', url: 'https://datawatch.app/scheduler.html', virtualConsole: vc,
    beforeParse(w) {
      Object.entries(SESSION).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = (url) => {
        const u = String(url);
        const data = u.includes('/api/scheduler/board') ? boardPayload()
                   : u.includes('fct_scheduler_assignments') ? { value: opts.empty ? { assignments: {} } : SAVED() }
                   : u.includes('/api/data/') ? { value: null } : { ok: true };
        return Promise.resolve({ ok: true, status: 200, json: async () => data, text: async () => '' });
      };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  const w = dom.window;
  const goTo = (date, span) => w.eval(`state.span = '${span || 'day'}'; state.weekAnchor = startOfDay(new Date('${date}T12:00:00')); render();`);
  const railRow = name => [...w.document.querySelectorAll('#railList .rail-row')].find(r => r.dataset.res === name);
  const railNames = () => [...w.document.querySelectorAll('#railList .rail-row')].map(r => r.dataset.res);
  const toast = () => (w.document.getElementById('toast') || {}).textContent || '';
  const main = () => (w.document.getElementById('main') || {}).innerHTML || '';
  const booked = (d, name) => (w.eval('state').assignments[d] || []).filter(a => a.resource === name);
  return { dom, w, errors, goTo, railRow, railNames, toast, main, booked };
}
const settle = () => new Promise(r => setTimeout(r, 900));

(async () => {
  console.log('Approved off, red-lined\n');

  console.log('[the day off reaches the person, from every login]');
  {
    const quiet = console.warn; console.warn = () => {};
    const board = await buildBoard(boardSql(), 'FCT', '2026-09-29');
    console.warn = quiet;
    const t = board.timeOff;
    eq('  Ken’s day off, sent from Ken’s flagged login, reaches Ken', t['Ken Stewart'] && t['Ken Stewart'][OCT26] && t['Ken Stewart'][OCT26].status, 'approved');
    eq('  a laborer’s, sent from a login with no row, reaches the person too — this is the one that went missing', t['Zach Brewer'] && t['Zach Brewer'][OCT26] && t['Zach Brewer'][OCT26].status, 'approved');
    eq('  where the name and the login both have a day, the approved one stands', t['Zach Brewer'][OCT27].status, 'approved');
    eq('  a login placed by hand goes where the admin said', t['Robert Becker'] && t['Robert Becker'][OCT26] && t['Robert Becker'][OCT26].status, 'approved');
    assert('  a login two people answer to goes to neither', !(t['Aaron Todd'] || {})[OCT26] && !(t['Amy Todd'] || {})[OCT26]);
    assert('  nor one an admin said is nobody on the crew', !(t['Dale Smith'] || {})[OCT26]);
    assert('  the logins keep their own entries, for a booking still under that name', !!(t.brewerzach && t.brewerzach[OCT26]));
    assert('  and which login is whose is not sent with the board', !('loginPeople' in board) && !/secretlogin/.test(JSON.stringify(board)));

    const { loginPeople } = foldLoginRows(ROSTER, LOGINS, LINKS);
    eq('  every login is placed by the crew list’s own rules', loginPeople,
      { stewartken: 'Ken Stewart', brewerzach: 'Zach Brewer', beckerbob: 'Robert Becker' });
    CURRENT_SQL = boardSql();
    let body = null;
    const res = { status() { return this; }, json(b) { body = b; return this; }, setHeader() {}, end() {} };
    await employeesHandler({ method: 'GET', query: { view: 'people' }, body: {}, headers: {} }, res);
    assert('  nor with the list of people', body && !('loginPeople' in body) && !/secretlogin|brewerzach/.test(JSON.stringify(body)), JSON.stringify(body).slice(0, 200));
  }

  console.log('\n[the crew panel red-lines a day approved off]');
  {
    const p = bootScheduler(); await settle();
    p.goTo(D);
    assert('the page boots and turns to the day with nothing thrown', p.errors.length === 0, p.errors[0]);
    const ken = p.railRow('Ken Stewart');
    assert('Ken is red-lined', !!ken && ken.classList.contains('off'), ken && ken.outerHTML);
    eq('  and cannot be dragged', ken.getAttribute('draggable'), 'false');
    eq('  and says "off" where "free" was', ken.querySelector('.rail-load').textContent, 'off');
    assert('  in red', ken.querySelector('.rail-load').classList.contains('offday'));
    assert('  and the tooltip says what and when', /approved off, cannot be scheduled/.test(ken.title) && /vacation · off \(approved\)/.test(ken.title), ken.title);
    const sups = p.railNames().filter(n => ['Ken Stewart', 'Aaron Todd'].includes(n));
    eq('  and sinks below the supervisor who can be sent', sups, ['Aaron Todd', 'Ken Stewart']);
    const css = /\.rail-row\.off \.rail-name \{[^}]*text-decoration:line-through[^}]*var\(--red\)/.test(SCHED);
    assert('  the name is struck through in red', css);

    ken.click();
    assert('clicking the row says why', /Ken Stewart is approved off .+ \(vacation\) — cannot be scheduled/.test(p.toast()), p.toast());
    const drag = new p.w.Event('dragstart', { bubbles: true, cancelable: true });
    ken.querySelector('.rail-name').dispatchEvent(drag);
    assert('a drag begun on the row anyway goes nowhere', drag.defaultPrevented === true && p.w.eval('_drag') === null);
    p.w.railDrop({ type: 'rail', resource: 'Ken Stewart', kind: 'emp' }, { kind: 'job', date: D, division: 'turf', jobId: 'j1', costCode: '' });
    assert('and the drop itself still refuses Ken, as it did', /approved off/.test(p.toast()) && p.booked(D, 'Ken Stewart').length === 1, p.toast());

    const pat = p.railRow('Pat Doyle');
    assert('a part day off is not red-lined — there is an afternoon to fill', !pat.classList.contains('off') && pat.getAttribute('draggable') === 'true');
    assert('  and says how much of the day is gone', /4h off/.test((pat.querySelector('.rail-off') || {}).textContent || ''), pat.innerHTML);
    const sam = p.railRow('Sam Reed');
    assert('a request not yet approved warns and does not block', !sam.classList.contains('off') && /req off/.test((sam.querySelector('.rail-off') || {}).textContent || ''), sam.innerHTML);
    const blake = p.railRow('Blake Hostetler');
    assert('somebody with no time off is as before', !blake.classList.contains('off') && !blake.querySelector('.rail-off') && /free/.test(blake.querySelector('.rail-load').textContent));

    p.w.openAssignJob('turf', 'j1', '', D);
    const kenPick = [...p.w.document.querySelectorAll('#pickList .pick-row')].find(r => /Ken Stewart/.test(r.textContent));
    assert('the assign dialog strikes Ken out as well', !!kenPick && kenPick.classList.contains('blocked') && /off \(approved\)/.test(kenPick.textContent), kenPick && kenPick.outerHTML);
    p.w.closeAssign();

    p.goTo(D, 'week');
    const kenWeek = p.railRow('Ken Stewart');
    assert('on a week board Ken is off one day of seven: not red-lined, still draggable', !kenWeek.classList.contains('off') && kenWeek.getAttribute('draggable') === 'true');
    assert('  and the row says so, in red', !!kenWeek.querySelector('.rail-off.hard') && /⛱ 1d/.test(kenWeek.querySelector('.rail-off.hard').textContent), kenWeek.innerHTML);
    assert('  naming the day', /Approved off, cannot be scheduled: .+ vacation/.test(kenWeek.querySelector('.rail-off.hard').title));
    const vic = p.railRow('Vic Lane');
    assert('off all seven days is red-lined on a week board too', vic.classList.contains('off') && vic.getAttribute('draggable') === 'false');
    p.w.close();
  }

  console.log('\n[a booking already on the day is flagged]');
  {
    const p = bootScheduler(); await settle();
    p.goTo(D);
    const chip = [...p.w.document.querySelectorAll('.asn[data-res="Ken Stewart"]')][0];
    assert('Ken’s chip on the job is struck through', !!chip && chip.classList.contains('offday'), chip && chip.outerHTML);
    assert('  and its tooltip says why', /approved off this day/.test(chip.title), chip.title);
    assert('the board note says a booking sits on a day off, and where to fix it',
      /⛱ 1 booking is on an approved day off/.test(p.main()) && /state\.view='attention'/.test(p.main()), p.main().slice(-900));
    // Full roster, so a person with nothing booked has a row to look at too.
    p.w.eval("state.view = 'crew'; state.showAll = true; render();");
    const cell = p.w.document.querySelector('td.cell[data-res="Ken Stewart"][data-date="' + D + '"]');
    assert('By Crew hatches the day', !!cell && cell.classList.contains('offday'), cell && cell.outerHTML.slice(0, 300));
    assert('  and strikes the booking on it', !!cell.querySelector('.asn.offday'));
    const pat = p.w.document.querySelector('td.cell[data-res="Pat Doyle"][data-date="' + D + '"]');
    assert('  a part day is not hatched', !!pat && !pat.classList.contains('offday'));
    p.w.close();

    const q = bootScheduler({ empty: true }); await settle();
    q.goTo(D);
    assert('with nothing booked on a day off, the board says nothing about it', !/on an approved day off/.test(q.main()));
    q.w.close();
  }

  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('Harness error:', err); process.exit(1); });
