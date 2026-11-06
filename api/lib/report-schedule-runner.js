'use strict';

// Run one scheduled report: build it the way its Email button does, and send
// it to the schedule's recipient groups.
//
// "The way its Email button does" is literal. The reports are built in the
// division pages, from the data those pages load, by functions that are
// thousands of lines of page code apiece. Rebuilding them here would give
// every report two copies that drift apart within a release, and the first a
// PM would hear of it is a number in the 6:30 email that does not match the
// screen. So the runner opens the page in headless Chrome, signed in as the
// admin who scheduled it, waits for the page's data, and calls the page's own
// builder through window.dwAutoReport (auto-report.js). Then it sends what
// came back through the same delivery path the button uses.
//
// The robot only reads. Every write the page attempts while it is open —
// presence heartbeats, the dust page's unload flush, a cleanup pass on boot —
// is refused at the network layer. A page left open by a person can save; a
// page opened by a timer to read a report must never be the thing that
// overwrote a foreman's afternoon of entries.
//
// Access is checked at every send, against the account as it is now: a
// division taken away from the admin who scheduled a report stops that report
// rather than leaving a timetable as a way around Manage Users.
//
// A saved Custom Reporting report (SCHEDULABLE[type].customReport) is sent
// customer-safe or not at all. Before anything is built the saved report is
// read again: deleted, no longer shared with the account it runs as, switched
// to internal data, or that account made sales since — the run stops and says
// so in plain words. The page is handed the definition as it is now
// (spec.customReport), forces internal data off itself, and anything that
// still comes back carrying the engine's internal mark is refused before it
// is sent. What does go is written into the report's own send history
// (custom_report_runs, run_kind 'schedule' or 'send_now') with the HTML that
// went, so Customer History can open exactly what the owner received.

const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const { currentAccess, isSalesIn } = require('./auth');
const { MAX_HTML_BYTES, isValidEmail, normalizeAttachments, sanitizeReportHtml } = require('./email');
const { launchBrowser } = require('./pdf');
const { deliverReport } = require('./report-delivery');
const { SCHEDULABLE, DIVISIONS, PAY_RANGES, JOBS_MODES, mayUseDivision, periodsFor } = require('./report-catalog');
const T = require('./report-schedule-time');
const CR = require('./custom-report-runs');
const { contactsForJobs, clientKeyOf } = require('./report-contacts');

// Time limits. The function running all this is killed at 300s (vercel.json),
// so every wait is the smaller of its own limit and what is left before the
// run's deadline, keeping back enough to send what has been built.
const PAGE_LOAD_MS  = 45_000;   // the page, and its data, before it offers the report
const BUILD_MS      = 90_000;   // one report — one job's, for an every-job schedule
const SEND_NEEDS_MS = 50_000;   // a PDF render (up to 45s) and the mail service
// Resend allows a couple of requests a second; an "every In Progress job"
// schedule sends one email per job, back to back.
const SEND_GAP_MS   = 600;
// A job-by-job schedule over a company's whole active list could run past the
// function's time limit. This many is well inside it, and a company with more
// active jobs than this should be splitting the schedule up anyway.
const MAX_ITEMS     = 40;

// A claim older than this belongs to a run that died, and is free to take.
const STALE_CLAIM    = '15 minutes';
const STALE_CLAIM_MS = 15 * 60 * 1000;

