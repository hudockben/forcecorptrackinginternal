'use strict';
/**
 * GET /api/trucking-driver-reports?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   → { reports: [{ assignment_id, work_date, driver_name, tons, loads,
 *                   actual_start, actual_end, tickets, notes, submitted_at }] }
 *
 * The office side of the driver reports — what came back against the hauls the
 * Scheduler handed out. Read-only: a report is the driver's account of their
 * own day, so the office reads it and reconciles against it rather than
 * editing it. Correcting a haul means correcting the schedule or the payroll
 * entry, both of which have their own owners.
 *
 * Gated on the trucking division. Drivers use /api/driver/schedule, which
 * answers with their rows alone.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function pad(n) { return String(n).padStart(2, '0'); }
function dstr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(ds, n) { const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return dstr(d); }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = requireAuth(req, res);
  if (!payload) return;
  if (!hasDivisionAccess(payload, 'trucking')) {
    return res.status(403).json({ error: 'You do not have access to this division\'s data' });
  }

  const { companyCode } = payload;
  const sql = neon(process.env.DATABASE_URL);

  const today = dstr(new Date());
  let from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : addDays(today, -30);
  let to   = DATE_RE.test(String(req.query.to   || '')) ? req.query.to   : today;
  if (to < from) { const t = from; from = to; to = t; }
  if (to > addDays(from, MAX_RANGE_DAYS)) to = addDays(from, MAX_RANGE_DAYS);

  try {
    const rows = await sql`
      SELECT assignment_id, work_date, driver_name, username,
             tons, loads, actual_start, actual_end, tickets, notes,
             submitted_at, updated_at
        FROM trucking_driver_reports
       WHERE company_code = ${companyCode}
         AND work_date BETWEEN ${from}::date AND ${to}::date
       ORDER BY work_date DESC, driver_name`;
    return res.json({
      from, to,
      reports: (rows || []).map(r => ({
        ...r,
        work_date: String(r.work_date).slice(0, 10),
        tons:  r.tons  === null ? null : Number(r.tons),
        loads: r.loads === null ? null : Number(r.loads),
      })),
    });
  } catch (err) {
    console.error('[trucking-driver-reports]', err.message);
    return res.status(500).json({ error: 'Could not load driver reports' });
  }
};
