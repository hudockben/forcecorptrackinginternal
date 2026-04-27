'use strict';
/**
 * scripts/recover-dust-rows.js
 *
 * Recovers deleted dust_control_entries rows using data stored in the
 * intercompany_billing_entries table (written when rows were sent to IC billing).
 *
 * For each IC billing entry where source='dust' whose source_id no longer exists
 * in dust_control_entries, this script re-inserts the row with all available data.
 *
 * Fields that cannot be recovered (not stored in IC billing):
 *   - state                 (will be empty — user can re-enter)
 *   - inv_sent, inv_received, cm_approval, inv_location
 *
 * Usage:
 *   node scripts/recover-dust-rows.js [--dry-run]
 *
 * Requires DATABASE_URL in environment or a .env file in the project root.
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const isDryRun = process.argv.includes('--dry-run');
const sql = neon(process.env.DATABASE_URL);

async function recover() {
  console.log(isDryRun ? '[DRY RUN] Scanning for recoverable rows…' : 'Recovering deleted dust rows…');

  // Find IC billing entries for dust that have no corresponding dust_control_entries row
  const recoverable = await sql`
    SELECT
      ib.company_code,
      ib.source_id         AS id,
      ib.company_name      AS company,
      ib.actual_date       AS date,
      ib.actual_start      AS start_time,
      ib.actual_end        AS end_time,
      ib.company_man,
      ib.location,
      ib.vehicle1, ib.v1_unit, ib.v1_rate,
      ib.vehicle2, ib.v2_unit, ib.v2_rate,
      ib.gallons_ub,
      ib.inv_number,
      ib.inv_status,
      ib.sent_at
    FROM intercompany_billing_entries ib
    WHERE ib.source = 'dust'
      AND ib.source_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM dust_control_entries dc
        WHERE dc.id = ib.source_id
      )
    ORDER BY ib.actual_date ASC
  `;

  if (recoverable.length === 0) {
    console.log('No recoverable rows found — nothing to restore.');
    return;
  }

  console.log(`Found ${recoverable.length} recoverable row(s):\n`);
  recoverable.forEach(r => {
    console.log(`  ${r.date}  ${r.company}  ${r.company_man || ''}  ${r.location || ''}  (id: ${r.id})`);
  });

  if (isDryRun) {
    console.log('\n[DRY RUN] No rows were written. Re-run without --dry-run to restore.');
    return;
  }

  let restored = 0;
  for (const r of recoverable) {
    try {
      await sql`
        INSERT INTO dust_control_entries (
          id, company_code,
          date, start_time, end_time,
          company, company_man, location,
          vehicle1, v1_unit, v1_rate,
          vehicle2, v2_unit, v2_rate,
          gallons_ub,
          inv_number, inv_status,
          updated_at
        ) VALUES (
          ${r.id}, ${r.company_code},
          ${r.date}, ${r.start_time || null}, ${r.end_time || null},
          ${r.company || null}, ${r.company_man || null}, ${r.location || null},
          ${r.vehicle1 || null}, ${r.v1_unit || null}, ${r.v1_rate ?? null},
          ${r.vehicle2 || null}, ${r.v2_unit || null}, ${r.v2_rate ?? null},
          ${r.gallons_ub ?? null},
          ${r.inv_number || null}, ${r.inv_status || null},
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;
      restored++;
      console.log(`  ✓ Restored: ${r.date}  ${r.company}  ${r.location || ''}`);
    } catch (err) {
      console.error(`  ✗ Failed for id ${r.id}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${restored} of ${recoverable.length} rows restored.`);
  console.log('Note: state was not stored in IC billing and will be blank — fill it in from the tracking table.');
}

recover().catch(err => {
  console.error('Recovery failed:', err.message);
  process.exit(1);
});
