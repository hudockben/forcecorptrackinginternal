'use strict';

// The Custom Reporting send history (custom_report_runs) and the cleaning of
// what the browser sends — shared by the two endpoints that write it:
//
//   api/custom-reports.js       POST ?action=run   a print or Excel download
//                                                  (and an email, as a fallback)
//   api/email/send-report.js    a custom report emailed — logged by the server
//                                                  itself once the email has gone
//
// The history answers "what did we send the owner on the 14th, and did it have
// our costs on it?", so an email is recorded where it is sent rather than by a
// second request from the browser that a dropped connection or a closed tab
// could lose. Prints and downloads never reach a server any other way, so for
// those the browser's word is all there is.

// The divisions whose pages carry Custom Reporting.
const DIVISIONS = ['turf', 'paving', 'kiewit'];

const MAX_DEFINITION_BYTES = 64 * 1024;
// A definition is a few levels deep (sections → columns / labels / options).
// Anything far deeper is not one, and walking it is how a request gets to
// exhaust the stack.
const MAX_DEPTH            = 32;
const RUN_ACTIONS          = ['print', 'email', 'excel'];
const MAX_RUN_JOBS         = 500;
const MAX_RUN_RECIPIENTS   = 50;
const MAX_SUBJECT          = 300;
const MAX_REPORT_NAME      = 200;
// Runs one user may log in a minute. A person printing and downloading does
// a handful; a script filling the history (and the database) does thousands.
const RUN_RATE_LIMIT       = 30;
// Definition snapshots older than this are emptied — the row (who, when, to
// whom, which jobs, internal or not) stays; the recipe that made it goes.
const SNAPSHOT_KEEP_DAYS   = 730;

// ── Cleaning what the browser sends ──────────────────────────────────────
// Postgres refuses a NUL character in TEXT and JSONB, and half a surrogate
// pair in JSONB. Either can arrive in a pasted job name or a copied note, and
// would turn a save — or worse, the log of a send that already went — into a
// 500. They are dropped; nobody types them on purpose.
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const cleanStr = s => String(s).replace(BAD_CHARS, '');

// One line of text (names, subjects): control characters become spaces.
function oneLine(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return cleanStr(v).replace(/[\u0001-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

// A copy of plain JSON data with the characters above removed, as { value },
// or { tooDeep } when it nests deeper than any definition does.
function cleanJson(v, depth = 0) {
  if (depth > MAX_DEPTH) return { tooDeep: true };
  if (typeof v === 'string') return { value: cleanStr(v) };
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      const c = cleanJson(x, depth + 1);
      if (c.tooDeep) return c;
      out.push(c.value === undefined ? null : c.value);
    }
    return { value: out };
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      // A "__proto__" key from JSON.parse would become this copy's prototype
      // when assigned, lending it properties the stored JSON does not have.
      if (x === undefined || typeof x === 'function' || k === '__proto__') continue;
      const c = cleanJson(x, depth + 1);
      if (c.tooDeep) return c;
      out[cleanStr(k)] = c.value;
    }
    return { value: out };
  }
  if (typeof v === 'number') return { value: Number.isFinite(v) ? v : null };
  if (typeof v === 'boolean' || v === null) return { value: v };
  return { value: undefined };
}

const isPlainObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * A report definition fit to store, as { value, json }, or { status, error }.
 * Saved reports must be v1 — the only shape the builder reads; the run log
 * keeps whatever snapshot it was given (requireV false).
 */
function readDefinition(raw, { requireV = true } = {}) {
  if (!isPlainObject(raw)) return { status: 400, error: 'definition must be an object' };
  let json;
  try { json = JSON.stringify(raw); } catch { return { status: 400, error: 'definition is not valid JSON' }; }
  if (Buffer.byteLength(json, 'utf8') > MAX_DEFINITION_BYTES) {
    return { status: 413, error: 'Report definition is too large' };
  }
  const c = cleanJson(raw);
  if (c.tooDeep) return { status: 400, error: 'definition is nested too deeply' };
  if (requireV && c.value.v !== 1) return { status: 400, error: 'Unsupported report definition version (expected v: 1)' };
  return { value: c.value, json: JSON.stringify(c.value) };
}

// A YYYY-MM-DD that is a real calendar day, or null. Postgres would refuse
// 2026-02-30 with a 500; this refuses it with a 400 that says why.
function readDate(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { error: 'Dates must be YYYY-MM-DD' };
  const d = new Date(raw + 'T00:00:00Z');
  const y = Number(raw.slice(0, 4));
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw || y < 1900 || y > 2999) {
    return { error: 'Dates must be YYYY-MM-DD' };
  }
  return { value: raw };
}

// A list of short strings, capped. Job ids and names stay aligned position
// for position — the history pairs them — so nothing is dropped from those.
function readList(raw, max, maxLen, what) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: `${what} must be a list` };
  if (raw.length > max) return { error: `Too many ${what} (max ${max})` };
  return { value: raw.map(x => oneLine(x, maxLen)) };
}

function readRecipients(raw) {
  const r = readList(raw, MAX_RUN_RECIPIENTS, 254, 'recipients');
  if (r.error) return r;
  return { value: [...new Set(r.value.map(e => e.toLowerCase()).filter(Boolean))] };
}

