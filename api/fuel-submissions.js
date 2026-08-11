'use strict';
/**
 * Fuel submissions — field fuel entry, and the Fuel Admin review of it.
 *
 *   GET    /api/fuel-submissions                      — list submissions
 *     Defaults to the caller's OWN rows, for every caller including Fuel
 *     Admins. Reading past your own fuel is an explicit opt-in, so a page
 *     that forgets to scope shows too little rather than the whole company.
 *     Query: ?status=draft|submitted|approved|submitted_approved
 *            ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *            ?employee=<username>   filter by who fueled
 *            ?fuel_card=X  ?fuel_type=X
 *            ?user_id=N    (admin only — one named submitter)
 *            ?scope=all    (admin only — every user in the company)
 *
 *   POST   /api/fuel-submissions                      — create draft
 *     Fuel-user only (requires divisionRoles.fuel). Status forced to 'draft'.
 *     A draft may be INCOMPLETE — see normalizeBody.
 *
 *   PUT    /api/fuel-submissions?id=N                 — update
 *     Field user → own row, only while status='draft'
 *     Fuel Admin → any row with status 'submitted' or 'approved', and the
 *     row must stay complete (logged as ADMIN_EDIT)
 *
 *   POST   /api/fuel-submissions?action=submit&id=N   — draft → submitted
 *     Field-user only, must own the row, row must be in 'draft', and every
 *     one of the thirteen reported fields must be filled in.
 *
 *   POST   /api/fuel-submissions?action=approve&id=N  — submitted → approved
 *   POST   /api/fuel-submissions?action=unapprove&id=N — approved → submitted
 *     Fuel-Admin only.
 *
 *   DELETE /api/fuel-submissions?id=N
 *     Field user → own drafts only. Fuel Admin → any row, at any status.
 *
 * The server is the source of truth for:
 *   - status transitions (clients cannot set status directly)
 *   - user_id / username / company_code (taken from the JWT, never the body)
 *   - approved_at / approved_by (stamped here, never sent)
 *   - gallons, whenever the tank meter readings describe a fill
 *     (see gallonsFromMeters)
 *
 * Approval is a status flip and nothing more: fuel does not inject rows into
 * any division's cost tracking. If that changes, approve/unapprove are where
 * it goes, and they are deliberately symmetric so it can be added to both.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');
const { FUEL_CARDS, FUEL_TYPES, US_STATE_CODES } = require('./lib/fuel-options');

// The thirteen fields the field crew reports, in the order the form asks for
// them. Submit requires every one; a draft may hold any subset. The order is
// what drives the "missing fields" message, so it reads top-to-bottom the same
// way the form does rather than in whatever order an object happened to be in.
// Gallons sits after the two meter readings because that is where it comes
// from — see gallonsFromMeters. Asking for it before them read as a question
// on a form whose answer was three fields further down.
const REPORTED_FIELDS = [
  ['work_date',         'Date'],
  ['employee_username', 'Employee'],
  ['fuel_card',         'Fuel Card Used'],
  ['fuel_type',         'Fuel Type'],
  ['mileage',           'Mileage'],
  ['truck_number',      'Truck Number'],
  ['beginning_meter',   'Beginning Meter Reading'],
  ['ending_meter',      'Ending Meter Reading'],
  ['gallons',           'Gallons'],
  ['fueling_site',      'Fueling Site'],
  ['city_fueled',       'City Fueled'],
  ['state',             'State'],
  ['tank_number',       'Tank Number'],
];

const VALID_STATUSES = ['draft', 'submitted', 'approved'];

function safeDate(v) {
  if (!v) return null;
  // A DATE column comes back from the driver as a Date at LOCAL midnight, so
  // toISOString() — which converts to UTC — moves the day backwards anywhere
  // east of Greenwich. Read the local components instead: the value has no
  // time-of-day to lose, and the answer no longer depends on where the process
  // is running.
  if (v instanceof Date) {
    const y  = v.getFullYear();
    const mo = String(v.getMonth() + 1).padStart(2, '0');
    const d  = String(v.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * True when the body simply didn't say anything about this field.
 *
 * The one rule this whole file turns on: 0 is a REAL answer, not an absent
 * one. Both meter readings are documented on the form as "0 if not Force
 * Fuel", so a plain falsy test here would read a correctly-filled meter as an
 * empty one and refuse the submission — with the field visibly filled in.
 * Gallons, mileage, truck and tank numbers all have the same exposure.
 */
