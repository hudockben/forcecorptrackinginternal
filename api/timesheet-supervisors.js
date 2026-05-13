'use strict';
/**
 * Supervisors dropdown for the Timesheet form.
 *
 *   GET /api/timesheet-supervisors
 *     → { supervisors: [{ id, name }, ...] }
 *
 * Source: the existing `employees` table, filtered by is_supervisor = TRUE.
 * No new table — admins flag supervisors directly on the employee row.
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
    let rows;
    try {
      rows = await sql`
        SELECT id, name FROM employees
        WHERE company_code  = ${payload.companyCode}
          AND is_supervisor = TRUE
          AND (active = TRUE OR active IS NULL)
        ORDER BY name ASC
      `;
    } catch {
      rows = [];
    }
    return res.json({ supervisors: rows.map(r => ({ id: r.id, name: r.name })) });
  } catch (err) {
    console.error('[timesheet-supervisors]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};
