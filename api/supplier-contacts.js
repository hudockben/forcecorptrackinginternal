'use strict';

// /api/supplier-contacts — the people at each supplier a division buys from.
//
// The Procurement tab has a Contact and an Email beside every Vendor, and the
// same three or four people answer for a supplier on every job. So whatever
// is typed there is remembered under that vendor (POST, which never makes a
// second copy of somebody), the next row offers them, and picking one fills
// in both cells. Admin → Suppliers lists and edits them per supplier.
//
// Suppliers have no ids — they are the name entries of the division's lists
// blob — so a contact belongs to a supplier by NAME, compared trimmed and
// without case, and renaming a supplier moves its contacts (action=rename).
// A Procurement row's Vendor is that same name, so the rename carries the
// division's procurement_items over with it, in the same statement: left on
// the old name, a row would lose its contacts, offer none, and file the next
// one typed on it under a supplier that no longer exists.
//
// GET    ?division=…                     → { ok, contacts:[{ id, supplier_name, name, email, phone, updated_at }], canEdit }
// POST   ?division=…  { supplier_name, name, email, phone }
//          → 201 { ok, contact, existed:false }   a new contact
//          →     { ok, contact, existed:true }    one already saved, its blank
//                                                 name/email/phone filled in
// POST   ?division=…&action=rename { from, to }
//          → { ok, moved:n, merged:n, rows:n, pos:n, po_ids:[…], po_error? }
//          rows = Procurement rows whose Vendor was `from` and is now `to`
//          pos  = the division's purchase orders whose Supplier was `from`
//                 and is now `to` (po_ids names them). po_error is set when
//                 orders naming `from` could not be renamed: 'no_access' (the
//                 caller may not change purchase orders), 'busy' (the list
//                 kept changing under the write) or 'failed'.
// PATCH  ?division=…&id=X  { name?, email?, phone? }  → { ok, contact } | 409 duplicate
// DELETE ?division=…&id=X                        → { ok, id }   (soft)
//
// Same people as Procurement itself: every non-sales user in the division
// reads, admin/level3/level2 write, level1 gets 403 read_only, sales is
// refused.
//
// email is kept as typed and never checked for shape — the buy-out sheets
// this replaces have phone numbers in that column, and refusing them would
// only mean the contact is never saved. Matching on it ignores case.

const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');
const { requireDivision, levelFor, isSalesIn, poCapabilities } = require('./lib/auth');
const { cleanStr, isPlainObject } = require('./lib/custom-report-runs');
const poSync = require('./lib/po-sync');

const DIVISIONS    = ['turf', 'paving', 'kiewit'];
const EDIT_LEVELS  = ['admin', 'level3', 'level2'];
const MAX_SUPPLIER = 120;
const MAX_NAME     = 120;
const MAX_EMAIL    = 200;
const MAX_PHONE    = 60;
const ID_RE        = /^[A-Za-z0-9_-]{1,64}$/;
// How many times a save looks again after a colleague's save of the same
// person got in between its look and its write. One is nearly always enough.
const ATTEMPTS     = 4;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// One line of text: NUL and half surrogate pairs go, other control
// characters become spaces. Refused when too long, never cut.
function readText(raw, max, label) {
  if (raw === undefined || raw === null) return { value: '' };
  if (typeof raw !== 'string' && typeof raw !== 'number') return { error: `${label} must be text` };
  const v = cleanStr(raw).replace(/[\u0001-\u001f\u007f]+/g, ' ').trim();
  if (v.length > max) return { error: `${label} is limited to ${max} characters` };
  return { value: v };
}

function readPerson(b, { partial }) {
  const out = {};
  for (const [k, max, label] of [['name', MAX_NAME, 'Name'], ['email', MAX_EMAIL, 'Email'], ['phone', MAX_PHONE, 'Phone']]) {
    if (partial && !has(b, k)) continue;
    const t = readText(b[k], max, label);
    if (t.error) return { error: t.error, field: k };
    out[k] = t.value;
  }
  return { value: out };
}

const iso = v => (v === null || v === undefined ? null : (v instanceof Date ? v.toISOString() : String(v)));

function shape(r) {
  return {
    id:            r.id,
    supplier_name: r.supplier_name,
    name:          r.name || '',
    email:         r.email || '',
    phone:         r.phone || '',
    updated_at:    iso(r.updated_at),
  };
}

const newId = () => 'sc' + Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
const isUniqueViolation = err => Boolean(err) && (err.code === '23505' || /duplicate key value/i.test(err.message || ''));
const isCheckViolation  = err => Boolean(err) && (err.code === '23514' || /violates check constraint/i.test(err.message || ''));
const fail = (res, status, error, message, extra) =>
  res.status(status).json({ ok: false, error, ...(message ? { message } : {}), ...(extra || {}) });
