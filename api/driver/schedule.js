'use strict';
/**
 * GET  /api/driver/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
 * POST /api/driver/schedule   { assignment_id, tons, loads, actual_start,
 *                               actual_end, tickets, notes }
 *
 * The driver's side of the Trucking Scheduler: the hauls assigned to whoever
 * is signed in, and what they report back against them.
 *
 * Everything is resolved server-side on purpose. A driver has the 'driver'
 * division and nothing else, which means no read of fct_trucking_schedule (the
 * whole company's board, every driver, every customer) and no read of
 * fct_truck_division (the division's rates, invoices and revenue). This
 * endpoint opens both with the server's credentials and hands back only the
 * rows that name the caller — so the phone never holds anything it should not,
 * whatever the page asks for.
 *
 * Identity comes from the username → driver map the trucking office keeps at
 * fct_trucking_driver_logins. A login the office has not mapped resolves to no
 * driver and is answered with an empty schedule and mapped:false, never with
 * somebody else's day. Matching is case-insensitive on the username because
 * that is what people type at a sign-in box; the driver name is returned
 * exactly as the schedule spells it, since that is the key the board and the
 * printed dispatch sheets are written against.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');

const SCHEDULE_KEY = 'fct_trucking_schedule';
const LOGINS_KEY   = 'fct_trucking_driver_logins';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const MAX_RANGE_DAYS = 120;   // a driver looking at their own hauls, not an export
const MAX_TEXT       = 500;

function pad(n) { return String(n).padStart(2, '0'); }
function dstr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDays(ds, n) { const d = new Date(ds + 'T12:00:00'); d.setDate(d.getDate() + n); return dstr(d); }

async function readBlob(sql, companyCode, key) {
  const rows = await sql`SELECT value FROM app_data WHERE key = ${companyCode + ':' + key}`;
  const v = rows && rows[0] && rows[0].value;
  return v && typeof v === 'object' ? v : null;
}

/** The driver name this login is mapped to, or null. */
async function resolveDriver(sql, companyCode, username) {
  const blob = await readBlob(sql, companyCode, LOGINS_KEY);
  const map  = blob && blob.map && typeof blob.map === 'object' ? blob.map : {};
  const want = String(username || '').trim().toLowerCase();
  if (!want) return null;
  for (const [u, driver] of Object.entries(map)) {
    if (String(u).trim().toLowerCase() === want && typeof driver === 'string' && driver.trim()) {
      return driver;
    }
  }
  return null;
}

/** { date → [assignment] } for one driver, within [from, to]. */
async function assignmentsFor(sql, companyCode, driver, from, to) {
  const blob = await readBlob(sql, companyCode, SCHEDULE_KEY);
  const all  = blob && blob.assignments && typeof blob.assignments === 'object' ? blob.assignments : {};
  const out  = {};
  Object.keys(all).forEach(date => {
    if (!DATE_RE.test(date) || date < from || date > to) return;
    const mine = (Array.isArray(all[date]) ? all[date] : []).filter(a => a && a.driver === driver);
    if (mine.length) out[date] = mine;
  });
  return out;
}

