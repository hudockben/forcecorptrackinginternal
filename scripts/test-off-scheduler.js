#!/usr/bin/env node
'use strict';
/**
 * Kept off the Scheduler: who an admin says cannot be sent to a job.
 *
 * Run: node scripts/test-off-scheduler.js
 *
 * The Scheduler's crew panel offered everybody on the roster, and not
 * everybody on the roster can be sent to a job: office staff whose logins are
 * flagged Supervisor so they can approve a timesheet, crew back at college. An
 * admin now switches them off, person by person, in Manage Users → Scheduler,
 * and the crew list is that much shorter. Pinned below:
 *
 * THE LIST. Kept per PERSON — the name the Scheduler shows — not per login and
 * not on an employees row, so a login folded into its person is covered by the
 * person, and somebody only on a division's list is kept off without a row
 * being made for them. Opt-out: nobody is off until an admin says so, and a
 * failed read keeps nobody off.
 *
 * WHO MAY SAY IT. Admins, through PATCH /api/employees?scheduler=, and only of
 * somebody on the crew list.
 *
 * THE BOARD. The crew list leaves them off; they ride along apart, so a day
 * already booked for one of them is theirs, not a stranger's.
 *
 * THE PAGE. Nothing offers them — the panel, the picker, the counts. Nothing
 * books them — a saved crew, Copy week, a division's plan, a drag. What is
 * already booked is shown, said, and can be taken off or handed to somebody
 * else, never moved or repeated.
 *
 * MANAGE USERS. The switch itself: one row a person, the list the Scheduler
 * reads, and a switch that goes back if the save does not land.
 *
 * No DB, server or browser required: the neon driver and the auth module are
 * stubbed, and the pages run in jsdom. The statements themselves are run
 * against a real Postgres by scripts/test-off-scheduler-sql.js.
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');
const { JSDOM, VirtualConsole } = require('jsdom');

let CURRENT_SQL = null;
const ADMIN = { companyCode: 'FCT', userId: 1, username: 'hudockben', role: 'admin', isPlatformAdmin: false };
const FIELD = { companyCode: 'FCT', userId: 9, username: 'strickallen', role: 'level2', isPlatformAdmin: false };
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
const roster = require(path.join(ROOT, 'api', 'lib', 'roster'));
const { readPeopleRoster, markOffScheduler, readOffScheduler, writeOffScheduler, offSchedulerKey } = roster;
const employeesHandler = require(path.join(ROOT, 'api', 'employees.js'));
const { buildBoard } = require(path.join(ROOT, 'api', 'scheduler', 'board.js'));
const { requireFn } = require(path.join(__dirname, 'lib', 'fn-source.js'));
const SCHED = fs.readFileSync(path.join(ROOT, 'scheduler.html'), 'utf8');
const DIVS  = fs.readFileSync(path.join(ROOT, 'divisions.html'), 'utf8');
const DIVS_SCRIPT = DIVS.slice(DIVS.indexOf('<script>') + 8, DIVS.lastIndexOf('</script>'));
const DATA_KEY = fs.readFileSync(path.join(ROOT, 'api', 'data', '[key].js'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + String(detail).slice(0, 300) : ''}`); }
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

// Crew, an office login flagged Supervisor, a college kid, and a login folded
// into its person.
const ROSTER = [
  row('Aaron Todd', { job_class: 'Foreman' }), row('toddaaron', { is_supervisor: true }),
  row('Blake Hostetler', { job_class: 'Laborer' }),
  row('Colton Reed', { job_class: 'Operator' }),
  row('Zach Brewer', { job_class: 'Laborer' }),
  row('reeferscott', { is_supervisor: true }),       // nobody on the roster answers to it
  row('travissteve', { is_supervisor: true }),       // an admin said: not on the crew list
];
const LOGINS = ['toddaaron', 'reeferscott', 'travissteve', 'hudockben'];
const LINKS  = { travissteve: { none: true } };

/** The database as the roster reads it, with `off` as the stored answers. */
function rosterSql(off, extra) {
  return recordingSql((text, values) => {
    if (/FROM employees WHERE/.test(text)) return ROSTER.map(r => ({ ...r }));
    if (/SELECT username FROM users/.test(text)) return LOGINS.map(username => ({ username }));
    if (/SELECT value FROM app_data WHERE key = \?/.test(text)) {
      if (values[0] === 'FCT:fct_login_links') return [{ value: { links: LINKS } }];
      if (values[0] === offSchedulerKey('FCT')) {
        if (off instanceof Error) throw off;
        return off ? [{ value: { people: off } }] : [];
      }
    }
    return extra ? extra(text, values) : [];
  });
}
const OFF = { 'zach brewer': { at: '2026-09-29T12:00:00.000Z', by: 'hudockben' },
              reeferscott:   { at: '2026-09-29T12:00:00.000Z', by: 'hudockben' } };

