'use strict';
/**
 * GET /api/scheduler/board[?today=YYYY-MM-DD]
 *
 * Cross-division master-schedule aggregation for the Scheduler division.
 *
 * Reads the ACTIVE jobs from the construction-project divisions that carry
 * bid items / sub-codes / Projection Planner schedules (turf + paving) and
 * returns, per sub-code, everything a master scheduler needs to staff people
 * across jobs:
 *   - bid vs running quantity, % complete, current & recent pace
 *   - crew productivity (units / laborer-day) from logged labor hours
 *   - crew + equipment history
 *   - sub-code start_date / target_date and the project deadline
 *   - planned working days remaining (from each job's Projection Planner)
 *   - required pace, gap and status (on-track / at-risk / behind / …)
 *
 * Also returns the company-wide employee and equipment rosters, and the
 * crew/equipment assignments already planned inside each division's
 * Projection Planner (so the master scheduler can import them as a baseline).
 *
 * Access: platform admins, or any user whose divisionRoles.scheduler is not
 * 'no_access'. STRICTLY READ-ONLY against source-division data — the master
 * scheduler's own assignments persist separately under the fct_scheduler_*
 * blob key via /api/data (gated to the scheduler division).
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const { readEmployeeRoster } = require('../lib/roster');
const { readEquipmentRoster } = require('../lib/equipment');

// Same "live job" definition the Timesheet job picker uses; empty/missing
// status is included so older jobs without a status still surface.
const ACTIVE_PROJECT_STATUSES = ['Awarded', 'In Progress', 'Substantially Complete'];

// Per-project opt-out set on the division dashboard's project info card
// ("Scheduler" select in tracker.html / paving.html / kiewit-pinetree.html).
// The twin of exclude-from-executive, which does the same job for the Executive
// rollup — a live project the master scheduler never staffs (owner-run work,
// a job another crew handles) is noise on the board, and this is how a PM
// takes it off without lying about the project's status.
//
// Opt-OUT, like the rollup toggle: a project with the flag unset is shown, so
// nothing already on the board disappears when this ships. Both key spellings
// are accepted because the dashboards write the hyphenated one and the
// normalized-table sync writes snake_case.
const projExcludedFromScheduler = p =>
  !!p && (p['exclude-from-scheduler'] === true || p.exclude_from_scheduler === true);

// Construction-project divisions that have schedulable sub-code work. Other
// divisions (trucking/dust/quarry) model "jobs" as customers/locations with
// no bid items, so they have nothing to pace at the sub-code level. Adding a
// division here later is all it takes to fold it into the master schedule.
const SOURCE_DIVISIONS = [
  { division: 'turf',   prefix: 'fct_project_',        index: 'fct_projects_index'        },
  { division: 'paving', prefix: 'fct_paving_project_', index: 'fct_paving_projects_index' },
  { division: 'kiewit', prefix: 'fct_kiewit_project_', index: 'fct_kiewit_projects_index' },
];

const HORIZON_DAYS = 120; // how far ahead to export Projection Planner assignments

// ── Date helpers (mirror tracker.html so the numbers match what PMs see) ────
function pad(n) { return String(n).padStart(2, '0'); }
function dateStrOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

function nthWeekday(year, month, weekday, n) {       // month 1-12, weekday 0=Sun
  const first = new Date(year, month - 1, 1).getDay();
  const offset = (weekday - first + 7) % 7;
  return new Date(year, month - 1, 1 + offset + (n - 1) * 7);
}
function lastWeekday(year, month, weekday) {
  const last = new Date(year, month, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month - 1, last.getDate() - offset);
}
function usHolidays(year) {
  const h = new Set();
  const ymd = (d) => dateStrOf(d);
  const fixedObs = (m, day) => {
    const dt = new Date(year, m - 1, day), dow = dt.getDay();
    if (dow === 0) dt.setDate(day + 1); else if (dow === 6) dt.setDate(day - 1);
    return ymd(dt);
  };
  h.add(fixedObs(1, 1));                       // New Year's Day
  h.add(ymd(nthWeekday(year, 1, 1, 3)));       // MLK Day
  h.add(ymd(nthWeekday(year, 2, 1, 3)));       // Presidents' Day
  h.add(ymd(lastWeekday(year, 5, 1)));         // Memorial Day
  h.add(fixedObs(6, 19));                      // Juneteenth
  h.add(fixedObs(7, 4));                       // Independence Day
  h.add(ymd(nthWeekday(year, 9, 1, 1)));       // Labor Day
  h.add(ymd(nthWeekday(year, 10, 1, 2)));      // Columbus Day
  h.add(fixedObs(11, 11));                     // Veterans Day
  h.add(ymd(nthWeekday(year, 11, 4, 4)));      // Thanksgiving
  h.add(fixedObs(12, 25));                     // Christmas
  return h;
}
const _holidayCache = {};
function isHoliday(ds) {
  const yr = ds.slice(0, 4);
  if (!_holidayCache[yr]) _holidayCache[yr] = usHolidays(parseInt(yr, 10));
  return _holidayCache[yr].has(ds);
}
/** Working days (Mon–Fri, excluding US federal holidays) from `fromStr` to
 *  `toStr` inclusive. Returns 0 when the window is empty or inverted. */
