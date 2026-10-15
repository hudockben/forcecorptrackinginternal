'use strict';

// /api/vacation — Manage System → Vacation, the "Vacation: 32 h left" on the
// Timesheet, and Payroll's flag on a request that goes past the bank.
//
// Each login gets an allowance of hours for a calendar year
// (vacation_allowances in neon-schema.sql). The bank resets every January 1:
// only vacation dated in the year comes off that year's hours. What has been
// spent is read off timesheet_entries on every request rather than kept as a
// second figure, so it always agrees with the requests as they stand — Payroll
// denies a request by deleting it and the hours come back, an edit to a
// request's hours counts at the new hours, an un-approve keeps them held.
//
// WHAT COUNTS. Vacation rows (time_off_type 'vacation') dated in the year that
// are SUBMITTED or APPROVED, at the hours leaveHoursOf reads off them — the
// same figure Payroll pays — so a half day is 4, an unpaid day is 0, and a row
// that does not say is a full 8. A draft has not been asked for yet and counts
// nothing. Sick, holiday, jury duty and bereavement are not vacation.
//
//   approved → hours signed off.
//   pending  → hours sent in and waiting for approval. They come off the
//              moment the request is sent: that is when it was asked for.
//   left     → hours − approved − pending. Negative is a real answer. A request
//              past the bank still goes in; it is flagged, never refused.
//
// GET  /api/vacation?mine=1&years=2026[,2027]         the caller's own banks
//        → { ok, balances: { "2026": { tracked, hours, approved, pending, left } } }
// GET  /api/vacation?year=2026                        company admins: the tab
//        → { ok, year, people: [...], copyable }
// GET  /api/vacation?year=2026&view=payroll           admins and payroll approvers
//        → { ok, year, balances: { <user_id>: { hours, approved, pending, left, after } } }
// PUT  /api/vacation?user_id=<n>&year=2026            company admins
//        { hours: 80 } sets the year's hours; { hours: null } stops tracking it
// POST /api/vacation?action=copy&from=2025&to=2026    company admins: the old
//        year's number for every login that has none for the new one

const { neon } = require('@neondatabase/serverless');
const { requireAuth, payrollAccess } = require('./lib/auth');
const { leaveHoursOf } = require('./lib/payroll-metrics');
const { readPeopleRoster } = require('./lib/roster');

const MAX_HOURS = 1000;          // the table's CHECK: a typo guard, 125 days
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MAX_MINE_YEARS = 4;

/**
 * Hours to the cent. Sums of floats leave dust — 0.1 + 0.2 — and a bank that
 * is exactly spent must read 0, not "over by 0.00".
 */
function r2(n) {
  const v = Math.round(Number(n) * 100) / 100;
  return Math.abs(v) < 0.005 ? 0 : v;
}

/** The same rule as the Users tab: a company admin, or a platform admin. */
function isCompanyAdmin(payload) {
  return Boolean(payload && (payload.role === 'admin' || payload.isPlatformAdmin));
}

function parseYear(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_YEAR && n <= MAX_YEAR ? n : null;
}

/**
 * The hours box: { hours } to set, { hours: null } to stop tracking, or
 * { error }. Stopping is said out loud — null, or an emptied box — and never
 * read into a body that simply left the field out.
 */
function parseHours(body) {
  if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'hours')) {
    return { error: 'hours is required: a number of hours, or null to stop tracking' };
  }
  const raw = body.hours;
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return { hours: null };
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    return { error: `hours must be a number between 0 and ${MAX_HOURS}` };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_HOURS) {
    return { error: `hours must be a number between 0 and ${MAX_HOURS}` };
  }
  return { hours: Math.round(n * 100) / 100 };
}

/** Is this login on the Timesheet? Only an explicit grant puts anyone there. */
function hasTimesheetGrant(divisionRoles) {
  let dr = divisionRoles;
  if (typeof dr === 'string') { try { dr = JSON.parse(dr); } catch { dr = null; } }
  return Boolean(dr && typeof dr === 'object' && dr.timesheet && dr.timesheet !== 'no_access');
}

/** Earliest first; a day filed twice goes in the order it was filed. */
function byDate(a, b) {
  if (a.work_date !== b.work_date) return a.work_date < b.work_date ? -1 : 1;
  return Number(a.id) - Number(b.id);
}

