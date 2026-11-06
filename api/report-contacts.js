'use strict';

// /api/report-contacts — the customer people a job's custom reports go to.
//
// A PM emails the same owner's rep, engineer and GC super every week. Typing
// them in every time is how one gets missed — or a different customer's
// address autocompletes in. So they are saved once, against the job or
// against the client (every job of that client), and the Email Report modal
// fills them in; a schedule can send to "each job's saved contacts" too
// (api/lib/report-contacts.js contactsForJobs).
//
// Recipient groups (api/email/recipient-groups.js) stay what they are — the
// company's internal distribution lists, admin-managed. These are per job and
// per division, and the people who run the jobs keep them: admin, level3 and
// level2 in the division may add, change and remove them; level1 may read.
// Sales cannot open Custom Reporting, so it is refused here too.
//
// GET    ?division=…[&project_ids=a,b][&client_keys=x,y]
//          → { ok, contacts:[…], canEdit }
//          With project_ids or client_keys (even empty) only those jobs' and
//          clients' contacts come back — the Email modal asks this way, and an
//          empty pick must never mean "every customer in the division". With
//          neither, every live contact in the division (the Contacts manager),
//          capped at LIST_CAP.
// POST   ?division=…        { project_id? | client_name?/client_key?, name?, title?,
//                             organization?, email, phone?, role?, auto_add? }
//          → 201 { ok, contact }   | 409 { error: 'duplicate' }
// PUT    ?division=…&id=N   partial update of the same fields (not which job or
//                           client it belongs to — delete and add it again)
// DELETE ?division=…&id=N   soft delete
//
// A client-level contact is filed under client_key = the client name trimmed
// and lower-cased, worked out here from client_name, so the browser cannot
// file it under a key no job would ever match.

const { neon } = require('@neondatabase/serverless');
const { requireDivision, levelFor, isSalesIn } = require('./lib/auth');
const { isValidEmail } = require('./lib/email');
const { DIVISIONS, clientKeyOf } = require('./lib/report-contacts');
const { cleanStr, toId, isPlainObject } = require('./lib/custom-report-runs');

const MAX_IDS        = 200;
const LIST_CAP       = 2000;
const MAX_TEXT       = 120;
const MAX_PHONE      = 40;
const MAX_CLIENT     = 200;
const MAX_PROJECT_ID = 120;
const ROLES          = ['owner', 'gc', 'engineer', 'inspector', 'internal', 'other'];
// Digits and the punctuation people write phone numbers with, plus "x" / "ext".
const PHONE_RE       = /^[0-9+().\-\sxXeEtT]*$/;
const EDIT_LEVELS    = ['admin', 'level3', 'level2'];

