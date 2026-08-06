'use strict';
/**
 * scripts/repair-orphaned-injected-rows.js
 *
 * Cleans up daily_tracking rows that payroll injected but that lost their link
 * back to the timesheet entry.
 *
 * How they happen: approving a timesheet entry inserts daily_tracking rows
 * tagged with timesheet_entry_id and a row_id of "ts<entryId>-<stamp>-<i>-<rand>".
 * Un-approving deletes them. A division tab that was already open still held
 * those rows in memory, and its next write — a Reload falling back to the
 * legacy blob, a project-recovery re-migration, or a queued PUT — re-created
 * them through POST / the PUT upsert. Neither path carries timesheet_entry_id,
 * so the row came back UNLINKED: no TS badge in cost tracking, fully editable,
 * invisible to the next un-approve, and double-counted if the entry was ever
 * approved again. api/daily-rows.js now refuses both writes; this script clears
 * up the rows that got through before that guard existed.
 *
 * For every unlinked row whose row_id says payroll minted it:
 *   - entry still exists and is 'approved'  → RELINK (set timesheet_entry_id):
 *     the labor is real, it just lost its badge/lock and its handle for a
 *     future un-approve.
 *   - entry is pending, or gone entirely    → DELETE: this is un-approved (or
 *     deleted) labor that should not be sitting in cost tracking at all.
 *
 * Rows that still carry their timesheet_entry_id are never touched.
 *
 * Usage:
 *   node scripts/repair-orphaned-injected-rows.js                 # dry run
 *   node scripts/repair-orphaned-injected-rows.js --apply         # make changes
 *   node scripts/repair-orphaned-injected-rows.js --company=FCT   # one company
 *
 * Requires DATABASE_URL in environment or a .env file in the project root.
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const apply     = process.argv.includes('--apply');
const companyArg = (process.argv.find(a => a.startsWith('--company=')) || '').split('=')[1] || null;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set.');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

// "ts<entryId>-…" — the id shape insertSplitRows mints. Manually added rows use
// numeric ids (Date.now() + Math.random()), so the prefix cannot collide.
function entryIdFromRowId(rowId) {
  const m = /^ts(\d+)-/.exec(String(rowId || ''));
  return m ? parseInt(m[1], 10) : null;
}

function fmtDate(v) {
  if (!v) return '—';
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

(async () => {
  console.log(apply ? 'Repairing orphaned injected rows…' : '[DRY RUN] Scanning for orphaned injected rows… (pass --apply to make changes)');

  const orphans = companyArg
    ? await sql`
        SELECT row_id, company_code, division, project_id, date, employee,
               cost_code, sub_code, labor_hours
        FROM daily_tracking
        WHERE timesheet_entry_id IS NULL AND row_id ~ '^ts[0-9]+-'
          AND company_code = ${companyArg}
        ORDER BY company_code, date, row_id
      `
    : await sql`
        SELECT row_id, company_code, division, project_id, date, employee,
               cost_code, sub_code, labor_hours
        FROM daily_tracking
        WHERE timesheet_entry_id IS NULL AND row_id ~ '^ts[0-9]+-'
        ORDER BY company_code, date, row_id
      `;

  if (!orphans.length) {
    console.log('Nothing to do — every payroll-injected row still carries its timesheet_entry_id.');
    return;
  }
  console.log(`Found ${orphans.length} unlinked row(s) with a payroll row_id.\n`);

  // Resolve every referenced entry in one read.
  const entryIds = [...new Set(orphans.map(r => entryIdFromRowId(r.row_id)).filter(id => id != null))];
  const entries  = entryIds.length
    ? await sql`SELECT id, company_code, status, username, work_date FROM timesheet_entries WHERE id = ANY(${entryIds})`
    : [];
  const byId = new Map(entries.map(e => [Number(e.id), e]));

  const toRelink = [];
  const toDelete = [];
  for (const row of orphans) {
    const entryId = entryIdFromRowId(row.row_id);
    const entry   = entryId != null ? byId.get(entryId) : null;
    // A row_id can only be trusted inside its own company — never relink across
    // one, and treat a cross-company id as a missing entry (delete).
    const sameCo  = entry && entry.company_code === row.company_code;
    if (sameCo && entry.status === 'approved') toRelink.push({ row, entryId, entry });
    else                                       toDelete.push({ row, entryId, entry: sameCo ? entry : null });
  }

  const label = r =>
    `${r.company_code}/${r.division} ${fmtDate(r.date)} ${r.employee || '—'} ` +
    `${r.cost_code || '—'}/${r.sub_code || '—'} ${Number(r.labor_hours) || 0}h  [${r.row_id}]`;

  if (toRelink.length) {
    console.log(`RELINK — ${toRelink.length} row(s) whose entry is still approved:`);
    toRelink.forEach(({ row, entryId }) => console.log(`  → entry #${entryId}  ${label(row)}`));
    console.log('');
  }
  if (toDelete.length) {
    console.log(`DELETE — ${toDelete.length} row(s) whose entry is pending or gone:`);
    toDelete.forEach(({ row, entryId, entry }) =>
      console.log(`  → entry #${entryId ?? '?'} (${entry ? entry.status : 'not found'})  ${label(row)}`));
    console.log('');
  }

  if (!apply) {
    console.log('[DRY RUN] No changes written. Re-run with --apply to relink and delete.');
    return;
  }

  let relinked = 0, deleted = 0;
  for (const { row, entryId } of toRelink) {
    await sql`
      UPDATE daily_tracking
      SET timesheet_entry_id = ${entryId}, updated_at = NOW()
      WHERE row_id = ${row.row_id} AND company_code = ${row.company_code}
        AND timesheet_entry_id IS NULL
    `;
    relinked++;
  }
  for (const { row } of toDelete) {
    await sql`
      DELETE FROM daily_tracking
      WHERE row_id = ${row.row_id} AND company_code = ${row.company_code}
        AND timesheet_entry_id IS NULL
    `;
    deleted++;
  }
  console.log(`Done — relinked ${relinked}, deleted ${deleted}.`);
})().catch(err => {
  console.error('FATAL', err.message);
  process.exit(1);
});