// The POSTs that are questions rather than writes. The Daily PM report's AI
// read of a job goes out as a POST; it saves nothing but its own once-a-day
// answer cache, and without it the scheduled copy would be missing the block
// the button's copy has.
const READ_ONLY_POSTS = new Set(['/api/ai/schedule-analysis']);
const READ_ONLY_BODY  = JSON.stringify({ error: 'Scheduled report runs are read-only.' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEARTBEAT_MS = 5_000;   // how often a long step's progress note is refreshed

function divisionName(key) {
  const d = DIVISIONS.find(x => x.key === key);
  return d ? d.name : key;
}

/** How long a step may take: its own limit, or what the deadline leaves after `reserve`. */
function budget(deadline, max, reserve = 0) {
  if (!deadline) return max;
  return Math.min(max, deadline - Date.now() - reserve);
}

/**
 * The page's origin, for the headless browser to open.
 *
 * Never taken from the request when the deployment knows its own address.
 * The robot carries a live session for the schedule's owner into whatever
 * origin it opens, so a Host header an admin could shape would let them
 * point it at a page of their own and walk off with another admin's token.
 * APP_BASE_URL wins when set; then the platform's own address — production's
 * domain in production, the deployment's URL on a preview, so a preview's
 * "Send now" builds with that preview's pages. Only with neither (a laptop
 * running the dev server) does the request's host stand in.
 */
function appBaseUrl(req) {
  const explicit = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const platform = process.env.VERCEL_ENV === 'production'
    ? (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL)
    : process.env.VERCEL_URL;
  if (platform) return `https://${String(platform).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const h = req && req.headers ? req.headers.host : '';
  if (h) {
    const host = String(h).split(',')[0].trim();
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return `${local ? 'http' : 'https'}://${host}`;
  }
  return '';
}

/**
 * The company name the email around a report carries: the branding's display
 * name, else the company's own — the rule send-report.js reads for an email
 * sent by hand, so a scheduled one is not headed differently. Any failure
 * (an older schema without company_branding) keeps the name already read.
 */
async function mailCompanyName(sql, company, fallback) {
  try {
    const rows = await sql`
      SELECT NULLIF(btrim(display_name), '') AS name FROM company_branding
       WHERE company_code = ${company} AND division = ''`;
    const name = rows[0] && typeof rows[0].name === 'string' ? rows[0].name.trim() : '';
    return name || fallback;
  } catch (err) {
    console.error('[report-schedules] branding name not read, using the company name:', err.message);
    return fallback;
  }
}

/** The account a schedule runs as, with its access as of now — or null. */
async function loadRunAs(sql, sched) {
  const rows = await sql`
    SELECT u.id, u.username, u.company_code, c.name AS company_name
      FROM users u
      JOIN companies c ON c.code = u.company_code
     WHERE u.id = ${sched.run_as_user_id}
     LIMIT 1`;
  const row = rows && rows[0];
  if (!row) return null;
  if (String(row.company_code).toUpperCase() !== String(sched.company_code).toUpperCase()) return null;
  const access = await currentAccess(sql, { userId: row.id, companyCode: row.company_code });
  if (!access) return null;
  return {
    userId:      row.id,
    username:    row.username,
    companyCode: String(row.company_code).toUpperCase(),
    companyName: row.company_name || row.company_code,
    ...access,
  };
}

/**
 * Every address on the schedule's groups, de-duplicated, in the order the
 * groups were picked, plus how many groups have gone. Not capped: past the
 * fifty one email can carry, deliverReport sends it as several.
 *
 * An address the mail service would refuse — saved before the check was as
 * strict as it is — is kept off the list, since one would stop the email
 * going to anybody, and comes back in `invalid` with its group's name so the
 * run can say who was left off.
 */
async function recipientsFor(sql, companyCode, groupIds) {
  const ids = (Array.isArray(groupIds) ? groupIds : []).map(Number).filter(Number.isFinite);
  if (!ids.length) return { emails: [], invalid: [], groups: [], missing: 0 };
  const rows = (await sql`
    SELECT id, name, emails FROM report_recipient_groups
     WHERE company_code = ${companyCode} AND id = ANY(${ids})`)
    .sort((a, b) => ids.indexOf(Number(a.id)) - ids.indexOf(Number(b.id)));
  const seen = new Set();
  const emails = [];
  const invalid = [];
  for (const g of rows) {
    for (const raw of (Array.isArray(g.emails) ? g.emails : [])) {
      const e = String(raw || '').trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      if (isValidEmail(e)) emails.push(e);
      else invalid.push({ email: e, group: g.name });
    }
  }
  return { emails, invalid, groups: rows.map(g => g.name), missing: ids.length - rows.length };
}

/**
 * The addresses left off a send, for a run's message. Each came from a
 * recipient group (the usual case), the schedule's own extra addresses
 * (source 'schedule') or a job's saved contacts (source 'contact'), and the
 * fix named is the one for where it came from.
 */
function leftOffText(invalid) {
  if (!invalid || !invalid.length) return '';
  const shown = invalid.slice(0, 5).map(x => `${x.email} (${x.group})`).join(', ')
    + (invalid.length > 5 ? ` and ${invalid.length - 5} more` : '');
  const fixes = [];
  if (invalid.some(x => !x.source || x.source === 'group')) fixes.push('with Edit on the group');
  if (invalid.some(x => x.source === 'schedule')) fixes.push('by editing the schedule');
  if (invalid.some(x => x.source === 'contact')) fixes.push('in the job\'s saved contacts');
  const fix = fixes.join(' or ');
  return invalid.length === 1
    ? `Left off ${shown} — not a valid email address; fix it ${fix}.`
    : `Left off ${shown} — not valid email addresses; fix them ${fix}.`;
}

/**
 * Fold more addresses into a recipient list (recipientsFor's shape): once
 * each, without case, in order; one the mail service would refuse goes to
 * `invalid` with where it came from. Returns a new list.
 */
function addRecipients(list, raw, label, source) {
  const out = { ...list, emails: list.emails.slice(), invalid: list.invalid.slice() };
  const seen = new Set([...out.emails, ...out.invalid.map(x => x.email)]);
  for (const r of (Array.isArray(raw) ? raw : [])) {
    const e = String((r && typeof r === 'object' ? r.email : r) || '').trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    if (isValidEmail(e)) out.emails.push(e);
    else out.invalid.push({ email: e, group: label, source });
  }
  return out;
}

// ── Scheduled custom reports ────────────────────────────────────────────────

const optionsOf = sched => (sched && sched.options && typeof sched.options === 'object' && !Array.isArray(sched.options) ? sched.options : {});

/** The saved report a custom schedule sends: its column, else the copy in options. */
function customReportIdOf(sched) {
  return CR.toId(sched && sched.custom_report_id) || CR.toId(optionsOf(sched).report_id);
}

/** Which jobs a custom schedule covers (JOBS_MODES). */
function jobsModeOf(sched) {
  if (JOBS_MODES.includes(sched && sched.jobs_mode)) return sched.jobs_mode;
  const o = optionsOf(sched);
  if (JOBS_MODES.includes(o.jobs_mode)) return o.jobs_mode;
  return sched && sched.project_id === '*' ? 'each' : 'saved';
}

/**
 * The saved report a custom schedule sends, read now and checked against the
 * account it runs as now — { report, mode }, or { error } in words for the
 * schedule's row. Customer-safe only: a report switched to internal data
 * since it was scheduled stops the schedule rather than going out.
 */
async function loadCustomReport(sql, sched, acct, def) {
  const savedName = String(optionsOf(sched).report_name || '').trim();
  if (isSalesIn(acct, def.division)) {
    return { error: `${acct.username} is a sales login in ${divisionName(def.division)} now, and sales cannot open Custom Reporting. `
      + 'Have an admin or level 3 user edit and save the schedule to run it as them.' };
  }
  const gone = n => ({ error: `The saved report${n ? ` “${n}”` : ''} was deleted. Restore it in Custom Reporting, or delete this schedule.` });
  const id = customReportIdOf(sched);
  if (!id) return gone(savedName);
  const rows = await sql`
    SELECT id, name, kind, visibility, owner_user_id, customer_safe, definition, version, deleted_at
      FROM custom_reports
     WHERE id = ${id} AND company_code = ${sched.company_code} AND division = ${def.division}
     LIMIT 1`;
  const r = rows && rows[0];
  const name = (r && r.name) || savedName;
  if (!r || r.deleted_at) return gone(name);
  if (!(r.visibility === 'shared' || Number(r.owner_user_id) === Number(acct.userId))) {
    return { error: `“${name}” is no longer shared with ${acct.username}, who this schedule runs as. `
      + 'Share it again, or have its owner edit and save the schedule.' };
  }
  const definition = CR.isPlainObject(r.definition) ? r.definition : {};
  if (r.customer_safe === false || definition.includeInternal === true) {
    return { error: `“${name}” now includes internal data — scheduled sends are customer-safe only. `
      + 'Switch internal data off in Custom Reporting and save it to start sending again.' };
  }
  const dates = CR.isPlainObject(definition.dates) ? definition.dates : {};
  if (dates.preset === 'custom') {
    return { error: `“${name}” is set to fixed dates now, so every email would show the same days. `
      + 'Give it a relative date range like Last week and save it.' };
  }
  const mode = jobsModeOf(sched);
  if (mode === 'saved' && r.kind !== 'report') {
    return { error: `“${name}” no longer saves its jobs, so this schedule does not know which jobs to send. `
      + 'Edit the schedule and pick the jobs it covers.' };
  }
  // The other way round: a template scheduled once per job (or as every In
  // Progress job) that has since been saved with its own jobs is a report
  // about THOSE jobs — its name, its "Prepared for", its filters — and is
  // not sent for every other job. Saving the schedule makes it send for the
  // report's own jobs (the editor offers nothing else for it).
  if (mode !== 'saved' && r.kind === 'report') {
    return { error: `“${name}” now saves its own jobs, so it is no longer sent ${mode === 'all_in_progress' ? 'as one report of every In Progress job' : 'once per job'}. `
      + 'Open the schedule and save it to send it for those jobs.' };
  }
  return {
    mode,
    report: {
      id: Number(r.id), name, kind: r.kind, version: Number(r.version) || 1,
      // Forced off here as well as on the page: the one setting a schedule
      // must never send with.
      definition: { ...definition, includeInternal: false },
    },
  };
}

/**
 * A custom report item's log record (its customReport, as the page returned
 * it), tidied: job ids and names as lists, the jobs' clients where the page
 * gave them, and the dates and definition it was built from.
 */
function customRecordOf(it, custom, spec) {
  const c = it && CR.isPlainObject(it.customReport) ? it.customReport : {};
  const list = v => (Array.isArray(v) ? v : []);
  let ids = list(c.project_ids).map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  if (!ids.length && it && it.projectId) ids = [String(it.projectId)];
  if (!ids.length && spec && spec.jobsMode === 'saved') {
    const j = custom.definition.jobs;
    ids = list(j && !Array.isArray(j) ? j.ids : j).map(String).filter(Boolean);
  }
  const names = list(c.project_names).map(x => String(x == null ? '' : x));
  // Clients as the page sent them: a list beside project_ids (a name, or
  // { id, client }), or none — then they are read from the jobs.
  const raw = list(c.clients);
  const clients = new Map();
  raw.forEach((x, i) => {
    if (x && typeof x === 'object') {
      const id = x.id != null ? String(x.id) : ids[i];
      const name = x.client != null ? x.client : x.name;
      if (id && typeof name === 'string') clients.set(id, name);
    } else if (typeof x === 'string' && ids[i]) {
      clients.set(ids[i], x);
    }
  });
  return {
    project_ids:   ids,
    project_names: ids.map((id, i) => names[i] || ''),
    clients,
    date_from:     c.date_from || null,
    date_to:       c.date_to || null,
    definition:    CR.isPlainObject(c.definition) ? { ...c.definition, includeInternal: false } : custom.definition,
  };
}

/**
 * Jobs a custom report item covers that it was not asked for, in words — or
 * null. One email per job is that job; a saved report, its saved jobs (a job
 * since deleted drops out, which is fine). An item that says nothing about
 * its jobs is taken to be the job asked for.
 */
function strayJobsOf(rec, mode, asked, custom) {
  if (mode === 'each') {
    const want = String(asked && asked.projectId);
    if (!rec.project_ids.length) { rec.project_ids = [want]; rec.project_names = [(asked && asked.projectName) || '']; return null; }
    const other = rec.project_ids.filter(id => id !== want);
    return other.length ? other.join(', ') : null;
  }
  if (mode === 'saved') {
    const j = custom.definition.jobs;
    const saved = new Set((Array.isArray(j) ? j : (j && Array.isArray(j.ids) ? j.ids : [])).map(String));
    const other = rec.project_ids.filter(id => !saved.has(id));
    return other.length ? other.join(', ') : null;
  }
  return null;
}

/** What a custom report item is called in the run's messages: its job, its jobs, or the report. */
function customItemName(rec, custom) {
  if (rec.project_ids.length === 1) return rec.project_names[0] || custom.name;
  if (rec.project_ids.length > 1) return `${custom.name} (${rec.project_ids.length} jobs)`;
  return custom.name;
}

/** The clients of jobs the page did not say, read from the jobs themselves, once per run. */
async function clientsFromJobs(sql, company, division, ids, cache) {
  const want = ids.filter(id => !cache.has(id));
  if (want.length) {
    const { PROJECT_KEYS } = require('../executive/report');
    const keys = PROJECT_KEYS[division];
    if (keys) {
      const key = id => `${company}:${keys.prefix}${id}`;
      const rows = await sql`
        SELECT key, value->>'client' AS client FROM app_data WHERE key = ANY(${want.map(key)})`;
      const byKey = new Map(rows.map(r => [r.key, r.client]));
      for (const id of want) cache.set(id, byKey.get(key(id)) || '');
    }
  }
  return ids.map(id => cache.get(id) || '');
}

/**
 * Do these jobs belong to one customer? One job always does; several do only
 * when every one names the same client (compared as the contacts file them).
 * A job with no client could be anybody's, so several with one blank do not.
 */
function oneCustomer(clients) {
  if (clients.length <= 1) return true;
  const keys = clients.map(c => clientKeyOf(c));
  return keys.every(k => k && k === keys[0]);
}

/**
 * The saved contacts (auto_add) of an item's jobs and their clients, as
 * { contacts } — or { mixed: true } when the item covers more than one
 * customer's jobs. A report about several customers' jobs never goes to those
 * customers' contacts: each would be sent the others' jobs.
 */
async function jobContactsFor(sql, sched, division, rec, cache) {
  if (!rec.project_ids.length) return { contacts: [] };
  let clients = rec.project_ids.map(id => rec.clients.get(id));
  if (clients.some(c => c === undefined)) {
    const read = await clientsFromJobs(sql, sched.company_code, division, rec.project_ids, cache);
    clients = clients.map((c, i) => (c === undefined ? read[i] : c));
  }
  if (!oneCustomer(clients)) return { mixed: true, contacts: [] };
  return {
    contacts: await contactsForJobs(sql, sched.company_code, division,
      rec.project_ids.map((id, i) => ({ id, client: clients[i] || '' }))),
  };
}

/** The clients of these jobs, read from the jobs (for the schedules API's own check). */
async function clientsOfJobs(sql, company, division, ids) {
  return clientsFromJobs(sql, company, division, (Array.isArray(ids) ? ids : []).map(String), new Map());
}

/**
 * Write a sent custom report into its send history, with the HTML that
 * went. Never throws: the email has gone, and a failed log must not turn
 * that into a failed run.
 */
async function logCustomSend(sql, { sched, def, acct, custom, rec, recipients, subject, html, runKind }) {
  const base = {
    action: 'email', run_kind: runKind, schedule_id: sched.id, included_internal: false,
    report_id: custom.id, report_name: custom.name,
    recipients: recipients.slice(0, CR.MAX_RUN_RECIPIENTS), subject,
  };
  const kinds = { kinds: ['schedule', 'send_now'] };
  let r = CR.readRun({
    ...base, project_ids: rec.project_ids, project_names: rec.project_names,
    date_from: rec.date_from, date_to: rec.date_to, definition: rec.definition,
  }, kinds);
  // Something about the jobs or dates would not store: logged anyway, without them.
  if (r.error) r = CR.readRun(base, kinds);
  if (r.error) {
    console.error('[report-schedules] custom report send not logged:', r.error, 'schedule=' + sched.id);
    return { logged: false, archived: false };
  }
  let run;
  try {
    run = await CR.insertRun(sql, {
      company: sched.company_code, division: def.division,
      me: { userId: acct.userId, username: acct.username }, run: r.value,
    });
  } catch (err) {
    console.error('[report-schedules] custom report send not logged:', err.message, 'schedule=' + sched.id);
    return { logged: false, archived: false };
  }
  let archived = false;
  try {
    // What went out is what deliverReport sanitized: the same function on
    // the same string gives the same document.
    archived = await CR.insertArchive(sql, { runId: run.id, company: sched.company_code, html: sanitizeReportHtml(html) });
  } catch (err) {
    console.error('[report-schedules] custom report archive not written:', err.message, 'run=' + run.id);
  }
  return { logged: true, runId: run.id, archived };
}

/**
 * What the page is asked to build: the report, the job (or every In Progress
 * job), and the dates the schedule's period means in its zone.
 *
 * `at` is the occurrence being sent, not the moment the run got to it. A 6:30
 * report the server reaches at 6:34 is the 6:30 one; a Sunday 11:55 PM report
 * reached at 12:00 AM is still Sunday's, and a "previous day" built off the
 * clock instead would quietly cover the wrong day.
 */
function specFor(sched, def, at) {
  const now = at instanceof Date ? at : new Date(at);
  const tz   = T.isValidTimeZone(sched.timezone) ? sched.timezone : T.DEFAULT_TZ;
  const opts = sched.options && typeof sched.options === 'object' ? sched.options : {};
  const spec = {
    type:        sched.report_type,
    projectId:   sched.project_id || null,
    projectName: sched.project_name || null,
    options:     opts,
    timezone:    tz,
    today:       T.localDate(now, tz),
  };
  if (def.scope === 'job' && !spec.projectId) spec.projectId = '*';
  // A saved custom report: its own saved jobs, or every In Progress job in
  // one report — one build, no job — or one email per job ('*', the jobs
  // picked on the schedule or every In Progress one). Its dates are its
  // definition's own preset, worked out by the page from spec.today.
  if (def.customReport) {
    spec.jobsMode = jobsModeOf(sched);
    if (spec.jobsMode === 'each') {
      if (!spec.projectId) spec.projectId = '*';
    } else {
      spec.projectId = null;
      spec.projectName = null;
    }
  }
  // One email per job, for the jobs ticked on the schedule rather than every
  // job marked In Progress (dwAutoReport.plan).
  if (spec.projectId === '*' && Array.isArray(sched.picked_jobs) && sched.picked_jobs.length) {
    spec.pickedJobs = sched.picked_jobs
      .filter(j => j && j.id != null && String(j.id) !== '*')
      .map(j => ({ id: String(j.id), name: j.name || null }));
  }
  if (def.period) {
    const period = periodsFor(def, T.PERIODS).includes(opts.period) ? opts.period : def.period;
    const r = T.periodRange(period, now, tz);
    spec.start = r.start;
    spec.end = r.end;
  }
  if (def.day) {
    const which = ['today', 'tomorrow', 'next_workday'].includes(opts.day) ? opts.day : def.day;
    spec.day = which === 'today' ? spec.today
      : which === 'tomorrow' ? T.localDate(now, tz, 1)
      : nextWorkday(now, tz);
  }
  if (def.payRange) {
    // A name, not dates: the payroll page knows its own weeks and cycles.
    spec.options = { ...opts, range: Object.prototype.hasOwnProperty.call(PAY_RANGES, opts.range) ? opts.range : def.payRange };
  }
  if (def.sections) {
    // As saved: the page says so if a picked section is no longer on it,
    // rather than this quietly sending the whole report instead.
    spec.options = { ...spec.options, sections: Array.isArray(opts.sections) && opts.sections.length ? opts.sections.map(String) : null };
  }
  if (def.year) {
    spec.year = opts.year === 'all' ? 'all' : spec.today.slice(0, 4);
  }
  return spec;
}

function nextWorkday(now, tz) {
  for (let i = 1; i <= 7; i++) {
    const d = T.localDate(now, tz, i);
    const wd = new Date(d + 'T12:00:00Z').getUTCDay();
    if (wd >= 1 && wd <= 5) return d;
  }
  return T.localDate(now, tz, 1);
}

/** A thirty-minute session for the robot — the account's own, as login.js signs it. */
function robotToken(acct) {
  return jwt.sign({
    userId:           acct.userId,
    username:         acct.username,
    companyCode:      acct.companyCode,
    companyName:      acct.companyName,
    role:             acct.role,
    divisionRoles:    acct.divisionRoles,
    allowedDivisions: acct.allowedDivisions,
    isPlatformAdmin:  acct.isPlatformAdmin,
  }, process.env.JWT_SECRET, { expiresIn: '30m' });
}

// A failure that is about time, not about the report: worth another try at
// the next five-minute pass (see handBack), where a page that is broken is not.
const timeUp = msg => Object.assign(new Error(msg), { timeout: true });
const isTimeUp = err => Boolean(err && (err.timeout || err.name === 'TimeoutError'));

// `why`, if given, is asked at the moment of the timeout for what the page was
// doing then — so the schedule's row says what it was stuck on, not just that
// it was slow.
function withTimeout(promise, ms, what, why) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(async () => {
        let detail = '';
        try { detail = why ? await why() : ''; } catch { /* the bare message, then */ }
        rej(timeUp(`${what} took longer than ${Math.round(ms / 1000)}s${detail ? '. ' + detail : ''}`));
      }, ms);
    }),
  ]);
}

