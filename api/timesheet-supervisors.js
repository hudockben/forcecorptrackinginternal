'use strict';
/**
 * Supervisors dropdown for the Timesheet form, plus the caller's own driver flag.
 *
 *   GET /api/timesheet-supervisors
 *     → { supervisors: [{ id, name }, ...], is_driver: <bool> }
 *
 * `is_driver` describes the CALLER, not the supervisor list: it is true when the
 * signed-in user is flagged employees.is_driver = TRUE. The Timesheet form uses
 * it for one purpose — deciding whether to ask "was this a haul?" on each job
 * block. It rides along on this request because the form already awaits it
 * before first paint, so the question is there the moment a driver opens the
 * page rather than appearing a beat later.
 *
 * Source: employees rows flagged is_supervisor = TRUE, INNER JOINed to the
 * users table on username so only user accounts surface in the dropdown.
 * The Supervisors sub-tab on divisions.html drives the toggle off the users
 * list, and the field-employee Timesheet picker matches it 1:1. Stale
 * supervisor rows whose name doesn't correspond to a user (e.g. carryover
 * from when the roster sourced the list) are silently filtered out.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;

  const allowed =
    hasDivisionAccess(payload, 'timesheet') ||
    hasDivisionAccess(payload, 'payroll')   ||
    payload.isPlatformAdmin;
  if (!allowed) {
    return res.status(403).json({ error: 'Timesheet or Payroll access required' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // Tolerate fresh deploys where the column hasn't been migrated yet.
    // We surface u.username (not e.name) so the dropdown always reads
    // straight from the user account — even if the employees row's name
    // drifted in casing or trailing whitespace from when the toggle wrote.
    let rows;
    try {
      rows = await sql`
        SELECT e.id, u.username AS name
        FROM   employees e
        INNER JOIN users u
          ON LOWER(u.username) = LOWER(e.name)
         AND u.company_code   = e.company_code
        WHERE  e.company_code  = ${payload.companyCode}
          AND  e.is_supervisor = TRUE
          AND (e.active = TRUE OR e.active IS NULL)
        ORDER BY u.username ASC
      `;
    } catch {
      rows = [];
    }
    // The caller's own driver flag. Same tolerance as above: a deploy that has
    // not run the migration yet simply reports false, which is the pre-existing
    // behaviour (no hauling question) rather than an error.
    let isDriver = false;
    try {
      const [me] = await sql`
        SELECT is_driver FROM employees
        WHERE  company_code = ${payload.companyCode}
          AND  LOWER(name)  = LOWER(${payload.username || ''})
          AND (active = TRUE OR active IS NULL)
        LIMIT 1
      `;
      isDriver = !!(me && me.is_driver);
    } catch {
      isDriver = false;
    }

    return res.json({
      supervisors: rows.map(r => ({ id: r.id, name: r.name })),
      is_driver:   isDriver,
    });
  } catch (err) {
    console.error('[timesheet-supervisors]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
