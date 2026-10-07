#!/usr/bin/env node
'use strict';
/**
 * Tests for GET /api/job-overtime — the OT Hours column on Analytics ▸
 * Financials.
 *
 * Run: node scripts/test-job-overtime.js
 *
 * The rule that matters: overtime is measured over an EMPLOYEE'S week, across
 * every job and division, and only then credited to the jobs the hours past
 * forty were worked on. Measuring each job's hours against forty on its own
 * would find no overtime on a job that only took a man past the line.
 *
 * The arithmetic (jobOvertime) is exercised directly; the handler is run with
 * the real auth module — only the token check is stood in for — and a mocked
 * database, to pin who may read it and what it reads.
 */

const path   = require('path');
const Module = require('module');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── Database and auth stand-ins ────────────────────────────────────────────
let ROWS = [];
let DB_FAILS = false;
const QUERIES = [];
let AUTH = null;

const realAuth = require(path.resolve(__dirname, '..', 'api', 'lib', 'auth.js'));
const origLoad = Module._load;
Module._load = function (request, parent) {
  const fromHandler = parent && /job-overtime\.js$/.test(parent.filename);
  if (fromHandler && request === '@neondatabase/serverless') {
    return { neon: () => (strings, ...vals) => {
      QUERIES.push({ text: strings.join('?').replace(/\s+/g, ' '), vals });
      return DB_FAILS ? Promise.reject(new Error('db down')) : Promise.resolve(ROWS);
    } };
  }
  if (fromHandler && request === './lib/auth') {
    // requireDivision as it ships, over a stubbed token check: the division
    // rules and the role lookup under test are the real ones.
    return {
      ...realAuth,
      requireDivision: async (req, res, options = {}) => {
        if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        const division = realAuth.normalizeDivision(req.query && req.query.division);
        if (!division && options.required) { res.status(400).json({ error: 'division query param is required' }); return null; }
        if (!realAuth.hasDivisionAccess(AUTH, division)) { res.status(403).json({ error: 'no access' }); return null; }
        return { payload: AUTH, division };
      },
    };
  }
  return origLoad.apply(this, arguments);
};
const handler = require(path.resolve(__dirname, '..', 'api', 'job-overtime.js'));
Module._load = origLoad;
const { jobOvertime } = handler;

const call = (query, method = 'GET') => new Promise(resolve => {
  const res = {
    setHeader() {}, status(c) { this._c = c; return this; },
    json(o) { resolve({ code: this._c || 200, body: o }); }, end() { resolve({ code: this._c || 200 }); },
  };
  handler({ method, query, headers: {} }, res);
});

// A counted day: work hours, optional travel, on a job in a division.
let nextId = 1;
const day = (username, date, hours, division, job_id, extra = {}) => ({
  id: String(nextId++), username, entry_type: 'daily', status: 'approved', work_date: date,
  created_at: `${date}T17:00:00Z`, division, job_id, computed_hours: hours, travel_hours: 0, ...extra,
});
// A Monday–Friday run of days from a Monday.
const week = (username, monday, hoursEach, division, job_id) => [0, 1, 2, 3, 4].map(i => {
  const d = new Date(monday + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i);
  return day(username, d.toISOString().slice(0, 10), hoursEach, division, job_id);
});

