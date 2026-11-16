'use strict';

// /api/procurement — the Procurement tab: a job's material buy-out sheet.
//
// A PM keeps, per job, a line for every material he has to buy: when it is
// needed on site, how long the supplier takes, which vendor and quote, which
// PO, and whether it has been ordered and delivered. That used to be an Excel
// sheet per job; this is it as rows (procurement_items, neon-schema.sql
// PROCUREMENT). Cost Code and Sub Code are the bid's own codes — in a turf
// bid the sub code IS the material — and Description is free text beside
// them, because bid lines carry none.
//
// A row comes from one of two places. Send to Procurement (action=send) turns
// bid lines into rows with source 'bid'; "+ Add Row" and "+ Material" add
// source 'manual' rows by hand. Both are edited the same way.
//
// GET    ?division=…&project_id=X[&include_deleted=1]
//          → { ok, items:[…], canEdit }   live rows, or every row with its
//            deleted_at when include_deleted=1 (Send to Procurement needs the
//            deleted ones to offer "removed earlier"). Ordered created_at, id.
// POST   ?division=…            { item:{ id, project_id, …fields } }
//          → 201 { ok, item }  | 409 { error:'duplicate' } when the id exists.
//            Always a manual row, whatever `source` the body claims.
// POST   ?division=…&action=send
//          { project_id, items:[{ id, bid_item_id, cost_code, sub_code, quantity, unit }], restore_ids:[…] }
//          → { ok, created:[…], restored:[…], skipped:n }
//            A restore_ids entry is a row id, or { id, bid_item_id, cost_code,
//            sub_code } for a row deleted before a Procore "Replace all" gave
//            its bid line a new id: it comes back tied to the new line.
// PATCH  ?division=…&id=X       { fields:{ …only the cells that changed } }  → { ok, item }
// PATCH  ?division=…&action=bulk { ids:[…], fields:{…} }  → { ok, items:[…], missing:[…] }
// DELETE ?division=…&id=X | &ids=a,b,c | &project_id=X    → { ok, deleted:n }
//
// Who: every non-sales user with the division reads; admin, level3 and level2
// write; level1 gets 403 read_only on every write; sales is refused outright
// (the tab carries cost codes, and a sales login is kept away from job costs —
// api/lib/auth.js SALES_LEVEL). Deleting a whole job's rows, which only
// happens when the job itself is deleted, takes admin or level3, the same as
// deleting the job.
//
// Errors are { ok:false, error:'<code>' } with a `message` for people, and a
// `field` when one value was refused. Values are refused, never cut short or
// guessed at: a typed quantity the server cannot read is an error the page
// shows, not a blank cell saved over the old one.

const { neon } = require('@neondatabase/serverless');
const { requireDivision, levelFor, isSalesIn } = require('./lib/auth');
const { normalizeNumeric } = require('./lib/numeric');
const { cleanStr, isPlainObject } = require('./lib/custom-report-runs');

const DIVISIONS             = ['turf', 'paving', 'kiewit'];
const EDIT_LEVELS           = ['admin', 'level3', 'level2'];
const PROJECT_DELETE_LEVELS = ['admin', 'level3'];
const SCA_STATUSES          = ['Pending', 'Needed', 'Not Needed', 'Executed'];
// One Send, one bulk edit or one bulk delete. A turf bid runs to a few
// hundred lines; this is far past that and still one statement.
const MAX_BATCH      = 2000;
const MAX_PROJECT_ID = 120;
const MAX_REF        = 64;
const MAX_LEAD_DAYS  = 3650;
// A quantity past a trillion is a paste gone wrong, not a takeoff.
const MAX_QTY        = 1e12;
// Row ids are minted by the page (uid()), so they are checked for shape: they
// end up in URLs and in comma-separated ?ids= lists.
const ROW_ID_RE      = /^[A-Za-z0-9_-]{1,64}$/;
// What is left of a number once api/lib/numeric.js has taken the currency,
// spaces and thousands separators off. Anything else is not a number.
const NUM_RE         = /^-?(\d+(\.\d*)?|\.\d+)$/;