async function patch(query, body, auth, sql) {
  NEXT_AUTH = auth;
  CURRENT_SQL = sql;
  let status = 200, out = null;
  const res = { status(s) { status = s; return this; }, json(b) { out = b; return this; }, setHeader() {}, end() {} };
  await employeesHandler({ method: 'PATCH', query, body: body || {}, headers: {} }, res);
  return { status, body: out };
}

// ── The Scheduler, running ──────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const ds  = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
// The board draws from today forward, so the fixture moves with it.
const TODAY = new Date();
const D1 = ds(TODAY);
const D2 = (() => { const x = new Date(TODAY); x.setDate(x.getDate() + 1); return ds(x); })();

const ZACH_AID = 'z1', EQUIP_AID = 'z2';
function boardPayload(opts = {}) {
  return {
    generatedAt: new Date().toISOString(),
    employees: [
      { name: 'Aaron Todd', jobClass: 'Foreman', isSupervisor: true, isDriver: false },
      { name: 'Blake Hostetler', jobClass: 'Laborer', isSupervisor: false, isDriver: false },
      { name: 'Colton Reed', jobClass: 'Operator', isSupervisor: false, isDriver: false },
    ],
    // What an older API build sends is no field at all.
    ...(opts.noOffField ? {} : { offScheduler: [
      { name: 'reeferscott', jobClass: '', isSupervisor: true, isDriver: false, login: true },
      { name: 'Zach Brewer', jobClass: 'Laborer', isSupervisor: false, isDriver: false },
    ] }),
    equipment: ['T-14'],
    jobs: [
      { division: 'turf', id: 'j1', name: 'Riverbend', jobNumber: '26001', status: 'Active', bidValue: 1, deadline: null,
        subCodes: [{ key: '3100||', costCode: '3100', subCode: '', description: 'Fine grade', status: 'on-track', bidQty: 10, runningQty: 1, pctComplete: 10, crew: [], equipment: [] }] },
      { division: 'paving', id: 'j2', name: 'Mill Street', jobNumber: '26002', status: 'Active', bidValue: 1, deadline: null,
        subCodes: [{ key: '420||', costCode: '420', subCode: '', description: 'Paving', status: 'on-track', bidQty: 10, runningQty: 1, pctComplete: 10, crew: [], equipment: [] }] },
    ],
    plannedAssignments: [
      { date: D2, resource: 'Zach Brewer', kind: 'emp', division: 'turf', jobId: 'j1', jobName: 'Riverbend', costCode: '3100', subCode: '', half: false },
      { date: D2, resource: 'Blake Hostetler', kind: 'emp', division: 'turf', jobId: 'j1', jobName: 'Riverbend', costCode: '3100', subCode: '', half: false },
    ],
    timeOff: {}, excludedJobs: 0, truckingAssignments: {},
    loginNames: {}, unmatchedLogins: [], manualLogins: [], offCrewLogins: [], loginGuesses: {},
    sourceDivisions: ['turf', 'paving', 'kiewit', 'dust', 'ees', 'trucking'],
    projectDivisions: ['turf', 'paving', 'kiewit'],
  };
}
// Zach was booked on Riverbend today, with the truck Zach runs, before an
// admin switched Zach off.
const SAVED = () => ({ version: 1, siteTimes: {}, assignments: { [D1]: [
  { id: ZACH_AID,  resource: 'Zach Brewer', kind: 'emp',   division: 'turf', jobId: 'j1', jobName: 'Riverbend', costCode: '', half: false },
  { id: EQUIP_AID, resource: 'T-14', kind: 'equip', op: 'Zach Brewer', division: 'turf', jobId: 'j1', jobName: 'Riverbend', costCode: '', half: false },
] } });
const CREWS = () => ({ version: 1, crews: [{ id: 'cA', name: 'Turf A', members: [{ name: 'Blake Hostetler', kind: 'emp' }, { name: 'Zach Brewer', kind: 'emp' }] }] });

