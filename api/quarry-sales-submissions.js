'use strict';
/**
 * Quarry Sales — the field side of the quarry's Sales Tracking tab.
 *
 *   GET    /api/quarry-sales-submissions              my sales, newest first
 *          ?status=draft|submitted                    one stage
 *          ?from=YYYY-MM-DD&to=YYYY-MM-DD             a window
 *          ?scope=all                                 the whole company (office)
 *   POST   /api/quarry-sales-submissions              create a draft
 *   PUT    /api/quarry-sales-submissions?id=N         update my draft
 *   POST   /api/quarry-sales-submissions?action=submit&id=N
 *   DELETE /api/quarry-sales-submissions?id=N         throw a draft away
 *                                                     (office: remove a sale)
 *
 * Two stages, not three. Timesheet → Payroll and Fuel → Fuel Admin both park a
 * submission in an office queue and wait for someone to approve it; there is no
 * such queue here. Submitting posts the sale straight into the fct_quarry_sales
 * blob the Sales Tracking tab reads, so the office sees it in the grid it
 * already works in, and an 'approved' state would name a step nobody performs.
 *
 * What the form asks for is exactly the seven columns that grid opens with —
 * date, location, employee, customer, product, tons, payment — and every one of
 * them but the tons and the date is picked from the quarry's own Manage Lists.
 * The names are re-resolved from that list on every write, so what lands in the
 * grid is spelled the way the list spells it however the page was cached.
 *
 * The office owns the money. Price per ton is deliberately not asked for: the
 * scale house sells what the office priced. It arrives as an empty, editable
 * cell on the injected row, and sales tax, net sales and total due follow from
 * it exactly as they do on a row typed in by hand.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');
const { syncForKey } = require('./lib/sync-normalized');
const { PAYMENT_OPTIONS } = require('./lib/quarry-sales-options');
const {
  QUARRY_SALES_BLOB, salesRowId, salesRowIdPrefix,
} = require('./lib/quarry-sales-injected');

const VALID_STATUSES = ['draft', 'submitted'];

/**
 * The form, as data. Order is the order the form asks for them, which is also
 * the order the "still needed" message names them in — and the order of the
 * columns in Sales Tracking, because they are the same seven things.
 *
 * `list` names the Manage Lists bucket an answer is picked from; a field with
 * no bucket is typed in. `pair` marks the four that carry an id beside the
 * name, so one loop can resolve all of them.
 */
const FIELDS = [
  { key: 'work_date',     label: 'Date' },
  { key: 'location_name', label: 'Location', list: 'location',  pair: 'location_id' },
  { key: 'employee_name', label: 'Employee', list: 'employees', pair: 'employee_id' },
  { key: 'customer_name', label: 'Customer', list: 'customer',  pair: 'customer_id' },
  { key: 'product_name',  label: 'Product',  list: 'product',   pair: 'product_id'  },
  { key: 'tons',          label: 'Tons' },
  { key: 'payment',       label: 'Payment' },
];

// The heaviest load anyone has ever put across the scale in one go, with room
// over it. Not a policy — a guard against the digit typed wrong that turns 24
// tons into 240 and quietly moves a month's revenue. A real load above this is
// two loads.
const MAX_TONS = 200;

const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

// ── Field parsing ──────────────────────────────────────────────────────────
// Every one of these tolerates a blank: a DRAFT is allowed to be half-filled,
// and missingFields() below is what decides whether it is complete enough to
// send in. What they refuse is a value that is present and wrong.

