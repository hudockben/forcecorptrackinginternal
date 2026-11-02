'use strict';
/**
 * Safety Center — the hours the crew has put against safety work.
 *
 *   GET /api/safety-hours?from=YYYY-MM-DD&to=YYYY-MM-DD
 *     supervisors only →
 *     {
 *       from, to,                       the range read, as asked (null = open)
 *       activities: [{ id, label }],    SAFETY_JOBS, in the order the tab lists them
 *       entries:  [...],                APPROVED safety days — the hours log
 *       pending:  [...],                submitted, still waiting on payroll
 *       truncated: boolean              true when the range held more than MAX_ROWS
 *     }
 *
 * Where the hours come from. A laborer picks "Safety Center" as the division on
 * the Timesheet and one of the standing activities as the job (SAFETY_JOBS in
 * api/lib/safety.js). The day then goes to payroll's Pending Review and is
 * approved exactly as every other day is — the same queue, the same supervisor
 * routing, the same Approve, bulk approve and Un-approve buttons. Approval is
 * what makes the hours count here, as it is what makes a turf day reach turf's
 * cost tracking.
 *
 * What is different is that nothing is copied on approval. Every other division
 * gets a row written into its own tab, because each of those tabs prices and
 * bills the work and has columns of its own to add. The Safety Center does
 * neither — it needs to know who spent how long on what — so this reads
 * timesheet_entries, payroll's source of truth, directly. An un-approval or a
 * delete in payroll therefore takes the day off this tab by itself, and there
 * is no second record of the time to drift from the first.
 *
 * Supervisors only, on the same rule as the sign-off report (canManage in
 * safetyCapabilities): this is everybody's time, by name. A laborer sees his
 * own safety days where he sees the rest of his time, on the Timesheet.
 *
 * Read-only. It writes nothing anywhere.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth } = require('./lib/auth');
const { safetyCapabilities, SAFETY_DIVISION, SAFETY_JOBS } = require('./lib/safety');

// A ceiling on one read, not a page size. Fifty people filing a safety day a
// week is 2,600 rows a year, so a year's range sits well under it; the cap is
// there so a range typed as 1900–2100 costs one bounded query rather than an
// unbounded one, and the tab says so when it is hit instead of quietly showing
// totals that stop short.
const MAX_ROWS = 5000;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

// A calendar date the user typed, or null. Checked for being a real day as
// well as for its shape: '2026-02-30' matches the pattern, and Postgres would
// refuse it with an error the tab would show as "Database error" rather than as
// the date being wrong.
function safeYmd(v) {
  const s = String(v == null ? '' : v).trim();
  if (!YMD.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function entryOut(r, names) {
  return {
    id:             String(r.id),
    userId:         r.user_id == null ? null : Number(r.user_id),
    username:       r.username,
    // The name this person last typed under a Safety Center signature — the
    // same answer the Sign Rate gives to "who is this login". Null for
    // somebody who has never signed anything here; the tab shows the login.
    fullName:       (names && names.get(Number(r.user_id))) || null,
    workDate:       r.work_date,
    jobId:          r.job_id,
    jobLabel:       r.job_label,
    startTime:      r.start_time || null,
    endTime:        r.end_time || null,
    hours:          num(r.computed_hours) || 0,
    travelHours:    num(r.travel_hours),
    lunchBreak:     r.lunch_break == null ? null : Boolean(r.lunch_break),
    supervisorName: r.supervisor_name || null,
    notes:          r.notes || null,
    status:         r.status,
    submittedAt:    r.submitted_at || null,
    approvedAt:     r.approved_at || null,
    approvedBy:     r.approved_by_name || null,
  };
}

/**
 * user id → the full name they most recently signed a Safety Center form with.
 *
 * Best effort. A name is a courtesy beside the login, never the record, so a
 * failed read (or a deployment whose schema predates safety_signatures) costs
 * the names and not the hours.
 */
async function signedNames(sql, companyCode, userIds) {
  const ids = [...new Set(userIds.filter(id => Number.isInteger(id)))];
  const names = new Map();
  if (!ids.length) return names;
  try {
    const rows = await sql`
      SELECT DISTINCT ON (user_id) user_id, full_name
        FROM safety_signatures
       WHERE company_code = ${companyCode}
         AND user_id = ANY(${ids}::int[])
       ORDER BY user_id, signed_at DESC
    `;
    for (const r of rows) {
      const n = String(r.full_name || '').trim();
      if (n) names.set(Number(r.user_id), n);
    }
  } catch (err) {
    console.warn('[safety-hours] signer names unavailable:', err.message);
  }
  return names;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = await requireAuth(req, res);
  if (!payload) return;

  // The payload is the account as Manage Users has it now (requireAuth reads
  // the row), so a supervisor demoted to crew loses this on their next request.
  const caps = safetyCapabilities(payload);
  if (!caps.canView) {
    return res.status(403).json({ error: 'You do not have access to the Safety Center' });
  }
  if (!caps.canManage) {
    return res.status(403).json({ error: 'The safety hours log is for safety supervisors' });
  }

  const q = req.query || {};
  // Blank means open-ended on that side. Anything else has to be a real date —
  // a typo silently read as "no limit" would answer a question nobody asked.
  const from = safeYmd(q.from);
  const to   = safeYmd(q.to);
  if (q.from && !from) return res.status(400).json({ error: 'from must be a date (YYYY-MM-DD)' });
  if (q.to   && !to)   return res.status(400).json({ error: 'to must be a date (YYYY-MM-DD)' });
  if (from && to && from > to) {
    return res.status(400).json({ error: 'from is after to — pick the earlier date first' });
  }

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    // Submitted and approved only. A draft is a day the laborer has not handed
    // in yet; it is his until he does, and payroll cannot see it either.
    //
    // work_date as text so a DATE never crosses a timezone on its way out (see
    // dateOnly in api/lib/safety.js for how that has bitten this repo), and the
    // NUMERIC columns as float because the driver hands NUMERIC back as a
    // string, which would make every total here a concatenation.
    const rows = await sql`
      SELECT id, user_id, username, status,
             work_date::text              AS work_date,
             job_id, job_label, start_time, end_time,
             computed_hours::float        AS computed_hours,
             travel_hours::float          AS travel_hours,
             lunch_break, supervisor_name, notes,
             submitted_at, approved_at, approved_by_name
        FROM timesheet_entries
       WHERE company_code = ${companyCode}
         AND entry_type   = 'daily'
         AND division     = ${SAFETY_DIVISION}
         AND status IN ('submitted', 'approved')
         AND (${from}::date IS NULL OR work_date >= ${from}::date)
         AND (${to}::date   IS NULL OR work_date <= ${to}::date)
       ORDER BY work_date DESC, LOWER(username) ASC, start_time ASC NULLS LAST, id ASC
       LIMIT ${MAX_ROWS + 1}
    `;

    const truncated = rows.length > MAX_ROWS;
    const kept = truncated ? rows.slice(0, MAX_ROWS) : rows;
    const names = await signedNames(sql, companyCode, kept.map(r => Number(r.user_id)));
    const out = kept.map(r => entryOut(r, names));

    return res.json({
      from, to,
      activities: SAFETY_JOBS.map(j => ({ id: j.id, label: j.label })),
      entries: out.filter(e => e.status === 'approved'),
      pending: out.filter(e => e.status === 'submitted'),
      truncated,
    });
  } catch (err) {
    console.error('[safety-hours]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// Exposed for scripts/test-safety-hours.js.
module.exports._test = { safeYmd, MAX_ROWS };
