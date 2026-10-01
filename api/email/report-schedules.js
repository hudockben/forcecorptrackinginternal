'use strict';

// /api/email/report-schedules — Manage Users → Auto Reports.
//
// Reports that go out on their own: which report, for which job, how often,
// at what time, to which saved recipient groups. api/cron/report-schedules.js
// sends them; this is where admins set them up, switch them off, and press
// "Send now" to see one arrive before trusting it to a timetable.
//
// Admins only (platform admin, company admin, or admin of any division — the
// same rule as saving a recipient group), and only for divisions the admin
// can open: a schedule is built with its owner's access, so letting someone
// schedule a division they cannot see would be a way to read it by email.
//
// GET    /api/email/report-schedules
//          → { divisions, schedules, groups, runs, periods, ... }
// GET    /api/email/report-schedules?projects=<division>
//          → { projects: [{ id, name, jobNumber, status }] }   the job picker
// POST   /api/email/report-schedules                  create
// PUT    /api/email/report-schedules?id=<n>           replace, or { enabled } alone
// DELETE /api/email/report-schedules?id=<n>
// POST   /api/email/report-schedules?id=<n>&action=run   send it now
//
// Saving a schedule makes the saver the account it runs as. That is the rule
// that keeps the access check honest: whoever last said "send this" is whose
// access it is sent with, checked again at every send.

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('../lib/auth');
const { SCHEDULABLE, DIVISIONS } = require('../lib/report-catalog');
const T = require('../lib/report-schedule-time');
const runner = require('../lib/report-schedule-runner');
const jobFin = require('../lib/job-financials');

const MAX_SCHEDULES = 200;    // per company
const MAX_GROUPS    = 10;     // per schedule
const RECENT_RUNS   = 40;
const DAY_CHOICES   = ['today', 'tomorrow', 'next_workday'];
const YEAR_CHOICES  = ['current', 'all'];