// ── Reading what the browser sends ───────────────────────────────────────
// One line of text: control characters become spaces, NUL and half surrogate
// pairs (which Postgres refuses) go. Refused when longer than `max` rather
// than cut, so nobody's title is silently shortened.
function readText(raw, max, what) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${what} must be text` };
  const v = cleanStr(raw).replace(/[\u0001-\u001f\u007f]+/g, ' ').trim();
  if (v.length > max) return { error: `${what} is limited to ${max} characters` };
  return { value: v || null };
}

function readEmail(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'An email address is required' };
  const e = raw.trim().toLowerCase();
  if (!isValidEmail(e)) return { error: `"${cleanStr(raw).trim().slice(0, 80)}" is not a valid email address` };
  return { value: e };
}

function readPhone(raw) {
  const t = readText(raw, MAX_PHONE, 'Phone');
  if (t.error || t.value === null) return t;
  if (!PHONE_RE.test(t.value)) return { error: 'Phone may hold only digits, spaces and + ( ) . - x ext' };
  return t;
}

function readRole(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: 'other' };
  if (!ROLES.includes(raw)) return { error: `role must be one of ${ROLES.join(', ')}` };
  return { value: raw };
}

function readAutoAdd(raw) {
  if (raw === undefined || raw === null) return { value: true };
  if (typeof raw !== 'boolean') return { error: 'auto_add must be true or false' };
  return { value: raw };
}

// A comma-separated list (or a repeated query parameter), trimmed, de-duped.
function readIdList(raw, norm, what) {
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap(x => (typeof x === 'string' ? x.split(',') : []))
    .map(norm)
    .filter(Boolean);
  const out = [...new Set(parts)];
  if (out.length > MAX_IDS) return { error: `Too many ${what} (max ${MAX_IDS})` };
  return { value: out };
}

const projectIdOf = s => {
  const v = cleanStr(s).replace(/[\u0001-\u001f\u007f]+/g, '').trim();
  return v.length <= MAX_PROJECT_ID ? v : '';
};

function shape(r) {
  return {
    id:                  Number(r.id),
    project_id:          r.project_id || null,
    client_key:          r.client_key || null,
    client_name:         r.client_name || null,
    name:                r.name || null,
    title:               r.title || null,
    organization:        r.organization || null,
    email:               r.email,
    phone:               r.phone || null,
    role:                r.role || 'other',
    auto_add:            Boolean(r.auto_add),
    updated_at:          r.updated_at,
    updated_by_username: r.updated_by_username || null,
  };
}

function isUniqueViolation(err) {
  return Boolean(err) && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
}

/** The person fields of a body, for a create (all) or an update (those sent). */
function readPersonFields(b, { partial }) {
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  for (const [key, label] of [['name', 'Name'], ['title', 'Title'], ['organization', 'Organization']]) {
    if (partial && !has(key)) continue;
    const t = readText(b[key], MAX_TEXT, label);
    if (t.error) return { error: t.error };
    out[key] = t.value;
  }
  if (!partial || has('email')) {
    const e = readEmail(b.email);
    if (e.error) return { error: e.error };
    out.email = e.value;
  }
  if (!partial || has('phone')) {
    const p = readPhone(b.phone);
    if (p.error) return { error: p.error };
    out.phone = p.value;
  }
  if (!partial || has('role')) {
    const r = readRole(b.role);
    if (r.error) return { error: r.error };
    out.role = r.value;
  }
  if (!partial || has('auto_add')) {
    const a = readAutoAdd(b.auto_add);
    if (a.error) return { error: a.error };
    out.auto_add = a.value;
  }
  return { value: out };
}

/** Which job or client a new contact is filed under. */
function readScope(b) {
  const pid = readText(b.project_id, MAX_PROJECT_ID, 'project_id');
  if (pid.error) return { error: pid.error };
  const cname = readText(b.client_name, MAX_CLIENT, 'Client');
  if (cname.error) return { error: cname.error };
  const ckeyRaw = readText(b.client_key, MAX_CLIENT, 'client_key');
  if (ckeyRaw.error) return { error: ckeyRaw.error };
  if (pid.value) {
    if (ckeyRaw.value) return { error: 'A contact belongs to one job or to one client, not both' };
    // The job's client name rides along for display only.
    return { value: { project_id: pid.value, client_key: null, client_name: cname.value } };
  }
  const key = clientKeyOf(cname.value || ckeyRaw.value || '');
  if (!key) return { error: 'Say which job or which client the contact is for' };
  if (cname.value && ckeyRaw.value && clientKeyOf(ckeyRaw.value) !== key) {
    return { error: 'client_key does not match client_name' };
  }
  return { value: { project_id: null, client_key: key, client_name: cname.value || ckeyRaw.value } };
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
    return res.status(400).json({ ok: false, error: 'Report contacts are not available for this division' });
  }
  if (isSalesIn(payload, division)) {
    return res.status(403).json({ ok: false, error: 'Report contacts are part of Custom Reporting, which a sales login cannot open.' });
  }

  const company  = payload.companyCode;
  const canEdit  = EDIT_LEVELS.includes(levelFor(payload, division));
  const userId   = Number.isSafeInteger(Number(payload.userId)) && payload.userId != null ? Number(payload.userId) : null;
  const username = payload.username || null;
  const q        = req.query || {};
  const sql      = neon(process.env.DATABASE_URL);

  try {
    // ── GET — a job's (or client's) contacts, or the division's ─────────
    if (req.method === 'GET') {
      const filtered = q.project_ids !== undefined || q.client_keys !== undefined;
      let rows;
      if (filtered) {
        const ids = readIdList(q.project_ids, projectIdOf, 'jobs');
        if (ids.error) return res.status(400).json({ ok: false, error: ids.error });
        const keys = readIdList(q.client_keys, clientKeyOf, 'clients');
        if (keys.error) return res.status(400).json({ ok: false, error: keys.error });
        rows = !ids.value.length && !keys.value.length ? [] : await sql`
          SELECT * FROM report_contacts
           WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
             AND (project_id = ANY(${ids.value}::text[])
                  OR (project_id IS NULL AND client_key = ANY(${keys.value}::text[])))
           ORDER BY (project_id IS NULL), id
           LIMIT ${LIST_CAP}`;
      } else {
        rows = await sql`
          SELECT * FROM report_contacts
           WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
           ORDER BY (project_id IS NULL), project_id, client_key, lower(COALESCE(name, email)), id
           LIMIT ${LIST_CAP}`;
      }
      return res.json({ ok: true, contacts: rows.map(shape), canEdit });
    }

    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    if (!canEdit) {
      return res.status(403).json({ ok: false, error: 'Only admin, level 3 and level 2 users can change saved contacts.' });
    }
    const b = req.body === undefined || req.body === null ? {} : req.body;
    if (req.method !== 'DELETE' && !isPlainObject(b)) {
      return res.status(400).json({ ok: false, error: 'Body must be an object' });
    }

    // ── POST — save a contact ──────────────────────────────────────────
    if (req.method === 'POST') {
      const scope = readScope(b);
      if (scope.error) return res.status(400).json({ ok: false, error: scope.error });
      const f = readPersonFields(b, { partial: false });
      if (f.error) return res.status(400).json({ ok: false, error: f.error });
      const s = scope.value, v = f.value;
      try {
        const rows = await sql`
          INSERT INTO report_contacts
            (company_code, division, project_id, client_key, client_name, name, title, organization,
             email, phone, role, auto_add, created_by_user_id, created_by_username, updated_by_username)
          VALUES
            (${company}, ${division}, ${s.project_id}, ${s.client_key}, ${s.client_name}, ${v.name}, ${v.title},
             ${v.organization}, ${v.email}, ${v.phone}, ${v.role}, ${v.auto_add}, ${userId}, ${username}, ${username})
          RETURNING *`;
        return res.status(201).json({ ok: true, contact: shape(rows[0]) });
      } catch (err) {
        if (isUniqueViolation(err)) return res.status(409).json({ ok: false, error: 'duplicate' });
        throw err;
      }
    }

    const id = toId(q.id);
    if (!id) return res.status(400).json({ ok: false, error: 'id is required' });

    // ── DELETE — out of the list (soft) ────────────────────────────────
    if (req.method === 'DELETE') {
      const rows = await sql`
        UPDATE report_contacts SET deleted_at = NOW(), updated_at = NOW(), updated_by_username = ${username}
         WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         RETURNING id`;
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'Contact not found' });
      return res.json({ ok: true, id });
    }

    // ── PUT — change a contact ─────────────────────────────────────────
    const found = await sql`
      SELECT * FROM report_contacts
       WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL`;
    const cur = found[0];
    if (!cur) return res.status(404).json({ ok: false, error: 'Contact not found' });

    // Which job or client it belongs to is fixed. The same values sent back
    // are fine (a client name re-cased included); a different one is refused.
    const moved = 'A contact cannot be moved to another job or client — delete it and add it again there.';
    if (Object.prototype.hasOwnProperty.call(b, 'project_id')) {
      const p = readText(b.project_id, MAX_PROJECT_ID, 'project_id');
      if (p.error || (p.value || null) !== (cur.project_id || null)) return res.status(400).json({ ok: false, error: moved });
    }
    if (Object.prototype.hasOwnProperty.call(b, 'client_key')
        && (clientKeyOf(b.client_key || '') || null) !== (cur.client_key || null)) {
      return res.status(400).json({ ok: false, error: moved });
    }
    let clientName = cur.client_name;
    if (Object.prototype.hasOwnProperty.call(b, 'client_name')) {
      const c = readText(b.client_name, MAX_CLIENT, 'Client');
      if (c.error) return res.status(400).json({ ok: false, error: c.error });
      if (cur.client_key && clientKeyOf(c.value || '') !== cur.client_key) return res.status(400).json({ ok: false, error: moved });
      clientName = c.value;
    }
    const f = readPersonFields(b, { partial: true });
    if (f.error) return res.status(400).json({ ok: false, error: f.error });
    const v = { ...cur, ...f.value };
    try {
      const rows = await sql`
        UPDATE report_contacts SET
          client_name = ${clientName}, name = ${v.name}, title = ${v.title}, organization = ${v.organization},
          email = ${v.email}, phone = ${v.phone}, role = ${v.role}, auto_add = ${Boolean(v.auto_add)},
          updated_at = NOW(), updated_by_username = ${username}
         WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         RETURNING *`;
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'Contact not found' });
      return res.json({ ok: true, contact: shape(rows[0]) });
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ ok: false, error: 'duplicate' });
      throw err;
    }
  } catch (err) {
    console.error('[report-contacts] error:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }
};
