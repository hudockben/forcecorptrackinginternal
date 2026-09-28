#!/usr/bin/env node
'use strict';
/**
 * Each person once: a login's role row folds into the person it names.
 *
 * Run: node scripts/test-login-names.js
 *
 * Manage Users → Roles lists LOGINS by username, and its Supervisor and Driver
 * toggles are stored on an employees row named after the username. So flagging
 * Aaron Todd's login wrote "toddaaron" beside the "Aaron Todd" the division
 * lists already hold, and the Scheduler's crew list, its crew counts and the
 * Team Directory all showed Aaron Todd twice.
 *
 * Pinned below:
 *
 * THE MATCH. A login row folds into the one person its username names — last
 * + first, first + last, an initial, a middle name — and never into two. A
 * login nobody answers to stays in the list, marked, rather than guessed at.
 *
 * WHAT THE PERSON TAKES ON. The login's Supervisor and Driver flags, any
 * contact detail the person lacks, and "reports to" lines pointing at the login.
 *
 * WHAT DOES NOT CHANGE. The rows themselves: plain GET /api/employees returns
 * them as stored, because Manage Users → Roles reads a login's flags off them,
 * and Timesheet and Payroll find a login's role by that name. Only names the
 * roster already returns are ever handed out.
 *
 * THE BOARD. The Scheduler gets people, the login → person pairs, the logins
 * it could not place, and the time off filed under a login. Bookings made under
 * a login name move to the person only from the review dialog.
 *
 * No DB or server required: the neon driver and the auth module are stubbed.
 */

const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');
const Module = require('module');

let CURRENT_SQL = null;
const ADMIN = { companyCode: 'FCT', userId: 1, username: 'hudockben', role: 'admin', isPlatformAdmin: true };
const FIELD = { companyCode: 'FCT', userId: 9, username: 'strickallen', role: 'level1', isPlatformAdmin: false };
let NEXT_AUTH = ADMIN;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth' || request === '../lib/auth') {
    return {
      requireAuth: () => NEXT_AUTH,
      hasDivisionAccess: () => true,
      requireDivision: () => null,
      payrollAccess: () => ({ canCode: true, canApprove: true, isCoder: false }),
    };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const { foldLoginRows, loginKeysFor, loginKey, readPeopleRoster, readEmployeeRoster, writeLoginLink, readLoginLinks } = require(path.join(ROOT, 'api', 'lib', 'roster'));
