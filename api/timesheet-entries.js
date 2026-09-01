'use strict';
/**
 * Timesheet entries — field-employee time submissions.
 *
 *   GET    /api/timesheet-entries                       — list entries
 *     Defaults to the caller's OWN rows, for every caller including payroll
 *     admins. Reading past your own time is an explicit opt-in, so a page that
 *     forgets to scope shows too little rather than the whole company.
 *     Query: ?status=draft|submitted|approved
 *            ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *            ?user_id=N      (admin only — one named user)
 *            ?scope=all      (admin only — every user in the company)
 *            ?division=X     (admin only — filter by which division was worked)
 *
 *   POST   /api/timesheet-entries                       — create draft
 *     Body matches entry shape; status forced to 'draft'.
 *     Field-user only (requires divisionRoles.timesheet access).
 *     A day split across two jobs is TWO of these calls, one per job, sharing a
 *     split_group_id (see normalizeSplitTag) — there is no multi-job entry
 *     shape, so payroll reviews each job as its own ordinary entry.
 *
 *   PUT    /api/timesheet-entries?id=N                  — update entry
 *     Field user  → own row, only if status='draft'
 *     Payroll admin → any row with status='submitted' (logs as ADMIN_EDIT)
 *
 *   POST   /api/timesheet-entries?action=submit&id=N    — draft → submitted
 *     Field-user only, must own the row, row must be in 'draft'.
 *
 *   POST   /api/timesheet-entries?action=approve&id=N   — submitted → approved
 *     Payroll-admin only, row must be in 'submitted'. For turf/paving daily
 *     entries the body MUST include a `split: [...]` array — each element is
 *     { cost_code, sub_code, equipment, labor_hours, equip_hours, quantity, is_travel }.
 *     sum(labor_hours) across the array must equal computed_hours + travel_hours.
 *     On success, one daily_tracking row is inserted per split element, tagged
 *     with timesheet_entry_id.
 *     For quarry daily entries the body MUST include a `quarry: {...}` object of
 *     the activity-specific value fields (daily: rate, fuelGallons, ppg,
 *     equipment/task; crushing: hourlyRate, hoursCrushing, fuelGallons,
 *     fuelCost, loadsToCrusher, tonsPerLoad, comments). The activity + location
 *     come from the job_id ("<activity>:<locationId>"); the row's hours are
 *     pinned to the entry's computed (work) hours. On success one row is
 *     appended to the fct_quarry_daily / fct_quarry_crushing blob (and mirrored
 *     to the normalized table), with its id prefixed "tsq-<entryId>-".
 *     For trucking daily entries the body MAY include a `trucking` object
 *     ({ haul_fee, division, unit }, all optional) — a Truck Tracking row is
 *     autofilled from the entry (driver ← employee, date, start/end, hours,
 *     customer ← job_label) and appended to the fct_truck_division blob (and
 *     mirrored to truck_division_entries), with its id prefixed "tst-<entryId>-".
 *     Haul fee and the division column come from payroll's modal; `unit` is
 *     pre-filled there from the entry, and a value sent back is written onto
 *     the entry's truck_unit as well as the row. Omitting `unit` (bulk approve)
 *     keeps the entry's own. Omitting `haul_fee` — bulk approve again, whose
 *     one box cannot price a card spanning customers — bills the haul at that
 *     customer's rate from the Trucking tab's Manage Lists; a fee sent blank is
 *     payroll's own answer and posts the row unpriced.
 *     A dust customer haul may send `dust` as { rows: [...] }, one element per
 *     haul the day was split into. Each carries `dest` — "dust" for the Dust
 *     Control Tracking grid (vehicle rates x hours + UB gallons) or "ob" for
 *     Other Billing (quantity x price per unit + trucking hours x rate) — and
 *     the leg's own columns for whichever it names. The array is the whole
 *     day's hauls in order, and its INDEX is the leg: both grids number from
 *     it, so a haul re-pointed at the other tab keeps its place and its
 *     Intercompany history moves with it instead of duplicating. Absent `dest`
 *     means the tracking grid, which is what bulk approve and every client
 *     predating the toggle send.
 *     For dust daily entries NO body is needed either — an "EES Other" row is
 *     autofilled from the entry (driver, date, start/end, hours, customer ←
 *     job_label, comments ← notes) and appended to the dust_ees_other_rows
 *     blob, with its id prefixed "tse-<entryId>-". Unit / location / name / job
 *     number / billing come from the timesheet's own EES fields; only the
 *     billing rate is left for the dust office. Approving also clears any
 *     Intercompany removal recorded against the row, so re-approving puts
 *     previously-deleted work back rather than being overruled by it.
 *
 *   POST   /api/timesheet-entries?action=resplit&id=N   — replace injected rows
 *     Payroll-admin only, row must already be 'approved'. Same body shape as
 *     approve. For turf/paving: deletes the prior injected daily_tracking rows
 *     then inserts the new split. For quarry: rewrites the injected blob row.
 *     Status stays 'approved'.
 *
 *   POST   /api/timesheet-entries?action=unapprove&id=N — approved → submitted
 *     Payroll-admin only. Deletes any injected daily_tracking rows (turf/paving),
 *     any injected fct_quarry_* blob rows (quarry), and any injected
 *     fct_truck_division rows (trucking), then reverts status. Used when an
 *     approval needs to be re-done from scratch. Removing a Truck Tracking row
 *     also pulls its Intercompany billing entry — see removeTruckingRows for
 *     why an un-approval does not otherwise stick.
 *
 *   GET    /api/timesheet-entries?action=split&id=N     — current injected rows
 *     Returns the existing split (one element per daily_tracking row linked to
 *     this entry) so the payroll modal can pre-fill when re-editing.
 *
 *   DELETE /api/timesheet-entries?id=N                  — delete own draft
 *     Field-user only, must own the row, row must be in 'draft'.
 *
 * The server is the source of truth for:
 *   - status transitions (clients cannot set status directly)
 *   - computed_hours (recomputed from start_time/end_time on every write)
 *   - user_id / username / company_code (taken from JWT, never the body)
 *
 * timesheet_entries is the payroll source of truth. Approval is the only bridge
 * out of it: turf/paving/quarry/trucking/dust daily entries inject cost-tracking
 * rows on approval (see the approve/unapprove actions below). Dust is the one
 * division that routes by job rather than by division alone — the two standing
 * EES activities go to the Dust division's "EES Other" tab, and customer work
 * is billed by the dust office off one of its own two grids. A dust entry with
 * no job stays isolated (status flip only).
 *
 * Dust customer work is also the one place the route is finer than the entry.
 * The same driver, truck and clock window is either UB on a well pad or a
 * delivery of material, and the dust office invoices those off two different
 * grids on two different bases — so the approving supervisor answers it PER
 * HAUL in the modal, and each haul posts its billing row in the grid its answer
 * names.
 *
 * That answer also decides whether the haul reaches Truck Tracking at all. UB
 * on a pad does not: the dust office records it, prices it off vehicle rates
 * times hours and invoices it, end to end, and a second copy of the same haul
 * in Truck Tracking was work nobody in that division did — undeletable from the
 * tab, and a standing invitation to bill it twice. A material delivery does:
 * Other Billing prices the material, and the hauling of it is the trucking
 * office's line. See postsHere in insertTruckingRows.
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');
const { syncForKey } = require('./lib/sync-normalized');
// Identity + lifecycle rules for the Truck Tracking rows this file injects.
// Shared with api/truck-division.js, which sweeps rows that outlived their
// entry on read — see the header of that module for why they live in one place.
const {
  TRUCK_DIVISION_BLOB,
  IC_SOURCE_TRUCKING,
  isEesJob,
  needsTruckTrackingRow,
  truckingRowIdPrefix,
  truckingRowId,
  truckRowLegIndex,
  removeIcBillingEntries,
  TRUCK_TAB_FIELDS,
  MAX_INJECTED_LEGS,
  maxTaskNumber,
  formatTaskNumber,
} = require('./lib/truck-injected');
// The same rules for the Dust Control Tracking row a dust customer haul also
// injects. Shared with api/dust-rows.js, which sweeps rows that outlived their
// entry on read and refuses the dust tab's writes against a payroll row.
const {
  IC_SOURCE_DUST,
  DUST_TAB_FIELDS,
  MAX_DUST_ROWS,
  needsDustTrackingRow,
  dustRowIdPrefix,
  dustRowId,
  dustRowIndexFromId,
  deleteDustRows,
} = require('./lib/dust-injected');
// The same rules for the Dust "Other Billing" row a MATERIAL haul posts instead
// of the tracking one. Which of the two a haul lands in is answered per leg in
// the approve modal — see needsObRow — so both live behind the same entry-level
// gate and are written, pruned and swept together.
const {
  OB_BLOB_KEY,
  IC_SOURCE_OB,
  OB_TAB_FIELDS,
  MAX_OB_ROWS,
  obRowIdPrefix,
  obRowId,
  obRowIndexFromId,
  deleteObRows,
} = require('./lib/dust-ob-injected');
// The tag EES Other rows carry in the shared Intercompany list. Named off the
// shared enum rather than spelled out at each use: the string appeared inline
// in three places, and a fourth destination billing under a typo of it would
// mirror into Intercompany as a division nothing rolls up.
const { IC_SOURCES } = require('./lib/ic-sources');
const IC_SOURCE_EES_OTHER = IC_SOURCES.DUST_EES_OTHER;

const VALID_DIVISIONS = ['turf', 'dust', 'paving', 'kiewit', 'trucking', 'quarry'];
const VALID_TIME_OFF  = ['vacation', 'sick', 'jury_duty', 'bereavement', 'holiday'];

// Auto-inject into daily_tracking is only meaningful for divisions whose cost
// tracking lives there (rows per project). Turf and paving qualify; the other
// divisions either store labor elsewhere or don't track per-project cost.
const AUTO_INJECT_DIVISIONS = ['turf', 'paving', 'kiewit'];

// Quarry auto-injects too, but into the quarry division's OWN cost tracking —
// the fct_quarry_daily / fct_quarry_crushing app_data blobs (mirrored to
// quarry_daily_entries / quarry_crushing_entries by sync-normalized.js), NOT
// daily_tracking. The activity (which tab) + location are encoded in the
// timesheet job_id as "<activity>:<locationId>" by timesheet-jobs.js.
const QUARRY_ACTIVITY_KEY = { daily: 'fct_quarry_daily', crushing: 'fct_quarry_crushing' };

// Split "tsq-<entryId>-<stamp>" back into its entry id, and let us find every
// quarry blob row injected from one timesheet entry. Encoded into the row `id`
// (not a side field) because quarry.html's normalizeDailyRow/normalizeCrushRow
// drop unknown keys but always preserve `id`.
function quarryRowIdPrefix(entryId) { return `tsq-${entryId}-`; }

// Trucking auto-injects too, but into the Trucking division's OWN "Truck
// Tracking" tab — the fct_truck_division app_data blob (mirrored to the
// truck_division_entries table by api/truck-division.js). Nearly every value is
// autofilled from the timesheet entry; payroll's modal supplies the haul fee and
// the division column, and can correct the unit the driver entered (or supply
// the one they left off) — see validateTruckingInjection. Injected rows are
// tagged by encoding the timesheet entry id into the row id (same scheme as
// quarry) so unapprove/delete can find and remove them again — see
// truckingRowId in lib/truck-injected.js for why that id must stay stable
// across a re-approval.
//
// Dust customer work lands here too — see needsTruckTrackingRow, imported above.

// Dust auto-injects into the Dust division's "EES Other" tab — the
// dust_ees_other_rows app_data blob. Like trucking there are NO payroll-entered
// fields: every value is autofilled from the timesheet entry, and the tab-owned
// columns (unit, location, name, job number, billing, rate) are filled in later
// by the dust office. Rows exist ONLY because a timesheet entry was approved —
// the tab never creates or deletes them, which is what makes the client's
// save-merge safe. Tagged by encoding the entry id into the row id, same scheme
// as quarry and trucking, so unapprove/delete can find them again.
const DUST_EES_OTHER_BLOB = 'dust_ees_other_rows';
function eesOtherRowIdPrefix(entryId) { return `tse-${entryId}-`; }

/**
 * The id for leg `index` (1-based) of an entry's EES Other rows.
 *
 * Two different kinds of row share this prefix, and they cannot collide because
 * they cannot come from the same entry: an entry on a standing EES activity
 * posts exactly one row for the day, while a dust CUSTOMER haul posts one per
 * leg billed off "Other Billing - Non Billable". Leg 1 keeps the historic "row"
 * suffix either way, so every row posted before a customer haul could land here
 * keeps the id its Intercompany history is filed under. Same scheme, and the
 * same reason, as dustRowId.
 */
function eesOtherRowId(entryId, index = 1) {
  const n = Number(index) || 1;
  return n <= 1 ? `${eesOtherRowIdPrefix(entryId)}row` : `${eesOtherRowIdPrefix(entryId)}${n}`;
}

// The 1-based leg an EES Other id names, or null when the id names no leg this
// file could have minted. Bounded rather than clamped, for the reason
// dustRowIndexFromId gives: what this returns is handed to the approve modal,
// and anything the modal shows, it saves.
function eesOtherRowIndexFromId(rowId) {
  const m = /^tse-\d+-(row|[1-9]\d*)$/.exec(String(rowId || ''));
  if (!m) return null;
  if (m[1] === 'row') return 1;
  const n = Number(m[1]);
  return (Number.isInteger(n) && n >= 2 && n <= MAX_DUST_ROWS) ? n : null;
}

/**
 * True when this entry could have rows in the EES Other tab.
 *
 * Two different things put them there and the teardown paths must find both:
 * the single row an entry on a standing EES ACTIVITY posts, and the per-leg
 * rows a dust CUSTOMER haul posts for every haul billed off "Other Billing -
 * Non Billable". Un-approve, delete and the edit guard used to ask isEesJob,
 * which is only the first of those — so a customer haul's rows would have
 * outlived the entry that made them, in a tab that creates and deletes nothing
 * and could never have removed them.
 *
 * Deliberately wider than either gate: any dust entry at all. Every removal
 * behind it is keyed on the "tse-<entryId>-" prefix, so asking on an entry that
 * has none costs one blob read and finds nothing — and the alternative, a
 * predicate that has to stay in step with two injection gates at once, is
 * exactly the drift that stranded rows before.
 */
function couldHaveEesOtherRows(entry) {
  return !!entry && entry.division === 'dust';
}

// The two standing EES activities are encoded by api/timesheet-jobs.js and named
// in lib/truck-injected.js (isEesJob, imported above) — the dust EES gate and the
// Truck Tracking gate are two halves of one routing decision, so they read one
// list. Only a dust entry on one of these becomes an EES Other row; an ordinary
// dust customer entry routes to Truck Tracking, as it always has.

// The one column the EES Other tab owns rather than the timesheet: the hourly
// rate a Billable row bills at. Everything else on the row is timesheet-fed, so
// a re-injection must preserve this and overwrite the rest.
const EES_OTHER_TAB_FIELDS = ['rate'];

// The two values the tab's Billing column accepts, mirroring the select in
// timesheet.html. Intercompany only picks up rows marked Billable, so a typo
// arriving as a third value would silently un-bill the day — the validator
// below refuses it rather than writing it.
const EES_BILLING_VALUES = ['Non-Billable', 'Billable'];

/**
 * Validate the six EES columns a standing-EES day carries onto its row.
 *
 * Two doors open onto these columns — the driver's form (through
 * normalizeEntryBody) and payroll's Edit Row (through action=resplit) — so the
 * caps here are deliberately normalizeEntryBody's. Drift them and the same
 * value is accepted at one door and truncated at the other, which reads as the
 * office losing a job number it definitely typed.
 *
 * Blank comes back as null, not '': that is what the columns hold for "not
 * filled in", and insertEesOtherRow falls back to the job label for a customer
 * left empty. Billing alone defaults rather than nulls, because a row with no
 * billing state is one Intercompany would have to guess about.
 */
function validateEesInjection(raw) {
  const e = (raw && typeof raw === 'object') ? raw : {};
  const billing = safeStr(e.billing, 50) || 'Non-Billable';
  if (!EES_BILLING_VALUES.includes(billing)) {
    return { error: `billing must be one of: ${EES_BILLING_VALUES.join(', ')}` };
  }
  return { fields: {
    unit:       safeStr(e.unit, 100),
    customer:   safeStr(e.customer, 500),
    location:   safeStr(e.location, 500),
    name:       safeStr(e.name, 500),
    job_number: safeStr(e.job_number, 100),
    billing,
  } };
}