function isBlank(v) {
  return v == null || (typeof v === 'string' && v.trim() === '');
}

function safeStr(v, max) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  return max ? s.slice(0, max) : s;
}

// Present-but-unparseable is an error; absent is null. Returned as
// { value } or { error } so the caller can tell those two apart — a draft
// tolerates the second and never the first.
function parseNum(v, label, { min = 0, max, decimals = 2 } = {}) {
  if (isBlank(v)) return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n)) return { error: `${label} must be a number.` };
  if (n < min)             return { error: `${label} cannot be negative.` };
  if (max != null && n > max) return { error: `${label} is too large.` };
  const f = Math.pow(10, decimals);
  return { value: Math.round(n * f) / f };
}

function parseIntField(v, label, { max = 2147483647 } = {}) {
  if (isBlank(v)) return { value: null };
  const n = Number(v);
  if (!Number.isFinite(n))       return { error: `${label} must be a number.` };
  if (!Number.isInteger(n))      return { error: `${label} must be a whole number.` };
  if (n < 0)                     return { error: `${label} cannot be negative.` };
  if (n > max)                   return { error: `${label} is too large.` };
  return { value: n };
}

/**
 * Gallons off the tank meter, or null when the readings don't describe a
 * pumped quantity.
 *
 * On a Force Fuel tank the meter IS the gallons counter, so the difference
 * between the two readings is the fill — the driver should not be retyping a
 * number the tank already told them. Everything else falls back to what they
 * reported, and the single `end > begin` condition covers all three of those
 * cases without needing to know which one it is looking at:
 *
 *   0 and 0        a card purchase, no tank meter involved — the receipt is
 *                  the only source for gallons, so keep what was typed
 *   end < begin    the meter rolled over or was replaced; the difference is
 *                  meaningless (and negative), so keep what was typed
 *   end === begin  nothing was pumped, which on a real fill-up means a
 *                  mistyped reading — computing 0 would bury that, so keep
 *                  what was typed and let the meter flag in Fuel Admin show
 *
 * Derived here rather than trusted from the body for the same reason
 * computed_hours is on a timesheet: two numbers that are supposed to agree
 * will eventually stop agreeing, and the audit trail should not have to
 * guess which one was right.
 */
function gallonsFromMeters(begin, end) {
  if (begin == null || end == null) return null;
  const b = Number(begin), e = Number(end);
  if (!Number.isFinite(b) || !Number.isFinite(e)) return null;
  if (e <= b) return null;
  return Math.round((e - b) * 100) / 100;
}

/**
 * Turn a request body into the column set, or into an error.
 *
 * Absent and invalid are handled differently on purpose. A missing field
 * becomes null — that is what makes a draft a draft, and the field crew's
 * half-finished entry survives a walk back to the truck. A field that IS
 * present but doesn't parse (a fuel card that isn't one of the four, a state
 * that isn't a state) is an error at every status, because the only way to
 * produce one is a client that is out of step with this file, and silently
 * nulling it would drop reported data on the floor.
 *
 * work_date is the single exception: the column is NOT NULL, so a row cannot
 * exist without one.
 */