// Where the page sent the robot instead of opening, in words. Vercel's own
// login (Deployment Protection, on preview deployments by default) gets its
// own explanation, since that is the one an admin can do something about.
function sentAwayMessage(def, origin, url) {
  const page = `the ${divisionName(def.division)} page`;
  let to = null;
  try { to = new URL(url); } catch { /* not a URL: say it as it is */ }
  let from = null;
  try { from = new URL(origin); } catch { /* as is */ }
  const deployment = from ? from.host : String(origin);
  if (to && /(^|\.)vercel\.com$/i.test(to.hostname)) {
    const lead = `Could not open ${page}: this deployment (${deployment}) is behind Vercel's login (Deployment Protection), `
      + 'which sent the report robot to sign in. ';
    return process.env.VERCEL_ENV === 'production'
      ? lead + 'That includes production here, so no scheduled report can open its page: turn on Protection Bypass '
        + 'for Automation in the Vercel project (Settings → Deployment Protection) and redeploy, or take production '
        + 'out of protection.'
      : lead + 'Production domains are not behind it under Vercel\'s standard protection, so scheduled reports run '
        + 'there; to send one from a preview, turn on Protection Bypass for Automation in the Vercel project and redeploy.';
  }
  if (to && from && to.host === from.host && to.protocol !== from.protocol) {
    return `Could not open ${page}: ${from.origin} sent the report robot to ${to.origin} instead. `
      + `The app's address should be its ${to.protocol}// one — check APP_BASE_URL.`;
  }
  if (!to || to.protocol === 'chrome-error:') {
    return `Could not open ${page}: ${deployment} would not load it for the report robot (${url}).`;
  }
  return `Could not open ${page}: ${deployment} sent the report robot to ${to.host} instead.`;
}

/**
 * Open `def.page` as `acct`, ready to be asked for reports.
 *
 *   const session = await openReportPage(browser, { baseUrl, def, acct, spec, deadline });
 *   await session.plan(spec)         → { jobs: null } | { jobs: [{ id, name }] }
 *   await session.build(spec)        → { items, skipped, errors }
 *   await session.close()
 *
 * One page in the browser's default context. Not a fresh context per run,
 * which is the obvious way to keep one account's session from the next:
 * serverless Chrome runs single-process, and opening a second context there
 * kills the browser outright ("Target closed"). So the app origin's storage is
 * wiped instead — on open, for anything a crashed run left, and on close, so
 * the next schedule (another account, perhaps another company) opens on
 * nothing but what it is given.
 *
 * Throws, in words, when the page will not open or will not offer the report.
 */