const SESSION = { fct_token: 'harness', fct_division: 'turf',
  fct_user: JSON.stringify({ userId: 1, username: 'harness', companyCode: 'FCT', isPlatformAdmin: true,
                             divisionRoles: { turf: 'level5', scheduler: 'level5' } }) };
const SCHED_HTML = SCHED;

/** scheduler.html, booted, with every write it attempts captured. */
function bootScheduler(opts = {}) {
  const errors = [], writes = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/i.test(e.message || '')) errors.push(e.message); });
  const dom = new JSDOM(SCHED_HTML, {
    runScripts: 'dangerously', url: 'https://datawatch.app/scheduler.html', virtualConsole: vc,
    beforeParse(w) {
      Object.entries(SESSION).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.fetch = (url, o) => {
        const u = String(url), req = o || {};
        if (req.method && req.method !== 'GET') writes.push({ url: u, body: req.body });
        const data = u.includes('/api/scheduler/board') ? boardPayload(opts)
                   : u.includes('fct_scheduler_assignments') ? { value: SAVED() }
                   : u.includes('fct_scheduler_crews')       ? { value: CREWS() }
                   : u.includes('/api/data/')                ? { value: null }
                   : { ok: true };
        return Promise.resolve({ ok: true, status: 200, json: async () => data, text: async () => '' });
      };
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
      w.HTMLCanvasElement.prototype.getContext = () => null;
    },
  });
  const w = dom.window;
  const saved = () => writes.filter(x => x.url.includes('fct_scheduler_assignments')).map(x => JSON.parse(x.body).value);
  const lastSaved = () => { const s = saved(); return s.length ? s[s.length - 1].assignments : null; };
  const booked = (d, name) => (w.eval('state').assignments[d] || []).filter(a => a.resource === name || a.op === name);
  const toast = () => (w.document.getElementById('toast') || {}).textContent || '';
  const main = () => (w.document.getElementById('main') || {}).innerHTML || '';
  return { dom, w, errors, writes, saved, lastSaved, booked, toast, main };
}
// Long enough for loadAll() and the debounced save behind it.
const settle = () => new Promise(r => setTimeout(r, 900));

