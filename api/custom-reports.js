'use strict';

// /api/custom-reports — Analytics → Custom Reporting.
//
// A PM builds a report from his division's own data (custom-reports.js in the
// browser does all of that), names it, and saves it here so next week's
// customer update is one click instead of an afternoon. What is stored is only
// the recipe — the `definition` JSON: jobs, dates, sections, columns, header
// text. Every figure is worked out in the browser when the report is run, so
// nothing here can go stale or hold a number nobody can trace.
//
// Two kinds of saved report, by visibility:
//   private  the owner's own. Anyone who can open Analytics may save these.
//   shared   a division template everyone in the division can run. Only an
//            admin or level3 IN THAT DIVISION may create, change, delete or
//            restore one — a template the whole office sends to customers is
//            not something any login should be able to rewrite.
// Somebody else's private report is invisible, admins included: it is his
// working copy, not the division's.
//
// Sales cannot open Analytics on the pages, so the API refuses them too —
// otherwise a report carrying costs would be one hand-made request away.
//
// GET    ?division=…                     → { reports, canShare, me }
// GET    ?division=…&deleted=1           → reports deleted in the last 30 days the caller may restore
// GET    ?division=…&runs=1[&report_id=] → { runs }  the send history
// POST   ?division=…                     create   { name, description?, visibility?, definition }
// PUT    ?division=…&id=N                save     { name?, description?, visibility?, definition?, version }
// DELETE ?division=…&id=N                soft delete
// POST   ?division=…&action=restore&id=N un-delete
// POST   ?division=…&action=run          log a print / email / Excel download
//
// Saves are optimistically locked. The browser sends the version it opened and
// the UPDATE only matches that version, so two people saving the same shared
// template cannot silently overwrite each other: the second gets 409
// version_conflict with the copy that is there now, and chooses.
//
// kind ('report' when the definition saves its jobs, else 'template') and
// customer_safe (false once internal data is switched on) are derived here
// from the definition on every write, never taken from the browser — they are
// what the list badges a report by, and a badge saying "customer safe" has to
// be true.
//
// The run log exists to answer "what did we send the owner on the 14th, and
// did it have our costs on it?". It is written after the send has already
// happened, so it is forgiving where it safely can be: a report_id the caller
// cannot see is stored as NULL rather than refused, because failing the log
// would not un-send the email.

const { neon } = require('@neondatabase/serverless');
const {
  requireDivision, levelFor, isSalesIn, accessFromRow, hasDivisionAccess,
} = require('./lib/auth');

// The divisions whose pages carry Custom Reporting. They share one data model,
// which is what lets one report builder serve all three.
const DIVISIONS = ['turf', 'paving', 'kiewit'];

const MAX_NAME             = 120;
const MAX_DESCRIPTION      = 500;
const MAX_DEFINITION_BYTES = 64 * 1024;
// A definition is a few levels deep (sections → columns / labels / options).
// Anything far deeper is not one, and walking it is how a request gets to
// exhaust the stack.
const MAX_DEPTH            = 32;
const LIST_CAP             = 500;
const RUNS_CAP             = 200;
const RESTORE_DAYS         = 30;
const PURGE_DAYS           = 90;
const RUN_ACTIONS          = ['print', 'email', 'excel'];
const MAX_RUN_JOBS         = 500;
const MAX_RUN_RECIPIENTS   = 50;
const MAX_SUBJECT          = 300;
const MAX_REPORT_NAME      = 200;

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

function readName(raw) {
  const name = oneLine(raw, Infinity);
  if (!name) return { error: 'Give the report a name.' };
  if (name.length > MAX_NAME) return { error: `Report names are limited to ${MAX_NAME} characters.` };
  return { value: name };
}

function readDescription(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'description must be text' };
  const d = cleanStr(raw).trim();
  if (d.length > MAX_DESCRIPTION) return { error: `Descriptions are limited to ${MAX_DESCRIPTION} characters.` };
  return { value: d || null };
}