function num(v, { int = false } = {}) {
  if (v === '' || v === null || v === undefined) return null;
  const n = int ? parseInt(v, 10) : parseFloat(v);
  if (!isFinite(n) || n < 0) return null;
  return n;
}
function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, MAX_TEXT);
  return s || null;
}
function time(v) {
  const s = String(v || '').trim();
  return TIME_RE.test(s) ? s : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  // The trucking office is allowed in too, so the Scheduler can preview what a
  // driver is being shown without a second endpoint.
  if (!hasDivisionAccess(payload, 'driver') && !hasDivisionAccess(payload, 'trucking')) {
    return res.status(403).json({ error: 'You do not have access to driver schedules' });
  }

  const { companyCode, username, userId } = payload;
  const sql = neon(process.env.DATABASE_URL);

  try {
    const driver = await resolveDriver(sql, companyCode, username);

    // ── GET — my hauls, with whatever I have already reported ──────────────
    if (req.method === 'GET') {
      const today = dstr(new Date());
      let from = DATE_RE.test(String(req.query.from || '')) ? req.query.from : today;
      let to   = DATE_RE.test(String(req.query.to   || '')) ? req.query.to   : from;
      if (to < from) { const t = from; from = to; to = t; }
      // Clamp rather than reject: a bad range should show a short schedule,
      // not an error on the one screen a driver opens at 5am.
      if (to > addDays(from, MAX_RANGE_DAYS)) to = addDays(from, MAX_RANGE_DAYS);

      if (!driver) {
        return res.json({ mapped: false, driver: null, username, from, to, days: [] });
      }

      const byDate  = await assignmentsFor(sql, companyCode, driver, from, to);
      const reports = await sql`
        SELECT assignment_id, tons, loads, actual_start, actual_end, tickets, notes,
               submitted_at, updated_at
          FROM trucking_driver_reports
         WHERE company_code = ${companyCode}
           AND driver_name  = ${driver}
           AND work_date BETWEEN ${from}::date AND ${to}::date`;
      const byId = new Map((reports || []).map(r => [r.assignment_id, r]));

      const days = Object.keys(byDate).sort().map(date => ({
        date,
        assignments: byDate[date]
          .slice()
          .sort((a, b) => String(a.start || '~').localeCompare(String(b.start || '~')))
          .map(a => ({
            id:       a.id,
            start:    a.start || '',
            end:      a.end || '',
            customer: a.customer || '',
            location: a.location || '',
            address:  a.address || '',
            unit:     a.unit || '',
            notes:    a.notes || '',
            report:   byId.get(a.id) || null,
          })),
      }));

      return res.json({ mapped: true, driver, username, from, to, days });
    }

    // ── POST — report back against one of my hauls ─────────────────────────
    if (req.method === 'POST') {
      if (!driver) {
        return res.status(403).json({
          error: 'This login is not linked to a driver yet. Ask the office to link it in Manage Lists.',
        });
      }
      const body = req.body || {};
      const id   = String(body.assignment_id || '').trim();
      if (!id) return res.status(400).json({ error: 'assignment_id is required' });

      // The assignment has to exist, be on the schedule, and be this driver's.
      // Checked against the board rather than trusting the id in the request,
      // so one driver cannot file tons against another's haul.
      const blob = await readBlob(sql, companyCode, SCHEDULE_KEY);
      const all  = blob && blob.assignments && typeof blob.assignments === 'object' ? blob.assignments : {};
      let workDate = null;
      for (const date of Object.keys(all)) {
        if (!DATE_RE.test(date)) continue;
        const hit = (Array.isArray(all[date]) ? all[date] : []).find(a => a && a.id === id);
        if (hit) { workDate = hit.driver === driver ? date : null; break; }
      }
      if (!workDate) {
        return res.status(404).json({ error: 'That haul is not on your schedule.' });
      }

      const row = {
        tons:   num(body.tons),
        loads:  num(body.loads, { int: true }),
        start:  time(body.actual_start),
        end:    time(body.actual_end),
        tickets: text(body.tickets),
        notes:   text(body.notes),
      };

      await sql`
        INSERT INTO trucking_driver_reports
          (assignment_id, company_code, work_date, driver_name, user_id, username,
           tons, loads, actual_start, actual_end, tickets, notes, submitted_at, updated_at)
        VALUES
          (${id}, ${companyCode}, ${workDate}::date, ${driver}, ${userId || null}, ${username || null},
           ${row.tons}, ${row.loads}, ${row.start}, ${row.end}, ${row.tickets}, ${row.notes}, NOW(), NOW())
        ON CONFLICT (company_code, assignment_id) DO UPDATE SET
           work_date    = EXCLUDED.work_date,
           driver_name  = EXCLUDED.driver_name,
           user_id      = EXCLUDED.user_id,
           username     = EXCLUDED.username,
           tons         = EXCLUDED.tons,
           loads        = EXCLUDED.loads,
           actual_start = EXCLUDED.actual_start,
           actual_end   = EXCLUDED.actual_end,
           tickets      = EXCLUDED.tickets,
           notes        = EXCLUDED.notes,
           submitted_at = NOW(),
           updated_at   = NOW()`;

      return res.json({ ok: true, assignment_id: id, work_date: workDate, driver });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[driver/schedule]', err.message);
    return res.status(500).json({ error: 'Could not load the schedule' });
  }
};
