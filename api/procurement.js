'use strict';

// /api/procurement — the Procurement tab: a job's material buy-out sheet.
//
// A PM keeps, per job, a line for every material he has to buy: when it is
// needed on site, how long the supplier takes, which vendor and quote, which
// PO, and whether it has been ordered and delivered. That used to be an Excel
// sheet per job; this is it as rows (procurement_items, neon-schema.sql
// PROCUREMENT). Cost Code and Sub Code are the bid's own codes — what the
// cost books to — and Description is the Material on the sheet: what is
// bought, in the job's own words ("20/40 Mesh rubber crumb infill" under the
// bid's "Infill Crumb Rubber"), blank meaning "the sub code's name". One bid
// line can be bought as many materials, each its own row.
//
// A row comes from one of two places. Send to Procurement (action=send) turns
// bid lines into rows with source 'bid'; "+ Add Row" and "+ Material" add
// source 'manual' rows by hand. Both are edited the same way.
//
// GET    ?division=…&project_id=X[&include_deleted=1]
//          → { ok, items:[…], canEdit }   live rows, or every row with its
//            deleted_at when include_deleted=1 (Send to Procurement needs the
//            deleted ones to offer "removed earlier"). Ordered created_at, id.
// GET    ?division=…&action=materials
//          → { ok, materials:[{ material, sub_code, cost_code, unit, vendor,
//            jobs, last_used }], canEdit }   every Material (description)
//            named on the division's live rows, once per sub code it was
//            bought under — the Material picker's suggestions on the next job
//            (materialLibrary below). Same readers as the rows.
// GET    ?division=…&action=breakdowns&sub_code=…[&cost_code=…][&exclude_project=X]
//          → { ok, breakdowns:[{ project_id, last_used, items:[{ id, source,
//            material, cost_code, sub_code, quantity, unit, vendor }] }] }
//            what one sub code was bought as on each job (most recent first)
//            — the list "+ Material" offers to copy (materialBreakdowns).
// POST   ?division=…&action=add  { project_id, items:[{ id, bid_item_id, cost_code,
//            sub_code, description, quantity, unit, vendor }] }
//          → 201 { ok, created:[…], existing:[…], skipped:n }   several manual
//            rows in one statement; an id already on the job is `existing`
//            (a retry), and a bid line not on the stored bid is 409 stale_bid.
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
// A row is tied to a bid line (bid_item_id) only while that line is on the
// job's bid as the server holds it NOW (the job's blob in app_data). A PATCH
// that sets bid_item_id checks it in the same statement, and a send checks
// every line it ties a row to; a line that is not there is 409 stale_bid and
// nothing is written. The page's copy of the bid can be behind — a
// colleague's Procore "Replace all" landing between its check and its write
// — and would otherwise move rows back onto the lines just replaced. A job
// with no blob at all (nothing to check against) is not refused.
//
// Files attached to a line live in the Job Document Vault (api/documents.js),
// filed in the folder for the line's cost code as well as the one picked. A
// write here that changes a line's code moves its files to the new code's
// folder (refileAfter below); that never changes the answer to the write.
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
// Called through the module (procDocs.x, never a destructured copy) so the
// tests can stand a failing re-file in for the real one.
const procDocs = require('./lib/procurement-docs');

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

// ── The material library ─────────────────────────────────────────────────
// The rows read for it (the most recently written first) and the most names
// sent back. A division's whole history is a few thousand named rows; past
// this the oldest names drop off first.
const MATERIALS_SCAN = 20000;
const MATERIALS_MAX  = 1500;

/**
 * Every Material named on the division's live rows, once per sub code it
 * was bought under: "Infill Crumb Rubber" → "20/40 Mesh rubber crumb infill",
 * by the LBS, from Willig Tire, on 3 jobs. The page offers these in the
 * Material picker, the row's own sub code's first, so a name one job worked
 * out is there for the next without anyone keeping a list.
 *
 * `rows` must come newest first: the spelling, unit and vendor kept for a
 * name are its most recent ones (a vendor or unit left blank is skipped for
 * an older one that has it). Names and codes compare the way the sheet
 * compares codes (procDocs.codeKey: case, spacing, dashes, quotes). A name
 * that is just its sub code again says nothing and is left out. Sorted by
 * the number of jobs, then most recently used.
 */