// ── Manage Users → Scheduler ────────────────────────────────────────────────
function slice(src, from, to, what) {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`could not find ${what} in divisions.html`);
  return src.slice(a, b);
}
/** The real markup and the real panel functions, over a stubbed fetch. */
function buildPanel(fetchImpl) {
  const dom = new JSDOM(DIVS, { runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(`var token = 'test-token'; var muActiveSubTab = 'users'; var supervisorsLoaded = true;`);
  w.fetch = fetchImpl;
  const esc = /function escHtml\(s\) \{[\s\S]*?\n {4}\}/.exec(DIVS_SCRIPT);
  if (!esc) throw new Error('could not find escHtml in divisions.html');
  const tabs = /const MU_SUBTABS = \{[^}]*\};/.exec(DIVS_SCRIPT);
  if (!tabs) throw new Error('could not find MU_SUBTABS in divisions.html');
  w.eval(esc[0] + '\n' + tabs[0].replace(/^const /, 'var ') + '\n' + requireFn(DIVS_SCRIPT, 'switchUserSubTab', 'divisions.html') + '\n'
    + 'function loadSupervisorList() {}\n'
    + slice(DIVS_SCRIPT, '// ── Scheduler sub-panel (inside Manage Users modal)', '// ── Excel export ─', 'the Scheduler sub-panel'));
  return { dom, w, doc: w.document };
}
const PEOPLE = [
  { name: 'Aaron Todd', job_class: 'Foreman', is_supervisor: true, is_driver: false, logins: ['toddaaron'] },
  { name: 'Blake Hostetler', job_class: 'Laborer', is_supervisor: false, is_driver: false },
  { name: 'reeferscott', job_class: null, is_supervisor: true, is_driver: false, login: true, offScheduler: true },
  { name: 'travissteve', job_class: null, is_supervisor: true, is_driver: false, login: true, offCrew: true },
  { name: 'Zach Brewer', job_class: 'Laborer', is_supervisor: false, is_driver: true, offScheduler: true },
];
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
  console.log('Kept off the Scheduler\n');

  console.log('[the list of people]');
  {
    const { people } = await readPeopleRoster(rosterSql(OFF), 'FCT');
    const byName = Object.fromEntries(people.map(p => [p.name, p]));
    assert('  somebody an admin switched off is marked', byName['Zach Brewer'].offScheduler === true);
    assert('  a login nobody answers to is marked under its own name', byName.reeferscott.offScheduler === true);
    assert('  and nobody else is', ['Aaron Todd', 'Blake Hostetler', 'Colton Reed'].every(n => byName[n].offScheduler === undefined));
    const again = await readPeopleRoster(rosterSql({ 'aaron todd': {} }), 'FCT');
    const aaron = again.people.find(p => p.name === 'Aaron Todd');
    assert('  a person is matched by name whatever the case, with their login folded in',
      aaron.offScheduler === true && (aaron.logins || []).includes('toddaaron') && !again.people.some(p => p.name === 'toddaaron'));
    const none = await readPeopleRoster(rosterSql(null), 'FCT');
    assert('  with nothing stored, nobody is off — opt-out, so nothing moves when this ships',
      none.people.every(p => p.offScheduler === undefined));
    const quiet = console.error; console.error = () => {};
    const broken = await readPeopleRoster(rosterSql(new Error('relation "app_data" is gone')), 'FCT');
    console.error = quiet;
    assert('  a failed read keeps nobody off, and the roster still comes back',
      broken.people.length === none.people.length && broken.people.every(p => p.offScheduler === undefined));
    const marked = markOffScheduler([{ name: 'Zach Brewer' }, { name: 'Zachary Brewer' }], { 'zach brewer': {} });
    eq('  a name is the whole name, not the start of one', marked.map(p => !!p.offScheduler), [true, false]);
    eq('  stored as an object only — anything else reads as nobody', await readOffScheduler(recordingSql(() => [{ value: { people: ['zach brewer'] } }]), 'FCT'), {});
  }

  console.log('\n[the write, in place]');
  {
    const sql = recordingSql();
    await writeOffScheduler(sql, 'FCT', '  Zach Brewer ', true, 'hudockben');
    const off = sql.calls[0];
    assert('  switching off is one upsert of one entry', /INSERT INTO app_data/.test(off.text) && /ON CONFLICT \(key\) DO UPDATE/.test(off.text) && /\|\| jsonb_build_object/.test(off.text), off.text);
    assert('  keyed by company', off.values[0] === 'FCT:fct_off_scheduler');
    assert('  and by the name, trimmed and lowercased', off.values.includes('zach brewer'), JSON.stringify(off.values));
    const said = JSON.parse(off.values.find(v => typeof v === 'string' && v.startsWith('{')));
    assert('  with who said it and when', said.by === 'hudockben' && !isNaN(Date.parse(said.at)), JSON.stringify(said));
    await writeOffScheduler(sql, 'FCT', 'Zach Brewer', false);
    const on = sql.calls[1];
    assert('  switching back on removes that entry and no other', /^UPDATE app_data SET/.test(on.text) && /- \?::text/.test(on.text) && on.values.includes('zach brewer'), on.text);
    assert('  the generic data endpoint does not take the key — only the admin PATCH writes it',
      !/fct_off_scheduler/.test(DATA_KEY) && !/^fct_scheduler/.test('fct_off_scheduler'));
  }

  console.log('\n[PATCH /api/employees?scheduler=]');
  {
    const field = await patch({ scheduler: 'Zach Brewer' }, { on: false }, FIELD, rosterSql(null));
    eq('  a scheduler who is not an admin cannot switch anyone off', field.status, 403);
    eq('  a name is required', (await patch({ scheduler: '  ' }, { on: false }, ADMIN, rosterSql(null))).status, 400);
    const vague = await patch({ scheduler: 'Zach Brewer' }, { on: 'no' }, ADMIN, rosterSql(null));
    assert('  "on" has to be true or false', vague.status === 400 && /true or false/.test(vague.body.error), JSON.stringify(vague.body));
    const stranger = await patch({ scheduler: 'Nobody Here' }, { on: false }, ADMIN, rosterSql(null));
    assert('  somebody not on the crew list is refused, and nothing is written',
      stranger.status === 400 && /not on the crew list/.test(stranger.body.error), JSON.stringify(stranger.body));
    const notCrew = await patch({ scheduler: 'travissteve' }, { on: false }, ADMIN, rosterSql(null));
    eq('  so is a login already said to be nobody on the crew', notCrew.status, 400);
    const sql = rosterSql(null);
    const ok = await patch({ scheduler: 'ZACH brewer' }, { on: false }, ADMIN, sql);
    assert('  an admin switches somebody off', ok.status === 200 && ok.body.ok === true && ok.body.on === false, JSON.stringify(ok.body));
    eq('  named as the roster spells the name', ok.body.name, 'Zach Brewer');
    const write = sql.calls.find(c => /INSERT INTO app_data/.test(c.text));
    assert('  saved under the person, by the admin who said it', !!write && write.values.includes('zach brewer') && write.values.some(v => /"by":"hudockben"/.test(String(v))));
    const backSql = recordingSql();
    const back = await patch({ scheduler: 'Somebody Since Renamed' }, { on: true }, ADMIN, backSql);
    assert('  switching back on needs no roster read, so an old entry can always be cleared',
      back.status === 200 && !backSql.calls.some(c => /FROM employees/.test(c.text)) && backSql.calls.some(c => /^UPDATE app_data/.test(c.text)));
  }

  console.log('\n[the board]');
  {
    const quiet = console.warn; console.warn = () => {};
    const board = await buildBoard(rosterSql(OFF), 'FCT', '2026-09-29');
    console.warn = quiet;
    const crew = board.employees.map(e => e.name);
    eq('  the crew list leaves them off', crew, ['Aaron Todd', 'Blake Hostetler', 'Colton Reed']);
    eq('  and they ride along apart', board.offScheduler.map(e => e.name), ['reeferscott', 'Zach Brewer']);
    eq('  in the crew list’s own shape', board.offScheduler.find(e => e.name === 'Zach Brewer'),
      { name: 'Zach Brewer', jobClass: 'Laborer', isSupervisor: false, isDriver: false });
    assert('  a login still says it is one', board.offScheduler.find(e => e.name === 'reeferscott').login === true);
    assert('  a login nobody is on the crew is in neither', !crew.includes('travissteve') && !board.offScheduler.some(e => e.name === 'travissteve'));
    console.warn = () => {};
    const plain = await buildBoard(rosterSql(null), 'FCT', '2026-09-29');
    const broken = await buildBoard(recordingSql(text => { if (/FROM employees WHERE/.test(text)) throw new Error('down'); return []; }), 'FCT', '2026-09-29');
    console.warn = quiet;
    assert('  with nobody switched off, everybody is on the list and nobody apart',
      plain.employees.length === 5 && plain.offScheduler.length === 0, JSON.stringify(plain.employees.map(e => e.name)));
    assert('  a roster that fails to load sends an empty list apart, not a missing one', Array.isArray(broken.offScheduler) && broken.offScheduler.length === 0);
  }

  console.log('\n[the Scheduler: nothing offers them]');
  {
    const p = bootScheduler(); await settle();
    assert('the page boots with nothing thrown', p.errors.length === 0, p.errors[0]);
    const rail = (p.w.document.getElementById('railList') || {}).innerHTML || '';
    assert('the crew panel lists the crew', ['Aaron Todd', 'Blake Hostetler', 'Colton Reed'].every(n => rail.includes(n)), rail.slice(0, 200));
    assert('  and not the people switched off', !rail.includes('Zach Brewer') && !rail.includes('reeferscott'));
    const tab = (p.w.document.getElementById('railTabCrew') || {}).textContent || '';
    assert('  and counts only the crew it offers', /\b3\b/.test(tab), tab);
    const main = p.main();
    const card = label => { const m = new RegExp('cap-val[^>]*>(\\d+)</div><div class="cap-lbl">' + label).exec(main); return m ? Number(m[1]) : null; };
    eq('Field crew counts who can be sent', card('Field crew'), 3);
    eq('Scheduled still counts Zach — Zach IS booked today', card('Scheduled'), 1);
    eq('Idle is the crew list with nothing booked, not crew less booked', card('Idle'), 3);
    assert('the board says how many are kept off, and where that was set', /2 people kept off the Scheduler in Manage Users/.test(main), main.slice(-1500));
    assert('  with their names on the note', /Switched off in Manage Users → Scheduler: reeferscott, Zach Brewer/.test(main));
    assert('and warns that one of them is booked today anyway', /1 booked this day is off the Scheduler/.test(main));
    eq('Zach is not called a stranger to the roster', p.w.eval('offRoster()').emps, []);
    assert('  so the board does not say anyone booked is off the roster', !/not on the roster/.test(main));
    p.w.openAssignJob('turf', 'j1', '', D1);
    const pick = (p.w.document.getElementById('pickList') || {}).innerHTML || '';
    assert('the assign dialog offers the crew', pick.includes('Blake Hostetler'), pick.slice(0, 200));
    assert('  and not the people switched off', !pick.includes('Zach Brewer') && !pick.includes('reeferscott'));
    p.w.closeAssign();
    eq('nothing was saved just by looking', p.writes.length, 0);
    p.w.close();
  }

  console.log('\n[the Scheduler: nothing books them]');
  {
    const p = bootScheduler(); await settle();
    const riverbend = p.w.jobById('turf', 'j1');
    eq('the one door every booking goes through refuses Zach', p.w.placeOnJob(D2, riverbend, '', { resource: 'Zach Brewer', kind: 'emp' }), 'kept');
    eq('  and still takes a machine', p.w.placeOnJob(D2, riverbend, '', { resource: 'T-14', kind: 'equip' }), 'added');

    p.w.crewDrop({ id: 'cA' }, { date: D2, division: 'turf', jobId: 'j1', costCode: '' });
    assert('a saved crew dropped on a day books the crew', p.booked(D2, 'Blake Hostetler').length === 1);
    eq('  and not the one switched off', p.booked(D2, 'Zach Brewer').length, 0);
    assert('  and says so', /Turf A → Riverbend .*\(1\) · 1 kept off the Scheduler/.test(p.toast()), p.toast());

    // The saved crews sit under the dialog's "more options".
    p.w.eval("state.assignCtx = { mode:'job', division:'paving', jobId:'j2', costCode:'', date:'" + D2 + "' }; state.moreOpts = true; renderModal();");
    const sel = p.w.document.getElementById('crewSel');
    if (sel) { sel.value = 'cA'; p.w.applyCrewFromPicker(); }
    assert('picking the saved crew in the dialog does the same',
      !!sel && p.booked(D2, 'Blake Hostetler').some(a => a.jobId === 'j2') && p.booked(D2, 'Zach Brewer').length === 0
      && /^Added Turf A \(1 assignment\) · 1 kept off the Scheduler$/.test(p.toast()), p.toast());
    p.w.closeAssign();

    p.w.importPlanned();
    assert('a division’s plan imports the crew', p.booked(D2, 'Blake Hostetler').some(a => a.costCode === '3100'));
    eq('  and not the one switched off', p.booked(D2, 'Zach Brewer').length, 0);
    assert('  and says so', /1 kept off the Scheduler/.test(p.toast()), p.toast());

    p.w.dropOnJobCell(D1, ZACH_AID, { date: D2, division: 'turf', jobId: 'j1', costCode: '' }, false);
    assert('Zach’s booking cannot be dragged to another day', p.booked(D1, 'Zach Brewer').length === 2 && p.booked(D2, 'Zach Brewer').length === 0);
    assert('  and the toast says why and what to do instead', /Zach Brewer is off the Scheduler .* right-click to take it off/.test(p.toast()), p.toast());
    p.w.dropOnJobCell(D1, EQUIP_AID, { date: D2, division: 'paving', jobId: 'j2', costCode: '' }, true);
    eq('  nor the machine Zach runs, copied on without Zach', p.booked(D2, 'T-14').filter(a => a.op === 'Zach Brewer').length, 0);
    p.w.personFill({ id: ZACH_AID, date: D1 }, { kind: 'job', date: D2, division: 'turf', jobId: 'j1', costCode: '' });
    eq('  nor repeated across the week with its grip', p.booked(D2, 'Zach Brewer').length, 0);
    p.w.dropOnResCell(D2, p.booked(D2, 'Blake Hostetler')[0].id, { date: D2, resource: 'Zach Brewer', rkind: 'emp' }, true);
    assert('work cannot be handed TO Zach', p.booked(D2, 'Zach Brewer').length === 0 && /Zach Brewer is off the Scheduler/.test(p.toast()), p.toast());
    p.w.openAssignResource('Zach Brewer', 'emp', D1);
    const modal = (p.w.document.getElementById('assignOverlay') || {}).innerHTML || '';
    assert('Zach’s own dialog shows what Zach is on, to take off', /Riverbend/.test(modal) && /removeAssignment\(/.test(modal), modal.slice(0, 300));
    assert('  and offers no job to put Zach on', !p.w.document.getElementById('rJob') && /nothing new is booked for them here/.test(modal));
    p.w.closeAssign();

    await settle();
    const saved = p.lastSaved() || {};
    const everZach = Object.entries(saved).filter(([d, rows]) => rows.some(a => a.resource === 'Zach Brewer' || a.op === 'Zach Brewer')).map(([d]) => d);
    eq('what reached the server books Zach on no new day', everZach, [D1]);
    p.w.close();
  }

  console.log('\n[the Scheduler: what is already booked can be covered]');
  {
    const p = bootScheduler(); await settle();
    p.w.dropOnResCell(D1, ZACH_AID, { date: D1, resource: 'Colton Reed', rkind: 'emp' }, false);
    assert('Zach’s day can be handed to somebody else', p.booked(D1, 'Colton Reed').some(a => a.resource === 'Colton Reed' && a.jobId === 'j1'));
    eq('  which takes it off Zach', p.booked(D1, 'Zach Brewer').length, 0);
    const truck = p.w.eval('state').assignments[D1].find(a => a.resource === 'T-14');
    eq('  and the machine goes with the work, to its new driver', truck && truck.op, 'Colton Reed');
    p.w.close();

    const q = bootScheduler(); await settle();
    q.w.eval("state.view = 'crew'; render();");
    const crewBoard = q.main();
    assert('By Crew lists Zach apart, under the reason', /⚠ Off the Scheduler/.test(crewBoard) && /Zach Brewer/.test(crewBoard) && /off the Scheduler<\/span>/.test(crewBoard), crewBoard.slice(-1200));
    assert('  and not among the crew, nor as a stranger to the roster', !/Not on the roster/.test(crewBoard));
    const toolbar = (q.w.document.getElementById('toolbar') || {}).innerHTML || '';
    assert('  the toolbar says how many are kept off', /3 crew · 1 equip · 2 off the Scheduler/.test(toolbar), toolbar.slice(0, 400));
    q.w.eval("state.view = 'job'; render();");
    q.w.copyWeekForward();
    await settle();
    const next = (() => { const x = new Date(TODAY); x.setDate(x.getDate() + 7); return ds(x); })();
    eq('Copy week → next does not carry Zach into next week', q.booked(next, 'Zach Brewer').length, 0);
    assert('  and says so rather than copying nothing in silence', /1 kept off the Scheduler/.test(q.toast()), q.toast());
    q.w.close();
  }

  console.log('\n[the Scheduler: an older API build]');
  {
    const p = bootScheduler({ noOffField: true }); await settle();
    assert('a board without the field boots', p.errors.length === 0, p.errors[0]);
    assert('  keeps nobody off and says nothing about it', !/kept off the Scheduler/.test(p.main()));
    eq('  and books as it always did', p.w.placeOnJob(D2, p.w.jobById('turf', 'j1'), '', { resource: 'Zach Brewer', kind: 'emp' }), 'added');
    p.w.close();
  }

  console.log('\n[Manage Users → Scheduler]');
  {
    const markup = new JSDOM(DIVS).window.document;
    const buttons = [...markup.querySelectorAll('.mu-subtabs .mu-subtab-btn')].map(b => b.textContent.trim());
    eq('the tab sits beside Users and Roles', buttons, ['Users', 'Roles', 'Scheduler']);
    const heads = [...markup.querySelectorAll('#mu-panel-scheduler thead th')].map(t => t.textContent.trim());
    eq('its table is a name and a switch', heads, ['Name', 'On the Scheduler']);
    assert('it is inside Manage Users, which only admins can open',
      !!markup.getElementById('mu-panel-scheduler') && !!markup.getElementById('mu-panel-scheduler').closest('#userModalBackdrop'));

    let sent = null, answer = { ok: true, status: 200, body: null };
    const fetchImpl = async (url, opts) => {
      if (opts && opts.method === 'PATCH') {
        sent = { url: String(url), body: JSON.parse(opts.body) };
        const body = answer.body || { ok: true, name: 'Zach Brewer', on: sent.body.on };
        return { ok: answer.ok, status: answer.status, json: async () => body };
      }
      return { ok: true, json: async () => ({ employees: PEOPLE }) };
    };
    const { w, doc } = buildPanel(fetchImpl);
    w.eval("switchUserSubTab('scheduler')");
    await tick(); await tick();
    assert('opening the tab shows its panel alone', doc.getElementById('mu-panel-scheduler').classList.contains('active')
      && !doc.getElementById('mu-panel-users').classList.contains('active') && doc.getElementById('muTabBtnScheduler').classList.contains('active'));
    const rows = () => [...doc.querySelectorAll('#schListBody tr')];
    const box = n => rows().find(r => r.textContent.includes(n)).querySelector('input[type="checkbox"]');
    eq('one row a person — the list the Scheduler reads', rows().map(r => r.querySelector('.dir-name span').textContent), PEOPLE.map(p => p.name));
    assert('crew on the list are switched on', box('Aaron Todd').checked && box('Blake Hostetler').checked);
    assert('people kept off are switched off', !box('Zach Brewer').checked && !box('reeferscott').checked);
    assert('a login said to be nobody on the crew is off, and not this switch’s to change', !box('travissteve').checked && box('travissteve').disabled);
    assert('a person shows the login folded into them, so the Roles tab’s name still finds them', /login: toddaaron/.test(rows()[0].textContent));
    assert('a login nobody answers to is marked one', !!rows().find(r => r.textContent.includes('reeferscott')).querySelector('.dir-tag.login'));
    eq('the count says who is on and who is off', doc.getElementById('sch-count').textContent, '2 on the Scheduler · 3 off');
    doc.getElementById('sch-search').value = 'toddaaron';
    w.eval('renderSchedulerList()');
    assert('searching a login finds its person', rows().length === 1 && /Aaron Todd/.test(rows()[0].textContent));
    doc.getElementById('sch-search').value = '';
    doc.getElementById('sch-off-only').checked = true;
    w.eval('renderSchedulerList()');
    eq('"Off only" shows who is kept off', rows().map(r => r.querySelector('.dir-name span').textContent), ['reeferscott', 'travissteve', 'Zach Brewer']);
    doc.getElementById('sch-off-only').checked = false;
    w.eval('renderSchedulerList()');

    const blake = box('Blake Hostetler');
    assert('each switch is wired to save itself', /toggleOnScheduler\(this\)/.test(blake.getAttribute('onchange') || ''));
    blake.checked = false;
    answer = { ok: true, status: 200, body: { ok: true, name: 'Blake Hostetler', on: false } };
    await w.toggleOnScheduler(blake);
    assert('switching somebody off PATCHes that one person by name', sent && /\/api\/employees\?scheduler=Blake%20Hostetler$/.test(sent.url), sent && sent.url);
    eq('  saying off, and nothing else', sent && sent.body, { on: false });
    eq('  and the count follows', doc.getElementById('sch-count').textContent, '1 on the Scheduler · 4 off');
    assert('  and says it', /Blake Hostetler is off the Scheduler\./.test(doc.getElementById('sch-result').textContent));

    const again = box('Blake Hostetler');
    again.checked = true;
    answer = { ok: false, status: 403, body: { error: 'Company admin access required' } };
    await w.toggleOnScheduler(again);
    assert('a save that does not land puts the switch back', again.checked === false && !again.disabled);
    assert('  and says why', /Company admin access required/.test(doc.getElementById('sch-result').textContent));
    eq('  and the count does not move', doc.getElementById('sch-count').textContent, '1 on the Scheduler · 4 off');

    w.eval("switchUserSubTab('supervisors')");
    assert('the Roles tab still opens on its own', doc.getElementById('mu-panel-supervisors').classList.contains('active')
      && !doc.getElementById('mu-panel-scheduler').classList.contains('active'));
    w.eval("switchUserSubTab('users')");
    assert('and so does Users', doc.getElementById('mu-panel-users').classList.contains('active')
      && !doc.getElementById('mu-panel-supervisors').classList.contains('active') && !doc.getElementById('mu-panel-scheduler').classList.contains('active'));
  }

  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('Harness error:', err); process.exit(1); });
