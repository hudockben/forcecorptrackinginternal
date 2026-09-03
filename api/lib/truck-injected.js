'use strict';
/**
 * Identity + lifecycle rules for the Truck Tracking rows payroll injects.
 *
 * Approving a trucking (or dust customer) timesheet entry writes one row into
 * the Trucking division's fct_truck_division blob, mirrored into
 * truck_division_entries. Un-approving or deleting the entry takes it back out.
 * Those rows are payroll-owned end to end: trucking.html renders them with a
 * "← Timesheet" badge and refuses to delete them, because the only correct way
 * to remove one is to un-approve the entry it came from.
 *
 * That contract broke in two places, and the two together let un-approved work
 * come back and stay:
 *
 *   1. The injected row id was stamped with Date.now(), so every re-approval
 *      minted a NEW identity. Intercompany keys its billing entry off that id,
 *      so a row approved, un-approved, corrected and re-approved left an
 *      orphaned billing entry behind pointing at an id nothing owned any more.
 *   2. Nothing removed the Intercompany billing entry when the row went away,
 *      and trucking.html's _recoverEntriesFromIcBilling treats a billing entry
 *      whose truck row is missing as data lost to a blob overwrite — so it
 *      rebuilt the row from the stale entry on the next page load. The row came
 *      back with its original id, undeletable from the tab, and invisible to
 *      the next un-approve once the entry had moved on to a different id.
 *
 * The rules live here rather than in api/timesheet-entries.js because
 * api/truck-division.js needs them too — it sweeps rows that outlived their
 * entry on read, and a second copy of "which rows are payroll's" is exactly the
 * kind of drift that produced the bug.
 */

const TRUCK_DIVISION_BLOB = 'fct_truck_division';

/* ── The backup haul fee ───────────────────────────────────────────────────
 *
 * A haul's fee belongs to payroll: the approve modal asks for it, and every
 * cost column of an injected row is rewritten from the timesheet entry. That is
 * the right owner and it stays the right owner — but it was also the ONLY way
 * to price one, and Truck Tracking is where the office notices an unpriced
 * haul. A row that came over at $0.00 could not be fixed from the tab it is
 * billed out of: someone had to find the entry in Payroll, un-approve it,
 * re-approve it with a fee, and hope nothing else on it had moved.
 *
 * So the fee gets a backup: the office types one in the tab, and it is kept
 * BESIDE payroll's number rather than on top of it.
 *
 *   haul_fee_override — what the office typed here. The tab may write it
 *                       (it is on TRUCK_TAB_FIELDS), so it survives both a
 *                       whole-blob save and a re-approval.
 *   haul_fee_payroll  — payroll's own figure, kept only while an override is
 *                       standing, so the tab can show what it is disagreeing
 *                       with and hand the row back with one click.
 *   haul_fee          — DERIVED: the override when one stands, payroll's
 *                       number otherwise.
 *
 * Deriving into haul_fee is the point. Everything that prices a haul reads that
 * one column — the tab's own totals, Intercompany billing, the executive
 * report, trucking-metrics, the normalized mirror, the CSV the office invoices
 * from, and payroll's own Edit Row — and an override each of them had to know
 * about separately is an override some of them would miss, which is a row
 * billing one figure and reported at another. They keep reading one column;
 * this decides what is in it, at both of the two writers (a tab save through
 * injected-blob-guard, and re-injection in api/timesheet-entries.js).
 *
 * Payroll is never locked out. It goes on rewriting haul_fee from the entry,
 * and if it comes back with a different number the override still stands — the
 * office set it deliberately, and a fee somebody has invoiced under must not
 * change because an unrelated correction was made upstream — but the tab says
 * so, and clearing the box takes payroll's figure back. An override that agrees
 * with payroll is dropped rather than kept: there is nothing to override, and a
 * receipt left behind would go on shadowing a column it no longer changes.
 *
 * Which is also how a disagreement ends on its own. Payroll's Edit Row fills
 * its Haul Fee box from the posted row (haulApplyTruckRows in payroll.html), so
 * it shows the fee the haul is actually billing at — the office's, when one
 * stands. Saving it puts that same number on the entry, the override now agrees
 * with payroll, and it is dropped: payroll has adopted the figure, and the row
 * goes back to having one owner.
 */