function safeDate(v) {
  if (!v) return null;
  // A DATE column comes back from the driver as a Date at LOCAL midnight, so
  // toISOString() — which converts to UTC — moves the day backwards anywhere
  // east of Greenwich. Read the local components instead: the value has no
  // time-of-day to lose, and the answer no longer depends on where the process
  // is running. (Vercel runs UTC, so this only ever bit dev and self-hosting.)
  if (v instanceof Date) {
    const y  = v.getFullYear();
    const mo = String(v.getMonth() + 1).padStart(2, '0');
    const d  = String(v.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function safeTime(v) {
  if (!v) return null;
  const s = String(v).trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

/**
 * Compute decimal hours between two "HH:MM" strings, handling overnight.
 * Returns null if either side is missing/invalid. Caps at 24h.
 */
function computeHours(start, end) {
  const s = safeTime(start);
  const e = safeTime(end);
  if (!s || !e) return null;
  const [sh, sm] = s.split(':').map(Number);
  const [eh, em] = e.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // overnight shift
  if (mins > 24 * 60) mins = 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

function safeStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}

function safeBool(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return null;
}

// The hauling answer, normalized to what the CHECK constraint admits.
// Anything the form did not ask — a non-driver, an older client, an entry that
// predates the question — comes back null, which every reader treats as
// ordinary work. An unrecognized string is null for the same reason: guessing
// between 'on site' and 'to and from' would silently move a man's hours
// between prevailing and standard, so an answer we cannot read is no answer.
const HAUL_TYPES = new Set(['on_site', 'off_site']);
function safeHaulType(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return HAUL_TYPES.has(s) ? s : null;
}

function safeInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Parse a decimal-hour leg (travel time). Anything non-numeric, negative,
// or beyond 24h is treated as "not provided" — null. Rounded to 0.01h so
// the value matches the NUMERIC(6,2) column without surprising truncation.
function safeHours(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 24) return null;
  return Math.round(n * 100) / 100;
}

function dbToEntry(r) {
  return {
    id:                  String(r.id),
    user_id:             r.user_id,
    username:            r.username,
    employee_id:         r.employee_id,
    entry_type:          r.entry_type,
    work_date:           safeDate(r.work_date) || '',
    status:              r.status,
    division:            r.division || '',
    job_id:              r.job_id || '',
    job_label:           r.job_label || '',
    start_time:          r.start_time || '',
    end_time:            r.end_time || '',
    computed_hours:        r.computed_hours != null ? Number(r.computed_hours) : null,
    travel_to_site_hours:  r.travel_to_site_hours != null ? Number(r.travel_to_site_hours) : null,
    travel_to_shop_hours:  r.travel_to_shop_hours != null ? Number(r.travel_to_shop_hours) : null,
    travel_hours:          r.travel_hours != null ? Number(r.travel_hours) : null,
    lunch_break:           r.lunch_break,
    operated_equipment:  r.operated_equipment,
    haul_type:           r.haul_type || '',
    supervisor_id:       r.supervisor_id,
    supervisor_name:     r.supervisor_name || '',
    notes:               r.notes || '',
    time_off_type:       r.time_off_type || '',
    truck_unit:          r.truck_unit || '',
    truck_description:   r.truck_description || '',
    ees_unit:            r.ees_unit || '',
    ees_customer:        r.ees_customer || '',
    ees_location:        r.ees_location || '',
    ees_name:            r.ees_name || '',
    ees_job_number:      r.ees_job_number || '',
    ees_billing:         r.ees_billing || '',
    // Split-day tag. Set only when this row was submitted as one job of a
    // multi-job day (see normalizeSplitTag); null on every ordinary entry.
    split_group_id:      r.split_group_id || '',
    split_index:         r.split_index != null ? Number(r.split_index) : null,
    split_count:         r.split_count != null ? Number(r.split_count) : null,
    submitted_at:        r.submitted_at,
    approved_at:         r.approved_at,
    approved_by_user_id: r.approved_by_user_id,
    approved_by_name:    r.approved_by_name || '',
    created_at:          r.created_at,
    updated_at:          r.updated_at,
  };
}

// ── Prevailing-wage lookup ────────────────────────────────────────────────
// The prevailing-wage flag lives on the project blob in app_data, not on the
// timesheet row. Only turf/paving keep their projects there — keyed
// fct_project_<id> / fct_paving_project_<id> — with a top-level
// `prevailing_wage` boolean; the other divisions' "jobs" are customers or
// locations with no such concept. Resolve it for a whole batch of entries
// with a single app_data read (same key = ANY(...) pattern timesheet-jobs.js
// uses) so the payroll list can show Yes/No per row.
const PW_PROJECT_PREFIX = { turf: 'fct_project_', paving: 'fct_paving_project_', kiewit: 'fct_kiewit_project_' };

// Roster blob (employees + equipment) per division. turf uses the shared
// fct_lists; paving and kiewit each keep their own roster blob. Any division
// not listed falls back to the turf roster.
const DIVISION_LISTS_KEY = { turf: 'fct_lists', paving: 'fct_paving_lists', kiewit: 'fct_kiewit_lists' };

// app_data key for an entry's project, or null when its division has no
// prevailing-wage concept (or the entry has no job attached).
function pwProjectKey(companyCode, entry) {
  const prefix = PW_PROJECT_PREFIX[entry.division];
  return prefix && entry.job_id ? `${companyCode}:${prefix}${entry.job_id}` : null;
}

// Sets `prevailing_wage` on every entry (mutates in place):
//   true / false → resolved from the project blob (false when the blob is
//                  missing, matching how rate auto-fill treats a gone project)
//   null         → division has no prevailing-wage concept / no job attached
async function attachPrevailingWage(sql, companyCode, entries) {
  const keys = [...new Set(
    entries.map(e => pwProjectKey(companyCode, e)).filter(Boolean),
  )];

  const pwByKey = new Map();
  if (keys.length) {
    const rows = await sql`SELECT key, value FROM app_data WHERE key = ANY(${keys})`;
    for (const r of rows) {
      const blob = r.value;
      pwByKey.set(r.key, !!(blob && typeof blob === 'object' && blob.prevailing_wage === true));
    }
  }

  for (const e of entries) {
    const key = pwProjectKey(companyCode, e);
    e.prevailing_wage = key == null ? null : (pwByKey.has(key) ? pwByKey.get(key) : false);
  }
  return entries;
}

// Standard single-entry write response. Resolves prevailing_wage (the field
// attachPrevailingWage adds for the list view) so a client that splices the
// returned entry straight into its local cache — e.g. payroll's
// applyEntryUpdate after approve/edit/unapprove — keeps the Yes/No flag and
// the prevailing-hours report accurate without a full refetch, and stays
// correct even when an admin edit changed the job. `extra` merges in any
// additional top-level keys (e.g. removed_split_rows).
async function entryJson(sql, companyCode, row, extra) {
  const [entry] = await attachPrevailingWage(sql, companyCode, [dbToEntry(row)]);
  return Object.assign({ ok: true, entry }, extra || {});
}

// ── Split helpers (timesheet → daily_tracking auto-injection) ─────────────
// A "split" is the supervisor's breakdown of a single approved timesheet
// entry into one or more daily_tracking rows. The supervisor picks cost
// codes, sub codes, equipment and hours; each split row becomes a
// daily_tracking row tagged with the timesheet_entry_id.

// Round to 0.01 to match NUMERIC(14,4) without surprising precision drift.
function _r2(n) { return Math.round(Number(n) * 100) / 100; }

// ── Roster lookup ─────────────────────────────────────────────────────────
// The roster blob stores display names ("Zach Brewer"); the timesheet carries
// whatever the field employee signs in as, and companies build logins
// differently — "mowery" (surname), "zachbrewer" (first+last), "brewerzach"
// (last+first), "zbrewer" (initial+last). This used to try the name verbatim
// and then a " surname" suffix, which covers only the first of those; every
// other shape fell through and the injected row got no job class and a $0 rate.
//
// Forms are tried in descending confidence, and a stage only counts when
// exactly one roster entry matches it — an ambiguous crew must never silently
// inherit someone else's pay rate.
function _rosterKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Doubled letters are where these two systems disagree in practice: the roster
// reads "Matt Shufstall" while the login is "shuffstallmatt", or "Kevin
// Cippolini" while the login is "cipollini". Collapsing runs of the same letter
// on BOTH sides bridges that. It is a normalization, not a fuzzy match — every
// stage below still has to hit exactly, and still has to hit exactly once, so
// this cannot start handing one person another's pay rate.
function _collapseDoubles(s) { return String(s).replace(/(.)\1+/g, '$1'); }

function matchRosterEmployee(blobEmps, employeeName) {
  const cand = (Array.isArray(blobEmps) ? blobEmps : [])
    .filter(e => e && typeof e === 'object' && String(e.name || '').trim());
  // Exact spellings first across every stage; only if nothing lands anywhere
  // do we retry the whole cascade with doubled letters collapsed.
  return _matchRoster(cand, employeeName, _rosterKey)
      || _matchRoster(cand, employeeName, s => _collapseDoubles(_rosterKey(s)));
}

function _matchRoster(cand, employeeName, key) {
  const login = key(employeeName);
  if (!login) return null;
  const wordsOf = e => String(e.name).trim().split(/\s+/).map(key).filter(Boolean);
  const only = list => (list.length === 1 ? list[0] : null);

  // 1. the roster name IS the login, punctuation and case aside
  const exact = cand.filter(e => key(e.name) === login);
  if (exact.length) return exact[0];

  // 2. the login is the name's words run together, either way round
  const joined = cand.filter(e => {
    const w = wordsOf(e);
    if (w.length < 2) return false;
    return w.join('') === login
        || [...w].reverse().join('') === login
        || (w[0] + w[w.length - 1]) === login
        || (w[w.length - 1] + w[0]) === login;
  });
  if (only(joined)) return joined[0];

  // 3. the login is the surname on its own
  const surname = cand.filter(e => {
    const w = wordsOf(e);
    return w.length > 1 && w[w.length - 1] === login;
  });
  if (only(surname)) return surname[0];

  // 4. first initial + surname, either way round
  const initial = cand.filter(e => {
    const w = wordsOf(e);
    if (w.length < 2 || !w[0]) return false;
    return (w[0][0] + w[w.length - 1]) === login
        || (w[w.length - 1] + w[0][0]) === login;
  });
  if (only(initial)) return initial[0];

  // 5. surname exact, first name shortened — "shuffstallmatt" against a roster
  // that spells him "Matthew Shuffstall". The surname has to match in full and
  // the leftover has to be the start of the first name, at least two letters of
  // it, so this cannot reach past the initial-only case above.
  const shortened = cand.filter(e => {
    const w = wordsOf(e);
    if (w.length < 2 || !w[0]) return false;
    const first = w[0], last = w[w.length - 1];
    if (login.startsWith(last)) {
      const rest = login.slice(last.length);
      return rest.length >= 2 && first.startsWith(rest);
    }
    if (login.endsWith(last)) {
      const rest = login.slice(0, login.length - last.length);
      return rest.length >= 2 && first.startsWith(rest);
    }
    return false;
  });
  return only(shortened);
}

/**
 * Normalize one split row from the request body. Returns { row, error }.
 * Each row contributes either labor_hours (>0) and/or equip_hours (>0).
 * is_travel is a UI-only marker that we forward to a flag column —
 * server-side it has no special validation beyond "you can mark it".
 */
function normalizeSplitRow(raw, idx) {
  if (!raw || typeof raw !== 'object') {
    return { error: `split[${idx}] must be an object` };
  }
  const cost_code = safeStr(raw.cost_code, 255);
  const sub_code  = safeStr(raw.sub_code,  255);
  const equipment = safeStr(raw.equipment, 255);
  const labor_hours = raw.labor_hours == null || raw.labor_hours === '' ? 0 : Number(raw.labor_hours);
  const equip_hours = raw.equip_hours == null || raw.equip_hours === '' ? 0 : Number(raw.equip_hours);
  const quantity    = raw.quantity    == null || raw.quantity    === '' ? 0 : Number(raw.quantity);
  if (!Number.isFinite(labor_hours) || labor_hours < 0 || labor_hours > 24) {
    return { error: `split[${idx}].labor_hours must be between 0 and 24` };
  }
  if (!Number.isFinite(equip_hours) || equip_hours < 0 || equip_hours > 24) {
    return { error: `split[${idx}].equip_hours must be between 0 and 24` };
  }
  // Upper bound guards the NUMERIC(14,4) daily_tracking.quantity column (max
  // < 1e10). Without it a fat-fingered quantity overflows on INSERT, and since
  // insertSplitRows writes each row as its own autocommitted statement, an
  // overflow on a later row orphans the earlier ones. 1e9 is far above any real
  // bid quantity while staying clear of the column ceiling.
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1e9) {
    return { error: `split[${idx}].quantity must be between 0 and 1,000,000,000` };
  }
  if (labor_hours <= 0 && equip_hours <= 0) {
    return { error: `split[${idx}] must have labor_hours or equip_hours greater than 0` };
  }
  if (!cost_code && !sub_code) {
    return { error: `split[${idx}] needs at least a cost code or sub code` };
  }
  return {
    row: {
      cost_code,
      sub_code,
      equipment,
      labor_hours: _r2(labor_hours),
      equip_hours: _r2(equip_hours),
      quantity:    Math.round(quantity * 10000) / 10000,
      is_travel:   raw.is_travel === true,
    },
  };
}

/**
 * Validate the full split against the timesheet entry hours.
 * sum(labor_hours across all split rows) must equal computed_hours + travel_hours
 * exactly (to the cent). Returns { rows, error }.
 */
function validateSplit(rawSplit, entry) {
  if (!Array.isArray(rawSplit) || rawSplit.length === 0) {
    return { error: 'split must be a non-empty array of rows' };
  }
  if (rawSplit.length > 50) {
    return { error: 'split may not contain more than 50 rows' };
  }
  const rows = [];
  for (let i = 0; i < rawSplit.length; i++) {
    const { row, error } = normalizeSplitRow(rawSplit[i], i);
    if (error) return { error };
    rows.push(row);
  }
  const work   = Number(entry.computed_hours) || 0;
  const travel = Number(entry.travel_hours)   || 0;
  const expected = _r2(work + travel);
  const actual   = _r2(rows.reduce((s, r) => s + r.labor_hours, 0));
  if (Math.abs(actual - expected) > 0.001) {
    return {
      error: `split labor_hours total (${actual.toFixed(2)}) must equal computed_hours + travel_hours (${expected.toFixed(2)})`,
    };
  }
  return { rows };
}

// ── Cost sources ──────────────────────────────────────────────────────────
// Every money field on an injected row comes from the same two places: the
// division's list blob (pay rates, job classes, equipment prices) and the
// project blob (prevailing wage or not). Resolving them through one builder
// means the approval path and the backfill path can never drift apart — a fix
// to the name matching or the equipment fallback lands in both at once.
//
// The normalized employees/projects tables are NOT usable here:
// sync-normalized.js drops prevailing_wage, prevailing_rate and
// non_prevailing_rate on the way through. equipment_list does keep unit_cost,
// so it serves as the fallback the payroll dropdown needs.
const _eqKey = s => String(s == null ? '' : s).trim().toLowerCase();

async function buildCostResolver(sql, companyCode, division, equipmentNames) {
  const listsKey  = `${companyCode}:${DIVISION_LISTS_KEY[division] || 'fct_lists'}`;
  const listsRows = await sql`SELECT value FROM app_data WHERE key = ${listsKey}`;
  const listsBlob = listsRows.length ? listsRows[0].value : null;
  const blobEmps      = listsBlob && Array.isArray(listsBlob.employees) ? listsBlob.employees : [];
  const blobEquipment = listsBlob && Array.isArray(listsBlob.equipment) ? listsBlob.equipment : [];

  const eqCostByName = new Map();
  for (const eq of blobEquipment) {
    if (eq && typeof eq === 'object' && eq.name) {
      eqCostByName.set(_eqKey(eq.name), Number(eq.unit_cost) || 0);
    }
  }
  // Only pay for the extra read when something needs it: a name the blob does
  // not know, or one it knows only at zero.
  const wanted = [...new Set((equipmentNames || []).filter(Boolean).map(_eqKey))];
  if (wanted.some(k => !(eqCostByName.get(k) > 0))) {
    try {
      const eqRows = await sql`
        SELECT name, unit_cost FROM equipment_list
        WHERE company_code = ${companyCode} AND active = TRUE
      `;
      for (const eq of eqRows) {
        // A real price beats a missing one and beats a zero — equipment priced
        // at 0 in one list and properly in the other is a gap in that list, not
        // a machine that runs for free.
        const k = _eqKey(eq.name);
        const cost = Number(eq.unit_cost) || 0;
        if (cost > 0 && !(eqCostByName.get(k) > 0)) eqCostByName.set(k, cost);
      }
    } catch (err) {
      console.warn('[timesheet-entries] equipment_list cost lookup failed:', err.message);
    }
  }

  return {
    employeeFor: username => matchRosterEmployee(blobEmps, username),
    // The names this division's list actually holds, so a "no match" can say
    // whether the person is absent or just spelled differently.
    rosterNames: () => blobEmps
      .map(e => (e && typeof e === 'object' ? String(e.name || '').trim() : ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b)),
    equipCostFor: name => (name ? (eqCostByName.get(_eqKey(name)) || 0) : 0),
    rateFor: (emp, isPrevailingWage) => (emp
      ? (Number(isPrevailingWage ? emp.prevailing_rate : emp.non_prevailing_rate) || 0)
      : 0),
  };
}

// Prevailing-wage flag for a set of jobs in one division, in a single read.
// Paving projects live under fct_paving_project_<id>, turf under
// fct_project_<id> — the division-aware prefix is what makes a paving
// prevailing-wage job resolve its flag, and thus its rate, correctly.
async function prevailingWageByJob(sql, companyCode, division, jobIds) {
  const prefix = PW_PROJECT_PREFIX[division] || 'fct_project_';
  const ids = [...new Set((jobIds || []).filter(Boolean).map(String))];
  const flags = new Map();
  if (!ids.length) return flags;
  const rows = await sql`
    SELECT key, value FROM app_data
    WHERE key = ANY(${ids.map(id => `${companyCode}:${prefix}${id}`)})
  `;
  const byKey = new Map(rows.map(r => [r.key, r.value]));
  for (const id of ids) {
    const blob = byKey.get(`${companyCode}:${prefix}${id}`);
    flags.set(id, !!(blob && blob.prevailing_wage === true));
  }
  return flags;
}

// Is this split row travel time? Two things say so and either is enough: the
// Travel checkbox on the payroll splitting screen, and the code the hours are
// booked to — paving books travel under sub codes like "19mm - Travel", and
// those hours are travel whether or not anyone remembered to tick the box.
// Deciding it here rather than at each call site means the approval and the
// rate refresh can never disagree about what a row is.
//
// Matched on a word boundary, not as a substring: "Form Traveler" is a
// structure, not a drive, and paying it at the standard rate on a prevailing
// job would quietly underpay it. "19mm - Travel" and "Travel Time" still match.
const TRAVEL_CODE_RE = /\btravel\b/i;

function isTravelSplitRow(row) {
  if (!row) return false;
  return row.is_travel === true
    || TRAVEL_CODE_RE.test(String(row.sub_code  || ''))
    || TRAVEL_CODE_RE.test(String(row.cost_code || ''));
}

// ── Hauling ───────────────────────────────────────────────────────────────
// The field_type an injected row is stamped with when the driver answered the
// hauling question on this entry's job block. Two things read the stamp: a
// human scanning the cost tab, who otherwise sees an hours row priced at zero
// with nothing saying why, and the production-rate roll-ups, which must not
// count a driver's hours as men on the site.
//
// Prefixed "Haul — " on purpose: HAUL_FIELD_TYPE_RE below matches the prefix,
// so a third category can be added here without touching anything that reads it.
const HAUL_FIELD_TYPE = {
  on_site:  'Haul — On Site',
  off_site: 'Haul — To/From Site',
};
// Anchored on the SEPARATOR, not just the word. `/^haul\b/` matched any field
// type an office had already invented that merely starts with "Haul" — a
// paving company using "Haul Off" for spoil removal would have had every such
// row silently priced at $0 and dropped out of its own production rates on the
// first deploy. Nothing reserves the word, and field_types is a free-form
// company-managed list. Matching "Haul — …" keeps the category open for a third
// stamp later while claiming only a shape no one types by accident.
// Any of em dash, en dash or hyphen, so the rule does not hinge on which
// character survived a copy-paste.
const HAUL_FIELD_TYPE_RE = /^haul\s*[—–-]\s/i;

// A driver's labour is already inside the truck's hourly rate — the Triaxle at
// $121/h is the truck AND the man in it. Pricing his hours again on the same
// row bills the job twice for one driver, which is what this suppresses.
//
// HOURS ARE NOT SUPPRESSED, only the money: the row still carries what he
// worked, so payroll balances against it and the cost tab reads honestly.
//
// Both answers zero the rate. Where they differ is prevailing wage, and that is
// decided on the payroll side (api/lib/payroll-metrics.js), not here — the two
// questions are genuinely separate. "Is this labour already paid for by the
// equipment line?" is about the COST of the row; "did the man work the covered
// site?" is about the RATE HE IS OWED. A haul on the site is both: free to the
// cost code, and still prevailing in his cheque.
function haulTypeOf(entry) {
  const t = entry && entry.haul_type;
  return (t === 'on_site' || t === 'off_site') ? t : null;
}

/**
 * Insert split rows into daily_tracking. The caller is responsible for first
 * deleting any prior injected rows for this entry (resplit case) — this
 * function only inserts. row_id is generated server-side (UUID-ish) so
 * the daily_tracking unique constraint never collides.
 */
async function insertSplitRows(sql, splitRows, entry, division, companyCode, employeeName) {
  // Pull the row_id naming pattern used by the existing daily-rows.js layer
  // (timestamp + random tail). This is a TEXT column with a UNIQUE constraint;
  // never collides because we mint a fresh value per call.
  const baseStamp = Date.now();
  // entry.work_date from a SELECT * is a JS Date in neon-serverless; coerce
  // to YYYY-MM-DD so the date column always receives a normalized string.
  const workDate = safeDate(entry.work_date)
    || (entry.work_date instanceof Date ? entry.work_date.toISOString().slice(0, 10) : null);

  // Auto-fill from the same source the cost tracking page reads when a user
  // picks an employee or equipment by hand. Lookups are best-effort — a
  // missing blob or a name that doesn't resolve leaves the value at its
  // default (null/0) rather than failing the approval.
  const pwFlags = await prevailingWageByJob(sql, companyCode, division, [entry.job_id]);
  const isPrevailingWage = !!pwFlags.get(String(entry.job_id));

  const resolver = await buildCostResolver(
    sql, companyCode, division, splitRows.map(r => r.equipment),
  );
  const emp      = resolver.employeeFor(employeeName);
  const jobClass = (emp && emp.job_class) || null;
  // Travel is not paid at the prevailing rate, even when the job itself is
  // prevailing wage — the premium is for time on the work, not for driving to
  // it. So each row is priced by what it is rather than by the job alone:
  // work at the job's rate, travel always at the employee's standard rate.
  const workRate   = resolver.rateFor(emp, isPrevailingWage);
  const travelRate = resolver.rateFor(emp, false);
  // Did the driver call this block a haul? If so his labour is already bought
  // by the truck on the row, and pricing it again double-bills the job.
  const haulType = haulTypeOf(entry);
  // Prefer the roster's own spelling so the injected row carries the name the
  // cost tracking tab shows everywhere else, not the raw login.
  const employeeLabel = (emp && emp.name) || employeeName;

  for (let i = 0; i < splitRows.length; i++) {
    const r = splitRows[i];
    const rowId = `ts${entry.id}-${baseStamp}-${i}-${Math.floor(Math.random() * 1e6)}`;
    const eqUnitCost = resolver.equipCostFor(r.equipment);
    // Stamp the marker from the same rule the rate below is priced by, so the
    // row's stored classification and its rate can never disagree. A row booked
    // to a travel code but never ticked used to land with no marker at all: it
    // read as ordinary work in cost tracking and came back unticked in the
    // resplit modal.
    //
    // This has to sit OUT here. A `//` line inside a sql`` template is not a
    // comment — the tag only sees text, and it is shipped to Postgres, which
    // has no `//` comment syntax. Written inside the statement it made every
    // turf/paving/kiewit approval fail to parse.
    const isTravel  = isTravelSplitRow(r);
    // Travel outranks the haul stamp, and keeps its own rate. A travel row is
    // the drive between shop and job — the commute — and the truck is not on
    // the clock for it, so that labour is real and unpaid-for elsewhere.
    // The haul only covers the WORK rows of the block.
    const isHaulRow = !isTravel && !!haulType;
    const fieldType = isTravel ? 'Travel' : (isHaulRow ? HAUL_FIELD_TYPE[haulType] : null);
    await sql`
      INSERT INTO daily_tracking (
        row_id, project_id, company_code, division,
        date, field_type, employee, cost_code, sub_code, job_class,
        rate, labor_hours, equipment, equip_unit_cost, equip_hours,
        material, supplier, po_num, units_purchased, unit_cost,
        material_cost, quantity, timesheet_entry_id
      ) VALUES (
        ${rowId},
        ${entry.job_id},
        ${companyCode},
        ${division},
        ${workDate},
        ${fieldType},
        ${employeeLabel},
        ${r.cost_code || null},
        ${r.sub_code || null},
        ${jobClass},
        ${isHaulRow ? 0 : (isTravel ? travelRate : workRate)},
        ${r.labor_hours},
        ${r.equipment || null},
        ${eqUnitCost},
        ${r.equip_hours},
        ${null}, ${null}, ${null}, ${0}, ${0},
        ${0}, ${r.quantity || 0},
        ${entry.id}
      )
      ON CONFLICT (row_id) DO NOTHING
    `;
  }
}

// Every daily_tracking row this entry ever injected: the ones still carrying
// timesheet_entry_id, plus any that lost it.
//
// A division tab open during an un-approve still holds the deleted rows in
// memory, and used to be able to put one back through the plain row API — which
// carries no timesheet_entry_id, so the row returned unlinked and the next
// un-approve could no longer see it. api/daily-rows.js now refuses those
// writes, but rows resurrected before that guard existed are still out there.
// The row_id encodes the entry id either way ("ts<entryId>-…" from
// insertSplitRows), so matching on both makes removal self-healing.
// The trailing dash keeps entry 42 from matching entry 421's rows.
async function removeSplitRows(sql, companyCode, entryId) {
  const like = `ts${entryId}-%`;
  const [{ cnt }] = await sql`
    SELECT COUNT(*)::int AS cnt FROM daily_tracking
    WHERE company_code = ${companyCode}
      AND (timesheet_entry_id = ${entryId} OR row_id LIKE ${like})
  `;
  await sql`
    DELETE FROM daily_tracking
    WHERE company_code = ${companyCode}
      AND (timesheet_entry_id = ${entryId} OR row_id LIKE ${like})
  `;
  return cnt;
}

// ── Quarry split helpers (timesheet → fct_quarry_daily/crushing blob) ──────
// Quarry's cost tracking is a JSON blob per activity, not a table. So the
// injection is a read-modify-write on the app_data blob (append a row, write
// it back, and mirror it into the normalized table via syncForKey — exactly
// what api/data/[key].js does on a normal PUT). Injected rows are tagged by
// encoding the timesheet entry id into the row id so unapprove/delete/resplit
// can find and remove them again.

// Parse a quarry job_id ("<activity>:<locationId>") into its parts. activity is
// null when the id has no recognized activity prefix (legacy location-only ids).
function parseQuarryJob(jobId) {
  const s = String(jobId || '');
  const i = s.indexOf(':');
  if (i < 0) return { activity: null, locationId: s };
  const activity = s.slice(0, i).toLowerCase();
  const locationId = s.slice(i + 1);
  return { activity: QUARRY_ACTIVITY_KEY[activity] ? activity : null, locationId };
}

// Parse+round a non-negative decimal from the modal. Returns null on invalid.
// '' / null → 0 (the field was left blank).
function quarryNum(v, max = 1e12) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.round(n * 10000) / 10000;
}

/**
 * Validate the payroll modal payload (req.body.quarry) for one activity.
 * Returns { fields } (the validated, activity-specific value fields) or
 * { error }. Hours are NOT taken from the body — the server pins them to the
 * timesheet's own computed (work) hours so the two can't drift.
 */
// Per-field caps. These are far above any real quarry value but low enough
// that neither a field NOR any derived product (labor_cost = hours*rate,
// estimated_tons = loads*tonsPerLoad, etc.) can overflow the NUMERIC(14,4)
// mirror columns (max ≈ 1e10) inside syncForKey — which would otherwise throw
// AFTER the blob was already written and leave blob/mirror inconsistent.
// ppg (Daily) and fuelCost (Crushing) are PRICES PER GALLON — the tracker, the
// executive report and quarry-metrics all cost fuel as fuelGallons × the rate.
// At $1,000/gal the cap admitted any day's fuel bill typed in by mistake, and
// the row then priced the whole day off it. A pump price ceiling rejects that
// instead; see PER_GALLON_MSG for what the caller is told.
const Q_MAX = {
  rate: 1e4, hourlyRate: 1e4, ppg: 25, fuelCost: 25,
  fuelGallons: 1e5, loadsToCrusher: 1e4, tonsPerLoad: 1e3, hoursCrushing: 24,
};
const PER_GALLON_FIELDS = new Set(['ppg', 'fuelCost']);
const PER_GALLON_MSG = "is a price per gallon, not a total — enter the pump price (e.g. 4.50) and the fuel cost is computed as gallons × that";
// "ppg must be between 0 and 25" reads like a bug to whoever just typed 855.
// Say which number the field wants.
function quarryRangeError(field, raw) {
  if (PER_GALLON_FIELDS.has(field) && Number(raw) > Q_MAX[field]) {
    return `${field} ${PER_GALLON_MSG}`;
  }
  return `${field} must be between 0 and ${Q_MAX[field]}`;
}

function validateQuarryInjection(activity, raw) {
  const q = (raw && typeof raw === 'object') ? raw : {};
  if (activity === 'daily') {
    const rate        = quarryNum(q.rate,        Q_MAX.rate);
    const fuelGallons = quarryNum(q.fuelGallons, Q_MAX.fuelGallons);
    const ppg         = quarryNum(q.ppg,         Q_MAX.ppg);
    if (rate == null)        return { error: quarryRangeError('rate', q.rate) };
    if (fuelGallons == null) return { error: quarryRangeError('fuelGallons', q.fuelGallons) };
    if (ppg == null)         return { error: quarryRangeError('ppg', q.ppg) };
    return { fields: {
      equipmentId:   safeStr(q.equipmentId, 200) || '',
      equipmentName: safeStr(q.equipmentName, 255) || '',
      taskId:        safeStr(q.taskId, 200) || '',
      taskName:      safeStr(q.taskName, 255) || '',
      rate, fuelGallons, ppg,
    } };
  }
  if (activity === 'crushing') {
    const vals = {
      hourlyRate:     quarryNum(q.hourlyRate,     Q_MAX.hourlyRate),
      hoursCrushing:  quarryNum(q.hoursCrushing,  Q_MAX.hoursCrushing),
      fuelGallons:    quarryNum(q.fuelGallons,    Q_MAX.fuelGallons),
      fuelCost:       quarryNum(q.fuelCost,       Q_MAX.fuelCost),
      loadsToCrusher: quarryNum(q.loadsToCrusher, Q_MAX.loadsToCrusher),
      tonsPerLoad:    quarryNum(q.tonsPerLoad,    Q_MAX.tonsPerLoad),
    };
    for (const [k, v] of Object.entries(vals)) {
      if (v == null) return { error: quarryRangeError(k, q[k]) };
    }
    return { fields: { ...vals, comments: safeStr(q.comments, 2000) || '' } };
  }
  return { error: 'Unknown quarry activity' };
}

async function readBlobArray(sql, companyCode, blobKey) {
  const scoped = `${companyCode}:${blobKey}`;
  const rows = await sql`SELECT value FROM app_data WHERE key = ${scoped}`;
  const v = rows.length ? rows[0].value : null;
  return Array.isArray(v) ? v : [];
}

async function writeBlobArray(sql, companyCode, blobKey, arr) {
  const scoped = `${companyCode}:${blobKey}`;
  await sql`
    INSERT INTO app_data (key, value, updated_at)
    VALUES (${scoped}, ${JSON.stringify(arr)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}

// Resolve the human location name for a quarry job. Prefer the canonical
// quarry_locations row; fall back to the trailing text of the job_label
// ("Daily — Homer City" → "Homer City") when the id doesn't resolve.
async function quarryLocationName(sql, companyCode, locationId, jobLabel) {
  if (locationId) {
    const rows = await sql`
      SELECT name FROM quarry_locations
      WHERE company_code = ${companyCode} AND id = ${locationId}
    `;
    if (rows.length && rows[0].name) return rows[0].name;
  }
  // Fall back to the location text after the activity prefix in the job label
  // ("Daily — Homer City" → "Homer City"). Tolerate any dash (em/en/hyphen) so
  // a label not built with the canonical em dash still resolves the location.
  const m = String(jobLabel || '').match(/[—–-]\s*(.+)$/);
  return m ? m[1].trim() : String(jobLabel || '').trim();
}

// Best-effort match of the timesheet employee to the quarry roster so the
// injected row carries a real employee_id (used by the tab's filters). Login
// names are often a last name; try exact then unambiguous suffix, else keep
// the free-text name with an empty id.
async function matchQuarryEmployee(sql, companyCode, name) {
  const n = (name || '').trim().toLowerCase();
  if (!n) return { id: '', name: name || '' };
  const rows = await sql`SELECT id, name FROM quarry_employees WHERE company_code = ${companyCode}`;
  const exact = rows.find(r => String(r.name || '').trim().toLowerCase() === n);
  if (exact) return { id: exact.id || '', name: exact.name };
  const suffix = rows.filter(r => String(r.name || '').trim().toLowerCase().endsWith(' ' + n));
  if (suffix.length === 1) return { id: suffix[0].id || '', name: suffix[0].name };
  return { id: '', name: name || '' };
}

/**
 * Build + inject a single quarry blob row for an approved entry. Deletes any
 * prior injected rows for this entry first (idempotent — covers resplit and a
 * retried approve), appends the new row, writes the blob, and mirrors it into
 * the normalized table via syncForKey. Returns the row that was written.
 */
async function insertQuarryRow(sql, companyCode, entry, activity, fields) {
  const blobKey = QUARRY_ACTIVITY_KEY[activity];
  const { locationId } = parseQuarryJob(entry.job_id);
  const locationName = await quarryLocationName(sql, companyCode, locationId, entry.job_label);
  const emp = await matchQuarryEmployee(sql, companyCode, entry.username);
  const workDate = safeDate(entry.work_date) || '';
  // Work hours only — travel time is intentionally not carried into the
  // quarry cost row (product decision).
  const hours = _r2(Number(entry.computed_hours) || 0);

  const base = {
    id: `${quarryRowIdPrefix(entry.id)}${Date.now()}`,
    date: workDate,
    locationId: locationId || '',
    locationName: locationName || '',
    employeeId: emp.id || '',
    employeeName: emp.name || entry.username || '',
  };

  const row = activity === 'daily'
    ? {
        ...base,
        equipmentId:   fields.equipmentId,
        equipmentName: fields.equipmentName,
        taskId:        fields.taskId,
        taskName:      fields.taskName,
        hours,
        rate:          fields.rate,
        fuelGallons:   fields.fuelGallons,
        ppg:           fields.ppg,
      }
    : {
        ...base,
        comments:       fields.comments,
        hourlyRate:     fields.hourlyRate,
        hours,
        hoursCrushing:  fields.hoursCrushing,
        fuelGallons:    fields.fuelGallons,
        fuelCost:       fields.fuelCost,
        loadsToCrusher: fields.loadsToCrusher,
        tonsPerLoad:    fields.tonsPerLoad,
      };

  const prefix = quarryRowIdPrefix(entry.id);
  const arr = await readBlobArray(sql, companyCode, blobKey);
  const next = arr.filter(r => !(r && typeof r === 'object' && String(r.id || '').startsWith(prefix)));
  next.push(row);
  await writeBlobArray(sql, companyCode, blobKey, next);
  await syncForKey(sql, companyCode, blobKey, next);
  return row;
}

/**
 * Remove every quarry blob row injected from this entry, across both activity
 * blobs (the job's activity may have changed since approval). Returns the count
 * removed. Because syncForKey short-circuits on an empty array (it will not
 * delete the last mirror row), the removed ids are also deleted from the
 * normalized table explicitly.
 */
async function removeQuarryRows(sql, companyCode, entry) {
  const prefix = quarryRowIdPrefix(entry.id);
  let removedTotal = 0;
  for (const [activity, blobKey] of Object.entries(QUARRY_ACTIVITY_KEY)) {
    const arr = await readBlobArray(sql, companyCode, blobKey);
    const removed = arr.filter(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix));
    if (!removed.length) continue;
    const remaining = arr.filter(r => !(r && typeof r === 'object' && String(r.id || '').startsWith(prefix)));
    await writeBlobArray(sql, companyCode, blobKey, remaining);
    const removedIds = removed.map(r => r.id);
    if (activity === 'daily') {
      await sql`DELETE FROM quarry_daily_entries WHERE company_code = ${companyCode} AND id = ANY(${removedIds})`;
    } else {
      await sql`DELETE FROM quarry_crushing_entries WHERE company_code = ${companyCode} AND id = ANY(${removedIds})`;
    }
    if (remaining.length) await syncForKey(sql, companyCode, blobKey, remaining);
    removedTotal += removed.length;
  }
  return removedTotal;
}

// The injected quarry row(s) for an entry, shaped for the payroll modal to
// pre-fill when re-editing an approved entry (mirrors the GET action=split
// contract for turf/paving).
async function quarrySplitForEntry(sql, companyCode, entry) {
  const { activity } = parseQuarryJob(entry.job_id);
  const blobKey = QUARRY_ACTIVITY_KEY[activity];
  if (!blobKey) return { activity: null, row: null };
  const prefix = quarryRowIdPrefix(entry.id);
  const arr = await readBlobArray(sql, companyCode, blobKey);
  const row = arr.find(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix)) || null;
  return { activity, row };
}

// ── Trucking split helpers (timesheet → fct_truck_division blob) ───────────
// Trucking's cost tracking is a single JSON blob (fct_truck_division), an array
// of truck-tracking rows. Injection is a read-modify-write on that blob (drop
// any prior injected rows for this entry, append the new one, write it back)
// plus a direct mirror into the truck_division_entries table — syncForKey does
// NOT know this key (only api/truck-division.js syncs it), so we mirror the one
// row ourselves to keep the table honest.

// Non-negative decimal or null (for the NUMERIC(10,4) mirror columns). Blank
// stays blank so haul_fee round-trips as "not set yet".
function truckNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// A DB DATE/TEXT date → "YYYY-MM-DD" or null (reuses safeDate's contract).
function truckDate(v) { return safeDate(v); }

// Validate the payroll modal payload (req.body.trucking) for a trucking
// injection. Three fields are entered on the payroll side — the haul fee
// (billing rate per hour), the division column, and the unit; everything else
// autofills from the timesheet entry. All are optional (blank is allowed) so
// payroll can approve now and fill the fee in later via Edit Row. Returns
// { fields } or { error }.
const TRUCK_HAUL_FEE_MAX = 1e7;
function truckFee(v) {
  // Trimmed first: Number(' ') is 0, so a whitespace-only box would be stored as
  // a deliberate $0/hr — which reads to the trucking office as zero-rated work
  // rather than as a fee nobody has set yet.
  if (v == null || String(v).trim() === '') return { value: '' };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > TRUCK_HAUL_FEE_MAX) {
    return { error: `haul_fee must be a number between 0 and ${TRUCK_HAUL_FEE_MAX}` };
  }
  return { value: Math.round(n * 10000) / 10000 };
}

/* ── What the office bills this customer ──────────────────────────────────
   A haul's fee is a fact about the company it hauled for: set once, beside its
   name in the Trucking tab's Manage Lists, and read from there by everything
   that prices a haul. The tab drops it onto a row the moment you name a
   customer on one; payroll's approve modal pre-fills the Haul Fee box from it.

   This is the same rate, read on the server, for the hauls nobody priced by
   hand. Bulk approve is why it has to exist: ONE fee box prices a whole card,
   so a card holding days for three customers cannot be filled in at all, and
   every row it approved used to post with no fee — reading as $0/hr in the
   trucking office's tab for work that had an agreed rate all along.

   Rates have no normalized table (dropdown_lists stores a customer as a bare
   name), so the lists blob is the only place they exist. Read exactly as
   api/truck-division.js's ?lists=1 route reads them — the company's own key
   first, the legacy global one behind it — and normalized the same way: a rate
   that is blank or non-numeric is not a price, and a fee filled in from one
   would read as a figure somebody is being charged. */
async function truckCustomerRates(sql, companyCode) {
  const [scopedRows, legacyRows] = await Promise.all([
    sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_truck_division_lists'}`,
    sql`SELECT value FROM app_data WHERE key = 'fct_truck_division_lists'`,
  ]);
  const asObj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  const lists = asObj(scopedRows[0]?.value) || asObj(legacyRows[0]?.value);
  const raw   = asObj(lists && lists.rates) || {};
  const rates = {};
  for (const key of Object.keys(raw)) {
    const name = String(key).trim();
    const val  = String(raw[key] == null ? '' : raw[key]).trim();
    if (name && val && !isNaN(parseFloat(val))) rates[name] = val;
  }
  return rates;
}

