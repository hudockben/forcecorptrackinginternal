#!/usr/bin/env node
'use strict';
// A DATE is half of what this tab reads. Pin the clock east of Greenwich so a
// week that slides a day through UTC actually fails here instead of passing by
// geography. Set before anything touches a Date.
process.env.TZ = 'Europe/Berlin';
/**
 * Safety Center hours: "Safety Center" on the Timesheet's division picker,
 * payroll's approval of those days, and the Safety Center's Hours tab.
 *
 * Run: node scripts/test-safety-hours.js
 * No DB or server required — the neon driver is stubbed with a recording fake,
 * and the pages are driven in jsdom. scripts/test-safety-hours-sql.js runs the
 * same flow end to end against a real PostgreSQL.
 *
 * Auth is stubbed at ONE point only: requireAuth hands back the payload under
 * test instead of decoding a JWT. Everything that decides what that payload
 * may do — hasDivisionAccess, payrollAccess, safetyCapabilities — is the real
 * code, because who may read everybody's hours is the rule most worth pinning
 * and a stub that waved callers through would test nothing.
 *
 * Five things are pinned:
 *
 * 1. THE TIMESHEET OFFERS IT. Safety Center is on the Division picker, and its
 *    jobs are the standing safety activities — served with no database read.
 *
 * 2. APPROVAL IS THE SAME APPROVAL. A safety day goes in, is approved and is
 *    un-approved through the same endpoint actions as every other day. The
 *    approval flips status and writes its audit record, and injects nothing:
 *    no cost row, no blob write. Payroll's Division filter narrows to it.
 *
 * 3. THE HOURS LOG IS THE SUPERVISOR'S. Somebody without the division, crew,
 *    and payroll-only accounts are refused; level3/admin, and a platform admin
 *    with no explicit role, are let in. An explicit crew grant beats the
 *    platform-admin default, as it does everywhere else in the Safety Center.
 *
 * 4. IT READS PAYROLL'S RECORD, AND ONLY THE RIGHT SLICE OF IT. The caller's
 *    company (never one from the query), division 'safety', daily days,
 *    submitted or approved, inside the range. Approved days are the log;
 *    submitted ones come back apart, as waiting on payroll.
 *
 * 5. THE PAGES. The Timesheet and payroll both know the division by name; the
 *    Safety Center's Hours tab shows for supervisors only, draws what the
 *    endpoint returns, escapes what people typed, and exports a CSV that a
 *    spreadsheet cannot be tricked into running.
 */

const path   = require('path');
const fs     = require('fs');
const vm     = require('vm');
const Module = require('module');
const { JSDOM } = require('jsdom');

process.env.DATABASE_URL = 'postgres://stub/stub';

const root = f => path.resolve(__dirname, '..', f);
const read = f => fs.readFileSync(root(f), 'utf8');
const { requireFn } = require(root('scripts/lib/fn-source.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── Stubs ──────────────────────────────────────────────────────────────────
// The real auth module, loaded BEFORE the hook goes in, so the copy handed to
// the endpoints below is the real one with requireAuth replaced and nothing
// else. api/lib/safety.js requires it as './auth' and gets it untouched.
const realAuth = require(root('api/lib/auth.js'));
let NEXT_AUTH = null;
let CURRENT_SQL = () => Promise.resolve([]);

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return { neon: () => (...args) => CURRENT_SQL(...args) };
  }
  if (request === './lib/auth') {
    return Object.assign({}, realAuth, { requireAuth: async () => NEXT_AUTH });
  }
  return origLoad.apply(this, arguments);
};

const jobsHandler    = require(root('api/timesheet-jobs.js'));
const entriesHandler = require(root('api/timesheet-entries.js'));
const hoursHandler   = require(root('api/safety-hours.js'));
const { SAFETY_JOBS } = require(root('api/lib/safety.js'));
const { normalizeEntryBody, SPLIT_DEST_DIVISIONS } = entriesHandler._test;

async function call(handler, auth, { method = 'GET', query = {}, body = {} } = {}) {
  NEXT_AUTH = auth;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query, body, headers: {} }, res);
  return res;
}

// A tagged-template fake that records every statement and answers through
// `answer(flat, strings, values)`.
function recordingSql(answer) {
  const calls = [];
  const fn = (strings, ...values) => {
    const flat = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ q: flat, strings, values });
    try { return Promise.resolve(answer(flat, strings, values)); }
    catch (err) { return Promise.reject(err); }
  };
  fn.calls = calls;
  return fn;
}

// The value bound right after the template piece matching `re`, or undefined.
function boundAfter(strings, values, re) {
  const i = strings.findIndex(s => re.test(s));
  return i === -1 ? undefined : values[i];
}

const COMPANY = 'FCT';
const LABORER  = { companyCode: COMPANY, userId: 7,  username: 'strickallen', divisionRoles: { timesheet: 'level1' } };
const CREW     = { companyCode: COMPANY, userId: 8,  username: 'jhauser',     divisionRoles: { timesheet: 'level1', safety: 'level1' } };
const SUP      = { companyCode: COMPANY, userId: 9,  username: 'travissteve', divisionRoles: { safety: 'level3' } };
const SAFETY_ADMIN = { companyCode: COMPANY, userId: 10, username: 'safetyboss', divisionRoles: { safety: 'admin' } };
const PAYROLL  = { companyCode: COMPANY, userId: 42, username: 'office',      divisionRoles: { timesheet: 'level1', payroll: 'level3' } };
const PLATFORM = { companyCode: COMPANY, userId: 1,  username: 'ben',         isPlatformAdmin: true, divisionRoles: {} };
const PLATFORM_AS_CREW = { companyCode: COMPANY, userId: 2, username: 'benfield', isPlatformAdmin: true,
                           divisionRoles: { safety: 'level1' } };