const HAUL_FEE_OVERRIDE = 'haul_fee_override';
const HAUL_FEE_PAYROLL  = 'haul_fee_payroll';

// The ceiling on a fee, wherever one is read. $10M/hr is not a rate anybody
// bills; a number past it is a typo or a paste of something that is not money.
const HAUL_FEE_MAX = 1e7;

/**
 * Read a haul fee the way every writer must read one: `{ value }` with a
 * number, `{ value: '' }` for "nobody has set one", or `{ error }`.
 *
 * Trimmed before Number(), because Number(' ') is 0 — a whitespace-only box
 * would otherwise store as a deliberate $0/hr, which reads to the office as
 * zero-rated work rather than as an unpriced haul. 0 typed on purpose is a
 * legitimate fee and passes.
 */
function normalizeHaulFee(v) {
  if (v == null || String(v).trim() === '') return { value: '' };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > HAUL_FEE_MAX) {
    return { error: `haul_fee must be a number between 0 and ${HAUL_FEE_MAX}` };
  }
  return { value: Math.round(n * 10000) / 10000 };
}

// Two fees are the same fee when they are the same number. String vs number is
// how the same figure arrives from a JSON blob ('115') and from payroll (115),
// so comparing them raw would read every override as a disagreement.
function sameHaulFee(a, b) {
  const x = normalizeHaulFee(a), y = normalizeHaulFee(b);
  if (x.error || y.error) return false;
  return x.value === y.value;
}

/**
 * Settle `haul_fee` on one injected row from the override standing against it.
 * Mutates and returns the row — the two callers each have a row in hand they
 * are about to store.
 *
 * Payroll's figure is whatever the row carries before this runs, EXCEPT when a
 * previous pass already moved it aside: haul_fee_payroll is the fee this row
 * would bill with no override, wherever it is present. That distinction is what
 * makes the function idempotent, and it is why the guard can run it on a row it
 * just took from the database.
 *
 * A junk override — negative, non-numeric, past the ceiling — is dropped rather
 * than honoured. It cannot arrive from the tab, which validates before it
 * saves, so it means a hand-edited blob or an older client, and inventing a
 * price from it is the one outcome worse than ignoring it.
 */
function applyHaulFeeOverride(row) {
  if (!row || typeof row !== 'object') return row;

  const payroll = Object.prototype.hasOwnProperty.call(row, HAUL_FEE_PAYROLL)
    ? row[HAUL_FEE_PAYROLL]
    : row.haul_fee;
  const { value, error } = normalizeHaulFee(row[HAUL_FEE_OVERRIDE]);

  // Nothing standing: no override, one this cannot read, or one that agrees
  // with payroll anyway. The row bills payroll's number and carries no receipt.
  if (error || value === '' || sameHaulFee(value, payroll)) {
    delete row[HAUL_FEE_OVERRIDE];
    delete row[HAUL_FEE_PAYROLL];
    row.haul_fee = payroll == null ? '' : payroll;
    return row;
  }

  row[HAUL_FEE_OVERRIDE] = value;
  row[HAUL_FEE_PAYROLL]  = payroll == null ? '' : payroll;
  row.haul_fee           = value;
  return row;
}

/**
 * The columns the trucking office owns on a row payroll owns.
 *
 * An injected row renders locked in Truck Tracking — every cost field is
 * payroll's — except the invoice sub-row, which stays editable so the office
 * can still manage billing on it. Re-injection therefore has to preserve these
 * and overwrite the rest, or correcting an entry's hours quietly wipes the QB
 * invoice number and the paid date off a row that was already invoiced. Same
 * rule, and the same reason, as EES_OTHER_TAB_FIELDS on the dust side.
 */
const TRUCK_TAB_FIELDS = [
  'qb_invoice', 'invoiced_date', 'invoice_sent_date', 'invoice_status', 'date_paid',
  // The backup fee (see "The backup haul fee" above). The override, not
  // haul_fee itself: a tab that could write the fee outright would also freeze
  // payroll out of it, because this list is what re-injection PRESERVES — a fee
  // on it could never be corrected from the timesheet again.
  HAUL_FEE_OVERRIDE,
];

