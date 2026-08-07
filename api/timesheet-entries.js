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
 *     For trucking daily entries NO body is needed — a Truck Tracking row is
 *     autofilled from the entry (driver ← employee, date, start/end, hours,
 *     customer ← job_label) and appended to the fct_truck_division blob (and
 *     mirrored to truck_division_entries), with its id prefixed "tst-<entryId>-".
 *     Haul fee and the division column are left blank for the trucking office.
 *     Remaining divisions (dust): legacy behavior (flip status only).
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
 *     approval needs to be re-done from scratch.
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
 * out of it: turf/paving/quarry/trucking daily entries inject cost-tracking rows
 * on approval (see the approve/unapprove actions below); the remaining divisions
 * stay isolated (status flip only).
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');
const { syncForKey } = require('./lib/sync-normalized');

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
// truck_division_entries table by api/truck-division.js). Unlike
// turf/paving/quarry there are NO payroll-entered cost fields: every value is
// autofilled from the timesheet entry. The haul fee and the division column are
// deliberately left blank for the trucking office to fill in later. Injected
// rows are tagged by encoding the timesheet entry id into the row id (same
// scheme as quarry) so unapprove/delete can find and remove them again.
const TRUCK_DIVISION_BLOB = 'fct_truck_division';
function truckingRowIdPrefix(entryId) { return `tst-${entryId}-`; }

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
    supervisor_id:       r.supervisor_id,
    supervisor_name:     r.supervisor_name || '',
    notes:               r.notes || '',
    time_off_type:       r.time_off_type || '',
    truck_unit:          r.truck_unit || '',
    truck_description:   r.truck_description || '',
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
  const empRate  = resolver.rateFor(emp, isPrevailingWage);
  // Prefer the roster's own spelling so the injected row carries the name the
  // cost tracking tab shows everywhere else, not the raw login.
  const employeeLabel = (emp && emp.name) || employeeName;

  for (let i = 0; i < splitRows.length; i++) {
    const r = splitRows[i];
    const rowId = `ts${entry.id}-${baseStamp}-${i}-${Math.floor(Math.random() * 1e6)}`;
    const eqUnitCost = resolver.equipCostFor(r.equipment);
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
        ${r.is_travel ? 'Travel' : null},
        ${employeeLabel},
        ${r.cost_code || null},
        ${r.sub_code || null},
        ${jobClass},
        ${empRate},
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
const Q_MAX = {
  rate: 1e4, hourlyRate: 1e4, ppg: 1e3, fuelCost: 1e3,
  fuelGallons: 1e5, loadsToCrusher: 1e4, tonsPerLoad: 1e3, hoursCrushing: 24,
};

function validateQuarryInjection(activity, raw) {
  const q = (raw && typeof raw === 'object') ? raw : {};
  if (activity === 'daily') {
    const rate        = quarryNum(q.rate,        Q_MAX.rate);
    const fuelGallons = quarryNum(q.fuelGallons, Q_MAX.fuelGallons);
    const ppg         = quarryNum(q.ppg,         Q_MAX.ppg);
    if (rate == null)        return { error: `rate must be between 0 and ${Q_MAX.rate}` };
    if (fuelGallons == null) return { error: `fuelGallons must be between 0 and ${Q_MAX.fuelGallons}` };
    if (ppg == null)         return { error: `ppg must be between 0 and ${Q_MAX.ppg}` };
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
      if (v == null) return { error: `${k} must be between 0 and ${Q_MAX[k]}` };
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
// injection. Only two fields are entered on the payroll side — the haul fee
// (billing rate per hour) and the division column; everything else autofills
// from the timesheet entry. Both are optional (blank is allowed) so payroll can
// approve now and fill the fee in later via Edit Row. Returns { fields } or
// { error }.
const TRUCK_HAUL_FEE_MAX = 1e7;
function validateTruckingInjection(raw) {
  const t = (raw && typeof raw === 'object') ? raw : {};
  let haul_fee = '';
  if (t.haul_fee !== '' && t.haul_fee != null) {
    const n = Number(t.haul_fee);
    if (!Number.isFinite(n) || n < 0 || n > TRUCK_HAUL_FEE_MAX) {
      return { error: `haul_fee must be a number between 0 and ${TRUCK_HAUL_FEE_MAX}` };
    }
    haul_fee = Math.round(n * 10000) / 10000;
  }
  const division = safeStr(t.division, 100) || '';
  return { fields: { haul_fee, division } };
}

// Best-effort match of the timesheet employee to the trucking driver roster so
// the injected row's driver reads as a real driver name where possible. The
// roster lives in dropdown_lists (list_name='truck_drivers'). Login names are
// often a last name; try exact then an unambiguous suffix, else keep the raw
// name (the Truck Tracking combobox preserves free text).
async function matchTruckingDriver(sql, companyCode, name) {
  const n = (name || '').trim().toLowerCase();
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
  const exact = names.find(v => v.trim().toLowerCase() === n);
  if (exact) return exact;
  const suffix = names.filter(v => v.trim().toLowerCase().endsWith(' ' + n));
  if (suffix.length === 1) return suffix[0];
  return name || '';
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
 * Build + inject a single Truck Tracking row for an approved trucking entry.
 * Deletes any prior injected rows for this entry first (idempotent — covers a
 * retried approve), appends the new row to the fct_truck_division blob, writes
 * it, and mirrors the row into truck_division_entries. Returns the row written.
 *
 * Autofill: driver ← employee, actual_date ← work_date, actual_start/end ←
 * start/end, total_hours ← the (lunch-deducted) computed work hours, customer ←
 * job_label, unit ← truck_unit, description ← truck_description. The haul fee and
 * division column come from the payroll modal (fields arg); everything else is
 * derived from the timesheet entry so the Truck Tracking row is fully owned by
 * payroll and locked in the Trucking division. invoice fields default to
 * Unpaid/blank (the trucking office manages invoicing).
 */
async function insertTruckingRow(sql, companyCode, entry, fields = {}) {
  const workDate = safeDate(entry.work_date) || '';
  const hours    = _r2(Number(entry.computed_hours) || 0);
  const driver   = await matchTruckingDriver(sql, companyCode, entry.username);
  const customer = safeStr(entry.job_label, 500) || safeStr(entry.job_id, 500) || '';
  const hhmm     = v => String(v || '').slice(0, 5);
  // Payroll-entered fields (validated by validateTruckingInjection). Blank is
  // allowed — payroll can approve now and set the fee later via Edit Row.
  const haulFee  = (fields.haul_fee === '' || fields.haul_fee == null) ? '' : fields.haul_fee;
  const division = safeStr(fields.division, 100) || '';

  const row = {
    id:                `${truckingRowIdPrefix(entry.id)}${Date.now()}`,
    task_number:       '',
    actual_date:       workDate,
    driver,
    unit:              safeStr(entry.truck_unit, 100) || '',
    actual_start:      hhmm(entry.start_time),
    actual_end:        hhmm(entry.end_time),
    total_hours:       hours,
    haul_fee:          haulFee,   // entered on the payroll side
    customer,
    description:       safeStr(entry.truck_description, 2000) || '',
    division,                     // entered on the payroll side
    notes:             entry.notes || '',
    qb_invoice:        '',
    invoiced_date:     '',
    invoice_sent_date: '',
    invoice_status:    'Unpaid',
    date_paid:         '',
  };

  const prefix = truckingRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  const stale  = arr.filter(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix));
  const next   = arr.filter(r => !(r && typeof r === 'object' && String(r.id || '').startsWith(prefix)));
  next.push(row);
  await writeBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB, next);

  const staleIds = stale.map(r => r.id).filter(Boolean);
  if (staleIds.length) {
    await sql`DELETE FROM truck_division_entries WHERE company_code = ${companyCode} AND id = ANY(${staleIds})`;
  }
  await upsertTruckDivisionEntry(sql, companyCode, row);
  return row;
}

/**
 * Remove every Truck Tracking row injected from this entry — from both the
 * fct_truck_division blob and the truck_division_entries mirror. Returns the
 * count removed.
 */
async function removeTruckingRows(sql, companyCode, entry) {
  const prefix    = truckingRowIdPrefix(entry.id);
  const arr       = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  const removed   = arr.filter(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix));
  if (!removed.length) return 0;
  const remaining = arr.filter(r => !(r && typeof r === 'object' && String(r.id || '').startsWith(prefix)));
  await writeBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB, remaining);
  const removedIds = removed.map(r => r.id).filter(Boolean);
  if (removedIds.length) {
    await sql`DELETE FROM truck_division_entries WHERE company_code = ${companyCode} AND id = ANY(${removedIds})`;
  }
  return removed.length;
}