async function main() {
  // ═════════════════════════════════════════════════════════════════════════
  // 1. The job picker
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[the Timesheet job picker — Safety Center]');
  {
    CURRENT_SQL = recordingSql(() => []);
    const r = await call(jobsHandler, LABORER, { query: { division: 'safety' } });
    assert('a laborer asking for safety jobs is answered', r.statusCode === 200, JSON.stringify(r.body));
    const jobs = (r.body && r.body.jobs) || [];
    assert('  with the standing safety activities, in order',
      JSON.stringify(jobs) === JSON.stringify(SAFETY_JOBS.map(j => ({ id: j.id, label: j.label }))),
      JSON.stringify(jobs));
    assert('  and no database read for a list that lives in code', CURRENT_SQL.calls.length === 0,
      `${CURRENT_SQL.calls.length} statements`);
    assert('  every id namespaced so it cannot pass for another division\'s job',
      jobs.length > 0 && jobs.every(j => /^safety:[a-z]+$/.test(j.id)));
    assert('  and no two alike', new Set(jobs.map(j => j.id)).size === jobs.length);
    assert('  a tailgate and training among them, the two most of this time will be',
      jobs.some(j => /Tailgate/.test(j.label)) && jobs.some(j => /Training/.test(j.label)));

    // Handed out as copies: the shared list is frozen, and a response that
    // aliased it would let a caller in the same process scribble on it.
    jobs[0].label = 'scribbled';
    assert('  the response is a copy of the list, not the list itself', SAFETY_JOBS[0].label !== 'scribbled');
    assert('  and the list is frozen besides', Object.isFrozen(SAFETY_JOBS) && Object.isFrozen(SAFETY_JOBS[0]));
  }
  {
    CURRENT_SQL = recordingSql(() => []);
    const r = await call(jobsHandler, PAYROLL, { query: { division: 'safety' } });
    assert('payroll reads the same list — its Edit modal re-picks the job from it', r.statusCode === 200
      && Array.isArray(r.body.jobs) && r.body.jobs.length === SAFETY_JOBS.length);
  }
  {
    CURRENT_SQL = recordingSql(() => []);
    const r = await call(jobsHandler, LABORER, { query: { division: 'nope' } });
    assert('an unknown division is refused, and the refusal names safety among the real ones',
      r.statusCode === 400 && /safety/.test(r.body.error), JSON.stringify(r.body));
  }
  {
    // The other divisions still go to their own readers — adding a branch must
    // not have swallowed one.
    CURRENT_SQL = recordingSql(flat => (/FROM quarry_locations/.test(flat) ? [{ id: 3, name: 'Homer City' }] : []));
    const r = await call(jobsHandler, LABORER, { query: { division: 'quarry' } });
    assert('quarry is still answered from its own locations', r.statusCode === 200
      && r.body.jobs.some(j => j.id === 'daily:3') && r.body.jobs.some(j => j.id === 'crushing:3'));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 2. The entry, and payroll's approval of it
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[a Safety Center day — what the entry endpoint accepts]');
  const DAY = {
    entry_type: 'daily', work_date: '2026-11-02', division: 'safety',
    job_id: 'safety:training', job_label: 'Safety Training',
    start_time: '07:00', end_time: '09:30', lunch_break: false, operated_equipment: false,
    supervisor_id: 3, supervisor_name: 'Steve Travis', notes: 'Fall protection refresher',
    // Values that belong to other divisions' rows, posted anyway. None of them
    // has anywhere to go on a safety day.
    truck_unit: 'T-12', truck_description: 'stray', ees_unit: 'stray', ees_billing: 'Billable',
  };
  {
    const { data, error } = normalizeEntryBody(DAY);
    assert('a safety day is a valid daily entry', !error && !!data, error);
    assert('  filed under the safety division', data && data.division === 'safety');
    assert('  against the activity picked', data && data.job_id === 'safety:training' && data.job_label === 'Safety Training');
    assert('  with its hours worked out server-side', data && data.computed_hours === 2.5, data && data.computed_hours);
    assert('  and no truck or EES extras carried across from other divisions',
      data && data.truck_unit === null && data.truck_description === null
      && data.ees_unit === null && data.ees_billing === null);
  }
  {
    const { error } = normalizeEntryBody(Object.assign({}, DAY, { job_id: '', job_label: '' }));
    assert('a safety day still needs an activity, like any day needs a job', /job_id and job_label/.test(error || ''));
  }
  assert('safety is not a destination a split row can be sent to — it posts no cost row',
    !SPLIT_DEST_DIVISIONS.includes('safety'));

  // The activity is checked on the server, not just offered by the picker. The
  // Hours tab totals by it, so a day filed against anything else would be
  // approved without complaint and split those totals.
  {
    const { error } = normalizeEntryBody(Object.assign({}, DAY, { job_id: '26019', job_label: 'Punxsy Storage Lot' }));
    assert('a safety day filed against a turf project is refused', /Safety Center activities/.test(error || ''), error);
    const made = normalizeEntryBody(Object.assign({}, DAY, { job_id: 'safety:made-up', job_label: 'Made Up' }));
    assert('  and so is an activity that does not exist', /Safety Center activities/.test(made.error || ''), made.error);
    const spoofed = normalizeEntryBody(Object.assign({}, DAY, { job_label: 'Anything I like' }));
    assert('a known activity is filed under the list\'s own label, whatever label was sent',
      !spoofed.error && spoofed.data.job_label === 'Safety Training', spoofed.error || spoofed.data.job_label);
    // Retired after the day was filed: the day must stay correctable.
    const FILED = { entry_type: 'daily', division: 'safety', job_id: 'safety:fit-test', job_label: 'Respirator Fit Test' };
    const kept = normalizeEntryBody(Object.assign({}, DAY, { job_id: 'safety:fit-test', job_label: 'x' }), FILED);
    assert('an edit may keep an activity since retired, under the label it was filed with',
      !kept.error && kept.data.job_label === 'Respirator Fit Test', kept.error || kept.data.job_label);
    const fresh = normalizeEntryBody(Object.assign({}, DAY, { job_id: 'safety:fit-test', job_label: 'x' }));
    assert('  but a new day cannot be filed against one', /Safety Center activities/.test(fresh.error || ''));
    const moved = normalizeEntryBody(Object.assign({}, DAY, { job_id: 'safety:fit-test', job_label: 'x' }),
      { entry_type: 'daily', division: 'turf', job_id: 'safety:fit-test' });
    assert('  nor a day moved in from another division', /Safety Center activities/.test(moved.error || ''));
  }
  // A Safety Center day is never a haul. A driver is not asked on one, and an
  // answer that arrives anyway is not kept, or payrollMetrics would count a
  // classroom day as hours behind the wheel.
  {
    const s = normalizeEntryBody(Object.assign({}, DAY, { haul_type: 'off_site' }));
    assert('a haul answer sent on a safety day is not kept', !s.error && s.data.haul_type === null,
      s.error || s.data.haul_type);
    const t = normalizeEntryBody(Object.assign({}, DAY, {
      division: 'turf', job_id: '26019', job_label: 'Punxsy Storage Lot', haul_type: 'off_site' }));
    assert('  while one on a job is', !t.error && t.data.haul_type === 'off_site', t.error || t.data.haul_type);
  }
  {
    // The same refusal, through the endpoint: nothing is written.
    CURRENT_SQL = recordingSql(() => []);
    const r = await call(entriesHandler, LABORER, {
      method: 'POST', body: Object.assign({}, DAY, { job_id: 'safety:made-up', job_label: 'Made Up' }) });
    assert('the endpoint refuses that day before writing anything', r.statusCode === 400
      && !CURRENT_SQL.calls.some(c => /^INSERT INTO timesheet_entries/.test(c.q)), `${r.statusCode} ${JSON.stringify(r.body)}`);
  }

  console.log('\n[a Safety Center day — payroll approves it like any other]');
  // One submitted safety day, and a fake that keeps it in step with the
  // UPDATEs the handler sends, so what comes back is what was written.
  const ROW = {
    id: 501, company_code: COMPANY, user_id: 7, username: 'strickallen', employee_id: null,
    entry_type: 'daily', work_date: new Date(2026, 10, 2), status: 'submitted',
    division: 'safety', job_id: 'safety:training', job_label: 'Safety Training',
    start_time: '07:00', end_time: '09:30', computed_hours: '2.50',
    travel_to_site_hours: null, travel_to_shop_hours: null, travel_hours: null,
    lunch_break: false, operated_equipment: false, equipment_used: null, haul_type: null,
    supervisor_id: 3, supervisor_name: 'Steve Travis', notes: 'Fall protection refresher',
    submitted_at: new Date('2026-11-02T15:00:00Z'), approved_at: null,
    approved_by_user_id: null, approved_by_name: null,
    created_at: new Date('2026-11-02T14:00:00Z'), updated_at: new Date('2026-11-02T15:00:00Z'),
  };
  let row = Object.assign({}, ROW);
  const entrySql = () => recordingSql((flat, strings, values) => {
    if (/^SELECT \* FROM timesheet_entries WHERE id = \? AND company_code = \?$/.test(flat)) {
      return values[0] === row.id && values[1] === row.company_code ? [Object.assign({}, row)] : [];
    }
    if (/^UPDATE timesheet_entries SET status = 'approved'/.test(flat)) {
      row = Object.assign({}, row, {
        status: 'approved', approved_at: new Date(),
        approved_by_user_id: boundAfter(strings, values, /approved_by_user_id\s*=\s*$/),
        approved_by_name: boundAfter(strings, values, /approved_by_name\s*=\s*$/),
      });
      return [Object.assign({}, row)];
    }
    if (/^UPDATE timesheet_entries SET status = 'submitted'/.test(flat)) {
      row = Object.assign({}, row, { status: 'submitted', approved_at: null, approved_by_user_id: null, approved_by_name: null });
      return [Object.assign({}, row)];
    }
    // Un-approve counts the cost rows it is about to sweep (removeSplitRows).
    // A safety day never posted one, so the count is nought.
    if (/^SELECT COUNT\(\*\)::int AS cnt FROM daily_tracking/.test(flat)) return [{ cnt: 0 }];
    return [];
  });
  const writesOutsideTheEntry = calls => calls.filter(c =>
    /^(INSERT INTO|UPDATE|DELETE FROM) (daily_tracking|app_data|quarry_|truck_division|dust_)/.test(c.q)
    && !/^DELETE FROM daily_tracking/.test(c.q));   // un-approve's unconditional sweep — finds nothing here
  {
    CURRENT_SQL = entrySql();
    const r = await call(entriesHandler, LABORER, { method: 'POST', query: { action: 'approve', id: '501' } });
    assert('the laborer who filed it cannot approve it', r.statusCode === 403, r.statusCode);
    assert('  and nothing was written', !CURRENT_SQL.calls.some(c => /^UPDATE|^INSERT/.test(c.q)));
  }
  {
    CURRENT_SQL = entrySql();
    // No body at all — what payroll's plain Approve button and bulk approve send.
    const r = await call(entriesHandler, PAYROLL, { method: 'POST', query: { action: 'approve', id: '501' } });
    assert('payroll approves it with the plain Approve — no body to fill in', r.statusCode === 200 && r.body.ok,
      JSON.stringify(r.body));
    assert('  it comes back approved, by the approver', r.body.entry && r.body.entry.status === 'approved'
      && r.body.entry.approved_by_name === 'office', JSON.stringify(r.body.entry));
    assert('  nothing is injected anywhere — no cost row, no blob write',
      writesOutsideTheEntry(CURRENT_SQL.calls).length === 0,
      writesOutsideTheEntry(CURRENT_SQL.calls).map(c => c.q.slice(0, 60)).join(' | '));
    const audit = CURRENT_SQL.calls.find(c => /^INSERT INTO timesheet_audit_log/.test(c.q));
    assert('  and the approval is on the record like any other',
      !!audit && audit.values.includes('APPROVE') && audit.values.includes(501));
    assert('  with no injection details, because there were none',
      !!audit && audit.values[5] === null, audit && String(audit.values[5]));
  }
  {
    CURRENT_SQL = entrySql();
    const r = await call(entriesHandler, PAYROLL, { method: 'POST', query: { action: 'approve', id: '501' } });
    assert('approving it twice is refused, as for any approved day', r.statusCode === 409, r.statusCode);
  }
  {
    CURRENT_SQL = entrySql();
    const r = await call(entriesHandler, PAYROLL, { method: 'POST', query: { action: 'unapprove', id: '501' } });
    assert('un-approve puts it back in Pending', r.statusCode === 200 && r.body.entry && r.body.entry.status === 'submitted',
      JSON.stringify(r.body));
    assert('  touching nothing outside the entry', writesOutsideTheEntry(CURRENT_SQL.calls).length === 0);
    assert('  and reporting no cost rows removed, because there were none', r.body.removed_split_rows === 0,
      String(r.body.removed_split_rows));
  }
  {
    // Payroll's Division filter. Before the division existed, a value the
    // endpoint did not know was dropped to "every division" — the filter would
    // have shown the whole company while reading "Safety Center".
    let divBound;
    CURRENT_SQL = recordingSql((flat, strings, values) => {
      if (/^SELECT \* FROM timesheet_entries WHERE company_code/.test(flat)) {
        divBound = boundAfter(strings, values, /OR division = \s*$/);
      }
      return [];
    });
    const r = await call(entriesHandler, PAYROLL, {
      query: { scope: 'all', division: 'safety', from: '2026-11-01', to: '2026-11-30', status: 'submitted' },
    });
    assert('payroll can filter its review grid to the Safety Center', r.statusCode === 200 && divBound === 'safety',
      `bound ${JSON.stringify(divBound)}`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3 + 4. The hours endpoint
  // ═════════════════════════════════════════════════════════════════════════
  // Rows as the driver hands them back for the endpoint's own SELECT: the
  // casts in it make work_date text and the hours floats.
  const ts = (id, over) => Object.assign({
    id, company_code: COMPANY, user_id: 7, username: 'strickallen',
    entry_type: 'daily', division: 'safety', status: 'approved',
    work_date: '2026-10-27', job_id: 'safety:meeting', job_label: 'Safety Meeting / Tailgate',
    start_time: '07:00', end_time: '07:30', computed_hours: 0.5, travel_hours: null,
    lunch_break: false, supervisor_name: 'Steve Travis', notes: null,
    submitted_at: new Date('2026-10-27T13:00:00Z'), approved_at: new Date('2026-10-28T13:00:00Z'),
    approved_by_name: 'office',
  }, over);
  const TABLE = [
    ts(1),
    ts(2, { user_id: 8, username: 'jhauser', work_date: '2026-10-29', job_id: 'safety:training',
            job_label: 'Safety Training', start_time: '06:00', end_time: '10:00', computed_hours: 4, travel_hours: 1 }),
    ts(3, { work_date: '2026-11-02', job_id: 'safety:training', job_label: 'Safety Training',
            status: 'submitted', approved_at: null, approved_by_name: null, computed_hours: 2.5 }),
    ts(4, { division: 'turf', job_id: '26019', job_label: 'Punxsy Storage Lot', computed_hours: 8 }),   // another division
    ts(5, { company_code: 'OTHER', computed_hours: 9 }),                                                    // another company
    ts(6, { status: 'draft', computed_hours: 3 }),                                                          // not handed in
    ts(7, { entry_type: 'time_off', division: null, job_id: null, computed_hours: null }),                  // a day off
    ts(8, { work_date: '2026-09-01', computed_hours: 1 }),                                                  // outside the range
  ];
  const SIGS = [
    { company_code: COMPANY, user_id: 8, full_name: 'J Hauser',    signed_at: new Date('2026-09-01T12:00:00Z') },
    { company_code: COMPANY, user_id: 8, full_name: 'Josh Hauser', signed_at: new Date('2026-10-20T12:00:00Z') },
    { company_code: 'OTHER', user_id: 7, full_name: 'Not Him',     signed_at: new Date('2026-10-20T12:00:00Z') },
  ];
  let failSigs = false, failMain = false, table = TABLE, lastHoursRead = null;
  // Applies every filter the real SQL applies — the bound ones from the values
  // it was handed, the literal ones only if the statement actually says them —
  // so what the endpoint returns is a fact about its SQL, not about this mock.
  const hoursSql = () => recordingSql((flat, strings, values) => {
    if (/FROM timesheet_entries/.test(flat)) {
      if (failMain) throw new Error('connection reset');
      const company  = boundAfter(strings, values, /company_code\s*=\s*$/);
      const division = boundAfter(strings, values, /division\s*=\s*$/);
      const from     = boundAfter(strings, values, /work_date >=\s*$/);
      const to       = boundAfter(strings, values, /work_date <=\s*$/);
      const limit    = boundAfter(strings, values, /LIMIT\s*$/);
      const dailyOnly  = /entry_type = 'daily'/.test(flat);
      const handedIn   = /status IN \('submitted', 'approved'\)/.test(flat);
      lastHoursRead = { company, division, from, to, limit, dailyOnly, handedIn, flat };
      return table
        .filter(r => r.company_code === company && r.division === division)
        .filter(r => !dailyOnly || r.entry_type === 'daily')
        .filter(r => !handedIn || r.status === 'submitted' || r.status === 'approved')
        .filter(r => (from == null || r.work_date >= from) && (to == null || r.work_date <= to))
        .sort((a, b) => b.work_date.localeCompare(a.work_date)
          || a.username.toLowerCase().localeCompare(b.username.toLowerCase())
          || String(a.start_time).localeCompare(String(b.start_time)) || a.id - b.id)
        .slice(0, limit);
    }
    if (/FROM safety_signatures/.test(flat)) {
      if (failSigs) throw new Error('relation "safety_signatures" does not exist');
      const company = boundAfter(strings, values, /company_code\s*=\s*$/);
      const ids     = boundAfter(strings, values, /user_id = ANY\(\s*$/) || [];
      const latest  = new Map();
      for (const s of SIGS.filter(s => s.company_code === company && ids.includes(s.user_id))) {
        const cur = latest.get(s.user_id);
        if (!cur || s.signed_at > cur.signed_at) latest.set(s.user_id, s);
      }
      return [...latest.values()].map(s => ({ user_id: s.user_id, full_name: s.full_name }));
    }
    return [];
  });
  const RANGE = { from: '2026-10-26', to: '2026-11-08' };

  console.log('\n[the hours log — who may read it]');
  for (const [who, auth, want] of [
    ['somebody without the Safety Center',                 LABORER,  403],
    ['crew in the Safety Center',                          CREW,     403],
    ['payroll, without the Safety Center',                 PAYROLL,  403],
    ['a platform admin set to crew in the Safety Center',  PLATFORM_AS_CREW, 403],
    ['a safety supervisor (level 3)',                      SUP,      200],
    ['a safety admin',                                     SAFETY_ADMIN, 200],
    ['a platform admin with no Safety Center role at all', PLATFORM, 200],
  ]) {
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, auth, { query: RANGE });
    assert(`${who} → ${want}`, r.statusCode === want, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)}`);
    if (want === 403) {
      assert('  and is refused before anything is read', !CURRENT_SQL.calls.some(c => /timesheet_entries/.test(c.q)));
    }
  }
  {
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, CREW, { query: RANGE });
    assert('crew are told it is the supervisors\', not that they have no access at all',
      /supervisors/.test((r.body && r.body.error) || ''), r.body && r.body.error);
  }
  {
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, SUP, { method: 'POST', query: RANGE });
    assert('it is read-only — a POST is refused', r.statusCode === 405);
    assert('  before any statement runs', CURRENT_SQL.calls.length === 0);
  }

  console.log('\n[the hours log — what it reads]');
  {
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, SUP, { query: Object.assign({ companyCode: 'OTHER', division: 'turf' }, RANGE) });
    const b = r.body || {};
    assert('a supervisor gets the range', r.statusCode === 200, JSON.stringify(b).slice(0, 200));
    assert('  read for their own company, whatever the query says', lastHoursRead && lastHoursRead.company === COMPANY,
      lastHoursRead && lastHoursRead.company);
    assert('  and for the safety division, whatever the query says', lastHoursRead && lastHoursRead.division === 'safety');
    assert('  daily days only — a day off is not safety time', lastHoursRead && lastHoursRead.dailyOnly);
    assert('  handed in only — a draft is the laborer\'s until he submits it', lastHoursRead && lastHoursRead.handedIn);
    assert('  inside the range asked for', lastHoursRead && lastHoursRead.from === RANGE.from && lastHoursRead.to === RANGE.to);
    assert('  echoing the range back', b.from === RANGE.from && b.to === RANGE.to);
    assert('  one row past the ceiling, so a full range can be told from an exact one',
      lastHoursRead && lastHoursRead.limit === hoursHandler._test.MAX_ROWS + 1);

    assert('the log is the approved days, newest first',
      JSON.stringify((b.entries || []).map(e => e.id)) === '["2","1"]', JSON.stringify((b.entries || []).map(e => e.id)));
    assert('the submitted day comes back apart, as waiting on payroll',
      JSON.stringify((b.pending || []).map(e => e.id)) === '["3"]', JSON.stringify((b.pending || []).map(e => e.id)));
    const e2 = (b.entries || []).find(e => e.id === '2') || {};
    assert('hours arrive as numbers, never strings to concatenate', e2.hours === 4 && e2.travelHours === 1,
      `${typeof e2.hours} ${e2.hours} / ${typeof e2.travelHours} ${e2.travelHours}`);
    assert('the date is the calendar day, untouched by a timezone', e2.workDate === '2026-10-29', e2.workDate);
    assert('the activity, the clock and who approved it ride along',
      e2.jobId === 'safety:training' && e2.startTime === '06:00' && e2.endTime === '10:00' && e2.approvedBy === 'office');
    assert('a person is named as they last signed a Safety Center form', e2.fullName === 'Josh Hauser', e2.fullName);
    const e1 = (b.entries || []).find(e => e.id === '1') || {};
    assert('  and somebody who never signed one is left to their login', e1.fullName === null && e1.username === 'strickallen');
    assert('  — never by a signature from another company', !JSON.stringify(b).includes('Not Him'));
    assert('the standing activities come with it, so the tab can show the ones nobody did',
      JSON.stringify(b.activities) === JSON.stringify(SAFETY_JOBS.map(j => ({ id: j.id, label: j.label }))));
    assert('a range this size is not truncated', b.truncated === false);
  }
  {
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, SUP, { query: {} });
    assert('no dates reads every safety day of the company', r.statusCode === 200
      && lastHoursRead.from === null && lastHoursRead.to === null
      && JSON.stringify(r.body.entries.map(e => e.id)) === '["2","1","8"]', JSON.stringify(r.body).slice(0, 160));
  }
  for (const [label, query] of [
    ['a date that does not exist', { from: '2026-02-30' }],
    ['a date that is not one',     { to: 'last week' }],
    ['a range back to front',      { from: '2026-11-08', to: '2026-10-26' }],
  ]) {
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, SUP, { query });
    assert(`${label} is refused rather than read as "no limit"`, r.statusCode === 400, `${r.statusCode} ${JSON.stringify(r.body)}`);
    assert('  before anything is read', !CURRENT_SQL.calls.length);
  }
  {
    failSigs = true;
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, SUP, { query: RANGE });
    failSigs = false;
    assert('names failing to load cost the names, not the hours', r.statusCode === 200
      && r.body.entries.length === 2 && r.body.entries.every(e => e.fullName === null));
  }
  {
    failMain = true;
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, SUP, { query: RANGE });
    failMain = false;
    assert('the hours failing to load is an error, not an empty log', r.statusCode === 500 && /Database error/.test(r.body.error));
  }
  {
    const MAX = hoursHandler._test.MAX_ROWS;
    table = Array.from({ length: MAX + 3 }, (_, i) => ts(1000 + i, { work_date: '2026-10-28' }));
    CURRENT_SQL = hoursSql();
    const r = await call(hoursHandler, SUP, { query: RANGE });
    table = TABLE;
    assert('a range holding more than one read returns says so', r.statusCode === 200 && r.body.truncated === true);
    assert('  and hands back exactly the ceiling', r.body.entries.length + r.body.pending.length === MAX,
      r.body.entries.length + r.body.pending.length);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 5. The pages
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n[the Timesheet and payroll know the division by name]');
  {
    const ts = read('timesheet.html');
    const pr = read('payroll.html');
    const pick = (html, id) => {
      const m = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
      return m ? m[1] : '';
    };
    assert('the Timesheet\'s Division picker offers Safety Center',
      /<option value="safety">Safety Center<\/option>/.test(pick(ts, 'f-division')));
    assert('  and a split day\'s extra job blocks copy that picker, so they offer it too',
      /DIVISION_OPTIONS_HTML = document\.getElementById\('f-division'\)\.innerHTML/.test(ts));
    assert('payroll\'s Division filter offers it',
      /<option value="safety">Safety Center<\/option>/.test(pick(pr, 'flt-division')));
    // Without it, opening Edit on a safety day sets the select to a value it
    // does not hold — no option selected — and saving re-files the day as
    // whatever the browser falls back to, or refuses it outright.
    assert('payroll\'s Edit modal can hold a safety day\'s division',
      /<option value="safety">Safety Center<\/option>/.test(pick(pr, 'em-division')));

    const label = (html, name) => {
      const ctx = vm.createContext({});
      vm.runInContext(requireFn(html, name), ctx);
      return vm.runInContext(`${name}('safety')`, ctx);
    };
    assert('the Timesheet names it on My Recent Entries', label(ts, 'prettyDivision') === 'Safety Center');
    assert('payroll names it on the grid, the reports and the exports', label(pr, 'prettyDiv') === 'Safety Center');
    assert('payroll\'s bulk approve says where a safety day\'s hours go',
      /Safety Center's Hours tab/.test(requireFn(pr, 'bulkGroupCard')));
  }

  console.log('\n[the Safety Center Hours tab]');
  const page = read('safety.html');
  const HOURS_DATA = {
    from: '2026-10-12', to: '2026-11-08',
    activities: SAFETY_JOBS.map(j => ({ id: j.id, label: j.label })),
    entries: [
      { id: '2', userId: 8, username: 'jhauser', fullName: 'Josh Hauser', workDate: '2026-10-29',
        jobId: 'safety:training', jobLabel: 'Safety Training', startTime: '06:00', endTime: '10:00',
        hours: 4, travelHours: 1, lunchBreak: false, supervisorName: 'Steve Travis',
        notes: '=HYPERLINK("http://evil","x") <img src=x onerror="window.__pwned=1">',
        status: 'approved', approvedAt: '2026-10-30T13:00:00Z', approvedBy: 'office' },
      { id: '1', userId: 7, username: 'strickallen', fullName: null, workDate: '2026-10-27',
        jobId: 'safety:meeting', jobLabel: 'Safety Meeting / Tailgate', startTime: '07:00', endTime: '07:30',
        hours: 0.5, travelHours: null, lunchBreak: false, supervisorName: 'Steve Travis', notes: null,
        status: 'approved', approvedAt: '2026-10-28T13:00:00Z', approvedBy: 'office' },
      // Filed against an activity since retired: keeps the label it was filed with.
      { id: '9', userId: 7, username: 'strickallen', fullName: null, workDate: '2026-10-14',
        jobId: 'safety:fit-test', jobLabel: 'Respirator Fit Test', startTime: '13:00', endTime: '14:00',
        hours: 1, travelHours: null, lunchBreak: false, supervisorName: null, notes: null,
        status: 'approved', approvedAt: '2026-10-15T13:00:00Z', approvedBy: 'office' },
    ],
    pending: [
      { id: '3', userId: 7, username: 'strickallen', fullName: null, workDate: '2026-11-02',
        jobId: 'safety:training', jobLabel: 'Safety Training', startTime: '07:00', endTime: '09:30',
        hours: 2.5, travelHours: null, lunchBreak: false, supervisorName: 'Steve Travis', notes: null,
        status: 'submitted', approvedAt: null, approvedBy: null },
    ],
    truncated: false,
  };

  function openSafety(user, { canManage, hours = HOURS_DATA } = {}) {
    const calls = [];
    const downloads = [];
    const dom = new JSDOM(page, {
      url: 'http://localhost/safety.html',
      runScripts: 'dangerously',
      beforeParse(win) {
        win.localStorage.setItem('fct_token', 'test-token');
        win.localStorage.setItem('fct_user', JSON.stringify(user));
        const ok = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        win.fetch = url => {
          const u = String(url);
          calls.push(u);
          if (u.startsWith('/api/safety-documents')) {
            return ok({ documents: [], statement: 'I have read it.', storageConfigured: true,
                        permissions: { canManage: Boolean(canManage) } });
          }
          // A function answers each read afresh — what payroll approved since.
          if (u.startsWith('/api/safety-hours')) return ok(typeof hours === 'function' ? hours() : hours);
          return ok({});
        };
        // The CSV download: keep the file, skip the navigation.
        win.URL.createObjectURL = blob => { downloads.push(blob); return 'blob:test'; };
        win.URL.revokeObjectURL = () => {};
        win.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
      },
    });
    return { win: dom.window, doc: dom.window.document, calls, downloads };
  }
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

  {
    const { win, doc, calls } = openSafety(
      { username: 'jhauser', companyCode: COMPANY, divisionRoles: { safety: 'level1' } }, { canManage: false });
    await settle();
    assert('crew do not see the Hours tab', doc.getElementById('tabHours').style.display === 'none');
    assert('  and the page never asks for the hours', !calls.some(u => u.includes('/api/safety-hours')));
    win.close();
  }
  {
    const { win, doc, calls, downloads } = openSafety(
      { username: 'travissteve', companyCode: COMPANY, divisionRoles: { safety: 'level3' } }, { canManage: true });
    await settle();
    const tab = doc.getElementById('tabHours');
    assert('a safety supervisor sees the Hours tab', tab.style.display === '', tab.style.display);
    assert('  and it is not read until it is opened', !calls.some(u => u.includes('/api/safety-hours')));

    tab.click();
    await settle();
    const read = calls.find(u => u.includes('/api/safety-hours')) || '';
    assert('opening it reads the hours', !!read, calls.join(' | '));
    const m = /from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/.exec(read);
    const day = s => new Date(s + 'T12:00:00');
    assert('  for four whole weeks by default, Monday to Sunday', !!m
      && day(m[1]).getDay() === 1 && day(m[2]).getDay() === 0
      && Math.round((day(m[2]) - day(m[1])) / 86400000) === 27, read);
    assert('  ending with the current week',
      !!m && day(m[2]) >= day(new Date().toISOString().slice(0, 10)) - 86400000, read);

    const panel = doc.getElementById('panelHours');
    assert('the panel is the one showing', panel.classList.contains('active'));
    const text = panel.textContent.replace(/\s+/g, ' ');
    assert('the total is the approved hours, and only those', /Approved safety hours 5\.50/.test(text), text.slice(0, 300));
    assert('  with the travel said beside it, not added in', /\+ 1\.00 h travel/.test(text));
    // Payroll totals a day as work + travel; the tab says that figure as well,
    // so the two can be checked against each other without arithmetic.
    assert('  and the total with travel, the figure payroll shows', /\+ 1\.00 h travel = 6\.50 h total/.test(text),
      text.slice(0, 300));
    assert('the day waiting on payroll is named, and kept out of the total',
      /1 entry \(2\.50 h\) in this range is waiting on payroll approval/.test(text), text.slice(0, 400));

    const acts = [...panel.querySelectorAll('.hrs-act')];
    assert('every standing activity is listed, and the retired one that was used',
      acts.length === SAFETY_JOBS.length + 1, acts.length);
    const actRow = name => acts.find(a => a.querySelector('.l').textContent === name);
    const training = actRow('Safety Training');
    assert('  training carries its hours', !!training && /^4\.00 h/.test(training.querySelector('.v').textContent),
      training ? training.textContent : 'no Safety Training row');
    assert('  an activity nobody did is shown at zero, stepped back',
      !!actRow('Incident Investigation') && actRow('Incident Investigation').classList.contains('none'));
    assert('  and a retired activity keeps the name it was filed under', !!actRow('Respirator Fit Test'));

    const tables = panel.querySelectorAll('table.hrs-table');
    assert('there is a by-employee table and a log', tables.length === 2, tables.length);
    const people = [...tables[0].querySelectorAll('tbody tr')].map(tr => tr.cells[0].textContent.trim());
    assert('  people most hours first, by the name they sign with',
      people.length === 2 && /^Josh Hauser/.test(people[0]) && /^strickallen/.test(people[1]), people.join(' | '));
    assert('  the login is still shown under a signed name', /jhauser/.test(people[0]));
    const heads = [...tables[0].querySelectorAll('thead th')].map(th => th.textContent.trim());
    const totalCol = heads.indexOf('Total');
    const josh = tables[0].querySelector('tbody tr');
    assert('  each person has a Total — work plus travel, the way payroll totals a day',
      totalCol > -1 && josh.cells[totalCol].textContent.trim() === '5.00', heads.join('|'));
    const foot = tables[0].querySelector('tfoot tr');
    assert('  and so does the table', totalCol > -1 && foot.cells[totalCol].textContent.trim() === '6.50');
    const log = [...tables[1].querySelectorAll('tbody tr')];
    assert('  one log row per approved day, newest first',
      log.length === 3 && /Josh Hauser/.test(log[0].cells[1].textContent) && /Respirator/.test(log[2].cells[2].textContent));

    assert('a note somebody typed is shown as text, never run',
      !panel.querySelector('td.notes img') && win.__pwned === undefined
      && /<img src=x/.test(panel.querySelector('td.notes').textContent));

    // The CSV.
    win.exportHoursCsv();
    const blob = downloads.find(d => d && typeof d === 'object');
    const name = downloads.find(d => typeof d === 'string');
    assert('Export CSV downloads a file named for the range', name === 'safety-hours-2026-10-12-to-2026-11-08.csv', name);
    // Read as bytes for the mark: decoding the file as UTF-8 (Blob.text) is
    // exactly what consumes it, so a check on the decoded text could never see it.
    const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
    const csv = blob ? await blob.text() : '';
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    assert('  marked UTF-8 for Excel', bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
      [...bytes.slice(0, 3)].map(b => b.toString(16)).join(' '));
    assert('  a header and one line per approved day — the pending one is not in it', lines.length === 4, lines.length);
    assert('  oldest first, the order a training record is kept in',
      /^2026-10-14,/.test(lines[1]) && /^2026-10-27,/.test(lines[2]) && /^2026-10-29,/.test(lines[3]), lines.join('\n'));
    assert('  with hours, travel and their total as numbers', /,4,1,5,/.test(lines[3]), lines[3]);
    assert('  and a note that opens like a formula is made to read as text',
      lines[3].includes(`"'=HYPERLINK(""http://evil"",""x"")`), lines[3]);
    win.close();
  }
  const SUP_USER = { username: 'travissteve', companyCode: COMPANY, divisionRoles: { safety: 'level3' } };
  {
    // Payroll approves days while this page sits open. Coming back to the tab
    // must show them, not the first read — the CSV is built from what is shown.
    let reads = 0;
    const later = Object.assign({}, HOURS_DATA, {
      entries: HOURS_DATA.entries.concat([Object.assign({}, HOURS_DATA.pending[0],
        { status: 'approved', approvedBy: 'office', approvedAt: '2026-11-02T18:00:00Z' })]),
      pending: [],
    });
    const { win, doc, calls } = openSafety(SUP_USER, { canManage: true, hours: () => (reads++ === 0 ? HOURS_DATA : later) });
    await settle();
    win.switchTab('hours'); await settle();
    win.switchTab('docs');  await settle();
    win.switchTab('hours'); await settle();
    const n = calls.filter(u => u.includes('/api/safety-hours')).length;
    assert('coming back to the Hours tab reads the hours again', n === 2, `${n} reads`);
    const text = doc.getElementById('panelHours').textContent.replace(/\s+/g, ' ');
    assert('  and shows the day payroll approved in the meantime',
      /Approved safety hours 8\.00/.test(text) && !/waiting on payroll/.test(text), text.slice(0, 300));
    win.close();
  }
  {
    // The Sign-Off Report's CSV goes out through the same writer as the hours
    // one, so a name somebody TYPED under a signature cannot open as a formula
    // in the office's spreadsheet either.
    const { win, downloads } = openSafety(SUP_USER, { canManage: true });
    await settle();
    win.eval(`state.report = [{
      document: { title: 'Ladders', weekOf: '2026-10-26' },
      signed: [{ username: 'mallory', fullName: '=HYPERLINK("http://evil","x")',
                 signedAt: '2026-10-27T12:00:00Z', hasDrawnSignature: false }],
      outstanding: [{ username: 'twhite' }],
    }];`);
    win.exportReportCsv();
    const blob = downloads.find(d => d && typeof d === 'object');
    const csv = blob ? await blob.text() : '';
    assert('the sign-off CSV keeps a typed name from opening as a formula',
      csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), csv);
    assert('  and still lists who has not signed', /twhite,,Not signed/.test(csv), csv);
    win.close();
  }
  {
    // An empty range says what would put something there.
    const { win, doc } = openSafety(
      { username: 'travissteve', companyCode: COMPANY, divisionRoles: { safety: 'level3' } },
      { canManage: true, hours: Object.assign({}, HOURS_DATA, { entries: [], pending: [] }) });
    await settle();
    win.switchTab('hours');
    await settle();
    const text = doc.getElementById('panelHours').textContent.replace(/\s+/g, ' ');
    assert('an empty range says how hours get here', /No approved safety hours/.test(text)
      && /Safety Center as the division on the Timesheet/.test(text), text.slice(0, 300));
    win.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
