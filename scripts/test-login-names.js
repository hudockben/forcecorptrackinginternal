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
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => CURRENT_SQL };
  if (request === './lib/auth' || request === '../lib/auth') {
    return {
      requireAuth: () => ({ companyCode: 'FCT', userId: 1, username: 'hudockben', role: 'admin', isPlatformAdmin: true }),
      hasDivisionAccess: () => true,
      requireDivision: () => null,
      payrollAccess: () => ({ canCode: true, canApprove: true, isCoder: false }),
    };
  }
  return origLoad.apply(this, arguments);
};

const ROOT = path.resolve(__dirname, '..');
const { foldLoginRows, loginKeysFor, loginKey, readPeopleRoster, readEmployeeRoster } = require(path.join(ROOT, 'api', 'lib', 'roster'));
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
    ['isForeign', 'loginNames', 'loginNameUses', 'loginUseCount', 'loginReviewHtml', 'moveLoginBookings', 'offRoster',
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
