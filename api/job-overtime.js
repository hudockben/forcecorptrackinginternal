'use strict';
/**
 * GET /api/job-overtime?division=turf|paving|kiewit
 *   → { division, jobs: { [jobId]: { otHours, weeks, lastWeek, lastWeekOt } } }
 *
 * Overtime hours per job, for the OT Hours column on Analytics ▸ Financials.
 * A running total: every week payroll has in hand, added up, so it grows week
 * over week as timesheets come in.
 *
 * OVERTIME IS NOT RE-MEASURED PER JOB, and this must never try to. The fortieth
 * hour is a fact about an EMPLOYEE'S WEEK across every job and every division
 * he touched — a man with 38 hours on a turf job who picks up six on a paving
 * job put the PAVING job into overtime, and nothing about either job read on
 * its own says so. So each employee's weeks are measured whole by payroll's own
 * weeklyOvertime (api/lib/payroll-metrics.js), which decides which entries the
 * overtime fell on — the ones worked after the fortieth hour — and those
 * entries are credited to the jobs they were filed against. That is exactly
 * how Payroll ▸ Reports ▸ Projects posts it (projectKeyOf in payroll.html), so
 * the two show the same hours for the same job.
 *
 * Which days count is payroll's rule too: submitted and approved daily entries,
 * work plus travel; time off never pushes a week past forty.
 *
 * Only per-job totals leave this endpoint — no names, no days — and only for
 * the division asked about. It is read by the Financials tab, so it opens to
 * the same people that tab does: access to the division, and a role that is
 * shown Financials (level1, level2 and sales are not).
 */
const { neon } = require('@neondatabase/serverless');
const { requireDivision, levelFor } = require('./lib/auth');
const { weeklyOvertime } = require('./lib/payroll-metrics');

// The divisions whose jobs are projects with a Financials tab. A timesheet
// job_id in these is the project's id (api/timesheet-jobs.js).
const JOB_DIVISIONS = new Set(['turf', 'paving', 'kiewit']);
// Roles the division pages hide Financials from (perm.visibleTabs).
const NO_FINANCIALS = new Set(['level1', 'level2', 'sales']);

const round2 = v => Math.round(v * 100) / 100;

/**
 * Credit each employee's overtime to the jobs in `division` it fell on.
 * Pure, so the arithmetic can be tested without a database.
 */
function jobOvertime(entries, division) {
  const byUser = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e) continue;
    // Keyed by username, as payroll keys its employees.
    const u = e.username || '—';
    if (!byUser.has(u)) byUser.set(u, []);
    byUser.get(u).push(e);
  }

  const jobs = new Map();
  for (const list of byUser.values()) {
    for (const w of weeklyOvertime(list).weeks) {
      for (const r of w.rows) {
        if (!(r.otHours > 0) || r.entry.division !== division) continue;
        // A day filed against no job cannot be put on any project's row.
        const id = String(r.entry.job_id == null ? '' : r.entry.job_id).trim();
        if (!id) continue;
        if (!jobs.has(id)) jobs.set(id, { otHours: 0, weeks: new Map() });
        const j = jobs.get(id);
        j.otHours += r.otHours;
        j.weeks.set(w.weekStart, (j.weeks.get(w.weekStart) || 0) + r.otHours);
      }
    }
  }

  const out = {};
  for (const [id, j] of jobs) {
    const lastWeek = [...j.weeks.keys()].sort().pop();
    out[id] = {
      otHours:    round2(j.otHours),
      weeks:      j.weeks.size,
      lastWeek,
      lastWeekOt: round2(j.weeks.get(lastWeek)),
    };
  }
  return out;
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const guard = await requireDivision(req, res, { required: true });
  if (!guard) return;
  const { payload, division } = guard;
  if (!JOB_DIVISIONS.has(division)) {
    return res.status(400).json({ error: 'division must be turf, paving or kiewit' });
  }
  if (NO_FINANCIALS.has(levelFor(payload, division))) {
    return res.status(403).json({ error: 'Your role does not include Financials' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    // Every counted day of every employee who has ever booked one to this
    // division — in ANY division, because the forty is counted across all of
    // them. id and created_at are the tiebreaks weeklyOvertime orders a
    // shared date by, and the reason they are selected.
    const entries = await sql`
      SELECT id, username, entry_type, status, work_date, created_at,
             division, job_id, computed_hours, travel_hours
      FROM timesheet_entries
      WHERE company_code = ${payload.companyCode}
        AND entry_type   = 'daily'
        AND status IN ('submitted', 'approved')
        AND username IN (
          SELECT username FROM timesheet_entries
          WHERE company_code = ${payload.companyCode}
            AND division     = ${division}
            AND entry_type   = 'daily'
            AND status IN ('submitted', 'approved')
        )
    `;
    return res.json({ division, jobs: jobOvertime(entries, division) });
  } catch (err) {
    console.error('[job-overtime]', err.message);
    return res.status(500).json({ error: 'Could not read overtime from payroll' });
  }
}

module.exports = handler;
module.exports.jobOvertime = jobOvertime;