// What a rename says about the purchase orders (renamePOs).
const poAnswer = po => ({ pos: po.pos, po_ids: po.ids, ...(po.error ? { po_error: po.error } : {}) });

/**
 * The live contact a save of `v` is about, or null. With an email, the
 * supplier's contact with that email; failing that, one of the same name that
 * has no email yet (somebody typed the name on one row and the email on the
 * next — that is one person, not two). With no email, the contact of that
 * name, the one without an email first.
 */
async function findSame(sql, { company, division }, v) {
  if (v.email) {
    const byEmail = await sql`
      SELECT * FROM supplier_contacts
       WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         AND lower(supplier_name) = lower(${v.supplier_name}) AND email <> '' AND lower(email) = lower(${v.email})
       LIMIT 1`;
    if (byEmail[0]) return { row: byEmail[0], by: 'email' };
    if (!v.name) return null;
    const byName = await sql`
      SELECT * FROM supplier_contacts
       WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         AND lower(supplier_name) = lower(${v.supplier_name}) AND email = '' AND lower(name) = lower(${v.name})
       LIMIT 1`;
    return byName[0] ? { row: byName[0], by: 'name_no_email' } : null;
  }
  const byName = await sql`
    SELECT * FROM supplier_contacts
     WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
       AND lower(supplier_name) = lower(${v.supplier_name}) AND lower(name) = lower(${v.name})
     ORDER BY (email = '') DESC, created_at, id
     LIMIT 1`;
  return byName[0] ? { row: byName[0], by: 'name' } : null;
}

/**
 * "Remember this contact": the existing one with its blanks filled, or a new
 * one. Never overwrites anything already saved — a contact's details are
 * changed on purpose, through PATCH, not by whatever was typed on a row.
 *
 * Safe against a colleague saving the same person at the same moment: the
 * unique indexes refuse the second copy (the INSERT does nothing), the fill
 * only writes into a field still blank at the instant it runs, and when
 * either finds the ground moved it looks again.
 */
async function remember(sql, scope, v, id) {
  const { company, division, who } = scope;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const same = await findSame(sql, scope, v);
    if (same) {
      const cur = same.row;
      const fills = (!cur.name && v.name) || (!cur.email && v.email) || (!cur.phone && v.phone);
      if (!fills) return { contact: cur, existed: true };
      try {
        // Matched by name for an email: only while it still has no email, or
        // two saves of different addresses would both claim the same person.
        const rows = await sql`
          UPDATE supplier_contacts SET
            name  = CASE WHEN name  = '' THEN ${v.name}  ELSE name  END,
            email = CASE WHEN email = '' THEN ${v.email} ELSE email END,
            phone = CASE WHEN phone = '' THEN ${v.phone} ELSE phone END,
            updated_at = NOW(), updated_by = ${who}
          WHERE id = ${cur.id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL
            AND (${same.by}::text <> 'name_no_email' OR email = '')
          RETURNING *`;
        if (rows[0]) return { contact: rows[0], existed: true };
      } catch (err) {
        // The email being filled in was saved on another contact meanwhile.
        if (!isUniqueViolation(err)) throw err;
      }
      continue;
    }
    // ON CONFLICT DO NOTHING: a colleague's copy of the same person, saved
    // between the look above and this write, wins, and the next pass finds it.
    const rows = await sql`
      INSERT INTO supplier_contacts
        (id, company_code, division, supplier_name, name, email, phone, created_by, updated_by)
      VALUES (${id || newId()}, ${company}, ${division}, ${v.supplier_name}, ${v.name}, ${v.email}, ${v.phone}, ${who}, ${who})
      ON CONFLICT DO NOTHING
      RETURNING *`;
    if (rows[0]) return { contact: rows[0], existed: false };
  }
  return { duplicate: true };
}

/**
 * Move every live contact of supplier `from` to `to`, in one statement —
 * and the Procurement rows naming `from` as their Vendor (`vendors`), deleted
 * ones too, so one restored later ("removed earlier" on Send to Procurement)
 * comes back under the supplier's current name. Each such row's version
 * moves, so a page showing its job picks the new name up on its next poll.
 *
 * A contact `to` already has (the same email, or with no email the same name)
 * is not moved on top of it: the existing one takes whatever it was missing
 * (name, phone) from the one moving, and the one moving is soft-deleted. So a
 * supplier renamed onto another one ends with one copy of each person.
 *
 * The CTEs see one snapshot and touch disjoint rows — `to`'s contacts, and
 * `from`'s — so nothing is updated twice. Re-casing a name ("acme" → "Acme")
 * is the same supplier and is a plain rename.
 */