function readVisibility(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return { value: fallback };
  if (raw === 'private' || raw === 'shared') return { value: raw };
  return { error: 'visibility must be private or shared' };
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

const flag = v => v === true || v === '1' || v === 'true';

/**
 * What the list badges a report by, from its definition alone. 'report' when
 * it saves specific jobs; 'template' when they are picked at run time.
 */
function deriveFlags(def) {
  const jobs = def && def.jobs;
  const savesJobs = Boolean(jobs) && jobs.mode === 'saved' && Array.isArray(jobs.ids) && jobs.ids.length > 0;
  return {
    kind:          savesJobs ? 'report' : 'template',
    customer_safe: !(def && def.includeInternal === true),
  };
}

// ── Who may do what to a row ─────────────────────────────────────────────
const ownedBy = (r, me) => Number(r.owner_user_id) === me.userId;
const isVisible = (r, me) => !r.deleted_at && (r.visibility === 'shared' || ownedBy(r, me));
// The rule ignores deleted_at, so it also answers "may they restore it?".
const mayEdit = (r, me, canShare) => (r.visibility === 'private' && ownedBy(r, me))
  || (r.visibility === 'shared' && canShare);

function shape(r, me, canShare) {
  return {
    id:                  Number(r.id),
    name:                r.name,
    description:         r.description,
    visibility:          r.visibility,
    kind:                r.kind,
    customer_safe:       Boolean(r.customer_safe),
    definition:          r.definition || {},
    version:             Number(r.version),
    owner_user_id:       Number(r.owner_user_id),
    owner_username:      r.owner_username,
    updated_by_username: r.updated_by_username,
    created_at:          r.created_at,
    updated_at:          r.updated_at,
    last_run_at:         r.last_run_at,
    run_count:           Number(r.run_count) || 0,
    deleted_at:          r.deleted_at || null,
    deleted_by_username: r.deleted_by_username || null,
    mine:                ownedBy(r, me),
    can_edit:            mayEdit(r, me, canShare),
  };
}

const asArray = v => (Array.isArray(v) ? v : []);

function shapeRun(r) {
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

// The pg error code for a unique-index violation. The only unique rules on
// these tables are the two name indexes, so it always means the name is taken.
function isUniqueViolation(err) {
  return Boolean(err) && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
}

async function loadLive(sql, company, division, id) {
  const rows = await sql`
    SELECT * FROM custom_reports
     WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL`;
  return rows[0] || null;
}

/**
 * May this report's owner still open Custom Reporting in the division? A
 * shared template made private goes back to its author — unless the author
 * has since left, lost the division or been made sales there, when it would
 * be private to nobody who can see it and simply vanish. Then it goes to
 * whoever made it private instead.
 */
async function ownerCanStillOpen(sql, company, division, ownerId) {
  const rows = await sql`
    SELECT u.division_roles, u.divisions, u.role, u.is_platform_admin, c.allowed_divisions
      FROM users u JOIN companies c ON c.code = u.company_code
     WHERE u.id = ${ownerId} AND u.company_code = ${company}`;
  if (!rows[0]) return false;
  const access = accessFromRow(rows[0]);
  return hasDivisionAccess(access, division) && !isSalesIn(access, division);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = await requireDivision(req, res, { required: true });
  if (!guard) return;
  const { payload, division } = guard;

  if (!DIVISIONS.includes(division)) {
    return res.status(400).json({ ok: false, error: 'Custom reports are not available for this division' });
  }
  if (isSalesIn(payload, division)) {
    return res.status(403).json({ ok: false, error: 'Custom Reporting is part of Analytics, which a sales login cannot open.' });
  }

  const me = { userId: Number(payload.userId), username: payload.username || null };
  // Every row is owned by somebody; a token with no user behind it owns nothing.
  if (!Number.isSafeInteger(me.userId)) return res.status(401).json({ ok: false, error: 'Unauthorized — please log in' });

  // Platform admins come back from levelFor as 'admin'.
  const canShare = ['admin', 'level3'].includes(levelFor(payload, division));
  const company  = payload.companyCode;
  const sql      = neon(process.env.DATABASE_URL);
  const q        = req.query || {};
  const out      = r => shape(r, me, canShare);

  try {
    // ── GET ?runs=1 — the send history ─────────────────────────────────
    // Admins and level3 see the division's; everyone else sees their own.
    if (req.method === 'GET' && flag(q.runs)) {
      let reportId = null;
      if (q.report_id !== undefined && q.report_id !== '') {
        reportId = toId(q.report_id);
        if (!reportId) return res.status(400).json({ ok: false, error: 'report_id must be a number' });
      }
      const rows = await sql`
        SELECT id, report_id, report_name, action, project_ids, project_names,
               to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to,
               recipients, subject, included_internal, run_by_user_id, run_by_username, created_at
          FROM custom_report_runs
         WHERE company_code = ${company} AND division = ${division}
           AND (${canShare}::boolean OR run_by_user_id = ${me.userId})
           AND (${reportId}::bigint IS NULL OR report_id = ${reportId}::bigint)
         ORDER BY created_at DESC, id DESC
         LIMIT ${RUNS_CAP}`;
      return res.json({ ok: true, runs: rows.map(shapeRun) });
    }

    // ── GET ?deleted=1 — Recently Deleted ──────────────────────────────
    // Only what the caller could restore: their own private reports, and the
    // shared templates if they may manage those.
    if (req.method === 'GET' && flag(q.deleted)) {
      const rows = await sql`
        SELECT * FROM custom_reports
         WHERE company_code = ${company} AND division = ${division}
           AND deleted_at IS NOT NULL
           AND deleted_at > NOW() - make_interval(days => ${RESTORE_DAYS})
           AND ((visibility = 'private' AND owner_user_id = ${me.userId})
             OR (visibility = 'shared' AND ${canShare}::boolean))
         ORDER BY deleted_at DESC, id DESC
         LIMIT ${LIST_CAP}`;
      return res.json({ ok: true, reports: rows.map(out), canShare, me });
    }

    // ── GET — the caller's reports and the division's templates ────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT * FROM custom_reports
         WHERE company_code = ${company} AND division = ${division}
           AND deleted_at IS NULL
           AND (visibility = 'shared' OR owner_user_id = ${me.userId})
         ORDER BY updated_at DESC, id DESC
         LIMIT ${LIST_CAP}`;
      return res.json({ ok: true, reports: rows.map(out), canShare, me });
    }

    // ── POST ?action=run — log a print / email / Excel download ────────
    if (req.method === 'POST' && q.action === 'run') {
      const b = req.body || {};
      if (!RUN_ACTIONS.includes(b.action)) {
        return res.status(400).json({ ok: false, error: 'action must be print, email or excel' });
      }
      const ids = readList(b.project_ids, MAX_RUN_JOBS, 120, 'jobs');
      if (ids.error) return res.status(400).json({ ok: false, error: ids.error });
      const names = readList(b.project_names, MAX_RUN_JOBS, 200, 'job names');
      if (names.error) return res.status(400).json({ ok: false, error: names.error });
      const recipients = readRecipients(b.recipients);
      if (recipients.error) return res.status(400).json({ ok: false, error: recipients.error });
      const from = readDate(b.date_from);
      const to   = readDate(b.date_to);
      if (from.error || to.error) return res.status(400).json({ ok: false, error: from.error || to.error });
      let defJson = '{}';
      if (b.definition !== undefined && b.definition !== null) {
        const d = readDefinition(b.definition, { requireV: false });
        if (d.error) return res.status(d.status).json({ ok: false, error: d.error });
        defJson = d.json;
      }
      const reportName = oneLine(b.report_name, MAX_REPORT_NAME) || 'Untitled report';
      const subject    = oneLine(b.subject, MAX_SUBJECT) || null;
      // Junk is the same as none: the log must not fail a send over it.
      const reportId   = toId(b.report_id);

      // One statement, so the report's run count and the history row cannot
      // disagree. The UPDATE matches only a report the caller can see; when it
      // matches nothing the run is still logged, against no report.
      const rows = await sql`
        WITH bumped AS (
          UPDATE custom_reports
             SET last_run_at = NOW(), run_count = run_count + 1
           WHERE id = ${reportId}::bigint AND company_code = ${company} AND division = ${division}
             AND deleted_at IS NULL
             AND (visibility = 'shared' OR owner_user_id = ${me.userId})
          RETURNING id
        )
        INSERT INTO custom_report_runs
          (report_id, company_code, division, report_name, action, project_ids, project_names,
           date_from, date_to, recipients, subject, included_internal, definition,
           run_by_user_id, run_by_username)
        VALUES
          ((SELECT id FROM bumped), ${company}, ${division}, ${reportName}, ${b.action},
           ${JSON.stringify(ids.value)}::jsonb, ${JSON.stringify(names.value)}::jsonb,
           ${from.value}::date, ${to.value}::date, ${JSON.stringify(recipients.value)}::jsonb,
           ${subject}, ${b.included_internal === true}, ${defJson}::jsonb,
           ${me.userId}, ${me.username})
        RETURNING id, report_id, report_name, action, project_ids, project_names,
                  to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to,
                  recipients, subject, included_internal, run_by_user_id, run_by_username, created_at`;
      return res.status(201).json({ ok: true, run: shapeRun(rows[0]) });
    }

    // ── POST ?action=restore&id=N — out of Recently Deleted ────────────
    if (req.method === 'POST' && q.action === 'restore') {
      const id = toId(q.id);
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
      const found = await sql`
        SELECT *, (deleted_at > NOW() - make_interval(days => ${RESTORE_DAYS})) AS restorable
          FROM custom_reports
         WHERE id = ${id} AND company_code = ${company} AND division = ${division}`;
      const cur = found[0];
      // Restored already (a second click): say so with the report, not an error.
      if (cur && !cur.deleted_at && isVisible(cur, me)) return res.json({ ok: true, report: out(cur) });
      if (!cur || !cur.deleted_at || (cur.visibility === 'private' && !ownedBy(cur, me))) {
        return res.status(404).json({ ok: false, error: 'Report not found' });
      }
      if (!mayEdit(cur, me, canShare)) {
        return res.status(403).json({ ok: false, error: 'Only an admin or level 3 user can restore a shared template.' });
      }
      if (!cur.restorable) {
        return res.status(404).json({ ok: false, error: `That report was deleted more than ${RESTORE_DAYS} days ago and can no longer be restored.` });
      }
      const rows = await sql`
        UPDATE custom_reports SET
          deleted_at = NULL, deleted_by_username = NULL,
          updated_at = NOW(), updated_by_user_id = ${me.userId}, updated_by_username = ${me.username}
         WHERE id = ${id} AND company_code = ${company} AND division = ${division}
           AND deleted_at IS NOT NULL
           AND deleted_at > NOW() - make_interval(days => ${RESTORE_DAYS})
         RETURNING *`;
      if (rows[0]) return res.json({ ok: true, report: out(rows[0]) });
      // Somebody else restored it in between.
      const now = await loadLive(sql, company, division, id);
      if (now && isVisible(now, me)) return res.json({ ok: true, report: out(now) });
      return res.status(404).json({ ok: false, error: 'Report not found' });
    }

    if (req.method === 'POST' && q.action) {
      return res.status(400).json({ ok: false, error: 'Unknown action' });
    }

    // ── POST — save a new report ───────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      const vis = readVisibility(b.visibility, 'private');
      if (vis.error) return res.status(400).json({ ok: false, error: vis.error });
      if (vis.value === 'shared' && !canShare) {
        return res.status(403).json({ ok: false, error: 'Only an admin or level 3 user can share a report with the division.' });
      }
      const name = readName(b.name);
      if (name.error) return res.status(400).json({ ok: false, error: name.error });
      const desc = readDescription(b.description);
      if (desc.error) return res.status(400).json({ ok: false, error: desc.error });
      const def = readDefinition(b.definition);
      if (def.error) return res.status(def.status).json({ ok: false, error: def.error });
      const { kind, customer_safe } = deriveFlags(def.value);

      const rows = await sql`
        INSERT INTO custom_reports
          (company_code, division, name, description, visibility, kind, definition, customer_safe,
           owner_user_id, owner_username, updated_by_user_id, updated_by_username)
        VALUES
          (${company}, ${division}, ${name.value}, ${desc.value}, ${vis.value}, ${kind},
           ${def.json}::jsonb, ${customer_safe},
           ${me.userId}, ${me.username}, ${me.userId}, ${me.username})
        RETURNING *`;
      return res.status(201).json({ ok: true, report: out(rows[0]) });
    }

    // ── PUT ?id=N — save changes ───────────────────────────────────────
    if (req.method === 'PUT') {
      const id = toId(q.id);
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
      const b = req.body || {};
      const version = toId(b.version);
      if (!version) return res.status(400).json({ ok: false, error: 'version is required' });

      const cur = await loadLive(sql, company, division, id);
      if (!cur || !isVisible(cur, me)) return res.status(404).json({ ok: false, error: 'Report not found' });
      if (!mayEdit(cur, me, canShare)) {
        return res.status(403).json({ ok: false, error: 'Only an admin or level 3 user can change a shared template. Use Save As to make your own copy.' });
      }
      if (Number(cur.version) !== version) {
        return res.status(409).json({ ok: false, error: 'version_conflict', report: out(cur) });
      }

      let name = cur.name;
      if (b.name !== undefined) {
        const n = readName(b.name);
        if (n.error) return res.status(400).json({ ok: false, error: n.error });
        name = n.value;
      }
      let description = cur.description;
      if (b.description !== undefined) {
        const d = readDescription(b.description);
        if (d.error) return res.status(400).json({ ok: false, error: d.error });
        description = d.value;
      }
      const vis = readVisibility(b.visibility, cur.visibility);
      if (vis.error) return res.status(400).json({ ok: false, error: vis.error });
      let owner = { id: Number(cur.owner_user_id), username: cur.owner_username };
      if (vis.value !== cur.visibility) {
        if (!canShare) {
          return res.status(403).json({ ok: false, error: 'Only an admin or level 3 user can share a report with the division.' });
        }
        if (vis.value === 'private' && !ownedBy(cur, me)
            && !(await ownerCanStillOpen(sql, company, division, owner.id))) {
          owner = { id: me.userId, username: me.username };
        }
      }
      let definition = cur.definition || {};
      if (b.definition !== undefined) {
        const d = readDefinition(b.definition);
        if (d.error) return res.status(d.status).json({ ok: false, error: d.error });
        definition = d.value;
      }
      const { kind, customer_safe } = deriveFlags(definition);

      const rows = await sql`
        UPDATE custom_reports SET
          name                = ${name},
          description         = ${description},
          visibility          = ${vis.value},
          definition          = ${JSON.stringify(definition)}::jsonb,
          kind                = ${kind},
          customer_safe       = ${customer_safe},
          owner_user_id       = ${owner.id},
          owner_username      = ${owner.username},
          version             = version + 1,
          updated_at          = NOW(),
          updated_by_user_id  = ${me.userId},
          updated_by_username = ${me.username}
         WHERE id = ${id} AND company_code = ${company} AND division = ${division}
           AND version = ${version} AND deleted_at IS NULL
         RETURNING *`;
      if (rows[0]) return res.json({ ok: true, report: out(rows[0]) });
      // Saved or deleted by somebody else since it was read above.
      const now = await loadLive(sql, company, division, id);
      if (!now || !isVisible(now, me)) return res.status(404).json({ ok: false, error: 'Report not found' });
      return res.status(409).json({ ok: false, error: 'version_conflict', report: out(now) });
    }

    // ── DELETE ?id=N — into Recently Deleted ───────────────────────────
    if (req.method === 'DELETE') {
      const id = toId(q.id);
      if (!id) return res.status(400).json({ ok: false, error: 'id is required' });
      const cur = await loadLive(sql, company, division, id);
      if (!cur || !isVisible(cur, me)) return res.status(404).json({ ok: false, error: 'Report not found' });
      if (!mayEdit(cur, me, canShare)) {
        return res.status(403).json({ ok: false, error: 'Only an admin or level 3 user can delete a shared template.' });
      }
      const rows = await sql`
        UPDATE custom_reports SET deleted_at = NOW(), deleted_by_username = ${me.username}
         WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         RETURNING *`;
      // Housekeeping rides along with deletes rather than needing a cron: what
      // has sat in the bin three times longer than it can be restored goes for
      // good. Its run history stays, pointing at no report. Never fatal — the
      // delete the user asked for has already happened.
      try {
        await sql`
          DELETE FROM custom_reports
           WHERE company_code = ${company} AND division = ${division}
             AND deleted_at < NOW() - make_interval(days => ${PURGE_DAYS})`;
      } catch (err) {
        console.error('[custom-reports] purge failed:', err.message);
      }
      return res.json({ ok: true, report: rows[0] ? out(rows[0]) : null });
    }

    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ ok: false, error: 'name_taken' });
    console.error('[custom-reports] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
};
