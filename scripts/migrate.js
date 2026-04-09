'use strict';

/**
 * scripts/migrate.js
 *
 * Applies the latest schema additions to your Neon database.
 * Safe to run repeatedly — every statement uses IF NOT EXISTS / IF NOT EXISTS.
 *
 * Usage:
 *   node scripts/migrate.js
 *
 * Requires DATABASE_URL in your environment (or a .env file in the project root).
 */

require('dotenv').config();
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function migrate() {
  console.log('Running migrations…');

  // ── trucking_entries ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS trucking_entries (
      id              TEXT PRIMARY KEY,
      company_code    TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
      tr_number       TEXT,
      driver          TEXT,
      truck_type      TEXT,
      project_id      TEXT,
      date            DATE,
      material_hauled TEXT,
      loads           NUMERIC(10,2),
      rate            NUMERIC(10,4),
      hours           NUMERIC(10,4),
      status          TEXT          NOT NULL DEFAULT 'pending',
      notes           TEXT,
      cost_code       TEXT,
      sub_code        TEXT,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `;
  console.log('  ✓ trucking_entries');

  await sql`CREATE INDEX IF NOT EXISTS idx_trucking_company ON trucking_entries(company_code)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_trucking_project ON trucking_entries(company_code, project_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_trucking_date    ON trucking_entries(company_code, date)`;
  console.log('  ✓ trucking_entries indexes');

  // ── scale_manual_entries ──────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS scale_manual_entries (
      id            TEXT PRIMARY KEY,
      company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
      label         TEXT,
      cost_code     TEXT,
      sub_code      TEXT,
      run_qty       NUMERIC(14,4),
      total_cost    NUMERIC(14,4),
      labor_hrs     NUMERIC(14,4),
      equip_hrs     NUMERIC(14,4),
      bid_qty       NUMERIC(14,4),
      bid_unit_cost NUMERIC(14,4),
      created_at    DATE
    )
  `;
  console.log('  ✓ scale_manual_entries');

  await sql`CREATE INDEX IF NOT EXISTS idx_scale_manual_company ON scale_manual_entries(company_code)`;
  console.log('  ✓ scale_manual_entries indexes');

  console.log('\nAll migrations applied successfully.');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