function safeDate(v) {
  if (!v) return null;
  // A DATE read back from the driver arrives as a Date object; toISOString()
  // on one would shift the day across a timezone, so take the local parts.
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${v.getFullYear()}-${m}-${d}`;
  }
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, mo, d] = s.split('-').map(Number);
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return s;
}

function safeInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function safeStr(v, max = 200) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Tons as typed. Blank stays blank so a draft can be saved before the ticket
 * is off the printer; anything present has to be a real, positive weight.
 * Returns { value } or { error }.
 */
function parseTons(v) {
  if (v === null || v === undefined || String(v).trim() === '') return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n))  return { error: 'Tons must be a number.' };
  if (n <= 0)               return { error: 'Tons must be more than zero.' };
  if (n > MAX_TONS)         return { error: `Tons looks wrong — ${n} is over the ${MAX_TONS}-ton limit for one load. Split it into two sales.` };
  return { value: Math.round(n * 10000) / 10000 };
}

/**
 * Everything on the form, blanks included. Never refuses an incomplete body —
 * only a value that is present and unusable. Returns { data } or { error }.
 */
function normalizeBody(body) {
  const b = (body && typeof body === 'object') ? body : {};

  const work_date = safeDate(b.work_date);
  if (b.work_date && !work_date) return { error: 'Date must be a real calendar date (YYYY-MM-DD).' };

  const tons = parseTons(b.tons);
  if (tons.error) return { error: tons.error };

  const payment = safeStr(b.payment, 20);
  if (payment && !PAYMENT_OPTIONS.includes(payment)) {
    return { error: `Payment must be one of: ${PAYMENT_OPTIONS.join(', ')}.` };
  }

  return {
    data: {
      work_date,
      location_id:   safeStr(b.location_id, 80),
      location_name: safeStr(b.location_name),
      employee_id:   safeStr(b.employee_id, 80),
      employee_name: safeStr(b.employee_name),
      customer_id:   safeStr(b.customer_id, 80),
      customer_name: safeStr(b.customer_name),
      product_id:    safeStr(b.product_id, 80),
      product_name:  safeStr(b.product_name),
      tons: tons.value,
      payment,
    },
  };
}

/**
 * Re-spell the four picked answers the way Manage Lists spells them.
 *
 * The whole reason those four are pickers is that "Homer City" and "Homer city"
 * are the same pit and the grid groups, filters and reports on the name. A page
 * cached last week can post an id whose name has since been corrected, so the
 * id is what is trusted and the name is taken from the list.
 *
 * An id that resolves to nothing keeps the name that was posted: a customer
 * deleted from the list between draft and submit is still who bought the
 * material, and refusing the sale over it would strand the load.
 *
 * Mutates and returns `data`. Non-fatal — a failed read leaves the posted
 * names alone rather than losing the sale.
 */
async function resolveListNames(sql, companyCode, data) {
  const anyId = FIELDS.some(f => f.pair && data[f.pair]);
  if (!anyId) return data;
  let lists = null;
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:fct_quarry_lists`}`;
    lists = rows.length ? rows[0].value : null;
  } catch (err) {
    console.error('[quarry-sales] list lookup failed:', err.message);
    return data;
  }
  if (!lists || typeof lists !== 'object') return data;

  for (const f of FIELDS) {
    if (!f.pair || !data[f.pair]) continue;
    const bucket = Array.isArray(lists[f.list]) ? lists[f.list] : [];
    const item = bucket.find(it => it && String(it.id) === String(data[f.pair]));
    if (item && String(item.name || '').trim()) data[f.key] = String(item.name).trim();
  }
  return data;
}

/**
 * The fields still empty, in form order. Reads a DB row or a normalized body —
 * both carry the same keys.
 *
 * Tons is checked against null rather than truthiness: a sale of 0 tons is
 * refused by parseTons, so a 0 here can only be a column that was never filled
 * in, and either way the answer is the same. The four picked fields are checked
 * on their NAME, not their id: a name with no id is a list item that has since
 * been deleted, which is still an answer.
 */
function missingFields(row) {
  return FIELDS.filter(f => {
    const v = row[f.key];
    if (f.key === 'tons') return v === null || v === undefined || v === '';
    return !String(v == null ? '' : v).trim();
  }).map(f => f.label);
}

// One DB row as the API hands it back. Numerics come off the driver as
// strings; the form and the list both want numbers.
function dbToEntry(r) {
  return {
    id:            String(r.id),
    status:        r.status,
    username:      r.username,
    user_id:       r.user_id,
    work_date:     safeDate(r.work_date),
    location_id:   r.location_id   || '',
    location_name: r.location_name || '',
    employee_id:   r.employee_id   || '',
    employee_name: r.employee_name || '',
    customer_id:   r.customer_id   || '',
    customer_name: r.customer_name || '',
    product_id:    r.product_id    || '',
    product_name:  r.product_name  || '',
    tons:          r.tons === null || r.tons === undefined ? null : Number(r.tons),
    payment:       r.payment || '',
    row_id:        r.row_id || null,
    submitted_at:  r.submitted_at || null,
    created_at:    r.created_at || null,
    updated_at:    r.updated_at || null,
  };
}

// ── The Sales Tracking blob ────────────────────────────────────────────────
// Injection is a read-modify-write on fct_quarry_sales — the same shape
// api/timesheet-entries.js uses for the Daily and Crushing blobs.

async function readBlobArray(sql, companyCode, blobKey) {
  const rows = await sql`SELECT value FROM app_data WHERE key = ${`${companyCode}:${blobKey}`}`;
  const v = rows.length ? rows[0].value : null;
  return Array.isArray(v) ? v : [];
}

async function writeBlobArray(sql, companyCode, blobKey, arr) {
  await sql`
    INSERT INTO app_data (key, value, updated_at)
    VALUES (${`${companyCode}:${blobKey}`}, ${JSON.stringify(arr)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

/**
 * Post a submitted sale into Sales Tracking, and mirror it to the normalized
 * table the reports read.
 *
 * Idempotent: any row this submission already owns is dropped first, so a
 * retried submit corrects the sale rather than posting it twice. The price the
 * office had already typed on that row is carried across — it is the office's
 * column, and losing it on a correction is how a priced load silently becomes
 * a $0 one.
 */
async function injectSalesRow(sql, companyCode, sub) {
  const prefix = salesRowIdPrefix(sub.id);
  const isMine = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);

  const arr   = await readBlobArray(sql, companyCode, QUARRY_SALES_BLOB);
  const prior = arr.find(isMine);

  const row = {
    id:            salesRowId(sub.id),
    date:          safeDate(sub.work_date) || '',
    locationId:    sub.location_id   || '',
    locationName:  sub.location_name || '',
    employeeId:    sub.employee_id   || '',
    employeeName:  sub.employee_name || '',
    customerId:    sub.customer_id   || '',
    customerName:  sub.customer_name || '',
    productId:     sub.product_id    || '',
    productName:   sub.product_name  || '',
    tons:          sub.tons === null || sub.tons === undefined ? '' : Number(sub.tons),
    payment:       sub.payment || '',
    // The office's column. Blank on a new sale, kept on a corrected one.
    pricePerTon:   (prior && prior.pricePerTon !== undefined && prior.pricePerTon !== null)
      ? prior.pricePerTon : '',
  };

  const next = arr.filter(r => !isMine(r));
  next.push(row);
  await writeBlobArray(sql, companyCode, QUARRY_SALES_BLOB, next);
  await syncForKey(sql, companyCode, QUARRY_SALES_BLOB, next);
  return row;
}

/**
 * Take a submission's sale back out of Sales Tracking. Returns how many rows
 * went.
 *
 * syncForKey short-circuits on an empty array — it will not delete the last
 * mirror row — so the removed ids are deleted from the normalized table
 * explicitly, the same way removeQuarryRows does on the timesheet side.
 */
async function removeSalesRow(sql, companyCode, submissionId) {
  const prefix = salesRowIdPrefix(submissionId);
  const isMine = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);

  const arr = await readBlobArray(sql, companyCode, QUARRY_SALES_BLOB);
  const removed = arr.filter(isMine);
  if (!removed.length) return 0;

  const remaining = arr.filter(r => !isMine(r));
  await writeBlobArray(sql, companyCode, QUARRY_SALES_BLOB, remaining);
  await sql`
    DELETE FROM quarry_sales_entries
    WHERE company_code = ${companyCode} AND id = ANY(${removed.map(r => String(r.id))})
  `;
  if (remaining.length) await syncForKey(sql, companyCode, QUARRY_SALES_BLOB, remaining);
  return removed.length;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode, userId } = payload;
  const canSubmit = hasDivisionAccess(payload, 'quarry_sales');
  // The office side is the quarry division itself — Sales Tracking is where
  // these land, so whoever works that grid is who may see and unpick them.
  const canOffice = hasDivisionAccess(payload, 'quarry') || payload.isPlatformAdmin;

  if (!canSubmit && !canOffice) {
    return res.status(403).json({ error: 'You do not have access to Quarry Sales' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const q   = req.query || {};

  try {
    // ── GET (list) ────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const statusF = VALID_STATUSES.includes(q.status) ? q.status : '';
      const fromF   = safeDate(q.from) || '1900-01-01';
      const toF     = safeDate(q.to)   || '9999-12-31';

      // Whose rows come back. The default is ALWAYS the caller's own, for
      // every caller including the office — company-wide is an explicit
      // opt-in, never something a request falls into by omission. A field user
      // asking for it is quietly scoped to themselves rather than refused:
      // there is nothing to reveal, so there is nothing to deny.
      const companyWide = canOffice && q.scope === 'all';

      let userF = null;
      if (!companyWide) {
        userF = safeInt(userId);
        // A token carrying no user id owns no rows, and a null filter falling
        // through here would hand back the whole company. Fail closed.
        if (userF == null) return res.status(401).json({ error: 'Unauthorized — please log in' });
      }

      let rows;
      if (userF != null) {
        rows = await sql`
          SELECT * FROM quarry_sales_submissions
          WHERE company_code = ${companyCode}
            AND user_id      = ${userF}
            AND (${statusF} = '' OR status = ${statusF})
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
          ORDER BY work_date DESC, created_at DESC
        `;
      } else {
        rows = await sql`
          SELECT * FROM quarry_sales_submissions
          WHERE company_code = ${companyCode}
            AND (${statusF} = '' OR status = ${statusF})
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
          ORDER BY work_date DESC, created_at DESC
        `;
      }

      return res.json({ entries: rows.map(dbToEntry) });
    }

    // ── POST (create draft) ───────────────────────────────────────────────
    if (req.method === 'POST' && !q.action) {
      if (!canSubmit) {
        return res.status(403).json({ error: 'Quarry Sales access is required to record a sale' });
      }
      const { data, error } = normalizeBody(req.body || {});
      if (error) return res.status(400).json({ error });
      // The date is the one thing a row cannot exist without — it is the
      // table's only NOT NULL answer, and the grid files sales by it.
      if (!data.work_date) return res.status(400).json({ error: 'Pick a date before saving.' });
      await resolveListNames(sql, companyCode, data);

      const [inserted] = await sql`
        INSERT INTO quarry_sales_submissions (
          company_code, user_id, username, status, work_date,
          location_id, location_name, employee_id, employee_name,
          customer_id, customer_name, product_id, product_name,
          tons, payment
        ) VALUES (
          ${companyCode}, ${userId}, ${payload.username}, 'draft', ${data.work_date},
          ${data.location_id}, ${data.location_name},
          ${data.employee_id}, ${data.employee_name},
          ${data.customer_id}, ${data.customer_name},
          ${data.product_id},  ${data.product_name},
          ${data.tons}, ${data.payment}
        )
        RETURNING *
      `;
      return res.json({ ok: true, entry: dbToEntry(inserted) });
    }

    // ── PUT (update draft) ────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM quarry_sales_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Sale not found' });
      if (existing.user_id !== userId) {
        return res.status(403).json({ error: 'You can only edit your own sales' });
      }
      // Submitting posts the sale into Sales Tracking, where the office prices
      // it. Editing it here afterwards would silently rewrite a row they may
      // already have invoiced, so the answer is no — and the office can delete
      // the sale from the grid if it was wrong.
      if (existing.status !== 'draft') {
        return res.status(409).json({ error: 'This sale has been submitted — ask the quarry office to remove it from Sales Tracking if it was wrong.' });
      }
      if (!canSubmit) return res.status(403).json({ error: 'Quarry Sales access is required' });

      const { data, error } = normalizeBody(req.body || {});
      if (error) return res.status(400).json({ error });
      if (!data.work_date) return res.status(400).json({ error: 'Pick a date before saving.' });
      await resolveListNames(sql, companyCode, data);

      const [updated] = await sql`
        UPDATE quarry_sales_submissions SET
          work_date     = ${data.work_date},
          location_id   = ${data.location_id},   location_name = ${data.location_name},
          employee_id   = ${data.employee_id},   employee_name = ${data.employee_name},
          customer_id   = ${data.customer_id},   customer_name = ${data.customer_name},
          product_id    = ${data.product_id},    product_name  = ${data.product_name},
          tons          = ${data.tons},          payment       = ${data.payment},
          updated_at    = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      return res.json({ ok: true, entry: dbToEntry(updated) });
    }

    // ── POST ?action=submit — draft → submitted, and into the grid ────────
    if (req.method === 'POST' && q.action === 'submit') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM quarry_sales_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Sale not found' });
      if (existing.user_id !== userId) {
        return res.status(403).json({ error: 'You can only submit your own sales' });
      }
      if (existing.status !== 'draft') {
        return res.status(409).json({ error: 'This sale has already been submitted.' });
      }
      if (!canSubmit) return res.status(403).json({ error: 'Quarry Sales access is required' });

      // Submit is the gate into Sales Tracking, so this is where completeness
      // stops being optional. A draft may be half-filled; a row in the office's
      // grid may not.
      const entryNow = dbToEntry(existing);
      const missing  = missingFields(entryNow);
      if (missing.length) {
        return res.status(400).json({
          error: `Fill in every field before submitting — still needed: ${missing.join(', ')}.`,
          missing_fields: missing,
        });
      }

      // The same load sent twice. A retry that lost track of its draft posts a
      // second sale instead of reusing the first, and once both are in the grid
      // nothing tells them apart — same pit, same day, same customer, same
      // material, same weight, twice. Matched in SQL against the row being
      // submitted so no DATE round-trips through JS and across a timezone.
      const [dupe] = await sql`
        SELECT b.id FROM quarry_sales_submissions a
        JOIN quarry_sales_submissions b
          ON  b.company_code  = a.company_code
          AND b.work_date     = a.work_date
          AND b.location_name IS NOT DISTINCT FROM a.location_name
          AND b.customer_name IS NOT DISTINCT FROM a.customer_name
          AND b.product_name  IS NOT DISTINCT FROM a.product_name
          AND b.tons          IS NOT DISTINCT FROM a.tons
          AND b.payment       IS NOT DISTINCT FROM a.payment
          AND b.id           <> a.id
          AND b.status        = 'submitted'
        WHERE a.id = ${id} AND a.company_code = ${companyCode}
        LIMIT 1
      `;
      if (dupe) {
        return res.status(409).json({
          error: 'A sale already submitted covers this pit, date, customer, product and tonnage. Delete this draft instead of sending it again.',
          duplicate_of: String(dupe.id),
        });
      }

      // The grid first, the status second. A crash between them leaves a draft
      // with a row already posted, which the next submit corrects in place —
      // whereas flipping the status first and then failing would leave a sale
      // marked sent that never reached the office.
      await injectSalesRow(sql, companyCode, entryNow);

      const [updated] = await sql`
        UPDATE quarry_sales_submissions
        SET status = 'submitted', submitted_at = NOW(),
            row_id = ${salesRowId(id)}, updated_at = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      return res.json({ ok: true, entry: dbToEntry(updated) });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    // A draft is the submitter's to throw away. A submitted sale is a row in
    // the office's grid, so removing it is the office's call — and it takes
    // the Sales Tracking row with it, because nothing else can: the blob guard
    // restores an injected row that a tab save omitted.
    if (req.method === 'DELETE') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM quarry_sales_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Sale not found' });

      if (existing.status === 'draft') {
        if (existing.user_id !== userId && !canOffice) {
          return res.status(403).json({ error: 'You can only delete your own drafts' });
        }
      } else if (!canOffice) {
        return res.status(403).json({ error: 'This sale is in Sales Tracking — only the quarry office can remove it.' });
      }

      const removed = await removeSalesRow(sql, companyCode, id);
      await sql`DELETE FROM quarry_sales_submissions WHERE id = ${id} AND company_code = ${companyCode}`;
      return res.json({ ok: true, removed_rows: removed });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[quarry-sales-submissions]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// Exposed for scripts/test-quarry-sales-submissions.js, which exercises the
// parsing and completeness rules directly rather than through a fake request.
module.exports._test = {
  FIELDS, MAX_TONS, VALID_STATUSES,
  safeDate, safeInt, safeStr, parseTons, normalizeBody, missingFields,
  dbToEntry, resolveListNames, injectSalesRow, removeSalesRow,
};