/**
 * One login's year: its allowance (null when not tracked) and its counted
 * rows. The spent figures are given either way; `left` only when tracked.
 */
function balanceOf(hours, rows) {
  let approved = 0, pending = 0;
  for (const r of rows || []) {
    const h = leaveHoursOf(r);
    if (r.status === 'approved') approved += h;
    else if (r.status === 'submitted') pending += h;
  }
  const tracked = hours != null && Number.isFinite(Number(hours));
  return {
    hours:    tracked ? r2(hours) : null,
    approved: r2(approved),
    pending:  r2(pending),
    left:     tracked ? r2(Number(hours) - approved - pending) : null,
  };
}

/**
 * What is left of the bank once each WAITING request is taken, by entry id —
 * so Payroll can tell which request goes over, not just that somebody is.
 *
 * Approved hours come off first: they are settled. The waiting ones then come
 * off in date order, the way the days will be taken. Two requests that fit one
 * at a time but not together therefore show the later one going over, which
 * is the one an approver is deciding about when the earlier is already in.
 */
function leftAfterEach(hours, rows) {
  const after = {};
  if (hours == null || !Number.isFinite(Number(hours))) return after;
  const list = (rows || []).slice().sort(byDate);
  let run = Number(hours);
  for (const r of list) if (r.status === 'approved') run -= leaveHoursOf(r);
  for (const r of list) {
    if (r.status !== 'submitted') continue;
    run -= leaveHoursOf(r);
    after[String(r.id)] = r2(run);
  }
  return after;
}

/** The counted vacation rows dated in [fromYear, toYear], one login or all. */
function usageRows(sql, company, fromYear, toYear, userId) {
  const from = `${fromYear}-01-01`;
  const to   = `${toYear}-12-31`;
  return userId == null
    ? sql`
        SELECT id, user_id, status, entry_type,
               time_off_hours::float8 AS time_off_hours,
               to_char(work_date, 'YYYY-MM-DD') AS work_date
        FROM   timesheet_entries
        WHERE  company_code = ${company}
          AND  entry_type = 'time_off' AND time_off_type = 'vacation'
          AND  status IN ('submitted', 'approved')
          AND  work_date >= ${from}::date AND work_date <= ${to}::date
      `
    : sql`
        SELECT id, user_id, status, entry_type,
               time_off_hours::float8 AS time_off_hours,
               to_char(work_date, 'YYYY-MM-DD') AS work_date
        FROM   timesheet_entries
        WHERE  company_code = ${company} AND user_id = ${userId}
          AND  entry_type = 'time_off' AND time_off_type = 'vacation'
          AND  status IN ('submitted', 'approved')
          AND  work_date >= ${from}::date AND work_date <= ${to}::date
      `;
}

