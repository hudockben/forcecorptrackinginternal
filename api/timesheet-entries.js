'use strict';
/**
 * Timesheet entries — field-employee time submissions.
 *
 *   GET    /api/timesheet-entries                       — list entries
 *     Field user  → only their own rows
 *     Payroll admin → all company rows (filter via query params)
 *     Query: ?status=draft|submitted|approved
 *            ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *            ?user_id=N      (admin only)
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
 *     Other divisions: legacy behavior (flip status only).
 *
 *   POST   /api/timesheet-entries?action=resplit&id=N   — replace injected rows
 *     Payroll-admin only, row must already be 'approved'. Same body shape as
 *     approve. For turf/paving: deletes the prior injected daily_tracking rows
 *     then inserts the new split. For quarry: rewrites the injected blob row.
 *     Status stays 'approved'.
 *
 *   POST   /api/timesheet-entries?action=unapprove&id=N — approved → submitted
 *     Payroll-admin only. Deletes any injected daily_tracking rows (turf/paving)
 *     and any injected fct_quarry_* blob rows (quarry) and reverts status. Used
 *     when an approval needs to be re-done from scratch.
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
 * out of it: turf/paving/quarry daily entries inject cost-tracking rows on
 * approval (see the approve/resplit/unapprove actions below); other divisions
 * stay isolated (status flip only).
 */

const { neon } = require('@neondatabase/serverless');
const { requireAuth, hasDivisionAccess } = require('./lib/auth');
const { syncForKey } = require('./lib/sync-normalized');

const VALID_DIVISIONS = ['turf', 'dust', 'paving', 'trucking', 'quarry'];
const VALID_TIME_OFF  = ['vacation', 'sick', 'jury_duty', 'bereavement', 'holiday'];

// Auto-inject into daily_tracking is only meaningful for divisions whose cost
// tracking lives there (rows per project). Turf and paving qualify; the other
// divisions either store labor elsewhere or don't track per-project cost.
const AUTO_INJECT_DIVISIONS = ['turf', 'paving'];

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

function safeDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
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
const PW_PROJECT_PREFIX = { turf: 'fct_project_', paving: 'fct_paving_project_' };

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
  if (!Number.isFinite(quantity) || quantity < 0) {
    return { error: `split[${idx}].quantity must be a non-negative number` };
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

  // Pre-fill auto-derivable fields from the same source the cost tracking
  // page reads when the user picks an employee/equipment manually: the
  // app_data blobs. The normalized projects/employees/equipment_list
  // tables drop `prevailing_wage`, `prevailing_rate`, and
  // `non_prevailing_rate` during the sync-normalized.js mirror, so they're
  // unreliable for auto-fill. Lookups are best-effort — a missing blob or
  // a name that doesn't resolve leaves the value at its previous default
  // (null/0).
  // Paving projects live under fct_paving_project_<id>, turf under
  // fct_project_<id> — use the division-aware prefix (same map the list view
  // uses) so paving prevailing-wage jobs resolve their flag, and thus the
  // prevailing vs non-prevailing labor rate, correctly.
  const projKey = `${companyCode}:${PW_PROJECT_PREFIX[division] || 'fct_project_'}${entry.job_id}`;
  const projRows = await sql`SELECT value FROM app_data WHERE key = ${projKey}`;
  const projBlob = projRows.length ? projRows[0].value : null;
  const isPrevailingWage = !!(projBlob && projBlob.prevailing_wage === true);

  const listsKey = division === 'paving'
    ? `${companyCode}:fct_paving_lists`
    : `${companyCode}:fct_lists`;
  const listsRows = await sql`SELECT value FROM app_data WHERE key = ${listsKey}`;
  const listsBlob = listsRows.length ? listsRows[0].value : null;
  const blobEmps = listsBlob && Array.isArray(listsBlob.employees) ? listsBlob.employees : [];
  const blobEquipment = listsBlob && Array.isArray(listsBlob.equipment) ? listsBlob.equipment : [];

  // Login usernames are typically the last name only ("Mowery") while the
  // roster stores full names ("Lucas Mowery"). Try exact match first, then
  // last-word match — but only accept the suffix match when unambiguous.
  const empLogin = (employeeName || '').trim().toLowerCase();
  let emp = null;
  if (empLogin) {
    emp = blobEmps.find(
      e => e && typeof e === 'object'
        && String(e.name || '').trim().toLowerCase() === empLogin,
    ) || null;
    if (!emp) {
      const needle = ' ' + empLogin;
      const suffixMatches = blobEmps.filter(
        e => e && typeof e === 'object'
          && String(e.name || '').trim().toLowerCase().endsWith(needle),
      );
      if (suffixMatches.length === 1) emp = suffixMatches[0];
    }
  }
  const jobClass = (emp && emp.job_class) || null;
  const empRate  = emp
    ? (Number(isPrevailingWage ? emp.prevailing_rate : emp.non_prevailing_rate) || 0)
    : 0;
  const employeeLabel = (emp && emp.name) || employeeName;

  const eqCostByName = new Map();
  for (const eq of blobEquipment) {
    if (eq && typeof eq === 'object' && eq.name) {
      eqCostByName.set(String(eq.name), Number(eq.unit_cost) || 0);
    }
  }

  for (let i = 0; i < splitRows.length; i++) {
    const r = splitRows[i];
    const rowId = `ts${entry.id}-${baseStamp}-${i}-${Math.floor(Math.random() * 1e6)}`;
    const eqUnitCost = r.equipment ? (eqCostByName.get(r.equipment) || 0) : 0;
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
        ${null},
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
  const parts = String(jobLabel || '').split('—');
  return parts.length > 1 ? parts.slice(1).join('—').trim() : (parts[0] || '').trim();
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
        supervisor_id:        null,
        supervisor_name:      null,
        notes:                safeStr(body.notes, 2000),
        time_off_type,
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
    // ── GET ────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
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
      const userF = canAdmin ? safeInt(q.user_id) : userId;
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
          notes, time_off_type
        ) VALUES (
          ${companyCode}, ${userId}, ${username}, ${data.entry_type}, ${data.work_date}, 'draft',
          ${data.division}, ${data.job_id}, ${data.job_label},
          ${data.start_time}, ${data.end_time}, ${data.computed_hours},
          ${data.travel_to_site_hours}, ${data.travel_to_shop_hours}, ${data.travel_hours},
          ${data.lunch_break}, ${data.operated_equipment},
          ${data.supervisor_id}, ${data.supervisor_name},
          ${data.notes}, ${data.time_off_type}
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

      if (splitRows || quarryInject) {
        try {
          if (splitRows) {
            await insertSplitRows(
              sql, splitRows, updated, updated.division, companyCode, updated.username,
            );
          } else {
            await insertQuarryRow(
              sql, companyCode, updated, quarryInject.activity, quarryInject.fields,
            );
          }
        } catch (injErr) {
          // Rollback the approval so payroll sees the row as pending again
          // and can retry. Without this we'd have an approved entry with
          // zero injected rows — invisible to the cost tracking tab.
          console.error('[timesheet-entries] injection failed, rolling back approval:', injErr.message);
          // Quarry writes the blob before mirroring; if the mirror sync threw,
          // scrub any half-written blob row so it can't linger as a phantom
          // locked row in the Daily/Crushing tab while the entry is pending.
          if (quarryInject) {
            try { await removeQuarryRows(sql, companyCode, updated); }
            catch (cleanupErr) { console.error('[timesheet-entries] quarry rollback cleanup failed:', cleanupErr.message); }
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
          : quarryInject ? { quarry_activity: quarryInject.activity } : null,
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

      if (existing.entry_type !== 'daily' || !AUTO_INJECT_DIVISIONS.includes(existing.division)) {
        return res.status(400).json({ error: 'Resplit applies only to daily entries in turf/paving/quarry' });
      }
      if (!existing.job_id) {
        return res.status(400).json({ error: 'Cannot inject: entry has no job_id (project)' });
      }

      const { rows: splitRows, error } = validateSplit((req.body && req.body.split) || [], existing);
      if (error) return res.status(400).json({ error });

      // Delete the prior injected rows for this entry, then insert the new
      // split. We don't wrap this in a transaction (neon-serverless has
      // limited multi-statement transaction support) — the delete is safe
      // to retry because it's keyed on timesheet_entry_id, and the insert
      // is idempotent on row_id.
      await sql`
        DELETE FROM daily_tracking
        WHERE timesheet_entry_id = ${id} AND company_code = ${companyCode}
      `;
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

      // Count first so the audit log captures it.
      const [{ cnt }] = await sql`
        SELECT COUNT(*)::int AS cnt FROM daily_tracking
        WHERE timesheet_entry_id = ${id} AND company_code = ${companyCode}
      `;
      await sql`
        DELETE FROM daily_tracking
        WHERE timesheet_entry_id = ${id} AND company_code = ${companyCode}
      `;
      // Quarry stores its injected rows in the fct_quarry_* blobs, not
      // daily_tracking — clear those too so the Daily/Crushing tab reflects
      // the un-approval.
      let removedQuarry = 0;
      if (existing.division === 'quarry') {
        removedQuarry = await removeQuarryRows(sql, companyCode, existing);
      }
      const removed = cnt + removedQuarry;
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
      let removedSplitRows = 0;
      if (existing.status === 'approved') {
        const [{ cnt }] = await sql`
          SELECT COUNT(*)::int AS cnt FROM daily_tracking
          WHERE timesheet_entry_id = ${id} AND company_code = ${companyCode}
        `;
        removedSplitRows = cnt;
        await sql`
          DELETE FROM daily_tracking
          WHERE timesheet_entry_id = ${id} AND company_code = ${companyCode}
        `;
        if (existing.division === 'quarry') {
          removedSplitRows += await removeQuarryRows(sql, companyCode, existing);
        }
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