// Matched on case as well as space, exactly as trucking.html and payroll.html
// match it: the LIST is a set of spellings ("kovalchick" and "Kovalchick" are
// two entries there because each was typed onto a row), while a rate is a fact
// about the COMPANY — a haul typed in lower case bills the same customer at the
// same price.
const _truckRateKey = v => String(v == null ? '' : v).trim().toLowerCase();
function truckRateFor(rates, name) {
  const k = _truckRateKey(name);
  if (!k || !rates) return '';
  const hit = Object.keys(rates).find(n => _truckRateKey(n) === k);
  return hit ? String(rates[hit]) : '';
}

/**
 * Validate ONE leg of a split day's Truck Tracking payload. Returns { fields }
 * or { error }.
 *
 * A leg carries only what differs between hauls: who it billed, when it ran, and
 * what it billed at. The unit, the division column and the description are the
 * driver's day, not the haul, so they stay on the parent payload and every row
 * gets the same answer. Absent keys fall back to the day: a leg with no window
 * bills the whole day's hours, and a leg with no fee bills the day's fee.
 */
function validateTruckingLeg(raw) {
  const t = (raw && typeof raw === 'object') ? raw : {};
  const has = k => Object.prototype.hasOwnProperty.call(t, k) && t[k] != null;
  const fields = {};
  if (has('company')) fields.company = safeStr(t.company, 500) || '';
  if (has('haul_fee')) {
    const { value, error } = truckFee(t.haul_fee);
    if (error) return { error };
    fields.haul_fee = value;
  }
  for (const key of ['start_time', 'end_time']) {
    if (!has(key)) continue;
    const given = String(t[key] || '').trim();
    if (!given) { fields[key] = ''; continue; }
    const v = safeTime(given);
    if (!v) return { error: `${key} must be HH:MM` };
    fields[key] = v;
  }
  return { fields };
}

function validateTruckingInjection(raw) {
  const t = (raw && typeof raw === 'object') ? raw : {};
  const fee = truckFee(t.haul_fee);
  if (fee.error) return { error: fee.error };
  // An ABSENT fee is not a blank one, on the same terms as the unit below. The
  // approve modal sends whatever its box holds, '' included, because that box
  // was pre-filled from the customer's rate — so a blank one is payroll saying
  // this haul bills nothing. What it does NOT send is a box it never filled in
  // and nobody typed in: BULK approve leaves the key off whenever its one fee
  // box is empty, since a card can span customers and one number cannot price
  // them, and the single modal leaves it off for a box that is blank because
  // the rates had not landed yet rather than because anyone emptied it. That
  // absence means "price it the way the office prices it", and insertTruckingRows
  // fills it from the customer's agreed rate — a row that used to post at no fee
  // at all and read as $0/hr in the trucking tab.
  const feeGiven = t.haul_fee !== undefined && t.haul_fee !== null;
  const division = safeStr(t.division, 100) || '';
  // Unit is the one autofilled column payroll can also type: the driver may
  // have left it off (every dust haul submitted before the Unit field existed
  // did), and the trucking office needs it on the row. An ABSENT key is not the
  // same as a blank one — the bulk card deliberately sends no unit, since one
  // unit shared across a group of drivers would be wrong, and that has to mean
  // "keep each entry's own unit" rather than "blank every one of them". Absent
  // → null (leave the timesheet's value alone); present → the string typed,
  // '' included (clear it).
  //
  // `== null` catches an explicit JSON null as well as a missing key: a caller
  // that spells "no opinion" as null must not silently wipe the unit. Clearing
  // is spelled '' — which is what the modal sends when payroll empties the box.
  const unit = t.unit == null ? null : (safeStr(t.unit, 100) || '');
  const fields = { division, unit };
  if (feeGiven) fields.haul_fee = fee.value;

  // A split day sends one leg per haul. The approve modal sends this for every
  // entry that posts Truck Tracking rows, one element when the day was not
  // split; absent — which is what bulk approve and any older client send —
  // means the day posts one row, as it always has.
  if (t.rows != null) {
    if (!Array.isArray(t.rows)) return { error: 'trucking.rows must be an array' };
    if (!t.rows.length) return { error: 'Truck Tracking needs at least one row' };
    if (t.rows.length > MAX_INJECTED_LEGS) {
      return { error: `A day can be split across at most ${MAX_INJECTED_LEGS} Truck Tracking rows` };
    }
    const legs = [];
    for (const leg of t.rows) {
      const { fields: legFields, error } = validateTruckingLeg(leg);
      if (error) return { error };
      legs.push(legFields);
    }
    fields.rows = legs;
  }
  return { fields };
}

// Best-effort match of the timesheet employee to the trucking driver roster so
// the injected row's driver reads as a real driver name where possible. The
// roster lives in dropdown_lists (list_name='truck_drivers').
//
// Matching is the same cascade the split path uses (see matchRosterEmployee):
// exact, the name's words run together either way round, surname alone,
// initial+surname, then a shortened first name — each retried with doubled
// letters collapsed, and each having to hit exactly one roster entry.
//
// This function used to try the login verbatim and then a " surname" suffix,
// which is the same pair the roster lookup was cut back from, and it left every
// concatenated login unmatched: "barrmike" against a roster reading "Mike Barr"
// fell through to the raw login, so the driver column showed the login instead
// of the driver. An unmatched name is still kept verbatim rather than blanked —
// the Truck Tracking driver cell is a free-text combobox.
async function matchTruckingDriver(sql, companyCode, name) {
  const n = (name || '').trim();
  if (!n) return name || '';
  // Roster source of truth is the fct_truck_division_lists blob (the
  // dropdown_lists mirror can lag in serverless — same reason api/timesheet-jobs
  // reads the blob for the customer picker). Read the blob first, fall back to
  // the mirror for older data.
  const [scopedRows, legacyRows] = await Promise.all([
    sql`SELECT value FROM app_data WHERE key = ${companyCode + ':fct_truck_division_lists'}`,
    sql`SELECT value FROM app_data WHERE key = 'fct_truck_division_lists'`,
  ]);
  const scoped = (scopedRows[0]?.value && typeof scopedRows[0].value === 'object') ? scopedRows[0].value : null;
  const legacy = (legacyRows[0]?.value && typeof legacyRows[0].value === 'object') ? legacyRows[0].value : null;
  const lists  = scoped || legacy || null;
  let names = (lists && Array.isArray(lists.drivers))
    ? lists.drivers.map(v => String(v || '')).filter(Boolean)
    : null;
  if (!names) {
    const rows = await sql`
      SELECT value FROM dropdown_lists
      WHERE company_code = ${companyCode} AND list_name = 'truck_drivers'
    `;
    names = rows.map(r => String(r.value || '')).filter(Boolean);
  }
  // matchRosterEmployee takes the roster as {name} objects (it is shared with
  // the employee blob, whose entries carry a rate alongside the name); the
  // driver roster is a flat list of names, so wrap and unwrap.
  const hit = matchRosterEmployee(names.map(v => ({ name: v })), name);
  return hit ? hit.name : (name || '');
}

// Upsert one injected row into the truck_division_entries mirror table. Mirrors
// the column set + coercions used by api/truck-division.js's _syncEntries so the
// two writers stay compatible (a later full-list PUT from trucking.html will
// re-upsert this same row cleanly).
async function upsertTruckDivisionEntry(sql, companyCode, e) {
  await sql`
    INSERT INTO truck_division_entries (
      id, company_code, task_number, actual_date, driver, unit,
      actual_start, actual_end, total_hours, haul_fee, customer,
      description, division, notes, qb_invoice, invoiced_date,
      invoice_sent_date, invoice_status, date_paid, updated_at
    ) VALUES (
      ${e.id}, ${companyCode},
      ${e.task_number || null},
      ${truckDate(e.actual_date)},
      ${e.driver || null},
      ${e.unit || null},
      ${e.actual_start || null},
      ${e.actual_end || null},
      ${truckNum(e.total_hours)},
      ${truckNum(e.haul_fee)},
      ${e.customer || null},
      ${e.description || null},
      ${e.division || null},
      ${e.notes || null},
      ${e.qb_invoice || null},
      ${truckDate(e.invoiced_date)},
      ${truckDate(e.invoice_sent_date)},
      ${e.invoice_status || 'Unpaid'},
      ${truckDate(e.date_paid)},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      task_number       = EXCLUDED.task_number,
      actual_date       = EXCLUDED.actual_date,
      driver            = EXCLUDED.driver,
      unit              = EXCLUDED.unit,
      actual_start      = EXCLUDED.actual_start,
      actual_end        = EXCLUDED.actual_end,
      total_hours       = EXCLUDED.total_hours,
      haul_fee          = EXCLUDED.haul_fee,
      customer          = EXCLUDED.customer,
      description       = EXCLUDED.description,
      division          = EXCLUDED.division,
      notes             = EXCLUDED.notes,
      qb_invoice        = EXCLUDED.qb_invoice,
      invoiced_date     = EXCLUDED.invoiced_date,
      invoice_sent_date = EXCLUDED.invoice_sent_date,
      invoice_status    = EXCLUDED.invoice_status,
      date_paid         = EXCLUDED.date_paid,
      updated_at        = NOW()
  `;
}

/**
 * Build + inject the Truck Tracking rows for an approved entry — either a
 * trucking entry or a dust customer haul (see needsTruckTrackingRow).
 *
 * Takes the WHOLE day and writes only the hauls this tab is the record of,
 * exactly as the two dust writers do. A trucking day posts every leg. A dust
 * day posts only the legs billed off Other Billing — see postsHere below, and
 * `flags.dustLegs`, which is how the day's destinations get here. So this
 * returns one row per leg for a trucking day, and anywhere from all of them to
 * none for a dust one.
 *
 * The pruning matters as much as the writing: a haul re-pointed from material
 * to UB, or a day corrected from three hauls to two, would otherwise leave a
 * row here billing work the timesheet no longer describes. Nothing else would
 * remove it — the tab refuses to delete payroll's rows.
 *
 * Idempotent on the stable row ids (covers a retried approve), written into the
 * fct_truck_division blob in a single pass and mirrored into
 * truck_division_entries. Returns the rows written, in leg order.
 *
 * Autofill: driver ← employee, actual_date ← work_date, actual_start/end ←
 * start/end, total_hours ← the (lunch-deducted) work hours PLUS travel hours,
 * customer ← job_label, unit ← truck_unit, description ← truck_description.
 * The haul fee and division column come from the payroll modal (fields arg);
 * everything else is derived from the timesheet entry so the Truck Tracking row
 * is fully owned by payroll and locked in the Trucking division. invoice fields
 * default to Unpaid/blank (the trucking office manages invoicing).
 *
 * On a split day the three columns that describe the HAUL rather than the day —
 * customer, the clock window and the haul fee — come from the leg instead, so
 * the tab reads one line per customer the driver actually hauled for, matching
 * the Dust Control Tracking rows the same approval posts. The unit, the
 * description, the division column and the driver are the day, and every row
 * carries the same answer.
 *
 * Hours split with the window, and two adjustments keep the day whole:
 *   - the lunch deduction (the gap between the clock window and the entry's
 *     lunch-deducted computed_hours) comes off the FIRST leg, and
 *   - travel hours, which are logged outside the window entirely, go on the
 *     first leg too.
 * So the legs still sum to exactly what the single row billed before the split —
 * an unsplit day computes to computed_hours + travel_hours, unchanged — and
 * neither figure has to be guessed at per haul.
 *
 * Both adjustments stay on the day's first leg whether or not that leg posts
 * here, which is why the arithmetic runs over every leg and the filtering
 * happens after. A haul bills its own window; what the haul before it billed
 * off is not its business. The visible consequence is that a dust day whose
 * first haul is UB bills its travel nowhere in Truck Tracking — the dust grid
 * has no travel column, and inventing one by moving the hours onto the next
 * customer's row would bill them for a drive they did not order. The approve
 * modal says so on the haul (see the truckOut line in payroll.html).
 *
 * Unit straddles the two: it autofills from the timesheet like the rest, but
 * the modal also lets payroll type it (fields.unit) for the entries that came
 * in without one. The approve/resplit handlers write that value back onto the
 * entry's truck_unit before calling this, so the two agree — fields.unit wins
 * here only so the row is right even if that write is skipped.
 *
 * A dust-sourced row differs in one way: the Division column defaults to "Dust"
 * rather than blank — that column exists to tell the trucking office whose work
 * a row represents, and the answer is already known here, though payroll can
 * still override it in the modal. Unit and description come off the timesheet
 * exactly as they do for trucking; the driver is asked for them whenever the
 * entry is headed for this tab (see needsTruckTrackingRow).
 */
async function insertTruckingRows(sql, companyCode, entry, fields = {}, flags = {}) {
  const legs     = (Array.isArray(fields.rows) && fields.rows.length) ? fields.rows : [{}];
  // The day's hauls as the DUST side sees them, or null when this entry has no
  // dust side at all (a trucking entry, whose every leg posts here).
  //
  // Absent legs on a dust haul read as one leg bound for the tracking grid —
  // the same `|| [{}]` the two dust writers apply, and the same default legDest
  // gives an unanswered leg. That is what bulk approve sends, and it means a
  // caller that forgets to pass the day's hauls posts NOTHING here rather than
  // silently falling back to posting everything.
  const dustLegs = needsDustTrackingRow(entry)
    ? ((Array.isArray(flags.dustLegs) && flags.dustLegs.length) ? flags.dustLegs : [{}])
    : null;
  const workDate = safeDate(entry.work_date) || '';
  const dayCustomer = safeStr(entry.job_label, 500) || safeStr(entry.job_id, 500) || '';
  const hhmm     = v => String(v || '').slice(0, 5);
  // Payroll-entered fields (validated by validateTruckingInjection). Blank is
  // allowed — payroll can approve now and set the fee later via Edit Row.
  const dayFee   = (fields.haul_fee === '' || fields.haul_fee == null) ? '' : fields.haul_fee;
  // Whether the day's fee is an ANSWER. Blank is one — payroll cleared a box
  // that was pre-filled with the customer's rate — while absent is nobody
  // having said, which is what bulk approve sends for a card spanning
  // customers. See the rate fill below, and validateTruckingInjection.
  const dayFeeGiven = fields.haul_fee !== undefined && fields.haul_fee !== null;
  const division = safeStr(fields.division, 100)
    || (entry.division === 'dust' ? 'Dust' : '');
  // null/undefined = the modal sent no unit (bulk approve, or an older client)
  // → keep the timesheet's. A string, '' included, is payroll's answer.
  const unit = fields.unit == null
    ? (safeStr(entry.truck_unit, 100) || '')
    : (safeStr(fields.unit, 100) || '');

  /**
   * Whether leg `i` of the day posts a row into Truck Tracking.
   *
   * A trucking entry posts every leg — its rows ARE the trucking office's
   * record of the day, and nothing else keeps one.
   *
   * A dust customer haul posts only the legs billed off Other Billing. A haul
   * billed off Dust Control Tracking is recorded, priced and invoiced entirely
   * by the dust office — vehicle rates times hours, on its own grid — so a
   * second row of it here was a copy of somebody else's work that the trucking
   * office could not delete, could not correct, and had to remember not to bill
   * against. Other Billing is different: that grid prices the material, and the
   * hauling of it is trucking's line, so those legs still come here.
   *
   * The index is the leg's place in the WHOLE day, never its place among the
   * legs that land here — truckingRowId is keyed off it, and Intercompany keys
   * its billing entry off that id. So a day whose middle haul was material
   * posts tst-<id>-2 beside tsd-<id>-row and tsd-<id>-3, and re-pointing that
   * haul at UB is a plain delete-one on a stable id rather than a renumbering
   * of everything after it. Same rule, same reason, as obRowId.
   */
  const postsHere = i => !dustLegs || legDest(dustLegs[i] || {}) === 'ob';

  const prefix = truckingRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  const isMine = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);
  const priorById = new Map(arr.filter(isMine).map(r => [String(r.id), r]));

  // Nothing here now and nothing here before: every haul of an all-UB dust day,
  // which is the common case. It must not rewrite the blob — that would race
  // the trucking tab's own save for no reason at all. Same guard, same reason,
  // as insertObRows.
  if (!legs.some((_, i) => postsHere(i)) && !priorById.size) return [];

  const driver = await matchTruckingDriver(sql, companyCode, entry.username);

  // What the day's hours have to add up to, and the two pieces that do not come
  // from a leg's own window — the lunch break and the travel, which both land on
  // the first leg.
  const work      = Number(entry.computed_hours) || 0;
  const travel    = Number(entry.travel_hours) || 0;
  const daySpan   = computeHours(hhmm(entry.start_time), hhmm(entry.end_time));
  // Only ever a deduction, never a top-up: an entry whose computed_hours exceeds
  // its own clock window is telling us something we cannot allocate to a haul,
  // and inventing hours on leg 1 to make the arithmetic close would bill for
  // them. Whether the legs cover the day is the approver's business, and the
  // modal's tally is where they are told.
  const deduction = daySpan == null ? 0 : Math.max(0, _r2(daySpan - work));
  // An unsplit day keeps billing its own stated hours, verbatim — no window
  // arithmetic at all. One leg is not a split: it is how the approve modal
  // spells "the whole day", so it lands here alongside bulk approve's
  // no-legs-at-all, and both bill the figure payroll was shown on the card.
  const split = legs.length > 1;
  // What is left of the lunch break to take off, as the legs are walked in
  // order. Only ever a deduction, so it starts at the day's and runs down.
  let owed = deduction;

  // Built for EVERY leg of the day and filtered afterwards, never filtered
  // first: the lunch deduction runs down across the legs in order, so a haul's
  // hours would otherwise change depending on whether the haul BEFORE it
  // happened to bill off the other grid. A leg bills what it bills.
  const allRows = legs.map((leg, i) => {
    // An unsplit day is the day, window and all. Its row bills computed_hours +
    // travel_hours whatever the modal sent, so taking the times from the leg
    // would stamp a row "11:15–15:30" against nine hours — which is what a
    // supervisor gets by splitting a day, then removing the first haul. Either
    // both come from the leg or neither does.
    const start = (split && leg.start_time !== undefined) ? leg.start_time : hhmm(entry.start_time);
    const end   = (split && leg.end_time   !== undefined) ? leg.end_time   : hhmm(entry.end_time);
    const span  = computeHours(start, end);
    let hours;
    if (!split) {
      hours = _r2(work + travel);
    } else {
      // A leg of a split day bills its own window and nothing else. Cleared
      // times leave it at zero rather than falling back to the day, which on a
      // split would bill the whole day again on one haul; the modal refuses to
      // save a haul with no hours, so this is the belt to that brace.
      //
      // The lunch break comes off the first haul, and anything the first haul
      // is too short to absorb comes off the next one, and the one after that.
      // Clamping it at the first leg instead meant a day split 05:00–05:30 /
      // 05:30–17:30 against an hour of lunch billed 12 hours for 11.5 approved
      // — half an hour of unpaid break invoiced at the haul fee, with nothing
      // on screen saying the day had stopped adding up.
      const span0 = span == null ? 0 : span;
      const take  = Math.min(span0, owed);
      owed = _r2(owed - take);
      const base  = span == null ? 0 : Math.max(0, _r2(span0 - take));
      hours = i === 0 ? _r2(base + travel) : base;
    }
    return {
      // Stable per entry and leg, not stamped with Date.now() — see
      // truckingRowId. A fresh id on every re-injection orphaned the row's
      // Intercompany billing entry, which then got read back as a lost row and
      // rebuilt as a duplicate of the work payroll had just corrected.
      id:                truckingRowId(entry.id, i + 1),
      task_number:       '',
      actual_date:       workDate,
      driver,
      unit,
      actual_start:      hhmm(start),
      actual_end:        hhmm(end),
      total_hours:       hours,
      haul_fee:          leg.haul_fee !== undefined ? leg.haul_fee : dayFee,
      customer:          leg.company !== undefined && leg.company !== ''
        ? safeStr(leg.company, 500) || dayCustomer
        : dayCustomer,
      description:       safeStr(entry.truck_description, 2000) || '',
      division,                     // entered on the payroll side
      notes:             entry.notes || '',
      qb_invoice:        '',
      invoiced_date:     '',
      invoice_sent_date: '',
      invoice_status:    'Unpaid',
      date_paid:         '',
    };
  });

  // The legs this tab actually bills. The ones dropped here are pruned below
  // like any other leg the day no longer has — same list, same Intercompany
  // cleanup — which is what makes flipping a haul from material to UB a move
  // rather than a duplicate.
  const rows = allRows.filter((_, i) => postsHere(i));

  // The hauls nobody priced: no fee on the leg, and none on the day either.
  // Kept as ids rather than positions, because `rows` is `allRows` minus the
  // legs the dust office bills off its own grid — an index into one is not an
  // index into the other.
  const unpricedIds = new Set(
    allRows.filter((_, i) => (legs[i] || {}).haul_fee === undefined && !dayFeeGiven)
           .map(r => r.id));

  // Carry over the invoice columns the trucking office owns on each row. Every
  // cost field is payroll's and is rewritten from the entry, but the office
  // fills in the QB number and the invoiced/paid dates on the locked row — and
  // correcting an entry's hours must not wipe the billing history off a row
  // that has already been invoiced. Same rule as EES_OTHER_TAB_FIELDS.
  //
  // Matched by id AND by customer, because a leg id is positional: remove the
  // first haul of a two-haul day and the second one is rewritten under the id
  // the first used. Carrying on id alone then moved the first customer's QB
  // number, invoiced date and "Paid" status onto the second customer's row —
  // work they had never been invoiced for, marked as already settled, with the
  // real invoiced row deleted in the same save. A slot whose occupant changed
  // starts its invoice sub-row clean; the office fills it in as they would for
  // any other new haul.
  const sameHaul  = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  for (const row of rows) {
    const prev = priorById.get(row.id);
    if (!prev || !sameHaul(prev.customer, row.customer)) continue;
    for (const f of TRUCK_TAB_FIELDS) {
      if (prev[f] !== undefined && prev[f] !== null && prev[f] !== '') row[f] = prev[f];
    }
  }

  // ── A haul nobody priced bills its customer's agreed rate ──────────────
  // The last stop for a fee, after the approve modal's own pre-fill and before
  // the row is written. It fires only where the payload asked no fee question of
  // anybody — bulk approve pricing a card that spans customers, or a client too
  // old to send one — so a fee typed in the modal, a blank one deliberately
  // cleared there, and a leg priced on its own all stand exactly as sent.
  //
  // Read FORWARD ONLY, onto a haul still unpriced, which is the rule the tab and
  // the modal both apply: re-pricing a customer in Manage Lists must never
  // silently restate a haul that has already gone out the door. A customer with
  // no rate set is left blank, exactly as before — there is nothing to fill it
  // from — and the fee is filled in from Edit Row, or a rate is set beside that
  // customer's name and the next approval carries it.
  const unpriced = rows.filter(r => unpricedIds.has(r.id) && r.haul_fee === '' && r.customer);
  if (unpriced.length) {
    const rates = await truckCustomerRates(sql, companyCode);
    for (const row of unpriced) {
      // Through the same gate a typed fee goes through, and only written when
      // it comes back a number. The Manage Lists normalizer keeps a rate on
      // parseFloat, which "121/hr" passes and Number() does not — and a rate
      // this cannot read is not one to invent a figure from. The row stays
      // blank, exactly as it would with no rate set at all.
      const { value, error } = truckFee(truckRateFor(rates, row.customer));
      if (!error && value !== '') row.haul_fee = value;
    }
  }

  // Number each row out of the tab's own TR-#### series, so a haul that came
  // from a timesheet is identifiable in the Task Number column — and on the
  // invoice, in Intercompany billing and in the executive report — exactly like
  // one the office typed. Until this, an injected row carried a blank there.
  //
  // Minted here rather than in the page because injected-blob-guard takes every
  // column but TRUCK_TAB_FIELDS from the server's copy of the row, so a number
  // written by the tab would not survive its next save. Rows already in the
  // blob, manual ones included, set the high-water mark: one series covers the
  // division.
  //
  // Carried across a re-approval on the same terms as the invoice columns —
  // same id AND same customer. Correcting a day's hours leaves the number
  // alone, so a haul keeps the number it was invoiced under. A leg whose
  // occupant changed (remove the first haul of a two-haul day and the second is
  // rewritten under the first one's id) is different work and takes a fresh
  // number, rather than inheriting one the office has already billed another
  // customer under.
  let nextTask = maxTaskNumber(arr);
  for (const row of rows) {
    const prev    = priorById.get(row.id);
    const carried = (prev && sameHaul(prev.customer, row.customer))
      ? String(prev.task_number || '').trim()
      : '';
    row.task_number = carried || formatTaskNumber(++nextTask);
  }

  const next = arr.filter(r => !isMine(r));
  next.push(...rows);
  await writeBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB, next);

  // Rows under an id we did NOT just write: legs a re-edit dropped (three
  // customers corrected down to two), plus leftovers from the era of
  // Date.now()-stamped ids. Both have to take their Intercompany billing entry
  // with them, or the tab keeps invoicing a haul the timesheet no longer has.
  // The rows we are (re)writing are deliberately excluded — deleting and
  // re-inserting one would reset created_at and move it in the tab's ordering,
  // and would drop the billing entry that legitimately still describes it.
  const kept     = new Set(rows.map(r => r.id));
  const staleIds = [...priorById.keys()].filter(id => id && !kept.has(id));
  if (staleIds.length) {
    await sql`DELETE FROM truck_division_entries WHERE company_code = ${companyCode} AND id = ANY(${staleIds})`;
    // Non-fatal: leaving a billing entry behind bills for a row that no longer
    // exists, but failing here would roll back an otherwise-good approval.
    try {
      await removeIcBillingEntries(sql, companyCode, IC_SOURCE_TRUCKING, staleIds);
    } catch (err) {
      console.error('[timesheet-entries] clearing stale IC billing failed:', err.message);
    }
  }
  for (const row of rows) await upsertTruckDivisionEntry(sql, companyCode, row);

  // APPROVING is a deliberate statement that this work counts, so it undoes an
  // earlier Intercompany removal rather than being silently overruled by it —
  // the same rule EES applies, and it only became reachable here once the row
  // id stopped changing on every re-approval.
  //
  // Editing the row is not that statement, and for a dust haul the difference
  // now carries money. Such a haul posts a row in BOTH tabs, billing on two
  // different bases, so whoever reconciles Intercompany suppresses one of the
  // pair — and it may well be this one. Clearing that on a routine haul-fee
  // correction would quietly bill the customer twice. The dust half of the pair
  // (insertDustTrackingRows) is gated the same way, so whichever half is chosen
  // survives an Edit Row.
  //
  // A slot whose OCCUPANT changed is the third case, and it is not an editing
  // decision at all. Remove the first haul of a two-haul day and the second is
  // rewritten under the first one's id — so a removal somebody recorded in
  // Intercompany against the first customer's haul would go on suppressing the
  // second customer's, which has never been billed and now never would be, with
  // nothing on screen to say why. The suppression described the haul that left.
  const reoccupied = rows
    .filter(row => {
      const prev = priorById.get(row.id);
      return prev && !sameHaul(prev.customer, row.customer);
    })
    .map(row => row.id);
  for (const id of new Set([...(flags.clearSuppression ? rows.map(r => r.id) : []), ...reoccupied])) {
    try {
      await clearIcSuppression(sql, companyCode, IC_SOURCE_TRUCKING, id);
    } catch (err) {
      console.error('[timesheet-entries] clearing IC suppression failed:', err.message);
    }
  }
  return rows;
}