function materialLibrary(rows) {
  const k = procDocs.codeKey;
  const byKey = new Map();
  for (const r of rows || []) {
    const material = oneLine(r.description || '');
    if (!material) continue;
    const sub = oneLine(r.sub_code || '');
    if (k(material) === k(sub)) continue;
    const key = k(sub) + '\u0000' + k(material);
    let e = byKey.get(key);
    if (!e) {
      e = { material, sub_code: sub, cost_code: oneLine(r.cost_code || ''), unit: '', vendor: '', jobs: new Set(), last_used: iso(r.updated_at) };
      byKey.set(key, e);
    }
    if (!e.unit) e.unit = oneLine(r.unit || '');
    if (!e.vendor) e.vendor = oneLine(r.vendor || '');
    e.jobs.add(String(r.project_id));
  }
  return [...byKey.values()]
    .map(e => ({ ...e, jobs: e.jobs.size }))
    .sort((a, b) => b.jobs - a.jobs || String(b.last_used || '').localeCompare(String(a.last_used || '')) || a.material.localeCompare(b.material))
    .slice(0, MATERIALS_MAX);
}

// ── A bid line's material list on other jobs ─────────────────────────────
// The jobs offered, and the materials of each, at most: a line is a few
// dozen parts at the very most; past this the list is a paste gone wrong.
const BREAKDOWN_JOBS  = 8;
const BREAKDOWN_ITEMS = 100;

/**
 * What one sub code was bought as, job by job: on Hempfield Baseball the
 * bid's "Detention System" was Geofabric (Collector), Perimeter Collector
 * Drain 12" Perf, #57 Aggregate… — the list "+ Material" offers to copy onto
 * the same line of another job. Each job's named rows under the code (held
 * to the sheet's comparison, procDocs.codeKey), in the order they were
 * added; a name that is just the sub code again is no material of its own.
 * With a cost code, only rows under that cost code too (the same sub code
 * under another cost code is another bid line). Jobs most recently worked
 * on first. `rows` come ordered by job, then age.
 */
function materialBreakdowns(rows, subCode, costCode) {
  const k = procDocs.codeKey;
  const want = k(subCode);
  const cost = k(costCode || '');
  const byJob = new Map();
  for (const r of rows || []) {
    if (k(r.sub_code || '') !== want) continue;
    if (cost && k(r.cost_code || '') !== cost) continue;
    const material = oneLine(r.description || '');
    if (!material || k(material) === want) continue;
    let j = byJob.get(r.project_id);
    if (!j) { j = { project_id: r.project_id, last_used: null, items: [], seen: new Set() }; byJob.set(r.project_id, j); }
    const used = iso(r.updated_at);
    if (!j.last_used || String(used) > String(j.last_used)) j.last_used = used;
    // The same name twice on one job (a delivery split in two) is one line
    // of its list.
    if (j.seen.has(k(material)) || j.items.length >= BREAKDOWN_ITEMS) continue;
    j.seen.add(k(material));
    j.items.push({
      id: r.id, source: r.source === 'bid' ? 'bid' : 'manual', material,
      cost_code: oneLine(r.cost_code || ''), sub_code: oneLine(r.sub_code || ''),
      quantity: num(r.quantity), unit: oneLine(r.unit || ''), vendor: oneLine(r.vendor || ''),
    });
  }
  return [...byJob.values()]
    .map(({ seen, ...j }) => j)
    .sort((a, b) => String(b.last_used || '').localeCompare(String(a.last_used || '')) || String(a.project_id).localeCompare(String(b.project_id)))
    .slice(0, BREAKDOWN_JOBS);
}

// The cells a copied material may carry (POST action=add). The rest of a
// row — dates, PO, agreement — is this job's own and starts blank.
const ADD_FIELDS = ['bid_item_id', 'cost_code', 'sub_code', 'description', 'quantity', 'unit', 'vendor'];

const isUniqueViolation = err => Boolean(err) && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
const isCheckViolation  = err => Boolean(err) && (err.code === '23514' || /violates check constraint/i.test(err.message || ''));

const fail = (res, status, error, message, extra) =>
  res.status(status).json({ ok: false, error, ...(message ? { message } : {}), ...(extra || {}) });