function workingDaysBetween(fromStr, toStr) {
  if (!fromStr || !toStr || fromStr > toStr) return 0;
  let count = 0;
  const cur = new Date(fromStr + 'T12:00:00');
  const end = new Date(toStr + 'T12:00:00');
  while (cur <= end) {
    const dow = cur.getDay();
    const ds = dateStrOf(cur);
    if (dow !== 0 && dow !== 6 && !isHoliday(ds)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Pacing helpers (compact ports of tracker.html's schedule math) ──────────
function ppProd(a) {
  const laborHours = a.labor_hours || 0, doneQty = a.running_qty || 0, daysWorked = a.dates.size;
  if (laborHours > 0 && doneQty > 0) return (doneQty / laborHours) * 8;
  const crewDaysTotal = a.crewDays.size;
  const avgCrew = (daysWorked > 0 && crewDaysTotal > 0) ? crewDaysTotal / daysWorked : a.employees.size;
  if (doneQty > 0 && daysWorked > 0 && avgCrew > 0) return (doneQty / daysWorked) / avgCrew;
  return null;
}
function ppWorkingDaysRemaining(sched, deadlineStr, todayStr) {
  if (!sched) return null;
  const deadlineD = deadlineStr ? new Date(deadlineStr + 'T23:59:59') : null;
  let workDays = 0, hasFuture = false;
  for (const [ds, day] of Object.entries(sched)) {
    if (ds < todayStr) continue;
    if (deadlineD && new Date(ds + 'T12:00:00') > deadlineD) continue;
    hasFuture = true;
    if (day.noWork) continue;
    workDays += day.halfDay ? 0.5 : 1;
  }
  return hasFuture ? Math.max(workDays, 0) : null;
}
function schedStatus(pct, gap, daysLeft, bidQty) {
  if (bidQty <= 0) return 'no-data';
  if (pct >= 100) return 'complete';
  if (daysLeft === null) return 'no-data';
  if (daysLeft < 0) return 'behind';
  if (gap === null || gap <= 0) return 'on-track';
  return (gap / bidQty) > 0.05 ? 'behind' : 'at-risk';
}

// ── Blob readers (mirror api/executive/report.js & timesheet-jobs.js) ───────
async function readIndexIds(sql, companyCode, indexKey) {
  const rows = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':' + indexKey}`;
  const v = rows.length ? rows[0].value : null;
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v && Array.isArray(v.ids)) return v.ids.filter(Boolean);
  return [];
}
async function readProjects(sql, companyCode, prefix, indexKey) {
  const ids = await readIndexIds(sql, companyCode, indexKey);
  if (!ids.length) return [];
  const keys = ids.map(id => companyCode + ':' + prefix + id);
  const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  return ids
    .map(id => byKey.get(companyCode + ':' + prefix + id))
    .filter(v => v && typeof v === 'object');
}

function aggregateDailyRows(rows) {
  const agg = {};
  (rows || []).forEach(row => {
    const key = (row.cost_code || '') + '||' + (row.sub_code || '');
    if (!agg[key]) agg[key] = {
      running_qty: 0, labor_hours: 0, dates: new Set(),
      employees: new Set(), equipment: new Set(), crewDays: new Set(), dailyByDate: {},
    };
    const a = agg[key];
    const qty = parseFloat(row.quantity) || 0;
    a.running_qty += qty;
    a.labor_hours += parseFloat(row.labor_hours) || 0;
    if (row.date) { a.dates.add(row.date); a.dailyByDate[row.date] = (a.dailyByDate[row.date] || 0) + qty; }
    const emp = (row.employee || '').trim();
    if (emp) { a.employees.add(emp); a.crewDays.add(row.date + '||' + emp); }
    const eq = (row.equipment || '').trim();
    if (eq) a.equipment.add(eq);
  });
  return agg;
}

function buildSubCode(bi, a, ppSched, deadline, todayStr) {
  const key = (bi.cost_code || '') + '||' + (bi.sub_code || '');
  const baseBidQty = parseFloat(bi.quantity) || 0;
  const coDelta = (bi.change_orders || []).reduce((s, co) => s + (parseFloat(co.qty_delta) || 0), 0);
  const bidQty = baseBidQty + coDelta;
  const runningQty = a ? a.running_qty : 0;
  const daysWorked = a ? a.dates.size : 0;
  const currentPace = daysWorked > 0 ? runningQty / daysWorked : 0;

  const dailySorted = a ? Object.entries(a.dailyByDate).sort(([x], [y]) => x.localeCompare(y)) : [];
  const last7 = dailySorted.slice(-7).map(([, q]) => q);
  const recentPace = last7.length >= 3 ? last7.reduce((s, q) => s + q, 0) / last7.length : currentPace;

  const pct = bidQty > 0 ? (runningQty / bidQty) * 100 : 0;
  const unitsLeft = Math.max(bidQty - runningQty, 0);
  const biDeadline = bi.target_date || deadline || null;
  let calDaysLeft = null;
  if (biDeadline) {
    // Past deadlines read as negative (overdue) so status resolves to "behind".
    calDaysLeft = biDeadline >= todayStr
      ? workingDaysBetween(todayStr, biDeadline)
      : -workingDaysBetween(biDeadline, todayStr);
  }

  const ppDays = ppWorkingDaysRemaining(ppSched, biDeadline, todayStr);
  const effectiveDaysLeft = ppDays !== null ? ppDays : calDaysLeft;
  const usingPPDays = ppDays !== null;

  const isLumpSum = (bi.unit || '').toUpperCase() === 'LS';
  const forcedComplete = !!bi.is_complete;
  const notStartedYet = !!(bi.start_date && bi.start_date > todayStr && daysWorked === 0);

  let plannedPace = null;
  if (bi.start_date && biDeadline) {
    const tw = workingDaysBetween(bi.start_date, biDeadline);
    if (tw > 0) plannedPace = bidQty / tw;
  }

  const requiredPace = (forcedComplete || isLumpSum || notStartedYet)
    ? (notStartedYet ? plannedPace : null)
    : (effectiveDaysLeft !== null && effectiveDaysLeft > 0) ? unitsLeft / effectiveDaysLeft : null;
  const gap = (!forcedComplete && !notStartedYet && !isLumpSum && requiredPace !== null)
    ? requiredPace - recentPace : null;
  const status = forcedComplete ? 'complete'
    : notStartedYet ? 'not-started'
    : isLumpSum ? (pct >= 100 ? 'complete' : effectiveDaysLeft !== null && effectiveDaysLeft < 0 ? 'behind' : pct > 0 ? 'on-track' : 'no-data')
    : schedStatus(pct, gap, effectiveDaysLeft, bidQty);

  const prod = a ? ppProd(a) : null;
  // Additional laborers to close the gap at the historical per-laborer rate.
  const addlLaborers = (gap !== null && gap > 0 && prod && prod > 0) ? Math.ceil(gap / prod) : null;

  return {
    key, costCode: bi.cost_code || '', subCode: bi.sub_code || '',
    description: bi.description || '', unit: bi.unit || '',
    bidQty, runningQty, pctComplete: Math.round(pct * 10) / 10, unitsLeft,
    bidValue: Math.round(bidQty * (parseFloat(bi.unit_cost) || 0)),
    startDate: bi.start_date || null, targetDate: bi.target_date || null,
    daysWorked, currentPace: round2(currentPace), recentPace: round2(recentPace),
    prod: prod !== null ? round2(prod) : null,
    crew: a ? [...a.employees] : [], equipment: a ? [...a.equipment] : [],
    ppPlannedDaysRemaining: ppDays, calendarWorkingDaysLeft: calDaysLeft,
    effectiveDaysLeft, usingPPDays,
    requiredPace: requiredPace !== null ? round2(requiredPace) : null,
    gap: gap !== null ? round2(gap) : null,
    addlLaborersNeeded: addlLaborers,
    isLumpSum, isComplete: forcedComplete, notStartedYet, status,
  };
}
function round2(n) { return Math.round(n * 100) / 100; }

function plannedAssignmentsFromSchedule(ppSchedule, todayStr, job) {
  // Flatten a project's Projection Planner into per-date resource rows so the
  // master scheduler can import what each division already planned.
  const out = [];
  if (!ppSchedule || typeof ppSchedule !== 'object') return out;
  const horizon = new Date(todayStr + 'T12:00:00');
  horizon.setDate(horizon.getDate() + HORIZON_DAYS);
  const horizonStr = dateStrOf(horizon);
  for (const [biKey, days] of Object.entries(ppSchedule)) {
    const [costCode, subCode] = biKey.split('||');
    for (const [ds, day] of Object.entries(days || {})) {
      if (ds < todayStr || ds > horizonStr || !day || day.noWork) continue;
      (day.employees || []).forEach(emp => out.push({
        date: ds, resource: emp, kind: 'emp', division: job.division,
        jobId: job.id, jobName: job.name, costCode, subCode: subCode || '', half: !!day.halfDay,
      }));
      (day.equipment || []).forEach(eq => out.push({
        date: ds, resource: eq, kind: 'equip', division: job.division,
        jobId: job.id, jobName: job.name, costCode, subCode: subCode || '', half: !!day.halfDay,
      }));
    }
  }
  return out;
}

// The same roster the "Manage employees" list shows — the canonical table plus
// the paving, kiewit and quarry lists. One definition, in api/lib/roster.js.
async function readEmployees(sql, companyCode) {
  try {
    const rows = await readEmployeeRoster(sql, companyCode);
    return rows.map(r => ({
      name: (r.name || '').trim(),
      jobClass: r.job_class || '',
      // The explicit role flags. The board groups crew by the job they do, and
      // job_class alone cannot tell a role from a wage tier.
      isSupervisor: r.is_supervisor === true,
      isDriver: r.is_driver === true,
      rateStd: parseFloat(r.non_prevailing_rate) || 0,
      ratePw: parseFloat(r.prevailing_rate) || parseFloat(r.non_prevailing_rate) || 0,
    })).filter(r => r.name);
  } catch (err) { console.warn('[scheduler/board] employees read failed:', err.message); return []; }
}
// ── Divisions whose work is a CUSTOMER, not a bid item ─────────────────────
// Turf, paving and kiewit are projects: they carry bid items, a quantity to
// chase and a pace to keep, and SOURCE_DIVISIONS reads them that way. Dust
// Control, EES and Trucking are not shaped like that and never will be. Their
// work is a customer and a pad, a wash, or a haul, and there is nothing
// underneath it to pace.
//
// They still belong on this board. A man sent to a dust pad on Tuesday is as
// unavailable as one on a turf job, and until all of them were here the board
// could answer "who is free" for only part of the company — which is the same
// as not answering it.
//
// So they arrive as jobs with NO sub-codes. The board already draws a job whose
// subCodes are empty without inventing a percentage for it (weightedPct returns
// null on an empty list) — the same shape the off-project rows use, and for the
// same reason: reporting 0% complete on work nobody measures that way would be
// worse than reporting nothing.
//
// WHERE THE NAMES COME FROM. Not from a reading of our own: from the very
// functions the Timesheet's job picker uses. The board and the picker have to
// give the SAME answer, because a man scheduled on a customer the picker has
// never heard of cannot book his hours against it — and a second reading of the
// same lists drifts the first time somebody adds one. (An earlier version of
// this read the Intercompany company list, which is a BILLING list: who gets
// invoiced under intercompany, a different and smaller set than who a division
// actually works for.)
const { dustJobs, truckingJobs, EES_JOBS } = require('../timesheet-jobs');

// EES is not a dust customer. Pre Loading and Washing are two standing
// activities — the recurring pre-load and wash work — and the Timesheet offers
// them beside the dust customers because that is where their hours are filed.
// On a schedule they read as their own line of work, so they are lifted out
// into a division of their own here, and they keep the timesheet's own job ids:
// a man scheduled on ees:washing and a man who books to ees:washing are on the
// same string, in both places.
const EES_IDS = new Set(EES_JOBS.map(j => j.id));
const asBoardJob = (division, id, name) => ({
  division, id, name, jobNumber: '',
  status: 'Active', deadline: null, subCodes: [], bidValue: 0,
});

/** The dust customers and the two EES activities, told apart. Neither keeps a
 *  schedule of its own, so both are ordinary scheduler rows — staffed here,
 *  saved here, and nowhere else. */
async function readDustAndEes(sql, companyCode) {
  try {
    const dust = [], ees = [];
    (await dustJobs(sql, companyCode)).forEach(j => {
      const name = String((j && j.label) || '').trim();
      if (!name || !j.id) return;
      const isEes = EES_IDS.has(j.id);
      (isEes ? ees : dust).push(asBoardJob(isEes ? 'ees' : 'dust', String(j.id), name));
    });
    return { dust, ees };
  } catch (err) {
    console.warn('[scheduler/board] dust and EES jobs read failed:', err.message);
    return { dust: [], ees: [] };
  }
}

// ── Trucking, read through from the dispatch board ─────────────────────────
// Trucking already has a schedule, and it is the one dispatchers work in. This
// board does not copy it: it reads it, shows the hauls as bookings like any
// other, and writes changes straight back to the blob they came from. There is
// one schedule, and two windows onto it.
//
// Each board's blob is { version, assignments: { 'YYYY-MM-DD': [ {id,driver,
// project,project_id,customer,unit,start,end,material,notes} ] }, hidden: [],
// deleted: {} }. All of it matters: anything written back has to preserve the
// parts this board does not model, so every row travels with the original under
// `src.row` and a write-back rebuilds from that rather than from what fits here.
const TRUCKING_BOARDS = [
  { key: 'fct_trucking_schedule',       label: 'Trucking', suffix: '' },
  { key: 'fct_trucking_labor_schedule', label: 'Trucking labor', suffix: ' (labor)' },
];
/** Identity by NAME, lowercased and space-collapsed. A haul's project_id is the
 *  better key on paper, but rows filed before project ids existed carry only a
 *  customer, and a board that split "Acme" into two rows because half its hauls
 *  predate a schema change is worse than one that occasionally joins two jobs
 *  that share a name. The name is also what a scheduler reads. */
function normKey(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
// What a haul is called here. project first, because that is what the trucking
// editor writes now; customer is the older spelling and is all a row filed
// before divisions existed has.
function haulJobName(a) { return String((a && (a.project || a.customer)) || '').trim() || 'Trucking'; }

/** The hauls already dispatched, as jobs and as bookings, plus a row for every
 *  trucking customer with nothing on yet — otherwise the only jobs you could
 *  staff here are the ones somebody had already staffed in Trucking. */
async function readTruckingBoards(sql, companyCode, todayStr) {
  const jobs = new Map(), assignments = {};
  const jobKeyOf = (boardKey, name) => boardKey + '¦' + normKey(name);
  const addJob = (b, name, row) => {
    const id = jobKeyOf(b.key, name);
    if (!jobs.has(id)) jobs.set(id, {
      division: 'trucking', id, name: String(name).trim() + b.suffix, jobNumber: '',
      status: 'Active', deadline: null, subCodes: [], bidValue: 0,
      // What a new haul booked here has to say about itself to be a haul in
      // Trucking's own blob, taken from the hauls already on this job.
      src: {
        key: b.key, label: b.label,
        project:   String((row && row.project) || name).trim(),
        projectId: String((row && row.project_id) || ''),
        customer:  String((row && row.customer) || '').trim(),
      },
    });
    return id;
  };

  for (const b of TRUCKING_BOARDS) {
    try {
      const rows = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':' + b.key}`;
      const v = rows.length ? rows[0].value : null;
      const byDate = (v && typeof v === 'object' && v.assignments && typeof v.assignments === 'object' && !Array.isArray(v.assignments))
        ? v.assignments : {};
      for (const [ds, list] of Object.entries(byDate)) {
        if (!Array.isArray(list) || !/^\d{4}-\d{2}-\d{2}$/.test(ds)) continue;
        // Forward work only. A dispatcher's archive is not this board's
        // business, and a base that stops at today is also what keeps a
        // write-back from ever reaching back and deleting history.
        if (ds < todayStr) continue;
        list.forEach((a, i) => {
          const driver = String((a && a.driver) || '').trim();
          if (!driver) return;
          const name = haulJobName(a);
          const jobId = addJob(b, name, a);
          // Trucking keys its own rows by id, so a row without one is already
          // invisible to its merge. It still tells us the driver is busy, so it
          // is shown — with an empty src.id, which is how the scheduler knows
          // not to try writing it back.
          const rid = String((a && a.id) || '');
          (assignments[ds] = assignments[ds] || []).push({
            id: 'tk¦' + b.key + '¦' + (rid || ds + '#' + i),
            resource: driver, kind: 'emp', division: 'trucking',
            jobId, jobName: jobs.get(jobId).name, costCode: '', half: false,
            unit:  String((a && a.unit)  || ''),
            start: String((a && a.start) || ''),
            end:   String((a && a.end)   || ''),
            // Where it came from: which blob, which row there, the job it sat
            // on when we read it (so a write-back can tell a move from a row
            // that never left), and the row itself, whole.
            src: { key: b.key, id: rid, jobId, row: a },
          });
        });
      }
    } catch (err) { console.warn('[scheduler/board] ' + b.key + ' read failed:', err.message); }
  }

  // Customers with no haul booked yet — otherwise the only jobs you could staff
  // here are the ones somebody had already staffed in Trucking. Off the same
  // roster the Timesheet's trucking picker reads, so a driver scheduled against
  // a customer here can book his hours against that same customer. Only on the
  // haul board: a labor call is raised against work, not against a name on a list.
  const haulBoard = TRUCKING_BOARDS[0];
  try {
    (await truckingJobs(sql, companyCode)).forEach(c => {
      const name = String((c && c.label) || '').trim();
      if (name) addJob(haulBoard, name, null);
    });
  } catch (err) { console.warn('[scheduler/board] trucking customers read failed:', err.message); }

  return { jobs: [...jobs.values()].sort((a, b) => a.name.localeCompare(b.name)), assignments };
}

// Off the same union the Timesheet picker reads (api/lib/equipment.js), for
// the reason readEmployees reads the shared roster: the board staffs turf,
// paving and kiewit alike, and the equipment_list table holds only turf's
// machines. Reading the table alone meant a paving job could never be given
// the paver it runs on.
async function readEquipment(sql, companyCode) {
  try {
    const rows = await readEquipmentRoster(sql, companyCode);
    return rows.map(r => (r.name || '').trim()).filter(Boolean);
  } catch (err) { console.warn('[scheduler/board] equipment read failed:', err.message); return []; }
}
// A FULL day off, in hours. The board asks a different question from payroll —
// not "what is he owed" but "is he here" — and the answer turns on this number,
// so it is named rather than written 8 in three places below.
//
// Mirrors PAID_LEAVE_HOURS in api/lib/payroll-metrics.js, which is where the
// rule lives. The two must agree: the same entry decides what a man is paid and
// whether a scheduler can put him on a job, and a board that thought a full day
// was six hours would quietly hand out half days nobody asked for.
const FULL_DAY_HOURS = 8;

/**
 * How long a time-off row says it is, and whether that leaves any of the day.
 *
 * WHY THE BOARD CARES. Half days happen — a man takes the morning for an
 * appointment and works the afternoon — and until the hours reached here the
 * board could only say "off", so it blocked the whole day. A four-hour morning
 * took a man off the schedule for eight, and the crew was planned around an
 * absence that was half imaginary.
 *
 *   hours → what the entry says, or a FULL day when it does not. Null is
 *           "nobody said", which is every row filed before payroll could ask;
 *           reading it as 0 would turn every one of them into a man who is
 *           somehow off for no time at all. Mirrors leaveHoursOf in
 *           api/lib/payroll-metrics.js.
 *   partial → he is here for some of the day. Strictly between nothing and a
 *           full day, and BOTH ends are deliberate:
 *             a full day (or longer) is a whole-day absence, plainly;
 *             ZERO is an UNPAID day off — he is gone all day and simply not
 *             paid for it, which is a payroll fact and not a scheduling one.
 *           So zero blocks exactly as eight does. Only an answer that leaves
 *           part of the day standing makes the man schedulable.
 */
function offShape(row) {
  const raw = row && row.time_off_hours;
  const n = raw == null ? null : Number(raw);
  // An unreadable figure is not a zero — the same judgement payroll makes. Fall
  // through to the answer the column refines: the whole day.
  const hours = (n == null || !Number.isFinite(n) || n < 0) ? FULL_DAY_HOURS : n;
  return { hours, partial: hours > 0 && hours < FULL_DAY_HOURS };
}

// Approved/pending time-off from the Timesheet division →
// name → { dateStr → { status, type, hours, partial } }.
// Pending (submitted) and approved both surface so a scheduler sees the risk early.
async function readTimeOff(sql, companyCode, todayStr) {
  try {
    const rows = await sql`
      SELECT te.work_date, te.status, te.time_off_type,
             -- How long the day off is. Without it every row reads as a whole
             -- day and a half-day morning takes the man off the board for the
             -- afternoon he is actually working.
             te.time_off_hours,
             COALESCE(NULLIF(TRIM(e.name), ''), te.username) AS name
      FROM   timesheet_entries te
      LEFT JOIN employees e ON e.id = te.employee_id
      WHERE  te.company_code = ${companyCode}
        AND  te.entry_type = 'time_off'
        AND  te.status IN ('submitted', 'approved')
        AND  te.work_date >= ${todayStr}::date`;
    const map = {};
    rows.forEach(r => {
      const name = (r.name || '').trim(); if (!name) return;
      const ds = String(r.work_date).slice(0, 10);
      (map[name] = map[name] || {})[ds] = Object.assign(
        { status: r.status, type: r.time_off_type || 'time off' }, offShape(r));
    });
    return map;
  } catch (err) { console.warn('[scheduler/board] time-off read failed:', err.message); return {}; }
}

/**
 * Build the whole board. Lifted out of the handler when api/ai/mathis.js became
 * a second caller: the assistant has to say what the Scheduler page says about
 * who is behind and who is double-booked, and the only way to guarantee that is
 * to run the same function rather than a second reading of the same blobs.
 */
async function buildBoard(sql, companyCode, todayStr) {
  const [employees, equipment, timeOff, dustEes, trucking, ...divisionProjects] = await Promise.all([
    readEmployees(sql, companyCode),
    readEquipment(sql, companyCode),
    readTimeOff(sql, companyCode, todayStr),
    readDustAndEes(sql, companyCode),
    readTruckingBoards(sql, companyCode, todayStr),
    ...SOURCE_DIVISIONS.map(s => readProjects(sql, companyCode, s.prefix, s.index)),
  ]);

  const jobs = [];
  const plannedAssignments = [];
  let excludedJobs = 0;

  SOURCE_DIVISIONS.forEach((src, i) => {
    (divisionProjects[i] || []).forEach(proj => {
      const name = (proj['project-name'] || proj.name || '').trim();
      if (!name) return;
      const status = (proj.status || '').trim();
      if (status && !ACTIVE_PROJECT_STATUSES.includes(status)) return;
      // Hidden on purpose from its division dashboard. Counted, not silent, so
      // the board can say why a job a PM expects to see is not on it.
      if (projExcludedFromScheduler(proj)) { excludedJobs++; return; }

      const id = String(proj.id || '');
      const deadline = proj['end-date'] || null;
      const ppSchedule = (proj.ppSchedule && typeof proj.ppSchedule === 'object') ? proj.ppSchedule : {};
      const agg = aggregateDailyRows(proj.dailyRows || []);

      const subCodes = (proj.bidItems || []).map(bi => {
        const k = (bi.cost_code || '') + '||' + (bi.sub_code || '');
        return buildSubCode(bi, agg[k] || null, ppSchedule[k] || null, deadline, todayStr);
      });

      const jobMeta = { division: src.division, id, name };
      plannedAssignments.push(...plannedAssignmentsFromSchedule(ppSchedule, todayStr, jobMeta));

      // Names seen on this job's daily rows are NOT folded into the roster.
      // Doing that put people in the Scheduler that nobody could find in
      // Manage — a name off an old daily row, a typo, somebody long gone —
      // and there was no way to tell them from the real roster. The roster is
      // the roster; the board flags anyone booked who has fallen off it.

      jobs.push({
        division: src.division, id, name,
        jobNumber: String(proj['job-number'] || proj.job_number || '').trim(),
        status: status || 'Active', deadline, subCodes,
        bidValue: subCodes.reduce((s, c) => s + (c.bidValue || 0), 0),
      });
    });
  });

  // Dust, EES and trucking rows join the project jobs. They carry no sub-codes,
  // so nothing downstream tries to pace them.
  jobs.push(...dustEes.dust, ...dustEes.ees, ...trucking.jobs);

  const equipOut = equipment.filter(Boolean).slice().sort((a, b) => a.localeCompare(b));
  employees.sort((a, b) => a.name.localeCompare(b.name));
  jobs.sort((a, b) => a.name.localeCompare(b.name));

  return {
    today: todayStr,
    employees,
    equipment: equipOut,
    jobs,
    plannedAssignments,
    timeOff,
    excludedJobs,
    // What trucking.html has already dispatched. Held apart from the
    // scheduler's own assignments so the board can draw it without it being
    // mistaken for something this board owns.
    truckingAssignments: trucking.assignments,
    // Every division the board draws — what the division filter offers.
    sourceDivisions: SOURCE_DIVISIONS.map(s => s.division).concat(['dust', 'ees', 'trucking']),
    // … and which of them run PROJECTS: bid items, a quantity to chase, a pace
    // to keep. Dust, EES and trucking rows are places to send a man, not work
    // with a pace, and anything counting or pacing jobs has to be able to tell
    // the two apart. (api/lib/mathis-digests.js counts active jobs off this;
    // without it, adding the rest of the company turned a customer list into a
    // project count.)
    projectDivisions: SOURCE_DIVISIONS.map(s => s.division),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = await requireAuth(req, res);
  if (!payload) return;
  if (!hasDivisionAccess(payload, 'scheduler')) {
    return res.status(403).json({ error: 'Scheduler access required' });
  }

  const todayStr = (typeof req.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today))
    ? req.query.today : new Date().toISOString().slice(0, 10);
  const sql = neon(process.env.DATABASE_URL);
  const companyCode = payload.companyCode;

  try {
    const board = await buildBoard(sql, companyCode, todayStr);
    return res.json({ generatedAt: new Date().toISOString(), ...board });
  } catch (err) {
    console.error('[scheduler/board]', err.message);
    return res.status(500).json({ error: 'Failed to build schedule board', detail: err.message });
  }
};

module.exports.buildBoard = buildBoard;
// Exported for scripts/test-sched-trucking.js, which runs both against a fake
// sql rather than grepping this file for the right-looking strings.
module.exports.readDustAndEes = readDustAndEes;
module.exports.readTruckingBoards = readTruckingBoards;
module.exports.schedStatus = schedStatus;
// Exported for scripts/test-sched-time-off.js, which checks this copy of the
// full-day rule against api/lib/payroll-metrics.js's.
module.exports.offShape = offShape;
module.exports.FULL_DAY_HOURS = FULL_DAY_HOURS;