/**
 * Write this entry's Truck Tracking half as exactly ONE row for the whole day,
 * and take back every other haul it had. As with the dust half, this is not a
 * way to rewrite one row of a split day and leave the rest alone.
 *
 * Kept because an unsplit day is the common case — every trucking entry and
 * every bulk approval — and reads better as one call. Returns that row.
 */
async function insertTruckingRow(sql, companyCode, entry, fields = {}, flags = {}) {
  const [row] = await insertTruckingRows(sql, companyCode, entry, fields, flags);
  return row;
}

/**
 * Build + inject a single "EES Other" row for an approved dust entry.
 *
 * Deletes any prior injected row for this entry first (idempotent — covers a
 * retried approve or a payroll edit), then appends the new one. Blob-only:
 * dust_ees_other_rows has no normalized mirror, same as the dust Other Billing
 * grid it sits beside.
 *
 * Autofill mirrors the timesheet entry exactly: driver ← employee, actual_date
 * ← work_date, actual_start/end ← start/end, actual_hours ← the (lunch-deducted)
 * computed hours, customer ← job_label, comments ← notes. Unit / location /
 * name / job number / billing / rate are left for the dust office and preserved
 * across re-injection. Billing defaults to Non-Billable so a row never bills
 * anybody by accident — Intercompany only picks up rows marked Billable.
 */
async function insertEesOtherRow(sql, companyCode, entry) {
  const hhmm     = v => String(v || '').slice(0, 5);
  const workDate = safeDate(entry.work_date) || '';
  const customer = safeStr(entry.job_label, 500) || safeStr(entry.job_id, 500) || '';

  const prefix = eesOtherRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB);
  const isMine = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);
  const prev   = arr.find(isMine) || null;

  const row = {
    // Stable, not stamped with Date.now(): there is only ever one row per
    // entry, and Intercompany keys its billing entry off this id. A fresh id on
    // every re-injection would orphan that entry — the reconciler would drop it
    // (losing its sent_at and any Intercompany-side invoice/payment dates) and
    // mint a replacement. Re-injecting is now genuinely idempotent.
    id:            `${prefix}row`,
    actual_date:   workDate,
    actual_start:  hhmm(entry.start_time),
    actual_end:    hhmm(entry.end_time),
    actual_hours:  _r2(Number(entry.computed_hours) || 0),
    driver:        entry.username || '',
    unit:          safeStr(entry.ees_unit, 100)      || '',
    customer:      safeStr(entry.ees_customer, 500)  || customer,
    location:      safeStr(entry.ees_location, 500)  || '',
    name:          safeStr(entry.ees_name, 500)      || '',
    job_number:    safeStr(entry.ees_job_number, 100) || '',
    billing:       safeStr(entry.ees_billing, 50)    || 'Non-Billable',
    activity:      entry.job_id === 'ees:washing' ? 'Washing' : 'Pre Loading',
    rate:          '',
    comments:      entry.notes || '',
  };
  // Carry over anything the dust office already filled in on the prior row.
  if (prev) {
    for (const f of EES_OTHER_TAB_FIELDS) {
      if (prev[f] !== undefined && prev[f] !== null && prev[f] !== '') row[f] = prev[f];
    }
  }

  const next = arr.filter(r => !isMine(r));
  next.push(row);
  await writeBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB, next);

  // Non-fatal: a failure here leaves the row suppressed, which the tab shows
  // as "Removed in IC" rather than hiding — whereas throwing would roll back
  // an otherwise-good approval over a secondary concern.
  try {
    await clearIcSuppression(sql, companyCode, IC_SOURCE_EES_OTHER, row.id);
  } catch (err) {
    console.error('[timesheet-entries] clearing IC suppression failed:', err.message);
  }
  return row;
}

/**
 * Build one EES Other row for a leg of a dust CUSTOMER haul — the third thing a
 * haul can bill off, which is nothing at all.
 *
 * Not every haul is invoiced. A driver sent to a customer's pad to move a tank,
 * wait on a frac, or clean up after somebody else did the work is real hours
 * against a real customer that the dust office tracks and bills to nobody, and
 * the EES Other tab is where it has always kept that. Until now it could only
 * get there from one of the two standing EES activities — so a non-billable
 * customer haul had nowhere to go, and was either invoiced by accident off one
 * of the two billing grids or left off the books entirely.
 *
 * The row shape is the tab's, filled from the leg rather than from the entry's
 * ees_* fields (a customer job has none — normalizeEntryBody forces them null):
 *
 *   date / driver / comments   the day, off the timesheet
 *   start, end, hours          the LEG's own window
 *   customer, location, unit   the leg's, from the approve modal
 *   name, job number           blank — nothing on a customer haul names them
 *   billing                    always Non-Billable; that IS this destination
 *   rate                       the tab's own column, and moot while Non-Billable
 *
 * Hours come from the leg's window, like every other per-leg dust row, rather
 * than from the entry's lunch-deducted computed_hours the way the EES-activity
 * row does. A split day's legs have to sum to the day they came out of, and the
 * window is the only figure that can do that per haul.
 */
function buildEesHaulRow(entry, fields, index, driver) {
  const hhmm  = v => String(v || '').slice(0, 5);
  const start = fields.start_time !== undefined ? hhmm(fields.start_time) : hhmm(entry.start_time);
  const end   = fields.end_time   !== undefined ? hhmm(fields.end_time)   : hhmm(entry.end_time);
  return {
    id:           eesOtherRowId(entry.id, index),
    actual_date:  safeDate(entry.work_date) || '',
    actual_start: start,
    actual_end:   end,
    actual_hours: legHours(start, end),
    driver,
    // The unit the haul ran, same fallback the dust grid's Vehicle 1 uses: the
    // leg's answer, or the one the driver put on the timesheet.
    unit:       safeStr(fields.vehicle1, 200) || safeStr(entry.truck_unit, 100) || '',
    customer:   safeStr(fields.company, 500)
                  || safeStr(entry.job_label, 500) || safeStr(entry.job_id, 500) || '',
    location:   safeStr(fields.location, 500) || '',
    // Left blank rather than guessed. Both are read-only in the tab, so an
    // invented value could never be corrected there — and neither a customer
    // haul nor its timesheet names a crew or a job number.
    name:       '',
    job_number: '',
    // The whole point of this destination, and rewritten on every re-injection
    // rather than carried: pointing a haul here IS saying it bills nobody, so
    // the answer cannot be edited out from under that.
    billing:    'Non-Billable',
    // Neither of the two standing EES activities. Left blank so the tab's
    // "From an approved timesheet entry" tooltip does not name one this haul
    // was not.
    activity:   '',
    rate:       '',
    comments:   entry.notes || '',
  };
}

/**
 * Write every leg of an approved customer haul that is headed for EES Other,
 * and take back the legs it no longer has. Returns the rows written, in leg
 * order.
 *
 * Takes the WHOLE day's legs, like insertDustTrackingRows and insertObRows, and
 * writes only the ones this grid claims — the index is the leg's place in the
 * day, so the three halves can be written independently and still describe one
 * split.
 *
 * The pruning matters as much as the writing: a haul re-pointed off this grid,
 * or a day corrected from three hauls to two, would otherwise leave a row here
 * describing work the timesheet no longer has. Nothing else would ever remove
 * it — the tab creates and deletes nothing, by design.
 *
 * Distinct from insertEesOtherRow, which posts the single row an entry on a
 * standing EES ACTIVITY gets. The two never run for the same entry: that gate
 * is isEesJob, this one is a customer haul, and they are disjoint by
 * construction. Sharing the "tse-" prefix is what lets un-approve, delete and
 * the edit guard keep asking one question about both.
 */
async function insertEesOtherRows(sql, companyCode, entry, legs, flags = {}) {
  const list = (Array.isArray(legs) && legs.length) ? legs : [{}];
  const mine = [];
  for (let i = 0; i < list.length; i++) {
    if (legDest(list[i] || {}) === 'ees') mine.push({ index: i + 1, fields: list[i] || {} });
  }

  const prefix = eesOtherRowIdPrefix(entry.id);
  const isMine = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);
  const arr    = await readBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB);
  const prior  = new Map(arr.filter(isMine).map(r => [String(r.id), r]));

  // Nothing here now and nothing here before: every haul of an ordinary billed
  // day, which is the common case. It must not rewrite the blob — that would
  // race the dust tab's own save for no reason at all. Same guard, same reason,
  // as insertObRows.
  if (!mine.length && !prior.size) return [];

  const rows = [];
  if (mine.length) {
    // The dust office's own roster, so the Driver column reads as a driver the
    // tab recognises rather than a login. Same call insertObRows makes.
    const driver = await matchDustEmployee(sql, companyCode, entry.username);
    for (const { index, fields } of mine) {
      const row  = buildEesHaulRow(entry, fields, index, driver);
      // Carry over the one column the dust office owns — but only while the
      // slot still holds the same haul. A leg id is positional, so removing the
      // first haul of a two-haul day rewrites the second under the first one's
      // id, and carrying on id alone would move one customer's rate onto
      // another's row. Same rule, same reason, as the other two grids.
      const prev = prior.get(row.id);
      const same = prev
        && String(prev.customer || '').trim().toLowerCase() === String(row.customer || '').trim().toLowerCase();
      if (prev && same) {
        for (const f of EES_OTHER_TAB_FIELDS) {
          if (prev[f] !== undefined && prev[f] !== null && prev[f] !== '') row[f] = prev[f];
        }
      }
      rows.push(row);
    }
  }

  // One pass: everything that is not ours stays exactly where it was, and ours
  // are appended in leg order.
  const keep = new Set(rows.map(r => r.id));
  const next = arr.filter(r => !isMine(r)).concat(rows);
  await writeBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB, next);

  // Rows this entry used to have and no longer does — a leg removed, or one
  // re-pointed at a grid that does bill. The blob write above has dropped them;
  // this pulls any Intercompany billing entry that outlived them.
  //
  // Not a formality even though these rows are always Non-Billable: the dust
  // tab's reconciler gates on HOURS rather than money (see _reconcileEesBilling
  // in dust.html), so a non-billable haul does reach Intercompany — at $0, so
  // the work is visible over there rather than missing. An entry left behind
  // would go on reporting hours the timesheet no longer describes.
  const dropped = [...prior.keys()].filter(id => !keep.has(id));
  if (dropped.length) {
    try {
      await removeIcBillingEntries(sql, companyCode, IC_SOURCE_EES_OTHER, dropped);
    } catch (err) {
      console.error('[timesheet-entries] removing EES IC billing entries failed:', err.message);
    }
  }

  // Approving is a deliberate statement that this work counts, so it undoes an
  // Intercompany removal recorded against the row rather than being silently
  // overruled by it — the same rule the other two grids follow, and reachable
  // for the same reason: the id is stable across re-approval.
  if (flags.clearSuppression) {
    for (const row of rows) {
      try {
        await clearIcSuppression(sql, companyCode, IC_SOURCE_EES_OTHER, row.id);
      } catch (err) {
        console.error('[timesheet-entries] clearing EES IC suppression failed:', err.message);
      }
    }
  }
  return rows;
}

// Removals recorded by an intercompany user (see _suppressIcEntry in
// intercompany.html). A suppressed row is not recreated by the division that
// owns it, which is what makes a deletion over there stick.
const IC_REMOVED_BLOB = 'fct_intercompany_removed_entries';

/**
 * Drop any intercompany removal recorded against one row. Returns the count.
 *
 * Approving is a deliberate statement that this work counts, so it undoes an
 * earlier removal rather than being silently overruled by it. This matters
 * here and nowhere else because the EES row id is stable across re-approval:
 * without this the row would stay suppressed forever, never bill again, and
 * leave the tab showing "Removed in IC" with no way back.
 */
async function clearIcSuppression(sql, companyCode, source, sourceId) {
  // One statement, deliberately. Reading the list and writing it back would
  // race the intercompany page recording a removal: it reads [A], the page
  // writes [A,B], it writes [] — and B is silently gone, so that row quietly
  // comes back. jsonb_agg rebuilds the array inside the UPDATE, so there is no
  // window. The EXISTS guard keeps it from touching the row (or updated_at)
  // when there was nothing to clear.
  const scoped = `${companyCode}:${IC_REMOVED_BLOB}`;
  const rows = await sql`
    UPDATE app_data
       SET value = COALESCE((
             SELECT jsonb_agg(t)
               FROM jsonb_array_elements(value) AS t
              WHERE NOT (t->>'source' = ${source} AND t->>'source_id' = ${sourceId})
           ), '[]'::jsonb),
           updated_at = NOW()
     WHERE key = ${scoped}
       AND jsonb_typeof(value) = 'array'
       AND EXISTS (
             SELECT 1
               FROM jsonb_array_elements(value) AS t
              WHERE t->>'source' = ${source} AND t->>'source_id' = ${sourceId}
           )
    RETURNING 1 AS cleared
  `;
  // At most one removal exists per (source, source_id) — the writer dedups —
  // so this is 1 when one was cleared and 0 when there was nothing to clear.
  return rows.length;
}

/**
 * Remove every EES Other row injected from this entry. Returns the count.
 */
async function removeEesOtherRows(sql, companyCode, entry) {
  const prefix    = eesOtherRowIdPrefix(entry.id);
  const arr       = await readBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB);
  const isMine    = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);
  const removed   = arr.filter(isMine);
  if (!removed.length) return 0;
  await writeBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB, arr.filter(r => !isMine(r)));
  return removed.length;
}

/**
 * Remove every Truck Tracking row injected from this entry — from the
 * fct_truck_division blob, the truck_division_entries mirror, and the shared
 * Intercompany billing list. Returns the count removed.
 *
 * The Intercompany sweep is what makes an un-approval stick. Without it the
 * billing entry outlived the row: Intercompany went on invoicing hours payroll
 * had just taken back, and trucking.html — which reads a billing entry with no
 * matching row as a row lost to a blob overwrite — rebuilt the row from it on
 * the next page load. The rebuilt row carried the original id, which the tab
 * refuses to delete and which a later re-approval no longer owned, so it sat
 * there permanently alongside the corrected one. Any Intercompany-side invoice
 * or payment dates on the entry go with it; that is the intended trade, since
 * the work it billed for is no longer approved.
 */
async function removeTruckingRows(sql, companyCode, entry) {
  const prefix    = truckingRowIdPrefix(entry.id);
  const isMine    = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);
  const arr       = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  const removed   = arr.filter(isMine);
  if (!removed.length) return 0;
  await writeBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB, arr.filter(r => !isMine(r)));
  const removedIds = removed.map(r => String(r.id)).filter(Boolean);
  if (removedIds.length) {
    await sql`DELETE FROM truck_division_entries WHERE company_code = ${companyCode} AND id = ANY(${removedIds})`;
    // Non-fatal. Throwing would fail the un-approve after the row is already
    // gone, and the retry would find nothing to remove and return early — so
    // the billing entry would be stranded by the very error meant to protect
    // it. Reported instead; the read-time sweep and the trucking page's own
    // reconciler both prune a billing entry whose row no longer exists.
    try {
      await removeIcBillingEntries(sql, companyCode, IC_SOURCE_TRUCKING, removedIds);
    } catch (err) {
      console.error('[timesheet-entries] removing IC billing entries failed:', err.message);
    }
  }
  return removed.length;
}

// True when an approved dust entry still has its injected EES Other row. Used by
// the PUT guard so an approved entry can't be edited out from under the tab.
async function eesOtherHasInjectedRow(sql, companyCode, entry) {
  const prefix = eesOtherRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB);
  return arr.some(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix));
}

// True when an approved trucking entry still has an injected Truck Tracking row.
// Used by the PUT guard to force un-approve-before-edit (same rule as quarry).
async function truckingHasInjectedRow(sql, companyCode, entry) {
  const prefix = truckingRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  return arr.some(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix));
}

// The injected Truck Tracking rows for an entry, in leg order, so the payroll
// modal can pre-fill the haul fee + division when re-editing an approved entry
// (mirrors the GET action=split contract quarry uses). `row` is the first leg,
// which is the whole answer for a day that was never split — and is what a
// payroll page cached from before splitting existed still reads.
async function truckingSplitForEntry(sql, companyCode, entry) {
  const prefix = truckingRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  const rows   = arr
    .filter(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix))
    // By leg, not by id text: "tst-9-row" and "tst-9-2" don't sort into leg
    // order as strings, and the modal fills its hauls in the order given.
    .map(r => ({ r, leg: truckRowLegIndex(r.id) }))
    .sort((a, b) => a.leg - b.leg)
    // The leg of the DAY each row describes, carried on the row itself.
    //
    // A dust day no longer posts one here per haul — only the hauls billed off
    // Other Billing — so position in this list stopped being position in the
    // day, exactly as it did on the dust side when a haul could first be billed
    // as material. Without the leg, a day whose SECOND haul was material
    // re-opened with that haul's fee filled into the first haul's box, and
    // saving wrote it back that way.
    //
    // Additive: a payroll page cached from before this ignores the key and
    // reads the list positionally, which is still right for every trucking day
    // — there every leg posts, so position IS the leg.
    .map(({ r, leg }) => ({ ...r, leg }));
  return { rows, row: rows[0] || null };
}

// ── Dust Control Tracking helpers (timesheet → dust_control_entries) ───────
// A dust customer haul injects a SECOND row alongside the Truck Tracking one:
// the Dust Control Tracking row the dust office bills from. See the header of
// lib/dust-injected.js for why both exist and what each one carries.
//
// Unlike trucking's blob this tab is a normalized table, so injection is a plain
// upsert keyed on the stable row id — no read-modify-write, and no mirror to
// keep in step.

// A dust row's money columns are NUMERIC(10,4). Blank stays blank so a rate the
// approver hasn't set yet round-trips as "not set" rather than as a real zero,
// which would bill the customer nothing and look deliberate.
// The widest value the columns can actually hold. v1_rate, v2_rate and
// gallons_ub are all NUMERIC(10,4) — ten significant digits with four after the
// point, so six integer digits. A ceiling any wider than this does not reject a
// fat-fingered figure, it accepts one Postgres then refuses with a 22003
// overflow, which surfaces as a 500 that rolls the whole approval back: the
// supervisor is told the approval failed rather than that the gallons are wrong.
const DUST_NUMERIC_MAX = 999999.9999;
const DUST_RATE_MAX    = DUST_NUMERIC_MAX;
const DUST_GALLONS_MAX = DUST_NUMERIC_MAX;
function dustNum(v, max, label) {
  // Trimmed first, for the same reason as truckFee: Number(' ') is 0, and a
  // rate or a gallons figure stored as a real zero bills the customer nothing
  // and looks deliberate.
  if (v == null || String(v).trim() === '') return { value: '' };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) {
    return { error: `${label} must be a number between 0 and ${max}` };
  }
  return { value: Math.round(n * 10000) / 10000 };
}

/**
 * Validate ONE leg of the payroll modal payload for a Dust Control Tracking
 * injection. Returns { fields } or { error }.
 *
 * Every field is optional, and ABSENT is not the same as BLANK — the same
 * distinction validateTruckingInjection draws for the unit, and for the same
 * reason. The approve modal sends every key because it shows every box, so
 * whatever is in them is the approver's answer, '' included: clearing the escort
 * vehicle has to stick. Bulk approve sends none of them, because one company man
 * or one gallons figure cannot speak for a week of hauls, and that has to mean
 * "derive what you can from the customer" rather than "blank it".
 *
 * Absent → undefined here, and insertDustTrackingRows fills it from the customer
 * (or, for the times, from the timesheet).
 */
function validateDustLeg(raw) {
  const t = (raw && typeof raw === 'object') ? raw : {};
  const has = k => Object.prototype.hasOwnProperty.call(t, k) && t[k] != null;
  const fields = {};

  if (has('company_man')) fields.company_man = safeStr(t.company_man, 200) || '';
  if (has('location'))    fields.location    = safeStr(t.location, 500)    || '';
  if (has('state'))       fields.state       = safeStr(t.state, 50)        || '';
  if (has('vehicle1'))    fields.vehicle1    = safeStr(t.vehicle1, 200)    || '';
  if (has('vehicle2'))    fields.vehicle2    = safeStr(t.vehicle2, 200)    || '';
  if (has('v1_unit'))     fields.v1_unit     = safeStr(t.v1_unit, 100)     || '';
  if (has('v2_unit'))     fields.v2_unit     = safeStr(t.v2_unit, 100)     || '';
  // Which customer this leg was hauled for. Absent (and blank) means the one the
  // driver picked on the timesheet — only a split day names anyone else, and a
  // leg that names nobody must not post a row with no company on it.
  if (has('company'))     fields.company     = safeStr(t.company, 200)     || '';

  // Which of the dust office's three grids this haul posts into. The same
  // driver, truck and clock window is UB on a well pad, a delivery of material,
  // or work that is tracked and billed to nobody — and the office records those
  // on different grids on different bases — so the destination belongs to the
  // HAUL, not to the entry.
  //
  // Absent means 'dust', which is what every client that predates the toggle
  // sends and what bulk approve sends. Anything else is refused rather than
  // coerced: a typo silently billing UB rates against a material delivery is
  // the one mistake this field can make, and it is invisible afterwards.
  if (has('dest')) {
    const d = safeStr(t.dest, 20) || '';
    if (d && !LEG_DESTS.includes(d)) {
      return { error: `dest must be one of ${LEG_DESTS.map(x => `"${x}"`).join(', ')} (got "${d}")` };
    }
    fields.dest = d || 'dust';
  }

  // The Other Billing columns. Only read when the leg is headed there — a dust
  // leg that carries them (the modal keeps a leg's answers when the toggle is
  // flipped back and forth) simply posts a tracking row that has no such
  // columns, and vice versa. Validated either way so a bad number is a 400
  // before anything is written rather than after the tracking half already is.
  if (has('trailer_number')) fields.trailer_number = safeStr(t.trailer_number, 100) || '';
  if (has('material'))       fields.material       = safeStr(t.material, 200)       || '';
  if (has('mu'))             fields.mu             = safeStr(t.mu, 100)             || '';

  // The leg's own slice of the driver's day. The dust tab bills rate x (end -
  // start), so these ARE the leg's hours: a day split 5/5 has to arrive as two
  // windows, not as one window billed twice.
  for (const key of ['start_time', 'end_time']) {
    if (!has(key)) continue;
    const given = String(t[key] || '').trim();
    if (!given) { fields[key] = ''; continue; }
    const v = safeTime(given);
    if (!v) return { error: `${key} must be HH:MM` };
    fields[key] = v;
  }

  for (const [key, max, label] of [
    ['v1_rate',        DUST_RATE_MAX,    'v1_rate'],
    ['v2_rate',        DUST_RATE_MAX,    'v2_rate'],
    ['gallons_ub',     DUST_GALLONS_MAX, 'gallons_ub'],
    // Other Billing's money, on the same limits: the two tabs bill the same
    // hauls and a figure one accepted and the other refused would post half a
    // day.
    ['gallons_bags',   DUST_GALLONS_MAX, 'gallons_bags'],
    ['price_per_unit', DUST_RATE_MAX,    'price_per_unit'],
    ['trucking_rate',  DUST_RATE_MAX,    'trucking_rate'],
  ]) {
    if (!has(key)) continue;
    const { value, error } = dustNum(t[key], max, label);
    if (error) return { error };
    fields[key] = value;
  }
  return { fields };
}

/**
 * Validate the whole payload (req.body.dust). Returns { rows } — one entry per
 * leg, in the order they were sent — or { error }.
 *
 * Three shapes are accepted, because three callers send it:
 *   absent            → [{}]           bulk approve: derive everything
 *   a flat object     → [{ ...one }]   the modal before the day could be split,
 *                                      and any client still sending that shape
 *   { rows: [...] }   → [{ ...each }]  the split-aware modal
 *
 * An empty rows array is an error rather than "no rows": a dust customer haul
 * always bills somewhere, and silently posting nothing would leave the office
 * looking for an invoice line that no longer exists.
 */
function validateDustInjection(raw) {
  let legs;
  if (raw == null) legs = [{}];
  else if (Array.isArray(raw)) legs = raw;
  else if (typeof raw === 'object' && Array.isArray(raw.rows)) legs = raw.rows;
  else if (typeof raw === 'object') legs = [raw];
  else legs = [{}];

  if (!legs.length) return { error: 'Dust Control Tracking needs at least one row' };
  if (legs.length > MAX_DUST_ROWS) {
    return { error: `A day can be split across at most ${MAX_DUST_ROWS} Dust Control Tracking rows` };
  }

  const rows = [];
  for (const leg of legs) {
    const { fields, error } = validateDustLeg(leg);
    if (error) return { error };
    rows.push(fields);
  }
  return { rows };
}

/**
 * Everything the approve modal (and the injection itself) needs to fill a Dust
 * Control Tracking row in for one customer: the company's men and locations, its
 * default vehicle rates, the division's equipment list, and the escort vehicle
 * this customer usually gets.
 *
 * The customer is resolved by dust_companies.id — that is what the timesheet
 * stores in job_id (see dustJobs in api/timesheet-jobs.js) — and only falls back
 * to matching job_label by name, so a customer renamed since the driver
 * submitted still resolves. `companyName` overrides both: a split leg can name
 * another customer entirely (one pad for CNX, the next for Antero on the same
 * ten hours), and that leg's rates, men and pads have to come from the customer
 * it actually billed rather than from the one at the top of the timesheet.
 *
 * `usualVehicle2` is learned rather than configured: there is no per-customer
 * default vehicle in dust_companies, only a default RATE, and the escort a
 * customer gets has been the same vehicle on every row for as long as the tab
 * has existed. So the most recent non-blank vehicle2 on that customer's own rows
 * is the answer, and it is offered only when the customer has a V2 default rate
 * set — a customer billed no escort rate is not sent an escort.
 */