/** rows → Map(`${user_id}|${year}` → rows). */
function groupRows(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const key = `${r.user_id}|${String(r.work_date).slice(0, 4)}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
}

function allowancesFor(sql, company, year) {
  return sql`
    SELECT user_id, hours::float8 AS hours, set_by_name, updated_at
    FROM   vacation_allowances
    WHERE  company_code = ${company} AND year = ${year}
  `;
}

// ── GET ?mine=1 ─────────────────────────────────────────────────────────────
async function readMine(sql, payload, q, res) {
  const asked = String(q.years != null ? q.years : (q.year != null ? q.year : '')).split(',');
  const years = [...new Set(asked.map(parseYear))];
  if (!years.length || years.includes(null)) {
    return res.status(400).json({ ok: false, error: 'years must be four-digit years, comma separated' });
  }
  if (years.length > MAX_MINE_YEARS) {
    return res.status(400).json({ ok: false, error: `At most ${MAX_MINE_YEARS} years at a time` });
  }
  const lo = Math.min(...years), hi = Math.max(...years);
  const [allowances, rows] = await Promise.all([
    sql`
      SELECT year, hours::float8 AS hours
      FROM   vacation_allowances
      WHERE  company_code = ${payload.companyCode} AND user_id = ${payload.userId}
        AND  year >= ${lo} AND year <= ${hi}
    `,
    usageRows(sql, payload.companyCode, lo, hi, payload.userId),
  ]);
  const byYear = new Map(allowances.map(a => [Number(a.year), a.hours]));
  const grouped = groupRows(rows);
  const balances = {};
  for (const y of years) {
    if (!byYear.has(y)) { balances[y] = { tracked: false }; continue; }
    balances[y] = { tracked: true, ...balanceOf(byYear.get(y), grouped.get(`${payload.userId}|${y}`)) };
  }
  return res.json({ ok: true, balances });
}

// ── GET ?year= (the Manage System tab) ──────────────────────────────────────
async function readTab(sql, payload, year, res) {
  const company = payload.companyCode;
  const [users, current, previous, rows] = await Promise.all([
    sql`SELECT id, username, division_roles FROM users WHERE company_code = ${company} ORDER BY id`,
    allowancesFor(sql, company, year),
    allowancesFor(sql, company, year - 1),
    usageRows(sql, company, year - 1, year, null),
  ]);

  // Which person each login is, so the tab can say a name and not only a
  // username — and say when two logins are the same man, whose vacation then
  // comes out of two banks. Non-fatal: without it every row is its login.
  let loginPeople = {};
  try { loginPeople = (await readPeopleRoster(sql, company)).loginPeople || {}; }
  catch (err) { console.error('[vacation] roster read failed (non-fatal):', err.message); }
  const personOf = u => loginPeople[String(u.username || '').toLowerCase()] || null;
  const loginsOf = new Map();
  for (const u of users) {
    const p = personOf(u);
    if (!p) continue;
    const k = p.toLowerCase();
    if (!loginsOf.has(k)) loginsOf.set(k, []);
    loginsOf.get(k).push(u.username);
  }

  const cur  = new Map(current.map(a => [Number(a.user_id), a]));
  const prev = new Map(previous.map(a => [Number(a.user_id), a]));
  const grouped = groupRows(rows);

  const people = [];
  for (const u of users) {
    const id = Number(u.id);
    const mine = grouped.get(`${id}|${year}`) || [];
    const onTimesheet = hasTimesheetGrant(u.division_roles);
    // Everyone on the Timesheet, and anyone else the year is about: a bank
    // set, last year's bank to copy, or vacation filed.
    if (!onTimesheet && !cur.has(id) && !prev.has(id) && !mine.length) continue;
    const a = cur.get(id);
    const p = prev.get(id);
    const person = personOf(u);
    const also = person
      ? (loginsOf.get(person.toLowerCase()) || []).filter(n => n !== u.username)
      : [];
    people.push({
      user_id:   id,
      username:  u.username,
      person,
      also,
      timesheet: onTimesheet,
      ...balanceOf(a ? a.hours : null, mine),
      set_by:     a ? a.set_by_name || null : null,
      updated_at: a ? a.updated_at || null : null,
      prev: p ? { hours: r2(p.hours), left: balanceOf(p.hours, grouped.get(`${id}|${year - 1}`)).left } : null,
    });
  }
  people.sort((x, y) => String(x.person || x.username).localeCompare(String(y.person || y.username), undefined, { sensitivity: 'base' })
    || String(x.username).localeCompare(String(y.username), undefined, { sensitivity: 'base' }));

  const copyable = previous.filter(a => !cur.has(Number(a.user_id))).length;
  return res.json({ ok: true, year, people, copyable });
}

// ── GET ?year=&view=payroll ─────────────────────────────────────────────────
// Only the banks that are set, and only the figures the review grid draws.
async function readForPayroll(sql, payload, year, res) {
  const company = payload.companyCode;
  const [allowances, rows] = await Promise.all([
    allowancesFor(sql, company, year),
    usageRows(sql, company, year, year, null),
  ]);
  const grouped = groupRows(rows);
  const balances = {};
  for (const a of allowances) {
    const mine = grouped.get(`${Number(a.user_id)}|${year}`) || [];
    balances[Number(a.user_id)] = { ...balanceOf(a.hours, mine), after: leftAfterEach(a.hours, mine) };
  }
  return res.json({ ok: true, year, balances });
}

// ── PUT ?user_id=&year= ─────────────────────────────────────────────────────
async function setHours(sql, payload, q, body, res) {
  const company = payload.companyCode;
  const year = parseYear(q.year);
  if (year == null) return res.status(400).json({ ok: false, error: `year must be between ${MIN_YEAR} and ${MAX_YEAR}` });
  const userId = /^\d+$/.test(String(q.user_id || '')) ? Number(q.user_id) : null;
  if (userId == null) return res.status(400).json({ ok: false, error: 'user_id is required' });
  const parsed = parseHours(body);
  if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });

  const [who] = await sql`SELECT id, username FROM users WHERE id = ${userId} AND company_code = ${company}`;
  if (!who) return res.status(404).json({ ok: false, error: 'No such login in this company' });

  let saved = null;
  if (parsed.hours == null) {
    await sql`DELETE FROM vacation_allowances WHERE company_code = ${company} AND user_id = ${userId} AND year = ${year}`;
  } else {
    [saved] = await sql`
      INSERT INTO vacation_allowances (company_code, user_id, year, hours, set_by_user_id, set_by_name)
      VALUES (${company}, ${userId}, ${year}, ${parsed.hours}, ${payload.userId}, ${payload.username})
      ON CONFLICT (company_code, user_id, year) DO UPDATE
        SET hours          = EXCLUDED.hours,
            set_by_user_id = EXCLUDED.set_by_user_id,
            set_by_name    = EXCLUDED.set_by_name,
            updated_at     = NOW()
      RETURNING hours::float8 AS hours, set_by_name, updated_at
    `;
  }
  const rows = await usageRows(sql, company, year, year, userId);
  return res.json({
    ok: true, user_id: userId, username: who.username, year,
    ...balanceOf(saved ? saved.hours : null, rows),
    set_by: saved ? saved.set_by_name : null,
    updated_at: saved ? saved.updated_at : null,
  });
}

// ── POST ?action=copy&from=&to= ─────────────────────────────────────────────
// Fills only the logins with nothing set for the new year — never overwrites a
// number somebody has already typed — and copies each figure as it stands,
// carried-over hours and all.
async function copyYear(sql, payload, q, res) {
  const from = parseYear(q.from), to = parseYear(q.to);
  if (from == null || to == null || from === to) {
    return res.status(400).json({ ok: false, error: 'from and to must be two different years' });
  }
  const copied = await sql`
    INSERT INTO vacation_allowances (company_code, user_id, year, hours, set_by_user_id, set_by_name)
    SELECT company_code, user_id, ${to}, hours, ${payload.userId}, ${payload.username}
    FROM   vacation_allowances
    WHERE  company_code = ${payload.companyCode} AND year = ${from}
    ON CONFLICT (company_code, user_id, year) DO NOTHING
    RETURNING user_id
  `;
  return res.json({ ok: true, from, to, copied: copied.length });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = await requireAuth(req, res);
  if (!payload) return;
  const q = req.query || {};
  const admin = isCompanyAdmin(payload);
  const sql = neon(process.env.DATABASE_URL);

  try {
    if (req.method === 'GET') {
      if (q.mine) return await readMine(sql, payload, q, res);
      const year = parseYear(q.year);
      if (year == null) return res.status(400).json({ ok: false, error: `year must be between ${MIN_YEAR} and ${MAX_YEAR}` });
      if (q.view === 'payroll') {
        if (!admin && !payrollAccess(payload).canApprove) {
          return res.status(403).json({ ok: false, error: 'Payroll approval access required' });
        }
        return await readForPayroll(sql, payload, year, res);
      }
      if (!admin) return res.status(403).json({ ok: false, error: 'Company admin access required' });
      return await readTab(sql, payload, year, res);
    }
    if (req.method === 'PUT') {
      if (!admin) return res.status(403).json({ ok: false, error: 'Company admin access required' });
      return await setHours(sql, payload, q, req.body || {}, res);
    }
    if (req.method === 'POST' && q.action === 'copy') {
      if (!admin) return res.status(403).json({ ok: false, error: 'Company admin access required' });
      return await copyYear(sql, payload, q, res);
    }
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[vacation]', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
};

module.exports._test = { r2, isCompanyAdmin, parseYear, parseHours, hasTimesheetGrant, balanceOf, leftAfterEach, byDate };