// The shared Intercompany billing list, and the tag trucking rows carry in it.
const IC_BILLING_BLOB = 'fct_intercompany_billing_entries';
const IC_SOURCE_TRUCKING = 'trucking';

// The two standing EES activities, as encoded by api/timesheet-jobs.js. A dust
// entry on one of these is EES work and goes to the Dust division's own tab;
// any other dust job is a customer haul and comes to Truck Tracking.
const EES_JOB_IDS = ['ees:preloading', 'ees:washing'];
function isEesJob(jobId) { return EES_JOB_IDS.includes(String(jobId || '')); }

/**
 * True when approving this entry injects a Truck Tracking row.
 *
 * Two divisions route here. Trucking, obviously — its own daily entries have
 * always injected. And dust customer work, because that work IS hauling: a
 * driver takes a truck to a customer for a day, which is the same shape the
 * Truck Tracking tab already records, down to the driver/date/customer/hours
 * columns. Filing it under dust describes who did the work, not where the cost
 * belongs.
 *
 * A dust entry therefore routes by job, and the two dust destinations are
 * disjoint by construction: the standing EES activities go to the Dust
 * division's own "EES Other" tab (isEesJob), every other dust job is a customer
 * haul and comes here. That disjointness is what lets the approve path treat
 * them as an if/else rather than having to order them.
 *
 * A dust entry with no job names no customer, so it injects nowhere and just
 * flips status — the same rule EES already applies. Trucking keeps its old
 * behaviour of injecting regardless, since its rows carry a unit and a
 * description that stand on their own without a customer.
 *
 * Single predicate on purpose: the gate appears at six sites (approve, resplit,
 * un-approve, the edit guard, the read-time sweep, and payroll.html's modal
 * trigger), and a row that outlives its entry is exactly what happens when one
 * of them drifts. The delete sweep deliberately casts wider than this — see the
 * note there.
 */
function needsTruckTrackingRow(entry) {
  if (!entry || entry.entry_type !== 'daily') return false;
  if (entry.division === 'trucking') return true;
  return entry.division === 'dust' && !!entry.job_id && !isEesJob(entry.job_id);
}

/**
 * True when this entry's approved split SENT rows to `division`.
 *
 * The division override (SPLIT_DEST_DIVISIONS in api/timesheet-entries.js) lets
 * payroll route part of a turf/paving/kiewit day into another division's cost
 * tracking, for the day a driver files his hours under the wrong division. The
 * row that lands over there is payroll's and legitimate — but the ENTRY still
 * says turf.
 *
 * That matters here because every "does this entry still justify this row" test
 * on the read path answers from entry.division alone. Left at that, the first
 * person to open Truck Tracking after such an approval sweeps the haul away as
 * an orphan and takes its Intercompany billing entry with it, and the same on
 * the two dust grids — silently, on a plain page load, with no way back short
 * of un-approving the timesheet.
 *
 * timesheet_entries.split_destinations is what the entry knows about where its
 * cost went. It is written when those rows are written and cleared when they
 * are removed, so it can never outlive them.
 */
function splitSentTo(entry, division) {
  const raw = entry && entry.split_destinations;
  if (!raw) return false;
  // JSONB arrives parsed from neon-serverless and from pg, but a caller that
  // selected it as text (or a mock that stores what it was handed) would hand
  // over the string. Cheap to be right either way.
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return false; }
  }
  return Array.isArray(list)
    && list.some(r => r && r.dest && r.dest.division === division);
}

// Every row injected from one timesheet entry shares this prefix, so un-approve
// and delete can find them again. Encoded into the row `id` (not a side field)
// because the division tabs drop unknown keys but always preserve `id`.
function truckingRowIdPrefix(entryId) { return `tst-${entryId}-`; }

/**
 * The most legs one day can be split into, in either tab.
 *
 * Defined here because the two halves of a dust haul must agree on it — the
 * Truck Tracking rows and the Dust Control Tracking rows are the same hauls seen
 * from two offices, so a cap either side could accept and the other refuse would
 * post half a split. dust-injected.js re-exports this as MAX_DUST_ROWS.
 *
 * Six is what the timesheet allows a driver to split a day across
 * (MAX_JOB_BLOCKS in timesheet.html); a supervisor breaking the same day down by
 * customer has no reason to need more.
 */
