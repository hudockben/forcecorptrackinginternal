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
// would not un-send the email. An emailed custom report is logged by
// api/email/send-report.js itself, as it goes out; ?action=run is how a print
// or a download is logged (and an email, when the server could not log it).
// A user may log RUN_RATE_LIMIT runs a minute — far more than anyone prints —
// and definition snapshots older than two years are emptied as runs come in.

const { neon } = require('@neondatabase/serverless');
const {
  requireDivision, levelFor, isSalesIn, accessFromRow, hasDivisionAccess,
} = require('./lib/auth');

const {
  DIVISIONS, RUN_RATE_LIMIT,
  cleanStr, oneLine, readDefinition, toId, readRun, shapeRun, recentRunCount, insertRun, pruneSnapshots,
} = require('./lib/custom-report-runs');

const MAX_NAME             = 120;
const MAX_DESCRIPTION      = 500;
const LIST_CAP             = 500;
const RUNS_CAP             = 200;
const RESTORE_DAYS         = 30;
const PURGE_DAYS           = 90;

// Cleaning what the browser sends — NUL characters, half surrogate pairs,
// control characters in one-line text, over-deep or over-size definitions —
// lives in lib/custom-report-runs.js, shared with the email path that logs
// custom-report sends itself.

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
      const r = readRun(req.body);
      if (r.error) return res.status(r.status).json({ ok: false, error: r.error });
      // Every division user may log a run, so a cheap per-user limit keeps a
      // script from filling the history admins read (and the database). A
      // person printing and downloading never comes near it.
      if ((await recentRunCount(sql, company, me.userId)) >= RUN_RATE_LIMIT) {
        return res.status(429).json({ ok: false, error: 'Too many reports logged — try again in a minute.' });
      }
      const run = await insertRun(sql, { company, division, me, run: r.value });
      // Old definition snapshots are emptied as new runs come in. Never
      // fatal — the run the user asked to log is already logged.
      try { await pruneSnapshots(sql, company, division); }
      catch (err) { console.error('[custom-reports] snapshot prune failed:', err.message); }
      return res.status(201).json({ ok: true, run });
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