(async () => {
  console.log('\n[the fortieth hour is the employee\'s, not the job\'s]');
  // 38 hours on a turf job Monday to Thursday, then 6 on a paving job Friday:
  // the paving job took him past forty, so it carries the 4 hours.
  const cross = [
    day('sam', '2026-09-21', 9.5, 'turf', 'T1'), day('sam', '2026-09-22', 9.5, 'turf', 'T1'),
    day('sam', '2026-09-23', 9.5, 'turf', 'T1'), day('sam', '2026-09-24', 9.5, 'turf', 'T1'),
    day('sam', '2026-09-25', 6, 'paving', 'P1'),
  ];
  const pav = jobOvertime(cross, 'paving');
  assert('the job that took him past forty carries the overtime', pav.P1 && pav.P1.otHours === 4, JSON.stringify(pav));
  assert('  the turf job, under forty on its own, carries none', JSON.stringify(jobOvertime(cross, 'turf')) === '{}');
  assert('  and another division\'s jobs are not reported', !('P1' in jobOvertime(cross, 'turf')));

  console.log('\n[it adds up week over week]');
  const two = [...week('sam', '2026-09-07', 9, 'turf', 'T1'),     // 45 → 5
               ...week('sam', '2026-09-14', 8.4, 'turf', 'T1')];  // 42 → 2
  const acc = jobOvertime(two, 'turf').T1;
  assert('two weeks of overtime on one job add up', acc && acc.otHours === 7, JSON.stringify(acc));
  assert('  counting the weeks it came from', acc.weeks === 2);
  assert('  and naming the latest one and what it added', acc.lastWeek === '2026-09-14' && acc.lastWeekOt === 2, JSON.stringify(acc));
  const under = week('dale', '2026-09-07', 8, 'turf', 'T1');      // exactly 40
  assert('a week of exactly forty is no overtime', JSON.stringify(jobOvertime(under, 'turf')) === '{}');

  console.log('\n[several employees on one job]');
  const crew = [...week('sam', '2026-09-07', 9, 'turf', 'T1'), ...week('ray', '2026-09-07', 10, 'turf', 'T1')];
  assert('their overtime is summed', jobOvertime(crew, 'turf').T1.otHours === 15);
  assert('  but each is measured against his own forty, not the crew\'s',
    jobOvertime([...week('sam', '2026-09-07', 4, 'turf', 'T1'), ...week('ray', '2026-09-07', 5, 'turf', 'T1')], 'turf').T1 === undefined);

  console.log('\n[which hours count, payroll\'s rule]');
  const travel = [...week('sam', '2026-09-07', 8, 'turf', 'T1')];
  travel[4].travel_hours = 1.5;
  assert('travel time on the clock counts toward the forty', jobOvertime(travel, 'turf').T1.otHours === 1.5);
  const draft = [...week('sam', '2026-09-07', 8, 'turf', 'T1'), day('sam', '2026-09-12', 5, 'turf', 'T1', { status: 'draft' })];
  assert('a draft day does not count', JSON.stringify(jobOvertime(draft, 'turf')) === '{}');
  const off = [...week('sam', '2026-09-07', 8, 'turf', 'T1').slice(0, 4),
               { ...day('sam', '2026-09-11', 8, 'turf', 'T1'), entry_type: 'time_off' },
               day('sam', '2026-09-12', 4, 'turf', 'T1')];
  assert('a day off is paid but never pushes the week past forty', JSON.stringify(jobOvertime(off, 'turf')) === '{}');
  const submitted = week('sam', '2026-09-07', 9, 'turf', 'T1').map(e => ({ ...e, status: 'submitted' }));
  assert('submitted days count, as on the payroll reports', jobOvertime(submitted, 'turf').T1.otHours === 5);

  console.log('\n[the day that crosses the line]');
  // 36 hours on T1, then Friday split into two blocks on two jobs. The block
  // created first keeps the regular hours; the later one takes the overtime.
  const split = [
    ...week('sam', '2026-09-07', 9, 'turf', 'T1').slice(0, 4),
    day('sam', '2026-09-11', 3, 'turf', 'T2', { created_at: '2026-09-11T10:00:00Z' }),
    day('sam', '2026-09-11', 5, 'turf', 'T3', { created_at: '2026-09-11T15:00:00Z' }),
  ];
  const sp = jobOvertime(split, 'turf');
  assert('the block filed first keeps its regular hours under forty', !('T2' in sp), JSON.stringify(sp));
  assert('  and the later one takes the hours past it', sp.T3 && sp.T3.otHours === 4, JSON.stringify(sp));
  assert('a day with no job is left off every project row',
    JSON.stringify(jobOvertime(week('sam', '2026-09-07', 9, 'turf', ''), 'turf')) === '{}');
  assert('a Sunday belongs to the week that began the Monday before',
    jobOvertime([...week('sam', '2026-09-07', 8, 'turf', 'T1'), day('sam', '2026-09-13', 2, 'turf', 'T1')], 'turf').T1.otHours === 2);

  console.log('\n[the endpoint]');
  ROWS = cross;
  AUTH = { companyCode: 'ACME', divisionRoles: { paving: 'admin', turf: 'level3' } };
  QUERIES.length = 0;
  const ok = await call({ division: 'paving' });
  assert('a division admin gets the division\'s overtime per job',
    ok.code === 200 && ok.body.division === 'paving' && ok.body.jobs.P1 && ok.body.jobs.P1.otHours === 4, JSON.stringify(ok));
  assert('  and nothing about who worked it', !/sam/.test(JSON.stringify(ok.body)));
  const q = QUERIES[0] || { text: '', vals: [] };
  assert('it reads one company\'s timesheets only', /company_code = \?/.test(q.text) && q.vals.filter(v => v === 'ACME').length === 2, q.text);
  assert('  counted daily entries only', /entry_type = 'daily'/.test(q.text) && /status IN \('submitted', 'approved'\)/.test(q.text));
  // The division narrows WHO is read, never WHICH days: his days on other
  // divisions' jobs are what take him past forty.
  const outer = q.text.slice(0, q.text.indexOf('username IN'));
  assert('  for every employee who has worked the division, on every division\'s jobs',
    /username IN \( SELECT username FROM timesheet_entries/.test(q.text) && q.vals.includes('paving')
    && !/division =/.test(outer), q.text);
  assert('  with the columns weeklyOvertime orders a shared date by', /\bcreated_at\b/.test(q.text) && /\bid\b/.test(q.text));

  const lvl3 = await call({ division: 'turf' });
  assert('level 3 can read it, as it can open Financials', lvl3.code === 200, JSON.stringify(lvl3));
  AUTH = { companyCode: 'ACME', divisionRoles: { turf: 'level2' } };
  assert('level 2, which is not shown Financials, cannot', (await call({ division: 'turf' })).code === 403);
  AUTH = { companyCode: 'ACME', divisionRoles: { turf: 'sales' } };
  assert('  nor sales', (await call({ division: 'turf' })).code === 403);
  AUTH = { companyCode: 'ACME', divisionRoles: { turf: 'admin', paving: 'no_access' } };
  assert('no access to the division is refused', (await call({ division: 'paving' })).code === 403);
  AUTH = { companyCode: 'ACME', isPlatformAdmin: true };
  assert('a division without jobs is refused', (await call({ division: 'dust' })).code === 400);
  assert('  as is a request that names no division', (await call({})).code === 400);
  assert('  and anything but a read', (await call({ division: 'turf' }, 'POST')).code === 405);
  AUTH = null;
  assert('signed out is refused', (await call({ division: 'turf' })).code === 401);
  AUTH = { companyCode: 'ACME', isPlatformAdmin: true };
  DB_FAILS = true;
  const down = await call({ division: 'turf' });
  assert('a database failure says so rather than answering no overtime', down.code === 500 && !down.body.jobs, JSON.stringify(down));
  DB_FAILS = false;

  // ── Through the real database driver ─────────────────────────────────────
  // The mock above hands back whatever the fixtures hold, and the fixtures hold
  // dates as text. The real driver does not: it parses each column by its
  // Postgres type, and a DATE comes back as a JS Date that weekStartOf cannot
  // read — every day dropped, every job "no overtime", a clean 200. So the
  // handler is run once more on the real @neondatabase/serverless, with only
  // Neon's HTTP answer faked, typing each column the way Postgres would given
  // the casts the query actually asks for.
  console.log('\n[through the real database driver]');
  {
    const { neonConfig } = require('@neondatabase/serverless');
    let sent = '';
    neonConfig.fetchFunction = async (url, init) => {
      const { query } = JSON.parse(init.body);
      sent = query;
      const cast = (col, to) => new RegExp(`\\b${col}::${to}\\b`).test(query);
      const fields = [
        ['id', 20], ['username', 25], ['entry_type', 25], ['status', 25], ['division', 25], ['job_id', 25],
        ['work_date', cast('work_date', 'text') ? 25 : 1082],            // DATE unless cast
        ['created_at', cast('created_at', 'text') ? 25 : 1184],           // TIMESTAMPTZ unless cast
        ['computed_hours', cast('computed_hours', 'float') ? 701 : 1700], // NUMERIC (a string) unless cast
        ['travel_hours', cast('travel_hours', 'float') ? 701 : 1700],
      ];
      const days = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
      const body = {
        command: 'SELECT', rowCount: days.length, rowAsArray: true,
        fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
        rows: days.map((d, i) => [String(i + 1), 'sam', 'daily', 'approved', 'turf', '101', d, `${d} 17:00:00+00`, '10', '0']),
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const prevUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://u:p@ep-test.us-east-2.aws.neon.tech/db';
    const handlerPath = path.resolve(__dirname, '..', 'api', 'job-overtime.js');
    delete require.cache[handlerPath];
    Module._load = function (request, parent) {
      if (parent && /job-overtime\.js$/.test(parent.filename) && request === './lib/auth') {
        return { ...realAuth, requireDivision: async () => ({ payload: { companyCode: 'ACME', isPlatformAdmin: true }, division: 'turf' }) };
      }
      return origLoad.apply(this, arguments);
    };
    const live = require(handlerPath);
    Module._load = origLoad;
    const out = await new Promise(resolve => {
      const res = { setHeader() {}, status(c) { this._c = c; return this; }, json(o) { resolve({ code: this._c || 200, body: o }); }, end() {} };
      live({ method: 'GET', query: { division: 'turf' }, headers: {} }, res);
    });
    assert('a week of 50 hours read through the real driver posts its 10 hours of overtime',
      out.code === 200 && out.body.jobs['101'] && out.body.jobs['101'].otHours === 10, JSON.stringify(out));
    assert('  because the query asks for the dates as text', /work_date::text\s+AS work_date/.test(sent), sent.slice(0, 200));
    process.env.DATABASE_URL = prevUrl;
    delete neonConfig.fetchFunction;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