function normalizeBody(body) {
  const b = (body && typeof body === 'object') ? body : {};

  const work_date = safeDate(b.work_date);
  if (!work_date) return { error: 'A valid date is required.' };

  const fuel_card = safeStr(b.fuel_card, 100);
  if (fuel_card && !FUEL_CARDS.includes(fuel_card)) {
    return { error: `"${fuel_card}" is not one of the fuel cards.` };
  }

  const fuel_type = safeStr(b.fuel_type, 100);
  if (fuel_type && !FUEL_TYPES.includes(fuel_type)) {
    return { error: `"${fuel_type}" is not one of the fuel types.` };
  }

  const state = safeStr(b.state, 2);
  if (state && !US_STATE_CODES.includes(state.toUpperCase())) {
    return { error: `"${state}" is not a state.` };
  }

  const nums = [
    ['gallons',         b.gallons,         'Gallons',                  { max: 99999999.99, decimals: 2 }],
    ['mileage',         b.mileage,         'Mileage',                  { max: 99999999999, decimals: 1 }],
    ['beginning_meter', b.beginning_meter, 'Beginning Meter Reading',  { max: 99999999999, decimals: 1 }],
    ['ending_meter',    b.ending_meter,    'Ending Meter Reading',     { max: 99999999999, decimals: 1 }],
  ];
  const out = {};
  for (const [key, raw, label, opts] of nums) {
    const r = parseNum(raw, label, opts);
    if (r.error) return { error: r.error };
    out[key] = r.value;
  }

  const ints = [
    ['truck_number', b.truck_number, 'Truck Number'],
    ['tank_number',  b.tank_number,  'Tank Number'],
  ];
  for (const [key, raw, label] of ints) {
    const r = parseIntField(raw, label);
    if (r.error) return { error: r.error };
    out[key] = r.value;
  }

  // The tank meter wins over anything the body says gallons were. Both pages
  // compute the same figure and show it read-only, so a body that disagrees
  // is a stale client or a hand-made request — neither is a reason to store a
  // gallons figure the meter readings on the same row contradict.
  const metered = gallonsFromMeters(out.beginning_meter, out.ending_meter);
  if (metered != null) out.gallons = metered;

  return {
    data: {
      work_date,
      employee_username: safeStr(b.employee_username, 200),
      fuel_card,
      fuel_type,
      gallons:         out.gallons,
      mileage:         out.mileage,
      truck_number:    out.truck_number,
      beginning_meter: out.beginning_meter,
      ending_meter:    out.ending_meter,
      fueling_site:    safeStr(b.fueling_site, 200),
      city_fueled:     safeStr(b.city_fueled, 120),
      state:           state ? state.toUpperCase() : null,
      tank_number:     out.tank_number,
    },
  };
}

/**
 * The reported fields this row is still missing, by their form labels.
 * Empty array = complete. Reads the column values, so it is equally valid
 * against a normalizeBody result and against a row straight out of the DB.
 */