const MAX_INJECTED_LEGS = 6;

/**
 * The canonical id for leg `index` (1-based) of an entry's injected rows.
 *
 * Stable, not stamped with Date.now(): a leg's position in the day is what
 * identifies it, and Intercompany keys its billing entry off this id. A fresh id
 * on every re-injection orphaned that entry — the billing entry outlived the row
 * it described, kept billing the customer, and got read back as a lost row and
 * rebuilt into a duplicate. Re-injecting is now genuinely idempotent: each leg
 * keeps its identity, its place in the table, and its Intercompany history
 * across an un-approve/correct/re-approve cycle. Matches the scheme the dust
 * "EES Other" rows were moved to for the same reason.
 *
 * Leg 1 keeps the historic "-row" suffix rather than becoming "-1", so every row
 * posted before a day could be split keeps the id its billing entry and its
 * invoice history are already filed under.
 */
function truckingRowId(entryId, index = 1) {
  const n = Number(index) || 1;
  return n <= 1 ? `${truckingRowIdPrefix(entryId)}row` : `${truckingRowIdPrefix(entryId)}${n}`;
}

// The timesheet entry a "tst-<entryId>-<suffix>" row came from, or null when the
// id isn't one of ours. Manual rows use UUIDs and "TR-####" task numbers, so the
// prefix cannot collide with one.
function entryIdFromTruckRowId(rowId) {
  const m = /^tst-(\d+)-/.exec(String(rowId || ''));
  return m ? Number(m[1]) : null;
}

function isInjectedTruckRowId(rowId) { return entryIdFromTruckRowId(rowId) != null; }

// Rank competing rows for the same LEG so exactly one survives a sweep: the
// canonical "-row" id wins outright, otherwise the newest Date.now() stamp does
// (the current row is always the last one injected). An unparseable suffix
// sorts below every real candidate.
function truckRowRecency(rowId) {
  const suffix = String(rowId || '').replace(/^tst-\d+-/, '');
  if (suffix === 'row') return Number.MAX_SAFE_INTEGER;
  const n = Number(suffix);
  return Number.isFinite(n) ? n : -1;
}

/**
 * Which leg of the day an injected id names.
 *
 * "-row" is leg 1 and "-2".."-6" are the legs a split day adds. A legacy
 * Date.now()-stamped id is NOT a leg: it is a leftover copy of the pre-split
 * single row, so it answers 1 and goes on competing with the canonical id for
 * that leg — which is what keeps the sweep clearing those out.
 *
 * The two are told apart by magnitude, which is safe because a Date.now() stamp
 * is around 1.7e12 and a leg index never exceeds MAX_INJECTED_LEGS.
 */
function truckRowLegIndex(rowId) {
  const suffix = String(rowId || '').replace(/^tst-\d+-/, '');
  if (suffix === 'row') return 1;
  const n = Number(suffix);
  return (Number.isInteger(n) && n >= 2 && n <= MAX_INJECTED_LEGS) ? n : 1;
}

/* ── Task numbers ───────────────────────────────────────────────────────────
 *
 * "TR-####" is how the Truck Tracking tab names a haul: it heads the first
 * column, rides along to Intercompany billing and lands on the executive
 * report. The tab numbers every row it creates itself (nextTaskNum and the CSV
 * import in trucking.html) — but a row arriving from payroll was injected with
 * an empty task_number, so the hauls the office bills for out of a timesheet
 * were the only ones with nothing to call them: a "← Timesheet" badge and a
 * blank where the number goes.
 *
 * They are numbered here, out of the SAME TR-#### series the tab uses, so the
 * division has one running series rather than two that have to be told apart on
 * an invoice. Row identity is still the id — a task number is a label, and
 * nothing keys off it.
 *
 * Server-side because the tab cannot do it: injected-blob-guard replays only
 * TRUCK_TAB_FIELDS off a client save and takes every other column from the
 * server's copy, so a number minted in the page would be dropped by the next
 * PUT. And task_number stays OFF that list on purpose — payroll mints it, and a
 * tab save must not be able to move it.
 */

const TRUCK_TASK_RE = /^TR-(\d+)$/;