// ── The editable fields ──────────────────────────────────────────────────
// Everything a PATCH may change, and how each is read. id, project_id,
// source, company, division and the audit columns are not here: a row never
// moves to another job, never changes where it came from, and who touched it
// last is the server's to say.
const FIELDS = {
  description:      { kind: 'text',    max: 500, label: 'Description' },
  quantity:         { kind: 'number',            label: 'Quantity' },
  unit:             { kind: 'text',    max: 20,  label: 'Unit' },
  sca_status:       { kind: 'sca',               label: 'Sub-Contractor Agreement' },
  date_needed:      { kind: 'date',              label: 'Date Needed' },
  lead_time_days:   { kind: 'days',              label: 'Lead Time (days)' },
  date_ordered:     { kind: 'date',              label: 'Date Ordered' },
  date_delivered:   { kind: 'date',              label: 'Date Delivered' },
  vendor:           { kind: 'text',    max: 120, label: 'Vendor' },
  quote_number:     { kind: 'text',    max: 120, label: 'Quote #' },
  contact:          { kind: 'text',    max: 120, label: 'Contact' },
  // Not checked for shape: the sheets this replaces keep phone numbers here.
  email:            { kind: 'text',    max: 200, label: 'Email' },
  po_id:            { kind: 'ref',     max: MAX_REF, label: 'PO' },
  po_auto:          { kind: 'bool',              label: 'PO auto-match' },
  cost_code:        { kind: 'text',    max: 200, label: 'Cost Code' },
  sub_code:         { kind: 'text',    max: 200, label: 'Sub Code' },
  bid_item_id:      { kind: 'ref',     max: MAX_REF, label: 'Bid line' },
  bid_qty_at_send:  { kind: 'number',            label: 'Bid quantity at send' },
  // NULL is "never sent"; '' is "sent, and the bid line had no unit".
  bid_unit_at_send: { kind: 'opttext', max: 20,  label: 'Bid unit at send' },
};
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ── Reading what the browser sends ───────────────────────────────────────
// One line of text: NUL and half surrogate pairs (which Postgres refuses) go,
// other control characters become spaces. Refused when longer than `max`
// rather than cut, so nobody's description is silently shortened.
function oneLine(raw) {
  return cleanStr(raw).replace(/[\u0001-\u001f\u007f]+/g, ' ').trim();
}