async function dustOptionsForEntry(sql, companyCode, entry, companyName, opts = {}) {
  // An overriding name is the leg's whole answer: it is resolved by name only,
  // never by the entry's job_id, or a leg moved to another customer would keep
  // reading the timesheet customer's rates.
  const override = safeStr(companyName, 200) || '';
  const jobId = override ? '' : (safeStr(entry && entry.job_id, 200) || '');
  const label = override || (safeStr(entry && entry.job_label, 500) || '');

  const [byId] = jobId ? await sql`
    SELECT id, name, v1_rate, v2_rate FROM dust_companies
    WHERE company_code = ${companyCode} AND id = ${jobId}
  ` : [];
  const [byName] = (!byId && label) ? await sql`
    SELECT id, name, v1_rate, v2_rate FROM dust_companies
    WHERE company_code = ${companyCode} AND name = ${label}
  ` : [];
  const co = byId || byName || null;

  const [men, locations, equipment] = co ? await Promise.all([
    sql`SELECT name FROM dust_company_personnel WHERE dust_company_id = ${co.id} ORDER BY sort_order, name`,
    sql`SELECT name, state FROM dust_company_locations WHERE dust_company_id = ${co.id} ORDER BY sort_order, name`,
    sql`SELECT name, unit_number, vehicle_rate FROM dust_equipment WHERE company_code = ${companyCode} ORDER BY sort_order, name`,
  ]) : [[], [], await sql`
    SELECT name, unit_number, vehicle_rate FROM dust_equipment
    WHERE company_code = ${companyCode} ORDER BY sort_order, name
  `];

  // The Material and MU lists the Other Billing grid's own dropdowns are built
  // from. Offered in the approve modal for the same reason the men and the pads
  // are: a haul billed under a material spelled its own way is a material the
  // office's filters and totals never group with the rest.
  //
  // Fetched ONLY for the modal (?action=split), never for an injection. Each
  // call is three queries, dustRosterNames is asked twice, and this function
  // runs once per distinct customer in EACH of the two injection paths — so a
  // two-customer approve was issuing up to 24 round trips inside the request
  // that also has to roll the approval back if anything throws, for lists
  // neither injection reads (buildObRow takes material and mu straight off the
  // validated leg).
  const [materials, mu] = opts.withLists
    ? await Promise.all([
        dustRosterNames(sql, companyCode, 'dust_materials', 'materials'),
        dustRosterNames(sql, companyCode, 'dust_mu',        'mu'),
      ])
    : [[], []];

  const v2Rate = co && co.v2_rate != null ? Number(co.v2_rate) : null;
  let usualVehicle2 = '';
  if (co && v2Rate != null) {
    // Newest first by the same ordering the tab lists rows in. LIMIT 1 rather
    // than a mode/most-common query: when a customer's escort changes, the new
    // one is the right answer from the next haul on, not once it outnumbers the
    // old one.
    const [recent] = await sql`
      SELECT vehicle2 FROM dust_control_entries
      WHERE company_code = ${companyCode}
        AND company      = ${co.name}
        AND COALESCE(vehicle2, '') <> ''
        -- Never learn from the rows we are about to overwrite. Re-approving
        -- would otherwise read its own previous output back as "what this
        -- customer usually gets", so an escort picked once could never be
        -- un-picked by clearing it and re-approving. Every leg of the day is
        -- excluded, not just the one being written: on a split day leg 2 would
        -- otherwise learn its escort from leg 1's un-rewritten copy.
        AND id NOT LIKE ${dustRowIdPrefix(entry.id) + '%'}
      -- NULLS LAST because DESC puts them FIRST in Postgres: one undated row
      -- would otherwise be every customer's "most recent" escort forever.
      ORDER BY date DESC NULLS LAST, created_at DESC
      LIMIT 1
    `;
    usualVehicle2 = (recent && recent.vehicle2) || '';
  }

  return {
    company:   co ? co.name : label,
    known:     !!co,
    v1_rate:   co && co.v1_rate != null ? Number(co.v1_rate) : null,
    v2_rate:   v2Rate,
    men:       men.map(m => m.name).filter(Boolean),
    locations: locations.map(l => ({ name: l.name, state: l.state || '' })).filter(l => l.name),
    equipment: equipment.map(e => ({
      name:         e.name,
      unit_number:  e.unit_number || '',
      vehicle_rate: e.vehicle_rate != null ? Number(e.vehicle_rate) : null,
    })).filter(e => e.name),
    materials,
    mu,
    usual_vehicle2: usualVehicle2,
  };
}

/**
 * Resolve one vehicle slot the way dust.html's setVehicle does, so a row
 * injected here and a row typed into the tab by hand agree.
 *
 * Unit number comes from the equipment list. The rate prefers the CUSTOMER's
 * default for the slot — company wins over equipment, which is the rule the tab
 * applies — and only falls back to the equipment's own rate when the customer
 * has none set. An explicit value from the approve modal beats both: the box was
 * shown pre-filled with exactly this cascade, so anything different in it is a
 * deliberate correction.
 */
function resolveDustVehicle(name, given, opts, coRate) {
  const vehicle = safeStr(name, 200) || '';
  const eq = vehicle
    ? (opts.equipment || []).find(e => String(e.name).toLowerCase() === vehicle.toLowerCase())
    : null;
  // An empty slot bills nothing, and that outranks anything the modal sent.
  // The tab multiplies rate x hours without ever looking at the vehicle NAME,
  // so a rate left behind after the vehicle was cleared is a real charge for a
  // truck that never rolled — the same invented charge materializeCompanyVehicleRates
  // refuses to create in dust.html. Clearing the vehicle clears the slot.
  if (!vehicle) return { vehicle: '', unit: '', rate: '' };
  const unit = given.unit !== undefined
    ? (safeStr(given.unit, 100) || '')
    : ((eq && eq.unit_number) || '');
  let rate;
  if (given.rate !== undefined) rate = given.rate;
  else if (coRate != null)      rate = coRate;
  else if (eq && eq.vehicle_rate != null) rate = eq.vehicle_rate;
  else rate = '';
  return { vehicle, unit, rate };
}

/**
 * Build + upsert ONE leg's Dust Control Tracking row for an approved dust
 * customer haul. Idempotent on the stable row id, so a retried approve, an Edit
 * Row and an un-approve/re-approve cycle all land on the same row. Returns the
 * row.
 *
 * Autofill, column by column, matching what the tab's own columns are:
 *   date                        ← the timesheet entry, verbatim
 *   start_time, end_time        ← the entry's clock window, or the leg's own
 *                                 slice of it on a split day
 *   company                     ← the customer the driver picked (job_label),
 *                                 or the customer this leg names
 *   company_man, location       ← the approving supervisor, in the modal
 *   state                       ← the location's state, as picking a location
 *                                 does in the tab
 *   vehicle1                    ← the unit off the timesheet, correctable
 *   v1_unit, v1_rate            ← the equipment list / the customer's V1 default
 *   vehicle2                    ← the escort this customer usually gets
 *   v2_unit, v2_rate            ← the equipment list / the customer's V2 default
 *   gallons_ub                  ← the approving supervisor, in the modal
 *
 * Hours are NOT stored: the tab derives Total Time from start and end, so a
 * stored figure would be a second source of truth for the same number. That is
 * also why splitting a day means splitting its clock window — the leg's times
 * are the only place its hours can live. It does mean travel hours logged
 * outside the clock window don't reach this row's vehicle totals; the Truck
 * Tracking row, which bills on hours, is where they land.
 *
 * The invoice columns (DUST_TAB_FIELDS) belong to the dust office and are
 * carried across re-injection, so correcting an entry can't wipe the invoice
 * number or paid date off a row that was already billed.
 */
async function insertDustTrackingLeg(sql, companyCode, entry, fields = {}, flags = {}, index = 1, cache = null) {
  const id   = dustRowId(entry.id, index);
  const hhmm = v => String(v || '').slice(0, 5);
  // Five queries answer "what does this customer imply" — the company, its men,
  // its pads, the division's equipment list and the escort it usually gets — and
  // a six-haul day asked all five six times over, serially, inside the request
  // that also rolls the approval back if anything throws. Legs on the same
  // customer get the same answer, so it is fetched once per distinct customer.
  const key  = String(fields.company || '').trim().toLowerCase();
  let opts;
  if (cache && cache.has(key)) opts = cache.get(key);
  else {
    opts = await dustOptionsForEntry(sql, companyCode, entry, fields.company);
    if (cache) cache.set(key, opts);
  }

  // Location is resolved first because the state follows from it, exactly as
  // picking a location in the tab fills the state in. Nobody but the approver
  // knows the pad, so there is nothing to derive it from — absent means blank.
  // An explicit state still wins over the location's, so a one-off job across a
  // state line can be corrected.
  const location = fields.location || '';
  const locHit = location
    ? (opts.locations || []).find(l => String(l.name).toLowerCase() === String(location).toLowerCase())
    : null;
  const state = fields.state !== undefined
    ? fields.state
    : ((locHit && locHit.state) || '');

  // Vehicle 1 is the truck the driver logged on the timesheet. Payroll can
  // correct it in the modal — the Unit box on the driver's form is free text
  // against the TRUCKING office's roster, and dust names its vehicles its own
  // way ("Distributor Truck 4000"), so the two don't always agree.
  const v1 = resolveDustVehicle(
    fields.vehicle1 !== undefined ? fields.vehicle1 : (entry.truck_unit || ''),
    { unit: fields.v1_unit, rate: fields.v1_rate },
    opts, opts.v1_rate,
  );
  // Vehicle 2 is the escort. Nobody enters it on the timesheet — it follows from
  // the customer, which is why it can be filled in without asking.
  const v2 = resolveDustVehicle(
    fields.vehicle2 !== undefined ? fields.vehicle2 : opts.usual_vehicle2,
    { unit: fields.v2_unit, rate: fields.v2_rate },
    opts, opts.v2_rate,
  );

  // A leg's own window, falling back to the whole day's — which is what a single
  // unsplit haul, and every bulk approval, sends. A leg that clears a time keeps
  // it clear: the tab reads a missing end as "no hours yet" rather than as the
  // driver's clock-out, and that is a state a supervisor can deliberately leave
  // a row in while they check what the pad actually took.
  const startTime = fields.start_time !== undefined ? fields.start_time : hhmm(entry.start_time);
  const endTime   = fields.end_time   !== undefined ? fields.end_time   : hhmm(entry.end_time);

  const row = {
    id,
    date:        safeDate(entry.work_date) || '',
    start_time:  startTime,
    end_time:    endTime,
    company:     opts.company || '',
    company_man: fields.company_man !== undefined ? fields.company_man : '',
    location,
    state,
    vehicle1:    v1.vehicle, v1_unit: v1.unit, v1_rate: v1.rate,
    vehicle2:    v2.vehicle, v2_unit: v2.unit, v2_rate: v2.rate,
    gallons_ub:  fields.gallons_ub !== undefined ? fields.gallons_ub : '',
    inv_number: '', inv_sent: '', inv_received: '', inv_status: '',
    cm_approval: '', inv_location: '',
  };

  // Carry over whatever the dust office already put on the prior row — but only
  // while it is the same haul. A leg id is positional, so removing the first
  // haul of a two-haul day rewrites the second under the first one's id, and
  // carrying on id alone moved one customer's invoice number, sent/received
  // dates and company-man approval onto another customer's row while deleting
  // the row they actually described. A slot whose customer changed starts its
  // invoice sub-row clean.
  const [prev] = await sql`
    SELECT * FROM dust_control_entries
    WHERE company_code = ${companyCode} AND id = ${id}
  `;
  const sameCompany = prev
    && String(prev.company || '').trim().toLowerCase() === String(row.company || '').trim().toLowerCase();
  if (prev && sameCompany) {
    for (const f of DUST_TAB_FIELDS) {
      const v = (f === 'inv_sent' || f === 'inv_received') ? safeDate(prev[f]) : prev[f];
      if (v !== undefined && v !== null && v !== '') row[f] = v;
    }
  }

  await sql`
    INSERT INTO dust_control_entries (
      id, company_code,
      date, start_time, end_time,
      company, company_man, location, state,
      vehicle1, v1_unit, v1_rate,
      vehicle2, v2_unit, v2_rate,
      gallons_ub,
      inv_number, inv_sent, inv_received, inv_status,
      cm_approval, inv_location,
      updated_at
    ) VALUES (
      ${row.id}, ${companyCode},
      ${safeDate(row.date)}, ${row.start_time || null}, ${row.end_time || null},
      ${row.company || null}, ${row.company_man || null}, ${row.location || null}, ${row.state || null},
      ${row.vehicle1 || null}, ${row.v1_unit || null}, ${truckNum(row.v1_rate)},
      ${row.vehicle2 || null}, ${row.v2_unit || null}, ${truckNum(row.v2_rate)},
      ${truckNum(row.gallons_ub)},
      ${row.inv_number || null}, ${safeDate(row.inv_sent)}, ${safeDate(row.inv_received)}, ${row.inv_status || null},
      ${row.cm_approval || null}, ${row.inv_location || null},
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      date         = EXCLUDED.date,
      start_time   = EXCLUDED.start_time,
      end_time     = EXCLUDED.end_time,
      company      = EXCLUDED.company,
      company_man  = EXCLUDED.company_man,
      location     = EXCLUDED.location,
      state        = EXCLUDED.state,
      vehicle1     = EXCLUDED.vehicle1,
      v1_unit      = EXCLUDED.v1_unit,
      v1_rate      = EXCLUDED.v1_rate,
      vehicle2     = EXCLUDED.vehicle2,
      v2_unit      = EXCLUDED.v2_unit,
      v2_rate      = EXCLUDED.v2_rate,
      gallons_ub   = EXCLUDED.gallons_ub,
      -- The six invoice columns are deliberately ABSENT from this SET list.
      -- They belong to the dust office, and an UPDATE has nothing to say about
      -- them: on a first INSERT they are written blank from the VALUES above,
      -- and after that only the office's own saves change them. Writing them
      -- here meant re-reading them a moment earlier and echoing them back, and
      -- with no transaction on Neon an invoice number the office typed between
      -- that read and this write was echoed away again.
      updated_at   = NOW()
  `;

  // APPROVING is a deliberate statement that this work counts, so it undoes an
  // earlier Intercompany removal rather than being silently overruled by it —
  // the same rule the trucking and EES rows apply, and reachable here for the
  // same reason: the row id is stable across a re-approval.
  //
  // Editing the row is NOT that statement. Nothing was deleted and nothing
  // needs recovering; the row has been billing (or deliberately not) all along.
  // Clearing the suppression here meant that correcting a gallons figure
  // silently un-deleted an entry somebody had removed in Intercompany, and the
  // only sign of it was the money reappearing.
  //
  // A slot whose OCCUPANT changed is the third case, and it is not an editing
  // decision either: removing the first haul of a two-haul day rewrites the
  // second under the first one's id, and a removal recorded in Intercompany
  // against the customer who left would go on suppressing the customer who
  // arrived — work that has never been billed and now never would be.
  if (flags.clearSuppression || (prev && !sameCompany)) {
    try {
      await clearIcSuppression(sql, companyCode, IC_SOURCE_DUST, id);
    } catch (err) {
      console.error('[timesheet-entries] clearing dust IC suppression failed:', err.message);
    }
  }

  // Payroll's write shows up in the dust tab's own audit log, tagged like any
  // other tracking edit, so the office can see where a row came from. Non-fatal:
  // the audit table is created lazily by api/dust-rows.js and may not exist yet
  // on a company that has never opened the tab.
  try {
    await sql`
      INSERT INTO dust_control_audit_log
        (company_code, row_id, action, user_id, username, changes, snapshot, source)
      VALUES
        (${companyCode}, ${id}, ${prev ? 'UPDATE' : 'INSERT'},
         null, ${'payroll approval'}, null,
         ${JSON.stringify({ timesheet_entry_id: entry.id, employee: entry.username || '', leg: index })}::jsonb,
         'tracking')
    `;
  } catch (err) {
    console.error('[timesheet-entries] dust audit write failed (non-fatal):', err.message);
  }

  return row;
}

/**
 * Write every leg of an approved dust haul, and take back the legs it no longer
 * has. Returns the rows written, in leg order.
 *
 * The pruning is the half that is easy to miss: a day first approved as three
 * customers and then corrected to two leaves leg 3's row — and leg 3's
 * Intercompany billing entry — behind, invoicing a customer for hauling that,
 * according to the timesheet, never happened. Nothing else would ever remove it:
 * the dust tab refuses to delete payroll's rows, and the read-time sweep only
 * asks whether the ENTRY still routes here, which it does.
 *
 * Legs are written in order and pruned after, so a mid-loop failure leaves the
 * earlier legs in place for the caller's rollback to scrub rather than deleting
 * rows it is about to rewrite.
 */
async function insertDustTrackingRows(sql, companyCode, entry, legs, flags = {}) {
  const list = (Array.isArray(legs) && legs.length) ? legs : [{}];
  const rows = [];
  const optsCache = new Map();
  for (let i = 0; i < list.length; i++) {
    const leg = list[i] || {};
    // The day's legs arrive whole and in order, whichever tab each is headed
    // for, and the index IS the leg's position in the DAY. Both halves number
    // from it, so a haul re-pointed from one tab to the other keeps its place
    // rather than renumbering everything after it. A leg headed for Other
    // Billing or EES Other is skipped here and written by that grid's own
    // injector; the prune below then takes back the tracking row it used to
    // have, along with that row's Intercompany billing entry — otherwise
    // flipping a haul to material would leave the UB invoice line standing
    // beside the new one.
    //
    // Tested POSITIVELY. Skipping only `=== 'ob'` meant this grid claimed every
    // destination that did not exist yet, so adding EES Other would have posted
    // a UB row beside every EES row.
    if (legDest(leg) !== 'dust') continue;
    rows.push(await insertDustTrackingLeg(sql, companyCode, entry, leg, flags, i + 1, optsCache));
  }
  const keep = new Set(rows.map(r => r.id));
  const prior = await sql`
    SELECT id FROM dust_control_entries
    WHERE company_code = ${companyCode} AND id LIKE ${dustRowIdPrefix(entry.id) + '%'}
  `;
  const drop = prior.map(r => String(r.id)).filter(id => id && !keep.has(id));
  if (drop.length) await deleteDustRows(sql, companyCode, drop);
  return rows;
}

/**
 * Write this entry's dust half as exactly ONE haul, and take back every other
 * haul it had. The name says "row" because it returns one; it is not a way to
 * rewrite one row of a split day and leave the rest alone — there is no such
 * thing, since the legs it does not write are legs the day no longer has.
 *
 * Kept because an unsplit haul is the common case and reads better as one call.
 */
async function insertDustTrackingRow(sql, companyCode, entry, fields = {}, flags = {}) {
  const [row] = await insertDustTrackingRows(sql, companyCode, entry, [fields], flags);
  return row;
}

// ── Dust "Other Billing" injection ────────────────────────────────────────
// The second of the dust office's two billing tabs. Same hauls, same approval,
// different invoice: Dust Control Tracking bills vehicle rates times hours plus
// UB gallons, Other Billing bills quantity times price per unit plus trucking
// hours times a trucking rate. See api/lib/dust-ob-injected.js for why the
// choice belongs to the haul rather than to the entry.

// The three grids a dust haul can post its billing row into:
//
//   'dust'  Dust Control Tracking — UB on a pad, vehicle rates times hours
//   'ob'    Other Billing         — material delivered, qty times price
//   'ees'   EES Other             — the same work, not billed to anybody
//
// Anything else — including absent — means the tracking tab. That is what every
// client predating the toggle sends, and what bulk approve sends, and it is the
// behaviour those callers already had.
//
// Read POSITIVELY by every writer (`=== 'dust'`, `=== 'ob'`, `=== 'ees'`), never
// by excluding the other one: a writer that skipped `=== 'ob'` and wrote
// everything else claimed each new destination as it was added, so the day would
// post an EES row AND the UB row it was moved off.
const LEG_DESTS = ['dust', 'ob', 'ees'];
function legDest(leg) {
  const d = leg && leg.dest;
  return LEG_DESTS.includes(d) ? d : 'dust';
}

// A leg's own hours, from its own clock window. Other Billing STORES trucking
// hours (the tracking tab derives them from start and end instead), so this is
// where the two tabs could disagree about the same haul — it deliberately uses
// the wrap-at-midnight rule dust.html's own calc() applies, so a night haul
// bills the same figure on either grid.
function legHours(start, end) {
  const mins = v => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    return (h > 23 || mi > 59) ? null : h * 60 + mi;
  };
  const s = mins(start), e = mins(end);
  if (s == null || e == null) return '';
  let d = e - s;
  if (d < 0) d += 1440;              // ran past midnight
  return _r2(d / 60);
}

/**
 * The dust office's own employee roster, for putting a real name on the Driver
 * column of an injected Other Billing row.
 *
 * The tab's Driver cell is a dropdown off this list, so a login name posted
 * verbatim would sit in it as an out-of-list value — selectable, but never
 * matching a filter or a roster the office actually recognises. Same problem,
 * and the same fix, as matchTruckingDriver on the Truck Tracking side.
 *
 * Read the way api/dust-config.js resolves the list: the normalized dropdown
 * rows unioned with the dust_lists blob's copy, because the blob is rewritten
 * whole on every save and holds names a past concurrent-write race dropped from
 * the table. An unmatched name is returned as it came — a driver missing from
 * the roster is an answer for Manage Lists, not grounds to post a blank.
 */
async function dustRosterNames(sql, companyCode, listName, blobField) {
  const [rows, scoped, legacy] = await Promise.all([
    sql`SELECT value FROM dropdown_lists
        WHERE company_code = ${companyCode} AND list_name = ${listName}
        ORDER BY sort_order, value`,
    sql`SELECT value FROM app_data WHERE key = ${companyCode + ':dust_lists'}`,
    sql`SELECT value FROM app_data WHERE key = 'dust_lists'`,
  ]);
  const blob = (scoped[0]?.value && typeof scoped[0].value === 'object') ? scoped[0].value
             : (legacy[0]?.value && typeof legacy[0].value === 'object') ? legacy[0].value
             : null;
  const out  = rows.map(r => String(r.value || '')).filter(Boolean);
  const seen = new Set(out);
  const extra = (blob && Array.isArray(blob[blobField])) ? blob[blobField] : [];
  for (const v of extra) {
    const name = String(v == null ? '' : v);
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

async function matchDustEmployee(sql, companyCode, name) {
  const n = (name || '').trim();
  if (!n) return name || '';
  const names = await dustRosterNames(sql, companyCode, 'dust_employees', 'employees');
  const hit = matchRosterEmployee(names.map(v => ({ name: v })), name);
  return hit ? hit.name : (name || '');
}

/**
 * Build ONE leg's Other Billing row. Pure apart from the customer lookup it is
 * handed — the blob write is done once for the whole day by insertObRows.
 *
 * Autofill, column by column, against what the tab's own columns are:
 *   date                  ← the timesheet entry, verbatim
 *   driver                ← the employee, matched to the dust roster
 *   truck_number          ← the unit off the timesheet, resolved to the
 *                           equipment list's unit NUMBER (which is what the
 *                           tab's Truck # dropdown holds), correctable in the
 *                           modal like the tracking row's vehicle
 *   trailer_number        ← the approving supervisor, in the modal
 *   customer              ← the customer the driver picked, or the one this leg
 *                           names
 *   destination           ← the approving supervisor (the tab calls the pad a
 *                           destination; the tracking tab calls it a location)
 *   state                 ← the destination's state, as picking one does in the
 *                           tab
 *   material, gallons_bags, mu, price_per_unit, trucking_rate
 *                         ← the approving supervisor, in the modal
 *   trucking_hrs          ← the leg's own clock window
 *   comments              ← the driver's notes, then the office's
 *
 * start_time / end_time are stored alongside, though the grid has no such
 * columns and never shows them: they are the only record of the window this
 * leg billed, and without them re-opening Edit Row could not put a material
 * haul back on screen as the haul it was. The tab renders by column name and
 * the audit diffs a fixed field list, so both ignore them.
 */
function buildObRow(entry, fields, index, opts, driver) {
  const hhmm = v => String(v || '').slice(0, 5);
  const startTime = fields.start_time !== undefined ? fields.start_time : hhmm(entry.start_time);
  const endTime   = fields.end_time   !== undefined ? fields.end_time   : hhmm(entry.end_time);

  // The destination carries the state with it, exactly as picking one in the
  // tab does. An explicit state still wins, so a one-off across a state line
  // can be corrected.
  const destination = fields.location || '';
  const locHit = destination
    ? (opts.locations || []).find(l => String(l.name).toLowerCase() === String(destination).toLowerCase())
    : null;
  const state = fields.state !== undefined ? fields.state : ((locHit && locHit.state) || '');

  // The truck. Named the way dust names its vehicles in the modal, stored the
  // way the tab's dropdown holds it — by unit number — with the typed value
  // kept when it matches nothing, so an off-roster truck still reads back.
  const truckName = fields.vehicle1 !== undefined ? fields.vehicle1 : (entry.truck_unit || '');
  const eq = truckName
    ? (opts.equipment || []).find(e => String(e.name).toLowerCase() === String(truckName).toLowerCase())
    : null;
  const truckNumber = eq ? String(eq.unit_number || '') : (safeStr(truckName, 100) || '');

  const pick = (key) => fields[key] !== undefined ? fields[key] : '';

  return {
    id:             obRowId(entry.id, index),
    date:           safeDate(entry.work_date) || '',
    inv_number:     '',
    driver:         driver || '',
    truck_number:   truckNumber,
    trailer_number: pick('trailer_number'),
    customer:       opts.company || '',
    destination,
    state,
    material:       pick('material'),
    gallons_bags:   pick('gallons_bags'),
    mu:             pick('mu'),
    price_per_unit: pick('price_per_unit'),
    trucking_hrs:   legHours(startTime, endTime),
    trucking_rate:  pick('trucking_rate'),
    comments:       entry.notes || '',
    start_time:     startTime,
    end_time:       endTime,
  };
}

/**
 * Write every leg of an approved haul that is headed for Other Billing, and
 * take back the legs it no longer has. Returns the rows written, in leg order.
 *
 * Takes the WHOLE day's legs, like insertDustTrackingRows, and skips the ones
 * bound for the tracking tab — the index is the leg's place in the day, so the
 * two halves can be written independently and still describe one split.
 *
 * The pruning matters as much as the writing: a haul re-pointed from material
 * back to UB, or a day corrected from three deliveries to two, would otherwise
 * leave a row here invoicing work the timesheet no longer describes. Nothing
 * else would ever remove it — the tab refuses to delete payroll's rows, and the
 * read-time sweep only asks whether the ENTRY still routes here, which it does.
 *
 * One blob read-modify-write for the whole day rather than one per leg, and the
 * rows this entry already had are dropped in the same write that appends their
 * replacements, so a six-leg day cannot leave a half-written list behind.
 */
async function insertObRows(sql, companyCode, entry, legs, flags = {}) {
  const list = (Array.isArray(legs) && legs.length) ? legs : [{}];
  const mine = [];
  for (let i = 0; i < list.length; i++) {
    if (legDest(list[i] || {}) === 'ob') mine.push({ index: i + 1, fields: list[i] || {} });
  }

  const prefix = obRowIdPrefix(entry.id);
  const isMine = r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix);
  const arr    = await readBlobArray(sql, companyCode, OB_BLOB_KEY);
  const prior  = new Map(arr.filter(isMine).map(r => [String(r.id), r]));

  // Nothing here now and nothing here before: the common case for a UB-only
  // day, and it must not rewrite the blob (that would race the tab's own save
  // for no reason at all).
  if (!mine.length && !prior.size) return [];

  const rows = [];
  if (mine.length) {
    // Legs on the same customer get the same answer, so the five queries behind
    // "what does this customer imply" are asked once per distinct customer
    // rather than once per leg — the same cache insertDustTrackingRows keeps.
    const optsCache = new Map();
    const driver = await matchDustEmployee(sql, companyCode, entry.username);
    for (const { index, fields } of mine) {
      const key = String(fields.company || '').trim().toLowerCase();
      let opts;
      if (optsCache.has(key)) opts = optsCache.get(key);
      else {
        opts = await dustOptionsForEntry(sql, companyCode, entry, fields.company);
        optsCache.set(key, opts);
      }
      const row = buildObRow(entry, fields, index, opts, driver);
      // Carry over what the dust office already put on the prior row — but only
      // while it is the same haul. A leg id is positional, so removing the
      // first delivery of a two-delivery day rewrites the second under the
      // first one's id, and carrying on id alone would move one customer's
      // invoice number and note onto another customer's row. A slot whose
      // customer changed starts clean. Same rule, same reason, as the tracking
      // side's sameCompany test.
      const prev = prior.get(row.id);
      const same = prev
        && String(prev.customer || '').trim().toLowerCase() === String(row.customer || '').trim().toLowerCase();
      if (prev && same) {
        for (const f of OB_TAB_FIELDS) {
          if (prev[f] !== undefined && prev[f] !== null && prev[f] !== '') row[f] = prev[f];
        }
      }
      rows.push(row);
    }
  }

  // Rewrite this entry's rows in one pass: everything that is not ours is kept
  // exactly where it was, and ours are appended in leg order.
  const keep = new Set(rows.map(r => r.id));
  const next = arr.filter(r => !isMine(r)).concat(rows);
  await writeBlobArray(sql, companyCode, OB_BLOB_KEY, next);

  // Rows this entry used to have and no longer does — a leg removed, or one
  // re-pointed at the tracking tab. The blob write above has already dropped
  // them; this is what pulls the Intercompany billing entry that outlived each,
  // which is the half that makes the removal stick.
  const dropped = [...prior.keys()].filter(id => !keep.has(id));
  if (dropped.length) {
    try {
      await removeIcBillingEntries(sql, companyCode, IC_SOURCE_OB, dropped);
    } catch (err) {
      console.error('[timesheet-entries] removing OB IC billing entries failed:', err.message);
    }
  }

  // Approving is a deliberate statement that this work counts, so it undoes an
  // Intercompany removal recorded against the row rather than being silently
  // overruled by it — the same thing the EES injection does, and for the same
  // reason: the id is stable across re-approval, so without this a row removed
  // once in Intercompany would stay suppressed forever.
  if (flags.clearSuppression) {
    for (const row of rows) {
      try {
        await clearIcSuppression(sql, companyCode, IC_SOURCE_OB, row.id);
      } catch (err) {
        console.error('[timesheet-entries] clearing OB IC suppression failed:', err.message);
      }
    }
  }
  return rows;
}

/**
 * Remove every Other Billing row injected from this entry, along with the
 * Intercompany billing entries they created. Returns the count removed.
 */
async function removeObRows(sql, companyCode, entry) {
  const prefix = obRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, OB_BLOB_KEY);
  const ids    = arr
    .filter(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix))
    .map(r => String(r.id));
  if (!ids.length) return 0;
  await deleteObRows(sql, companyCode, ids);
  return ids.length;
}