function renameStatement(sql, { company, division, who }, from, to) {
  return sql`
    WITH moving AS (
      SELECT id, name, email, phone FROM supplier_contacts
       WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         AND lower(supplier_name) = lower(${from})
    ), dup AS (
      SELECT m.id AS mid, t.id AS tid, m.name, m.phone
        FROM moving m
        JOIN supplier_contacts t
          ON t.company_code = ${company} AND t.division = ${division} AND t.deleted_at IS NULL
         AND lower(t.supplier_name) = lower(${to})
         AND ((m.email <> '' AND lower(t.email) = lower(m.email))
           OR (m.email = '' AND t.email = '' AND lower(t.name) = lower(m.name)))
    ), filled AS (
      UPDATE supplier_contacts t SET
        name  = CASE WHEN t.name  = '' THEN d.name  ELSE t.name  END,
        phone = CASE WHEN t.phone = '' THEN d.phone ELSE t.phone END,
        updated_at = NOW(), updated_by = ${who}
        FROM dup d
       WHERE t.id = d.tid AND ((t.name = '' AND d.name <> '') OR (t.phone = '' AND d.phone <> ''))
      RETURNING t.id
    ), merged AS (
      UPDATE supplier_contacts
         SET deleted_at = NOW(), deleted_by = ${who}, updated_at = NOW(), updated_by = ${who}
       WHERE id IN (SELECT mid FROM dup)
      RETURNING id
    ), moved AS (
      UPDATE supplier_contacts
         SET supplier_name = ${to}, updated_at = NOW(), updated_by = ${who}
       WHERE id IN (SELECT id FROM moving) AND id NOT IN (SELECT mid FROM dup)
      RETURNING id
    ), vendors AS (
      UPDATE procurement_items
         SET vendor = ${to}, version = version + 1, updated_at = NOW(), updated_by = ${who}
       WHERE company_code = ${company} AND division = ${division}
         AND lower(btrim(vendor)) = lower(${from}) AND vendor <> ${to}
      RETURNING id
    )
    SELECT (SELECT count(*) FROM moved)::int   AS moved,
           (SELECT count(*) FROM merged)::int  AS merged,
           (SELECT count(*) FROM filled)::int  AS filled,
           (SELECT count(*) FROM vendors)::int AS rows`;
}

/**
 * Rename the supplier on the division's purchase orders. Procurement fills a
 * row's PO # from the job's order with its codes AND its vendor, so orders
 * left on the old name would drop every row that was on one to "Not Ordered"
 * (and Late), and "Create PO from selected" would raise a second order.
 *
 * Done here, not by the page: the page's copy of the order list can be
 * minutes old (its poll does not take a new list while a box has focus, and
 * on Admin > Suppliers one nearly always has), and saving that copy whole put
 * back orders colleagues had deleted and undid their approvals. This touches
 * ONLY the Supplier of the orders that name `from`, on the stored list as it
 * is at the instant of the write — a compare-and-set that starts again from a
 * fresh read whenever someone else saved in between (api/lib/po-sync.js) —
 * then the normalized mirror and the job cost rows those orders' own
 * deliveries made (the rows a Daily Tracking delivery came from keep their
 * own supplier, as on every purchasing save).
 */