// The sequence in a "TR-####", or 0 for anything that isn't one (blank, a
// hand-typed label, an imported number in some other format). 0 so it can be
// fed to Math.max without a special case.
function taskNumberSeq(value) {
  const m = TRUCK_TASK_RE.exec(String(value == null ? '' : value).trim());
  return m ? parseInt(m[1], 10) : 0;
}

function formatTaskNumber(n) { return `TR-${String(n).padStart(4, '0')}`; }

// Highest TR-#### across a set of rows — manual and injected alike, because the
// series is shared and a number is only free if nothing in the tab holds it.
function maxTaskNumber(rows) {
  let max = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r || typeof r !== 'object') continue;
    const n = taskNumberSeq(r.task_number);
    if (n > max) max = n;
  }
  return max;
}

/**
 * Number the injected rows in `entries` that have no task number, continuing
 * the list's own series. Pure: returns { entries, assigned } with `entries` a
 * new array carrying the numbers and `assigned` the [{ id, task_number }] that
 * were minted (empty when there was nothing to do).
 *
 * Only injected rows, and only blank ones. A manual row without a number is the
 * tab's business — it mints its own on add and on CSV import — and a row that
 * already has one keeps it, which is what makes this safe to run on every read:
 * a number that has been shown to the office, invoiced under, or mirrored into
 * Intercompany must never be re-issued.
 *
 * Assigned in list order, which for injected rows is the order they were
 * approved (injection appends), so the numbering follows the same
 * oldest-lowest rule a manually added row gets.
 */
function numberInjectedRows(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const blank = list.filter(r =>
    r && typeof r === 'object' &&
    isInjectedTruckRowId(r.id) &&
    !String(r.task_number == null ? '' : r.task_number).trim());
  if (!blank.length) return { entries: list, assigned: [] };

  let next = maxTaskNumber(list);
  const assigned = blank.map(r => ({ id: String(r.id), task_number: formatTaskNumber(++next) }));
  const byId = new Map(assigned.map(a => [a.id, a.task_number]));
  const patched = list.map(r => {
    const num = (r && typeof r === 'object') ? byId.get(String(r.id)) : null;
    return num ? { ...r, task_number: num } : r;
  });
  return { entries: patched, assigned };
}

/**
 * Stamp task numbers onto rows in the Truck Tracking blob, race-free.
 *
 * Same hazard as deleteTruckBlobRows: trucking.html PUTs the whole list, so a
 * read-modify-write here could undo a row somebody edited in between. The patch
 * happens inside the UPDATE and touches only the named ids — and only while
 * they are still blank, so a number minted by a concurrent read (or by payroll
 * re-injecting) is never overwritten by a second one.
 *
 * Company-scoped key only, for the reason deleteTruckBlobRows gives: the
 * unscoped legacy blob is shared across companies and is not ours to rewrite.
 * A read served from it still hands the client the numbers it just minted, and
 * the mirror table below carries them until the first save migrates the blob.
 */
async function setTruckBlobTaskNumbers(sql, companyCode, assigned) {
  const map = {};
  for (const a of (assigned || [])) {
    if (a && a.id && a.task_number) map[String(a.id)] = String(a.task_number);
  }
  if (!Object.keys(map).length) return;
  const scoped = `${companyCode}:${TRUCK_DIVISION_BLOB}`;
  const patch  = JSON.stringify(map);
  await sql`
    UPDATE app_data
       SET value = COALESCE((
             SELECT jsonb_agg(
                      CASE WHEN jsonb_typeof(t) = 'object'
                            AND COALESCE(t->>'task_number', '') = ''
                            AND (${patch}::jsonb ->> (t->>'id')) IS NOT NULL
                           THEN t || jsonb_build_object('task_number', ${patch}::jsonb ->> (t->>'id'))
                           ELSE t END
                      ORDER BY ord)
               FROM jsonb_array_elements(value) WITH ORDINALITY AS a(t, ord)
           ), '[]'::jsonb),
           updated_at = NOW()
     WHERE key = ${scoped}
       AND jsonb_typeof(value) = 'array'
  `;
}

/**
 * Give every injected row in `entries` a task number, and persist the ones this
 * call minted. Returns { entries, assigned } with `entries` ready to hand
 * straight back to the client, so a row is numbered on the same load that
 * numbers it.
 *
 * Runs on read for the same reason the orphan sweep does: rows injected before
 * payroll started numbering them are blank in a column the office bills out of,
 * and the tab cannot fill them in itself. Costs nothing in the steady state —
 * no blank injected rows means no write, which is every call after the first.
 */