// True when an approved dust entry still has an injected Other Billing row.
// Used by the PUT guard to force un-approve-before-edit, the same rule quarry,
// trucking, EES and dust tracking apply — the row shows the entry's date, its
// customer and the hours off its clock window, so editing the entry underneath
// it would leave the invoice disagreeing with the timesheet.
async function obHasInjectedRow(sql, companyCode, entry) {
  const prefix = obRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, OB_BLOB_KEY);
  return arr.some(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix));
}

/**
 * Every injected Other Billing row for an entry, tagged with the leg of the day
 * it describes, so the payroll modal can put a material haul back on screen as
 * the haul it was.
 *
 * `leg` is what makes the two halves reassemble: a day whose middle haul was
 * material answers with legs 1 and 3 from dustSplitForEntry and leg 2 from
 * here, and the modal slots each into its own place. Without it the modal would
 * pack them tight and re-save the day with its hauls in the wrong order — under
 * the wrong customers, at the wrong rates.
 */
async function obSplitForEntry(sql, companyCode, entry) {
  const prefix = obRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, OB_BLOB_KEY);
  const n = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? '' : String(Number(v));
  const hhmm = v => String(v || '').slice(0, 5);
  const rows = arr
    .filter(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix))
    .map(r => ({ r, leg: obRowIndexFromId(r.id) }))
    // An id carrying our prefix but naming no leg is not a haul this day has.
    // Handing it to the modal would open the day with a haul the timesheet
    // never described, and saving would then mint it as a real invoice line.
    .filter(x => x.leg != null)
    .sort((a, b) => a.leg - b.leg)
    .map(({ r, leg }) => ({
      leg,
      id:             r.id,
      dest:           'ob',
      company:        r.customer       || '',
      location:       r.destination    || '',
      state:          r.state          || '',
      start_time:     hhmm(r.start_time),
      end_time:       hhmm(r.end_time),
      vehicle1:       r.truck_number   || '',
      trailer_number: r.trailer_number || '',
      material:       r.material       || '',
      gallons_bags:   n(r.gallons_bags),
      mu:             r.mu             || '',
      price_per_unit: n(r.price_per_unit),
      trucking_rate:  n(r.trucking_rate),
    }));
  return { rows };
}

/**
 * Every injected EES Other row for a CUSTOMER haul, tagged with the leg of the
 * day it describes, so the payroll modal can put a non-billable haul back on
 * screen as the haul it was.
 *
 * The third answer to the same question dustSplitForEntry and obSplitForEntry
 * answer, and reassembled by `leg` for the same reason: a day whose middle haul
 * billed nobody answers with legs 1 and 3 from the grids that do bill and leg 2
 * from here, and the modal slots each into its own place. Without it the modal
 * would pack them tight and re-save the day with its hauls in the wrong order.
 *
 * Only ever called for an entry that is a dust customer haul, so every "tse-"
 * row it can see is one of these — an entry on a standing EES activity is a
 * different gate and never reaches the modal this feeds.
 */
async function eesSplitForEntry(sql, companyCode, entry) {
  const prefix = eesOtherRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, DUST_EES_OTHER_BLOB);
  const hhmm   = v => String(v || '').slice(0, 5);
  const rows = arr
    .filter(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix))
    .map(r => ({ r, leg: eesOtherRowIndexFromId(r.id) }))
    // An id carrying our prefix but naming no leg is not a haul this day has —
    // same rule as the other two grids, and the same reason: the modal saves
    // whatever it is shown.
    .filter(x => x.leg != null)
    .sort((a, b) => a.leg - b.leg)
    .map(({ r, leg }) => ({
      leg,
      id:         r.id,
      dest:       'ees',
      company:    r.customer || '',
      location:   r.location || '',
      start_time: hhmm(r.actual_start),
      end_time:   hhmm(r.actual_end),
      vehicle1:   r.unit     || '',
    }));
  return { rows };
}

/**
 * Remove every Dust Control Tracking row injected from this entry, along with
 * the Intercompany billing entries they created. Returns the count removed.
 */
async function removeDustTrackingRows(sql, companyCode, entry) {
  const prefix = dustRowIdPrefix(entry.id);
  const rows = await sql`
    SELECT id FROM dust_control_entries
    WHERE company_code = ${companyCode} AND id LIKE ${prefix + '%'}
  `;
  const ids = rows.map(r => String(r.id)).filter(Boolean);
  if (!ids.length) return 0;
  await deleteDustRows(sql, companyCode, ids);
  return ids.length;
}

// True when an approved dust entry still has its injected Dust Control Tracking
// row. Used by the PUT guard to force un-approve-before-edit, the same rule
// quarry, trucking and EES apply.
async function dustHasInjectedRow(sql, companyCode, entry) {
  const prefix = dustRowIdPrefix(entry.id);
  const [hit] = await sql`
    SELECT 1 AS found FROM dust_control_entries
    WHERE company_code = ${companyCode} AND id LIKE ${prefix + '%'}
    LIMIT 1
  `;
  return !!hit;
}

// Every injected Dust Control Tracking row for an entry, in leg order, so the
// payroll modal can pre-fill every box of every leg when re-editing an approved
// haul (mirrors the GET action=split contract quarry and trucking use).
//
// `row` is the first leg, kept alongside `rows` so a payroll page still cached
// from before days could be split pre-fills its single set of boxes instead of
// opening blank — and blank, on a re-edit, saves as a wipe.
async function dustSplitForEntry(sql, companyCode, entry) {
  const found = await sql`
    SELECT * FROM dust_control_entries
    WHERE company_code = ${companyCode} AND id LIKE ${dustRowIdPrefix(entry.id) + '%'}
  `;
  // NUMERIC(10,4) comes back from the driver as "130.0000". The modal puts these
  // straight into number inputs, where the trailing zeros are what the approver
  // sees and then re-saves, so trim them back to the figure that was entered.
  const n = v => (v == null || v === '' || !Number.isFinite(Number(v))) ? '' : String(Number(v));
  const hhmm = v => String(v || '').slice(0, 5);
  const rows = found
    // By leg, not by id text: "tsd-9-row" and "tsd-9-2" don't sort into leg
    // order as strings, and the tab shows them in the order they are given.
    .map(r => ({ r, leg: dustRowIndexFromId(r.id) }))
    // An id that names no leg is not a haul this day has: a Date.now()-stamped
    // leftover, or a row a failed prune left behind. Handing it to the modal
    // would open the day with a haul the timesheet never described, and saving
    // would then mint it as a real invoice line. Left out, it is pruned by the
    // next save like any other row this split no longer has.
    .filter(x => x.leg != null)
    .sort((a, b) => a.leg - b.leg)
    .map(({ r, leg }) => ({
      // The leg of the DAY this row describes, and the tab it describes it in.
      // A day can now split across both dust tabs, so position in this list is
      // no longer position in the day: a middle haul billed as material answers
      // from obSplitForEntry instead, and the modal reassembles the two by leg.
      // Additive — a payroll page cached from before the toggle ignores both
      // and reads the list positionally, which is still right for every day it
      // could itself have created.
      leg,
      dest:        'dust',
      id:          r.id,
      company:     r.company     || '',
      company_man: r.company_man || '',
      location:    r.location    || '',
      state:       r.state       || '',
      start_time:  hhmm(r.start_time),
      end_time:    hhmm(r.end_time),
      vehicle1:    r.vehicle1    || '',
      v1_unit:     r.v1_unit     || '',
      v1_rate:     n(r.v1_rate),
      vehicle2:    r.vehicle2    || '',
      v2_unit:     r.v2_unit     || '',
      v2_rate:     n(r.v2_rate),
      gallons_ub:  n(r.gallons_ub),
    }));
  return { rows, row: rows[0] || null };
}

/**
 * The dust customers a split leg can be pointed at, each with the men, pads and
 * default rates that customer's own rows are filled from.
 *
 * Sent whole, once, with the modal's pre-fill: a supervisor splitting a day is
 * choosing between customers, and a round trip per pick would leave the pad and
 * rate boxes empty for as long as it took to answer. Three queries rather than
 * three per customer — the personnel and location tables are small and are
 * grouped here.
 */
async function dustCompanyDirectory(sql, companyCode) {
  const [companies, men, locations] = await Promise.all([
    sql`SELECT id, name, v1_rate, v2_rate FROM dust_companies
        WHERE company_code = ${companyCode} ORDER BY name`,
    sql`SELECT p.dust_company_id, p.name FROM dust_company_personnel p
        JOIN dust_companies c ON c.id = p.dust_company_id
        WHERE c.company_code = ${companyCode} ORDER BY p.sort_order, p.name`,
    sql`SELECT l.dust_company_id, l.name, l.state FROM dust_company_locations l
        JOIN dust_companies c ON c.id = l.dust_company_id
        WHERE c.company_code = ${companyCode} ORDER BY l.sort_order, l.name`,
  ]);
  const byId = new Map(companies.map(c => [String(c.id), {
    id:        String(c.id),
    name:      c.name || '',
    v1_rate:   c.v1_rate != null ? Number(c.v1_rate) : null,
    v2_rate:   c.v2_rate != null ? Number(c.v2_rate) : null,
    men:       [],
    locations: [],
  }]));
  for (const m of men) {
    const co = byId.get(String(m.dust_company_id));
    if (co && m.name) co.men.push(m.name);
  }
  for (const l of locations) {
    const co = byId.get(String(l.dust_company_id));
    if (co && l.name) co.locations.push({ name: l.name, state: l.state || '' });
  }
  return [...byId.values()].filter(c => c.name);
}

async function writeAudit(sql, companyCode, payload, entryId, action, changes, snapshot) {
  try {
    await sql`
      INSERT INTO timesheet_audit_log
        (company_code, entry_id, action, user_id, username, changes, snapshot)
      VALUES
        (${companyCode}, ${entryId}, ${action},
         ${payload?.userId || null}, ${payload?.username || null},
         ${changes ? JSON.stringify(changes) : null}::jsonb,
         ${snapshot ? JSON.stringify(snapshot) : null}::jsonb)
    `;
  } catch (err) {
    console.error('[timesheet-entries] audit write failed (non-fatal):', err.message);
  }
}

// ── Split-day tag ─────────────────────────────────────────────────────────
// One day spent on two jobs is submitted from timesheet.html as one form and
// arrives here as two ordinary POSTs, each carrying the same split_group_id and
// its own 1-based split_index. Nothing in this file branches on the tag — a
// split row approves, injects, edits and deletes exactly like any other entry.
// It exists so both clients can print "Split 1/2" instead of showing two
// unrelated-looking entries for the same person on the same day.
//
// Kept out of normalizeEntryBody deliberately, because the two callers need
// different behavior when the body says nothing about the tag: a POST is
// creating a row so "absent" means "not a split", while a PUT is editing one
// and "absent" must mean "leave it alone". payroll.html's admin edit form sends
// no split fields at all, and if that silently cleared the tag, correcting a
// typo on one half of a split would break its pairing with the other half.
//
// Returns null when the body carries no split keys (caller decides), or the
// resolved triple otherwise. Anything malformed, out of range, or describing a
// group of one resolves to all-nulls rather than an error: the tag is a display
// aid, and a bad one is never worth refusing a day's work over.
const SPLIT_GROUP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SPLIT_COUNT = 20;

function normalizeSplitTag(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k);
  if (!has('split_group_id') && !has('split_index') && !has('split_count')) return null;

  const none = { split_group_id: null, split_index: null, split_count: null };
  const gid = safeStr(b.split_group_id, 64);
  if (!gid || !SPLIT_GROUP_RE.test(gid)) return none;
  const count = safeInt(b.split_count);
  const index = safeInt(b.split_index);
  if (count == null || index == null) return none;
  if (count < 2 || count > MAX_SPLIT_COUNT) return none;
  if (index < 1 || index > count) return none;
  return { split_group_id: gid, split_index: index, split_count: count };
}

