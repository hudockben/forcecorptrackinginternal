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

  // ── dust_control_entries — cm_approval & inv_location columns ────────────
  await sql`ALTER TABLE dust_control_entries ADD COLUMN IF NOT EXISTS cm_approval  TEXT`;
  await sql`ALTER TABLE dust_control_entries ADD COLUMN IF NOT EXISTS inv_location TEXT`;
  console.log('  ✓ dust_control_entries cm_approval, inv_location');

  // ── employees.is_supervisor (for Timesheet supervisor dropdown) ──────────
  await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_supervisor BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`CREATE INDEX IF NOT EXISTS idx_employees_supervisor ON employees(company_code, is_supervisor) WHERE is_supervisor = TRUE`;
  console.log('  ✓ employees.is_supervisor');

  // ── timesheet_entries ─────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS timesheet_entries (
      id                  BIGSERIAL PRIMARY KEY,
      company_code        TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
      user_id             INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username            TEXT          NOT NULL,
      employee_id         INTEGER,
      entry_type          TEXT          NOT NULL CHECK (entry_type IN ('daily','time_off')),
      work_date           DATE          NOT NULL,
      status              TEXT          NOT NULL DEFAULT 'draft'
                                         CHECK (status IN ('draft','submitted','approved')),
      division            TEXT,
      job_id              TEXT,
      job_label           TEXT,
      start_time          TEXT,
      end_time            TEXT,
      computed_hours      NUMERIC(6,2),
      lunch_break         BOOLEAN,
      operated_equipment  BOOLEAN,
      supervisor_id       INTEGER,
      supervisor_name     TEXT,
      notes               TEXT,
      time_off_type       TEXT          CHECK (time_off_type IN ('vacation','sick','jury_duty','bereavement','holiday')),
      submitted_at        TIMESTAMPTZ,
      approved_at         TIMESTAMPTZ,
      approved_by_user_id INTEGER,
      approved_by_name    TEXT,
      created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ts_company_user_date ON timesheet_entries(company_code, user_id, work_date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ts_company_status    ON timesheet_entries(company_code, status, work_date DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ts_company_div_job   ON timesheet_entries(company_code, division, job_id)`;
  console.log('  ✓ timesheet_entries');

  // ── timesheet_audit_log ───────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS timesheet_audit_log (
      id            BIGSERIAL PRIMARY KEY,
      company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
      entry_id      BIGINT        NOT NULL,
      action        TEXT          NOT NULL CHECK (action IN ('INSERT','UPDATE','SUBMIT','APPROVE','ADMIN_EDIT','DELETE')),
      user_id       INTEGER,
      username      TEXT,
      changes       JSONB,
      snapshot      JSONB,
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_ts_audit_company ON timesheet_audit_log(company_code, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ts_audit_entry   ON timesheet_audit_log(entry_id, created_at DESC)`;
  console.log('  ✓ timesheet_audit_log');

  // ── daily_tracking: prefix lookup for payroll-injected rows ───────────────
  // Un-approve / resplit / delete sweep every row a timesheet entry injected —
  // both the ones still carrying timesheet_entry_id and any that lost it — by
  // matching the "ts<entryId>-" prefix their row_id always starts with.
  // text_pattern_ops is what makes LIKE 'ts42-%' index-backed under a non-C
  // collation; the plain idx_dt_row_id cannot serve it.
  await sql`CREATE INDEX IF NOT EXISTS idx_dt_row_id_prefix ON daily_tracking(row_id text_pattern_ops)`;
  console.log('  ✓ daily_tracking row_id prefix index');

  console.log('\nAll migrations applied successfully.');
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