async function backfillInjectedTaskNumbers(sql, companyCode, entries) {
  const { entries: patched, assigned } = numberInjectedRows(entries);
  if (!assigned.length) return { entries: patched, assigned };

  await setTruckBlobTaskNumbers(sql, companyCode, assigned);

  // Keep the normalized mirror honest — the executive report and Intercompany
  // read it directly, and it is what the GET falls back to when the blob is
  // empty. Blank-only there too, so this can never renumber a live row.
  const ids  = assigned.map(a => a.id);
  const nums = assigned.map(a => a.task_number);
  await sql`
    UPDATE truck_division_entries t
       SET task_number = v.num, updated_at = NOW()
      FROM (SELECT unnest(${ids}::text[]) AS id, unnest(${nums}::text[]) AS num) v
     WHERE t.company_code = ${companyCode}
       AND t.id = v.id
       AND COALESCE(t.task_number, '') = ''
  `;

  console.warn(`[truck-injected] numbered ${assigned.length} injected row(s) for ${companyCode}: ` +
    assigned.map(a => `${a.id}→${a.task_number}`).join(', '));
  return { entries: patched, assigned };
}

/**
 * Drop Intercompany billing entries for a set of source rows, from both the
 * shared blob and its normalized mirror. Returns the number removed.
 *
 * Called whenever an injected Truck Tracking row is removed. Without it the
 * billing entry outlives the row: Intercompany keeps invoicing hours that were
 * un-approved, and the trucking page reads the orphan as a row it lost and
 * rebuilds it. Any Intercompany-side invoice/payment dates on the entry go with
 * it — that is the intended trade, since the work it billed for no longer
 * exists. This is the same call the dust "EES Other" reconciler already makes
 * when payroll un-approves one of its rows.
 *
 * One statement, deliberately. Reading the list and writing it back would race
 * every other division doing the same thing against this one shared blob:
 * dust reads [A], we write [A minus ours], dust writes [A,B] — and our removal
 * is silently undone. jsonb_agg rebuilds the array inside the UPDATE, so there
 * is no window. COALESCE(..., false) keeps a non-object element (there should
 * be none, but a malformed blob shouldn't be quietly pruned) from evaluating
 * to NULL and being dropped by the filter.
 */
async function removeIcBillingEntries(sql, companyCode, source, sourceIds) {
  const ids = [...new Set((sourceIds || []).map(v => String(v || '')).filter(Boolean))];
  if (!ids.length) return 0;
  const scoped = `${companyCode}:${IC_BILLING_BLOB}`;

  const rows = await sql`
    WITH hits AS (
      SELECT count(*)::int AS n
        FROM app_data d, jsonb_array_elements(d.value) AS t
       WHERE d.key = ${scoped}
         AND jsonb_typeof(d.value) = 'array'
         AND t->>'source' = ${source}
         AND t->>'source_id' = ANY(${ids}::text[])
    ),
    upd AS (
      UPDATE app_data
         SET value = COALESCE((
               SELECT jsonb_agg(t)
                 FROM jsonb_array_elements(value) AS t
                WHERE NOT COALESCE(
                        t->>'source' = ${source}
                    AND t->>'source_id' = ANY(${ids}::text[]), false)
             ), '[]'::jsonb),
             updated_at = NOW()
       WHERE key = ${scoped}
         AND jsonb_typeof(value) = 'array'
         AND (SELECT n FROM hits) > 0
      RETURNING 1
    )
    SELECT (SELECT n FROM hits) AS removed
  `;
  const removed = rows.length ? Number(rows[0].removed) || 0 : 0;

  // Keep the normalized mirror honest. syncForKey rewrites it wholesale from
  // the blob on the next PUT, but Intercompany reads the table directly, so a
  // row left here bills for work the blob no longer carries.
  await sql`
    DELETE FROM intercompany_billing_entries
     WHERE company_code = ${companyCode}
       AND source = ${source}
       AND source_id = ANY(${ids}::text[])
  `;
  return removed;
}