async function openReportPage(browser, { baseUrl, def, acct, spec, deadline }) {
  if (!baseUrl) throw new Error('The server does not know its own address (set APP_BASE_URL).');
  const origin = new URL(baseUrl).origin;
  const stats = { blockedWrites: 0, pageErrors: [] };
  // For the message when the page is too slow: the app's requests still
  // open, and the last few things the page warned about.
  const inflight = new Map();
  const warnings = [];
  const page = await browser.newPage();
  let cdp = null;
  const wipe = async () => {
    try {
      if (!cdp) cdp = await page.createCDPSession();
      await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    } catch { /* best effort: the page may already be gone */ }
  };
  const close = async () => {
    // Off the app first, so nothing on it writes to storage after the wipe.
    try { await page.goto('about:blank', { timeout: 10_000 }); } catch { /* close regardless */ }
    await wipe();
    try { await page.close(); } catch { /* already gone */ }
  };

  try {
    await wipe();
    await page.setViewport({ width: 1440, height: 900 });
    // The page's "today" is the office's today: a report the schedule sends
    // at 9 PM Eastern must not be built for tomorrow because the server's
    // clock is already past midnight UTC.
    try { await page.emulateTimezone(spec.timezone); } catch { /* keep the server's */ }

    // Deployment Protection's bypass secret, for a preview that has it on —
    // added here, to the app's own requests only. Set on the page instead, it
    // rides along on every request the page makes, the CDN's included, and
    // that secret opens every protected deployment of the project.
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '';
    await page.setRequestInterception(true);
    // Every answer to a paused request is a promise, and Puppeteer rejects it
    // when it cannot apply it — the request already gone, interception not on
    // for whatever made it, a header Chrome will not take. Left unhandled,
    // that rejection ends the whole function on Vercel: no result written,
    // "Interrupted" on the row, a bare HTTP 500 for Send now. So none is left
    // unhandled, and a request whose header override is refused still goes,
    // without it, rather than hang.
    const settle = p => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
    page.on('request', req => {
      try {
        const url = req.url();
        if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return settle(req.continue());
        let u;
        try { u = new URL(url); } catch { return settle(req.abort()); }
        if (/^\/_vercel\/(insights|speed-insights)\//.test(u.pathname)) return settle(req.abort());
        const method = req.method();
        const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
        if (u.origin === origin) {
          if (read || READ_ONLY_POSTS.has(u.pathname)) {
            if (u.pathname.startsWith('/api/')) inflight.set(req, Date.now());
            if (!bypass) return settle(req.continue());
            return req.continue({ headers: { ...req.headers(), 'x-vercel-protection-bypass': bypass } })
              .catch(() => settle(req.continue()));
          }
          // Refused the way a server refuses, not dropped the way a network
          // drops: the pages retry a failed connection with backoff (the job
          // pages give a refused bulk save 1 + 2 + 4 seconds), and a page that
          // does that once per job at boot never gets as far as the report.
          stats.blockedWrites++;
          return settle(req.respond({ status: 403, contentType: 'application/json', body: READ_ONLY_BODY }));
        }
        // The pages pull a few libraries and fonts from CDNs. Reads only, and
        // only the kinds of thing a page renders with.
        if (read && ['script', 'stylesheet', 'font', 'image'].includes(req.resourceType())) return settle(req.continue());
        // The page itself going elsewhere — Vercel's login in front of a
        // protected deployment, say. Not followed; written down, so the run
        // can say where it was sent rather than just "net::ERR_FAILED".
        try {
          if (req.isNavigationRequest() && req.frame() === page.mainFrame()) stats.sentTo = url;
        } catch { /* the frame is gone; nothing to say */ }
        return settle(req.abort());
      } catch { /* already handled */ }
    });
    page.on('requestfinished', req => inflight.delete(req));
    page.on('requestfailed', req => inflight.delete(req));
    // An alert() would hang the page forever with nobody to click OK.
    page.on('dialog', d => { d.dismiss().catch(() => {}); });
    page.on('pageerror', err => { if (stats.pageErrors.length < 5) stats.pageErrors.push(String(err && err.message || err)); });
    page.on('console', msg => {
      try {
        if (msg.type() !== 'warn' && msg.type() !== 'warning' && msg.type() !== 'error') return;
        const text = String(msg.text() || '');
        if (!text || /^Failed to load resource/.test(text)) return;   // the CDNs' noise, not the page's
        warnings.push(text.slice(0, 160));
        if (warnings.length > 3) warnings.shift();
      } catch { /* a message is never worth failing over */ }
    });

    const user = {
      username:         acct.username,
      companyCode:      acct.companyCode,
      companyName:      acct.companyName,
      role:             acct.role,
      divisionRoles:    acct.divisionRoles,
      allowedDivisions: acct.allowedDivisions,
      isPlatformAdmin:  acct.isPlatformAdmin,
    };
    await page.evaluateOnNewDocument((appOrigin, ls, readOnlyPosts, refusal) => {
      // The session goes to the app's own origin and nowhere else — not to
      // a page the app redirects to, not to a frame from somewhere else.
      if (location.origin !== appOrigin) return;
      try { for (const k of Object.keys(ls)) localStorage.setItem(k, ls[k]); } catch (_) { /* opaque origin */ }

      // The second lock on the door. Request interception refuses writes while
      // the page is open, but a page that flushes on its way out — the dust
      // page PUTs every row on pagehide, with keepalive so the request outlives
      // the page — hands that request to the browser after interception has
      // let go of it. So writes are also refused here, before they exist.
      const READS = ['GET', 'HEAD', 'OPTIONS'];
      const allowed = url => {
        try {
          const u = new URL(url, location.href);
          return u.origin !== location.origin || readOnlyPosts.includes(u.pathname);
        } catch (_) { return false; }
      };
      // Answered with a 403, as the server answers a write it will not take —
      // not a rejected fetch, which the pages read as a dropped connection
      // and retry with backoff.
      const realFetch = window.fetch;
      window.fetch = function (input, init) {
        const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (!READS.includes(method) && !allowed(url)) {
          window.__dwRefusedWrites = (window.__dwRefusedWrites || 0) + 1;
          return Promise.resolve(new Response(refusal, { status: 403, headers: { 'Content-Type': 'application/json' } }));
        }
        return realFetch.apply(this, arguments);
      };
      if (navigator.sendBeacon) navigator.sendBeacon = () => false;
      const xhrOpen = XMLHttpRequest.prototype.open;
      const xhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__dwWrite = !READS.includes(String(method || 'GET').toUpperCase()) && !allowed(url);
        return xhrOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        if (this.__dwWrite) throw new TypeError('Scheduled report runs are read-only.');
        return xhrSend.apply(this, arguments);
      };
    }, origin, {
      fct_token:        robotToken(acct),
      fct_user:         JSON.stringify(user),
      fct_division:     def.division,
      fct_company_code: acct.companyCode,
    }, [...READ_ONLY_POSTS], READ_ONLY_BODY);

    const loadMs = () => budget(deadline, PAGE_LOAD_MS, SEND_NEEDS_MS);
    if (loadMs() < 5_000) throw timeUp('The run ran out of time before the page could be opened.');
    page.setDefaultTimeout(loadMs());
    let opened;
    try {
      opened = await page.goto(`${baseUrl}/${def.page}?autoreport=1`, { waitUntil: 'domcontentloaded', timeout: loadMs() });
    } catch (err) {
      if (stats.sentTo) throw new Error(sentAwayMessage(def, origin, stats.sentTo));
      throw err;
    }
    // Sent elsewhere by the page's own script (a login page that redirects
    // in script, not by HTTP): goto resolves — to nothing — and the frame
    // sits on Chrome's error page. Said now, not after the whole load wait.
    if (stats.sentTo || (!opened && String(page.url()).startsWith('chrome-error://'))) {
      throw new Error(sentAwayMessage(def, origin, stats.sentTo || page.url()));
    }
    const status = opened && typeof opened.status === 'function' ? opened.status() : null;
    if (status === 401 || status === 403) {
      throw new Error(`The ${divisionName(def.division)} page answered HTTP ${status} — ${new URL(origin).host} refused the report robot. `
        + 'If this deployment is behind Vercel\'s login (Deployment Protection), see Protection Bypass for Automation.');
    }

    try {
      await page.waitForFunction(
        t => window.dwAutoReport && window.dwAutoReport.has(t),
        { timeout: Math.max(1_000, loadMs()), polling: 250 }, spec.type);
    } catch (waitErr) {
      // Sent elsewhere after the document loaded: the same message as above.
      if (stats.sentTo) throw new Error(sentAwayMessage(def, origin, stats.sentTo));
      const where = (() => { try { return new URL(page.url()).pathname; } catch { return ''; } })();
      if (!where.endsWith('/' + def.page)) {
        throw new Error(`The ${divisionName(def.division)} page sent ${acct.username} away (to ${where || 'another page'}) instead of opening.`);
      }
      const notOffered = new Error(`The ${divisionName(def.division)} page did not offer this report`
        + (stats.pageErrors.length ? ` — it hit an error: ${stats.pageErrors[0]}` : '.'));
      // Still loading when the wait ran out (no error on the page) may be a
      // slow morning, not a broken page: the run may try it again.
      if (isTimeUp(waitErr) && !stats.pageErrors.length) notOffered.timeout = true;
      throw notOffered;
    }
  } catch (err) {
    if (err && err.name === 'TimeoutError') err.timeout = true;
    await close();
    throw err;
  }

  // What the page was doing when it ran out of time, in a sentence or two.
  const stuckOn = async () => {
    const parts = [];
    const now = Date.now();
    const open = [...inflight].map(([req, at]) => {
      let where = req.url();
      try { const u = new URL(where); where = u.pathname + (u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search); } catch { /* as is */ }
      return { where: `${req.method()} ${where}`, secs: Math.round((now - at) / 1000) };
    }).sort((a, b) => b.secs - a.secs);
    if (open.length) {
      parts.push('Still waiting on ' + open.slice(0, 3).map(o => `${o.where} (${o.secs}s)`).join(', ')
        + (open.length > 3 ? ` and ${open.length - 3} more` : '') + '.');
    }
    let refused = stats.blockedWrites;
    try { refused += await withTimeout(page.evaluate(() => window.__dwRefusedWrites || 0), 2_000, 'Reading the page'); } catch { /* the network count, then */ }
    if (refused) parts.push(`The page tried to save ${refused} time${refused === 1 ? '' : 's'} (refused: scheduled runs are read-only).`);
    if (!open.length && warnings.length) parts.push('Its last warning: ' + warnings[warnings.length - 1]);
    return parts.join(' ');
  };
  // runOutOfTime on the error: the RUN's time was short, not the report slow
  // — a build given less than BUILD_MS because the run's deadline was near.
  // That report has not failed; the next pass should build it again.
  const ask = async (fn, s, what) => {
    const ms = budget(deadline, BUILD_MS, SEND_NEEDS_MS);
    if (ms < 10_000) throw Object.assign(timeUp('The run ran out of time.'), { runOutOfTime: true });
    try {
      return await withTimeout(page.evaluate(fn, s), ms, what, stuckOn);
    } catch (err) {
      if (isTimeUp(err) && ms < BUILD_MS) err.runOutOfTime = true;
      throw err;
    }
  };
  // The app request the page has waited on longest, for the progress notes.
  const waitingOn = () => {
    let longest = null;
    for (const [req, at] of inflight) if (!longest || at < longest.at) longest = { req, at };
    if (!longest) return '';
    let where = longest.req.url();
    try { where = new URL(where).pathname; } catch { /* as is */ }
    const more = inflight.size > 1 ? ` and ${inflight.size - 1} more` : '';
    return `waiting on ${longest.req.method()} ${where} (${Math.round((Date.now() - longest.at) / 1000)}s)${more}`;
  };
  return {
    stats,
    waitingOn,
    plan:  s => ask(x => window.dwAutoReport.plan(x), s, 'Opening the report'),
    build: s => ask(x => window.dwAutoReport.build(x), s, 'Building the report'),
    close,
  };
}