async function renamePOs(sql, payload, scope, from, to) {
  // The contacts and rows are renamed by now: a failure here is reported
  // with them (po_error), not as a failed rename.
  try { return await renamePOsNow(sql, payload, scope, from, to); } catch (err) {
    console.error('[supplier-contacts] rename: purchase orders not renamed:', err.message);
    return { pos: 0, ids: [], error: 'failed' };
  }
}
async function renamePOsNow(sql, payload, { company, division }, from, to) {
  const key = poSync.blobKeyFor(company, division);
  const k = v => String(v == null ? '' : v).trim().toLowerCase();
  const names = po => po && k(po.supplier) === k(from) && po.supplier !== to;
  if (!poCapabilities(payload, division).canUpload) {
    // Not allowed to change orders: said only when there is one to change.
    const { list } = await poSync.readPOBlob(sql, key);
    return list.some(names) ? { pos: 0, ids: [], error: 'no_access' } : { pos: 0, ids: [] };
  }
  let hit = [];
  const saved = await poSync.mutatePOBlob(sql, key, list => {
    hit = [];
    const next = list.map(po => {
      if (!names(po)) return po;
      const renamed = { ...po, supplier: to };
      hit.push(renamed);
      return renamed;
    });
    return hit.length ? next : null;
  });
  if (!saved.ok) return { pos: 0, ids: [], error: 'busy' };
  if (!saved.changed || !hit.length) return { pos: 0, ids: [] };
  const ids = hit.map(po => String(po.id));
  // The stored list is the truth on read; these follow it, best effort.
  try {
    await sql`
      UPDATE purchase_orders SET supplier = ${to}, updated_at = NOW()
       WHERE company_code = ${company} AND division = ${division} AND id = ANY(${ids}::text[])`;
    const rowIds = [...new Set(hit.flatMap(po => (Array.isArray(po.lines) ? po.lines : [])
      .filter(l => l && l.po_row_id && !poSync.isDailyLine(l)).map(l => String(l.po_row_id))))];
    if (rowIds.length) {
      await sql`
        UPDATE daily_tracking SET supplier = ${to}, updated_at = NOW()
         WHERE company_code = ${company} AND division = ${division}
           AND row_id = ANY(${rowIds}::text[]) AND timesheet_entry_id IS NULL`;
    }
  } catch (err) {
    console.error('[supplier-contacts] rename: PO mirror / cost rows not updated:', err.message);
  }
  return { pos: hit.length, ids };
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
    return fail(res, 400, 'division_not_supported', 'Supplier contacts are not available for this division.');
  }
  if (isSalesIn(payload, division)) {
    return fail(res, 403, 'no_access', 'Supplier contacts are not available to a sales login.');
  }

  const company = payload.companyCode;
  const canEdit = EDIT_LEVELS.includes(levelFor(payload, division));
  const who     = String(payload.name || payload.username || '').slice(0, 120) || null;
  const scope   = { company, division, who };
  const q       = req.query || {};
  const action  = q.action === undefined ? '' : String(q.action);
  const sql     = neon(process.env.DATABASE_URL);

  try {
    // ── GET — the division's contacts ────────────────────────────────────
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT * FROM supplier_contacts
         WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         ORDER BY lower(supplier_name), lower(name), lower(email), id`;
      return res.json({ ok: true, contacts: rows.map(shape), canEdit });
    }

    if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      return fail(res, 405, 'method_not_allowed', 'Method not allowed');
    }
    if (!canEdit) {
      return fail(res, 403, 'read_only', 'Only admin, level 3 and level 2 users can change supplier contacts.');
    }
    let b = req.body === undefined || req.body === null ? {} : req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (req.method !== 'DELETE' && !isPlainObject(b)) {
      return fail(res, 400, 'invalid', 'Body must be an object');
    }

    // ── POST action=rename — a supplier renamed on the Suppliers tab ─────
    if (req.method === 'POST' && action === 'rename') {
      const from = readText(b.from, MAX_SUPPLIER, 'from');
      if (from.error) return fail(res, 400, 'invalid', from.error, { field: 'from' });
      const to = readText(b.to, MAX_SUPPLIER, 'to');
      if (to.error) return fail(res, 400, 'invalid', to.error, { field: 'to' });
      if (!from.value || !to.value) return fail(res, 400, 'invalid', 'Both the old and the new supplier name are needed.');
      if (from.value.toLowerCase() === to.value.toLowerCase()) {
        // Re-cased: the same supplier, so nothing can merge — just the labels.
        const r = (await sql`
          WITH moved AS (
            UPDATE supplier_contacts SET supplier_name = ${to.value}, updated_at = NOW(), updated_by = ${who}
             WHERE company_code = ${company} AND division = ${division} AND deleted_at IS NULL
               AND lower(supplier_name) = lower(${from.value}) AND supplier_name <> ${to.value}
             RETURNING id
          ), vendors AS (
            UPDATE procurement_items
               SET vendor = ${to.value}, version = version + 1, updated_at = NOW(), updated_by = ${who}
             WHERE company_code = ${company} AND division = ${division}
               AND lower(btrim(vendor)) = lower(${from.value}) AND vendor <> ${to.value}
             RETURNING id
          )
          SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM vendors)::int AS rows`)[0] || {};
        const po = await renamePOs(sql, payload, scope, from.value, to.value);
        return res.json({ ok: true, moved: Number(r.moved) || 0, merged: 0, rows: Number(r.rows) || 0, ...poAnswer(po) });
      }
      // A contact saved under `to` between the statement's snapshot and its
      // write is a unique violation; the next pass sees it and merges it.
      let r;
      for (let attempt = 0; ; attempt++) {
        try {
          r = (await renameStatement(sql, scope, from.value, to.value))[0] || {};
          break;
        } catch (err) {
          if (!isUniqueViolation(err) || attempt >= ATTEMPTS - 1) throw err;
        }
      }
      const po = await renamePOs(sql, payload, scope, from.value, to.value);
      return res.json({ ok: true, moved: Number(r.moved) || 0, merged: Number(r.merged) || 0, rows: Number(r.rows) || 0, ...poAnswer(po) });
    }

    // ── POST — remember a contact ────────────────────────────────────────
    if (req.method === 'POST') {
      if (action) return fail(res, 400, 'invalid', `Unknown action "${action.slice(0, 40)}"`);
      const sup = readText(b.supplier_name, MAX_SUPPLIER, 'Supplier');
      if (sup.error) return fail(res, 400, 'invalid', sup.error, { field: 'supplier_name' });
      if (!sup.value) return fail(res, 400, 'invalid', 'Say which supplier the contact is for.', { field: 'supplier_name' });
      const p = readPerson(b, { partial: false });
      if (p.error) return fail(res, 400, 'invalid', p.error, { field: p.field });
      if (!p.value.name && !p.value.email) return fail(res, 400, 'invalid', 'A contact needs a name or an email.');
      let id = null;
      if (b.id !== undefined && b.id !== null && b.id !== '') {
        if (typeof b.id !== 'string' || !ID_RE.test(b.id)) {
          return fail(res, 400, 'invalid', 'id must be 1 to 64 letters, digits, - or _', { field: 'id' });
        }
        id = b.id;
      }
      const out = await remember(sql, scope, { supplier_name: sup.value, ...p.value }, id);
      if (out.duplicate) return fail(res, 409, 'duplicate', 'That contact could not be saved: its id is taken.');
      return res.status(out.existed ? 200 : 201).json({ ok: true, contact: shape(out.contact), existed: out.existed });
    }

    if (action) return fail(res, 400, 'invalid', `Unknown action "${action.slice(0, 40)}"`);
    if (typeof q.id !== 'string' || !ID_RE.test(q.id)) {
      return fail(res, 400, q.id === undefined ? 'id_required' : 'invalid', 'id is required');
    }
    const id = q.id;

    // ── DELETE — off the list (soft) ─────────────────────────────────────
    if (req.method === 'DELETE') {
      const rows = await sql`
        UPDATE supplier_contacts
           SET deleted_at = NOW(), deleted_by = ${who}, updated_at = NOW(), updated_by = ${who}
         WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL
         RETURNING id`;
      if (!rows[0]) return fail(res, 404, 'not_found', 'Contact not found');
      return res.json({ ok: true, id });
    }

    // ── PATCH — change a contact on purpose ──────────────────────────────
    // `division` may ride in the body (requireDivision reads it there too).
    const extra = Object.keys(b).filter(k => !['name', 'email', 'phone', 'division'].includes(k));
    if (extra.length) {
      return fail(res, 400, 'field_not_allowed', `${extra[0]} cannot be changed here`, { field: extra[0] });
    }
    const p = readPerson(b, { partial: true });
    if (p.error) return fail(res, 400, 'invalid', p.error, { field: p.field });
    if (!Object.keys(p.value).length) return fail(res, 400, 'no_fields', 'Nothing to change');
    const f = p.value;
    const s = k => has(f, k);
    const v = k => (has(f, k) ? f[k] : null);
    try {
      const rows = await sql`
        UPDATE supplier_contacts SET
          name  = CASE WHEN ${s('name')}::boolean  THEN ${v('name')}::text  ELSE name  END,
          email = CASE WHEN ${s('email')}::boolean THEN ${v('email')}::text ELSE email END,
          phone = CASE WHEN ${s('phone')}::boolean THEN ${v('phone')}::text ELSE phone END,
          updated_at = NOW(), updated_by = ${who}
        WHERE id = ${id} AND company_code = ${company} AND division = ${division} AND deleted_at IS NULL
        RETURNING *`;
      if (!rows[0]) return fail(res, 404, 'not_found', 'Contact not found');
      return res.json({ ok: true, contact: shape(rows[0]) });
    } catch (err) {
      if (isUniqueViolation(err)) return fail(res, 409, 'duplicate', 'This supplier already has a contact with that email (or, with no email, that name).');
      if (isCheckViolation(err)) return fail(res, 400, 'invalid', 'A contact needs a name or an email.');
      throw err;
    }
  } catch (err) {
    console.error('[supplier-contacts] error:', err.message);
    return fail(res, 500, 'database_error', 'Database error');
  }
};