/**
 * Remove a set of rows from the Truck Tracking blob by id, race-free.
 *
 * Same read-modify-write hazard as above: trucking.html PUTs the whole blob, so
 * a sweep that read the array and wrote it back could undo a row somebody added
 * in between. Filtering inside the UPDATE only ever removes the named ids.
 *
 * Company-scoped key only. The unscoped "fct_truck_division" blob predates
 * company scoping and is shared, so one company's timesheet entries are not
 * grounds to delete rows out of it — a row belonging to another company would
 * read as an entry that doesn't exist. A read served from the legacy blob is
 * still filtered before it reaches the client, and the first save migrates it
 * to the scoped key.
 */
async function deleteTruckBlobRows(sql, companyCode, rowIds) {
  const ids = [...new Set((rowIds || []).map(v => String(v || '')).filter(Boolean))];
  if (!ids.length) return;
  const scoped = `${companyCode}:${TRUCK_DIVISION_BLOB}`;
  await sql`
    UPDATE app_data
       SET value = COALESCE((
             SELECT jsonb_agg(t)
               FROM jsonb_array_elements(value) AS t
              WHERE NOT COALESCE(t->>'id' = ANY(${ids}::text[]), false)
           ), '[]'::jsonb),
           updated_at = NOW()
     WHERE key = ${scoped}
       AND jsonb_typeof(value) = 'array'
  `;
}

/**
 * Decide which injected rows in `entries` no longer have a right to be there.
 *
 * Pure — takes the rows and the timesheet entries they claim to come from, and
 * returns the ids to drop. A row is stale when:
 *   - its entry is gone (payroll deleted it),
 *   - its entry is no longer approved (payroll un-approved it),
 *   - its entry no longer routes to Truck Tracking (it was edited onto a
 *     different division, or a dust entry moved onto an EES job),
 *   - its LEG is a dust haul the dust office bills off its own tracking grid
 *     (see `ubLegs`), or
 *   - a newer row for the same LEG of the same entry exists — the duplicate an
 *     old Date.now() id left behind when the entry was re-approved.
 *
 * Competition is per leg, not per entry: a day split across two customers posts
 * one row per haul, and both are live. Legs the split no longer has are pruned
 * by the injection itself, which knows how many it just wrote; this sweep only
 * knows whether the entry still routes here at all, so an entry-level "keep one,
 * drop the rest" rule would delete the second haul's billing on every load of
 * the Truck Tracking tab.
 *
 * `ubLegs` is the per-leg half of that gate: a Set of "<entryId>|<leg>" keys for
 * the hauls the dust office bills off Dust Control Tracking, which no longer
 * post a row here. It is what retires the rows posted before that was true —
 * every dust haul approved up to then wrote one, the tab refuses to delete
 * payroll's rows, and payroll cannot take one back without un-approving a
 * timesheet the office has already been paid for. Absent (a caller with no dust
 * side to ask about) means no leg is excluded, which is the rule every trucking
 * entry follows anyway.
 *
 * Manual rows are never candidates: the sweep only ever looks at ids carrying
 * the "tst-<entryId>-" prefix payroll mints.
 */
function findStaleTruckRows(entries, entriesById, ubLegs = null) {
  const stale = [];
  const newestByLeg = new Map();

  const injected = (entries || []).filter(r => r && typeof r === 'object' && isInjectedTruckRowId(r.id));
  for (const row of injected) {
    const entryId = entryIdFromTruckRowId(row.id);
    const entry   = entriesById.get(entryId) || null;
    if (!entry || entry.status !== 'approved'
        || !(needsTruckTrackingRow(entry) || splitSentTo(entry, 'trucking'))) {
      stale.push(String(row.id));
      continue;
    }
    const key  = `${entryId}|${truckRowLegIndex(row.id)}`;
    // This haul is UB on a pad: the dust office records it, prices it and
    // invoices it off its own grid, and a second copy here is work nobody in
    // this division did.
    if (ubLegs && ubLegs.has(key)) { stale.push(String(row.id)); continue; }
    const prev = newestByLeg.get(key);
    if (!prev) { newestByLeg.set(key, row); continue; }
    // Two live rows for one leg: keep the newer, drop the other.
    if (truckRowRecency(row.id) > truckRowRecency(prev.id)) {
      newestByLeg.set(key, row);
      stale.push(String(prev.id));
    } else {
      stale.push(String(row.id));
    }
  }
  return stale;
}