/**
 * Open the page and build everything the spec asks for, one report at a time,
 * without sending any of it. What the suite drives; runSchedule interleaves
 * the same steps with the sends.
 * Resolves to { items, skipped, errors, blockedWrites, pageErrors } or throws.
 */
async function buildInBrowser(browser, { baseUrl, def, acct, spec, deadline }) {
  const session = await openReportPage(browser, { baseUrl, def, acct, spec, deadline });
  const out = { items: [], skipped: [], errors: [] };
  try {
    for (const one of await specsToBuild(session, spec, out)) {
      try {
        const r = await session.build(one);
        out.items.push(...r.items); out.skipped.push(...r.skipped); out.errors.push(...r.errors);
      } catch (err) {
        out.errors.push({ projectId: one.projectId, projectName: one.projectName, error: err.message });
      }
    }
  } finally {
    await session.close();
  }
  return { ...out, ...session.stats };
}

/**
 * The builds a spec takes: itself, or — for "every In Progress job" — one per
 * job, each with its own time limit, so a slow job costs that job and not the
 * whole run's worth already built.
 */
async function specsToBuild(session, spec, out) {
  const plan = await session.plan(spec);
  if (!plan || !Array.isArray(plan.jobs)) return [spec];
  if (!plan.jobs.length) out.skipped.push({ why: 'No jobs are marked In Progress.' });
  return withBatch(plan.jobs.map(j => ({ ...spec, projectId: j.id, projectName: j.name || null })));
}

// Each job's spec names every job the run will build (`batch`), so a page
// can start a slow per-job read for all of them at once (dwAutoReport.prefetch).
function withBatch(specs) {
  const batch = specs.map(sp => String(sp.projectId));
  return specs.map(sp => ({ ...sp, batch }));
}

// Memory in use, MB: this process and the Chrome it drives. Serverless Chrome
// is one process (single-process mode), so its pid is all of it.
function memoryInUse(browser) {
  let mb = process.memoryUsage().rss / 1048576;
  try {
    const proc = browser && typeof browser.process === 'function' ? browser.process() : null;
    if (proc && proc.pid) {
      const st = require('fs').readFileSync(`/proc/${proc.pid}/status`, 'utf8');
      const m = /VmRSS:\s+(\d+)\s+kB/.exec(st);
      if (m) mb += Number(m[1]) / 1024;
    }
  } catch { /* no /proc here: this process alone */ }
  return Math.round(mb);
}