function isAdmin(payload) {
  if (!payload) return false;
  if (payload.isPlatformAdmin) return true;
  if (payload.role === 'admin') return true;
  const dr = payload.divisionRoles;
  if (dr && typeof dr === 'object') {
    for (const v of Object.values(dr)) if (v === 'admin') return true;
  }
  return false;
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The schedule as the tab reads it. */
function shape(r) {
  return {
    id:            Number(r.id),
    report_type:   r.report_type,
    division:      r.division,
    project_id:    r.project_id,
    project_name:  r.project_name,
    options:       r.options || {},
    frequency:     r.frequency,
    days_of_week:  r.days_of_week,
    day_of_month:  r.day_of_month,
    send_time:     r.send_time,
    timezone:      r.timezone,
    group_ids:     Array.isArray(r.group_ids) ? r.group_ids.map(Number) : [],
    subject:       r.subject,
    note:          r.note,
    attach_pdf:    r.attach_pdf !== false,
    enabled:       Boolean(r.enabled),
    run_as_username: r.run_as_username,
    next_run_at:   r.next_run_at,
    last_run_at:   r.last_run_at,
    last_status:   r.last_status,
    last_message:  r.last_message,
    sending:       Boolean(r.claimed_at),
    created_by_username: r.created_by_username,
    updated_at:    r.updated_at,
  };
}

/**
 * Validate an editor body into a row's worth of fields, or { error }.
 * Group ids are checked against the company separately (needs the database).
 */
function normalizeBody(body, payload) {
  const b = body || {};
  const def = SCHEDULABLE[b.report_type];
  if (!def) return { error: 'Pick a report.' };
  if (!hasDivisionAccess(payload, def.division)) {
    return { status: 403, error: 'You do not have access to that division.' };
  }

  let project_id = null;
  let project_name = null;
  const pid = str(b.project_id, 120);
  if (def.scope === 'job') {
    if (!pid) return { error: 'Pick a job, or every In Progress job.' };
    project_id = pid;
  } else if (def.scope === 'job_or_all') {
    // No job is every job, in one report; '*' (one email per job) is not a
    // thing this kind of report does.
    project_id = pid && pid !== '*' ? pid : null;
  }
  if (project_id && project_id !== '*') project_name = str(b.project_name, 200) || null;

  const inOpts = b.options && typeof b.options === 'object' ? b.options : {};
  const options = {};
  if (def.period) {
    options.period = Object.prototype.hasOwnProperty.call(T.PERIODS, inOpts.period) ? inOpts.period : def.period;
  }
  if (def.day)  options.day  = DAY_CHOICES.includes(inOpts.day) ? inOpts.day : def.day;
  if (def.year) options.year = YEAR_CHOICES.includes(inOpts.year) ? inOpts.year : 'current';

  const occ = T.normalizeOccurrence(b);
  if (!occ.ok) return { error: occ.error };

  const rawGroups = Array.isArray(b.group_ids) ? b.group_ids : [];
  const group_ids = [...new Set(rawGroups.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!group_ids.length) return { error: 'Pick at least one recipient group.' };
  if (group_ids.length > MAX_GROUPS) return { error: `At most ${MAX_GROUPS} recipient groups.` };

  return {
    value: {
      report_type: def.type,
      division:    def.division,
      project_id,
      project_name,
      options,
      ...occ.value,
      group_ids,
      subject:     str(b.subject, 200) || null,
      note:        str(b.note, 2000) || null,
      attach_pdf:  b.attach_pdf !== false,
      enabled:     b.enabled !== false,
    },
  };
}

async function groupsExist(sql, company, ids) {
  const rows = await sql`
    SELECT id FROM report_recipient_groups WHERE company_code = ${company} AND id = ANY(${ids})`;
  return rows.length === ids.length;
}

async function loadOne(sql, company, id) {
  const rows = await sql`SELECT * FROM report_schedules WHERE id = ${id} AND company_code = ${company}`;
  return rows[0] || null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = await requireAuth(req, res);
  if (!payload) return;
  if (!isAdmin(payload)) return res.status(403).json({ ok: false, error: 'Admin access required' });

  const sql = neon(process.env.DATABASE_URL);
  const company = payload.companyCode;
  const q = req.query || {};

  try {
    // ── GET ?projects=<division> — the job picker ─────────────────────────
    if (req.method === 'GET' && q.projects) {
      const div = jobFin.jobDivision(String(q.projects));
      if (!div) return res.status(400).json({ ok: false, error: 'Unknown division' });
      if (!hasDivisionAccess(payload, div.key)) return res.status(403).json({ ok: false, error: 'No access to that division' });
      const projects = (await div.read(sql, company, {})).filter(Boolean).map(p => ({
        id:        String(p.id || ''),
        name:      String(p['project-name'] || p.name || '').trim() || 'Untitled',
        jobNumber: String(p['job-number'] || p.job_number || '').trim(),
        status:    String(p.status || '').trim(),
      })).filter(p => p.id);
      return res.json({ ok: true, projects });
    }

    // ── GET — everything the tab draws ────────────────────────────────────
    if (req.method === 'GET') {
      const divisions = DIVISIONS
        .filter(d => hasDivisionAccess(payload, d.key))
        .map(d => ({
          key: d.key,
          name: d.name,
          reports: Object.values(SCHEDULABLE).filter(s => s.division === d.key).map(s => ({
            type: s.type, name: s.name, label: s.label, scope: s.scope, blurb: s.blurb,
            period: s.period || null, day: s.day || null, year: Boolean(s.year),
          })),
        }))
        .filter(d => d.reports.length);
      const visible = new Set(divisions.map(d => d.key));

      const [rows, groups, runs] = await Promise.all([
        sql`SELECT * FROM report_schedules WHERE company_code = ${company} ORDER BY division, report_type, id`,
        sql`SELECT id, name, emails, report_type, project_id FROM report_recipient_groups
             WHERE company_code = ${company} ORDER BY name`,
        sql`SELECT r.id, r.schedule_id, r.run_kind, r.status, r.sent_count, r.total_count, r.recipient_count,
                   r.message, r.triggered_by, r.started_at, r.finished_at, s.report_type, s.division, s.project_name, s.project_id
              FROM report_schedule_runs r
              JOIN report_schedules s ON s.id = r.schedule_id
             WHERE r.company_code = ${company}
             ORDER BY r.started_at DESC
             LIMIT ${RECENT_RUNS}`,
      ]);

      return res.json({
        ok: true,
        divisions,
        schedules: rows.filter(r => visible.has(r.division)).map(shape),
        groups: groups.map(g => ({
          id: Number(g.id), name: g.name,
          count: Array.isArray(g.emails) ? g.emails.length : 0,
          report_type: g.report_type, project_id: g.project_id,
        })),
        runs: runs.filter(r => visible.has(r.division)).map(r => ({
          id: Number(r.id), schedule_id: Number(r.schedule_id), kind: r.run_kind, status: r.status,
          sent: r.sent_count, total: r.total_count, recipients: r.recipient_count, message: r.message,
          triggered_by: r.triggered_by, started_at: r.started_at, finished_at: r.finished_at,
          report_type: r.report_type, project_name: r.project_name, project_id: r.project_id,
        })),
        periods: T.PERIODS,
        defaultTimezone: T.DEFAULT_TZ,
        now: new Date().toISOString(),
      });
    }

    // ── POST ?id=&action=run — send it now ───────────────────────────────
    if (req.method === 'POST' && q.action === 'run') {
      const id = parseInt(q.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id is required' });
      const sched = await loadOne(sql, company, id);
      if (!sched) return res.status(404).json({ ok: false, error: 'Schedule not found' });
      if (!hasDivisionAccess(payload, sched.division)) {
        return res.status(403).json({ ok: false, error: 'You do not have access to that division.' });
      }
      const startedAt = new Date();
      const result = await runner.runSchedule(sql, sched, {
        baseUrl: runner.appBaseUrl(req), now: startedAt, deadline: startedAt.getTime() + 270_000,
      });
      try {
        await runner.recordRun(sql, sched, result, {
          kind: 'manual', triggeredBy: payload.username, startedAt, now: new Date(),
        });
      } catch (err) {
        console.error('[report-schedules] could not record send now', id, err.message);
      }
      console.log('[report-schedules] send now', 'id=' + id, 'user=' + payload.username,
        'status=' + result.status, 'sent=' + result.sent);
      const fresh = await loadOne(sql, company, id);
      return res.json({ ok: true, result, schedule: fresh ? shape(fresh) : null });
    }

    // ── POST — create ─────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const norm = normalizeBody(req.body, payload);
      if (norm.error) return res.status(norm.status || 400).json({ ok: false, error: norm.error });
      const v = norm.value;
      if (!(await groupsExist(sql, company, v.group_ids))) {
        return res.status(400).json({ ok: false, error: 'One of those recipient groups no longer exists.' });
      }
      const count = await sql`SELECT COUNT(*)::int AS n FROM report_schedules WHERE company_code = ${company}`;
      if ((count[0] && count[0].n) >= MAX_SCHEDULES) {
        return res.status(400).json({ ok: false, error: `A company can have at most ${MAX_SCHEDULES} scheduled reports.` });
      }
      const next = v.enabled ? T.nextRunAt(v, new Date()) : null;
      const rows = await sql`
        INSERT INTO report_schedules
          (company_code, report_type, division, project_id, project_name, options,
           frequency, days_of_week, day_of_month, send_time, timezone, group_ids,
           subject, note, attach_pdf, enabled, run_as_user_id, run_as_username,
           next_run_at, created_by, created_by_username)
        VALUES
          (${company}, ${v.report_type}, ${v.division}, ${v.project_id}, ${v.project_name}, ${JSON.stringify(v.options)}::jsonb,
           ${v.frequency}, ${v.days_of_week ? JSON.stringify(v.days_of_week) : null}::jsonb, ${v.day_of_month},
           ${v.send_time}, ${v.timezone}, ${JSON.stringify(v.group_ids)}::jsonb,
           ${v.subject}, ${v.note}, ${v.attach_pdf}, ${v.enabled}, ${payload.userId}, ${payload.username || null},
           ${next ? next.toISOString() : null}, ${payload.userId || null}, ${payload.username || null})
        RETURNING *`;
      return res.json({ ok: true, schedule: shape(rows[0]) });
    }

    // ── PUT ?id= — replace, or switch on/off ──────────────────────────────
    if (req.method === 'PUT') {
      const id = parseInt(q.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id is required' });
      const cur = await loadOne(sql, company, id);
      if (!cur) return res.status(404).json({ ok: false, error: 'Schedule not found' });
      if (!hasDivisionAccess(payload, cur.division)) {
        return res.status(403).json({ ok: false, error: 'You do not have access to that division.' });
      }

      const body = req.body || {};
      const toggleOnly = Object.keys(body).length === 1 && Object.prototype.hasOwnProperty.call(body, 'enabled');
      let v;
      if (toggleOnly) {
        v = { ...cur, enabled: Boolean(body.enabled) };
      } else {
        const norm = normalizeBody(body, payload);
        if (norm.error) return res.status(norm.status || 400).json({ ok: false, error: norm.error });
        v = norm.value;
        if (!(await groupsExist(sql, company, v.group_ids))) {
          return res.status(400).json({ ok: false, error: 'One of those recipient groups no longer exists.' });
        }
      }
      // A schedule switched off has no next run; switched on or retimed, it
      // goes at the next matching time from now — never "immediately, to catch
      // up", which is how a report turned back on after a month would arrive
      // at once for no reason anyone asked for.
      const next = v.enabled ? T.nextRunAt(v, new Date()) : null;
      const rows = await sql`
        UPDATE report_schedules SET
          report_type   = ${v.report_type},
          division      = ${v.division},
          project_id    = ${v.project_id},
          project_name  = ${v.project_name},
          options       = ${JSON.stringify(v.options || {})}::jsonb,
          frequency     = ${v.frequency},
          days_of_week  = ${v.days_of_week ? JSON.stringify(v.days_of_week) : null}::jsonb,
          day_of_month  = ${v.day_of_month},
          send_time     = ${v.send_time},
          timezone      = ${v.timezone},
          group_ids     = ${JSON.stringify(v.group_ids || [])}::jsonb,
          subject       = ${v.subject},
          note          = ${v.note},
          attach_pdf    = ${v.attach_pdf !== false},
          enabled       = ${Boolean(v.enabled)},
          run_as_user_id  = ${payload.userId},
          run_as_username = ${payload.username || null},
          next_run_at   = ${next ? next.toISOString() : null},
          updated_at    = NOW()
         WHERE id = ${id} AND company_code = ${company}
         RETURNING *`;
      return res.json({ ok: true, schedule: shape(rows[0]) });
    }

    // ── DELETE ?id= ───────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = parseInt(q.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id is required' });
      const cur = await loadOne(sql, company, id);
      if (!cur) return res.json({ ok: true });
      if (!hasDivisionAccess(payload, cur.division)) {
        return res.status(403).json({ ok: false, error: 'You do not have access to that division.' });
      }
      await sql`DELETE FROM report_schedules WHERE id = ${id} AND company_code = ${company}`;
      return res.json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[email/report-schedules]', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
};

module.exports.normalizeBody = normalizeBody;
module.exports.isAdmin = isAdmin;