// Where each division keeps a job's blob, the bid (bidItems) included — the
// keys api/bid-items.js and the pages write. The map lives in
// api/lib/procurement-docs.js, which reads a line's live cost code from the
// same blob to file its attachments, so the two can never disagree on a key.
const { PROJECT_KEY_PREFIX } = procDocs;
const bidKeyPrefix = (company, division) => `${company}:${PROJECT_KEY_PREFIX[division]}`;
// No closing stop: the page puts it inside a sentence of its own.
const STALE_BID = 'that bid line is no longer on the job\'s bid — the bid was changed somewhere else since this page read it; '
  + 'reload the page to see the current bid';

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
 *
 * A change that ties the rows to a bid line (bid_item_id) only lands while
 * that line is on the job's stored bid; otherwise no row comes back, and the
 * caller tells that apart from a missing row (staleBid below).
 */
function updateRows(sql, { company, division, who }, ids, f, projectId) {
  const s = k => has(f, k);
  const v = k => (has(f, k) ? f[k] : null);
  // The bid line the rows are being tied to, when they are: checked below.
  const toLine = v('bid_item_id');
  const keyPrefix = bidKeyPrefix(company, division);
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
      -- A bid line is taken only while it is on the job's bid as stored now,
      -- read in this same statement (see the note at the top).
      AND (${toLine}::text IS NULL
        OR NOT EXISTS (SELECT 1 FROM app_data a WHERE a.key = ${keyPrefix}::text || procurement_items.project_id)
        OR EXISTS (
          SELECT 1 FROM app_data a
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(a.value->'bidItems') = 'array' THEN a.value->'bidItems' ELSE '[]'::jsonb END) e
           WHERE a.key = ${keyPrefix}::text || procurement_items.project_id AND e->>'id' = ${toLine}::text))
    RETURNING *`;
}

/**
 * Whether a write that ties rows to a bid line matched nothing because the
 * line is not on the bid (rather than because the rows are gone): some of
 * the rows are still there, live.
 */
async function staleBid(sql, { company, division }, ids, f) {
  if (!has(f, 'bid_item_id') || f.bid_item_id == null) return false;
  const live = await sql`
    SELECT 1 FROM procurement_items
     WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
       AND id = ANY(${ids}::text[])
     LIMIT 1`;
  return live.length > 0;
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

// ── A line's attachments follow its cost code ───────────────────────────
// A file attached to a procurement line is filed in the Job Document Vault
// twice over: in the folder the person picked, and in the folder for the
// line's cost code, which is how a cost-code folder compiles every
// attachment of its section (api/lib/procurement-docs.js). A write that
// changes the line's code — a hand-added line re-coded by picking another
// Sub Code, the page bringing a stale stored code into line with a renamed
// bid line, a deleted line restored onto a new bid line — moves its files to
// the new code's folder. Only writes that carry cost_code or bid_item_id pay
// for this, and of those only lines with something attached pay more than
// one read.
const touchesCode = f => has(f, 'cost_code') || has(f, 'bid_item_id');

/**
 * The stored codes of the given rows that have files attached, read just
 * before a write that may change them, or null. Never throws: a failed read
 * means the files stay where they are, not that the save is refused.
 */
async function codesBefore(sql, { company, division }, ids) {
  try {
    return await procDocs.snapshotStoredCodes(sql, { companyCode: company, division, rowIds: ids });
  } catch (err) {
    console.warn(`[procurement] reading codes before a re-file failed: ${err.message}`);
    return null;
  }
}

/**
 * After the write: every row whose live code now differs from the code it
 * stored before (ignoring case and the spaces around it) has its files moved
 * from the old code's folder to the new one's. The comparison is old STORED
 * code against new LIVE code because the stored copy is what lags: a bid line
 * renamed on the bid page changes the live code straight away, and the save
 * that brings the copy up to date is the moment the files can follow.
 *
 * Never throws and never changes the answer to the write that triggered it —
 * that write has landed whatever happens here.
 */
async function refileAfter(sql, { company, division, who }, payload, before, rows) {
  try {
    if (!before || !before.size || !Array.isArray(rows) || !rows.length) return;
    const written = rows.filter(r => r && before.has(r.id));
    if (!written.length) return;
    const live = await procDocs.liveCostCodes(sql, { companyCode: company, division, rowIds: written.map(r => r.id) });
    const changes = [];
    for (const r of written) {
      const now = live.get(r.id);
      if (!now) continue;
      const fromCode = before.get(r.id);
      if (procDocs.codeKey(fromCode) === procDocs.codeKey(now.code)) continue;
      changes.push({ rowId: r.id, projectId: r.project_id, fromCode, toCode: now.rawCode });
    }
    if (!changes.length) return;
    await procDocs.refileProcurementDocs(sql, {
      companyCode: company, division, changes,
      // The document trail records people the way api/documents.js does.
      username: (payload && payload.username) || who || null,
      userId: (payload && payload.userId) || null,
    });
  } catch (err) {
    console.warn(`[procurement] re-filing attachments after a code change failed: ${err.message}`);
  }
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
    // ── GET action=materials — the names bought under each sub code ──────
    if (req.method === 'GET' && action === 'materials') {
      const rows = await sql`
        SELECT project_id, cost_code, sub_code, description, unit, vendor, updated_at
          FROM procurement_items
         WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
           AND btrim(description) <> ''
         ORDER BY updated_at DESC, id
         LIMIT ${MATERIALS_SCAN}`;
      return res.json({ ok: true, materials: materialLibrary(rows), canEdit });
    }
    // ── GET action=breakdowns — what one sub code was bought as, job by job
    if (req.method === 'GET' && action === 'breakdowns') {
      const sub = readText(q.sub_code, 200, 'sub_code');
      if (sub.error) return fail(res, 400, 'invalid', sub.error, { field: 'sub_code' });
      if (!procDocs.codeKey(sub.value)) return fail(res, 400, 'invalid', 'sub_code is required', { field: 'sub_code' });
      let exclude = null;
      if (q.exclude_project !== undefined && q.exclude_project !== '') {
        const ex = readProjectId(q.exclude_project);
        if (ex.error) return fail(res, 400, 'invalid', ex.error, { field: 'exclude_project' });
        exclude = ex.value;
      }
      // The line's cost code, when given: one sub code can sit under two
      // cost codes (Geofabric under Stormwater and under Base), and those
      // are two bid lines with lists of their own.
      const cost = readText(q.cost_code, 200, 'cost_code');
      if (cost.error) return fail(res, 400, 'invalid', cost.error, { field: 'cost_code' });
      // Narrowed in SQL by the code's letters and digits, then held to the
      // sheet's own comparison (procDocs.codeKey) here.
      const rows = await sql`
        SELECT id, project_id, source, cost_code, sub_code, description, quantity, unit, vendor, created_at, updated_at
          FROM procurement_items
         WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
           AND btrim(description) <> ''
           AND lower(regexp_replace(sub_code, '[^[:alnum:]]+', '', 'g')) = lower(regexp_replace(${sub.value}::text, '[^[:alnum:]]+', '', 'g'))
           AND (${exclude}::text IS NULL OR project_id <> ${exclude}::text)
         ORDER BY project_id, created_at, id
         LIMIT ${MATERIALS_SCAN}`;
      return res.json({ ok: true, breakdowns: materialBreakdowns(rows, sub.value, cost.value), canEdit });
    }
    if (req.method === 'GET' && action) return fail(res, 400, 'invalid', `Unknown action "${action.slice(0, 40)}"`);

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

      // Every line a row is to be tied to has to be on the job's bid as the
      // server holds it: the checklist was drawn from the page's copy, and a
      // colleague's Procore "Replace all" since would otherwise get rows tied
      // to lines that no longer exist (or rows moved back onto them). A
      // restore that keeps its row's line is checked by that line.
      if (restore.value.length || lines.length) {
        const blob = await sql`SELECT value->'bidItems' AS items FROM app_data WHERE key = ${bidKeyPrefix(company, division) + pid.value}`;
        if (blob.length) {
          const items = Array.isArray(blob[0].items) ? blob[0].items : [];
          const onBid = new Set(items.filter(e => e && e.id != null).map(e => String(e.id)));
          const plain = restore.value.filter(id => !relink.has(id));
          const kept = plain.length ? await sql`
            SELECT bid_item_id FROM procurement_items
             WHERE company_code = ${company} AND division = ${division} AND project_id = ${pid.value}
               AND id = ANY(${plain}::text[]) AND deleted_at IS NOT NULL AND bid_item_id IS NOT NULL` : [];
          const wanted = lines.map(l => l.bid_item_id)
            .concat([...relink.values()].map(v => v.bid_item_id), kept.map(r => r.bid_item_id));
          const off = [...new Set(wanted.filter(id => !onBid.has(String(id))))];
          if (off.length) {
            return fail(res, 409, 'stale_bid',
              'The bid for this job was changed somewhere else since this list was drawn, so nothing was sent. '
              + 'Reload the page, then Send to Procurement again.', { lines: off });
          }
        }
      }

      // ONE statement, so the send happens whole or not at all: "removed
      // earlier" lines the user ticked again come back, and the new lines go
      // in, together. Two statements left a send whose insert failed half
      // done — the restore kept, the page told "Not sent".
      //
      // Restored: the same row comes back, with everything that was typed on
      // it before it was deleted — and, when the entry said so, tied to its
      // bid line's new id.
      //
      // Inserted: ON CONFLICT DO NOTHING with no target: the bid-line unique
      // index is what stops a second row for a line already on the sheet —
      // live, or deleted ("skipped") — whether the duplicate comes from a
      // double click, a retry with the same ids, or a colleague sending the
      // same job at the same moment (the second insert waits for the first to
      // commit, then does nothing). A retried request reuses its row ids, so a
      // primary-key clash is answered the same way rather than as an error.
      // created_at is clock_timestamp() so the rows keep the bid's order.
      const rl = id => relink.get(id) || {};
      // Only a re-tied restore can change a row's code; a plain restore and a
      // new line cannot have moved any file.
      const codesWas = relink.size ? await codesBefore(sql, scope, [...relink.keys()]) : null;
      let out = [];
      if (restore.value.length || lines.length) {
        try {
          out = await sql`
            WITH restored AS (
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
               RETURNING p.*
            ), created AS (
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
              RETURNING *
            )
            SELECT 'restored' AS send_kind, r.* FROM restored r
            UNION ALL
            SELECT 'created' AS send_kind, c.* FROM created c`;
        } catch (err) {
          // A line a restore was to be tied to already has a bid row (a
          // colleague sent it a moment ago): nothing at all went in. Said by
          // name, so the PM knows which line, and the page reads its
          // checklist again.
          if (isUniqueViolation(err)) {
            const wanted = [...new Set([...relink.values()].map(v => v.bid_item_id).filter(Boolean))];
            let held = [];
            try {
              held = wanted.length ? await sql`
                SELECT DISTINCT bid_item_id, cost_code, sub_code FROM procurement_items
                 WHERE company_code = ${company} AND division = ${division} AND project_id = ${pid.value}
                   AND source = 'bid' AND bid_item_id = ANY(${wanted}::text[]) AND NOT (id = ANY(${restore.value}::text[]))` : [];
            } catch { held = []; }
            const names = held.map(h => [h.cost_code, h.sub_code].filter(Boolean).join(' / ') || h.bid_item_id);
            return fail(res, 409, 'duplicate', names.length
              ? `Another row is already linked to the bid line${names.length === 1 ? '' : 's'} ${names.map(n => `"${n}"`).join(', ')} — someone may have sent ${names.length === 1 ? 'it' : 'them'} a moment ago — so nothing was sent.`
              : 'Another row is already linked to one of those bid lines, so nothing was sent.',
              { lines: held.map(h => h.bid_item_id) });
          }
          if (constraintAnswer(res, err)) return;
          throw err;
        }
      }
      // The RETURNING order of each half: the inserted rows in send order.
      const restored = out.filter(r => r.send_kind === 'restored');
      const created  = out.filter(r => r.send_kind === 'created');
      await refileAfter(sql, scope, payload, codesWas, restored);

      return res.json({
        ok: true,
        created:  created.map(shape),
        restored: restored.map(shape),
        skipped:  rawItems.length - created.length,
      });
    }

    // ── POST action=add — several materials added by hand at once ───────
    // "+ Material" copying a line's material list from another job: every
    // material a row of its own (source 'manual'), in one statement, so the
    // list goes in whole or not at all. Retried with the same ids (an answer
    // lost on the way back), each row goes in once: an id already on this
    // job comes back under `existing`, not as an error.
    if (req.method === 'POST' && action === 'add') {
      const pid = readProjectId(b.project_id);
      if (pid.error) return fail(res, 400, pid.code || 'invalid', pid.error, { field: 'project_id' });
      if (!Array.isArray(b.items) || !b.items.length) return fail(res, 400, 'invalid', 'items must be a list of rows', { field: 'items' });
      if (b.items.length > MAX_BATCH) return fail(res, 400, 'too_many', `Too many rows to add at once (max ${MAX_BATCH})`);
      const rows = [];
      const ids = new Set();
      for (let i = 0; i < b.items.length; i++) {
        const it = b.items[i];
        const at = `Row ${i + 1}: `;
        if (!isPlainObject(it)) return fail(res, 400, 'invalid', `${at}must be an object`, { index: i });
        const id = readRowId(it.id);
        if (id.error) return fail(res, 400, 'invalid', at + id.error, { index: i, field: 'id' });
        if (ids.has(id.value)) return fail(res, 400, 'invalid', `${at}id ${id.value} is used twice`, { index: i, field: 'id' });
        ids.add(id.value);
        const row = { id: id.value };
        for (const k of ADD_FIELDS) {
          const r = readValue(FIELDS[k], has(it, k) ? it[k] : null);
          if (r.error) return fail(res, 400, 'invalid', at + r.error, { index: i, field: k });
          row[k] = r.value;
        }
        rows.push(row);
      }
      // A row tied to a bid line is tied only to a line on the job's bid as
      // stored now, as everywhere else (see the note at the top).
      const lines = [...new Set(rows.map(r => r.bid_item_id).filter(Boolean))];
      if (lines.length) {
        const blob = await sql`SELECT value->'bidItems' AS items FROM app_data WHERE key = ${bidKeyPrefix(company, division) + pid.value}`;
        if (blob.length) {
          const items = Array.isArray(blob[0].items) ? blob[0].items : [];
          const onBid = new Set(items.filter(e => e && e.id != null).map(e => String(e.id)));
          const off = lines.filter(id => !onBid.has(String(id)));
          if (off.length) return fail(res, 409, 'stale_bid', `Not added: ${STALE_BID}.`, { lines: off, field: 'bid_item_id' });
        }
      }
      const col = k => rows.map(r => r[k]);
      // created_at is clock_timestamp() so the rows keep the list's order.
      const created = await sql`
        INSERT INTO procurement_items
          (id, company_code, division, project_id, source, bid_item_id, cost_code, sub_code, description,
           quantity, unit, vendor, created_at, created_by, updated_at, updated_by)
        SELECT t.id, ${company}, ${division}, ${pid.value}, 'manual', t.bid_item_id, t.cost_code, t.sub_code, t.description,
               t.quantity, t.unit, t.vendor, clock_timestamp(), ${who}, clock_timestamp(), ${who}
          FROM unnest(${col('id')}::text[], ${col('bid_item_id')}::text[], ${col('cost_code')}::text[], ${col('sub_code')}::text[],
                      ${col('description')}::text[], ${col('quantity')}::numeric[], ${col('unit')}::text[], ${col('vendor')}::text[])
               WITH ORDINALITY AS t(id, bid_item_id, cost_code, sub_code, description, quantity, unit, vendor, ord)
         ORDER BY t.ord
        ON CONFLICT (id) DO NOTHING
        RETURNING *`;
      const made = new Set(created.map(r => r.id));
      const rest = [...ids].filter(id => !made.has(id));
      // The ids that were there already: this job's own rows come back (the
      // first try landed); anything else is not this request's to show.
      const existing = rest.length ? await sql`
        SELECT * FROM procurement_items
         WHERE company_code = ${company} AND division = ${division} AND project_id = ${pid.value}
           AND id = ANY(${rest}::text[]) AND deleted_at IS NULL` : [];
      const order = new Map([...ids].map((id, i) => [id, i]));
      const byOrder = (a, c) => order.get(a.id) - order.get(c.id);
      return res.status(created.length ? 201 : 200).json({
        ok: true,
        created: created.slice().sort(byOrder).map(shape),
        existing: existing.slice().sort(byOrder).map(shape),
        skipped: rest.length - existing.length,
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
      const codesWas = touchesCode(f.value) ? await codesBefore(sql, scope, ids.value) : null;
      let rows;
      try {
        rows = await updateRows(sql, scope, ids.value, f.value, projects[0]);
      } catch (err) {
        if (constraintAnswer(res, err)) return;
        throw err;
      }
      if (!rows.length && await staleBid(sql, scope, ids.value, f.value)) {
        return fail(res, 409, 'stale_bid', STALE_BID, { field: 'bid_item_id' });
      }
      await refileAfter(sql, scope, payload, codesWas, rows);
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
      const codesWas = touchesCode(f.value) ? await codesBefore(sql, scope, [id.value]) : null;
      let rows;
      try {
        rows = await updateRows(sql, scope, [id.value], f.value, null);
      } catch (err) {
        if (constraintAnswer(res, err)) return;
        throw err;
      }
      if (!rows[0]) {
        if (await staleBid(sql, scope, [id.value], f.value)) return fail(res, 409, 'stale_bid', STALE_BID, { field: 'bid_item_id' });
        return fail(res, 404, 'not_found', 'That row does not exist any more.');
      }
      await refileAfter(sql, scope, payload, codesWas, rows);
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