// A promise rejected with nobody to catch it ends the whole function on
// Vercel, and the run with it — no result written, the row left "Interrupted".
// While a run is on, one is logged and noted on its row instead, so it says
// what happened rather than dying silently.
const runsUnderWay = new Set();
let watchingRejections = false;
function watchRejections() {
  if (watchingRejections) return;
  watchingRejections = true;
  process.on('unhandledRejection', err => {
    console.error('[report-schedules] unhandled rejection during a scheduled report:', (err && err.stack) || err);
    const msg = String((err && err.message) || err).slice(0, 200);
    for (const note of runsUnderWay) { try { note(msg); } catch { /* best effort */ } }
  });
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

/**
 * Run one schedule now.
 *
 *   runSchedule(sql, sched, {
 *     now, baseUrl,
 *     occurrence?,   // the time it was due — what its dates are worked from
 *     browser?,      // a running Chrome to share; otherwise one is launched
 *     deadline?,     // epoch ms: start nothing that cannot finish before it
 *     stillWanted?,  // async () => reason | null — asked before each send
 *   })
 *
 * Builds and sends one report at a time, so whatever is sent before a timeout
 * or a failure stays sent and is counted.
 *
 * Resolves to { status, sent, total, recipientCount, message } — status one of
 * sent | partial | skipped | failed. Never throws.
 */
async function runSchedule(sql, sched, ctx = {}) {
  const now = ctx.now || new Date();
  const result = { status: 'failed', sent: 0, total: 0, recipientCount: 0, message: '' };
  const fail = msg => Object.assign(result, { status: 'failed', message: msg });

  const def = SCHEDULABLE[sched.report_type];
  if (!def) return fail('This report can no longer be scheduled.');

  let acct;
  try { acct = await loadRunAs(sql, sched); }
  catch (err) { return fail(`Could not read the account it runs as: ${err.message}`); }
  if (!acct) {
    return fail(`It runs as ${sched.run_as_username || 'a deleted account'}, which no longer exists. Open it and save it to run it as you.`);
  }
  if (!mayUseDivision(acct, def.division)) {
    return fail(def.division === 'payroll'
      ? `${acct.username} is no longer a payroll approver. Open it and save it as someone who is.`
      : def.division === 'safety'
        ? `${acct.username} is no longer a Safety Center supervisor. Open it and save it as someone who is.`
        : `${acct.username} no longer has access to ${divisionName(def.division)}. Open it and save it as someone who does.`);
  }

  // What the email shell is headed with (the report inside carries its own).
  const mailName = await mailCompanyName(sql, sched.company_code, acct.companyName);

  // A saved custom report: read again, now, and checked against the account
  // it runs as, before anything is built.
  let custom = null;
  if (def.customReport) {
    let loaded;
    try { loaded = await loadCustomReport(sql, sched, acct, def); }
    catch (err) { return fail(`Could not read the saved report: ${err.message}`); }
    if (loaded.error) return fail(loaded.error);
    custom = loaded.report;
    result.reportName = custom.name;
  }

  let recips;
  try { recips = await recipientsFor(sql, sched.company_code, sched.group_ids); }
  catch (err) { return fail(`Could not read its recipient groups: ${err.message}`); }
  // A custom report's schedule may also carry addresses of its own, and send
  // to each job's saved contacts — those are worked out job by job below.
  if (custom) recips = addRecipients(recips, sched.emails, 'the schedule\'s own addresses', 'schedule');
  const useContacts = Boolean(custom && sched.use_job_contacts);
  let leftOff = leftOffText(recips.invalid);
  if (!recips.emails.length && !useContacts) {
    return fail(recips.invalid.length ? `Nobody to send to. ${leftOff}`
      : recips.missing
        ? 'Its recipient group was deleted. Pick another group.'
        : custom && !(Array.isArray(sched.group_ids) && sched.group_ids.length)
          ? 'It has nobody to send to. Add a recipient group, an email address or the jobs\' saved contacts.'
          : 'Its recipient groups have no addresses on them.');
  }
  result.recipientCount = recips.emails.length;
  // Everybody a custom report actually went to, over every job's email.
  const sentTo = new Set();
  const contactsLeftOff = [];
  const clientCache = new Map();
  const runKind = ctx.kind === 'manual' ? 'send_now' : 'schedule';

  const spec = specFor(sched, def, ctx.occurrence || now);
  if (custom) spec.customReport = { id: custom.id, name: custom.name, version: custom.version, definition: custom.definition };
  const tz = spec.timezone;
  const generatedAt = now.toLocaleString('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const problems = [];   // what kept something from going out
  const notes    = [];   // what went out, but not quite as asked
  const skipped  = [];
  let stopped    = null;  // the schedule was switched off or changed mid-run
  let halted     = false; // the run stopped early, for whatever reason
  let attempted  = 0;
  // Jobs this pass never got to, and why: the run's time ran out, more were
  // due than one run sends (MAX_ITEMS), or the schedule stopped it.
  let outOfTime = 0, overCap = 0, stoppedLeft = 0;
  let timedOut   = false; // the page or the report ran out of time before anything went
  // What earlier passes at this same occurrence did (handBack): the jobs they
  // sent are not sent again, and the outcome below is the occurrence's whole.
  const occurrence = new Date(ctx.occurrence || now);
  const prev = resumeState(ctx.resume, occurrence);
  const done = new Set(prev.done);
  const everyJob = spec.projectId === '*';
  let planned = null;       // every-job runs: how many jobs the occurrence has
  // Failures about time that the next pass may well undo — a page that was
  // slow to open, a report whose build ran out of time. Reported if this is
  // the last pass; not carried to the next, so a report that goes out on the
  // second try is not "partly sent" because of the first.
  const retryProblems = [];
  let retryAttempts = 0;

  let browser = ctx.browser || null;
  const ownBrowser = !browser;
  let session = null;
  const open = () => openReportPage(browser, { baseUrl: ctx.baseUrl, def, acct, spec, deadline: ctx.deadline });
  // Where the run has got to, for the row while it runs — and, if the run is
  // cut off, for the row afterwards: which step, how much was sent, and how
  // much memory the function was using.
  let lastStep = '';
  const progress = step => {
    lastStep = step;
    if (!ctx.progress) return;
    try {
      ctx.progress(`${step}; ${plural(prev.sent + result.sent, 'report')} sent so far; ${memoryInUse(browser)} MB in use`);
    } catch { /* never worth failing over */ }
  };
  // Every five seconds while the page works on a step: how long, the memory,
  // and what it is waiting for — so a run killed partway leaves its trend.
  const during = async (step, fn) => {
    progress(step);
    const t0 = Date.now();
    const beat = setInterval(() => {
      if (!ctx.progress) return;
      const waiting = session && typeof session.waitingOn === 'function' ? session.waitingOn() : '';
      try {
        ctx.progress(`${step}, ${Math.round((Date.now() - t0) / 1000)}s in${waiting ? ', ' + waiting : ''}; `
          + `${plural(prev.sent + result.sent, 'report')} sent so far; ${memoryInUse(browser)} MB in use`);
      } catch { /* never worth failing over */ }
    }, HEARTBEAT_MS);
    try { return await fn(); } finally { clearInterval(beat); }
  };
  const noteRejection = msg => {
    if (ctx.progress) { try { ctx.progress(`${lastStep || 'Running'}; it hit an error nothing caught: ${msg}`); } catch { /* best effort */ } }
  };
  watchRejections();
  runsUnderWay.add(noteRejection);
  try {
    await (async () => {
      if (!browser) {
        progress('Starting the report browser');
        try { browser = await launchBrowser(); }
        catch (err) { problems.push(`Could not start the report browser: ${err.message}`); return; }
      }
      progress(`Opening the ${divisionName(def.division)} page`);
      try { session = await open(); }
      catch (err) {
        timedOut = isTimeUp(err);
        (timedOut ? retryProblems : problems).push(err.message || 'The report page would not open.');
        return;
      }

      const holder = { items: [], skipped: [], errors: [] };
      let specs;
      try {
        specs = await during(everyJob ? 'Waiting for the page to load and listing the In Progress jobs' : 'Waiting for the page to load',
          () => specsToBuild(session, spec, holder));
      }
      catch (err) {
        timedOut = isTimeUp(err);
        (timedOut ? retryProblems : problems).push(err.message || 'The report could not be built.');
        return;
      }
      skipped.push(...holder.skipped.map(s => s.why));
      if (everyJob) planned = specs.length;
      if (everyJob) specs = specs.filter(sp => !done.has(String(sp.projectId)));
      if (specs.length > MAX_ITEMS) {
        overCap = specs.length - MAX_ITEMS;
        specs = specs.slice(0, MAX_ITEMS);
      }
      if (everyJob) specs = withBatch(specs);

      let firstSend = true;
      for (let s = 0; s < specs.length && !halted; s++) {
        const one = specs[s];
        if (ctx.deadline && budget(ctx.deadline, Infinity, SEND_NEEDS_MS) < 10_000) {
          outOfTime += specs.length - s;
          halted = true;
          break;
        }
        // A build that timed out is still running in its page, and its
        // report would land in the next job's capture. The next job gets a
        // page of its own.
        if (!session) {
          try { session = await open(); }
          catch (err) {
            outOfTime += specs.length - s;
            (isTimeUp(err) ? retryProblems : problems).push(err.message || 'The report page would not open.');
            halted = true;
            break;
          }
        }
        const label = one.projectName || (custom ? custom.name : def.label);
        let built;
        try {
          built = await during(specs.length > 1 ? `Building ${label} (${s + 1} of ${specs.length})` : `Building ${label}`,
            () => session.build(one));
        }
        catch (err) {
          const msg = `${label}: ${err.message}`;
          if (isTimeUp(err)) {
            await session.close();
            session = null;
          }
          // Cut short by the run's own time, not slow in itself: this job and
          // the rest go back to the next pass, the job not counted as tried.
          if (everyJob && isTimeUp(err) && err.runOutOfTime) {
            outOfTime += specs.length - s;
            halted = true;
            break;
          }
          attempted++;
          if (!everyJob && isTimeUp(err)) {
            timedOut = true;
            retryAttempts++;
            retryProblems.push(msg);
          } else {
            problems.push(msg);
          }
          // A job whose own build failed is done with for this occurrence —
          // tried, and reported — not built again by every later pass.
          if (everyJob) done.add(String(one.projectId));
          continue;
        }
        built.skipped.forEach(k => skipped.push(k.projectName ? `${k.projectName}: ${k.why}` : k.why));
        built.errors.forEach(e => { attempted++; problems.push(`${e.projectName || 'Report'}: ${e.error}`); });

        let finished = true;
        for (const it of built.items) {
          const rec = custom ? customRecordOf(it, custom, spec) : null;
          const name = custom ? customItemName(rec, custom) : (it.projectName || def.label);
          if (ctx.deadline && budget(ctx.deadline, Infinity) < SEND_NEEDS_MS) {
            finished = false;
            halted = true;
            break;
          }
          if (ctx.stillWanted) {
            let why = null;
            try { why = await ctx.stillWanted(); } catch { why = null; }
            if (why) { stopped = why; finished = false; halted = true; break; }
          }
          // A custom report is for the jobs it was asked for — the one job of
          // a one-email-per-job schedule, the saved report's own jobs — and
          // never sent, to those jobs' contacts or anyone, as something else.
          if (custom) {
            const strayJobs = strayJobsOf(rec, spec.jobsMode, one, custom);
            if (strayJobs) {
              attempted++;
              problems.push(`${name}: the page built it for ${strayJobs}, not the job${spec.jobsMode === 'saved' ? 's' : ''} it was asked for — not sent.`);
              continue;
            }
          }
          // Who this one goes to: the schedule's own list, and for a custom
          // report that sends to the jobs' saved contacts, this item's jobs'.
          let to = recips.emails;
          if (custom && useContacts) {
            let found;
            try { found = await jobContactsFor(sql, sched, def.division, rec, clientCache); }
            catch (err) {
              attempted++;
              problems.push(`${name}: its saved contacts could not be read (${err.message}).`);
              continue;
            }
            if (found.mixed) {
              // Several customers' jobs in one report: not to their contacts.
              const why = `${name}: not sent to the jobs' saved contacts — it covers more than one customer's jobs, `
                + 'and each would see the others\'. Send one email per job to use them.';
              if (!to.length) { attempted++; problems.push(why); continue; }
              // It still goes to the rest; the row asks to be looked at.
              problems.push(why);
            }
            const merged = addRecipients({ emails: to, invalid: [] }, found.contacts, `contact on ${name}`, 'contact');
            to = merged.emails;
            contactsLeftOff.push(...merged.invalid);
            if (!to.length) { skipped.push(`No saved contacts for ${name}`); continue; }
          }
          attempted++;
          // Customer-safe or not at all: whatever the page did, a report that
          // carries the engine's internal mark does not go out on a timetable.
          if (custom && (CR.INTERNAL_MARK.test(String(it.html || ''))
            || (CR.isPlainObject(it.customReport) && it.customReport.included_internal === true))) {
            problems.push(`${name}: it carries internal data, and scheduled sends are customer-safe only — not sent.`);
            continue;
          }
          if (Buffer.byteLength(it.html, 'utf8') > MAX_HTML_BYTES) {
            problems.push(`${name}: the report is too large to email.`);
            continue;
          }
          const att = normalizeAttachments(it.attachments);
          if (!att.ok) { problems.push(`${name}: ${att.error}`); continue; }

          // The schedule's subject, with the job named on each of a one-
          // email-per-job schedule's emails so they can be told apart.
          const jobName = custom ? (spec.jobsMode === 'each' && rec.project_ids.length === 1 ? rec.project_names[0] : null) : it.projectName;
          const subj = sched.subject && sched.subject.trim()
            ? (jobName && !sched.subject.includes(jobName) ? `${sched.subject.trim()} — ${jobName}` : sched.subject.trim())
            : it.subject;

          if (!firstSend) await sleep(SEND_GAP_MS);
          firstSend = false;
          progress(specs.length > 1 ? `Making the PDF and sending ${name} (${s + 1} of ${specs.length})` : `Making the PDF and sending ${name}`);
          const sent = await deliverReport({
            label:       def.label,
            projectName: it.projectName,
            recipients:  to,
            subject:     subj,
            note:        sched.note || '',
            html:        it.html,
            attachments: att.attachments,
            summary:     it.summary,
            attachPdf:   sched.attach_pdf !== false,
            companyName: mailName,
            generatedAt,
            browser,
            logTag:      `schedule=${sched.id} report=${sched.report_type}`,
          });
          if (sent.ok) {
            result.sent++;
            // It went — the PDF just could not be made, so the report is in the body.
            if (sent.warning) notes.push(`${name}: ${sent.warning}`);
            if (custom) {
              to.forEach(e => sentTo.add(e));
              const logged = await logCustomSend(sql, {
                sched, def, acct, custom, rec, recipients: to, subject: sent.subject || subj, html: it.html, runKind,
              });
              if (logged.logged) result.logged = (result.logged || 0) + 1;
              if (logged.archived) result.archived = (result.archived || 0) + 1;
            }
          } else {
            problems.push(`${name}: ${sent.error}`);
          }
        }
        // A job is done once every report it made has been tried; one the
        // run stopped partway through is left for the next pass, whole.
        if (finished) { if (everyJob) done.add(String(one.projectId)); }
        else if (stopped) stoppedLeft += specs.length - s;
        else outOfTime += specs.length - s;
      }
    })();
    if (session && session.stats.blockedWrites) {
      console.log('[report-schedules] refused', session.stats.blockedWrites, 'page write(s) while building schedule', sched.id);
    }
  } catch (err) {
    problems.push(err.message || 'The run failed.');
  } finally {
    runsUnderWay.delete(noteRejection);
    if (session) await session.close();
    if (ownBrowser && browser) { try { await browser.close(); } catch { /* already gone */ } }
  }

  result.total = attempted;
  // A custom report sent to its jobs' contacts went to a different list for
  // each job: the count is everybody it reached, and a saved contact the mail
  // service would refuse is named with the rest left off.
  if (custom && sentTo.size) result.recipientCount = sentTo.size;
  // The send history's housekeeping, as the Email button's sends do it.
  if (custom && result.logged) {
    try {
      await CR.pruneSnapshots(sql, sched.company_code, def.division);
      if (result.archived) await CR.pruneArchives(sql, sched.company_code);
    } catch (err) { console.error('[report-schedules] custom report history prune failed:', err.message); }
  }
  if (contactsLeftOff.length) {
    const seenBad = new Set();
    leftOff = leftOffText([...recips.invalid, ...contactsLeftOff.filter(x => !seenBad.has(x.email) && seenBad.add(x.email))]);
  }
  const unreached    = outOfTime + overCap + stoppedLeft;
  const allSent      = prev.sent + result.sent;
  const allAttempted = prev.attempted + attempted;
  const allProblems  = [...prev.problems, ...problems, ...retryProblems];
  const to = plural(result.recipientCount, 'recipient');
  // An every-job occurrence's jobs, all passes: the most any pass's plan saw.
  // Those not yet tried are what is left, whatever this pass managed to see.
  const total = everyJob ? Math.max(planned == null ? 0 : planned, prev.total) : 0;
  const left  = everyJob && total ? Math.max(0, total - done.size) : unreached;
  // Lasting progress only: a report sent, or a job dealt with for good. A
  // single report that timed out and will be built again is neither.
  const madeProgress = result.sent > 0 || done.size > prev.done.length;

  // Unfinished — out of time, stopped, or more jobs than one pass sends: the
  // rest goes back to the next five-minute pass, if the schedule still wants
  // it (see handBack). Only a timetabled run hands anything back.
  let handedBack = false;
  if ((unreached > 0 || (timedOut && !result.sent)) && ctx.handBack) {
    try {
      handedBack = await ctx.handBack({
        state: {
          occurrence: occurrence.toISOString(),
          done:       [...done],
          sent:       allSent,
          attempted:  allAttempted - retryAttempts,
          problems:   [...prev.problems, ...problems].slice(-10).map(p => String(p).slice(0, 300)),
          passes:     prev.passes + 1,
          idle:       prev.idle + (madeProgress ? 0 : 1),
          total,
        },
      });
    } catch (err) {
      console.error('[report-schedules] could not hand back schedule', sched.id, err.message);
      handedBack = false;
    }
  }
  if (handedBack) {
    result.status = 'continuing';
    const soFar = allSent ? `Sent ${plural(allSent, 'report')} to ${to} so far. ` : '';
    const why = stopped
      ? 'It was changed while it was being sent, so the rest goes out at the next pass, with the new settings.'
      : left
        ? `${plural(left, 'more job')} ${left === 1 ? 'goes' : 'go'} out at the next pass, in a few minutes.`
        : 'It will be tried again at the next pass, in a few minutes.';
    result.message = `${soFar}${why}${problems.length ? ' ' + problems.join('; ') : ''}${leftOff ? ' ' + leftOff : ''}`;
    return result;
  }

  // The last pass at this occurrence: whatever is still not sent is said so.
  // (A stop says why itself.)
  const unsent = stopped ? 0 : left;
  if (unsent) {
    const reason = overCap && !outOfTime ? `one run sends at most ${MAX_ITEMS}`
      : outOfTime ? `the run ran out of time before it got to ${unsent === 1 ? 'it' : 'them'}`
      : 'the run stopped before it got to them';
    allProblems.push(`${plural(unsent, 'more job')} not sent — ${reason}.`);
  }
  const passes = prev.passes ? ` (over ${prev.passes + 1} runs)` : '';
  const tail = [...allProblems, ...(stopped ? [stopped] : []), ...notes];
  if (allSent && !allProblems.length && !stopped) {
    // Everything went — but to somebody short when an address was left off,
    // so the row still asks to be looked at. Who was left off comes straight
    // after the lead, where the row's two lines and the stored 2000
    // characters cannot lose it behind a long list of skipped jobs.
    result.status = leftOff ? 'partial' : 'sent';
    result.message = (allSent === 1 ? `Sent to ${to}.` : `Sent ${allSent} reports to ${to}${passes}.`)
      + (leftOff ? ` ${leftOff}` : '')
      + (notes.length ? ` ${notes.join('; ')}` : '')
      + (skipped.length ? ` Skipped — ${skipped.join('; ')}` : '');
  } else if (allSent) {
    result.status = 'partial';
    result.message = `Sent ${allSent} of ${allAttempted + unsent} to ${to}${passes}.${leftOff ? ' ' + leftOff : ''} ${tail.join('; ')}`;
  } else if (!allProblems.length && (skipped.length || stopped)) {
    result.status = 'skipped';
    result.message = (stopped && !skipped.length ? stopped : `Nothing to send — ${[...skipped, ...(stopped ? [stopped] : [])].join('; ')}`)
      + (leftOff ? ` ${leftOff}` : '');
  } else {
    result.status = 'failed';
    result.message = (tail.length ? tail.join('; ') : 'The page built no report.') + (leftOff ? ` ${leftOff}` : '');
  }
  return result;
}

// What an earlier pass at this occurrence left for the next (handBack) —
// this occurrence's only. A pass killed before it could write itself down
// leaves its state on the row, and tomorrow's run must not skip the jobs
// that went out today.
function resumeState(raw, occurrence) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const at = r.occurrence ? new Date(r.occurrence).getTime() : NaN;
  const mine = Number.isFinite(at) && occurrence && at === new Date(occurrence).getTime();
  if (!mine) return { done: [], sent: 0, attempted: 0, problems: [], passes: 0, idle: 0, total: 0 };
  return {
    done:      Array.isArray(r.done) ? r.done.map(String) : [],
    sent:      Number(r.sent) || 0,
    attempted: Number(r.attempted) || 0,
    problems:  Array.isArray(r.problems) ? r.problems.map(String) : [],
    passes:    Number(r.passes) || 0,
    idle:      Number(r.idle) || 0,
    total:     Number(r.total) || 0,
  };
}

// ── Claims ──────────────────────────────────────────────────────────────────
// A schedule is being sent while it holds a claim: claimed_at, and a token
// saying whose. Two runs never hold one at once, so a report never goes out
// twice at the same time; a claim older than STALE_CLAIM belongs to a run that
// died, and is free to take.

const occurrenceOf = s => ({
  frequency: s.frequency, days_of_week: s.days_of_week, day_of_month: s.day_of_month,
  send_time: s.send_time, timezone: s.timezone,
});

/**
 * Claim the most overdue schedule that is due and not being sent — or null.
 * `except` is the schedules this run has already had a go at: one it handed
 * back is due again at once, and is the next run's to take, not this one's.
 */
async function claimNextDue(sql, token, except = []) {
  const skip = except.map(Number).filter(Number.isFinite);
  const rows = await sql`
    UPDATE report_schedules SET claimed_at = NOW(), claim_token = ${token}
     WHERE id = (
       SELECT id FROM report_schedules
        WHERE enabled
          AND next_run_at IS NOT NULL
          AND next_run_at <= NOW()
          AND (claimed_at IS NULL OR claimed_at < NOW() - ${STALE_CLAIM}::interval)
          AND NOT (id = ANY(${skip}::bigint[]))
        ORDER BY next_run_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
     RETURNING *, extract(epoch FROM updated_at)::text AS updated_epoch`;
  return rows[0] || null;
}

/** Claim one schedule for Send now — or null if a run already has it. */
async function claimForSendNow(sql, id, companyCode, token) {
  const rows = await sql`
    UPDATE report_schedules SET claimed_at = NOW(), claim_token = ${token}
     WHERE id = ${id} AND company_code = ${companyCode}
       AND (claimed_at IS NULL OR claimed_at < NOW() - ${STALE_CLAIM}::interval)
     RETURNING *`;
  return rows[0] || null;
}

/**
 * Start a claimed run: say on the row that it is sending, and — for a
 * timetabled run — move the timetable on to the next occurrence NOW, before
 * anything goes out.
 *
 * Moving it first makes a send at most once. Moved after, as it first was, a
 * run killed partway (the function's time limit, the database blinking under
 * the closing write) left the occurrence still due, and fifteen minutes later
 * the next run sent every email again. Now a cut-off run is simply cut off:
 * it says so ('Interrupted') and the next send is the next occurrence. And
 * nothing after the run touches the timetable, so an edit saved while it ran
 * is the timetable that stands.
 */
//
// Resolves false when a timetabled schedule was saved between its claim and
// here: the timetable worked out from the claimed copy is no longer the one
// that stands, so nothing is written over it and the run does not start. The
// caller lets the claim go; the next pass takes the schedule as it now is.
async function beginRun(sql, sched, token, { kind, now }) {
  const at = (now || new Date()).toISOString();
  if (kind === 'schedule') {
    const next = T.nextRunAt(occurrenceOf(sched), now || new Date());
    // updated_epoch is the claim's own reading of updated_at, to the
    // microsecond — a JavaScript Date keeps milliseconds, and would never match.
    const rows = await sql`
      UPDATE report_schedules
         SET next_run_at = ${next ? next.toISOString() : null},
             last_status = 'sending', last_run_at = ${at}, last_message = 'Building and sending.'
       WHERE id = ${sched.id} AND claim_token = ${token}
         AND (${sched.updated_epoch == null ? null : String(sched.updated_epoch)}::text IS NULL
              OR extract(epoch FROM updated_at)::text = ${sched.updated_epoch == null ? null : String(sched.updated_epoch)}::text)
       RETURNING id`;
    return rows.length > 0;
  }
  const rows = await sql`
    UPDATE report_schedules
       SET last_status = 'sending', last_run_at = ${at}, last_message = 'Building and sending.'
     WHERE id = ${sched.id} AND claim_token = ${token}
     RETURNING id`;
  return rows.length > 0;
}

// A pass that hands back takes another five minutes, and a page that never
// opens costs a minute and a half of Chrome each time: an occurrence gets at
// most this many passes all told, and only this many hand-backs from passes
// that got nothing done.
const MAX_PASSES      = 8;
const MAX_IDLE_PASSES = 2;

/**
 * Give the rest of a timetabled occurrence back to the next five-minute pass:
 * the run ran out of time (or past MAX_ITEMS) with jobs still to send, timed
 * out before sending anything, or was stopped because the schedule was saved
 * mid-run. next_run_at goes back to the occurrence — due again, and its dates
 * still that occurrence's — and resume_state carries what was already sent,
 * so the next pass sends only the rest and reports on the whole.
 *
 * Only while the schedule still wants it: switched on, and on the timetable
 * it was claimed on. Switched off or deleted, nothing more goes; retimed, the
 * new timetable stands. A different report since: the next pass starts the
 * occurrence over rather than skip jobs it never sent. Resolves true if
 * handed back.
 */
async function handBack(sql, sched, token, { occurrence, state }) {
  // Counted in the state, which belongs to this occurrence: passes so far
  // (this one included), and how many of them got nothing done.
  const st = state || {};
  const passes = Number(st.passes) || 1;
  if (passes >= MAX_PASSES) return false;
  if ((Number(st.idle) || 0) > MAX_IDLE_PASSES) return false;
  const occ = new Date(occurrence);
  if (!Number.isFinite(occ.getTime())) return false;
  const days = Array.isArray(sched.days_of_week) ? JSON.stringify(sched.days_of_week) : null;
  const dom  = sched.day_of_month == null ? null : Number(sched.day_of_month);
  // The same report: the same type and, for a saved custom report, the same
  // saved report covering the same jobs — two custom reports share a type.
  const crId = sched.custom_report_id == null ? null : String(sched.custom_report_id);
  const crOpt = String(optionsOf(sched).report_id == null ? '' : optionsOf(sched).report_id);
  const mode = sched.jobs_mode == null ? null : String(sched.jobs_mode);
  const rows = await sql`
    UPDATE report_schedules
       SET next_run_at  = ${occ.toISOString()},
           resume_state = CASE WHEN report_type = ${sched.report_type}
                                AND custom_report_id IS NOT DISTINCT FROM ${crId}::bigint
                                AND COALESCE(options->>'report_id', '') = ${crOpt}
                                AND jobs_mode IS NOT DISTINCT FROM ${mode}::text
                               THEN ${JSON.stringify(state || {})}::jsonb ELSE NULL END,
           resume_count = ${passes}
     WHERE id = ${sched.id} AND claim_token = ${token} AND enabled
       AND frequency = ${sched.frequency} AND send_time = ${sched.send_time} AND timezone = ${sched.timezone}
       AND day_of_month IS NOT DISTINCT FROM ${dom}::integer
       AND days_of_week IS NOT DISTINCT FROM ${days}::jsonb
     RETURNING id`;
  return rows.length > 0;
}

/**
 * Before each send of a timetabled run: is this still the schedule that was
 * claimed? Switched off, deleted or edited while it was being built, it is
 * not sent — "switch it off" must mean nothing more goes out, even to the
 * group it was going to.
 */
async function stillWanted(sql, sched) {
  const rows = await sql`SELECT enabled, updated_at FROM report_schedules WHERE id = ${sched.id}`;
  const r = rows[0];
  if (!r) return 'It was deleted while it was being built, so nothing more was sent.';
  if (!r.enabled) return 'It was switched off while it was being built, so nothing more was sent.';
  if (new Date(r.updated_at).getTime() !== new Date(sched.updated_at).getTime()) {
    return 'It was changed while it was being built, so nothing more was sent; the next run uses the new settings.';
  }
  return null;
}

/**
 * Write a run down: the schedule's last outcome, the history row, and the
 * claim let go of. The timetable is left alone — beginRun has already moved
 * it, and a Send now never moves it: testing Thursday's report on Tuesday
 * must not cancel Wednesday's.
 */
async function recordRun(sql, sched, result, { kind, token, triggeredBy, startedAt, now }) {
  const at = now || new Date();
  const msg = String(result.message || '').slice(0, 2000);
  // A timetabled occurrence that is finished — sent, failed, missed — drops
  // what its passes carried; one handed back ('continuing') keeps it for the
  // next. A Send now never touches it.
  const finished = kind === 'schedule' && result.status !== 'continuing';
  await sql`
    UPDATE report_schedules
       SET last_run_at = ${at.toISOString()}, last_status = ${result.status}, last_message = ${msg},
           claimed_at  = CASE WHEN claim_token = ${token || ''} THEN NULL ELSE claimed_at END,
           claim_token = CASE WHEN claim_token = ${token || ''} THEN NULL ELSE claim_token END,
           resume_state = CASE WHEN ${finished} THEN NULL ELSE resume_state END,
           resume_count = CASE WHEN ${finished} THEN 0 ELSE resume_count END
     WHERE id = ${sched.id}`;
  // What was sent, as it was sent — an edit afterwards must not relabel it.
  // A saved custom report's name goes with it (two custom reports share a
  // type): the name the run read, else the one the schedule was saved with.
  const reportName = reportNameOf(sched, result);
  await sql`
    INSERT INTO report_schedule_runs
      (schedule_id, company_code, run_kind, status, sent_count, total_count, recipient_count,
       message, triggered_by, started_at, finished_at, report_type, division, project_id, project_name, report_name)
    VALUES
      (${sched.id}, ${sched.company_code}, ${kind}, ${result.status}, ${result.sent || 0}, ${result.total || 0},
       ${result.recipientCount || 0}, ${msg}, ${triggeredBy || null},
       ${(startedAt || at).toISOString()}, ${at.toISOString()},
       ${sched.report_type}, ${sched.division}, ${sched.project_id || null}, ${runLabel(sched, reportName)}, ${reportName})`;
}

/** A custom report run's report name — what the run read, else what the schedule was saved with — or null. */
function reportNameOf(sched, result) {
  if (!(SCHEDULABLE[sched.report_type] && SCHEDULABLE[sched.report_type].customReport)) return null;
  const n = String((result && result.reportName) || optionsOf(sched).report_name || '').trim();
  return n ? n.slice(0, 200) : null;
}

/**
 * Note a run's progress on its row as it goes (runSchedule's ctx.progress):
 * last_message while it says 'sending', so the tab can show where it has got
 * to, and an interrupted run says where it stopped. Written one at a time, in
 * order, never holding the run up; only while this run's claim is the row's
 * and it is still sending, so nothing lands on top of the run's own result.
 */
function progressWriter(sql, sched, token) {
  let chain = Promise.resolve();
  return text => {
    const msg = `${PROGRESS_PREFIX}${String(text).slice(0, 400)}`;
    console.log('[report-schedules] schedule', sched.id, String(text));
    chain = chain.then(() => sql`
      UPDATE report_schedules SET last_message = ${msg}
       WHERE id = ${sched.id} AND claim_token = ${token} AND last_status = 'sending'`).catch(() => {});
  };
}
const PROGRESS_PREFIX = 'Working: ';

// The job a run was for, as the history shows it: the job's name, the jobs
// ticked ("3 picked jobs"), or none for every In Progress job and whole-
// division reports. A saved custom report leads with its name — "Owner
// Update — 3 picked jobs" — since every one of them is a "Custom Report".
function runLabel(sched, reportName) {
  const picked = sched.project_id === '*' && Array.isArray(sched.picked_jobs) && sched.picked_jobs.length
    ? `${sched.picked_jobs.length} picked job${sched.picked_jobs.length === 1 ? '' : 's'}` : null;
  const def = SCHEDULABLE[sched.report_type];
  if (def && def.customReport) {
    const mode = jobsModeOf(sched);
    const jobs = picked || (mode === 'each' ? 'each In Progress job' : mode === 'all_in_progress' ? 'all In Progress jobs' : null);
    const name = reportName === undefined ? reportNameOf(sched, null) : reportName;
    return [name, jobs].filter(Boolean).join(' — ') || null;
  }
  if (picked) return picked;
  return sched.project_name || null;
}

/**
 * The row's status as the tabs show it. "Sending" is a claim a live run
 * holds; one older than the stale limit belongs to a run that died, and the
 * row says so ('interrupted', and where it got to) rather than reading
 * "Sending…" until the next occurrence.
 */
function liveStatus(r) {
  const fresh = Boolean(r.claimed_at) && Date.now() - new Date(r.claimed_at).getTime() < STALE_CLAIM_MS;
  const cutOff = r.last_status === 'sending' && !fresh;
  if (!cutOff) return { status: r.last_status, message: r.last_message, sending: fresh };
  const tail = 'Some of its emails may have gone out; the rest did not.';
  const m = String(r.last_message || '');
  return {
    status: 'interrupted',
    message: m.startsWith(PROGRESS_PREFIX)
      ? `The run was cut off at: ${m.slice(PROGRESS_PREFIX.length)}. ${tail}`
      : `The run was cut off before it finished. ${tail}`,
    sending: false,
  };
}

/** Let go of a claim with nothing recorded — a run that never started. */
async function releaseClaim(sql, sched, token) {
  await sql`
    UPDATE report_schedules SET claimed_at = NULL, claim_token = NULL
     WHERE id = ${sched.id} AND claim_token = ${token}`;
}

module.exports = {
  runSchedule,
  recordRun,
  beginRun,
  handBack,
  progressWriter,
  PROGRESS_PREFIX,
  stillWanted,
  claimNextDue,
  claimForSendNow,
  releaseClaim,
  newClaimToken: () => randomUUID(),
  appBaseUrl,
  specFor,
  liveStatus,
  runLabel,
  loadCustomReport,
  customReportIdOf,
  jobsModeOf,
  clientsOfJobs,
  oneCustomer,
  STALE_CLAIM_MS,
  MAX_PASSES,
  MAX_IDLE_PASSES,
  // for the suite
  buildInBrowser,
  openReportPage,
  loadRunAs,
  recipientsFor,
  addRecipients,
  leftOffText,
  nextWorkday,
  MAX_ITEMS,
};