function missingFields(row) {
  const r = row || {};
  return REPORTED_FIELDS
    .filter(([key]) => r[key] == null || (typeof r[key] === 'string' && r[key].trim() === ''))
    .map(([, label]) => label);
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// NUMERIC columns arrive from the driver as strings. Hand the client numbers
// so it never has to guess whether "0" means zero or means empty — the whole
// meter-reading rule depends on that staying unambiguous all the way out.
function dbToEntry(r) {
  if (!r) return null;
  return {
    id:                 String(r.id),
    user_id:            r.user_id,
    username:           r.username,
    status:             r.status,
    work_date:          safeDate(r.work_date),
    employee_username:  r.employee_username,
    fuel_card:          r.fuel_card,
    fuel_type:          r.fuel_type,
    gallons:            numOrNull(r.gallons),
    mileage:            numOrNull(r.mileage),
    truck_number:       r.truck_number == null ? null : Number(r.truck_number),
    beginning_meter:    numOrNull(r.beginning_meter),
    ending_meter:       numOrNull(r.ending_meter),
    fueling_site:       r.fueling_site,
    city_fueled:        r.city_fueled,
    state:              r.state,
    tank_number:        r.tank_number == null ? null : Number(r.tank_number),
    submitted_at:       r.submitted_at || null,
    approved_at:        r.approved_at  || null,
    approved_by_name:   r.approved_by_name || null,
    created_at:         r.created_at || null,
    updated_at:         r.updated_at || null,
  };
}

async function writeAudit(sql, companyCode, payload, entryId, action, changes, snapshot) {
  try {
    await sql`
      INSERT INTO fuel_audit_log
        (company_code, entry_id, action, user_id, username, changes, snapshot)
      VALUES
        (${companyCode}, ${entryId}, ${action},
         ${payload?.userId || null}, ${payload?.username || null},
         ${changes ? JSON.stringify(changes) : null}::jsonb,
         ${snapshot ? JSON.stringify(snapshot) : null}::jsonb)
    `;
  } catch (err) {
    // Never fail the caller's write over the log of it — an unrecorded
    // approval is a smaller problem than a refused one.
    console.error('[fuel-submissions] audit write failed (non-fatal):', err.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode, userId } = payload;
  const canSubmit = hasDivisionAccess(payload, 'fuel');
  const canAdmin  = hasDivisionAccess(payload, 'fuel_admin') || payload.isPlatformAdmin;

  if (!canSubmit && !canAdmin) {
    return res.status(403).json({ error: 'You do not have access to Fuel Submissions or Fuel Admin' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const q   = req.query || {};

  try {
    // ── GET (list) ────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      // Status accepts one value, the combined sentinel "submitted_approved"
      // (Fuel Admin's default view), or '' for all. Unrolled into two discrete
      // slots so the SQL uses plain equality instead of ANY(array) — some
      // neon-serverless paths mis-bind a JS array for ANY(), making it hang.
      let s1 = '__none__', s2 = '__none__', matchAll = true;
      if (q.status === 'submitted_approved')            { s1 = 'submitted'; s2 = 'approved'; matchAll = false; }
      else if (VALID_STATUSES.includes(q.status))       { s1 = q.status; matchAll = false; }

      const fromF = safeDate(q.from) || '1900-01-01';
      const toF   = safeDate(q.to)   || '9999-12-31';
      const empF  = safeStr(q.employee, 200) || '';
      const cardF = FUEL_CARDS.includes(q.fuel_card) ? q.fuel_card : '';
      const typeF = FUEL_TYPES.includes(q.fuel_type) ? q.fuel_type : '';

      // Whose rows come back. The default is ALWAYS the caller's own — a
      // company-wide read is an explicit opt-in, never something a request
      // falls into by omission.
      //   ?user_id=N   one named submitter (admin only)
      //   ?scope=all   the whole company   (admin only — Fuel Admin's grid)
      // A non-admin asking for either is quietly scoped to themselves rather
      // than refused: there is nothing to reveal, so there is nothing to deny.
      const askedUser   = safeInt(q.user_id);
      const companyWide = canAdmin && askedUser == null && q.scope === 'all';

      let userF = null;
      if (!companyWide) {
        userF = canAdmin && askedUser != null ? askedUser : safeInt(userId);
        // A token carrying no user id owns no rows, and a null filter falling
        // through here would hand back the whole company. Fail closed.
        if (userF == null) return res.status(401).json({ error: 'Unauthorized — please log in' });
      }

      let rows;
      if (userF != null) {
        rows = await sql`
          SELECT * FROM fuel_submissions
          WHERE company_code = ${companyCode}
            AND user_id      = ${userF}
            AND (${matchAll}::boolean OR status = ${s1} OR status = ${s2})
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
            AND (${empF}  = '' OR employee_username = ${empF})
            AND (${cardF} = '' OR fuel_card = ${cardF})
            AND (${typeF} = '' OR fuel_type = ${typeF})
          ORDER BY work_date DESC, created_at DESC
        `;
      } else {
        rows = await sql`
          SELECT * FROM fuel_submissions
          WHERE company_code = ${companyCode}
            AND (${matchAll}::boolean OR status = ${s1} OR status = ${s2})
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
            AND (${empF}  = '' OR employee_username = ${empF})
            AND (${cardF} = '' OR fuel_card = ${cardF})
            AND (${typeF} = '' OR fuel_type = ${typeF})
          ORDER BY work_date DESC, created_at DESC
        `;
      }

      return res.json({ entries: rows.map(dbToEntry) });
    }

    // ── POST (create draft) — field user only ─────────────────────────────
    if (req.method === 'POST' && !q.action) {
      if (!canSubmit) {
        return res.status(403).json({ error: 'Fuel Submissions access is required to create entries' });
      }
      const { data, error } = normalizeBody(req.body || {});
      if (error) return res.status(400).json({ error });

      const [inserted] = await sql`
        INSERT INTO fuel_submissions (
          company_code, user_id, username, status, work_date,
          employee_username, fuel_card, fuel_type, gallons, mileage,
          truck_number, beginning_meter, ending_meter,
          fueling_site, city_fueled, state, tank_number
        ) VALUES (
          ${companyCode}, ${userId}, ${payload.username}, 'draft', ${data.work_date},
          ${data.employee_username}, ${data.fuel_card}, ${data.fuel_type},
          ${data.gallons}, ${data.mileage},
          ${data.truck_number}, ${data.beginning_meter}, ${data.ending_meter},
          ${data.fueling_site}, ${data.city_fueled}, ${data.state}, ${data.tank_number}
        )
        RETURNING *
      `;
      const entry = dbToEntry(inserted);
      await writeAudit(sql, companyCode, payload, inserted.id, 'INSERT', null, entry);
      return res.json({ ok: true, entry });
    }

    // ── POST ?action=submit — draft → submitted ───────────────────────────
    if (req.method === 'POST' && q.action === 'submit') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM fuel_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Submission not found' });
      if (existing.user_id !== userId) {
        return res.status(403).json({ error: 'You can only submit your own fuel entries' });
      }
      if (existing.status !== 'draft') {
        return res.status(409).json({ error: `Cannot submit an entry that is already ${existing.status}` });
      }
      if (!canSubmit) {
        return res.status(403).json({ error: 'Fuel Submissions access is required' });
      }

      // Submit is the gate into Fuel Admin, so this is where completeness
      // stops being optional. A draft is allowed to be half-filled; the thing
      // the office reviews is not.
      const missing = missingFields(existing);
      if (missing.length) {
        return res.status(400).json({
          error: `Fill in every field before submitting — still missing: ${missing.join(', ')}.`,
          missing_fields: missing,
        });
      }

      // Same fill-up sent twice. A retry that lost track of its draft posts a
      // second row instead of reusing the first, and once both are submitted
      // nothing on the card tells them apart — same truck, same day, same
      // gallons, twice. Matched in SQL against the row being submitted so no
      // DATE round-trips through JS and across a timezone on the way.
      const [dupe] = await sql`
        SELECT b.id, b.status FROM fuel_submissions a
        JOIN fuel_submissions b
          ON  b.company_code      = a.company_code
          AND b.work_date         = a.work_date
          AND b.employee_username IS NOT DISTINCT FROM a.employee_username
          AND b.truck_number      IS NOT DISTINCT FROM a.truck_number
          AND b.gallons           IS NOT DISTINCT FROM a.gallons
          AND b.fuel_card         IS NOT DISTINCT FROM a.fuel_card
          AND b.id               <> a.id
          AND (b.status = 'submitted' OR b.status = 'approved')
        WHERE a.id = ${id} AND a.company_code = ${companyCode}
        LIMIT 1
      `;
      if (dupe) {
        return res.status(409).json({
          error: `A ${dupe.status} fuel entry already covers this truck, date, card and gallons. Delete this draft instead of submitting it again.`,
          duplicate_of: String(dupe.id),
        });
      }

      const [updated] = await sql`
        UPDATE fuel_submissions
        SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      const entry = dbToEntry(updated);
      await writeAudit(sql, companyCode, payload, id, 'SUBMIT', null, entry);
      return res.json({ ok: true, entry });
    }

    // ── POST ?action=approve — submitted → approved (Fuel Admin) ──────────
    if (req.method === 'POST' && q.action === 'approve') {
      if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access is required' });
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM fuel_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Submission not found' });
      if (existing.status !== 'submitted') {
        return res.status(409).json({ error: `Only submitted entries can be approved — this one is ${existing.status}` });
      }
      // An admin edit could in principle have emptied a field. Check again
      // rather than assume submit's check still holds.
      const missing = missingFields(existing);
      if (missing.length) {
        return res.status(400).json({
          error: `This entry is missing: ${missing.join(', ')}. Fill it in before approving.`,
          missing_fields: missing,
        });
      }

      const [updated] = await sql`
        UPDATE fuel_submissions
        SET status = 'approved', approved_at = NOW(),
            approved_by_user_id = ${userId}, approved_by_name = ${payload.username},
            updated_at = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      const entry = dbToEntry(updated);
      await writeAudit(sql, companyCode, payload, id, 'APPROVE', null, entry);
      return res.json({ ok: true, entry });
    }

    // ── POST ?action=unapprove — approved → submitted (Fuel Admin) ────────
    if (req.method === 'POST' && q.action === 'unapprove') {
      if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access is required' });
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM fuel_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Submission not found' });
      if (existing.status !== 'approved') {
        return res.status(409).json({ error: `Only approved entries can be un-approved — this one is ${existing.status}` });
      }

      const [updated] = await sql`
        UPDATE fuel_submissions
        SET status = 'submitted', approved_at = NULL,
            approved_by_user_id = NULL, approved_by_name = NULL,
            updated_at = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      const entry = dbToEntry(updated);
      await writeAudit(sql, companyCode, payload, id, 'UNAPPROVE', null, entry);
      return res.json({ ok: true, entry });
    }

    // ── PUT — edit ────────────────────────────────────────────────────────
    if (req.method === 'PUT') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM fuel_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Submission not found' });

      const isOwnDraft = existing.user_id === userId && existing.status === 'draft';
      // Fuel Admins may correct mistakes on both submitted AND approved
      // entries — the audit log records the resulting snapshot either way.
      const isAdminEdit = canAdmin && (existing.status === 'submitted' || existing.status === 'approved');
      if (!isOwnDraft && !isAdminEdit) {
        return res.status(403).json({ error: 'This entry cannot be edited from your account' });
      }

      const { data, error } = normalizeBody(req.body || {});
      if (error) return res.status(400).json({ error });

      // A draft may be emptied out; anything past draft may not. Letting an
      // admin blank a field on a submitted row would put an incomplete entry
      // in front of the office with nothing marking it as such.
      if (!isOwnDraft) {
        const missing = missingFields(data);
        if (missing.length) {
          return res.status(400).json({
            error: `A submitted entry cannot be left incomplete — still missing: ${missing.join(', ')}.`,
            missing_fields: missing,
          });
        }
      }

      const [updated] = await sql`
        UPDATE fuel_submissions SET
          work_date         = ${data.work_date},
          employee_username = ${data.employee_username},
          fuel_card         = ${data.fuel_card},
          fuel_type         = ${data.fuel_type},
          gallons           = ${data.gallons},
          mileage           = ${data.mileage},
          truck_number      = ${data.truck_number},
          beginning_meter   = ${data.beginning_meter},
          ending_meter      = ${data.ending_meter},
          fueling_site      = ${data.fueling_site},
          city_fueled       = ${data.city_fueled},
          state             = ${data.state},
          tank_number       = ${data.tank_number},
          updated_at        = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      const entry = dbToEntry(updated);
      await writeAudit(sql, companyCode, payload, id, isOwnDraft ? 'UPDATE' : 'ADMIN_EDIT', null, entry);
      return res.json({ ok: true, entry });
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    // Field user: their OWN drafts only. Fuel Admin: any row, at any status,
    // recorded with the full pre-delete snapshot.
    if (req.method === 'DELETE') {
      const id = safeInt(q.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM fuel_submissions WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Submission not found' });

      const isOwnDraft = existing.user_id === userId && existing.status === 'draft';
      if (!isOwnDraft && !canAdmin) {
        return res.status(403).json({ error: 'You do not have permission to delete this entry' });
      }

      await sql`DELETE FROM fuel_submissions WHERE id = ${id} AND company_code = ${companyCode}`;
      await writeAudit(sql, companyCode, payload, id, 'DELETE', null, dbToEntry(existing));
      return res.json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[fuel-submissions]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// Internal helpers exposed for unit testing only. Not part of the HTTP
// contract — do not depend on these from other endpoints.
module.exports._test = { normalizeBody, missingFields, isBlank, dbToEntry, gallonsFromMeters, REPORTED_FIELDS };