function normalizeEntryBody(body) {
  const entry_type = body.entry_type === 'time_off' ? 'time_off' : 'daily';

  const work_date = safeDate(body.work_date);
  if (!work_date) return { error: 'work_date (YYYY-MM-DD) is required' };

  if (entry_type === 'time_off') {
    const time_off_type = VALID_TIME_OFF.includes(body.time_off_type) ? body.time_off_type : null;
    if (!time_off_type) return { error: 'time_off_type is required (vacation, sick, jury_duty, bereavement, holiday)' };
    // Time off is tied to a supervisor too (same roster as daily entries) so
    // payroll can attribute/route it and the Scheduler knows whose crew is out.
    const supervisor_id   = safeInt(body.supervisor_id);
    const supervisor_name = safeStr(body.supervisor_name, 200);
    if (!supervisor_name) return { error: 'supervisor_name is required' };
    return {
      data: {
        entry_type,
        work_date,
        division:             null,
        job_id:               null,
        job_label:            null,
        start_time:           null,
        end_time:             null,
        computed_hours:       null,
        travel_to_site_hours: null,
        travel_to_shop_hours: null,
        travel_hours:         null,
        lunch_break:          null,
        operated_equipment:   null,
        haul_type:            null,
        supervisor_id,
        supervisor_name,
        notes:                safeStr(body.notes, 2000),
        time_off_type,
        truck_unit:           null,
        truck_description:    null,
        ees_unit:             null,
        ees_customer:         null,
        ees_location:         null,
        ees_name:             null,
        ees_job_number:       null,
        ees_billing:          null,
      },
    };
  }

  // Daily entry
  const division = VALID_DIVISIONS.includes(body.division) ? body.division : null;
  if (!division) return { error: 'division must be one of: ' + VALID_DIVISIONS.join(', ') };

  const job_id    = safeStr(body.job_id, 200);
  const job_label = safeStr(body.job_label, 500);
  if (!job_id || !job_label) return { error: 'job_id and job_label are required for a daily entry' };

  const start_time = safeTime(body.start_time);
  const end_time   = safeTime(body.end_time);
  if (!start_time || !end_time) return { error: 'start_time and end_time (HH:MM) are required' };

  const lunch_break = safeBool(body.lunch_break);

  // Lunch deduction: when the worker checked "Yes" for lunch, subtract a
  // 30-minute unpaid break from the gross start→end span. Clamp at 0 so a
  // sub-30-minute span with lunch=yes doesn't produce a negative.
  let computed_hours = computeHours(start_time, end_time);
  if (computed_hours == null || computed_hours <= 0) {
    return { error: 'start_time/end_time produced 0 hours — check the values' };
  }
  if (lunch_break === true) {
    computed_hours = Math.max(0, Math.round((computed_hours - 0.5) * 100) / 100);
  }

  const supervisor_id   = safeInt(body.supervisor_id);
  const supervisor_name = safeStr(body.supervisor_name, 200);
  if (!supervisor_name) return { error: 'supervisor_name is required' };

  // Travel time is captured as two optional decimal-hour legs: time spent
  // driving to the site, and time spent driving back to the shop. Either
  // leg may be omitted (worker drove home from the site, day started at the
  // shop with no return trip yet, etc.). travel_hours is the sum and is
  // computed server-side so the client can't disagree with itself. Travel
  // hours are NOT lunch-deducted — the 30-minute break only applies to the
  // on-site work span.
  const travel_to_site_hours = safeHours(body.travel_to_site_hours);
  const travel_to_shop_hours = safeHours(body.travel_to_shop_hours);
  const travel_hours = (travel_to_site_hours == null && travel_to_shop_hours == null)
    ? null
    : Math.round(((travel_to_site_hours || 0) + (travel_to_shop_hours || 0)) * 100) / 100;

  // Truck Unit + per-haul Description. Captured for exactly the entries whose
  // approval injects a Truck Tracking row — trucking, and dust customer hauls —
  // because that is where the two columns land. Gated on the same predicate the
  // injection uses rather than a division test of its own, so a dust job can
  // never collect a unit the approval would then discard, or vice versa. Forced
  // to null everywhere else so a stray value can't leak across divisions.
  const isTruckRow = needsTruckTrackingRow({ entry_type: 'daily', division, job_id });
  // A haul on a division that posts a cost row names its truck in this same
  // column — it is the same fact, and the two are disjoint by construction
  // (needsTruckTrackingRow covers only trucking and dust customers, neither of
  // which auto-injects a cost row). Without this the unit the driver picked
  // would be nulled on the way in and the approver would be back to typing it.
  //
  // The DESCRIPTION stays trucking-only: it belongs to the Truck Tracking row,
  // and a cost row has nowhere to show it.
  const haulType   = safeHaulType(body.haul_type);
  const isHaulUnit = !!haulType && AUTO_INJECT_DIVISIONS.includes(division);
  const truck_unit        = (isTruckRow || isHaulUnit) ? safeStr(body.truck_unit, 100) : null;
  const truck_description = isTruckRow ? safeStr(body.truck_description, 2000) : null;

  // EES-only extras, captured only for a dust entry on one of the two standing
  // EES jobs. Forced to null everywhere else so a stray value can't leak across
  // divisions (same rule the trucking extras follow).
  const isEes = division === 'dust' && isEesJob(job_id);
  const ees_unit       = isEes ? safeStr(body.ees_unit, 100)       : null;
  const ees_customer   = isEes ? safeStr(body.ees_customer, 500)   : null;
  const ees_location   = isEes ? safeStr(body.ees_location, 500)   : null;
  const ees_name       = isEes ? safeStr(body.ees_name, 500)       : null;
  const ees_job_number = isEes ? safeStr(body.ees_job_number, 100) : null;
  const ees_billing    = isEes ? (safeStr(body.ees_billing, 50) || 'Non-Billable') : null;

  return {
    data: {
      entry_type,
      work_date,
      division,
      job_id,
      job_label,
      start_time,
      end_time,
      computed_hours,
      travel_to_site_hours,
      travel_to_shop_hours,
      travel_hours,
      lunch_break,
      operated_equipment: safeBool(body.operated_equipment),
      haul_type:          haulType,
      supervisor_id,
      supervisor_name,
      notes:              safeStr(body.notes, 2000),
      time_off_type:      null,
      truck_unit,
      truck_description,
      ees_unit,
      ees_customer,
      ees_location,
      ees_name,
      ees_job_number,
      ees_billing,
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const payload = requireAuth(req, res);
  if (!payload) return;

  const { companyCode, userId, username } = payload;
  const canSubmit  = hasDivisionAccess(payload, 'timesheet');
  const canAdmin   = hasDivisionAccess(payload, 'payroll') || payload.isPlatformAdmin;

  if (!canSubmit && !canAdmin) {
    return res.status(403).json({ error: 'You do not have access to Timesheet or Payroll' });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    // ── GET (list) ─────────────────────────────────────────────────────────
    // Guarded on `!action` so the action-specific GETs further down (?action=
    // split) are reachable — this branch would otherwise swallow them and hand
    // back an entry list the caller never asked for.
    if (req.method === 'GET' && !req.query.action) {
      const q = req.query || {};
      // Status filter accepts a single value, the combined sentinel
      // "submitted_approved" (payroll's default view), or '' for all.
      // Unrolled into two discrete slots so the SQL can use plain equality
      // instead of ANY(array) — some neon-serverless code paths mis-bind
      // a JS array parameter for ANY(), making the query hang.
      let s1 = '__none__', s2 = '__none__', matchAll = true;
      if (q.status === 'submitted_approved')                    { s1 = 'submitted'; s2 = 'approved'; matchAll = false; }
      else if (['draft','submitted','approved'].includes(q.status)) { s1 = q.status; matchAll = false; }

      const fromF = safeDate(q.from) || '1900-01-01';
      const toF   = safeDate(q.to)   || '9999-12-31';

      // Whose rows come back. The default is ALWAYS the caller's own — a
      // company-wide read is an explicit opt-in, never something a request
      // falls into by omission. That default used to be inverted for anyone
      // holding payroll access, so a supervisor who also submits their own
      // time saw the whole company's entries under "My Recent Entries" on
      // timesheet.html (which sends no user_id and renders no employee name,
      // so other people's days looked indistinguishable from their own).
      //   ?user_id=N   one named user   (admin only)
      //   ?scope=all   the whole company (admin only — payroll.html's review grid)
      // A non-admin asking for either is quietly scoped to themselves rather
      // than 403'd: there is nothing to reveal, so there is nothing to refuse.
      const askedUser   = safeInt(q.user_id);
      const companyWide = canAdmin && askedUser == null && q.scope === 'all';

      let userF = null;
      if (!companyWide) {
        userF = canAdmin && askedUser != null ? askedUser : safeInt(userId);
        // A token carrying no user id owns no rows, and letting a null filter
        // fall through here would hand back the company — the exact shape of
        // the bug above. Fail closed and make them sign in again.
        if (userF == null) return res.status(401).json({ error: 'Unauthorized — please log in' });
      }

      const divF  = canAdmin && VALID_DIVISIONS.includes(q.division) ? q.division : '';

      let rows;
      if (userF != null) {
        rows = await sql`
          SELECT * FROM timesheet_entries
          WHERE company_code = ${companyCode}
            AND user_id      = ${userF}
            AND (${matchAll}::boolean OR status = ${s1} OR status = ${s2})
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
            AND (${divF} = '' OR division = ${divF})
          ORDER BY work_date DESC, created_at DESC
        `;
      } else {
        rows = await sql`
          SELECT * FROM timesheet_entries
          WHERE company_code = ${companyCode}
            AND (${matchAll}::boolean OR status = ${s1} OR status = ${s2})
            AND work_date >= ${fromF}::date
            AND work_date <= ${toF}::date
            AND (${divF} = '' OR division = ${divF})
          ORDER BY work_date DESC, created_at DESC
        `;
      }

      const entries = await attachPrevailingWage(sql, companyCode, rows.map(dbToEntry));
      return res.json({ entries });
    }

    // ── POST (create draft) — field-user only ─────────────────────────────
    if (req.method === 'POST' && !req.query.action) {
      if (!canSubmit) {
        return res.status(403).json({ error: 'Timesheet access is required to create entries' });
      }

      const { data, error } = normalizeEntryBody(req.body || {});
      if (error) return res.status(400).json({ error });

      // Absent split keys on a create mean "not a split". Time off is never
      // split — there is no job to split it across.
      const split = (data.entry_type === 'time_off')
        ? { split_group_id: null, split_index: null, split_count: null }
        : (normalizeSplitTag(req.body) || { split_group_id: null, split_index: null, split_count: null });

      const inserted = await sql`
        INSERT INTO timesheet_entries (
          company_code, user_id, username, entry_type, work_date, status,
          division, job_id, job_label,
          start_time, end_time, computed_hours,
          travel_to_site_hours, travel_to_shop_hours, travel_hours,
          lunch_break, operated_equipment, haul_type,
          supervisor_id, supervisor_name,
          notes, time_off_type,
          truck_unit, truck_description,
          ees_unit, ees_customer, ees_location, ees_name, ees_job_number, ees_billing,
          split_group_id, split_index, split_count
        ) VALUES (
          ${companyCode}, ${userId}, ${username}, ${data.entry_type}, ${data.work_date}, 'draft',
          ${data.division}, ${data.job_id}, ${data.job_label},
          ${data.start_time}, ${data.end_time}, ${data.computed_hours},
          ${data.travel_to_site_hours}, ${data.travel_to_shop_hours}, ${data.travel_hours},
          ${data.lunch_break}, ${data.operated_equipment}, ${data.haul_type},
          ${data.supervisor_id}, ${data.supervisor_name},
          ${data.notes}, ${data.time_off_type},
          ${data.truck_unit}, ${data.truck_description},
          ${data.ees_unit}, ${data.ees_customer}, ${data.ees_location},
          ${data.ees_name}, ${data.ees_job_number}, ${data.ees_billing},
          ${split.split_group_id}, ${split.split_index}, ${split.split_count}
        )
        RETURNING *
      `;
      const row = inserted[0];
      await writeAudit(sql, companyCode, payload, row.id, 'INSERT', null, dbToEntry(row));
      return res.json(await entryJson(sql, companyCode, row));
    }

    // ── POST ?action=submit — draft → submitted (field-user, own row) ─────
    if (req.method === 'POST' && req.query.action === 'submit') {
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      if (existing.user_id !== userId) {
        return res.status(403).json({ error: 'You can only submit your own entries' });
      }
      if (existing.status !== 'draft') {
        return res.status(409).json({ error: `Cannot submit an entry that is already ${existing.status}` });
      }
      if (!canSubmit) {
        return res.status(403).json({ error: 'Timesheet access is required' });
      }

      // Submit is the gate into payroll, so it is where a double-submit has to
      // stop. A retry that lost track of its draft posts a second row instead
      // of reusing the first, and once both are submitted nothing on the card
      // tells them apart — same day, same job, same clock, twice. There is no
      // reading of that other than one day of work counted twice, so refuse it
      // here and point at the row that already covers it.
      //
      // Matched entirely in SQL against the row being submitted (no values
      // round-tripped through JS) so a DATE never crosses a timezone on its way
      // out and back. A split shift is not caught by this — different clock —
      // and neither are two jobs on one day, which is the point.
      const [dupe] = await sql`
        SELECT b.id, b.status FROM timesheet_entries a
        JOIN timesheet_entries b
          ON  b.company_code = a.company_code
          AND b.user_id      = a.user_id
          AND b.entry_type   = a.entry_type
          AND b.work_date    = a.work_date
          AND b.id          <> a.id
          AND (b.status = 'submitted' OR b.status = 'approved')
          AND (
                (a.entry_type = 'daily'
                  AND b.division   IS NOT DISTINCT FROM a.division
                  AND b.job_id     IS NOT DISTINCT FROM a.job_id
                  AND b.start_time IS NOT DISTINCT FROM a.start_time
                  AND b.end_time   IS NOT DISTINCT FROM a.end_time)
             OR (a.entry_type = 'time_off'
                  AND b.time_off_type IS NOT DISTINCT FROM a.time_off_type)
          )
        WHERE a.id = ${id} AND a.company_code = ${companyCode}
        LIMIT 1
      `;
      if (dupe) {
        return res.status(409).json({
          error: existing.entry_type === 'time_off'
            ? `You already have a ${dupe.status} time-off entry for this day. Delete this draft instead of submitting it again.`
            : `You already have a ${dupe.status} entry for this day, job and times. Delete this draft instead of submitting it again.`,
          duplicate_of: String(dupe.id),
        });
      }

      const [updated] = await sql`
        UPDATE timesheet_entries
        SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      await writeAudit(sql, companyCode, payload, id, 'SUBMIT', null, dbToEntry(updated));
      return res.json(await entryJson(sql, companyCode, updated));
    }

    // ── POST ?action=approve — submitted → approved (payroll admin) ───────
    // For turf/paving daily entries, the body MUST include a `split` array
    // that breaks the entry's hours into one or more daily_tracking rows.
    // The split is validated (sum(labor_hours) must equal work+travel hours)
    // before any DB write happens; once validated the entry transitions to
    // 'approved' AND the daily_tracking rows are inserted in the same code
    // path. For quarry daily entries the body MUST include a `quarry` object;
    // one row is appended to the fct_quarry_daily/crushing blob instead. If the
    // injection fails the approval is rolled back manually (status flipped back
    // to 'submitted') so payroll sees the pending row again rather than an
    // approved-but-uninjected entry.
    //
    // Trucking daily entries — and dust customer hauls, which are the same
    // work under a different division (see needsTruckTrackingRow) — inject one
    // Truck Tracking row instead. Dust entries on a standing EES activity
    // inject an "EES Other" row. Everything else flips status only.
    if (req.method === 'POST' && req.query.action === 'approve') {
      if (!canAdmin) {
        return res.status(403).json({ error: 'Payroll admin access is required' });
      }
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      if (existing.status !== 'submitted') {
        return res.status(409).json({ error: `Cannot approve an entry that is ${existing.status}` });
      }

      // Set when the approver's answer actually changes the stored one, so the
      // rollback below can put it back and the audit record can say what moved.
      let priorHaulType   = null;
      let haulTypeChanged = false;

      const needsSplit =
        existing.entry_type === 'daily' &&
        AUTO_INJECT_DIVISIONS.includes(existing.division);
      const needsQuarry =
        existing.entry_type === 'daily' &&
        existing.division === 'quarry';
      // Trucking (and dust customer work) injects an autofilled Truck Tracking
      // row; payroll supplies the haul fee + division column in the body (both
      // optional).
      const needsTrucking = needsTruckTrackingRow(existing);
      // Dust on a standing EES activity injects an autofilled "EES Other" row.
      // Nothing is entered on the payroll side — every value comes from the
      // timesheet entry itself. (Dust customer work routes to Truck Tracking
      // above; the two are disjoint, so this stays an if/else.)
      const needsEesOther =
        existing.entry_type === 'daily' &&
        existing.division === 'dust' &&
        isEesJob(existing.job_id);

      let splitRows = null;
      if (needsSplit) {
        if (!existing.job_id) {
          return res.status(400).json({ error: 'Cannot inject: entry has no job_id (project)' });
        }
        const { rows, error } = validateSplit((req.body && req.body.split) || [], existing);
        if (error) return res.status(400).json({ error });
        splitRows = rows;

        // The approver's answer to the hauling question, when they gave one.
        //
        // The driver answers on the timesheet, but only a driver the office has
        // flagged is even asked — and a day already submitted cannot be
        // answered retrospectively by anyone but payroll. Without this the
        // classification could not be applied to a single entry already sitting
        // in the queue, and a driver who forgot could only be fixed by sending
        // the day back.
        //
        // Absent means keep whatever the entry carries, exactly as the PUT does:
        // approving an ordinary day must never clear a driver's own answer.
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'haul_type')) {
          const nextHaul = safeHaulType(req.body.haul_type);
          if (nextHaul !== (existing.haul_type || null)) {
            priorHaulType = existing.haul_type || null;
            haulTypeChanged = true;
            await sql`
              UPDATE timesheet_entries SET haul_type = ${nextHaul}, updated_at = NOW()
              WHERE id = ${id} AND company_code = ${companyCode}
            `;
          }
          // Keeps this in-memory copy honest for anything below that reads it.
          // It is NOT what the split is priced from — insertSplitRows is handed
          // `updated`, the RETURNING * row from the status flip, which is read
          // back after the write above and already carries the new answer.
          existing.haul_type = nextHaul;
        }
      }

      let quarryInject = null;
      if (needsQuarry) {
        const { activity } = parseQuarryJob(existing.job_id);
        if (!activity) {
          return res.status(400).json({
            error: 'This quarry entry is missing a Daily/Crushing activity on its job. Edit the entry and re-pick the job, then approve.',
          });
        }
        const { fields, error } = validateQuarryInjection(activity, req.body && req.body.quarry);
        if (error) return res.status(400).json({ error });
        quarryInject = { activity, fields };
      }

      let truckingInject = null;
      if (needsTrucking) {
        const { fields, error } = validateTruckingInjection(req.body && req.body.trucking);
        if (error) return res.status(400).json({ error });
        truckingInject = fields;
      }

      // A dust customer haul writes a SECOND row: the Dust Control Tracking row
      // the dust office bills from. Same work, same approval, different tab —
      // the trucking row records who drove where, this one carries the customer
      // detail and the vehicle/UB money. Payroll supplies the company man, the
      // location and the gallons here; the rest follows from the customer.
      // A split day sends one leg per customer/pad — see validateDustInjection.
      const needsDust = needsDustTrackingRow(existing);
      let dustInject = null;
      if (needsDust) {
        const { rows, error } = validateDustInjection(req.body && req.body.dust);
        if (error) return res.status(400).json({ error });
        dustInject = rows;
      }

      // The unit payroll typed in the approve modal lands on the ENTRY, not just
      // the injected row: the entry is what every later re-injection reads, so a
      // unit that lived only on the row would vanish the next time the row was
      // rewritten (un-approve → re-approve, or Edit Row). Absent — which is what
      // bulk approve sends, and what an older client sends — leaves each entry's
      // own unit alone; a blank string clears it.
      //
      // Written AFTER the injection succeeds, not folded into the status flip:
      // the flip below is rolled back when injection fails, and a truck_unit
      // written alongside it would not be, leaving the entry disagreeing with a
      // Truck Tracking row that was never written. insertTruckingRow takes the
      // unit from `fields`, not from the entry, so nothing downstream needs this
      // write to have happened first.
      const unitGiven = !!(truckingInject && truckingInject.unit != null);
      const unitValue = unitGiven ? (truckingInject.unit || null) : null;

      const [updated] = await sql`
        UPDATE timesheet_entries
        SET status              = 'approved',
            approved_at         = NOW(),
            approved_by_user_id = ${userId},
            approved_by_name    = ${username},
            updated_at          = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;

      if (splitRows || quarryInject || needsTrucking || needsDust || needsEesOther) {
        try {
          if (splitRows) {
            await insertSplitRows(
              sql, splitRows, updated, updated.division, companyCode, updated.username,
            );
          } else if (quarryInject) {
            await insertQuarryRow(
              sql, companyCode, updated, quarryInject.activity, quarryInject.fields,
            );
          } else if (needsTrucking || needsDust) {
            // Not an if/else pair: a dust customer haul is BOTH, and the two
            // rows are the same day's work seen from the two offices that need
            // it. A trucking entry only ever takes the first branch.
            // `dustLegs` is the whole day's hauls, destinations and all. The
            // Truck Tracking write reads it to skip the legs the dust office
            // bills off its own tracking grid — it takes the day and writes
            // only the hauls this tab is the record of, exactly as the two
            // dust writers below do.
            if (needsTrucking) await insertTruckingRows(sql, companyCode, updated, truckingInject || {}, { clearSuppression: true, dustLegs: dustInject });
            // Both dust halves take the WHOLE day's legs and each writes only
            // the ones its own tab claims, so a day split across UB and
            // material posts one row per haul in whichever grid bills it. Each
            // also prunes the legs it no longer owns, which is what makes
            // flipping a haul's destination on a re-edit a move rather than a
            // duplicate.
            if (needsDust) {
              await insertDustTrackingRows(sql, companyCode, updated, dustInject || [{}], { clearSuppression: true });
              await insertObRows(sql, companyCode, updated, dustInject || [{}], { clearSuppression: true });
              // The third grid: hauls the office tracks and bills to nobody.
              await insertEesOtherRows(sql, companyCode, updated, dustInject || [{}], { clearSuppression: true });
            }
          } else {
            await insertEesOtherRow(sql, companyCode, updated);
          }
        } catch (injErr) {
          // Rollback the approval so payroll sees the row as pending again
          // and can retry. Without this we'd have an approved entry with
          // zero injected rows — invisible to the cost tracking tab.
          console.error('[timesheet-entries] injection failed, rolling back approval:', injErr.message);
          // insertSplitRows inserts each daily_tracking row as its own
          // autocommitted statement (neon-serverless has no multi-statement
          // transaction), so a mid-loop failure can leave earlier rows behind.
          // Scrub every injected row for this entry so a partial split can't
          // linger as phantom cost in the division tab (invisible to un-approve,
          // undeletable from the tab) and a retried approve can't double-inject.
          if (splitRows) {
            try { await removeSplitRows(sql, companyCode, id); }
            catch (cleanupErr) { console.error('[timesheet-entries] split rollback cleanup failed:', cleanupErr.message); }
          }
          // Quarry/trucking write the blob before mirroring; if the mirror sync
          // threw, scrub any half-written blob row so it can't linger as a
          // phantom row in the division's tracking tab while the entry is pending.
          if (quarryInject) {
            try { await removeQuarryRows(sql, companyCode, updated); }
            catch (cleanupErr) { console.error('[timesheet-entries] quarry rollback cleanup failed:', cleanupErr.message); }
          }
          if (needsTrucking) {
            try { await removeTruckingRows(sql, companyCode, updated); }
            catch (cleanupErr) { console.error('[timesheet-entries] trucking rollback cleanup failed:', cleanupErr.message); }
          }
          // The dust row is written after the trucking one, so a failure can
          // leave the first of the pair behind — and the sweep above only takes
          // back the trucking half. Scrub this side too, or an approval that
          // rolled back leaves the dust office billing for a pending entry.
          if (needsDust) {
            try { await removeDustTrackingRows(sql, companyCode, updated); }
            catch (cleanupErr) { console.error('[timesheet-entries] dust rollback cleanup failed:', cleanupErr.message); }
            // The Other Billing half is written last, so it is the likeliest to
            // have thrown — but it can also have landed before the tracking
            // half did not. Either way a rolled-back approval must leave the
            // dust office billing nothing, in either grid.
            try { await removeObRows(sql, companyCode, updated); }
            catch (cleanupErr) { console.error('[timesheet-entries] dust OB rollback cleanup failed:', cleanupErr.message); }
            // And the third grid, on the same terms: a haul billed to nobody is
            // still a row in a tab that cannot delete its own.
            try { await removeEesOtherRows(sql, companyCode, updated); }
            catch (cleanupErr) { console.error('[timesheet-entries] dust EES rollback cleanup failed:', cleanupErr.message); }
          }
          if (needsEesOther) {
            try { await removeEesOtherRows(sql, companyCode, updated); }
            catch (cleanupErr) { console.error('[timesheet-entries] EES Other rollback cleanup failed:', cleanupErr.message); }
          }
          // The hauling answer was written BEFORE the injection, so it has to
          // come back too. It is not cosmetic: left behind, the entry reads as
          // pending while its hours have already moved out of prevailing in the
          // Hours Report and the Excel export — for an approval that never
          // happened.
          if (haulTypeChanged) {
            try {
              await sql`
                UPDATE timesheet_entries SET haul_type = ${priorHaulType}, updated_at = NOW()
                WHERE id = ${id} AND company_code = ${companyCode}
              `;
            } catch (cleanupErr) {
              console.error('[timesheet-entries] haul_type rollback failed:', cleanupErr.message);
            }
          }
          await sql`
            UPDATE timesheet_entries
            SET status              = 'submitted',
                approved_at         = NULL,
                approved_by_user_id = NULL,
                approved_by_name    = NULL,
                updated_at          = NOW()
            WHERE id = ${id} AND company_code = ${companyCode}
          `;
          return res.status(500).json({
            error: 'Approval rolled back: failed to write cost tracking rows',
            detail: injErr.message,
          });
        }
      }

      // Injection landed (or there was none to do) — now the entry can safely
      // record the unit payroll typed. See the note by unitGiven above.
      let approvedRow = updated;
      if (unitGiven) {
        const [withUnit] = await sql`
          UPDATE timesheet_entries
          SET truck_unit = ${unitValue}, updated_at = NOW()
          WHERE id = ${id} AND company_code = ${companyCode}
          RETURNING *
        `;
        if (withUnit) approvedRow = withUnit;
      }

      // Reclassifying a day's haul answer moves the driver's hours between
      // prevailing and standard — real money on his cheque — so it goes on the
      // record with who did it and what it was before. The same handler already
      // logs the truck unit and the dust row counts; this is the one field that
      // changes what somebody is paid.
      const haulAudit = haulTypeChanged
        ? { haul_type_from: priorHaulType, haul_type_to: (existing.haul_type || null) }
        : null;
      await writeAudit(
        sql, companyCode, payload, id, 'APPROVE',
        splitRows ? Object.assign({ split_row_count: splitRows.length }, haulAudit)
          : quarryInject ? { quarry_activity: quarryInject.activity }
          : (needsTrucking || needsDust)
            ? {
                trucking_injected: needsTrucking,
                dust_tracking_injected: needsDust,
                // How many customers/pads the day was split across, so an audit
                // of a two-row haul doesn't read as a double-post. Both tabs get
                // one row per haul, and the two counts are reported separately
                // because only one of them is a split when a trucking entry goes
                // through this path.
                dust_row_count: needsDust
                  ? (dustInject || [{}]).filter(l => legDest(l) === 'dust').length : undefined,
                // Told apart from the tracking count because they are different
                // grids: an audit that folded them together would read a
                // three-haul day as three UB rows when one of them billed
                // material and one billed nobody.
                dust_ob_row_count: needsDust
                  ? (dustInject || [{}]).filter(l => legDest(l) === 'ob').length : undefined,
                dust_ees_row_count: needsDust
                  ? (dustInject || [{}]).filter(l => legDest(l) === 'ees').length : undefined,
                truck_row_count: needsTrucking
                  ? ((truckingInject && truckingInject.rows) || [{}]).length : undefined,
              }
          : needsEesOther ? { ees_other_injected: true } : null,
        dbToEntry(approvedRow),
      );
      return res.json(await entryJson(sql, companyCode, approvedRow));
    }

    // ── POST ?action=resplit — re-author the split on an approved entry ──
    // Payroll's "edit the cost-tracking breakdown" path for an already
    // approved entry. Deletes the prior injected rows for this entry, then
    // inserts the new split. Same validation as approve. Status stays
    // 'approved' — this is purely the breakdown, not the approval state.
    if (req.method === 'POST' && req.query.action === 'resplit') {
      if (!canAdmin) {
        return res.status(403).json({ error: 'Payroll admin access is required' });
      }
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      if (existing.status !== 'approved') {
        return res.status(409).json({ error: 'Resplit is only allowed on approved entries' });
      }

      // Quarry re-edit: rewrite the injected quarry blob row. insertQuarryRow
      // deletes the prior injected row(s) for this entry before appending, so
      // there's no separate delete step here.
      if (existing.entry_type === 'daily' && existing.division === 'quarry') {
        const { activity } = parseQuarryJob(existing.job_id);
        if (!activity) {
          return res.status(400).json({
            error: 'This quarry entry is missing a Daily/Crushing activity on its job.',
          });
        }
        const { fields, error } = validateQuarryInjection(activity, req.body && req.body.quarry);
        if (error) return res.status(400).json({ error });
        try {
          await insertQuarryRow(sql, companyCode, existing, activity, fields);
        } catch (injErr) {
          console.error('[timesheet-entries] quarry resplit failed:', injErr.message);
          return res.status(500).json({
            error: 'Edit failed: could not rewrite the quarry tracking row. Retry.',
            detail: injErr.message,
          });
        }
        await writeAudit(
          sql, companyCode, payload, id, 'ADMIN_EDIT',
          { resplit: true, quarry_activity: activity },
          dbToEntry(existing),
        );
        return res.json(await entryJson(sql, companyCode, existing));
      }

      // Dust EES re-edit: the standing-activity day (Pre Loading / Washing),
      // whose approval posts one row to the division's EES Other tab. Disjoint
      // from both gates below by construction — needsTruckTrackingRow and
      // needsDustTrackingRow each exclude an EES job, because that work is not a
      // customer haul — so the order of these branches carries no meaning.
      //
      // Everything the tab shows is timesheet-fed except the office's own rate,
      // and these six columns are the part payroll can correct. So the edit
      // writes them back onto the entry FIRST and re-injects from it: the row is
      // rebuilt from the entry on every later re-injection, and writing only the
      // row would be reverted by the next un-approve/re-approve.
      // insertEesOtherRow rewrites this entry's row in place and carries the
      // rate across (EES_OTHER_TAB_FIELDS), so correcting a job number cannot
      // cost the dust office the figure it bills at.
      // The INJECTION gate, not couldHaveEesOtherRows: that one is deliberately
      // wider — any dust entry — because teardown must also find the per-leg
      // rows a customer haul posts. Editing one of those is the haul modal's
      // job, below. This branch owns only the standing-activity row, so it asks
      // the same question insertEesOtherRow's writer does.
      if (existing.entry_type === 'daily'
          && existing.division === 'dust' && isEesJob(existing.job_id)) {
        const { fields, error } = validateEesInjection(req.body && req.body.ees);
        if (error) return res.status(400).json({ error });
        const [reEes] = await sql`
          UPDATE timesheet_entries SET
            ees_unit       = ${fields.unit},
            ees_customer   = ${fields.customer},
            ees_location   = ${fields.location},
            ees_name       = ${fields.name},
            ees_job_number = ${fields.job_number},
            ees_billing    = ${fields.billing},
            updated_at     = NOW()
          WHERE id = ${id} AND company_code = ${companyCode}
          RETURNING *
        `;
        const eesEntry = reEes || existing;
        try {
          await insertEesOtherRow(sql, companyCode, eesEntry);
        } catch (injErr) {
          console.error('[timesheet-entries] EES resplit failed:', injErr.message);
          // The columns landed and the row did not, so the two disagree until a
          // retry — say which half held, or payroll re-types an edit that is
          // already on the entry and wonders why the tab never moved.
          return res.status(500).json({
            error: 'Edit failed: the entry was updated but the EES Other row could not be rewritten. Retry.',
            detail: injErr.message,
          });
        }
        await writeAudit(
          sql, companyCode, payload, id, 'ADMIN_EDIT',
          { resplit: true, ees_other: true, ees_billing: fields.billing },
          dbToEntry(existing),
        );
        return res.json(await entryJson(sql, companyCode, eesEntry));
      }

      // Trucking re-edit: rewrite the injected Truck Tracking row with the new
      // haul fee / division / unit. insertTruckingRow removes the prior injected
      // row for this entry before appending, so there's no separate delete step.
      //
      // A dust customer haul answers BOTH gates and rewrites both of its rows in
      // one edit — the modal shows the two tabs' fields together, so saving it
      // has to land in both places or they drift apart.
      const reTruck = needsTruckTrackingRow(existing);
      const reDust  = needsDustTrackingRow(existing);
      if (reTruck || reDust) {
        const { fields, error } = validateTruckingInjection(req.body && req.body.trucking);
        if (error) return res.status(400).json({ error });
        // Validated before either write, so a bad gallons figure is a 400 that
        // changed nothing rather than a half-applied edit. On a dust haul this
        // is the whole day's breakdown: legs the edit dropped are taken back by
        // insertDustTrackingRows, so re-editing three customers down to two
        // leaves no third invoice line behind.
        const dustParsed = validateDustInjection(req.body && req.body.dust);
        if (dustParsed.error) return res.status(400).json({ error: dustParsed.error });

        // A save that names ONE haul rewrites the day as one haul, and every
        // other haul's row — and its Intercompany billing entry — goes with it.
        // That is right when the approver removed those hauls in the modal, and
        // wrong when the client simply predates splitting: a payroll page cached
        // from before it sends no `rows` key at all, which parses as a single
        // derive-everything leg and would silently un-bill the rest of the day.
        //
        // The read side is deliberately old-client-safe (?action=split still
        // answers with `row` beside `rows`), so the write side refuses rather
        // than letting a stale tab destroy what it cannot see. Reloading payroll
        // is the whole fix, and the message says so.
        const askedTruck = !!(req.body && req.body.trucking && Array.isArray(req.body.trucking.rows));
        const askedDust  = !!(req.body && req.body.dust && Array.isArray(req.body.dust.rows));
        // How many hauls this day was actually approved as. On the dust side
        // that is the HIGHEST leg posted across ALL THREE grids, not the count
        // in any one: a day whose middle haul billed material has one tracking
        // row at leg 1, one at leg 3 and one Other Billing row at leg 2, and
        // counting a single grid would call a three-haul day a two-haul one —
        // letting exactly the stale single-leg save this guard exists to refuse
        // straight through. Every grid a haul can reach has to be asked, or the
        // day is undercounted the moment one is left out.
        const dustLegs = reDust
          ? await Promise.all([
              dustSplitForEntry(sql, companyCode, existing),
              obSplitForEntry(sql, companyCode, existing),
              eesSplitForEntry(sql, companyCode, existing),
            ])
          : null;
        const dustPosted = dustLegs
          ? dustLegs.flatMap(x => x.rows).reduce((n, r) => Math.max(n, Number(r.leg) || 0), 0)
          : 0;
        // The HIGHEST leg posted here, not the count — same reason the dust
        // side takes a maximum. A dust day posts a Truck Tracking row only for
        // the hauls billed off Other Billing, so a three-haul day can hold one
        // row at leg 3 and counting the rows would call it a one-haul day,
        // letting exactly the stale single-leg save this guard exists to refuse
        // straight through.
        const truckPosted = reTruck
          ? (await truckingSplitForEntry(sql, companyCode, existing)).rows
              .reduce((n, r) => Math.max(n, Number(r.leg) || 0), 0)
          : 0;
        const posted = Math.max(truckPosted, dustPosted);
        if (posted > 1 && ((reTruck && !askedTruck) || (reDust && !askedDust))) {
          return res.status(409).json({
            error: `This day was approved as ${posted} hauls, and this edit only describes one. `
                 + 'Reload Payroll and open Edit Row again — an out-of-date page cannot edit a split day.',
            posted_haul_count: posted,
          });
        }
        try {
          if (reTruck) {
            // The whole day's hauls, so the write can skip the legs the dust
            // office bills off its tracking grid — and prune the row off a leg
            // this edit just re-pointed from material to UB, which is the one
            // path that ever takes a Truck Tracking row back without the entry
            // itself changing.
            await insertTruckingRows(sql, companyCode, existing, fields, { dustLegs: dustParsed.rows });
          }
        } catch (injErr) {
          console.error('[timesheet-entries] trucking resplit failed:', injErr.message);
          return res.status(500).json({
            error: 'Edit failed: could not rewrite the Truck Tracking row. Retry.',
            detail: injErr.message,
          });
        }
        // The unit goes onto the entry as soon as the row that carries it
        // exists, and BEFORE the dust write — which can fail and return, and
        // used to leave the Truck Tracking row stamped with the new unit while
        // the entry still held the old one. The next re-injection reads the
        // entry, so that gap silently reverted the unit on the following edit.
        let truckEntry = existing;
        if (reTruck && fields.unit != null) {
          const [reUnit] = await sql`
            UPDATE timesheet_entries
            SET truck_unit = ${fields.unit || null}, updated_at = NOW()
            WHERE id = ${id} AND company_code = ${companyCode}
            RETURNING *
          `;
          if (reUnit) truckEntry = reUnit;
        }
        // The dust half of the same edit. Reported separately because the two
        // rows live in different tabs: told only "the edit failed", payroll
        // would not know that the haul fee it just corrected did land.
        try {
          if (reDust) {
            await insertDustTrackingRows(sql, companyCode, existing, dustParsed.rows);
            // Written second so the two calls see the same list of legs and
            // each prunes what it no longer owns: a haul the approver just
            // flipped from UB to material is deleted by the first call and
            // created by this one, which is why a flip is a move rather than a
            // row in both grids.
            await insertObRows(sql, companyCode, existing, dustParsed.rows);
            // Third for the same reason, so a haul flipped onto — or off —
            // "Other Billing - Non Billable" moves rather than duplicating.
            await insertEesOtherRows(sql, companyCode, existing, dustParsed.rows);
          }
        } catch (injErr) {
          console.error('[timesheet-entries] dust resplit failed:', injErr.message);
          return res.status(500).json({
            error: 'Edit failed: the Truck Tracking rows were updated but the dust billing rows could not be rewritten. Retry.',
            detail: injErr.message,
          });
        }
        await writeAudit(
          sql, companyCode, payload, id, 'ADMIN_EDIT',
          {
            resplit: true,
            trucking: reTruck,
            dust_tracking: reDust,
            dust_row_count: reDust
              ? dustParsed.rows.filter(l => legDest(l) === 'dust').length : undefined,
            dust_ob_row_count: reDust
              ? dustParsed.rows.filter(l => legDest(l) === 'ob').length : undefined,
            dust_ees_row_count: reDust
              ? dustParsed.rows.filter(l => legDest(l) === 'ees').length : undefined,
            truck_row_count: reTruck ? ((fields.rows) || [{}]).length : undefined,
            truck_unit: fields.unit != null ? (fields.unit || '') : undefined,
          },
          dbToEntry(existing),
        );
        return res.json(await entryJson(sql, companyCode, truckEntry));
      }

      if (existing.entry_type !== 'daily' || !AUTO_INJECT_DIVISIONS.includes(existing.division)) {
        return res.status(400).json({ error: 'Resplit applies only to daily entries in turf/paving/kiewit/quarry/trucking' });
      }
      if (!existing.job_id) {
        return res.status(400).json({ error: 'Cannot inject: entry has no job_id (project)' });
      }

      const { rows: splitRows, error } = validateSplit((req.body && req.body.split) || [], existing);
      if (error) return res.status(400).json({ error });

      // Same rule as the approve path: an answer supplied here wins, an absent
      // key leaves the entry's own alone. This is the only way to correct a
      // mis-classified haul on a day that is already approved, short of
      // un-approving it — and the rows are about to be re-priced from it below.
      let rsPriorHaul = null, rsHaulChanged = false;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'haul_type')) {
        const nextHaul = safeHaulType(req.body.haul_type);
        if (nextHaul !== (existing.haul_type || null)) {
          rsPriorHaul = existing.haul_type || null;
          rsHaulChanged = true;
          await sql`
            UPDATE timesheet_entries SET haul_type = ${nextHaul}, updated_at = NOW()
            WHERE id = ${id} AND company_code = ${companyCode}
          `;
        }
        // Read by insertSplitRows below — the resplit path passes `existing`,
        // not a re-read row, so this one IS the pricing source.
        existing.haul_type = nextHaul;
      }

      // Delete the prior injected rows for this entry, then insert the new
      // split. We don't wrap this in a transaction (neon-serverless has
      // limited multi-statement transaction support) — the delete is safe
      // to retry because it's keyed on the entry, and the insert is
      // idempotent on row_id.
      await removeSplitRows(sql, companyCode, id);
      try {
        await insertSplitRows(
          sql, splitRows, existing, existing.division, companyCode, existing.username,
        );
      } catch (injErr) {
        console.error('[timesheet-entries] resplit insert failed:', injErr.message);
        return res.status(500).json({
          error: 'Resplit failed: prior rows deleted but new rows could not be written. Retry.',
          detail: injErr.message,
        });
      }

      await writeAudit(
        sql, companyCode, payload, id, 'ADMIN_EDIT',
        Object.assign({ resplit: true, split_row_count: splitRows.length },
          rsHaulChanged
            ? { haul_type_from: rsPriorHaul, haul_type_to: (existing.haul_type || null) }
            : null),
        dbToEntry(existing),
      );
      return res.json(await entryJson(sql, companyCode, existing));
    }

    // ── POST ?action=unapprove — approved → submitted (payroll admin) ────
    // Reverses an approval. Deletes any injected daily_tracking rows so
    // the cost tracking tab reflects reality (entry is no longer approved
    // → its cost rows must go away). Audit log records the action with the
    // count of removed rows.
    if (req.method === 'POST' && req.query.action === 'unapprove') {
      if (!canAdmin) {
        return res.status(403).json({ error: 'Payroll admin access is required' });
      }
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });
      if (existing.status !== 'approved') {
        return res.status(409).json({ error: 'Only approved entries can be un-approved' });
      }

      // Counts as it deletes, so the audit log captures how much cost went away.
      const cnt = await removeSplitRows(sql, companyCode, id);
      // Quarry stores its injected rows in the fct_quarry_* blobs, not
      // daily_tracking — clear those too so the Daily/Crushing tab reflects
      // the un-approval.
      let removedQuarry = 0;
      if (existing.division === 'quarry') {
        removedQuarry = await removeQuarryRows(sql, companyCode, existing);
      }
      // Trucking (and dust customer work) stores its injected rows in the
      // fct_truck_division blob + truck_division_entries table — clear those so
      // the Truck Tracking tab reflects the un-approval.
      let removedTrucking = 0;
      if (needsTruckTrackingRow(existing)) {
        removedTrucking = await removeTruckingRows(sql, companyCode, existing);
      }
      // Dust stores its injected rows in the dust_ees_other_rows blob — clear
      // those so the EES Other tab reflects the un-approval. The dust auto-sync
      // then pulls any Intercompany entry the row had created.
      let removedEesOther = 0;
      if (couldHaveEesOtherRows(existing)) {
        removedEesOther = await removeEesOtherRows(sql, companyCode, existing);
      }
      // A dust customer haul also posted a Dust Control Tracking row — take that
      // back too, or the dust office keeps billing work payroll has withdrawn.
      let removedDust = 0;
      let removedDustOb = 0;
      if (needsDustTrackingRow(existing)) {
        removedDust = await removeDustTrackingRows(sql, companyCode, existing);
        // A haul billed as material posted into Other Billing instead, and the
        // entry alone cannot say which grid it went to — the destination lives
        // on the leg. So both are swept whenever the entry could have posted to
        // either; the one with nothing to find costs a single blob read.
        removedDustOb = await removeObRows(sql, companyCode, existing);
      }
      const removed = cnt + removedQuarry + removedTrucking + removedEesOther
        + removedDust + removedDustOb;
      const [updated] = await sql`
        UPDATE timesheet_entries
        SET status              = 'submitted',
            approved_at         = NULL,
            approved_by_user_id = NULL,
            approved_by_name    = NULL,
            updated_at          = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      await writeAudit(
        sql, companyCode, payload, id, 'ADMIN_EDIT',
        { unapprove: true, removed_split_rows: removed },
        dbToEntry(updated),
      );
      return res.json(await entryJson(sql, companyCode, updated, { removed_split_rows: removed }));
    }

    // ── POST ?action=refresh-rates — re-resolve money on injected rows ──
    // The rate, job class and equipment price are copied onto an injected row
    // at approval time, so a row approved while a rate was missing from the
    // lists — or while the roster lookup could not match the login — keeps its
    // zeros forever. Un-approving and re-approving fixes one entry; this fixes
    // every approved entry in a date range in place.
    //
    // It only ever touches the four fields the approval derives, and never
    // hours, cost codes, equipment names or anything a supervisor can edit in
    // the division tab. A row whose employee still does not resolve is left
    // exactly as it is and reported back, so the answer is "add this person to
    // Manage Lists" rather than a silently zeroed rate.
    if (req.method === 'POST' && req.query.action === 'refresh-rates') {
      if (!canAdmin) {
        return res.status(403).json({ error: 'Payroll admin access is required' });
      }
      const from = safeDate(req.query.from);
      const to   = safeDate(req.query.to);
      // Bounded so one call cannot outrun the serverless timeout. The caller
      // is told when it hit the cap so it can narrow the range.
      const SCAN_LIMIT = 1000;

      const scanRows = (from && to)
        ? await sql`
            SELECT dt.row_id, dt.division, dt.employee, dt.job_class, dt.rate,
                   dt.equipment, dt.equip_unit_cost,
                   dt.field_type, dt.cost_code, dt.sub_code,
                   te.username, te.job_id, te.haul_type
            FROM daily_tracking dt
            JOIN timesheet_entries te
              ON te.id = dt.timesheet_entry_id AND te.company_code = dt.company_code
            WHERE dt.company_code = ${companyCode}
              AND dt.timesheet_entry_id IS NOT NULL
              AND te.status = 'approved'
              AND te.work_date >= ${from} AND te.work_date <= ${to}
            ORDER BY dt.row_id
            LIMIT ${SCAN_LIMIT}
          `
        : await sql`
            SELECT dt.row_id, dt.division, dt.employee, dt.job_class, dt.rate,
                   dt.equipment, dt.equip_unit_cost,
                   dt.field_type, dt.cost_code, dt.sub_code,
                   te.username, te.job_id, te.haul_type
            FROM daily_tracking dt
            JOIN timesheet_entries te
              ON te.id = dt.timesheet_entry_id AND te.company_code = dt.company_code
            WHERE dt.company_code = ${companyCode}
              AND dt.timesheet_entry_id IS NOT NULL
              AND te.status = 'approved'
            ORDER BY dt.row_id
            LIMIT ${SCAN_LIMIT}
          `;

      // One resolver and one prevailing-wage read per division, not per row.
      const byDivision = new Map();
      for (const r of scanRows) {
        const d = r.division || 'turf';
        if (!byDivision.has(d)) byDivision.set(d, []);
        byDivision.get(d).push(r);
      }

      let updated = 0;
      // Keyed on login AND division: the same person can submit into more than
      // one, and each division has its own list. Collapsing them onto one entry
      // sent you to fix a list that was only part of the problem.
      const unresolved = new Map();   // "login\0division" → { username, division, rows }
      // Which roster each division actually searched. "No match" means one of
      // two very different things — the person is missing from that division's
      // list, or they are in it under a name the login does not resolve to —
      // and the answer is useless without seeing the names.
      const rosters = {};
      for (const [division, rows] of byDivision) {
        const resolver = await buildCostResolver(
          sql, companyCode, division, rows.map(r => r.equipment),
        );
        rosters[division] = resolver.rosterNames();
        const pwFlags = await prevailingWageByJob(
          sql, companyCode, division, rows.map(r => r.job_id),
        );

        for (const r of rows) {
          const emp = resolver.employeeFor(r.username);
          if (!emp) {
            const key = `${r.username}\u0000${division}`;
            const seen = unresolved.get(key) || { username: r.username, division, rows: 0 };
            seen.rows += 1;
            unresolved.set(key, seen);
            continue;
          }
          // Same rule the approval applies: travel is paid at the standard
          // rate whatever the job is, so only work rows can take the
          // prevailing rate. An already-posted row carries its Travel marker
          // as field_type; the codes are read too, so a "… - Travel" sub code
          // counts even where the box was never ticked. This is also what
          // re-rates travel posted before the rule existed — run it over the
          // range and those rows correct themselves in place.
          const travelRow = String(r.field_type || '') === 'Travel'
            || isTravelSplitRow({ cost_code: r.cost_code, sub_code: r.sub_code });
          // Same treatment for a haul, and for the same reason it self-heals:
          // read the answer from the ENTRY rather than only from the stamp, so
          // a row posted before the driver was flagged — or before the driver
          // corrected his answer — re-prices and re-stamps itself when the
          // range is run. Travel still outranks it, exactly as on the approval
          // path: the commute is not bought by the truck.
          // The ENTRY decides, not the stamp already on the row: the scan joins
          // timesheet_entries, so haul_type is always available and always
          // current. Reading the stamp as a second source would let the two
          // disagree inside one write — a row whose driver has since corrected
          // his answer would lose the stamp but keep the $0, and only come right
          // on a second run.
          const haulType  = travelRow ? null : haulTypeOf(r);
          // A driver's labour is inside the truck's rate; pricing it again
          // bills the job twice for one man. Hours are left alone.
          const rate      = haulType
            ? 0
            : resolver.rateFor(emp, !travelRow && !!pwFlags.get(String(r.job_id)));
          // Re-stamp so the cost tab says why the row is priced at zero — and
          // un-stamp a row that is no longer a haul, so the marker never
          // outlives the answer that put it there.
          // A row that has BECOME travel drops any haul stamp it still carries.
          // sub_code is one of the fields a supervisor may re-code on an
          // injected row, so a haul row can be moved onto a travel code — and
          // the stamp is not cosmetic: rowHaulHours on the division pages
          // subtracts stamped hours from the crew-size and units-per-man-hour
          // denominators. Left behind, it keeps a driver out of a figure he now
          // belongs in, while the rate beside it has already been corrected
          // back to his standard one.
          //
          // Safe to overwrite: an injected row's field_type is only ever
          // 'Travel', a haul stamp, or NULL — there is no third value to lose.
          const fieldType = travelRow
            ? (HAUL_FIELD_TYPE_RE.test(String(r.field_type || '')) ? 'Travel' : (r.field_type || 'Travel'))
            : (haulType ? HAUL_FIELD_TYPE[haulType]
              : (HAUL_FIELD_TYPE_RE.test(String(r.field_type || '')) ? null : (r.field_type || null)));
          const eqCost    = resolver.equipCostFor(r.equipment);
          // job_class is one of the fields a supervisor may re-categorize in
          // the division tab, so only fill it when it is still empty — never
          // overwrite a deliberate change. rate, employee and the equipment
          // price are locked over there, so they are ours to correct.
          const jobClass  = String(r.job_class || '').trim() ? r.job_class : (emp.job_class || null);
          // Never trade a price we have for one we could not resolve.
          const nextEqCost = eqCost > 0 ? eqCost : (Number(r.equip_unit_cost) || 0);

          const same = Number(r.rate) === rate
            && String(r.employee || '') === String(emp.name || '')
            && String(r.job_class || '') === String(jobClass || '')
            && String(r.field_type || '') === String(fieldType || '')
            && Number(r.equip_unit_cost) === nextEqCost;
          if (same) continue;

          await sql`
            UPDATE daily_tracking
            SET employee        = ${emp.name},
                job_class       = ${jobClass},
                rate            = ${rate},
                field_type      = ${fieldType},
                equip_unit_cost = ${nextEqCost},
                updated_at      = NOW()
            WHERE row_id = ${r.row_id} AND company_code = ${companyCode}
              AND timesheet_entry_id IS NOT NULL
          `;
          updated++;
        }
      }

      await writeAudit(
        sql, companyCode, payload, 0, 'ADMIN_EDIT',
        { refresh_rates: true, scanned: scanRows.length, updated }, null,
      );
      return res.json({
        ok: true,
        scanned: scanRows.length,
        updated,
        hitLimit: scanRows.length === SCAN_LIMIT,
        unresolved: [...unresolved.values()].sort((a, b) => b.rows - a.rows),
        // Only the lists that something actually failed against — a clean run
        // has no reason to ship every division's roster back.
        rosters: Object.fromEntries(
          Object.entries(rosters).filter(([d]) =>
            [...unresolved.values()].some(u => u.division === d)),
        ),
      });
    }

    // ── GET ?action=split&id=N — fetch existing injected rows ────────────
    // Used by the payroll modal when re-editing the split for an already
    // approved entry.
    if (req.method === 'GET' && req.query.action === 'split') {
      // Payroll-only, like every other action on this endpoint. This branch
      // takes an entry id and scopes by company but NOT by user, so without the
      // gate any level-1 timesheet account could read back another employee's
      // injected cost rows — job cost codes and rates, and for a haul the Truck
      // Tracking row with the customer's haul fee on it. The list branch above
      // is careful to scope non-admins to their own rows; this must match.
      // Every caller is a payroll admin screen (payroll.html's three modals).
      if (!canAdmin) {
        return res.status(403).json({ error: 'Payroll admin access is required' });
      }
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      // Quarry entries: return the injected quarry blob row (activity + its
      // value fields) so the payroll modal can pre-fill on re-edit. `id` MUST
      // be selected — quarrySplitForEntry keys the blob lookup on entry.id.
      const [entryRow] = await sql`
        SELECT id, entry_type, division, job_id, job_label FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (entryRow && entryRow.division === 'quarry') {
        const { activity, row } = await quarrySplitForEntry(sql, companyCode, entryRow);
        return res.json({ quarry: { activity, row } });
      }
      // The same gate the injection uses, not `division === 'trucking'`: a dust
      // customer haul writes a Truck Tracking row too, and pre-filling only half
      // of them meant re-editing a dust haul opened on blank fields and saved
      // the haul fee (now also the unit) back as empty.
      if (needsTruckTrackingRow(entryRow) || needsDustTrackingRow(entryRow)) {
        // Every leg, so a split day re-opens with each haul's own fee rather
        // than the first one's applied to all of them.
        const { rows: truckRows, row } = await truckingSplitForEntry(sql, companyCode, entryRow);
        const answer = { trucking: { row, rows: truckRows } };
        // A dust haul's modal shows both tabs' fields, so it needs both rows
        // back — plus the customer's men, locations, vehicles and defaults, so a
        // box the approver left blank first time round can still be filled from
        // a dropdown rather than typed from memory.
        if (needsDustTrackingRow(entryRow)) {
          // `companies` carries every customer's men, pads and default rates, so
          // a leg pointed at another customer fills itself in the same way the
          // first one did instead of waiting on a second round trip.
          const [dust, ob, ees, options, companies] = await Promise.all([
            dustSplitForEntry(sql, companyCode, entryRow),
            obSplitForEntry(sql, companyCode, entryRow),
            eesSplitForEntry(sql, companyCode, entryRow),
            dustOptionsForEntry(sql, companyCode, entryRow, '', { withLists: true }),
            dustCompanyDirectory(sql, companyCode),
          ]);
          // `ob_rows` and `ees_rows` beside `rows`, each element carrying the
          // leg of the day it describes, so the modal can put a day split across
          // all three grids back on screen in its own order. `row` stays what it
          // always was — the first tracking leg — so a payroll page cached from
          // before the destination toggle still pre-fills instead of opening
          // blank.
          answer.dust = {
            rows: dust.rows, row: dust.row,
            ob_rows: ob.rows, ees_rows: ees.rows,
            options, companies,
          };
        }
        return res.json(answer);
      }

      const rows = await sql`
        SELECT row_id, project_id, date, cost_code, sub_code, equipment,
               labor_hours, equip_hours, quantity, field_type
        FROM daily_tracking
        WHERE timesheet_entry_id = ${id} AND company_code = ${companyCode}
        ORDER BY id ASC
      `;
      return res.json({
        split: rows.map(r => ({
          cost_code:   r.cost_code   || '',
          sub_code:    r.sub_code    || '',
          equipment:   r.equipment   || '',
          labor_hours: r.labor_hours != null ? Number(r.labor_hours) : 0,
          equip_hours: r.equip_hours != null ? Number(r.equip_hours) : 0,
          quantity:    r.quantity    != null ? Number(r.quantity)    : 0,
          is_travel:   r.field_type === 'Travel',
        })),
      });
    }

    // ── PUT — update fields ───────────────────────────────────────────────
    if (req.method === 'PUT') {
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });

      const isOwnDraft      = existing.user_id === userId && existing.status === 'draft';
      // Payroll admins may correct mistakes on both submitted AND approved
      // entries — the audit log records the prior snapshot either way.
      const isAdminEditable = canAdmin && (existing.status === 'submitted' || existing.status === 'approved');
      if (!isOwnDraft && !isAdminEditable) {
        return res.status(403).json({ error: 'This entry cannot be edited from your account' });
      }

      // If this is an admin edit on an approved entry that already has
      // injected cost rows, refuse — otherwise the timesheet's hours and
      // the daily_tracking split go out of sync silently. The admin must
      // un-approve first (which removes the split), edit, then re-approve
      // with a fresh split.
      if (canAdmin && existing.status === 'approved') {
        const [{ cnt }] = await sql`
          SELECT COUNT(*)::int AS cnt FROM daily_tracking
          WHERE timesheet_entry_id = ${id} AND company_code = ${companyCode}
        `;
        let injected = cnt;
        if (existing.division === 'quarry') {
          const { row } = await quarrySplitForEntry(sql, companyCode, existing);
          if (row) injected += 1;
        }
        if (needsTruckTrackingRow(existing)) {
          if (await truckingHasInjectedRow(sql, companyCode, existing)) injected += 1;
        }
        // The dust tab shows this entry's date, times and customer verbatim, so
        // editing an approved haul without re-injecting would leave the tab —
        // and the invoice built from it — quietly disagreeing with the timesheet.
        if (needsDustTrackingRow(existing)) {
          if (await dustHasInjectedRow(sql, companyCode, existing)) injected += 1;
          // Same rule for a haul billed as material: the Other Billing row
          // shows this entry's date and customer, and its trucking hours are
          // the clock window off the timesheet, so editing the entry underneath
          // it would leave the invoice disagreeing with the day it billed.
          if (await obHasInjectedRow(sql, companyCode, existing)) injected += 1;
        }
        // Same rule for EES: the tab shows the entry's hours and times verbatim,
        // so editing an approved entry without re-injecting would leave the tab
        // — and any Intercompany figure built from it — quietly disagreeing with
        // the timesheet.
        if (couldHaveEesOtherRows(existing)) {
          if (await eesOtherHasInjectedRow(sql, companyCode, existing)) injected += 1;
        }
        if (injected > 0) {
          return res.status(409).json({
            error: 'This entry has cost tracking rows injected from approval. Un-approve it first, edit, then re-approve with a fresh split.',
            injected_row_count: injected,
          });
        }
      }

      const { data, error } = normalizeEntryBody(req.body || {});
      if (error) return res.status(400).json({ error });

      // Absent split keys on an edit mean "leave the tag as it is" — see
      // normalizeSplitTag. Changing an entry to time off drops it either way.
      const split = (data.entry_type === 'time_off')
        ? { split_group_id: null, split_index: null, split_count: null }
        : (normalizeSplitTag(req.body) || {
            split_group_id: existing.split_group_id || null,
            split_index:    existing.split_index != null ? Number(existing.split_index) : null,
            split_count:    existing.split_count != null ? Number(existing.split_count) : null,
          });

      // Same rule for the two haul fields. payroll.html's entry-edit form has no
      // Unit or Description input — it edits the day, not the haul — so it sends
      // neither key, and taking that as "clear them" silently threw away the
      // driver's unit and description (and the one payroll typed at approval)
      // on any correction to the hours or the job. Absent now means keep.
      // Present still wins, blank included, so timesheet.html can still clear a
      // field the driver filled in by mistake.
      // Only while the entry is STILL a haul, though: normalizeEntryBody forces
      // both to null off a truck row on purpose, so a division change away from
      // trucking/dust must not let a stale unit ride along.
      const body        = req.body || {};
      const staysTruck  = needsTruckTrackingRow({
        entry_type: data.entry_type, division: data.division, job_id: data.job_id,
      });
      // A haul on turf/paving/kiewit keeps its truck in this same column, so it
      // needs the same "absent means keep" protection. Without it, payroll
      // correcting the hours on a haul day — an edit that sends neither key —
      // wiped the unit the driver had named, while keepHaul below preserved the
      // haul answer: still a haul, no truck, and the approval then posts a row
      // that costs the job nothing at all.
      //
      // "Still a haul" is what the row will hold AFTER this write: the body's
      // answer when it sent one, otherwise the stored one, which keepHaul keeps.
      const nextHaulForUnit = Object.prototype.hasOwnProperty.call(body, 'haul_type')
        ? safeHaulType(body.haul_type)
        : (existing.haul_type || null);
      const staysHaulUnit = data.entry_type === 'daily'
        && !!nextHaulForUnit
        && AUTO_INJECT_DIVISIONS.includes(data.division);
      const keepUnit    = (staysTruck || staysHaulUnit)
        && !Object.prototype.hasOwnProperty.call(body, 'truck_unit');
      const keepTruckDesc = staysTruck && !Object.prototype.hasOwnProperty.call(body, 'truck_description');

      // The same rule again for the six EES columns, for the same reason and
      // with the same failure the two above were added to stop. payroll.html's
      // entry-edit form has no Unit / Customer / Location / Name / Job Number /
      // Billing input — it edits the day, not the EES row — so it sends none of
      // these keys, and taking absent as "clear them" threw away what the driver
      // filled in on any correction to the hours or the job, and reset Billing
      // to Non-Billable. The tab then bills nobody for a day that was Billable.
      // Absent means keep; present still wins, blank included, so timesheet.html
      // can still clear a field the driver filled in by mistake, and payroll's
      // Edit Row (action=resplit) writes them through its own path.
      // Only while the entry is STILL an EES day, though: normalizeEntryBody
      // forces these to null off an EES job on purpose, so a job change to a
      // customer haul must not let stale EES columns ride along.
      const staysEes = data.entry_type === 'daily'
        && data.division === 'dust' && isEesJob(data.job_id);
      const keepEes  = f => staysEes && !Object.prototype.hasOwnProperty.call(body, f);

      // Same hazard, same rule, for the driver's hauling answer. Payroll's Edit
      // Entry modal edits the DAY — date, job, clock, lunch, equipment — and
      // sends none of the timesheet's haul keys, so writing data.haul_type
      // unconditionally would clear it on any correction to the hours or the
      // job. The prevailing-hours split and the $0 labour rate both hang off
      // that answer, so losing it silently moves a driver's hours back into
      // prevailing and re-bills the job for his wage.
      //
      // Absent means keep; present still wins, blank included, so timesheet.html
      // can clear an answer the driver ticked by mistake.
      //
      // Gated on the entry still being a DAILY one, the same shape as staysTruck
      // and staysEes above. normalizeEntryBody already forces haul_type to null
      // on the time_off branch on purpose, and the time-off payload sends no
      // haul_type key — so without this an entry switched from a haul day to
      // time off would keep the answer, and carry it back into a later daily
      // edit that never asked for it, zeroing that block's labour rate.
      // Division and job changes need no such gate: haul_type is tied to
      // neither, so nothing about a re-categorization makes it stale.
      const keepHaul = data.entry_type === 'daily'
        && !Object.prototype.hasOwnProperty.call(body, 'haul_type');

      const [updated] = await sql`
        UPDATE timesheet_entries SET
          entry_type         = ${data.entry_type},
          work_date          = ${data.work_date},
          division           = ${data.division},
          job_id             = ${data.job_id},
          job_label          = ${data.job_label},
          start_time         = ${data.start_time},
          end_time           = ${data.end_time},
          computed_hours       = ${data.computed_hours},
          travel_to_site_hours = ${data.travel_to_site_hours},
          travel_to_shop_hours = ${data.travel_to_shop_hours},
          travel_hours         = ${data.travel_hours},
          lunch_break        = ${data.lunch_break},
          operated_equipment = ${data.operated_equipment},
          haul_type          = CASE WHEN ${keepHaul}::boolean
                                    THEN haul_type ELSE ${data.haul_type}::text END,
          supervisor_id      = ${data.supervisor_id},
          supervisor_name    = ${data.supervisor_name},
          notes              = ${data.notes},
          time_off_type      = ${data.time_off_type},
          truck_unit         = CASE WHEN ${keepUnit}::boolean
                                    THEN truck_unit ELSE ${data.truck_unit}::text END,
          truck_description  = CASE WHEN ${keepTruckDesc}::boolean
                                    THEN truck_description ELSE ${data.truck_description}::text END,
          ees_unit           = CASE WHEN ${keepEes('ees_unit')}::boolean
                                    THEN ees_unit ELSE ${data.ees_unit}::text END,
          ees_customer       = CASE WHEN ${keepEes('ees_customer')}::boolean
                                    THEN ees_customer ELSE ${data.ees_customer}::text END,
          ees_location       = CASE WHEN ${keepEes('ees_location')}::boolean
                                    THEN ees_location ELSE ${data.ees_location}::text END,
          ees_name           = CASE WHEN ${keepEes('ees_name')}::boolean
                                    THEN ees_name ELSE ${data.ees_name}::text END,
          ees_job_number     = CASE WHEN ${keepEes('ees_job_number')}::boolean
                                    THEN ees_job_number ELSE ${data.ees_job_number}::text END,
          ees_billing        = CASE WHEN ${keepEes('ees_billing')}::boolean
                                    THEN ees_billing ELSE ${data.ees_billing}::text END,
          split_group_id     = ${split.split_group_id},
          split_index        = ${split.split_index},
          split_count        = ${split.split_count},
          updated_at         = NOW()
        WHERE id = ${id} AND company_code = ${companyCode}
        RETURNING *
      `;
      await writeAudit(
        sql, companyCode, payload, id,
        isAdminEditable ? 'ADMIN_EDIT' : 'UPDATE',
        null, dbToEntry(updated)
      );
      return res.json(await entryJson(sql, companyCode, updated));
    }

    // ── DELETE ────────────────────────────────────────────────────────────
    // Field user: their OWN drafts only.
    // Payroll admin: any entry regardless of status (recorded as DELETE in
    // the audit log with the full pre-delete snapshot).
    if (req.method === 'DELETE') {
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      const [existing] = await sql`
        SELECT * FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (!existing) return res.status(404).json({ error: 'Entry not found' });

      const isOwnDraft = existing.user_id === userId && existing.status === 'draft';
      if (!isOwnDraft && !canAdmin) {
        return res.status(403).json({ error: 'You do not have permission to delete this entry' });
      }

      // Cascade-remove any injected daily_tracking rows. The FK is ON DELETE
      // SET NULL — relying on that would leave the cost rows alive as
      // "manual" rows, which is invisible and surprising. Explicit DELETE
      // keeps payroll deletion symmetric with the approval/un-approval flow.
      //
      // Every sweep keys on the entry's DIVISION, never on its status. An
      // injected row can outlive the thing that should have removed it — a
      // daily_tracking row that lost its link (see removeSplitRows), or a
      // quarry/trucking row whose blob rewrite landed while its mirror delete
      // threw — and either way the entry is left reading 'submitted' with
      // cost still posted against it. Deleting the entry is the last chance to
      // catch those, so the status must not be what decides whether to look.
      // Costs nothing on the other divisions, which never match the prefix.
      let removedSplitRows = await removeSplitRows(sql, companyCode, id);
      if (existing.division === 'quarry') {
        removedSplitRows += await removeQuarryRows(sql, companyCode, existing);
      }
      // Deliberately broader than needsTruckTrackingRow: that gate also reads
      // the job, and a dust entry un-approved, stripped of its job and then
      // deleted would slip past it while its injected row (removed on a sweep
      // that threw) lived on. The sweep is keyed on the "tst-<id>-" prefix, so
      // looking when there is nothing to find costs one blob read and can never
      // match another entry's rows.
      if (existing.division === 'trucking' || existing.division === 'dust') {
        removedSplitRows += await removeTruckingRows(sql, companyCode, existing);
      }
      // Same reasoning, same breadth, for the dust half of a customer haul: the
      // sweep is keyed on the "tsd-<id>-" prefix, so looking when there is
      // nothing to find costs one indexed lookup and can never match another
      // entry's row.
      if (existing.division === 'dust') {
        removedSplitRows += await removeDustTrackingRows(sql, companyCode, existing);
        // And the Other Billing half, on the same reasoning and the same
        // breadth: the sweep is keyed on the "tso-<id>-" prefix, so looking
        // when there is nothing to find costs one blob read and can never match
        // another entry's rows.
        removedSplitRows += await removeObRows(sql, companyCode, existing);
      }
      // Keyed on the division+job the same way the other sweeps are, so a row
      // that outlived its entry still gets caught when the entry is deleted.
      if (couldHaveEesOtherRows(existing)) {
        removedSplitRows += await removeEesOtherRows(sql, companyCode, existing);
      }
      await sql`DELETE FROM timesheet_entries WHERE id = ${id} AND company_code = ${companyCode}`;
      await writeAudit(
        sql, companyCode, payload, id, 'DELETE',
        removedSplitRows ? { removed_split_rows: removedSplitRows } : null,
        dbToEntry(existing),
      );
      return res.json({ ok: true, removed_split_rows: removedSplitRows });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('[timesheet-entries]', err.message);
    return res.status(500).json({ error: 'Database error', detail: err.message });
  }
};

// Internal helpers exposed for unit testing only (scripts/test-trucking-injection.js).
// Not part of the HTTP contract — do not depend on these from other endpoints.
module.exports._test = {
  normalizeSplitTag,
  normalizeEntryBody,
  matchRosterEmployee,
  insertSplitRows,
  removeSplitRows,
  truckingRowIdPrefix,
  truckingRowId,
  matchTruckingDriver,
  insertTruckingRow,
  insertTruckingRows,
  needsTruckTrackingRow,
  insertEesOtherRow,
  insertEesOtherRows,
  eesOtherRowId,
  eesOtherRowIndexFromId,
  couldHaveEesOtherRows,
  eesSplitForEntry,
  removeEesOtherRows,
  eesOtherRowIdPrefix,
  eesOtherHasInjectedRow,
  clearIcSuppression,
  removeTruckingRows,
  truckingHasInjectedRow,
  truckingSplitForEntry,
  validateTruckingInjection,
  TRUCK_DIVISION_BLOB,
  // Dust Control Tracking injection — scripts/test-dust-injection.js.
  needsDustTrackingRow,
  dustRowId,
  dustRowIdPrefix,
  validateDustInjection,
  dustOptionsForEntry,
  dustCompanyDirectory,
  insertDustTrackingRow,
  insertDustTrackingRows,
  removeDustTrackingRows,
  dustHasInjectedRow,
  dustSplitForEntry,
  // Dust "Other Billing" injection — scripts/test-dust-ob-injection.js.
  legDest,
  legHours,
  buildObRow,
  insertObRows,
  removeObRows,
  obHasInjectedRow,
  obSplitForEntry,
  matchDustEmployee,
  OB_BLOB_KEY,
  // Quarry injection — scripts/test-quarry-fuel-entry.js.
  validateQuarryInjection,
  Q_MAX,
};
