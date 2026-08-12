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
 *            ?balance=pending|balanced|issue
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
 *     Fuel-Admin only. Un-approving also returns the entry to 'pending'
 *     balance — the verdict went with the approval it was reached about.
 *
 *   POST   /api/fuel-submissions?action=balance       — the SECOND review
 *     Body: { ids: [...], balance_status, balance_note }
 *     Fuel-Admin only, approved entries only. Bulk: a statement that agrees
 *     clears every fill-up for that truck at once.
 *
 * There are two independent reviews here and they are not the same job.
 * `status` is the daily one: a manager checks what the field sent and
 * approves it. `balance_status` is the monthly one: whoever reconciles
 * against the Guttman and Wex statements marks each approved fill-up
 * 'balanced' once it is accounted for, or 'issue' when it isn't. Every
 * approved entry starts 'pending', which is where most of a month sits.
 *
 *   POST   /api/fuel-submissions?action=import       — backfill
 *     Body: { rows: [...], status: 'approved'|'submitted', batch }
 *     Fuel-Admin only. For a month recorded somewhere else before this form
 *     existed. Every row must be as complete as a submitted one, and a row
 *     that already exists is skipped and named rather than doubled.
 *
 *   POST   /api/fuel-submissions?action=undo_import  — take one back out
 *     Body: { batch }   Fuel-Admin only. Leaves balanced entries alone.
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

// The second review. status says whether the office has approved what the
// field sent; balance_status says whether the month's reconciler has
// accounted for it against a fuel account. They move independently — most of
// a month sits approved-but-pending, which a single status column could not
// express.
const VALID_BALANCE = ['pending', 'balanced', 'issue'];
const MAX_BALANCE_IDS = 1000;

// Backfill. An import lands rows at 'submitted' or 'approved' — never
// 'draft', because a draft belongs to the person still filling it in and
// these have no such person: the fill-up happened, was written down
// somewhere else, and is being put where it belongs after the fact.
const IMPORT_STATUSES = ['submitted', 'approved'];
const MAX_IMPORT_ROWS = 500;

/**
 * The largest difference between two tank meter readings that can be a fill.
 *
 * Not a policy — a fact about the fleet. Across four thousand reported
 * fill-ups the largest figure anyone has ever typed is 197 gallons, and the
 * median is 47. A meter span above this is a digit typed wrong, and it is
 * always the same shape: a fill of 55 recorded as 1055, or 20.2 as 2020.2.
 *
 * Left unchecked the difference REPLACES the driver's figure, so one keystroke
 * turns a 55-gallon fill into four hundred and sixty thousand — and the month
 * it lands in cannot be balanced against anything.
 */
const MAX_METER_FILL = 500;

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Shaped like a date is not the same as being one. The 30th of February
  // gets past the pattern and is refused by the DATE column instead — which
  // surfaces as a 500 with a driver's error message rather than something
  // the office can act on, and on the import path takes the rest of the
  // batch down with it.
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const real = dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
  return real ? s : null;
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
 *   e - b > MAX    a mistyped reading, for the same reason as the two above:
 *                  a difference of four hundred thousand gallons is not a
 *                  fill. See MAX_METER_FILL.
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
  if (e - b > MAX_METER_FILL) return null;
  return Math.round((e - b) * 100) / 100;
}

/**
 * Do a metered figure and a reported one describe the same fill?
 *
 * Two gallons or five per cent, whichever is wider — room for a pump and a
 * tank meter disagreeing about the last splash, and nothing like enough for
 * a digit typed wrong. Every real disagreement seen in four thousand entries
 * has been a round hundred or thousand out, never a rounding.
 */
