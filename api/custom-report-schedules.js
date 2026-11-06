'use strict';

// /api/custom-report-schedules — Analytics → Custom Reporting → Schedules.
//
// A saved custom report sent on a timetable: the Monday owner update, every
// In Progress job's progress report on the 1st. The schedule is a row in
// report_schedules (report_type <division>_custom_report), so the same
// five-minute cron sends it (api/cron/report-schedules.js) through the same
// runner (api/lib/report-schedule-runner.js) as every Auto Report: the
// division page is opened headless as the account the schedule runs as, the
// saved recipe is built there by the same engine the builder's Email button
// uses, and the result goes out through the same delivery path.
//
// Customer-safe is the rule, at every step. A report with internal data
// switched on cannot be scheduled; a report switched to internal data after
// it was scheduled stops sending (the runner reads the report again before
// every run); the page forces internal data off when it builds; and anything
// that still carries the engine's internal mark is refused before it is sent.
//
// Each job's saved contacts (use_job_contacts) are only ever sent a report
// about their own customer's jobs: one email per job, or a saved report whose
// jobs all belong to one client. One report for every In Progress job, or a
// saved report spanning customers, is refused with them — and the runner
// checks again at send time, since a report's jobs can change after.
//
// Who may do what:
//   - sales cannot open Custom Reporting at all (403), as /api/custom-reports;
//   - level1 / level2 see no schedules (an empty list, canSchedule false) and
//     may change none (403);
//   - admin / level3 in the division see every custom schedule in it, and may
//     create, edit, switch off or on, delete and Send now any of them.
// Saving a schedule (create, or an edit of its settings) makes the saver the
// account it runs as, and the saver must pass every check: the report is
// theirs or shared, customer-safe and on a relative date range. Switching a
// schedule off or on changes nothing else, so it leaves that account alone —
// it is the one that could see the report, and it is checked again at every
// send anyway.
//
// GET    ?division=                       → { schedules, canSchedule, groups }
// GET    ?division=&runs=<scheduleId>     → { runs }   its last 25 runs
// POST   ?division=                       create
// PUT    ?division=&id=<n>                save, or { enabled } alone (also a full
//                                         body whose only change is enabled)
// DELETE ?division=&id=<n>
// POST   ?division=&id=<n>&action=run     Send now — built and sent inside the
//                                         request, as Auto Reports' Send now
//
// A refusal is { ok: false, error: <code>, message: <words for the user> }.
// Body (create / save):
//   { custom_report_id, jobs_mode: 'saved' | 'each' | 'all_in_progress',
//     picked_jobs?: [{ id, name }]  (each only; none = every In Progress job),
//     frequency, days_of_week?, day_of_month?, send_time, timezone,
//     group_ids?: [n], emails?: [address], use_job_contacts?: bool,
//     subject?, note?, attach_pdf?, enabled? }

const { neon } = require('@neondatabase/serverless');
const { requireDivision, levelFor, isSalesIn } = require('./lib/auth');
const { isValidEmail } = require('./lib/email');
const { JOBS_MODES, customTypeFor } = require('./lib/report-catalog');
const T = require('./lib/report-schedule-time');
const runner = require('./lib/report-schedule-runner');
const { toId, isPlainObject, oneLine, cleanStr } = require('./lib/custom-report-runs');

const DIVISIONS        = ['turf', 'paving', 'kiewit'];
// Shared with Auto Reports: one count of report_schedules rows per company.
const MAX_SCHEDULES    = 200;
const MAX_GROUPS       = 10;
const MAX_EMAILS       = 50;
// A list longer than this is not somebody's recipients, and is not read.
const MAX_RAW_EMAILS   = 500;
const MAX_PICKED_JOBS  = 100;
const MAX_SUBJECT      = 200;
const MAX_NOTE         = 2000;
const RUNS_SHOWN       = 25;
// Inside the function's 300 seconds (vercel.json), as Auto Reports' Send now.
const SEND_NOW_MS      = 285_000;