// True when an approved trucking entry still has an injected Truck Tracking row.
// Used by the PUT guard to force un-approve-before-edit (same rule as quarry).
async function truckingHasInjectedRow(sql, companyCode, entry) {
  const prefix = truckingRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  return arr.some(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix));
}

// The injected Truck Tracking row for an entry, so the payroll modal can pre-fill
// the haul fee + division when re-editing an approved entry (mirrors the GET
// action=split contract quarry uses).
async function truckingSplitForEntry(sql, companyCode, entry) {
  const prefix = truckingRowIdPrefix(entry.id);
  const arr    = await readBlobArray(sql, companyCode, TRUCK_DIVISION_BLOB);
  const row    = arr.find(r => r && typeof r === 'object' && String(r.id || '').startsWith(prefix)) || null;
  return { row };
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
        supervisor_id,
        supervisor_name,
        notes:                safeStr(body.notes, 2000),
        time_off_type,
        truck_unit:           null,
        truck_description:    null,
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

  // Trucking-only extras: the truck Unit and a per-haul Description. Only
  // meaningful for the trucking division (they map to the Truck Tracking unit +
  // description columns on approval); for every other division they're forced to
  // null so a stray value can't leak across.
  const truck_unit        = division === 'trucking' ? safeStr(body.truck_unit, 100)        : null;
  const truck_description = division === 'trucking' ? safeStr(body.truck_description, 2000) : null;

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
      supervisor_id,
      supervisor_name,
      notes:              safeStr(body.notes, 2000),
      time_off_type:      null,
      truck_unit,
      truck_description,
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

      const inserted = await sql`
        INSERT INTO timesheet_entries (
          company_code, user_id, username, entry_type, work_date, status,
          division, job_id, job_label,
          start_time, end_time, computed_hours,
          travel_to_site_hours, travel_to_shop_hours, travel_hours,
          lunch_break, operated_equipment,
          supervisor_id, supervisor_name,
          notes, time_off_type,
          truck_unit, truck_description
        ) VALUES (
          ${companyCode}, ${userId}, ${username}, ${data.entry_type}, ${data.work_date}, 'draft',
          ${data.division}, ${data.job_id}, ${data.job_label},
          ${data.start_time}, ${data.end_time}, ${data.computed_hours},
          ${data.travel_to_site_hours}, ${data.travel_to_shop_hours}, ${data.travel_hours},
          ${data.lunch_break}, ${data.operated_equipment},
          ${data.supervisor_id}, ${data.supervisor_name},
          ${data.notes}, ${data.time_off_type},
          ${data.truck_unit}, ${data.truck_description}
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
    // For the remaining divisions (dust/trucking) the legacy behavior is
    // preserved: approval flips status only, no cost-tracking write.
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

      const needsSplit =
        existing.entry_type === 'daily' &&
        AUTO_INJECT_DIVISIONS.includes(existing.division);
      const needsQuarry =
        existing.entry_type === 'daily' &&
        existing.division === 'quarry';
      // Trucking injects an autofilled Truck Tracking row; payroll supplies the
      // haul fee + division column in the body (both optional).
      const needsTrucking =
        existing.entry_type === 'daily' &&
        existing.division === 'trucking';

      let splitRows = null;
      if (needsSplit) {
        if (!existing.job_id) {
          return res.status(400).json({ error: 'Cannot inject: entry has no job_id (project)' });
        }
        const { rows, error } = validateSplit((req.body && req.body.split) || [], existing);
        if (error) return res.status(400).json({ error });
        splitRows = rows;
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

      if (splitRows || quarryInject || needsTrucking) {
        try {
          if (splitRows) {
            await insertSplitRows(
              sql, splitRows, updated, updated.division, companyCode, updated.username,
            );
          } else if (quarryInject) {
            await insertQuarryRow(
              sql, companyCode, updated, quarryInject.activity, quarryInject.fields,
            );
          } else {
            await insertTruckingRow(sql, companyCode, updated, truckingInject || {});
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

      await writeAudit(
        sql, companyCode, payload, id, 'APPROVE',
        splitRows ? { split_row_count: splitRows.length }
          : quarryInject ? { quarry_activity: quarryInject.activity }
          : needsTrucking ? { trucking_injected: true } : null,
        dbToEntry(updated),
      );
      return res.json(await entryJson(sql, companyCode, updated));
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

      // Trucking re-edit: rewrite the injected Truck Tracking row with the new
      // haul fee / division. insertTruckingRow removes the prior injected row for
      // this entry before appending, so there's no separate delete step.
      if (existing.entry_type === 'daily' && existing.division === 'trucking') {
        const { fields, error } = validateTruckingInjection(req.body && req.body.trucking);
        if (error) return res.status(400).json({ error });
        try {
          await insertTruckingRow(sql, companyCode, existing, fields);
        } catch (injErr) {
          console.error('[timesheet-entries] trucking resplit failed:', injErr.message);
          return res.status(500).json({
            error: 'Edit failed: could not rewrite the Truck Tracking row. Retry.',
            detail: injErr.message,
          });
        }
        await writeAudit(
          sql, companyCode, payload, id, 'ADMIN_EDIT',
          { resplit: true, trucking: true },
          dbToEntry(existing),
        );
        return res.json(await entryJson(sql, companyCode, existing));
      }

      if (existing.entry_type !== 'daily' || !AUTO_INJECT_DIVISIONS.includes(existing.division)) {
        return res.status(400).json({ error: 'Resplit applies only to daily entries in turf/paving/kiewit/quarry/trucking' });
      }
      if (!existing.job_id) {
        return res.status(400).json({ error: 'Cannot inject: entry has no job_id (project)' });
      }

      const { rows: splitRows, error } = validateSplit((req.body && req.body.split) || [], existing);
      if (error) return res.status(400).json({ error });

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
        { resplit: true, split_row_count: splitRows.length },
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
      // Trucking stores its injected rows in the fct_truck_division blob +
      // truck_division_entries table — clear those so the Truck Tracking tab
      // reflects the un-approval.
      let removedTrucking = 0;
      if (existing.division === 'trucking') {
        removedTrucking = await removeTruckingRows(sql, companyCode, existing);
      }
      const removed = cnt + removedQuarry + removedTrucking;
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
                   te.username, te.job_id
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
                   te.username, te.job_id
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
          const rate      = resolver.rateFor(emp, !!pwFlags.get(String(r.job_id)));
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
            && Number(r.equip_unit_cost) === nextEqCost;
          if (same) continue;

          await sql`
            UPDATE daily_tracking
            SET employee        = ${emp.name},
                job_class       = ${jobClass},
                rate            = ${rate},
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
      const id = safeInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id is required' });

      // Quarry entries: return the injected quarry blob row (activity + its
      // value fields) so the payroll modal can pre-fill on re-edit. `id` MUST
      // be selected — quarrySplitForEntry keys the blob lookup on entry.id.
      const [entryRow] = await sql`
        SELECT id, division, job_id, job_label FROM timesheet_entries
        WHERE id = ${id} AND company_code = ${companyCode}
      `;
      if (entryRow && entryRow.division === 'quarry') {
        const { activity, row } = await quarrySplitForEntry(sql, companyCode, entryRow);
        return res.json({ quarry: { activity, row } });
      }
      if (entryRow && entryRow.division === 'trucking') {
        const { row } = await truckingSplitForEntry(sql, companyCode, entryRow);
        return res.json({ trucking: { row } });
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
        if (existing.division === 'trucking') {
          if (await truckingHasInjectedRow(sql, companyCode, existing)) injected += 1;
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
          supervisor_id      = ${data.supervisor_id},
          supervisor_name    = ${data.supervisor_name},
          notes              = ${data.notes},
          time_off_type      = ${data.time_off_type},
          truck_unit         = ${data.truck_unit},
          truck_description  = ${data.truck_description},
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
      if (existing.division === 'trucking') {
        removedSplitRows += await removeTruckingRows(sql, companyCode, existing);
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
  matchRosterEmployee,
  insertSplitRows,
  removeSplitRows,
  truckingRowIdPrefix,
  matchTruckingDriver,
  insertTruckingRow,
  removeTruckingRows,
  truckingHasInjectedRow,
  truckingSplitForEntry,
  validateTruckingInjection,
  TRUCK_DIVISION_BLOB,
};