function metersAgree(metered, reported) {
  if (metered == null || reported == null) return false;
  const m = Number(metered), r = Number(reported);
  if (!Number.isFinite(m) || !Number.isFinite(r)) return false;
  return Math.abs(m - r) <= Math.max(2, Math.abs(r) * 0.05);
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

  // The tank meter wins over anything the body says gallons were — but only
  // where the two are describing the same fill.
  //
  // Both pages derive the figure from the readings and show it, so a form
  // submission agrees by construction. A body that DISAGREES is a fill-up
  // recorded somewhere else, where the two numbers were typed independently
  // and either can be wrong. In four thousand of those the reported figure
  // has been right and the readings wrong, every time — so the reported one
  // stands, and Fuel Admin flags the row so the readings get corrected rather
  // than the gallons quietly restated.
  const metered = gallonsFromMeters(out.beginning_meter, out.ending_meter);
  if (metered != null && (out.gallons == null || metersAgree(metered, out.gallons))) {
    out.gallons = metered;
  }

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

// An import batch id. Generated by the page so every chunk of one file shares
// one, which is what makes the whole load undoable as a unit. Constrained
// because it comes off the wire and is compared against stored rows.
function safeBatch(v) {
  if (v == null) return null;
  const s = String(v).trim();
  // Refused rather than truncated, which is what a length cap would do here.
  // Two ids sharing their first 64 characters would fold into one batch, and
  // undoing either would take both loads out.
  return s && s.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(s) ? s : null;
}

/**
 * What makes two fuel entries the same fill-up.
 *
 * The same five fields the submit path already refuses a second copy of:
 * date, who fueled, truck, card, gallons. Everything else on the row can
 * differ between two records of one purchase — the site typed two ways, a
 * mileage read a mile apart — without them being two purchases.
 *
 * Used twice on the import path, and it has to give the same answer for a
 * row off the wire and a row out of the database, which is why both sides go
 * through the same coercions rather than being compared as they arrive.
 */
function importKey(r) {
  const o = r || {};
  return [
    safeDate(o.work_date) || '',
    String(o.employee_username == null ? '' : o.employee_username).trim(),
    String(o.fuel_card == null ? '' : o.fuel_card).trim(),
    o.truck_number == null ? '' : Number(o.truck_number),
    o.gallons == null ? '' : Number(o.gallons),
  ].join('|');
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
    import_batch:       r.import_batch || null,
    balance_status:     r.balance_status || 'pending',
    balance_note:       r.balance_note || null,
    balanced_at:        r.balanced_at || null,
    balanced_by_name:   r.balanced_by_name || null,
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
    // ── GET ?action=imports — what has been loaded, newest first ──────────
    // Grouped in SQL rather than by pulling every imported row back and
    // folding it here: this is the list a batch gets undone from, and it has
    // to stay cheap enough to load every time the tab is opened, months
    // after the imports it lists.
    if (req.method === 'GET' && q.action === 'imports') {
      if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access is required' });
      const rows = await sql`
        SELECT import_batch AS batch,
               COUNT(*)::int                                            AS entries,
               COUNT(*) FILTER (WHERE balance_status <> 'pending')::int AS balanced,
               MIN(work_date)  AS from_date,
               MAX(work_date)  AS to_date,
               MIN(created_at) AS created_at,
               MIN(username)   AS username
        FROM fuel_submissions
        WHERE company_code = ${companyCode} AND import_batch IS NOT NULL
        GROUP BY import_batch
        ORDER BY MIN(created_at) DESC
        LIMIT 50
      `;
      return res.json({
        imports: rows.map(r => ({
          batch:      r.batch,
          entries:    Number(r.entries),
          balanced:   Number(r.balanced),
          from_date:  safeDate(r.from_date),
          to_date:    safeDate(r.to_date),
          created_at: r.created_at || null,
          username:   r.username || null,
        })),
      });
    }

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
      const balF  = VALID_BALANCE.includes(q.balance) ? q.balance : '';

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
            AND (${balF}  = '' OR balance_status = ${balF})
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
            AND (${balF}  = '' OR balance_status = ${balF})
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

      // Un-approving sends the entry back a stage, so the balancing verdict
      // that was reached about it goes too. A row marked 'balanced' while
      // sitting unapproved would read as accounted-for on a figure the
      // office has withdrawn.
      const [updated] = await sql`
        UPDATE fuel_submissions
        SET status = 'submitted', approved_at = NULL,
            approved_by_user_id = NULL, approved_by_name = NULL,
            balance_status = 'pending', balance_note = NULL,
            balanced_at = NULL, balanced_by_user_id = NULL, balanced_by_name = NULL,
            updated_at = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      const entry = dbToEntry(updated);
      await writeAudit(sql, companyCode, payload, id, 'UNAPPROVE', null, entry);
      return res.json({ ok: true, entry });
    }

    // ── POST ?action=balance — the second review (Fuel Admin) ─────────────
    // Body: { ids: [...], balance_status, balance_note }
    //
    // Bulk by design. The month is reconciled an account at a time, and a
    // statement that agrees clears every fill-up for that truck at once —
    // ticking forty rows one by one is the work this exists to remove.
    if (req.method === 'POST' && q.action === 'balance') {
      if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access is required' });

      const b = req.body || {};
      const status = String(b.balance_status || '');
      if (!VALID_BALANCE.includes(status)) {
        return res.status(400).json({ error: `balance_status must be one of: ${VALID_BALANCE.join(', ')}` });
      }
      const rawIds = Array.isArray(b.ids) ? b.ids : [];
      const ids = [...new Set(rawIds.map(safeInt).filter(n => n != null))];
      if (!ids.length)                  return res.status(400).json({ error: 'No entries were selected.' });
      if (ids.length > MAX_BALANCE_IDS) return res.status(400).json({ error: `That is more than ${MAX_BALANCE_IDS} entries at once.` });

      // A note belongs to an issue. Carrying one onto a balanced row would
      // leave the reason it was once a problem attached to a figure that is
      // no longer one.
      const note = status === 'issue' ? safeStr(b.balance_note, 500) : null;
      // 'pending' is the un-doing of a verdict, so it clears who reached it.
      const stamp = status !== 'pending';

      // Balancing is the stage AFTER approval, so only approved rows are
      // eligible. Marking a submitted entry balanced would account for fuel
      // the office has not agreed to yet.
      // Bound as one comma-separated string and split in SQL rather than as a
      // JS array: some neon-serverless paths mis-bind an array parameter for
      // ANY() and the query hangs rather than failing. Every element has been
      // through safeInt, so the string is digits and commas.
      //
      // One statement, and `skipped` is derived from what it actually wrote.
      // Selecting the eligible rows first and then updating them separately
      // reports on a world that was true a round trip ago: an un-approve
      // landing in between leaves an entry counted as updated when nothing
      // was written to it.
      const idCsv = ids.join(',');
      const updated = await sql`
        UPDATE fuel_submissions
        SET balance_status      = ${status},
            balance_note        = ${note},
            balanced_at         = CASE WHEN ${stamp}::boolean THEN NOW() ELSE NULL END,
            balanced_by_user_id = ${stamp ? userId : null},
            balanced_by_name    = ${stamp ? payload.username : null},
            updated_at          = NOW()
        WHERE company_code = ${companyCode}
          AND id = ANY(string_to_array(${idCsv}, ',')::bigint[])
          AND status = 'approved'
        RETURNING *
      `;
      if (!updated.length) {
        return res.status(409).json({
          error: 'None of those entries are approved yet — balancing comes after the daily review.',
          updated: 0,
        });
      }

      // The audit rows in one statement too. A loop here is one round trip per
      // entry on the exact path the feature is built around — a month of six
      // hundred fill-ups cleared from a single statement match — and it runs
      // AFTER the update has committed, so a timeout would report failure for
      // work that had already succeeded.
      const auditRows = updated.map(row => ({
        entry_id: String(row.id),
        changes:  { balance_status: status, balance_note: note },
        snapshot: dbToEntry(row),
      }));
      try {
        await sql`
          INSERT INTO fuel_audit_log
            (company_code, entry_id, action, user_id, username, changes, snapshot)
          SELECT ${companyCode}, x.entry_id, 'BALANCE', ${userId || null}, ${payload.username || null},
                 x.changes, x.snapshot
          FROM jsonb_to_recordset(${JSON.stringify(auditRows)}::jsonb)
            AS x(entry_id BIGINT, changes JSONB, snapshot JSONB)
        `;
      } catch (err) {
        console.error('[fuel-submissions] balance audit write failed (non-fatal):', err.message);
      }

      const wrote = new Set(updated.map(r => Number(r.id)));
      return res.json({
        ok: true,
        updated: updated.length,
        // Named rather than counted so the page can say WHICH entries it
        // couldn't touch instead of a silent shortfall in the total.
        skipped: ids.filter(id => !wrote.has(id)).map(String),
        entries: updated.map(dbToEntry),
      });
    }

    // ── POST ?action=import — backfill a month (Fuel Admin) ───────────────
    // Body: { rows: [...], status: 'approved'|'submitted', batch }
    //
    // For fuel that was recorded somewhere else before this form existed —
    // a month kept in a spreadsheet, loaded in one go. Every row goes through
    // the SAME normalizeBody the field form's writes do, and must be as
    // complete as a submitted entry: an import is not a back door to a row
    // that could not have been submitted from the page.
    //
    // Rows are attributed two ways at once, and both matter. user_id and
    // username are the admin who loaded the file — they are who to ask about
    // it. employee_username is who actually fueled, off the file, which is
    // what every report and filter reads.
    if (req.method === 'POST' && q.action === 'import') {
      if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access is required to import entries' });

      const b = req.body || {};
      const status = String(b.status || 'approved');
      if (!IMPORT_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${IMPORT_STATUSES.join(', ')}` });
      }
      const rows = Array.isArray(b.rows) ? b.rows : [];
      if (!rows.length)                  return res.status(400).json({ error: 'There are no rows to import.' });
      if (rows.length > MAX_IMPORT_ROWS) return res.status(400).json({ error: `That is more than ${MAX_IMPORT_ROWS} rows in one request.` });

      // A batch id that was sent but doesn't pass is refused rather than
      // replaced with a generated one. Substituting silently would give each
      // chunk of one file a different batch, and the load would stop being
      // one undoable thing at exactly the moment somebody needed it to be.
      if (b.batch != null && b.batch !== '' && !safeBatch(b.batch)) {
        return res.status(400).json({ error: 'batch may only contain letters, digits, dot, dash and underscore.' });
      }
      const batch = safeBatch(b.batch)
        || `imp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

      // Validate everything first, and keep each row's position in the file
      // so the page can point at the line rather than at a count.
      const rejected = [];
      const candidates = [];
      const seen = new Map();
      rows.forEach((raw, index) => {
        const { data, error } = normalizeBody(raw);
        if (error) { rejected.push({ index, error }); return; }
        const missing = missingFields(data);
        if (missing.length) {
          rejected.push({ index, error: `Missing: ${missing.join(', ')}.` });
          return;
        }
        // Two identical rows inside one file. The submit path already treats
        // this as a mistake rather than as two fills, and an import that
        // quietly doubled a truck's month would be found — if at all — as an
        // unexplained variance against the statement weeks later.
        const key = importKey(data);
        if (seen.has(key)) {
          rejected.push({
            index, duplicate_of_row: seen.get(key) + 1,
            error: `Same date, employee, truck, card and gallons as row ${seen.get(key) + 1} of this file.`,
          });
          return;
        }
        seen.set(key, index);
        candidates.push({ index, key, data });
      });

      if (!candidates.length) {
        return res.status(400).json({
          error: 'None of those rows could be imported.',
          batch, created: 0, entries: [], rejected, duplicates: [],
        });
      }

      // One statement for the whole batch. The NOT EXISTS is what makes a
      // re-run safe: loading the same file twice — after a dropped
      // connection, or because nobody was sure the first one landed — adds
      // nothing the second time. It cannot see the rows this same statement
      // is inserting, which is why the within-file pass above exists too.
      const approving = status === 'approved';
      const payloadRows = candidates.map(c => c.data);
      const inserted = await sql`
        INSERT INTO fuel_submissions (
          company_code, user_id, username, status, work_date,
          employee_username, fuel_card, fuel_type, gallons, mileage,
          truck_number, beginning_meter, ending_meter,
          fueling_site, city_fueled, state, tank_number,
          submitted_at, approved_at, approved_by_user_id, approved_by_name,
          import_batch
        )
        SELECT ${companyCode}, ${userId}, ${payload.username}, ${status}, x.work_date,
               x.employee_username, x.fuel_card, x.fuel_type, x.gallons, x.mileage,
               x.truck_number, x.beginning_meter, x.ending_meter,
               x.fueling_site, x.city_fueled, x.state, x.tank_number,
               NOW(),
               CASE WHEN ${approving}::boolean THEN NOW() ELSE NULL END,
               ${approving ? userId : null}, ${approving ? payload.username : null},
               ${batch}
        FROM jsonb_to_recordset(${JSON.stringify(payloadRows)}::jsonb) AS x(
          work_date DATE, employee_username TEXT, fuel_card TEXT, fuel_type TEXT,
          gallons NUMERIC, mileage NUMERIC, truck_number INTEGER,
          beginning_meter NUMERIC, ending_meter NUMERIC,
          fueling_site TEXT, city_fueled TEXT, state TEXT, tank_number INTEGER
        )
        WHERE NOT EXISTS (
          SELECT 1 FROM fuel_submissions f
          WHERE f.company_code      = ${companyCode}
            AND f.work_date         = x.work_date
            AND f.employee_username IS NOT DISTINCT FROM x.employee_username
            AND f.truck_number      IS NOT DISTINCT FROM x.truck_number
            AND f.gallons           IS NOT DISTINCT FROM x.gallons
            AND f.fuel_card         IS NOT DISTINCT FROM x.fuel_card
            AND (f.status = 'submitted' OR f.status = 'approved')
        )
        RETURNING *
      `;

      const entries = inserted.map(dbToEntry);
      // Which candidates did NOT come back. Derived from what the statement
      // actually wrote rather than from a count, so a row held back by the
      // duplicate check is named — the office needs to know WHICH fill-up it
      // already had, not that the total came up short by three.
      const wrote = new Set(entries.map(importKey));
      const duplicates = candidates
        .filter(c => !wrote.has(c.key))
        .map(c => ({
          index: c.index,
          work_date:    c.data.work_date,
          truck_number: c.data.truck_number,
          gallons:      c.data.gallons,
          fuel_card:    c.data.fuel_card,
        }));

      if (entries.length) {
        // After the insert has committed, and in one statement — a loop here
        // is a round trip per row on the one path built for hundreds at a
        // time, and a timeout partway would report failure for entries that
        // are already in the table.
        const auditRows = entries.map(e => ({
          entry_id: e.id,
          changes:  { import_batch: batch, status },
          snapshot: e,
        }));
        try {
          await sql`
            INSERT INTO fuel_audit_log
              (company_code, entry_id, action, user_id, username, changes, snapshot)
            SELECT ${companyCode}, x.entry_id, 'IMPORT', ${userId || null}, ${payload.username || null},
                   x.changes, x.snapshot
            FROM jsonb_to_recordset(${JSON.stringify(auditRows)}::jsonb)
              AS x(entry_id BIGINT, changes JSONB, snapshot JSONB)
          `;
        } catch (err) {
          console.error('[fuel-submissions] import audit write failed (non-fatal):', err.message);
        }
      }

      return res.json({
        ok: true, batch, status,
        created: entries.length,
        entries, duplicates, rejected,
      });
    }

    // ── POST ?action=undo_import — take a whole load back out ──────────────
    // Body: { batch }
    //
    // The other half of importing several hundred rows at once. Finding them
    // again by hand among what the field really did send is not something
    // anyone should have to do to correct a wrong file.
    //
    // Entries that have since been BALANCED are left alone and reported. A
    // verdict was reached about those against a real statement, and quietly
    // deleting accounted-for fuel is a worse outcome than an undo that
    // doesn't finish the job and says so.
    if (req.method === 'POST' && q.action === 'undo_import') {
      if (!canAdmin) return res.status(403).json({ error: 'Fuel Admin access is required' });

      const batch = safeBatch((req.body && req.body.batch) || q.batch);
      if (!batch) return res.status(400).json({ error: 'batch is required' });

      const removed = await sql`
        DELETE FROM fuel_submissions
        WHERE company_code = ${companyCode}
          AND import_batch = ${batch}
          AND balance_status = 'pending'
        RETURNING *
      `;
      const [{ kept }] = await sql`
        SELECT COUNT(*)::int AS kept FROM fuel_submissions
        WHERE company_code = ${companyCode}
          AND import_batch = ${batch}
          AND balance_status <> 'pending'
      `;

      if (!removed.length) {
        return res.status(kept ? 409 : 404).json({
          error: kept
            ? `All ${kept} of those entries have been balanced — undo would delete fuel that has already been accounted for. Set them back to pending first.`
            : 'That import is not here — it may already have been undone.',
          deleted: 0, kept,
        });
      }

      const auditRows = removed.map(r => ({
        entry_id: String(r.id),
        changes:  { import_batch: batch },
        snapshot: dbToEntry(r),
      }));
      try {
        await sql`
          INSERT INTO fuel_audit_log
            (company_code, entry_id, action, user_id, username, changes, snapshot)
          SELECT ${companyCode}, x.entry_id, 'IMPORT_UNDO', ${userId || null}, ${payload.username || null},
                 x.changes, x.snapshot
          FROM jsonb_to_recordset(${JSON.stringify(auditRows)}::jsonb)
            AS x(entry_id BIGINT, changes JSONB, snapshot JSONB)
        `;
      } catch (err) {
        console.error('[fuel-submissions] undo audit write failed (non-fatal):', err.message);
      }

      return res.json({ ok: true, batch, deleted: removed.length, kept });
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

      // Correcting a figure a reconciliation was signed off on un-signs it.
      // The same invariant un-approving enforces: a row cannot go on reading
      // 'balanced by office' once the number the office balanced has changed
      // underneath it — and this workflow expects entries to be corrected
      // after a match, so it is the normal case rather than a corner one.
      //
      // Only the four fields a statement is matched on count. Fixing a
      // misspelt city has nothing to do with whether the gallons were
      // accounted for, and throwing the verdict away for it would make the
      // reconciler redo work over a typo.
      const BALANCE_KEYS = ['work_date', 'gallons', 'truck_number', 'fuel_card'];
      // NUMERIC comes back from the driver as a string and a DATE as a Date,
      // so both sides have to be brought to one form before they can be
      // compared. Written out rather than as `Number(v) || v`, which reads a
      // truck numbered 0 or a zero-gallon correction as unchanged — the
      // falsy-zero trap this whole feature has already been bitten by once.
      const norm = (k, v) => {
        if (v == null) return null;
        if (k === 'work_date') return safeDate(v);
        if (k === 'gallons' || k === 'truck_number') {
          const n = Number(v);
          return Number.isFinite(n) ? String(n) : String(v);
        }
        return String(v);
      };
      const wasBalanced  = (existing.balance_status || 'pending') !== 'pending';
      const figureMoved  = BALANCE_KEYS.some(k => norm(k, existing[k]) !== norm(k, data[k]));
      const resetBalance = wasBalanced && figureMoved;

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
          balance_status      = CASE WHEN ${resetBalance}::boolean THEN 'pending' ELSE balance_status END,
          balance_note        = CASE WHEN ${resetBalance}::boolean THEN NULL ELSE balance_note END,
          balanced_at         = CASE WHEN ${resetBalance}::boolean THEN NULL ELSE balanced_at END,
          balanced_by_user_id = CASE WHEN ${resetBalance}::boolean THEN NULL ELSE balanced_by_user_id END,
          balanced_by_name    = CASE WHEN ${resetBalance}::boolean THEN NULL ELSE balanced_by_name END,
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
module.exports._test = {
  normalizeBody, missingFields, isBlank, dbToEntry, gallonsFromMeters,
  importKey, safeBatch, REPORTED_FIELDS, MAX_IMPORT_ROWS,
};