function readText(raw, max, label) {
  if (raw === undefined || raw === null) return { value: '' };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${label} must be text` };
  const v = oneLine(raw);
  if (v.length > max) return { error: `${label} is limited to ${max} characters` };
  return { value: v };
}

// An id of something that lives elsewhere (a bid line, a PO). Not held to
// ROW_ID_RE: older bid lines and POs were minted by other code. Blank is NULL.
function readRef(raw, max, label) {
  const t = readText(raw, max, label);
  if (t.error) return t;
  return { value: t.value || null };
}

// "1,200", "$1,200.50", " 901 " and 901 all read; "12 ft" and "abc" do not —
// parseFloat would have quietly kept the 12.
function readNumber(raw, label) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  let n;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const t = normalizeNumeric(raw);
    if (t === '') return { value: null };
    if (!NUM_RE.test(t)) return { error: `${label} must be a number` };
    n = Number(t);
  } else {
    return { error: `${label} must be a number` };
  }
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  if (Math.abs(n) > MAX_QTY) return { error: `${label} is too large` };
  return { value: n };
}

// A calendar date as the date input sends it. '2026-02-30' is refused rather
// than rolled into March, and so is a year nobody means (0026 from a slipped
// keystroke).
function readDate(raw, label) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: `${label} must be a date (YYYY-MM-DD)` };
  const t = raw.trim();
  if (!t) return { value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return { error: `${label} must be a date (YYYY-MM-DD)` };
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2999 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { error: `${label} is not a real date` };
  }
  return { value: t };
}

function readDays(raw, label) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  let n;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) n = Number(raw.trim());
  else if (typeof raw === 'string' && !raw.trim()) return { value: null };
  else return { error: `${label} must be a whole number of days` };
  if (!Number.isInteger(n) || n < 0 || n > MAX_LEAD_DAYS) {
    return { error: `${label} must be a whole number of days from 0 to ${MAX_LEAD_DAYS}` };
  }
  return { value: n };
}

function readValue(spec, raw) {
  switch (spec.kind) {
    case 'text':    return readText(raw, spec.max, spec.label);
    case 'opttext': return raw === undefined || raw === null ? { value: null } : readText(raw, spec.max, spec.label);
    case 'ref':     return readRef(raw, spec.max, spec.label);
    case 'number':  return readNumber(raw, spec.label);
    case 'date':    return readDate(raw, spec.label);
    case 'days':    return readDays(raw, spec.label);
    case 'bool':
      return typeof raw === 'boolean' ? { value: raw } : { error: `${spec.label} must be true or false` };
    case 'sca':
      return SCA_STATUSES.includes(raw) ? { value: raw }
        : { error: `${spec.label} must be one of ${SCA_STATUSES.join(', ')}` };
    default:
      return { error: `${spec.label} cannot be changed` };
  }
}

/**
 * The fields of a PATCH, as { value:{ column: value } } or { error, field }.
 * Only the keys sent come back, which is what makes the save field-level:
 * a cell nobody touched is not in the UPDATE, so it keeps whatever another
 * person saved into it a moment ago.
 */
function readFields(raw) {
  if (!isPlainObject(raw)) return { error: 'fields must be an object' };
  const keys = Object.keys(raw);
  if (!keys.length) return { error: 'Nothing to change', code: 'no_fields' };
  const out = {};
  for (const k of keys) {
    if (!has(FIELDS, k)) return { error: `${k} cannot be changed here`, field: k, code: 'field_not_allowed' };
    const r = readValue(FIELDS[k], raw[k]);
    if (r.error) return { error: r.error, field: k };
    out[k] = r.value;
  }
  return { value: out };
}

function readProjectId(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: 'project_id is required', code: 'project_id_required' };
  const v = cleanStr(raw).replace(/[\u0000-\u001f\u007f]+/g, '').trim();
  if (!v) return { error: 'project_id is required', code: 'project_id_required' };
  if (v.length > MAX_PROJECT_ID) return { error: `project_id is limited to ${MAX_PROJECT_ID} characters` };
  return { value: v };
}

function readRowId(raw, what = 'id') {
  if (typeof raw !== 'string' || !ROW_ID_RE.test(raw)) {
    return { error: `${what} must be 1 to 64 letters, digits, - or _` };
  }
  return { value: raw };
}

/** Row ids from an array (a body) or a comma-separated string (?ids=), de-duped. */
function readRowIds(raw, what) {
  const parts = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',').map(s => s.trim()).filter(Boolean) : null);
  if (!parts) return { error: `${what} must be a list of ids` };
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const r = readRowId(p, what);
    if (r.error) return r;
    if (!seen.has(r.value)) { seen.add(r.value); out.push(r.value); }
  }
  if (out.length > MAX_BATCH) return { error: `Too many ${what} (max ${MAX_BATCH})`, code: 'too_many' };
  return { value: out };
}

// ── What goes back ───────────────────────────────────────────────────────
// Dates as 'YYYY-MM-DD'. The pg driver hands a DATE back as a Date at LOCAL
// midnight, so the local getters are the ones that give the stored day back;
// a driver that returns the text is passed through.
function ymd(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}
const iso = v => (v === null || v === undefined ? null : (v instanceof Date ? v.toISOString() : String(v)));
// NUMERIC comes back as text so no precision is lost on the way; the page
// works in numbers.
const num = v => (v === null || v === undefined ? null : Number(v));

function shape(r) {
  return {
    id:               r.id,
    project_id:       r.project_id,
    source:           r.source,
    bid_item_id:      r.bid_item_id ?? null,
    cost_code:        r.cost_code ?? '',
    sub_code:         r.sub_code ?? '',
    description:      r.description ?? '',
    quantity:         num(r.quantity),
    unit:             r.unit ?? '',
    bid_qty_at_send:  num(r.bid_qty_at_send),
    bid_unit_at_send: r.bid_unit_at_send ?? null,
    sca_status:       r.sca_status,
    date_needed:      ymd(r.date_needed),
    lead_time_days:   r.lead_time_days === null || r.lead_time_days === undefined ? null : Number(r.lead_time_days),
    date_ordered:     ymd(r.date_ordered),
    date_delivered:   ymd(r.date_delivered),
    vendor:           r.vendor ?? '',
    quote_number:     r.quote_number ?? '',
    contact:          r.contact ?? '',
    email:            r.email ?? '',
    po_id:            r.po_id ?? null,
    po_auto:          Boolean(r.po_auto),
    version:          Number(r.version),
    created_at:       iso(r.created_at),
    created_by:       r.created_by ?? null,
    updated_at:       iso(r.updated_at),
    updated_by:       r.updated_by ?? null,
    deleted_at:       iso(r.deleted_at),
  };
}

const isUniqueViolation = err => Boolean(err) && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
const isCheckViolation  = err => Boolean(err) && (err.code === '23514' || /violates check constraint/i.test(err.message || ''));

const fail = (res, status, error, message, extra) =>
  res.status(status).json({ ok: false, error, ...(message ? { message } : {}), ...(extra || {}) });

/**
 * Apply one set of field changes to some live rows, in one statement.
 *
 * Every column is in the SET, each behind its own "was it sent?" flag, so a
 * column that was not sent is written back as the value the row holds at
 * that instant — under the row lock, not the value some earlier read saw.
 * That is the per-field last-writer-wins the page relies on: two people
 * changing two cells of one row both keep their change.
 *
 * `projectId`, when given, pins the rows to that one job (the bulk edit).
 */
function updateRows(sql, { company, division, who }, ids, f, projectId) {
  const s = k => has(f, k);
  const v = k => (has(f, k) ? f[k] : null);
  return sql`
    UPDATE procurement_items SET
      description      = CASE WHEN ${s('description')}::boolean      THEN ${v('description')}::text      ELSE description      END,
      quantity         = CASE WHEN ${s('quantity')}::boolean         THEN ${v('quantity')}::numeric      ELSE quantity         END,
      unit             = CASE WHEN ${s('unit')}::boolean             THEN ${v('unit')}::text             ELSE unit             END,
      sca_status       = CASE WHEN ${s('sca_status')}::boolean       THEN ${v('sca_status')}::text       ELSE sca_status       END,
      date_needed      = CASE WHEN ${s('date_needed')}::boolean      THEN ${v('date_needed')}::date      ELSE date_needed      END,
      lead_time_days   = CASE WHEN ${s('lead_time_days')}::boolean   THEN ${v('lead_time_days')}::integer ELSE lead_time_days  END,
      date_ordered     = CASE WHEN ${s('date_ordered')}::boolean     THEN ${v('date_ordered')}::date     ELSE date_ordered     END,
      date_delivered   = CASE WHEN ${s('date_delivered')}::boolean   THEN ${v('date_delivered')}::date   ELSE date_delivered   END,
      vendor           = CASE WHEN ${s('vendor')}::boolean           THEN ${v('vendor')}::text           ELSE vendor           END,
      quote_number     = CASE WHEN ${s('quote_number')}::boolean     THEN ${v('quote_number')}::text     ELSE quote_number     END,
      contact          = CASE WHEN ${s('contact')}::boolean          THEN ${v('contact')}::text          ELSE contact          END,
      email            = CASE WHEN ${s('email')}::boolean            THEN ${v('email')}::text            ELSE email            END,
      po_id            = CASE WHEN ${s('po_id')}::boolean            THEN ${v('po_id')}::text            ELSE po_id            END,
      po_auto          = CASE WHEN ${s('po_auto')}::boolean          THEN ${v('po_auto')}::boolean       ELSE po_auto          END,
      cost_code        = CASE WHEN ${s('cost_code')}::boolean        THEN ${v('cost_code')}::text        ELSE cost_code        END,
      sub_code         = CASE WHEN ${s('sub_code')}::boolean         THEN ${v('sub_code')}::text         ELSE sub_code         END,
      bid_item_id      = CASE WHEN ${s('bid_item_id')}::boolean      THEN ${v('bid_item_id')}::text      ELSE bid_item_id      END,
      bid_qty_at_send  = CASE WHEN ${s('bid_qty_at_send')}::boolean  THEN ${v('bid_qty_at_send')}::numeric ELSE bid_qty_at_send END,
      bid_unit_at_send = CASE WHEN ${s('bid_unit_at_send')}::boolean THEN ${v('bid_unit_at_send')}::text ELSE bid_unit_at_send END,
      version    = version + 1,
      updated_at = NOW(),
      updated_by = ${who}
    WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
      AND id = ANY(${ids}::text[])
      AND (${projectId}::text IS NULL OR project_id = ${projectId}::text)
    RETURNING *`;
}

/** The answer to a write the database refused on a constraint, or null. */
function constraintAnswer(res, err) {
  if (isUniqueViolation(err)) {
    return fail(res, 409, 'duplicate', 'Another row is already linked to that bid line.');
  }
  if (isCheckViolation(err)) {
    const msg = err.constraint === 'procurement_items_bid_line_chk' || /bid_line_chk/.test(err.message || '')
      ? 'A row sent from the bid must stay linked to a bid line.'
      : 'That value is not allowed for this row.';
    return fail(res, 400, 'invalid', msg);
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const guard = await requireDivision(req, res, { required: true });
  if (!guard) return;
  const { payload, division } = guard;

  if (!DIVISIONS.includes(division)) {
    return fail(res, 400, 'division_not_supported', 'Procurement is not available for this division.');
  }
  if (isSalesIn(payload, division)) {
    return fail(res, 403, 'no_access', 'Procurement is not available to a sales login.');
  }

  const company  = payload.companyCode;
  const level    = levelFor(payload, division);
  const canEdit  = EDIT_LEVELS.includes(level);
  const who      = String(payload.name || payload.username || '').slice(0, 120) || null;
  const scope    = { company, division, who };
  const q        = req.query || {};
  const action   = q.action === undefined ? '' : String(q.action);
  const sql      = neon(process.env.DATABASE_URL);

  try {
    // ── GET — one job's rows ─────────────────────────────────────────────
    if (req.method === 'GET') {
      const pid = readProjectId(q.project_id);
      if (pid.error) return fail(res, 400, pid.code || 'invalid', pid.error, { field: 'project_id' });
      const withDeleted = ['1', 'true'].includes(String(q.include_deleted || ''));
      const rows = withDeleted
        ? await sql`
            SELECT * FROM procurement_items
             WHERE company_code = ${company} AND division = ${division} AND project_id = ${pid.value}
             ORDER BY created_at, id`
        : await sql`
            SELECT * FROM procurement_items
             WHERE company_code = ${company} AND division = ${division} AND project_id = ${pid.value}
               AND deleted_at IS NULL
             ORDER BY created_at, id`;
      return res.json({ ok: true, items: rows.map(shape), canEdit });
    }

    if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      return fail(res, 405, 'method_not_allowed', 'Method not allowed');
    }
    if (!canEdit) {
      return fail(res, 403, 'read_only', 'Only admin, level 3 and level 2 users can change Procurement.');
    }
    let b = req.body === undefined || req.body === null ? {} : req.body;
    // A keepalive flush can arrive as text when the content type is lost.
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (req.method !== 'DELETE' && !isPlainObject(b)) {
      return fail(res, 400, 'invalid', 'Body must be an object');
    }

    // ── POST action=send — bid lines into rows ───────────────────────────
    if (req.method === 'POST' && action === 'send') {
      const pid = readProjectId(b.project_id);
      if (pid.error) return fail(res, 400, pid.code || 'invalid', pid.error, { field: 'project_id' });
      const rawItems = b.items === undefined || b.items === null ? [] : b.items;
      if (!Array.isArray(rawItems)) return fail(res, 400, 'invalid', 'items must be a list', { field: 'items' });
      if (rawItems.length > MAX_BATCH) return fail(res, 400, 'too_many', `Too many lines to send at once (max ${MAX_BATCH})`);
      const rawRestore = b.restore_ids === undefined || b.restore_ids === null ? [] : b.restore_ids;
      if (!Array.isArray(rawRestore)) return fail(res, 400, 'invalid', 'restore_ids must be a list', { field: 'restore_ids' });
      // Each entry is a row id, or { id, bid_item_id, cost_code, sub_code }:
      // a row deleted ("skipped") before a Procore "Replace all" still names
      // the old bid line, and comes back tied to the line that replaced it —
      // a deleted row cannot be PATCHed, so the link travels with its restore.
      const restoreIds = [];
      const relink = new Map();
      for (let i = 0; i < rawRestore.length; i++) {
        const e = rawRestore[i];
        if (!isPlainObject(e)) { restoreIds.push(e); continue; }
        const id = readRowId(e.id, 'restore_ids');
        if (id.error) return fail(res, 400, 'invalid', id.error, { field: 'restore_ids', index: i });
        const to = {};
        for (const k of ['bid_item_id', 'cost_code', 'sub_code']) {
          const r = readValue(FIELDS[k], e[k]);
          if (r.error) return fail(res, 400, 'invalid', `restore_ids ${i + 1}: ${r.error}`, { field: 'restore_ids', index: i });
          to[k] = r.value;
        }
        if (!to.bid_item_id) return fail(res, 400, 'invalid', `restore_ids ${i + 1}: bid_item_id is required`, { field: 'restore_ids', index: i });
        restoreIds.push(id.value);
        relink.set(id.value, to);
      }
      const restore = readRowIds(restoreIds, 'restore_ids');
      if (restore.error) return fail(res, 400, restore.code || 'invalid', restore.error, { field: 'restore_ids' });

      // Each line read strictly; one bad line refuses the send, so nobody is
      // left guessing which of 300 lines went in.
      const lines = [];
      const ids = new Set();
      const bidSeen = new Set();
      for (let i = 0; i < rawItems.length; i++) {
        const it = rawItems[i];
        const at = `Line ${i + 1}: `;
        if (!isPlainObject(it)) return fail(res, 400, 'invalid', `${at}must be an object`, { index: i });
        const id = readRowId(it.id);
        if (id.error) return fail(res, 400, 'invalid', at + id.error, { index: i, field: 'id' });
        if (ids.has(id.value)) return fail(res, 400, 'invalid', `${at}id ${id.value} is used twice`, { index: i, field: 'id' });
        ids.add(id.value);
        const line = { id: id.value };
        for (const k of ['bid_item_id', 'cost_code', 'sub_code', 'quantity', 'unit']) {
          const r = readValue(FIELDS[k], it[k]);
          if (r.error) return fail(res, 400, 'invalid', at + r.error, { index: i, field: k });
          line[k] = r.value;
        }
        if (!line.bid_item_id) return fail(res, 400, 'invalid', `${at}bid_item_id is required`, { index: i, field: 'bid_item_id' });
        // The same bid line twice in one send is one row; the second counts
        // as skipped, the way a line already on the sheet does.
        if (bidSeen.has(line.bid_item_id)) continue;
        bidSeen.add(line.bid_item_id);
        lines.push(line);
      }

      // "Removed earlier" lines the user ticked again: the same row comes
      // back, with everything that was typed on it before it was deleted —
      // and, when the entry said so, tied to its bid line's new id.
      const rl = id => relink.get(id) || {};
      let restored = [];
      if (restore.value.length) {
        try {
          restored = await sql`
            UPDATE procurement_items p
               SET deleted_at = NULL, deleted_by = NULL, version = p.version + 1, updated_at = NOW(), updated_by = ${who},
                   bid_item_id = COALESCE(t.bid_item_id, p.bid_item_id),
                   cost_code   = CASE WHEN t.bid_item_id IS NULL THEN p.cost_code ELSE t.cost_code END,
                   sub_code    = CASE WHEN t.bid_item_id IS NULL THEN p.sub_code  ELSE t.sub_code  END
              FROM unnest(${restore.value}::text[], ${restore.value.map(id => rl(id).bid_item_id ?? null)}::text[],
                          ${restore.value.map(id => rl(id).cost_code ?? '')}::text[], ${restore.value.map(id => rl(id).sub_code ?? '')}::text[])
                   AS t(id, bid_item_id, cost_code, sub_code)
             WHERE p.company_code = ${company} AND p.division = ${division} AND p.project_id = ${pid.value}
               AND p.id = t.id AND p.deleted_at IS NOT NULL
             RETURNING p.*`;
        } catch (err) {
          // The new line already has a bid row (a colleague sent it a moment
          // ago): nothing is restored or sent, and the checklist read again
          // will show that line as already added.
          if (constraintAnswer(res, err)) return;
          throw err;
        }
      }

      // ON CONFLICT DO NOTHING with no target: the bid-line unique index is
      // what stops a second row for a line already on the sheet — live, or
      // deleted ("skipped") — whether the duplicate comes from a double
      // click, a retry with the same ids, or a colleague sending the same job
      // at the same moment (the second insert waits for the first to commit,
      // then does nothing). A retried request reuses its row ids, so a
      // primary-key clash is answered the same way rather than as an error.
      // created_at is clock_timestamp() so the rows keep the bid's order.
      const created = lines.length ? await sql`
        INSERT INTO procurement_items
          (id, company_code, division, project_id, source, bid_item_id, cost_code, sub_code,
           quantity, unit, bid_qty_at_send, bid_unit_at_send, created_at, created_by, updated_at, updated_by)
        SELECT t.id, ${company}, ${division}, ${pid.value}, 'bid', t.bid_item_id, t.cost_code, t.sub_code,
               t.quantity, t.unit, t.quantity, t.unit, clock_timestamp(), ${who}, clock_timestamp(), ${who}
          FROM unnest(${lines.map(l => l.id)}::text[], ${lines.map(l => l.bid_item_id)}::text[],
                      ${lines.map(l => l.cost_code)}::text[], ${lines.map(l => l.sub_code)}::text[],
                      ${lines.map(l => l.quantity)}::numeric[], ${lines.map(l => l.unit)}::text[])
               WITH ORDINALITY AS t(id, bid_item_id, cost_code, sub_code, quantity, unit, ord)
         ORDER BY t.ord
        ON CONFLICT DO NOTHING
        RETURNING *` : [];

      return res.json({
        ok: true,
        created:  created.map(shape),
        restored: restored.map(shape),
        skipped:  rawItems.length - created.length,
      });
    }

    // ── POST — one row added by hand ─────────────────────────────────────
    if (req.method === 'POST') {
      if (action) return fail(res, 400, 'invalid', `Unknown action "${action.slice(0, 40)}"`);
      const it = b.item;
      if (!isPlainObject(it)) return fail(res, 400, 'invalid', 'item must be an object', { field: 'item' });
      const id = readRowId(it.id);
      if (id.error) return fail(res, 400, 'invalid', id.error, { field: 'id' });
      const pid = readProjectId(it.project_id);
      if (pid.error) return fail(res, 400, pid.code || 'invalid', pid.error, { field: 'project_id' });
      // Every editable field the body carries, each read the PATCH way. What
      // it does not carry starts blank; source, version and the audit
      // columns in a copied row object are ignored, not trusted.
      const v = {};
      for (const k of Object.keys(FIELDS)) {
        if (!has(it, k)) continue;
        if (k === 'sca_status' && (it[k] === null || it[k] === '')) continue;
        const r = readValue(FIELDS[k], it[k]);
        if (r.error) return fail(res, 400, 'invalid', r.error, { field: k });
        v[k] = r.value;
      }
      const d = (k, dflt) => (has(v, k) ? v[k] : dflt);
      try {
        const rows = await sql`
          INSERT INTO procurement_items
            (id, company_code, division, project_id, source, bid_item_id, cost_code, sub_code, description,
             quantity, unit, bid_qty_at_send, bid_unit_at_send, sca_status, date_needed, lead_time_days,
             date_ordered, date_delivered, vendor, quote_number, contact, email, po_id, po_auto,
             created_by, updated_by)
          VALUES
            (${id.value}, ${company}, ${division}, ${pid.value}, 'manual', ${d('bid_item_id', null)},
             ${d('cost_code', '')}, ${d('sub_code', '')}, ${d('description', '')},
             ${d('quantity', null)}::numeric, ${d('unit', '')}, ${d('bid_qty_at_send', null)}::numeric,
             ${d('bid_unit_at_send', null)}, ${d('sca_status', 'Pending')}, ${d('date_needed', null)}::date,
             ${d('lead_time_days', null)}::integer, ${d('date_ordered', null)}::date, ${d('date_delivered', null)}::date,
             ${d('vendor', '')}, ${d('quote_number', '')}, ${d('contact', '')}, ${d('email', '')},
             ${d('po_id', null)}, ${d('po_auto', true)}::boolean, ${who}, ${who})
          RETURNING *`;
        return res.status(201).json({ ok: true, item: shape(rows[0]) });
      } catch (err) {
        if (isUniqueViolation(err)) return fail(res, 409, 'duplicate', 'A row with that id already exists.');
        throw err;
      }
    }

    // ── PATCH action=bulk — one change to many rows of one job ───────────
    if (req.method === 'PATCH' && action === 'bulk') {
      const ids = readRowIds(b.ids, 'ids');
      if (ids.error) return fail(res, 400, ids.code || 'invalid', ids.error, { field: 'ids' });
      if (!ids.value.length) return fail(res, 400, 'invalid', 'Pick at least one row', { field: 'ids' });
      const f = readFields(b.fields);
      if (f.error) return fail(res, 400, f.code || 'invalid', f.error, f.field ? { field: f.field } : undefined);
      let pinned = null;
      if (b.project_id !== undefined && b.project_id !== null) {
        const p = readProjectId(b.project_id);
        if (p.error) return fail(res, 400, p.code || 'invalid', p.error, { field: 'project_id' });
        pinned = p.value;
      }
      // One job per bulk edit. A selection that somehow spans two jobs is
      // refused outright rather than half-applied, and the UPDATE pins the
      // job again so nothing between this read and that write can widen it.
      const found = await sql`
        SELECT DISTINCT project_id FROM procurement_items
         WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
           AND id = ANY(${ids.value}::text[])`;
      const projects = found.map(r => r.project_id);
      if (projects.length > 1 || (pinned && projects.length === 1 && projects[0] !== pinned)) {
        return fail(res, 400, 'mixed_projects', 'A bulk edit works on the rows of one job at a time.');
      }
      if (!projects.length) return fail(res, 404, 'not_found', 'None of those rows exist any more.');
      let rows;
      try {
        rows = await updateRows(sql, scope, ids.value, f.value, projects[0]);
      } catch (err) {
        if (constraintAnswer(res, err)) return;
        throw err;
      }
      const got = new Set(rows.map(r => r.id));
      return res.json({ ok: true, items: rows.map(shape), missing: ids.value.filter(id => !got.has(id)) });
    }

    // ── PATCH — the cells of one row that changed ────────────────────────
    if (req.method === 'PATCH') {
      if (action) return fail(res, 400, 'invalid', `Unknown action "${action.slice(0, 40)}"`);
      const id = readRowId(q.id);
      if (id.error) return fail(res, 400, q.id === undefined ? 'id_required' : 'invalid', id.error, { field: 'id' });
      const f = readFields(b.fields);
      if (f.error) return fail(res, 400, f.code || 'invalid', f.error, f.field ? { field: f.field } : undefined);
      let rows;
      try {
        rows = await updateRows(sql, scope, [id.value], f.value, null);
      } catch (err) {
        if (constraintAnswer(res, err)) return;
        throw err;
      }
      if (!rows[0]) return fail(res, 404, 'not_found', 'That row does not exist any more.');
      return res.json({ ok: true, item: shape(rows[0]) });
    }

    // ── DELETE — out of the sheet (soft) ─────────────────────────────────
    if (action) return fail(res, 400, 'invalid', `Unknown action "${action.slice(0, 40)}"`);
    const given = ['id', 'ids', 'project_id'].filter(k => q[k] !== undefined && q[k] !== '');
    if (given.length !== 1) {
      return fail(res, 400, 'id_required', 'Say which rows to delete: id, ids or project_id (one of them).');
    }

    // A whole job's rows: only when the job itself is deleted, so it takes
    // what deleting a job takes.
    if (given[0] === 'project_id') {
      if (!PROJECT_DELETE_LEVELS.includes(level)) {
        return fail(res, 403, 'level3_required', 'Only admin and level 3 users can delete a whole job\'s Procurement rows.');
      }
      const pid = readProjectId(q.project_id);
      if (pid.error) return fail(res, 400, pid.code || 'invalid', pid.error, { field: 'project_id' });
      const rows = await sql`
        UPDATE procurement_items
           SET deleted_at = NOW(), deleted_by = ${who}, version = version + 1, updated_at = NOW(), updated_by = ${who}
         WHERE company_code = ${company} AND division = ${division} AND project_id = ${pid.value} AND deleted_at IS NULL
         RETURNING id`;
      return res.json({ ok: true, deleted: rows.length });
    }

    const single = given[0] === 'id';
    // ?ids=a,b,c — or ?ids=a&ids=b, which arrives as a list.
    const ids = single ? readRowIds([q.id], 'id') : readRowIds(Array.isArray(q.ids) ? q.ids.join(',') : q.ids, 'ids');
    if (ids.error) return fail(res, 400, ids.code || 'invalid', ids.error);
    if (!ids.value.length) return fail(res, 400, 'id_required', 'Say which rows to delete.');
    const rows = await sql`
      UPDATE procurement_items
         SET deleted_at = NOW(), deleted_by = ${who}, version = version + 1, updated_at = NOW(), updated_by = ${who}
       WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         AND id = ANY(${ids.value}::text[])
       RETURNING id`;
    if (single && !rows.length) return fail(res, 404, 'not_found', 'That row does not exist any more.');
    return res.json({ ok: true, deleted: rows.length });
  } catch (err) {
    console.error('[procurement] error:', err.message);
    return fail(res, 500, 'database_error', 'Database error');
  }
};

// For the tests: the readers, without a request around them.
module.exports._test = { readFields, readNumber, readDate, readDays, readText, readRowIds, shape, ymd, FIELDS };