const employeesHandler = require(path.join(ROOT, 'api', 'employees.js'));
const { buildBoard } = require(path.join(ROOT, 'api', 'scheduler', 'board.js'));
const { requireFn, sliceSource, evalSlice } = require(path.join(__dirname, 'lib', 'fn-source.js'));
const SCHED = fs.readFileSync(path.join(ROOT, 'scheduler.html'), 'utf8');
const DIVS  = fs.readFileSync(path.join(ROOT, 'divisions.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
const eq = (label, got, want) => assert(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

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
const row = (name, extra) => ({ id: null, name, job_class: null, is_supervisor: false, is_driver: false,
  phone: null, email: null, supervisor_name: null, source: 'employees', ...(extra || {}) });

// The supervisor list from the screenshot this fix answers, plus the edges.
const ROSTER = [
  row('Aaron Todd', { job_class: 'Foreman', phone: '814-555-0100' }),
  row('toddaaron', { is_supervisor: true, phone: '814-555-0199', email: 'aaron@example.com' }),
  row('Allen Strick', { job_class: 'Operator' }),
  row('strickallen', { is_supervisor: true }),
  row('Bryan Force'), row('forcebryan', { is_supervisor: true }),
  row('Colton McMillan'), row('mcmillancolton', { is_supervisor: true }),
  row('Dan Hopkins'), row('hopkinsdan', { is_supervisor: true }),
  row('Ken Stewart'), row('stewartken', { is_supervisor: true }),
  row('Carrie Stewart'), row('stewartcarrie', { is_supervisor: true }),
  row('Corey Adams', { job_class: 'Laborer' }), row('adamscorey', { is_supervisor: true }),
  row('Bob Becker Jr.'), row('beckerbob', { is_driver: true }),
  row("Pat O'Brien"), row('obrienpat', { is_driver: true }),
  row('Mary Ann Smith'), row('smithmaryann', { is_supervisor: true }),
  row('Amy Todd'), row('atodd', { is_supervisor: true }),                         // Aaron or Amy: ambiguous
  row('travissteve', { is_supervisor: true }),                                     // nobody on the roster
  row('brewernate', { job_class: 'Laborer' }),                                     // looks like a login, is not one
  row('Nick Reed', { supervisor_name: 'toddaaron' }),
  row('Ben Hudock'),
];
const LOGINS = ['toddaaron', 'strickallen', 'forcebryan', 'mcmillancolton', 'hopkinsdan', 'stewartken', 'stewartcarrie',
                'adamscorey', 'beckerbob', 'obrienpat', 'smithmaryann', 'atodd', 'travissteve', 'hudockben', 'Ben Hudock',
                'secretlogin'];

(async () => {
  console.log('Each person once\n');

  console.log('[the ways a login is made from a name]');
  {
    const keys = loginKeysFor('Aaron Todd');
    assert('  last + first', keys.includes('toddaaron'));
    assert('  first + last', keys.includes('aarontodd'));
    assert('  an initial and a last name, either way round', keys.includes('atodd') && keys.includes('todda'));
    assert('  a first name and an initial', keys.includes('aaront'));
    assert('  a suffix is dropped', loginKeysFor('Bob Becker Jr.').includes('beckerbob'));
    assert('  punctuation is dropped', loginKeysFor("Pat O'Brien").includes('obrienpat') && loginKeysFor('Colton McMillan').includes('mcmillancolton'));
    assert('  a middle name kept whole', loginKeysFor('Mary Ann Smith').includes('smithmaryann'));
    eq('  a one-word name makes no login', loginKeysFor('toddaaron'), []);
    eq('  a username compares as letters only', [loginKey('Aaron.Todd'), loginKey('toddaaron2')], ['aarontodd', 'toddaaron']);
  }

  console.log('\n[the fold]');
  {
    const { people, matched, unmatched } = foldLoginRows(ROSTER, LOGINS);
    const byName = Object.fromEntries(people.map(p => [p.name, p]));
    eq('  every pair from the screenshot folds', ['toddaaron', 'strickallen', 'forcebryan', 'mcmillancolton', 'hopkinsdan', 'stewartken'].map(l => matched[l]),
      ['Aaron Todd', 'Allen Strick', 'Bryan Force', 'Colton McMillan', 'Dan Hopkins', 'Ken Stewart']);
    eq('  two logins with one last name go to the right people', [matched.stewartken, matched.stewartcarrie], ['Ken Stewart', 'Carrie Stewart']);
    eq('  suffixes, apostrophes and middle names fold too', [matched.beckerbob, matched.obrienpat, matched.smithmaryann],
      ['Bob Becker Jr.', "Pat O'Brien", 'Mary Ann Smith']);
    assert('  no folded login is left in the list', Object.keys(matched).every(l => !byName[l]));
    eq('  so the list is 11 shorter', people.length, ROSTER.length - Object.keys(matched).length);
    assert('  and nobody appears twice', new Set(people.map(p => p.name.toLowerCase())).size === people.length);

    assert('  the person takes on the login’s Supervisor flag', byName['Aaron Todd'].is_supervisor && byName['Corey Adams'].is_supervisor);
    assert('  and its Driver flag', byName['Bob Becker Jr.'].is_driver && byName["Pat O'Brien"].is_driver);
    eq('  and remembers which logins it holds', byName['Aaron Todd'].logins, ['toddaaron']);
    eq('  keeps its own job class', byName['Corey Adams'].job_class, 'Laborer');
    eq('  keeps its own phone number over the login’s', byName['Aaron Todd'].phone, '814-555-0100');
    eq('  and fills a blank from the login’s card', byName['Aaron Todd'].email, 'aaron@example.com');
    eq('  a "reports to" naming the login now names the person', byName['Nick Reed'].supervisor_name, 'Aaron Todd');

    // Aaron Todd and Amy Todd both answer to "atodd". Picking one would hand
    // one of them the other's role.
    assert('  a login two people answer to is left alone', !matched.atodd && unmatched.includes('atodd') && byName.atodd && byName.atodd.login === true);
    assert('  so neither of them is made a supervisor by it', !byName['Amy Todd'].is_supervisor);
    assert('  a login nobody answers to stays in the list, marked', unmatched.includes('travissteve') && byName.travissteve.login === true);
    assert('  and keeps its flag, so it is not lost', byName.travissteve.is_supervisor === true);
    assert('  a name that only looks like a login is a person', byName.brewernate && !byName.brewernate.login && !unmatched.includes('brewernate'));
    assert('  a username with a space in it is somebody’s full name, not a login row', byName['Ben Hudock'] && !byName['Ben Hudock'].login);
    assert('  the list is in name order', people.map(p => p.name).join('|') === people.map(p => p.name).sort((a, b) => a.localeCompare(b)).join('|'));
    assert('  the rows it was given are not changed', ROSTER.find(r => r.name === 'Aaron Todd').is_supervisor === false && !ROSTER.find(r => r.name === 'Aaron Todd').logins);

    const none = foldLoginRows(ROSTER, []);
    eq('  with no logins to go on, nothing folds', none.people.length, ROSTER.length);
  }

  console.log('\n[read from the database]');
  {
    const sql = recordingSql(text => {
      if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
      if (/SELECT username FROM users/.test(text)) return LOGINS.map(username => ({ username }));
      return [];
    });
    const { people, matched, unmatched } = await readPeopleRoster(sql, 'FCT');
    assert('  the logins are read for this company only', sql.calls.some(c => /SELECT username FROM users WHERE company_code = \?/.test(c.text) && c.values[0] === 'FCT'));
    assert('  and fold', matched.toddaaron === 'Aaron Todd' && !people.some(p => p.name === 'toddaaron'));
    // secretlogin and hudockben are logins with no row: nothing may name them.
    const out = JSON.stringify({ people, matched, unmatched });
    assert('  no login the roster does not already show is handed out', !/secretlogin|hudockben/.test(out));

    const broken = recordingSql(text => {
      if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
      if (/FROM users/.test(text)) throw new Error('relation "users" does not exist');
      return [];
    });
    const quiet = console.error; console.error = () => {};
    const fallback = await readPeopleRoster(broken, 'FCT');
    console.error = quiet;
    eq('  a failed read of the logins folds nothing — the list as it was', fallback.people.length, ROSTER.length);
  }

  console.log('\n[GET /api/employees]');
  {
    const call = async (query) => {
      CURRENT_SQL = recordingSql(text => {
        if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
        if (/SELECT username FROM users/.test(text)) return LOGINS.map(username => ({ username }));
        return [];
      });
      let body = null, status = 200;
      const res = { status(s) { status = s; return this; }, json(b) { body = b; return this; }, setHeader() {}, end() {} };
      await employeesHandler({ method: 'GET', query, body: {}, headers: {} }, res);
      return { status, body };
    };
    const plain = await call({});
    assert('  as stored by default, login rows included — Manage Users → Roles reads them',
      plain.status === 200 && plain.body.employees.some(e => e.name === 'toddaaron') && plain.body.employees.length === ROSTER.length);
    const people = await call({ view: 'people' });
    assert('  ?view=people returns each person once', people.body.employees.length === ROSTER.length - 11 && !people.body.employees.some(e => e.name === 'toddaaron'));
    assert('  with the pairs and the logins it could not place', people.body.matched.toddaaron === 'Aaron Todd' && people.body.unmatched.includes('travissteve'));
  }

  console.log('\n[the Scheduler board]');
  {
    const sql = recordingSql(text => {
      if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
      if (/SELECT username FROM users/.test(text)) return LOGINS.map(username => ({ username }));
      if (/FROM timesheet_entries te/.test(text)) {
        return [
          { work_date: '2026-10-01', status: 'approved', time_off_type: 'PTO', time_off_hours: 8, name: 'toddaaron' },
          { work_date: '2026-10-02', status: 'submitted', time_off_type: 'PTO', time_off_hours: 8, name: 'toddaaron' },
          { work_date: '2026-10-02', status: 'approved', time_off_type: 'PTO', time_off_hours: 8, name: 'Aaron Todd' },
        ];
      }
      return [];
    });
    const quietW = console.warn; console.warn = () => {};
    const board = await buildBoard(sql, 'FCT', '2026-09-28');
    console.warn = quietW;
    const names = board.employees.map(e => e.name);
    assert('  the crew list has each person once', names.includes('Aaron Todd') && !names.includes('toddaaron') && new Set(names).size === names.length);
    eq('  and counts them once', board.employees.length, ROSTER.length - 11);
    const aaron = board.employees.find(e => e.name === 'Aaron Todd');
    assert('  a folded person is grouped by the login’s role', aaron.isSupervisor === true);
    assert('  a login nobody answers to is sent marked', board.employees.find(e => e.name === 'travissteve').login === true);
    assert('  a person is not', aaron.login === undefined);
    eq('  the pairs ride along for the page', board.loginNames.toddaaron, 'Aaron Todd');
    assert('  and the logins it could not place', board.unmatchedLogins.includes('travissteve') && board.unmatchedLogins.includes('atodd'));
    assert('  time off filed under the login reaches the person', board.timeOff['Aaron Todd'] && board.timeOff['Aaron Todd']['2026-10-01'] && board.timeOff['Aaron Todd']['2026-10-01'].status === 'approved');
    eq('  where both have the day, the approved one stands', board.timeOff['Aaron Todd']['2026-10-02'].status, 'approved');
    assert('  and the login keeps its own, for bookings still under that name', !!(board.timeOff.toddaaron && board.timeOff.toddaaron['2026-10-01']));
  }

  console.log('\n[bookings under a login name move only from the review]');
  {
    const HELPERS = sliceSource(SCHED, 'const esc = s =>', '// "06:30"', 'the page helpers', 'function shortDate(');
    const sandbox = {
      console, saves: 0, crewSaves: 0, toasts: [], renders: 0, closed: 0,
      state: {
        board: { loginNames: { toddaaron: 'Aaron Todd', beckerbob: 'Bob Becker Jr.' }, unmatchedLogins: ['travissteve'],
                 employees: [{ name: 'Aaron Todd' }, { name: 'Bob Becker Jr.' }, { name: 'travissteve', login: true }], equipment: ['Roller 2'] },
        assignments: {
          '2026-09-28': [
            { id: 'a1', resource: 'toddaaron',  kind: 'emp', division: 'turf', jobId: 't1', jobName: 'Haymaker', costCode: '' },
            { id: 'a2', resource: 'Aaron Todd', kind: 'emp', division: 'turf', jobId: 't1', jobName: 'Haymaker', costCode: '' },
            { id: 'a3', resource: 'Roller 2', kind: 'equip', op: 'toddaaron', division: 'turf', jobId: 't1', jobName: 'Haymaker', costCode: '' },
            { id: 'h1', resource: 'beckerbob', kind: 'emp', division: 'trucking', jobId: 'c1', jobName: 'Haul', src: 'trucking' },
          ],
          '2026-09-29': [
            { id: 'a4', resource: 'toddaaron', kind: 'emp', division: 'turf', jobId: 't2', jobName: 'Softball', costCode: '' },
          ],
        },
        crews: [{ id: 'c1', name: 'Haymaker crew', members: [{ name: 'toddaaron', kind: 'emp' }, { name: 'Aaron Todd', kind: 'emp' }, { name: 'Roller 2', kind: 'equip' }] }],
      },
    };
    sandbox.pushUndo = () => { sandbox._undo.push('snap'); };
    sandbox.updateUndoButtons = () => {};
    sandbox.saveAssignments = () => { sandbox.saves++; };
    sandbox.saveCrews = () => { sandbox.crewSaves++; };
    sandbox.closeLoginReview = () => { sandbox.closed++; };
    sandbox.closeMoreMenu = () => {};
    sandbox.render = () => { sandbox.renders++; };
    sandbox.toast = m => { sandbox.toasts.push(m); };
    sandbox.railLoadPill = () => '';
    sandbox.weekDateStrs = () => ['2026-09-28', '2026-09-29'];
    vm.createContext(sandbox);
    vm.runInContext('var _undo = [];', sandbox);
    evalSlice(HELPERS, sandbox, 'the page helpers', { filename: 'scheduler.html' });
    vm.runInContext('var user = null;', sandbox);
    ['isForeign', 'loginNames', 'loginNameUses', 'loginUseCount', 'canMatchLogins', 'loginReviewHtml', 'moveLoginBookings', 'offRoster',
     'stripSubCodes', 'dedupeAssignmentMap', 'railRow'].forEach(n => vm.runInContext(requireFn(SCHED, n, 'scheduler.html'), sandbox, { filename: 'scheduler.html' }));

    eq('  bookings under a login are counted, the operator of a machine too — and saved crews apart from them',
      sandbox.loginNameUses(), { toddaaron: { bookings: 3, crews: 1 } });
    assert('  a haul under a login is Trucking’s and is not counted', !sandbox.loginNameUses().beckerbob);

    const review = sandbox.loginReviewHtml();
    assert('  the review shows every pair', /toddaaron<\/span> → <strong>Aaron Todd<\/strong>/.test(review) && /beckerbob<\/span> → <strong>Bob Becker Jr\.<\/strong>/.test(review), review);
    assert('  with what each login still has, a saved crew never called a booking', /3 bookings, 1 saved crew under the login/.test(review), review);
    assert('  and the total, the same way', /3 bookings and 1 saved-crew place are still under a login name/.test(review), review);
    assert('  the logins it could not place', /Not matched \(1\)/.test(review) && /travissteve/.test(review), review);
    assert('  and offers to move them, nothing moved yet', /moveLoginBookings\(\)/.test(review) && sandbox.state.assignments['2026-09-28'][0].resource === 'toddaaron');

    sandbox.moveLoginBookings();
    const day1 = sandbox.state.assignments['2026-09-28'];
    assert('  moving puts the employee’s name on the bookings', sandbox.state.assignments['2026-09-29'][0].resource === 'Aaron Todd');
    eq('  both names on one job, one day become one booking', day1.filter(a => a.resource === 'Aaron Todd' && a.kind === 'emp').length, 1);
    eq('  a machine’s operator moves too', day1.find(a => a.kind === 'equip').op, 'Aaron Todd');
    eq('  a haul is left under Trucking’s name', day1.find(a => a.src).resource, 'beckerbob');
    eq('  a saved crew holding both names now holds the person once', sandbox.state.crews[0].members.map(m => m.name), ['Aaron Todd', 'Roller 2']);
    assert('  one undo step, one save of each', sandbox._undo.length === 1 && sandbox.saves === 1 && sandbox.crewSaves === 1);
    assert('  and it says so', /Moved 3 bookings and 1 saved-crew place to employee names · Ctrl\+Z to undo/.test(sandbox.toasts[0]), sandbox.toasts[0]);
    eq('  nothing is left under a login name', sandbox.loginUseCount('bookings') + sandbox.loginUseCount('crews'), 0);
    assert('  and the review says so', /No bookings or saved crews are under a login name/.test(sandbox.loginReviewHtml()));

    sandbox.moveLoginBookings();
    assert('  moving again with nothing to move leaves no undo step behind', sandbox._undo.length === 1 && /Nothing is under a login name/.test(sandbox.toasts[1]));

    const rail = sandbox.railRow('travissteve', 'emp', 'Supervisor', false, true);
    assert('  a login nobody answers to is marked in the crew list', /class="rail-login"/.test(rail) && /a login, not matched to an employee/.test(rail), rail);
    assert('  a person is not', !/rail-login/.test(sandbox.railRow('Aaron Todd', 'emp', 'Supervisor', false, false)));

    const board = requireFn(SCHED, 'renderJobBoard', 'scheduler.html');
    assert('  the board note does not count a login name as a stranger', /stray\.emps = stray\.emps\.filter\(n => !logins\[n\]\)/.test(board));
    assert('  and counts bookings only — a saved crew is not a booking', /const nLogin = loginUseCount\('bookings'\)/.test(board));
    assert('  it points at the review instead', /under a login name, not the employee/.test(board) && /openLoginReview\(\)/.test(board));
    const exported = /Object\.assign\(window, \{([^}]*)\}/.exec(SCHED.replace(/\n/g, ' '));
    assert('  the review is reachable from the markup', exported && ['openLoginReview', 'closeLoginReview', 'moveLoginBookings'].every(n => new RegExp('\\b' + n + '\\b').test(exported[1])));
  }

  console.log('\n[an admin’s answer beats the name]');
  {
    const links = {
      toddaaron:   { person: 'Amy Todd' },      // the name points at Aaron; an admin says Amy
      atodd:       { person: 'Aaron Todd' },    // two people answer to it; an admin picks one
      travissteve: { none: true },              // an office login with a role
      stewartken:  { person: 'Nobody Here' },   // somebody no longer on the roster
    };
    const { people, matched, unmatched, manual, offCrew, guesses } = foldLoginRows(ROSTER, LOGINS, links);
    const byName = Object.fromEntries(people.map(p => [p.name, p]));
    eq('  a login goes to the person an admin chose, not the one its name points at', matched.toddaaron, 'Amy Todd');
    assert('  who takes on its role', byName['Amy Todd'].is_supervisor === true);
    eq('  the name’s own guess is still reported, for the screen that overrides it', guesses.toddaaron, 'Aaron Todd');
    eq('  a login two people answer to goes where the admin says', matched.atodd, 'Aaron Todd');
    eq('  and its guess says why it needed saying', guesses.atodd, null);
    eq('  both are marked as matched by hand', manual.slice().sort(), ['atodd', 'toddaaron']);
    assert('  a login an admin says is nobody on the crew is off the crew',
      offCrew.includes('travissteve') && !unmatched.includes('travissteve') && !matched.travissteve);
    assert('  but still in the list of people, marked, so the directory keeps its number',
      byName.travissteve && byName.travissteve.offCrew === true && byName.travissteve.login === true);
    eq('  an answer naming somebody no longer on the roster falls back to the name', matched.stewartken, 'Ken Stewart');
    assert('  and is not counted as matched by hand', !manual.includes('stewartken'));
    eq('  each login goes to one person only', byName['Aaron Todd'].logins, ['atodd']);
  }

  console.log('\n[an answer is written one login at a time]');
  {
    const sql = recordingSql();
    await writeLoginLink(sql, 'FCT', 'ToddAaron', { person: 'Amy Todd' });
    const set = sql.calls[0];
    assert('  into this company’s row', set.values.includes('FCT:fct_login_links'));
    assert('  under the login, lowercased', set.values.includes('toddaaron'));
    assert('  with the answer as JSON', set.values.includes(JSON.stringify({ person: 'Amy Todd' })));
    assert('  merged into the entries already there, never written over them',
      /ON CONFLICT \(key\) DO UPDATE/.test(set.text) && /\|\| jsonb_build_object\(\?::text, \?::jsonb\)/.test(set.text), set.text);
    await writeLoginLink(sql, 'FCT', 'toddaaron', null);
    const clear = sql.calls[1];
    assert('  going back to the name removes just that entry',
      /^UPDATE app_data/.test(clear.text) && /- \?::text/.test(clear.text) && clear.values.includes('toddaaron'), clear.text);
    const read = await readLoginLinks(recordingSql(() => [{ value: { links: ['not', 'an', 'object'] } }]), 'FCT');
    eq('  a row in the wrong shape reads as no answers', read, {});
  }

  console.log('\n[PATCH /api/employees?login=]');
  {
    const baseReply = text => {
      if (/SELECT username FROM users WHERE company_code = \? AND LOWER\(username\) = LOWER\(\?\)/.test(text)) return [{ username: 'toddaaron' }];
      if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
      if (/SELECT username FROM users/.test(text)) return LOGINS.map(username => ({ username }));
      return [];
    };
    const call = async (auth, query, body, reply) => {
      NEXT_AUTH = auth;
      CURRENT_SQL = recordingSql(reply || baseReply);
      let out = null, status = 200;
      const res = { status(s) { status = s; return this; }, json(b) { out = b; return this; }, setHeader() {}, end() {} };
      await employeesHandler({ method: 'PATCH', query, body, headers: {} }, res);
      NEXT_AUTH = ADMIN;
      return { status, out, sql: CURRENT_SQL };
    };
    const writes = r => r.sql.calls.filter(c => /app_data/.test(c.text) && !/SELECT value FROM app_data/.test(c.text));

    const field = await call(FIELD, { login: 'toddaaron' }, { person: 'Amy Todd' });
    assert('  only an admin can say who a login is', field.status === 403 && writes(field).length === 0);
    const nobody = await call(ADMIN, { login: 'nosuchlogin' }, { person: 'Amy Todd' }, () => []);
    assert('  a login that is not the company’s is refused', nobody.status === 404 && writes(nobody).length === 0);
    const stranger = await call(ADMIN, { login: 'toddaaron' }, { person: 'Somebody Else' });
    assert('  a person not on the roster is refused, not stored and ignored', stranger.status === 400 && writes(stranger).length === 0, JSON.stringify(stranger.out));
    const loginAsPerson = await call(ADMIN, { login: 'toddaaron' }, { person: 'strickallen' });
    assert('  and so is another login in a person’s place', loginAsPerson.status === 400 && writes(loginAsPerson).length === 0);
    const ok = await call(ADMIN, { login: 'TODDAARON' }, { person: 'amy todd' });
    assert('  a person on the roster is saved, under the login as the account spells it',
      ok.status === 200 && ok.out.ok && ok.out.login === 'toddaaron' && writes(ok).length === 1 && writes(ok)[0].values.includes('toddaaron'), JSON.stringify(ok.out));
    eq('  with the name as the roster spells it', ok.out.link, { person: 'Amy Todd' });
    const none = await call(ADMIN, { login: 'toddaaron' }, { none: true });
    assert('  "not on the crew" is saved as such', none.status === 200 && writes(none)[0].values.includes(JSON.stringify({ none: true })));
    const back = await call(ADMIN, { login: 'toddaaron' }, { person: null });
    assert('  and going back to the name clears the entry', back.status === 200 && /^UPDATE app_data/.test(writes(back)[0].text) && back.out.link === null);
    const flags = await call(ADMIN, { name: 'Aaron Todd' }, { phone: '814-555-0100' }, () => [{ id: 1, name: 'Aaron Todd', phone: '814-555-0100' }]);
    assert('  a PATCH by name is still the contact card, untouched', flags.status === 200 && flags.out.ok && writes(flags).length === 0);
  }

  console.log('\n[the board and the directory follow the answers]');
  {
    const reply = (text, values) => {
      if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
      if (/SELECT username FROM users/.test(text)) return LOGINS.map(username => ({ username }));
      if (/SELECT value FROM app_data WHERE key = \?/.test(text) && values[0] === 'FCT:fct_login_links') {
        return [{ value: { links: { travissteve: { none: true }, atodd: { person: 'Amy Todd' } } } }];
      }
      return [];
    };
    const quietW = console.warn; console.warn = () => {};
    const board = await buildBoard(recordingSql(reply), 'FCT', '2026-09-28');
    console.warn = quietW;
    assert('  a login off the crew is off the crew list', !board.employees.some(e => e.name === 'travissteve') && board.offCrewLogins.includes('travissteve'));
    assert('  a login matched by hand is folded, and says so', board.loginNames.atodd === 'Amy Todd' && board.manualLogins.includes('atodd'));
    eq('  the guesses ride along for the screen', board.loginGuesses.toddaaron, 'Aaron Todd');
    CURRENT_SQL = recordingSql(reply);
    let dir = null;
    await employeesHandler({ method: 'GET', query: { view: 'people' }, body: {}, headers: {} },
      { status() { return this; }, json(b) { dir = b; return this; }, setHeader() {}, end() {} });
    const steve = dir.employees.find(e => e.name === 'travissteve');
    assert('  the directory keeps a login that is off the crew, marked', steve && steve.offCrew === true && dir.offCrew.includes('travissteve'));
  }

  console.log('\n[the Login names screen lets an admin choose]');
  {
    const HELPERS = sliceSource(SCHED, 'const esc = s =>', '// "06:30"', 'the page helpers', 'function shortDate(');
    const calls = [];
    const sb = {
      console, toasts: [], refreshed: 0, redrawn: 0, overlayOpen: true,
      state: {
        board: {
          employees: [{ name: 'Aaron Todd' }, { name: 'Amy Todd' }, { name: 'Nick Reed' }, { name: 'brewer', login: true }],
          loginNames: { toddaaron: 'Aaron Todd', atodd: 'Amy Todd' }, manualLogins: ['atodd'],
          unmatchedLogins: ['brewer'], offCrewLogins: ['travissteve'],
          loginGuesses: { toddaaron: 'Aaron Todd', atodd: null, brewer: null, travissteve: null },
        },
        assignments: {}, crews: [],
      },
    };
    sb.api = async (url, opts) => { calls.push({ url, opts }); if (sb.failNext) { sb.failNext = false; throw new Error('Company admin access required'); } return { ok: true }; };
    sb.refreshData = async () => { sb.refreshed++; };
    sb.openLoginReview = () => { sb.redrawn++; };
    sb.toast = m => { sb.toasts.push(m); };
    sb.document = { getElementById: id => (id === 'loginsOverlay' && sb.overlayOpen ? {} : null) };
    vm.createContext(sb);
    vm.runInContext('var user = { role: "admin" };', sb);
    evalSlice(HELPERS, sb, 'the page helpers', { filename: 'scheduler.html' });
    // requireFn lifts from the word "function", so an async one needs its keyword back.
    ['isForeign', 'loginNames', 'loginNameUses', 'loginUseCount', 'canMatchLogins', 'loginReviewHtml', 'setLoginMatch']
      .forEach(n => vm.runInContext((n === 'setLoginMatch' ? 'async ' : '') + requireFn(SCHED, n, 'scheduler.html'), sb, { filename: 'scheduler.html' }));

    const html = sb.loginReviewHtml();
    const selectFor = l => (new RegExp('<select class="login-pick" data-login="' + l + '"[\\s\\S]*?</select>').exec(html) || [''])[0];
    eq('  every login gets a choice', (html.match(/<select class="login-pick"/g) || []).length, 4);
    assert('  a login the name placed shows what the name says, chosen', /<option value="" selected>Automatic: Aaron Todd<\/option>/.test(selectFor('toddaaron')), selectFor('toddaaron'));
    assert('  one an admin placed shows that person chosen, and is marked by hand',
      /<option value="p:Amy Todd" selected>Amy Todd<\/option>/.test(selectFor('atodd')) && /by hand/.test(html), selectFor('atodd'));
    assert('  one nobody answers to says so', /<option value="" selected>Automatic: no match<\/option>/.test(selectFor('brewer')));
    assert('  one off the crew is listed as such, with that chosen',
      /Not on the crew list \(1\)/.test(html) && /<option value="none" selected>Not on the crew list<\/option>/.test(selectFor('travissteve')));
    assert('  the people to choose from are employees, never another login',
      /value="p:Nick Reed"/.test(selectFor('toddaaron')) && !/value="p:brewer"/.test(selectFor('toddaaron')));

    vm.runInContext('user = { role: "level1" };', sb);
    const readOnly = sb.loginReviewHtml();
    assert('  anyone else sees the answers, with nothing to change', !/<select/.test(readOnly) && /<strong>Aaron Todd<\/strong>/.test(readOnly) && /Only an admin can change who a login is/.test(readOnly));
    vm.runInContext('user = { role: "admin" };', sb);

    const pickAs = async v => { calls.length = 0; const el = { dataset: { login: 'toddaaron' }, value: v, disabled: false }; await sb.setLoginMatch(el); return el; };
    const chose = await pickAs('p:Amy Todd');
    assert('  choosing a person saves it for that login', calls[0].url === '/api/employees?login=toddaaron' && calls[0].opts.method === 'PATCH' && calls[0].opts.body === JSON.stringify({ person: 'Amy Todd' }));
    assert('  then reads the board again and redraws the screen', sb.refreshed === 1 && sb.redrawn === 1 && chose.disabled === true);
    eq('  and says what it did', sb.toasts[sb.toasts.length - 1], 'toddaaron is Amy Todd');
    await pickAs('none');
    eq('  "not on the crew list" saves as such', calls[0].opts.body, JSON.stringify({ none: true }));
    await pickAs('');
    eq('  "automatic" goes back to the name', calls[0].opts.body, JSON.stringify({ person: null }));
    sb.failNext = true;
    const refreshedBefore = sb.refreshed, redrawnBefore = sb.redrawn;
    await pickAs('p:Nick Reed');
    assert('  a refused save says so and redraws the stored answer, reading nothing',
      /Could not save: Company admin access required/.test(sb.toasts[sb.toasts.length - 1]) && sb.refreshed === refreshedBefore && sb.redrawn === redrawnBefore + 1,
      JSON.stringify({ toast: sb.toasts[sb.toasts.length - 1], refreshed: sb.refreshed - refreshedBefore, redrawn: sb.redrawn - redrawnBefore }));
    const exported = /Object\.assign\(window, \{([^}]*)\}/.exec(SCHED.replace(/\n/g, ' '));
    assert('  the choice is reachable from the markup', exported && /\bsetLoginMatch\b/.test(exported[1]));
  }

  console.log('\n[the Team Directory]');
  {
    assert('  reads people, not login rows', /fetch\('\/api\/employees\?view=people'/.test(DIVS));
    assert('  Manage Users → Roles still reads the rows as stored', /fetch\('\/api\/employees',\s+\{ headers/.test(DIVS));
    const save = requireFn(DIVS, 'dirSave', 'divisions.html');
    assert('  a saved card goes onto the person’s logins too, so a cleared number stays cleared',
      /for \(const login of \(card && card\.logins\) \|\| \[\]\)/.test(save) && /JSON\.stringify\(\{ phone, email, supervisor_name: sup \}\)/.test(save));
    assert('  and only the card: no role flag is sent to a login', !/is_supervisor|is_driver/.test(save));
    assert('  a login name still finds its person in the search', /\.\.\.\(e\.logins \|\| \[\]\)/.test(DIVS));
  }

  console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
