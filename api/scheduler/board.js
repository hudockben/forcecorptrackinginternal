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

// Same "live job" definition the Timesheet job picker uses; empty/missing
// status is included so older jobs without a status still surface.
const ACTIVE_PROJECT_STATUSES = ['Awarded', 'In Progress', 'Substantially Complete'];

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

async function readEmployees(sql, companyCode) {
  try {
    const rows = await sql`
      SELECT name, job_class, is_supervisor, pw_rate, non_pw_rate
      FROM   employees
      WHERE  company_code = ${companyCode} AND active = TRUE
      ORDER  BY sort_order ASC, name ASC`;
    return rows.map(r => ({ name: (r.name || '').trim(), jobClass: r.job_class || '', isSupervisor: !!r.is_supervisor,
        rateStd: parseFloat(r.non_pw_rate) || 0, ratePw: parseFloat(r.pw_rate) || parseFloat(r.non_pw_rate) || 0 }))
      .filter(r => r.name);
  } catch (err) { console.warn('[scheduler/board] employees read failed:', err.message); return []; }
}
async function readEquipment(sql, companyCode) {
  try {
    const rows = await sql`
      SELECT name FROM equipment_list
      WHERE  company_code = ${companyCode} AND active = TRUE
      ORDER  BY sort_order ASC, name ASC`;
    return rows.map(r => (r.name || '').trim()).filter(Boolean);
  } catch (err) { console.warn('[scheduler/board] equipment read failed:', err.message); return []; }
}
// Approved/pending time-off from the Timesheet division → name → { dateStr → {status,type} }.
// Pending (submitted) and approved both surface so a scheduler sees the risk early.
async function readTimeOff(sql, companyCode, todayStr) {
  try {
    const rows = await sql`
      SELECT te.work_date, te.status, te.time_off_type,
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
      (map[name] = map[name] || {})[ds] = { status: r.status, type: r.time_off_type || 'time off' };
    });
    return map;
  } catch (err) { console.warn('[scheduler/board] time-off read failed:', err.message); return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (!hasDivisionAccess(payload, 'scheduler')) {
    return res.status(403).json({ error: 'Scheduler access required' });
  }

  const todayStr = (typeof req.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today))
    ? req.query.today : new Date().toISOString().slice(0, 10);
  const sql = neon(process.env.DATABASE_URL);
  const companyCode = payload.companyCode;

  try {
    const [employees, equipment, timeOff, ...divisionProjects] = await Promise.all([
      readEmployees(sql, companyCode),
      readEquipment(sql, companyCode),
      readTimeOff(sql, companyCode, todayStr),
      ...SOURCE_DIVISIONS.map(s => readProjects(sql, companyCode, s.prefix, s.index)),
    ]);

    const jobs = [];
    const plannedAssignments = [];
    const rosterEmp = new Set(employees.map(e => e.name));
    const rosterEquip = new Set(equipment);

    SOURCE_DIVISIONS.forEach((src, i) => {
      (divisionProjects[i] || []).forEach(proj => {
        const name = (proj['project-name'] || proj.name || '').trim();
        if (!name) return;
        const status = (proj.status || '').trim();
        if (status && !ACTIVE_PROJECT_STATUSES.includes(status)) return;

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

        // Fold any crew/equipment seen on this job into the roster so the
        // scheduler always shows everyone actually working, even if a name
        // never made it into the canonical roster tables.
        (proj.assigned_employees || []).forEach(n => n && rosterEmp.add(String(n).trim()));
        (proj.assigned_equipment || []).forEach(n => n && rosterEquip.add(String(n).trim()));
        subCodes.forEach(sc => { sc.crew.forEach(n => rosterEmp.add(n)); sc.equipment.forEach(n => rosterEquip.add(n)); });

        jobs.push({
          division: src.division, id, name,
          jobNumber: String(proj['job-number'] || proj.job_number || '').trim(),
          status: status || 'Active', deadline, subCodes,
          bidValue: subCodes.reduce((s, c) => s + (c.bidValue || 0), 0),
        });
      });
    });

    // Merge project-derived names that aren't in the roster tables.
    const knownEmp = new Set(employees.map(e => e.name));
    rosterEmp.forEach(n => { if (n && !knownEmp.has(n)) employees.push({ name: n, jobClass: '', isSupervisor: false, rateStd: 0, ratePw: 0 }); });
    const equipOut = [...rosterEquip].filter(Boolean).sort((a, b) => a.localeCompare(b));
    employees.sort((a, b) => a.name.localeCompare(b.name));

    jobs.sort((a, b) => a.name.localeCompare(b.name));

    return res.json({
      generatedAt: new Date().toISOString(),
      today: todayStr,
      employees,
      equipment: equipOut,
      jobs,
      plannedAssignments,
      timeOff,
      sourceDivisions: SOURCE_DIVISIONS.map(s => s.division),
    });
  } catch (err) {
    console.error('[scheduler/board]', err.message);
    return res.status(500).json({ error: 'Failed to build schedule board', detail: err.message });
  }
};