/**
 * Sweep injected rows that outlived their timesheet entry out of `entries`.
 *
 * Self-healing on read, because the alternative is a row nobody can remove: the
 * Truck Tracking tab refuses to delete payroll rows, and payroll can only
 * un-approve an entry that still exists and still owns that id. Rows stranded
 * before the fixes above are only reachable this way.
 *
 * Costs one indexed lookup, and only when the list actually contains injected
 * rows; it writes nothing in the steady state, which is every call after the
 * first. Returns { entries, removed } with `entries` filtered in place of the
 * caller's list — the caller can hand it straight back to the client, so the
 * stale row is gone from the tab on the same load that cleaned it up.
 */
async function sweepInjectedTruckRows(sql, companyCode, entries) {
  const list = Array.isArray(entries) ? entries : [];
  const entryIds = [...new Set(
    list.map(r => (r && typeof r === 'object') ? entryIdFromTruckRowId(r.id) : null)
        .filter(id => id != null)
  )];
  if (!entryIds.length) return { entries: list, removed: [] };

  const rows = await sql`
    SELECT id, status, entry_type, division, job_id, split_destinations
      FROM timesheet_entries
     WHERE company_code = ${companyCode} AND id = ANY(${entryIds}::bigint[])
  `;
  const entriesById = new Map(rows.map(r => [Number(r.id), r]));

  // Which of these hauls the dust office bills off its own tracking grid. Asked
  // only for the dust entries in play, and skipped entirely when there are none
  // — which is every trucking-only tab load.
  //
  // Required lazily because dust-injected.js requires THIS module at load time
  // (for isEesJob, removeIcBillingEntries and the shared leg cap). At the top
  // this would close the cycle and hand that module an empty object; by the
  // time anything calls in here, both are fully loaded.
  const dustEntryIds = [...entriesById.values()]
    .filter(e => e && e.division === 'dust')
    .map(e => Number(e.id));
  let ubLegs = null;
  if (dustEntryIds.length) {
    const { dustBilledLegs } = require('./dust-injected');
    ubLegs = await dustBilledLegs(sql, companyCode, dustEntryIds);
  }

  const stale = findStaleTruckRows(list, entriesById, ubLegs);
  if (!stale.length) return { entries: list, removed: [] };

  const staleSet = new Set(stale);
  const remaining = list.filter(r => !(r && typeof r === 'object' && staleSet.has(String(r.id))));

  await deleteTruckBlobRows(sql, companyCode, stale);
  await sql`
    DELETE FROM truck_division_entries
     WHERE company_code = ${companyCode} AND id = ANY(${stale}::text[])
  `;
  // The billing entry has to go with the row, or the trucking page reads it as
  // a lost row and rebuilds exactly what we just swept.
  await removeIcBillingEntries(sql, companyCode, IC_SOURCE_TRUCKING, stale);

  console.warn(`[truck-injected] swept ${stale.length} orphaned injected row(s) for ${companyCode}: ${stale.join(', ')}`);
  return { entries: remaining, removed: stale };
}

module.exports = {
  TRUCK_DIVISION_BLOB,
  TRUCK_TAB_FIELDS,
  HAUL_FEE_OVERRIDE,
  HAUL_FEE_PAYROLL,
  HAUL_FEE_MAX,
  normalizeHaulFee,
  sameHaulFee,
  applyHaulFeeOverride,
  IC_BILLING_BLOB,
  IC_SOURCE_TRUCKING,
  EES_JOB_IDS,
  MAX_INJECTED_LEGS,
  isEesJob,
  needsTruckTrackingRow,
  splitSentTo,
  truckingRowIdPrefix,
  truckingRowId,
  entryIdFromTruckRowId,
  isInjectedTruckRowId,
  truckRowRecency,
  truckRowLegIndex,
  taskNumberSeq,
  formatTaskNumber,
  maxTaskNumber,
  numberInjectedRows,
  setTruckBlobTaskNumbers,
  backfillInjectedTaskNumbers,
  removeIcBillingEntries,
  deleteTruckBlobRows,
  findStaleTruckRows,
  sweepInjectedTruckRows,
};