const FIXED_DATES_MSG  = 'Scheduled reports need a relative date range like Last week';

const refuse = (status, error, message) => ({ status, error, message });
const send = (res, r) => res.status(r.status || 400).json({ ok: false, error: r.error, message: r.message });

// ── The body ────────────────────────────────────────────────────────────────

/**
 * The editor's body as the fields of a schedule, before anything is looked
 * up: { value } or a refusal. The saved report itself, its kind and whether
 * the groups exist are checked against the database afterwards.
 */
function readBody(raw) {
  const b = isPlainObject(raw) ? raw : {};
  const reportId = toId(b.custom_report_id != null ? b.custom_report_id : b.report_id);
  if (!reportId) return refuse(400, 'report_required', 'Pick the saved report to send.');

  let jobsMode = null;
  if (b.jobs_mode !== undefined && b.jobs_mode !== null && b.jobs_mode !== '') {
    if (!JOBS_MODES.includes(b.jobs_mode)) return refuse(400, 'jobs_mode', 'Pick which jobs it covers.');
    jobsMode = b.jobs_mode;
  }

  let pickedJobs = null;
  if (b.picked_jobs !== undefined && b.picked_jobs !== null) {
    if (!Array.isArray(b.picked_jobs)) return refuse(400, 'picked_jobs', 'Picked jobs must be a list.');
    const seen = new Set();
    const list = [];
    for (const j of b.picked_jobs) {
      const id = oneLine(j && typeof j === 'object' ? j.id : j, 120);
      if (!id || id === '*' || seen.has(id)) continue;
      seen.add(id);
      list.push({ id, name: oneLine(j && typeof j === 'object' ? j.name : '', 200) || null });
      if (list.length > MAX_PICKED_JOBS) return refuse(400, 'picked_jobs', `Pick at most ${MAX_PICKED_JOBS} jobs.`);
    }
    pickedJobs = list.length ? list : null;
  }

  const occ = T.normalizeOccurrence(b);
  if (!occ.ok) return refuse(400, 'cadence', occ.error);

  if (b.group_ids !== undefined && b.group_ids !== null && !Array.isArray(b.group_ids)) {
    return refuse(400, 'groups', 'Recipient groups must be a list.');
  }
  const groupIds = [...new Set((b.group_ids || []).map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
  if (groupIds.length > MAX_GROUPS) return refuse(400, 'groups', `At most ${MAX_GROUPS} recipient groups.`);

  if (b.emails !== undefined && b.emails !== null && !Array.isArray(b.emails)) {
    return refuse(400, 'emails', 'Email addresses must be a list.');
  }
  const rawEmails = b.emails || [];
  if (rawEmails.length > MAX_RAW_EMAILS) return refuse(400, 'emails', `At most ${MAX_EMAILS} email addresses.`);
  const emails = [];
  for (const x of rawEmails) {
    if (typeof x !== 'string') return refuse(400, 'emails', 'Email addresses must be text.');
    const e = cleanStr(x).trim().toLowerCase();
    if (!e || emails.includes(e)) continue;
    if (!isValidEmail(e)) return refuse(400, 'emails', `${e.slice(0, 254)} is not a valid email address.`);
    emails.push(e);
  }
  if (emails.length > MAX_EMAILS) return refuse(400, 'emails', `At most ${MAX_EMAILS} email addresses.`);

  const useJobContacts = b.use_job_contacts === true;
  if (!groupIds.length && !emails.length && !useJobContacts) {
    return refuse(400, 'recipients', 'Add someone to send it to: the jobs’ saved contacts, a recipient group or an email address.');
  }

  const subject = typeof b.subject === 'string' ? oneLine(b.subject, Infinity) : '';
  if (subject.length > MAX_SUBJECT) return refuse(400, 'subject', `Subjects are limited to ${MAX_SUBJECT} characters.`);
  const note = typeof b.note === 'string' ? cleanStr(b.note).trim() : '';
  if (note.length > MAX_NOTE) return refuse(400, 'note', `Notes are limited to ${MAX_NOTE} characters.`);

  return {
    value: {
      reportId, jobsMode, pickedJobs, ...occ.value,
      group_ids: groupIds, emails, use_job_contacts: useJobContacts,
      subject: subject || null, note: note || null,
      attach_pdf: b.attach_pdf !== false, enabled: b.enabled !== false,
    },
  };
}

/**
 * The saved report a schedule would send, checked for the person saving it:
 * { report } or a refusal. Theirs or shared, live, customer-safe, and on a
 * relative date range — a fixed range would send the same days every time.
 */
async function checkReport(sql, company, division, me, reportId) {
  const rows = await sql`
    SELECT id, name, kind, visibility, owner_user_id, customer_safe, definition, deleted_at
      FROM custom_reports
     WHERE id = ${reportId} AND company_code = ${company} AND division = ${division}`;
  const r = rows[0];
  // Not there, and not theirs to see, read the same.
  if (!r || r.deleted_at || !(r.visibility === 'shared' || Number(r.owner_user_id) === me.userId)) {
    return refuse(400, 'report_not_found', 'That saved report was deleted or is not shared with you — pick another.');
  }
  const def = isPlainObject(r.definition) ? r.definition : {};
  if (r.customer_safe === false || def.includeInternal === true) {
    return refuse(400, 'not_customer_safe', `“${r.name}” includes internal data. Scheduled sends are customer-safe only — `
      + 'switch internal data off and save the report first.');
  }
  const dates = isPlainObject(def.dates) ? def.dates : {};
  if (dates.preset === 'custom') {
    return refuse(400, 'fixed_dates', `${FIXED_DATES_MSG}. “${r.name}” is set to fixed dates, so every email would show the same days.`);
  }
  const jobs = def.jobs;
  const jobIds = (Array.isArray(jobs) ? jobs : (isPlainObject(jobs) && Array.isArray(jobs.ids) ? jobs.ids : []))
    .filter(x => (typeof x === 'string' && x) || typeof x === 'number').map(String);
  return { report: { id: Number(r.id), name: r.name, kind: r.kind === 'report' ? 'report' : 'template', jobIds } };
}

/**
 * Each job's saved contacts may only be sent a report about their own
 * customer's jobs: one email per job always is; one report for every In
 * Progress job never is; a saved report's jobs are, when they all belong to
 * one client. Otherwise each customer would be emailed the others' jobs.
 */
async function checkJobContacts(sql, company, division, report, mode) {
  const why = 'Each job’s saved contacts can only be sent a report about their own jobs';
  if (mode === 'all_in_progress') {
    return refuse(400, 'job_contacts', `${why} — one report for every In Progress job would show each customer the others’. `
      + 'Send one email per job to use them, or pick groups and addresses instead.');
  }
  if (mode === 'saved' && report.jobIds.length > 1) {
    const clients = await runner.clientsOfJobs(sql, company, division, report.jobIds);
    if (!runner.oneCustomer(clients)) {
      return refuse(400, 'job_contacts', `${why} — “${report.name}” covers jobs of more than one customer. `
        + 'Pick groups and addresses instead, or schedule a report for one customer’s jobs.');
    }
  }
  return null;
}

/**
 * The jobs a schedule covers, for the kind of report it sends: a report that
 * saves its jobs is sent for those; a template, once per job (every In
 * Progress job, or the ones picked) or for every In Progress job at once.
 */
function jobsFor(report, v) {
  if (report.kind === 'report') {
    if (v.jobsMode && v.jobsMode !== 'saved') {
      return refuse(400, 'jobs_mode', `“${report.name}” saves its own jobs, so it is sent for those jobs.`);
    }
    return { mode: 'saved', pickedJobs: null };
  }
  if (v.jobsMode === 'saved') {
    return refuse(400, 'jobs_mode', `“${report.name}” picks its jobs when it is run — send one email per job, or every In Progress job in one report.`);
  }
  const mode = v.jobsMode || 'each';
  return { mode, pickedJobs: mode === 'each' ? v.pickedJobs : null };
}

async function groupsExist(sql, company, ids) {
  if (!ids.length) return true;
  const rows = await sql`SELECT id FROM report_recipient_groups WHERE company_code = ${company} AND id = ANY(${ids})`;
  return rows.length === ids.length;
}

/** The body, the report and the groups, checked: the row's fields, or a refusal. */
async function validate(sql, { company, division, me, body }) {
  const read = readBody(body);
  if (!read.value) return read;
  const v = read.value;
  const checked = await checkReport(sql, company, division, me, v.reportId);
  if (!checked.report) return checked;
  const jobs = jobsFor(checked.report, v);
  if (!jobs.mode) return jobs;
  if (v.use_job_contacts) {
    const mixed = await checkJobContacts(sql, company, division, checked.report, jobs.mode);
    if (mixed) return mixed;
  }
  if (!(await groupsExist(sql, company, v.group_ids))) {
    return refuse(400, 'groups', 'One of those recipient groups no longer exists.');
  }
  const report = checked.report;
  return {
    value: {
      report_type:      customTypeFor(division),
      division,
      custom_report_id: report.id,
      jobs_mode:        jobs.mode,
      project_id:       jobs.mode === 'each' ? '*' : null,
      picked_jobs:      jobs.pickedJobs,
      options:          { report_id: report.id, report_name: report.name, jobs_mode: jobs.mode },
      frequency:        v.frequency,
      days_of_week:     v.days_of_week,
      day_of_month:     v.day_of_month,
      send_time:        v.send_time,
      timezone:         v.timezone,
      group_ids:        v.group_ids,
      emails:           v.emails,
      use_job_contacts: v.use_job_contacts,
      subject:          v.subject,
      note:             v.note,
      attach_pdf:       v.attach_pdf,
      enabled:          v.enabled,
    },
  };
}

/**
 * A schedule's settings, loosely, for telling a save that only switches it
 * off or on (the builder sends the whole schedule back with enabled flipped)
 * from one that changes something. Read from a body or a row alike, and
 * never refused: a schedule whose report has since been deleted or switched
 * to internal data can still be paused.
 */
function settingsKey(src) {
  const s = isPlainObject(src) ? src : {};
  const freq = String(s.frequency || '').toLowerCase();
  const list = v => (Array.isArray(v) ? v : []);
  return JSON.stringify({
    report:   toId(s.custom_report_id != null ? s.custom_report_id : s.report_id),
    mode:     s.jobs_mode || null,
    picked:   list(s.picked_jobs).map(j => String(j && typeof j === 'object' ? j.id : j)).filter(x => x && x !== '*' && x !== 'undefined'),
    freq,
    time:     String(s.send_time || ''),
    tz:       s.timezone || T.DEFAULT_TZ,
    days:     freq === 'weekly' ? [...new Set(list(s.days_of_week).map(Number))].sort() : null,
    dom:      freq === 'monthly' ? Number(s.day_of_month) : null,
    groups:   [...new Set(list(s.group_ids).map(Number))].sort((a, b) => a - b),
    emails:   [...new Set(list(s.emails).map(e => String(e).trim().toLowerCase()))].sort(),
    contacts: s.use_job_contacts === true,
    subject:  typeof s.subject === 'string' ? oneLine(s.subject, Infinity) || null : null,
    note:     typeof s.note === 'string' ? cleanStr(s.note).trim() || null : null,
    pdf:      s.attach_pdf !== false,
  });
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** The division's custom schedules, with their saved report as it is now. */
async function loadSchedules(sql, company, division, id) {
  return sql`
    SELECT s.*, cr.name AS cr_name, (cr.id IS NOT NULL AND cr.deleted_at IS NULL) AS cr_live,
           cr.visibility AS cr_visibility, cr.owner_user_id AS cr_owner, cr.customer_safe AS cr_safe
      FROM report_schedules s
      LEFT JOIN custom_reports cr ON cr.id = s.custom_report_id AND cr.company_code = s.company_code
     WHERE s.company_code = ${company} AND s.division = ${division} AND s.report_type = ${customTypeFor(division)}
       AND (${id == null ? null : id}::bigint IS NULL OR s.id = ${id == null ? null : id}::bigint)
     ORDER BY s.id`;
}

function shape(r, me) {
  const live = runner.liveStatus(r);
  const opts = isPlainObject(r.options) ? r.options : {};
  const reportLive = r.cr_live === true;
  return {
    id:                  Number(r.id),
    report_type:         r.report_type,
    division:            r.division,
    custom_report_id:    r.custom_report_id == null ? null : Number(r.custom_report_id),
    report_name:         (reportLive && r.cr_name) || opts.report_name || null,
    jobs_mode:           runner.jobsModeOf(r),
    project_id:          r.project_id || null,
    picked_jobs:         Array.isArray(r.picked_jobs) && r.picked_jobs.length ? r.picked_jobs : null,
    frequency:           r.frequency,
    days_of_week:        r.days_of_week,
    day_of_month:        r.day_of_month,
    send_time:           r.send_time,
    timezone:            r.timezone,
    group_ids:           Array.isArray(r.group_ids) ? r.group_ids.map(Number) : [],
    emails:              Array.isArray(r.emails) ? r.emails : [],
    use_job_contacts:    r.use_job_contacts === true,
    subject:             r.subject,
    note:                r.note,
    attach_pdf:          r.attach_pdf !== false,
    enabled:             Boolean(r.enabled),
    next_run_at:         r.next_run_at,
    last_run_at:         r.last_run_at,
    last_status:         live.status,
    last_message:        live.message,
    sending:             live.sending,
    run_as_username:     r.run_as_username,
    created_by_username: r.created_by_username,
    updated_at:          r.updated_at,
    // The saved report as it is now: gone, not the caller's to open (they
    // can still pause, send or delete the schedule), or no longer
    // customer-safe (it will not send until it is).
    report_deleted:      !reportLive,
    report_visible:      reportLive && (r.cr_visibility === 'shared' || Number(r.cr_owner) === me.userId),
    report_customer_safe: reportLive ? r.cr_safe !== false : null,
  };
}

// ── The handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = await requireDivision(req, res, { required: true });
  if (!guard) return;
  const { payload, division } = guard;
  if (!DIVISIONS.includes(division)) {
    return send(res, refuse(400, 'division', 'Scheduled custom reports are not available for this division.'));
  }
  if (isSalesIn(payload, division)) {
    return send(res, refuse(403, 'sales', 'Custom Reporting is part of Analytics, which a sales login cannot open.'));
  }
  const me = { userId: Number(payload.userId), username: payload.username || null };
  if (!Number.isSafeInteger(me.userId)) return res.status(401).json({ ok: false, error: 'Unauthorized — please log in' });

  // Platform admins come back from levelFor as 'admin'.
  const canSchedule = ['admin', 'level3'].includes(levelFor(payload, division));
  const company = payload.companyCode;
  const type = customTypeFor(division);
  const sql = neon(process.env.DATABASE_URL);
  const q = req.query || {};
  const notAllowed = () => send(res, refuse(403, 'forbidden', 'Only an admin or level 3 user can schedule reports.'));
  const notFound = () => send(res, refuse(404, 'not_found', 'Schedule not found.'));
  const loadOne = async id => ((await loadSchedules(sql, company, division, id))[0] || null);

  try {
    // ── GET ?runs=<id> — one schedule's recent sends ─────────────────────
    if (req.method === 'GET' && q.runs !== undefined) {
      const id = toId(q.runs);
      if (!id) return send(res, refuse(400, 'id', 'runs must be a schedule id.'));
      if (!canSchedule) return res.json({ ok: true, runs: [], canSchedule: false });
      if (!(await loadOne(id))) return notFound();
      const rows = await sql`
        SELECT id, schedule_id, run_kind, status, sent_count, total_count, recipient_count, message,
               triggered_by, started_at, finished_at, report_name, project_name
          FROM report_schedule_runs
         WHERE schedule_id = ${id} AND company_code = ${company}
         ORDER BY started_at DESC, id DESC
         LIMIT ${RUNS_SHOWN}`;
      return res.json({
        ok: true,
        canSchedule,
        runs: rows.map(r => ({
          id: Number(r.id), schedule_id: Number(r.schedule_id), kind: r.run_kind, status: r.status,
          sent: r.sent_count, total: r.total_count, recipients: r.recipient_count, message: r.message,
          triggered_by: r.triggered_by, started_at: r.started_at, finished_at: r.finished_at,
          report_name: r.report_name || null, label: r.project_name || null,
        })),
      });
    }

    // ── GET — the division's custom schedules ────────────────────────────
    if (req.method === 'GET') {
      if (!canSchedule) return res.json({ ok: true, schedules: [], canSchedule: false, groups: [] });
      const [rows, groups] = await Promise.all([
        loadSchedules(sql, company, division, null),
        sql`SELECT id, name, emails, report_type FROM report_recipient_groups
             WHERE company_code = ${company} ORDER BY name, id`,
      ]);
      // The company's general groups and this report type's, plus any a
      // schedule here already sends to.
      const used = new Set(rows.flatMap(r => (Array.isArray(r.group_ids) ? r.group_ids.map(Number) : [])));
      return res.json({
        ok: true,
        canSchedule,
        schedules: rows.map(r => shape(r, me)),
        groups: groups
          .filter(g => !g.report_type || g.report_type === type || used.has(Number(g.id)))
          .map(g => ({ id: Number(g.id), name: g.name, count: Array.isArray(g.emails) ? g.emails.length : 0 })),
      });
    }

    if (!canSchedule) return notAllowed();

    // ── POST ?id=&action=run — Send now ──────────────────────────────────
    if (req.method === 'POST' && q.action === 'run') {
      const id = toId(q.id);
      if (!id) return send(res, refuse(400, 'id', 'id is required.'));
      if (!(await loadOne(id))) return notFound();
      // Claimed like a timetabled run, so a second press — or the
      // five-minute run reaching the same schedule — cannot send it again
      // while this one is still going.
      const token = runner.newClaimToken();
      const claimed = await runner.claimForSendNow(sql, id, company, token);
      if (!claimed) return send(res, refuse(409, 'busy', 'It is being sent right now — wait for that to finish.'));
      const startedAt = new Date();
      try {
        await runner.beginRun(sql, claimed, token, { kind: 'manual', now: startedAt });
      } catch (err) {
        console.error('[custom-report-schedules] could not start send now', id, err.message);
        try { await runner.releaseClaim(sql, claimed, token); } catch { /* goes stale instead */ }
        return send(res, refuse(500, 'not_started', 'Could not start it — the database did not answer. Try again.'));
      }
      const result = await runner.runSchedule(sql, claimed, {
        baseUrl: runner.appBaseUrl(req), now: startedAt, deadline: startedAt.getTime() + SEND_NOW_MS,
        progress: runner.progressWriter(sql, claimed, token), kind: 'manual',
      });
      try {
        await runner.recordRun(sql, claimed, result, {
          kind: 'manual', token, triggeredBy: payload.username, startedAt, now: new Date(),
        });
      } catch (err) {
        console.error('[custom-report-schedules] could not record send now', id, err.message);
      }
      console.log('[custom-report-schedules] send now', 'id=' + id, 'user=' + payload.username,
        'status=' + result.status, 'sent=' + result.sent);
      // Sent (or not) by now: failing to re-read the row must not turn that
      // into an error that invites a second press.
      let fresh = null;
      try { fresh = await loadOne(id); } catch { /* the page reloads the list anyway */ }
      return res.json({ ok: true, result, schedule: fresh ? shape(fresh, me) : null });
    }

    // ── POST — create ────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const checked = await validate(sql, { company, division, me, body: req.body });
      if (!checked.value) return send(res, checked);
      const v = checked.value;
      const count = await sql`SELECT COUNT(*)::int AS n FROM report_schedules WHERE company_code = ${company}`;
      if ((count[0] && count[0].n) >= MAX_SCHEDULES) {
        return send(res, refuse(400, 'cap', `A company can have at most ${MAX_SCHEDULES} scheduled reports.`));
      }
      const next = v.enabled ? T.nextRunAt(v, new Date()) : null;
      const rows = await sql`
        INSERT INTO report_schedules
          (company_code, report_type, division, project_id, project_name, picked_jobs, options,
           frequency, days_of_week, day_of_month, send_time, timezone, group_ids,
           subject, note, attach_pdf, enabled, run_as_user_id, run_as_username,
           next_run_at, created_by, created_by_username,
           custom_report_id, emails, use_job_contacts, jobs_mode)
        VALUES
          (${company}, ${v.report_type}, ${division}, ${v.project_id}, ${null},
           ${v.picked_jobs ? JSON.stringify(v.picked_jobs) : null}::jsonb, ${JSON.stringify(v.options)}::jsonb,
           ${v.frequency}, ${v.days_of_week ? JSON.stringify(v.days_of_week) : null}::jsonb, ${v.day_of_month},
           ${v.send_time}, ${v.timezone}, ${JSON.stringify(v.group_ids)}::jsonb,
           ${v.subject}, ${v.note}, ${v.attach_pdf}, ${v.enabled}, ${me.userId}, ${me.username},
           ${next ? next.toISOString() : null}, ${me.userId}, ${me.username},
           ${v.custom_report_id}, ${JSON.stringify(v.emails)}::jsonb, ${v.use_job_contacts}, ${v.jobs_mode})
        RETURNING id`;
      return res.json({ ok: true, schedule: shape(await loadOne(rows[0].id), me) });
    }

    // ── PUT ?id= — save, or switch off / on ──────────────────────────────
    if (req.method === 'PUT') {
      const id = toId(q.id);
      if (!id) return send(res, refuse(400, 'id', 'id is required.'));
      const cur = await loadOne(id);
      if (!cur) return notFound();
      const body = isPlainObject(req.body) ? req.body : {};
      const hasEnabled = Object.prototype.hasOwnProperty.call(body, 'enabled');
      const toggleOnly = hasEnabled && (Object.keys(body).length === 1 || settingsKey(body) === settingsKey(cur));

      let v;
      if (toggleOnly) {
        v = { ...cur, enabled: body.enabled !== false && body.enabled !== 'false' && Boolean(body.enabled) };
      } else {
        const checked = await validate(sql, { company, division, me, body });
        if (!checked.value) return send(res, checked);
        v = checked.value;
      }
      // Switched off: no next run. Switched on or retimed: the next matching
      // time from now — except a due occurrence kept due when the timetable
      // did not change and it stayed on (a typo fixed in its subject must not
      // skip today's send). What its earlier passes sent is kept only while
      // it is still the same report for the same jobs.
      const sameTimetable = cur.frequency === v.frequency && cur.send_time === v.send_time
        && cur.timezone === v.timezone
        && JSON.stringify(cur.days_of_week || null) === JSON.stringify(v.days_of_week || null)
        && (cur.day_of_month == null ? null : Number(cur.day_of_month)) === (v.day_of_month == null ? null : Number(v.day_of_month));
      const stillDue = cur.enabled && v.enabled && sameTimetable
        && cur.next_run_at && new Date(cur.next_run_at) <= new Date();
      const next = !v.enabled ? null : stillDue ? new Date(cur.next_run_at) : T.nextRunAt(v, new Date());
      const keepResume = Boolean(stillDue)
        && String(cur.custom_report_id) === String(v.custom_report_id)
        && runner.jobsModeOf(cur) === runner.jobsModeOf(v)
        && (cur.project_id || null) === (v.project_id || null);
      const sentBefore = Number(cur.resume_state && cur.resume_state.sent) || 0;
      const endedStatus = sentBefore ? 'partial' : 'skipped';
      const endedMessage = `The rest of its last send did not go out: it was ${v.enabled ? 'changed' : 'switched off'} before the next pass.`
        + (sentBefore ? ` ${sentBefore} report${sentBefore === 1 ? '' : 's'} had gone out before that.` : '');

      if (toggleOnly) {
        await sql`
          UPDATE report_schedules SET
            enabled       = ${Boolean(v.enabled)},
            next_run_at   = ${next ? next.toISOString() : null},
            resume_state  = CASE WHEN ${keepResume} THEN resume_state ELSE NULL END,
            resume_count  = CASE WHEN ${keepResume} THEN resume_count ELSE 0 END,
            last_status   = CASE WHEN last_status = 'continuing' AND NOT ${keepResume} THEN ${endedStatus} ELSE last_status END,
            last_message  = CASE WHEN last_status = 'continuing' AND NOT ${keepResume} THEN ${endedMessage} ELSE last_message END,
            updated_at    = NOW()
           WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND report_type = ${type}`;
      } else {
        await sql`
          UPDATE report_schedules SET
            project_id       = ${v.project_id},
            project_name     = ${null},
            picked_jobs      = ${v.picked_jobs ? JSON.stringify(v.picked_jobs) : null}::jsonb,
            options          = ${JSON.stringify(v.options)}::jsonb,
            frequency        = ${v.frequency},
            days_of_week     = ${v.days_of_week ? JSON.stringify(v.days_of_week) : null}::jsonb,
            day_of_month     = ${v.day_of_month},
            send_time        = ${v.send_time},
            timezone         = ${v.timezone},
            group_ids        = ${JSON.stringify(v.group_ids)}::jsonb,
            subject          = ${v.subject},
            note             = ${v.note},
            attach_pdf       = ${v.attach_pdf},
            enabled          = ${v.enabled},
            custom_report_id = ${v.custom_report_id},
            emails           = ${JSON.stringify(v.emails)}::jsonb,
            use_job_contacts = ${v.use_job_contacts},
            jobs_mode        = ${v.jobs_mode},
            run_as_user_id   = ${me.userId},
            run_as_username  = ${me.username},
            next_run_at      = ${next ? next.toISOString() : null},
            resume_state     = CASE WHEN ${keepResume} THEN resume_state ELSE NULL END,
            resume_count     = CASE WHEN ${keepResume} THEN resume_count ELSE 0 END,
            last_status      = CASE WHEN last_status = 'continuing' AND NOT ${keepResume} THEN ${endedStatus} ELSE last_status END,
            last_message     = CASE WHEN last_status = 'continuing' AND NOT ${keepResume} THEN ${endedMessage} ELSE last_message END,
            updated_at       = NOW()
           WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND report_type = ${type}`;
      }
      return res.json({ ok: true, schedule: shape(await loadOne(id), me) });
    }

    // ── DELETE ?id= ──────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const id = toId(q.id);
      if (!id) return send(res, refuse(400, 'id', 'id is required.'));
      const rows = await sql`
        DELETE FROM report_schedules
         WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND report_type = ${type}
         RETURNING id`;
      return res.json({ ok: true, deleted: rows.length > 0 });
    }

    return res.status(405).json({ ok: false, error: 'method', message: 'Method not allowed' });
  } catch (err) {
    console.error('[custom-report-schedules]', err.message);
    return res.status(500).json({ ok: false, error: 'database', message: 'Database error' });
  }
};

module.exports.readBody = readBody;
module.exports.settingsKey = settingsKey;
module.exports.FIXED_DATES_MSG = FIXED_DATES_MSG;
module.exports.MAX_SCHEDULES = MAX_SCHEDULES;