const toId = v => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// What the engine stamps on the masthead of a report that carries internal
// columns (custom-reports-engine.js, buildReportHtml).
const INTERNAL_MARK = /\bdata-cr-internal\s*=\s*["']?1\b/;

/**
 * One history row from a request body, as { value } or { status, error }.
 *
 * included_internal is the browser's flag, but never less than the snapshot
 * it sent along says: a definition with internal data switched on is logged
 * as internal even when the flag claims otherwise. That can over-flag a
 * report whose internal switch is on with no internal column chosen — the
 * right way round for a log asked "did it have our costs on it?".
 */
function readRun(b) {
  b = b || {};
  if (!RUN_ACTIONS.includes(b.action)) return { status: 400, error: 'action must be print, email or excel' };
  const ids = readList(b.project_ids, MAX_RUN_JOBS, 120, 'jobs');
  if (ids.error) return { status: 400, error: ids.error };
  const names = readList(b.project_names, MAX_RUN_JOBS, 200, 'job names');
  if (names.error) return { status: 400, error: names.error };
  const recipients = readRecipients(b.recipients);
  if (recipients.error) return { status: 400, error: recipients.error };
  const from = readDate(b.date_from);
  const to   = readDate(b.date_to);
  if (from.error || to.error) return { status: 400, error: from.error || to.error };
  let defJson = '{}', defInternal = false;
  if (b.definition !== undefined && b.definition !== null) {
    const d = readDefinition(b.definition, { requireV: false });
    if (d.error) return { status: d.status, error: d.error };
    defJson = d.json;
    defInternal = d.value.includeInternal === true;
  }
  return {
    value: {
      action:           b.action,
      // Junk is the same as none: the log must not fail a send over it.
      reportId:         toId(b.report_id),
      reportName:       oneLine(b.report_name, MAX_REPORT_NAME) || 'Untitled report',
      projectIds:       ids.value,
      projectNames:     names.value,
      dateFrom:         from.value,
      dateTo:           to.value,
      recipients:       recipients.value,
      subject:          oneLine(b.subject, MAX_SUBJECT) || null,
      includedInternal: b.included_internal === true || defInternal,
      defJson,
    },
  };
}

function shapeRun(r) {
  const asArray = v => (Array.isArray(v) ? v : []);
  return {
    id:                Number(r.id),
    report_id:         r.report_id == null ? null : Number(r.report_id),
    report_name:       r.report_name,
    action:            r.action,
    project_ids:       asArray(r.project_ids),
    project_names:     asArray(r.project_names),
    date_from:         r.date_from || null,
    date_to:           r.date_to || null,
    recipients:        asArray(r.recipients),
    subject:           r.subject,
    included_internal: Boolean(r.included_internal),
    run_by_user_id:    r.run_by_user_id == null ? null : Number(r.run_by_user_id),
    run_by_username:   r.run_by_username,
    created_at:        r.created_at,
  };
}

/** How many runs this user has logged in the company in the last minute. */
async function recentRunCount(sql, company, userId) {
  const rows = await sql`
    SELECT count(*)::int AS n FROM custom_report_runs
     WHERE company_code = ${company} AND run_by_user_id = ${userId}
       AND created_at > NOW() - interval '1 minute'`;
  return rows[0] ? Number(rows[0].n) : 0;
}

/**
 * Write one history row (from readRun) and bump its report's counters, in one
 * statement so the two cannot disagree. The UPDATE matches only a report the
 * caller can see; when it matches nothing the run is still logged, against
 * no report — failing the log would not un-send the email.
 */
async function insertRun(sql, { company, division, me, run }) {
  const rows = await sql`
    WITH bumped AS (
      UPDATE custom_reports
         SET last_run_at = NOW(), run_count = run_count + 1
       WHERE id = ${run.reportId}::bigint AND company_code = ${company} AND division = ${division}
         AND deleted_at IS NULL
         AND (visibility = 'shared' OR owner_user_id = ${me.userId})
      RETURNING id
    )
    INSERT INTO custom_report_runs
      (report_id, company_code, division, report_name, action, project_ids, project_names,
       date_from, date_to, recipients, subject, included_internal, definition,
       run_by_user_id, run_by_username)
    VALUES
      ((SELECT id FROM bumped), ${company}, ${division}, ${run.reportName}, ${run.action},
       ${JSON.stringify(run.projectIds)}::jsonb, ${JSON.stringify(run.projectNames)}::jsonb,
       ${run.dateFrom}::date, ${run.dateTo}::date, ${JSON.stringify(run.recipients)}::jsonb,
       ${run.subject}, ${run.includedInternal}, ${run.defJson}::jsonb,
       ${me.userId}, ${me.username})
    RETURNING id, report_id, report_name, action, project_ids, project_names,
              to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to,
              recipients, subject, included_internal, run_by_user_id, run_by_username, created_at`;
  return shapeRun(rows[0]);
}

/**
 * Housekeeping that rides along with logging rather than needing a cron:
 * definition snapshots past SNAPSHOT_KEEP_DAYS are emptied, a batch at a
 * time, for this company and division only. The partial index on snapshots
 * still held keeps the search to the rows that have one.
 */
async function pruneSnapshots(sql, company, division) {
  await sql`
    UPDATE custom_report_runs SET definition = '{}'::jsonb
     WHERE id IN (
       SELECT id FROM custom_report_runs
        WHERE company_code = ${company} AND division = ${division}
          AND definition <> '{}'::jsonb
          AND created_at < NOW() - make_interval(days => ${SNAPSHOT_KEEP_DAYS})
        ORDER BY created_at
        LIMIT 200)`;
}

module.exports = {
  DIVISIONS, MAX_DEFINITION_BYTES, RUN_ACTIONS, MAX_RUN_JOBS, MAX_RUN_RECIPIENTS, MAX_SUBJECT, MAX_REPORT_NAME,
  RUN_RATE_LIMIT, SNAPSHOT_KEEP_DAYS, INTERNAL_MARK,
  cleanStr, oneLine, cleanJson, isPlainObject, readDefinition, readDate, readList, readRecipients, toId,
  readRun, shapeRun, recentRunCount, insertRun, pruneSnapshots,
};
