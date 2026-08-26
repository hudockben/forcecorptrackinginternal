-- ForceCorpTracking — Neon (PostgreSQL) Schema
-- Run this once against your Neon database to initialize tables.

-- ─────────────────────────────────────────────────
-- KEY-VALUE STORE
-- Mirrors the three localStorage keys the app uses:
--   fct_projects  — all projects (with embedded bid items & daily rows)
--   fct_lists     — dropdown lists
--   fct_cost_rows — cost-tracking rows
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_data (
    key        TEXT PRIMARY KEY,
    value      JSONB        NOT NULL DEFAULT 'null',
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the three keys so GET requests always find a row.
INSERT INTO app_data (key, value) VALUES
    ('fct_projects',  '[]'),
    ('fct_lists',     '{}'),
    ('fct_cost_rows', '[]')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────
-- NORMALIZED TABLES  (optional / future use)
-- These mirror schema.sql but in PostgreSQL syntax.
-- The app currently uses the app_data key-value table above.
-- These tables are here for reporting / analytics.
-- ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cost_items (
    id                      SERIAL PRIMARY KEY,
    cost_code               TEXT NOT NULL,
    sub_code                TEXT,
    quantity                NUMERIC(14,4) NOT NULL DEFAULT 0,
    running_quantities      NUMERIC(14,4) NOT NULL DEFAULT 0,
    bid_item_cost           NUMERIC(14,4) NOT NULL DEFAULT 0,
    running_item_cost       NUMERIC(14,4) NOT NULL DEFAULT 0,
    past_avg                NUMERIC(14,4),
    status                  TEXT NOT NULL DEFAULT 'Active'
                            CHECK (status IN ('Active','Complete','On Hold','At Risk')),
    cumulative_labor_hours  NUMERIC(14,4) NOT NULL DEFAULT 0,
    days_worked             INTEGER       NOT NULL DEFAULT 0,
    num_laborers            INTEGER       NOT NULL DEFAULT 0,
    equip_total_cost        NUMERIC(14,4) NOT NULL DEFAULT 0,
    equipment_hours         NUMERIC(14,4) NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_tracking (
    id               SERIAL PRIMARY KEY,
    date             DATE          NOT NULL,
    field_type       VARCHAR(255),
    employee         VARCHAR(255),
    cost_code        VARCHAR(255),
    sub_code         VARCHAR(255),
    job_class        VARCHAR(255),
    rate             NUMERIC(14,4) NOT NULL DEFAULT 0,
    labor_hours      NUMERIC(14,4) NOT NULL DEFAULT 0,
    equipment        VARCHAR(255),
    equip_unit_cost  NUMERIC(14,4) NOT NULL DEFAULT 0,
    equip_hours      NUMERIC(14,4) NOT NULL DEFAULT 0,
    material         TEXT,
    supplier         VARCHAR(255),
    po_num           VARCHAR(50),
    units_purchased  NUMERIC(14,4) NOT NULL DEFAULT 0,
    unit_cost        NUMERIC(14,4) NOT NULL DEFAULT 0,
    material_cost    NUMERIC(14,4) NOT NULL DEFAULT 0,
    quantity         NUMERIC(14,4) NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dropdown_lists (
    id           SERIAL PRIMARY KEY,
    company_code TEXT         NOT NULL,
    list_name    VARCHAR(50)  NOT NULL,
    value        VARCHAR(255) NOT NULL,
    sort_order   INTEGER      NOT NULL DEFAULT 0,
    UNIQUE (company_code, list_name, value)
);

CREATE TABLE IF NOT EXISTS equipment_list (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    unit_cost  NUMERIC(14,4) NOT NULL DEFAULT 0,
    sort_order INTEGER       NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────────
-- DAILY TRACKING — per-row columns added for
-- scalable storage (rows live here, not in JSON blobs)
-- Safe to run on an existing DB: all use IF NOT EXISTS / DEFAULT.
-- ─────────────────────────────────────────────────
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS row_id               TEXT UNIQUE;
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS project_id           TEXT NOT NULL DEFAULT '';
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS company_code         TEXT NOT NULL DEFAULT '';
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS equip_total_override NUMERIC(14,4);
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS total_cost_override  NUMERIC(14,4);
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS num_laborers         NUMERIC(14,4);

CREATE INDEX IF NOT EXISTS idx_dt_company_project ON daily_tracking(company_code, project_id);
CREATE INDEX IF NOT EXISTS idx_dt_row_id          ON daily_tracking(row_id);
-- Prefix lookup for "every row payroll injected from timesheet entry N", whose
-- row_ids all start "ts<N>-". Un-approve/resplit/delete sweep on that prefix as
-- well as on timesheet_entry_id, so a row that lost its link is still removed.
-- text_pattern_ops is what makes LIKE 'ts42-%' index-backed under a non-C
-- collation; the plain idx_dt_row_id above cannot serve it.
CREATE INDEX IF NOT EXISTS idx_dt_row_id_prefix   ON daily_tracking(row_id text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_dt_company_date    ON daily_tracking(company_code, date);
CREATE INDEX IF NOT EXISTS idx_dt_company_cc      ON daily_tracking(company_code, cost_code, sub_code);

CREATE TABLE IF NOT EXISTS company_board (
    id           SERIAL PRIMARY KEY,
    company_code TEXT          NOT NULL,
    message      TEXT          NOT NULL,
    author_user  TEXT          NOT NULL,
    author_name  TEXT          NOT NULL DEFAULT '',
    completed    BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_board_company ON company_board(company_code, created_at DESC);

CREATE TABLE IF NOT EXISTS deadlines (
    id            SERIAL PRIMARY KEY,
    company_code  TEXT          NOT NULL,
    message       TEXT          NOT NULL,
    deadline_date DATE,
    project_name  TEXT          NOT NULL DEFAULT '',
    author_user   TEXT          NOT NULL,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deadlines_company ON deadlines(company_code, deadline_date ASC);

-- ─────────────────────────────────────────────────
-- PROJECTS
-- One row per project per company.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
    id                TEXT PRIMARY KEY,         -- UUID from the app
    company_code      TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    job_number        TEXT,
    start_date        DATE,
    target_completion DATE,
    pinned            BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_company ON projects(company_code);

-- Projects table: add columns used by api/projects.js that were not in the
-- original CREATE TABLE.  All nullable or defaulted so existing rows survive.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status            TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_type     TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS client            TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS gc                TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pm                TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS superintendent    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS estimator         TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_contact    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS address           TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS city_state        TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_date          DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_days     TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_amount   TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS revised_amount    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS retention         TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS scope             TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS notes             TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sqft              TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prevailing_wage   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS assigned_employees JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS assigned_equipment JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sort_order        INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────
-- BID ITEMS
-- One row per bid line item, linked to a project.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bid_items (
    id           TEXT PRIMARY KEY,              -- UUID from the app
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    company_code TEXT NOT NULL,
    cost_code    TEXT NOT NULL,
    sub_code     TEXT,
    description  TEXT,
    quantity     NUMERIC(14,4) NOT NULL DEFAULT 0,
    unit         TEXT,
    unit_cost    NUMERIC(14,4) NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'Active'
                 CHECK (status IN ('Active','Complete','On Hold','At Risk')),
    target_date  DATE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE bid_items ADD COLUMN IF NOT EXISTS start_date    DATE;
ALTER TABLE bid_items ADD COLUMN IF NOT EXISTS is_complete   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bid_items ADD COLUMN IF NOT EXISTS change_orders JSONB   NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_bid_items_project    ON bid_items(project_id);
CREATE INDEX IF NOT EXISTS idx_bid_items_company_cc ON bid_items(company_code, cost_code, sub_code);

-- ─────────────────────────────────────────────────
-- EMPLOYEES
-- One row per employee per company, with rate info.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
    id           SERIAL PRIMARY KEY,
    company_code TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT          NOT NULL,
    job_class    TEXT,
    rate         NUMERIC(10,4),                 -- default/standard rate
    pw_rate      NUMERIC(10,4),                 -- prevailing wage rate
    non_pw_rate  NUMERIC(10,4),                 -- non-prevailing wage rate
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    active       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (company_code, name)
);

CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_code);

-- ─────────────────────────────────────────────────
-- EQUIPMENT LIST  (add company scoping)
-- ─────────────────────────────────────────────────
ALTER TABLE equipment_list ADD COLUMN IF NOT EXISTS company_code TEXT REFERENCES companies(code) ON DELETE CASCADE;
ALTER TABLE equipment_list ADD COLUMN IF NOT EXISTS active       BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE equipment_list ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE equipment_list ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Drop the old global unique constraint on name (if it exists from initial schema)
-- and replace with a per-company constraint so multiple companies can share equipment names.
ALTER TABLE equipment_list DROP CONSTRAINT IF EXISTS equipment_list_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_company_name ON equipment_list(company_code, name)
  WHERE company_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_equipment_company ON equipment_list(company_code);

-- ─────────────────────────────────────────────────
-- COST ITEMS  (add company + project scoping)
-- ─────────────────────────────────────────────────
ALTER TABLE cost_items ADD COLUMN IF NOT EXISTS company_code TEXT;
ALTER TABLE cost_items ADD COLUMN IF NOT EXISTS project_id   TEXT;
ALTER TABLE cost_items ADD COLUMN IF NOT EXISTS description  TEXT;

CREATE INDEX IF NOT EXISTS idx_cost_items_company_project ON cost_items(company_code, project_id);

-- ─────────────────────────────────────────────────
-- DROPDOWN LISTS  (add company scoping if upgrading
-- from old schema that lacked company_code)
-- ─────────────────────────────────────────────────
ALTER TABLE dropdown_lists ADD COLUMN IF NOT EXISTS company_code TEXT NOT NULL DEFAULT '';
ALTER TABLE dropdown_lists DROP CONSTRAINT IF EXISTS dropdown_lists_list_name_value_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dropdown_company_list_value ON dropdown_lists(company_code, list_name, value);
CREATE INDEX IF NOT EXISTS idx_dropdown_company ON dropdown_lists(company_code);

-- ─────────────────────────────────────────────────
-- SUPPLIERS
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
    id           SERIAL PRIMARY KEY,
    company_code TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT          NOT NULL,
    contact_name TEXT,
    phone        TEXT,
    email        TEXT,
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    active       BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (company_code, name)
);

CREATE INDEX IF NOT EXISTS idx_suppliers_company ON suppliers(company_code);

-- ─────────────────────────────────────────────────
-- PURCHASE ORDERS
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchase_orders (
    id           TEXT PRIMARY KEY,              -- UUID from the app
    company_code TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    project_id   TEXT,
    po_num       TEXT          NOT NULL,
    supplier     TEXT,
    material     TEXT,
    cost_code    TEXT,
    sub_code     TEXT,
    total_units  NUMERIC(14,4) NOT NULL DEFAULT 0,
    unit_cost    NUMERIC(14,4) NOT NULL DEFAULT 0,
    total_cost   NUMERIC(14,4) NOT NULL DEFAULT 0,
    status       TEXT          NOT NULL DEFAULT 'Open'
                 CHECK (status IN ('Open','Partial','Complete','Cancelled')),
    notes        TEXT,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_company         ON purchase_orders(company_code);
CREATE INDEX IF NOT EXISTS idx_po_company_project ON purchase_orders(company_code, project_id);
CREATE INDEX IF NOT EXISTS idx_po_num             ON purchase_orders(company_code, po_num);

-- ─────────────────────────────────────────────────
-- PO DELIVERIES
-- Tracks individual deliveries against a PO.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS po_deliveries (
    id              SERIAL PRIMARY KEY,
    po_id           TEXT          NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    company_code    TEXT          NOT NULL,
    delivery_date   DATE,
    units_delivered NUMERIC(14,4) NOT NULL DEFAULT 0,
    unit_cost       NUMERIC(14,4) NOT NULL DEFAULT 0,
    delivery_cost   NUMERIC(14,4) NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_deliveries_po      ON po_deliveries(po_id);
CREATE INDEX IF NOT EXISTS idx_po_deliveries_company ON po_deliveries(company_code);

-- ─────────────────────────────────────────────────
-- INVENTORY ITEMS
-- Tracks infill material and other inventory.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
    id           SERIAL PRIMARY KEY,
    company_code TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    project_id   TEXT,
    infill_type  TEXT          NOT NULL,
    location     TEXT,
    quantity     NUMERIC(14,4) NOT NULL DEFAULT 0,
    unit         TEXT,
    unit_cost    NUMERIC(14,4),
    notes        TEXT,
    date_added   DATE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_company ON inventory_items(company_code);
CREATE INDEX IF NOT EXISTS idx_inventory_project ON inventory_items(company_code, project_id);

-- ─────────────────────────────────────────────────
-- TRUCKING ENTRIES
-- One row per trucking entry from the Trucking tab.
-- Financial detail (hours, equip cost) also flows
-- through daily_tracking via tr_row_id.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trucking_entries (
    id              TEXT PRIMARY KEY,              -- UUID from the app
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
);

CREATE INDEX IF NOT EXISTS idx_trucking_company ON trucking_entries(company_code);
CREATE INDEX IF NOT EXISTS idx_trucking_project ON trucking_entries(company_code, project_id);
CREATE INDEX IF NOT EXISTS idx_trucking_date    ON trucking_entries(company_code, date);

-- ─────────────────────────────────────────────────
-- SCALE MANUAL ENTRIES
-- Snapshots sent from Cost Tracking to the
-- Scale of Economy analysis tab.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scale_manual_entries (
    id            TEXT PRIMARY KEY,               -- UUID from the app
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
);

CREATE INDEX IF NOT EXISTS idx_scale_manual_company ON scale_manual_entries(company_code);

-- ─────────────────────────────────────────────────
-- MIGRATION: add columns needed by REST endpoints
-- ─────────────────────────────────────────────────

-- po_deliveries: extra fields to store frontend line shape
ALTER TABLE po_deliveries ADD COLUMN IF NOT EXISTS line_id       TEXT;
ALTER TABLE po_deliveries ADD COLUMN IF NOT EXISTS invoice_num   TEXT;
ALTER TABLE po_deliveries ADD COLUMN IF NOT EXISTS tax           NUMERIC(14,4) NOT NULL DEFAULT 0;
ALTER TABLE po_deliveries ADD COLUMN IF NOT EXISTS employee      TEXT;
ALTER TABLE po_deliveries ADD COLUMN IF NOT EXISTS po_row_id     TEXT;

-- purchase_orders: frontend uses po_number, title, date_created, status audit
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_num            TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS title             TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS date_created      DATE;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS status_changed_by TEXT;
-- Drop the strict status check so any app status value is accepted
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
-- Division column so turf and paving POs are stored separately
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS division TEXT NOT NULL DEFAULT 'turf';
CREATE INDEX IF NOT EXISTS idx_po_company_division ON purchase_orders(company_code, division);

-- trucking_entries: add tr_row_id, status audit, and division columns
ALTER TABLE trucking_entries ADD COLUMN IF NOT EXISTS tr_row_id          TEXT;
ALTER TABLE trucking_entries ADD COLUMN IF NOT EXISTS status_changed_at  TIMESTAMPTZ;
ALTER TABLE trucking_entries ADD COLUMN IF NOT EXISTS status_changed_by  TEXT;
ALTER TABLE trucking_entries ADD COLUMN IF NOT EXISTS division           TEXT NOT NULL DEFAULT 'turf';
CREATE INDEX IF NOT EXISTS idx_trucking_division ON trucking_entries(company_code, division);

-- daily_tracking: add division column
ALTER TABLE daily_tracking ADD COLUMN IF NOT EXISTS division TEXT NOT NULL DEFAULT 'turf';
CREATE INDEX IF NOT EXISTS idx_dt_division ON daily_tracking(company_code, division);

-- company_board: add division column so each division has its own board
ALTER TABLE company_board ADD COLUMN IF NOT EXISTS division TEXT NOT NULL DEFAULT 'turf';
CREATE INDEX IF NOT EXISTS idx_board_division ON company_board(company_code, division, created_at DESC);

-- deadlines: add division column so each division has its own deadlines
ALTER TABLE deadlines ADD COLUMN IF NOT EXISTS division TEXT NOT NULL DEFAULT 'turf';
CREATE INDEX IF NOT EXISTS idx_deadlines_division ON deadlines(company_code, division, deadline_date ASC);

-- ─────────────────────────────────────────────────
-- DIVISION VALUE GUARD
-- A CHECK constraint on every division-aware table so a typo or stray
-- value can never insert orphan rows that bypass the division allowlist.
-- The DEFAULT 'turf' is intentionally kept for backward compatibility
-- with tracker.html (turf), which omits ?division= in some legacy paths.
-- New code (paving/kiewit/dust/trucking/intercompany) MUST pass division explicitly.
-- DROP-then-ADD is idempotent and safe to re-run on every deploy.
-- ─────────────────────────────────────────────────
ALTER TABLE purchase_orders   DROP CONSTRAINT IF EXISTS purchase_orders_division_chk;
ALTER TABLE purchase_orders   ADD  CONSTRAINT purchase_orders_division_chk   CHECK (division IN ('turf','dust','paving','kiewit','trucking','intercompany'));

ALTER TABLE trucking_entries  DROP CONSTRAINT IF EXISTS trucking_entries_division_chk;
ALTER TABLE trucking_entries  ADD  CONSTRAINT trucking_entries_division_chk  CHECK (division IN ('turf','dust','paving','kiewit','trucking','intercompany'));

ALTER TABLE daily_tracking    DROP CONSTRAINT IF EXISTS daily_tracking_division_chk;
ALTER TABLE daily_tracking    ADD  CONSTRAINT daily_tracking_division_chk    CHECK (division IN ('turf','dust','paving','kiewit','trucking','intercompany'));

ALTER TABLE company_board     DROP CONSTRAINT IF EXISTS company_board_division_chk;
ALTER TABLE company_board     ADD  CONSTRAINT company_board_division_chk     CHECK (division IN ('turf','dust','paving','kiewit','trucking','intercompany'));

ALTER TABLE deadlines         DROP CONSTRAINT IF EXISTS deadlines_division_chk;
ALTER TABLE deadlines         ADD  CONSTRAINT deadlines_division_chk         CHECK (division IN ('turf','dust','paving','kiewit','trucking','intercompany'));

-- ─────────────────────────────────────────────────
-- DUST CONTROL ENTRIES
-- One row per job entry from the Dust Control tab.
-- Computed fields (v1Total, ubTotal, invTotal) are
-- derived from stored values + ub_rate setting; they
-- are NOT stored here to avoid drift.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dust_control_entries (
    id              TEXT PRIMARY KEY,              -- app-generated uid
    company_code    TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    date            DATE,
    start_time      TEXT,                          -- "HH:MM" string
    end_time        TEXT,                          -- "HH:MM" string
    company         TEXT,
    company_man     TEXT,
    location        TEXT,
    state           TEXT,
    vehicle1        TEXT,
    v1_unit         TEXT,
    v1_rate         NUMERIC(10,4),
    vehicle2        TEXT,
    v2_unit         TEXT,
    v2_rate         NUMERIC(10,4),
    gallons_ub      NUMERIC(10,4),
    inv_number      TEXT,
    inv_sent        DATE,
    inv_received    DATE,
    inv_status      TEXT,
    cm_approval     TEXT,
    inv_location    TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dust_company      ON dust_control_entries(company_code);
CREATE INDEX IF NOT EXISTS idx_dust_company_date ON dust_control_entries(company_code, date);
CREATE INDEX IF NOT EXISTS idx_dust_company_co   ON dust_control_entries(company_code, company);

ALTER TABLE dust_control_entries ADD COLUMN IF NOT EXISTS cm_approval  TEXT;
ALTER TABLE dust_control_entries ADD COLUMN IF NOT EXISTS inv_location TEXT;

-- ─────────────────────────────────────────────────
-- DUST CONTROL AUDIT LOG
-- One row per INSERT / UPDATE / DELETE on dust_control_entries.
-- Populated by the /api/dust-rows PUT handler by diffing the
-- incoming list against current DB state.
--
-- The `source` column distinguishes which dust tab produced the
-- entry: 'tracking'      = Dust Control Tracking grid
--        'other-billing' = Other Billing grid
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dust_control_audit_log (
    id            BIGSERIAL PRIMARY KEY,
    company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    row_id        TEXT          NOT NULL,
    action        TEXT          NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
    user_id       INTEGER,
    username      TEXT,
    changes       JSONB,
    snapshot      JSONB,
    source        TEXT          NOT NULL DEFAULT 'tracking',
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Idempotent migration: must run BEFORE the source-aware index so existing
-- audit tables (created before the column existed) get the column first.
ALTER TABLE dust_control_audit_log ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tracking';

CREATE INDEX IF NOT EXISTS idx_dust_audit_company    ON dust_control_audit_log(company_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dust_audit_row        ON dust_control_audit_log(row_id);
CREATE INDEX IF NOT EXISTS idx_dust_audit_company_at ON dust_control_audit_log(company_code, created_at);
CREATE INDEX IF NOT EXISTS idx_dust_audit_company_src ON dust_control_audit_log(company_code, source, created_at DESC);

-- ─────────────────────────────────────────────────
-- TRUCK DIVISION ENTRIES
-- One row per job entry from the Trucking Division tab.
-- Replaces fct_truck_division JSON blob.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS truck_division_entries (
    id                TEXT PRIMARY KEY,
    company_code      TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    task_number       TEXT,
    actual_date       DATE,
    driver            TEXT,
    unit              TEXT,
    actual_start      TEXT,                          -- HH:MM string
    actual_end        TEXT,                          -- HH:MM string
    total_hours       NUMERIC(10,4),
    haul_fee          NUMERIC(10,4),
    customer          TEXT,
    description       TEXT,
    division          TEXT,
    notes             TEXT,
    -- Invoice sub-row fields
    qb_invoice        TEXT,
    invoiced_date     DATE,
    invoice_sent_date DATE,
    invoice_status    TEXT          NOT NULL DEFAULT 'Unpaid',
    date_paid         DATE,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tde_company      ON truck_division_entries(company_code);
CREATE INDEX IF NOT EXISTS idx_tde_company_date ON truck_division_entries(company_code, actual_date);
CREATE INDEX IF NOT EXISTS idx_tde_driver       ON truck_division_entries(company_code, driver);
CREATE INDEX IF NOT EXISTS idx_tde_customer     ON truck_division_entries(company_code, customer);

-- ─────────────────────────────────────────────────
-- TRUCK DIVISION UNITS
-- Truck unit roster per company (name + unit number).
-- Drivers/customers stored in dropdown_lists with
-- list_name = 'truck_drivers' / 'truck_customers'.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS truck_division_units (
    id           SERIAL PRIMARY KEY,
    company_code TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT          NOT NULL,
    number       TEXT,
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    UNIQUE (company_code, name)
);

CREATE INDEX IF NOT EXISTS idx_tdu_company ON truck_division_units(company_code);

-- ─────────────────────────────────────────────────
-- DUST CONTROL CONFIG
-- Replaces dust_settings and dust_lists JSON blobs.
-- ─────────────────────────────────────────────────

-- Per-company settings (ub_rate, etc.)
CREATE TABLE IF NOT EXISTS dust_settings (
    company_code TEXT PRIMARY KEY REFERENCES companies(code) ON DELETE CASCADE,
    ub_rate      NUMERIC(10,4) NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Vehicle/equipment roster
CREATE TABLE IF NOT EXISTS dust_equipment (
    id            TEXT PRIMARY KEY,              -- app-generated uid
    company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name          TEXT          NOT NULL,
    unit_number   TEXT,
    vehicle_rate  NUMERIC(10,4),
    sort_order    INTEGER       NOT NULL DEFAULT 0,
    UNIQUE (company_code, name)
);

CREATE INDEX IF NOT EXISTS idx_dust_equip_company ON dust_equipment(company_code);

-- Customer companies
CREATE TABLE IF NOT EXISTS dust_companies (
    id            TEXT PRIMARY KEY,              -- app-generated uid
    company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name          TEXT          NOT NULL,
    tier          TEXT          NOT NULL DEFAULT '',
    v1_rate       NUMERIC(10,4),                 -- default Vehicle 1 rate for this customer
    v2_rate       NUMERIC(10,4),                 -- default Vehicle 2 rate for this customer
    ub_rate       NUMERIC(10,4),                 -- per-customer UB $/gal override (NULL = use dust_settings.ub_rate)
    sort_order    INTEGER       NOT NULL DEFAULT 0,
    UNIQUE (company_code, name)
);

ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS v1_rate NUMERIC(10,4);
ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS v2_rate NUMERIC(10,4);
ALTER TABLE dust_companies ADD COLUMN IF NOT EXISTS ub_rate NUMERIC(10,4);

CREATE INDEX IF NOT EXISTS idx_dust_co_company ON dust_companies(company_code);

-- Locations per customer company
CREATE TABLE IF NOT EXISTS dust_company_locations (
    id              TEXT PRIMARY KEY,            -- app-generated uid
    dust_company_id TEXT          NOT NULL REFERENCES dust_companies(id) ON DELETE CASCADE,
    name            TEXT          NOT NULL,
    state           TEXT,
    sort_order      INTEGER       NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dust_loc_company ON dust_company_locations(dust_company_id);

-- Personnel (company men) per customer company
CREATE TABLE IF NOT EXISTS dust_company_personnel (
    id              TEXT PRIMARY KEY,            -- app-generated uid
    dust_company_id TEXT          NOT NULL REFERENCES dust_companies(id) ON DELETE CASCADE,
    name            TEXT          NOT NULL,
    sort_order      INTEGER       NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dust_pers_company ON dust_company_personnel(dust_company_id);

-- Employees, materials, states, and MU options stored in dropdown_lists:
--   list_name = 'dust_employees'  (strings)
--   list_name = 'dust_materials'  (strings)
--   list_name = 'dust_states'     (strings)
--   list_name = 'dust_mu'         (strings) — Other Billing "MU" dropdown

-- ─────────────────────────────────────────────────
-- INTERCOMPANY BILLING
-- Mirrors fct_intercompany_companies and
-- fct_intercompany_billing_entries JSON blobs.
-- ─────────────────────────────────────────────────

-- Companies eligible for intercompany billing
CREATE TABLE IF NOT EXISTS intercompany_companies (
    id            TEXT PRIMARY KEY,              -- app-generated uid
    company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name          TEXT          NOT NULL,
    divisions     TEXT[]        NOT NULL DEFAULT '{}',
    notes         TEXT,
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    UNIQUE (company_code, name)
);

CREATE INDEX IF NOT EXISTS idx_ic_co_company ON intercompany_companies(company_code);

-- Billing entries sent from trucking or dust control to an intercompany company
CREATE TABLE IF NOT EXISTS intercompany_billing_entries (
    id                TEXT PRIMARY KEY,          -- app-generated uid
    company_code      TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    source            TEXT          NOT NULL,    -- 'trucking' | 'dust'
    source_id         TEXT          NOT NULL,    -- id of the originating entry
    company_id        TEXT,                      -- references intercompany_companies.id
    company_name      TEXT,
    actual_date       DATE,
    total_hours       NUMERIC(10,4),
    total             NUMERIC(10,4),             -- invoice total billed to customer
    sent_at           TIMESTAMPTZ,
    sent_by           TEXT,
    -- Trucking-specific fields
    task_number       TEXT,
    driver            TEXT,
    unit              TEXT,
    actual_start      TEXT,
    actual_end        TEXT,
    haul_fee          NUMERIC(10,4),
    customer          TEXT,
    description       TEXT,
    division          TEXT,
    notes             TEXT,
    qb_invoice        TEXT,
    invoiced_date     DATE,
    invoice_sent_date DATE,
    invoice_status    TEXT,
    date_paid         DATE,
    -- Dust-specific fields
    location          TEXT,
    company_man       TEXT,
    vehicle1          TEXT,
    v1_unit           TEXT,
    v1_rate           NUMERIC(10,4),
    v1_total          NUMERIC(10,4),
    vehicle2          TEXT,
    v2_unit           TEXT,
    v2_rate           NUMERIC(10,4),
    v2_total          NUMERIC(10,4),
    gallons_ub        NUMERIC(10,4),
    ub_total          NUMERIC(10,4),
    inv_number        TEXT,
    inv_status        TEXT,
    -- Dust "Other Billing" fields (source = 'dust-other-billing'). That grid
    -- bills material + trucking per load rather than by vehicle-hours, so it
    -- shares only total / driver / inv_number with the tracking shape above.
    truck_number      TEXT,
    trailer_number    TEXT,
    destination       TEXT,
    state             TEXT,
    material          TEXT,
    gallons_bags      NUMERIC(10,4),
    price_per_unit    NUMERIC(10,4),
    material_total    NUMERIC(10,4),
    trucking_hrs      NUMERIC(10,4),
    trucking_rate     NUMERIC(10,4),
    trucking_total    NUMERIC(10,4),
    comments          TEXT,
    -- Dust "EES Other" fields (source = 'dust-ees-other'). Hours × rate rather
    -- than material, so it adds a rate plus the job's own identifiers.
    -- ees_name rather than name: the entry's "Name" column is a job-side label
    -- and must not be confused with company_name above.
    rate              NUMERIC(10,4),
    ees_name          TEXT,
    job_number        TEXT,
    billing           TEXT,
    updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ic_be_company      ON intercompany_billing_entries(company_code);
CREATE INDEX IF NOT EXISTS idx_ic_be_company_date ON intercompany_billing_entries(company_code, actual_date);
CREATE INDEX IF NOT EXISTS idx_ic_be_source       ON intercompany_billing_entries(company_code, source);
CREATE INDEX IF NOT EXISTS idx_ic_be_ic_company   ON intercompany_billing_entries(company_code, company_id);

-- ─────────────────────────────────────────────────
-- QUARRY DIVISION
-- Mirrors fct_quarry_daily, fct_quarry_crushing,
-- fct_quarry_sales, and fct_quarry_lists JSON blobs.
-- Computed totals are stored on each row (computed
-- in the sync layer) so SQL reports don't need to
-- redo the math. The JSON blob in app_data remains
-- the write path; these tables shadow it for reporting.
-- ─────────────────────────────────────────────────

-- Lists: locations, products, customers, employees, equipment, tasks
CREATE TABLE IF NOT EXISTS quarry_locations (
    id           TEXT NOT NULL,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_quarry_loc_company ON quarry_locations(company_code);

CREATE TABLE IF NOT EXISTS quarry_products (
    id           TEXT NOT NULL,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_quarry_prod_company ON quarry_products(company_code);

CREATE TABLE IF NOT EXISTS quarry_customers (
    id           TEXT NOT NULL,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_quarry_cust_company ON quarry_customers(company_code);

CREATE TABLE IF NOT EXISTS quarry_employees (
    id           TEXT NOT NULL,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    rate         NUMERIC(10,4),
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_quarry_emp_company ON quarry_employees(company_code);

CREATE TABLE IF NOT EXISTS quarry_equipment (
    id           TEXT NOT NULL,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_quarry_equip_company ON quarry_equipment(company_code);

CREATE TABLE IF NOT EXISTS quarry_tasks (
    id           TEXT NOT NULL,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    sort_order   INTEGER       NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_quarry_task_company ON quarry_tasks(company_code);

-- Daily Tracking
CREATE TABLE IF NOT EXISTS quarry_daily_entries (
    id              TEXT NOT NULL,
    company_code    TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    date            DATE,
    location_id     TEXT,
    location_name   TEXT,
    employee_id     TEXT,
    employee_name   TEXT,
    equipment_id    TEXT,
    equipment_name  TEXT,
    task_id         TEXT,
    task_name       TEXT,
    hours           NUMERIC(14,4),
    rate            NUMERIC(14,4),
    fuel_gallons    NUMERIC(14,4),
    ppg             NUMERIC(14,4),
    labor_cost      NUMERIC(14,4),
    fuel_cost       NUMERIC(14,4),
    total_cost      NUMERIC(14,4),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_qd_company_date ON quarry_daily_entries(company_code, date);
CREATE INDEX IF NOT EXISTS idx_qd_company_loc  ON quarry_daily_entries(company_code, location_name);

-- Crushing Tracking
CREATE TABLE IF NOT EXISTS quarry_crushing_entries (
    id                 TEXT NOT NULL,
    company_code       TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    date               DATE,
    location_id        TEXT,
    location_name      TEXT,
    employee_id        TEXT,
    employee_name      TEXT,
    hourly_rate        NUMERIC(14,4),
    hours              NUMERIC(14,4),
    hours_crushing     NUMERIC(14,4),
    fuel_gallons       NUMERIC(14,4),
    fuel_cost          NUMERIC(14,4),
    loads_to_crusher   NUMERIC(14,4),
    tons_per_load      NUMERIC(14,4),
    comments           TEXT,
    total_payroll      NUMERIC(14,4),
    total_fuel         NUMERIC(14,4),
    estimated_tons     NUMERIC(14,4),
    tons_per_hour      NUMERIC(14,4),
    total_cost         NUMERIC(14,4),
    cost_per_ton       NUMERIC(14,4),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_qc_company_date ON quarry_crushing_entries(company_code, date);
CREATE INDEX IF NOT EXISTS idx_qc_company_loc  ON quarry_crushing_entries(company_code, location_name);

-- Sales Tracking
CREATE TABLE IF NOT EXISTS quarry_sales_entries (
    id              TEXT NOT NULL,
    company_code    TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    date            DATE,
    location_id     TEXT,
    location_name   TEXT,
    employee_id     TEXT,
    employee_name   TEXT,
    customer_id     TEXT,
    customer_name   TEXT,
    product_id      TEXT,
    product_name    TEXT,
    tons            NUMERIC(14,4),
    price_per_ton   NUMERIC(14,4),
    payment         TEXT,
    total           NUMERIC(14,4),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_qs_company_date     ON quarry_sales_entries(company_code, date);
CREATE INDEX IF NOT EXISTS idx_qs_company_customer ON quarry_sales_entries(company_code, customer_name);
CREATE INDEX IF NOT EXISTS idx_qs_company_product  ON quarry_sales_entries(company_code, product_name);

-- ─────────────────────────────────────────────────
-- EMPLOYEES — is_supervisor flag for Timesheet supervisor dropdown
-- ─────────────────────────────────────────────────
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_supervisor BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_employees_supervisor ON employees(company_code, is_supervisor)
  WHERE is_supervisor = TRUE;

-- ─────────────────────────────────────────────────
-- TIMESHEET ENTRIES
-- Field-employee time entries. Two row shapes share one table,
-- discriminated by entry_type:
--   'daily'    → day-of-work entry: division, job, start/end time, etc.
--   'time_off' → vacation/sick/etc., with time_off_type + date only.
--
-- Field users (divisionRoles.timesheet) own the create/edit path for
-- their own rows up through 'submitted'. Once submitted, only payroll
-- admins (divisionRoles.payroll) may edit or approve. This data is
-- INTENTIONALLY separate from daily_tracking.labor_hours and
-- dust_control_entries — payroll consumes timesheet_entries only.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS timesheet_entries (
    id                  BIGSERIAL PRIMARY KEY,
    company_code        TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    user_id             INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username            TEXT          NOT NULL,
    employee_id         INTEGER,                  -- optional FK to employees (filled in later)
    entry_type          TEXT          NOT NULL CHECK (entry_type IN ('daily','time_off')),
    work_date           DATE          NOT NULL,
    status              TEXT          NOT NULL DEFAULT 'draft'
                                       CHECK (status IN ('draft','submitted','approved')),

    -- Daily fields (nullable for time_off)
    division            TEXT,                     -- 'turf' | 'dust' | 'paving' | 'trucking' | 'quarry'
    job_id              TEXT,                     -- division-specific ID
    job_label           TEXT,                     -- denormalized at submit time so it never breaks
    start_time          TEXT,                     -- "HH:MM"
    end_time            TEXT,                     -- "HH:MM"
    computed_hours      NUMERIC(6,2),             -- server-computed from start_time/end_time
    travel_to_site_hours NUMERIC(6,2),            -- decimal hours spent driving to the job
    travel_to_shop_hours NUMERIC(6,2),            -- decimal hours spent driving back to the shop
    travel_hours        NUMERIC(6,2),             -- server-computed = travel_to_site_hours + travel_to_shop_hours
    lunch_break         BOOLEAN,
    operated_equipment  BOOLEAN,
    supervisor_id       INTEGER,                  -- references employees.id
    supervisor_name     TEXT,                     -- denormalized
    notes               TEXT,

    -- Time off fields (nullable for daily)
    time_off_type       TEXT          CHECK (time_off_type IN ('vacation','sick','jury_duty','bereavement','holiday')),

    -- Workflow audit
    submitted_at        TIMESTAMPTZ,
    approved_at         TIMESTAMPTZ,
    approved_by_user_id INTEGER,
    approved_by_name    TEXT,

    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ts_company_user_date ON timesheet_entries(company_code, user_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_ts_company_status    ON timesheet_entries(company_code, status, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_ts_company_div_job   ON timesheet_entries(company_code, division, job_id);

-- Travel-time columns (added after initial release). Idempotent so existing
-- deployments pick them up the next time run-schema executes.
--
-- Travel time is captured as two decimal-hour legs (to-site + to-shop) rather
-- than clock-time spans — that's how the field crew reports it ("2 hours to
-- the site, 2 hours back"). The earlier travel_start_time / travel_end_time
-- columns are dropped because no production data was ever written to them.
ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS travel_start_time;
ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS travel_end_time;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS travel_to_site_hours NUMERIC(6,2);
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS travel_to_shop_hours NUMERIC(6,2);
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS travel_hours         NUMERIC(6,2);

-- Haul daily fields (added after initial release). Captured on the timesheet
-- for the entries whose approval CAN post a Truck Tracking row — division
-- 'trucking', and division 'dust' on a customer job (not the EES activities,
-- which have their own columns below) — and carried into the matching Truck
-- Tracking columns (unit + description) on payroll approval. See
-- needsTruckTrackingRow in api/lib/truck-injected.js, which is the one place
-- that rule lives.
--
-- Asked at the entry level on purpose, even though a dust day is now routed per
-- HAUL: only the hauls billed off Other Billing reach Truck Tracking, and which
-- of the dust office's two grids a haul bills off is answered by the approving
-- supervisor, long after the driver has filled this in. The unit is wanted
-- either way — it also seeds each haul's Vehicle 1 on the dust grid.
-- Idempotent so existing deployments pick them up the next time run-schema
-- executes.
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS truck_unit        TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS truck_description TEXT;

-- EES-only daily fields. Captured on the timesheet only when the division is
-- 'dust' AND the job is one of the two standing EES activities (job_id
-- 'ees:preloading' / 'ees:washing' — see api/timesheet-jobs.js), and carried
-- straight into the Dust division's "EES Other" tab on payroll approval. The
-- tab displays these verbatim, so the timesheet is their only source of truth.
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS ees_unit       TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS ees_customer   TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS ees_location   TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS ees_name       TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS ees_job_number TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS ees_billing    TEXT;

-- Split-day tagging. A field worker who spends one day on two jobs submits ONE
-- form on timesheet.html and the page posts one row per job — same date,
-- supervisor and notes, each with its own job, clock and equipment answer — so
-- payroll reviews and approves them exactly as if they had been submitted
-- separately. These three columns are the only thing tying them back together:
-- a shared group id (minted client-side, one per submission) plus this row's
-- 1-based position and the size of the group, which is what lets both
-- timesheet.html and payroll.html show a "Split 1/2" marker.
--
-- Nothing downstream branches on them: approval, injection, editing and
-- deletion all treat a split row as an ordinary entry. NULL group id = not a
-- split, which is every entry submitted before this existed.
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS split_group_id TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS split_index    SMALLINT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS split_count    SMALLINT;

CREATE INDEX IF NOT EXISTS idx_ts_split_group ON timesheet_entries(company_code, split_group_id);

-- ─────────────────────────────────────────────────
-- TIMESHEET → DAILY TRACKING bridge
-- daily_tracking.timesheet_entry_id links a cost-tracking row back to the
-- payroll approval that produced it. NULL = manually entered in the
-- division cost tab (legacy path, fully editable). NOT NULL = auto-injected
-- on payroll approval and managed exclusively from payroll.html.
-- ON DELETE SET NULL keeps the historical cost row if a timesheet entry is
-- later deleted; the row becomes a manual row at that point.
-- Defined AFTER the timesheet_entries CREATE TABLE so a fresh-DB run-schema
-- has a target for the FK.
-- ─────────────────────────────────────────────────
ALTER TABLE daily_tracking
  ADD COLUMN IF NOT EXISTS timesheet_entry_id BIGINT
    REFERENCES timesheet_entries(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_dt_ts_entry
  ON daily_tracking(timesheet_entry_id)
  WHERE timesheet_entry_id IS NOT NULL;

-- ─────────────────────────────────────────────────
-- TIMESHEET AUDIT LOG
-- One row per state-changing action on timesheet_entries.
-- ─────────────────────────────────────────────────
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
);

CREATE INDEX IF NOT EXISTS idx_ts_audit_company    ON timesheet_audit_log(company_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ts_audit_entry      ON timesheet_audit_log(entry_id, created_at DESC);

-- ─────────────────────────────────────────────────
-- FUEL SUBMISSIONS
-- One row per fill-up, reported from the field on fuel.html and reviewed
-- in Fuel Admin (fuel-admin.html). Same two-sided shape as
-- timesheet_entries → payroll: users holding divisionRoles.fuel own the
-- create/edit path for their own rows up through 'submitted', and from
-- there only divisionRoles.fuel_admin may edit or approve.
--
-- Every reported field is nullable except work_date. That is deliberate:
-- the FORM requires all thirteen, and the API enforces all thirteen at
-- SUBMIT, but a draft is explicitly a half-finished thing — a worker who
-- walks away mid-entry should keep what they typed rather than be refused
-- by a NOT NULL. Nothing incomplete can reach Fuel Admin, because nothing
-- reaches Fuel Admin without passing through submit.
--
-- The two meter readings are the exception worth naming: 0 is a REAL
-- answer there ("0 if not Force Fuel"), not an empty one, so nothing in
-- this system may treat 0 as missing.
--
-- gallons is DERIVED whenever the meters describe a fill (ending above
-- beginning) — on a Force Fuel tank the meter is the gallons counter, so
-- the difference is the fill and the API recomputes it on every write.
-- It stays a reported value for a card purchase (meters at 0) and for a
-- rolled-over meter, where the difference means nothing. Stored rather
-- than computed on read so a later correction to a meter reading cannot
-- silently restate what an already-approved row was approved for.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_submissions (
    id                  BIGSERIAL PRIMARY KEY,
    company_code        TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    user_id             INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username            TEXT          NOT NULL,
    status              TEXT          NOT NULL DEFAULT 'draft'
                                       CHECK (status IN ('draft','submitted','approved')),

    -- Where this fill-up has got to in the SECOND review. status is the
    -- approval workflow — draft, submitted, approved — run daily by the
    -- manager checking what the field sent. balance_status is a separate
    -- axis, run monthly by whoever reconciles against the fuel accounts:
    -- every approved fill-up starts 'pending' and becomes 'balanced' when it
    -- has been accounted for on a statement, or 'issue' when it hasn't.
    --
    -- Deliberately NOT a fourth value of status. A fill-up is approved OR
    -- not, and separately balanced OR not; folding them into one column
    -- would make "approved but not yet balanced" unsayable, which is the
    -- state most of a month sits in.
    balance_status      TEXT          NOT NULL DEFAULT 'pending',
    balance_note        TEXT,
    balanced_at         TIMESTAMPTZ,
    balanced_by_user_id INTEGER,
    balanced_by_name    TEXT,

    work_date           DATE          NOT NULL,
    employee_username   TEXT,
    fuel_card           TEXT,
    fuel_type           TEXT,
    gallons             NUMERIC(10,2),
    mileage             NUMERIC(12,1),
    truck_number        INTEGER,
    beginning_meter     NUMERIC(12,1),
    ending_meter        NUMERIC(12,1),
    fueling_site        TEXT,
    city_fueled         TEXT,
    state               TEXT,
    tank_number         INTEGER,

    submitted_at        TIMESTAMPTZ,
    approved_at         TIMESTAMPTZ,
    approved_by_user_id INTEGER,
    approved_by_name    TEXT,

    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fuel_company_user_date ON fuel_submissions(company_code, user_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_company_status    ON fuel_submissions(company_code, status, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_company_employee  ON fuel_submissions(company_code, employee_username, work_date DESC);

-- Balancing columns (added after initial release). Idempotent so existing
-- deployments pick them up the next time run-schema executes. Every fill-up
-- already in the table becomes 'pending', which is the truthful answer for
-- work that predates anyone balancing it.
--
-- The CHECK is added by name rather than inline on the column above so that
-- the drop-then-add pair below stays idempotent — an inline check would be
-- auto-named and this would leave a second, identical constraint beside it.
ALTER TABLE fuel_submissions ADD COLUMN IF NOT EXISTS balance_status      TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE fuel_submissions ADD COLUMN IF NOT EXISTS balance_note        TEXT;
ALTER TABLE fuel_submissions ADD COLUMN IF NOT EXISTS balanced_at         TIMESTAMPTZ;
ALTER TABLE fuel_submissions ADD COLUMN IF NOT EXISTS balanced_by_user_id INTEGER;
ALTER TABLE fuel_submissions ADD COLUMN IF NOT EXISTS balanced_by_name    TEXT;

ALTER TABLE fuel_submissions DROP CONSTRAINT IF EXISTS fuel_balance_status_check;
ALTER TABLE fuel_submissions ADD  CONSTRAINT fuel_balance_status_check
  CHECK (balance_status IN ('pending','balanced','issue'));

CREATE INDEX IF NOT EXISTS idx_fuel_company_balance
  ON fuel_submissions(company_code, balance_status, work_date DESC);

-- Which import run put this row here. NULL for everything the field crew
-- typed in, which is the normal case and stays the normal case — this exists
-- for backfill: a month already recorded in a spreadsheet before the form
-- existed, loaded in one go rather than re-keyed a fill-up at a time.
--
-- Stamped so an import is UNDOABLE. Without it, discovering the wrong file
-- was loaded means finding two hundred rows by hand among the ones the field
-- really did send, and telling them apart by eye afterwards is exactly the
-- kind of judgement nobody should have to make about fuel records.
ALTER TABLE fuel_submissions ADD COLUMN IF NOT EXISTS import_batch TEXT;

CREATE INDEX IF NOT EXISTS idx_fuel_company_import
  ON fuel_submissions(company_code, import_batch) WHERE import_batch IS NOT NULL;

-- ─────────────────────────────────────────────────
-- FUEL AUDIT LOG
-- One row per state-changing action on fuel_submissions. Same shape and
-- same purpose as timesheet_audit_log: what changed, who changed it, and
-- the full post-change snapshot, so an approved fill-up can always be
-- traced back to what the field originally reported.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_audit_log (
    id            BIGSERIAL PRIMARY KEY,
    company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    entry_id      BIGINT        NOT NULL,
    action        TEXT          NOT NULL,
    user_id       INTEGER,
    username      TEXT,
    changes       JSONB,
    snapshot      JSONB,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Named rather than inline so adding an action later is a drop-and-add pair
-- that stays idempotent. BALANCE arrived with the second review stage;
-- IMPORT and IMPORT_UNDO with the backfill loader.
ALTER TABLE fuel_audit_log DROP CONSTRAINT IF EXISTS fuel_audit_log_action_check;
ALTER TABLE fuel_audit_log ADD  CONSTRAINT fuel_audit_log_action_check
  CHECK (action IN ('INSERT','UPDATE','SUBMIT','APPROVE','UNAPPROVE','ADMIN_EDIT','DELETE','BALANCE',
                    'IMPORT','IMPORT_UNDO'));

CREATE INDEX IF NOT EXISTS idx_fuel_audit_company ON fuel_audit_log(company_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_audit_entry   ON fuel_audit_log(entry_id, created_at DESC);

-- ─────────────────────────────────────────────────
-- FUEL VEHICLES
-- The truck roster behind Fuel Admin's Vehicles tab, and what makes the
-- monthly fuel report reportable: a fuel_submissions row carries a truck
-- NUMBER, and IFTA wants a VIN, a licence year and make, and the sticker
-- the vehicle is running under. truck_number is the join between the two,
-- which is why it is required here even though it is the one field the
-- office doesn't think of as vehicle detail — a vehicle with no truck
-- number can never be matched to the fuel bought for it.
--
-- Unique per company on truck_number for the same reason: two rows for
-- one truck would double every gallon it burned in the by-vehicle totals.
-- The number is reused when a truck is replaced, so the row is EDITED
-- rather than duplicated, and `active` retires one without deleting the
-- history that points at it.
--
-- ifta is the flag that decides whether a vehicle's fuel belongs in the
-- IFTA purchase totals at all. Off-road equipment burns dyed fuel that is
-- not highway-taxable, and rolling it into a filing overstates the credit.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_vehicles (
    id            BIGSERIAL PRIMARY KEY,
    company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    truck_number  INTEGER       NOT NULL,
    vin           TEXT,
    model_year    INTEGER,
    make          TEXT,
    ifta          BOOLEAN       NOT NULL DEFAULT FALSE,
    ifta_sticker  TEXT,
    active        BOOLEAN       NOT NULL DEFAULT TRUE,
    notes         TEXT,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_vehicle_truck
  ON fuel_vehicles(company_code, truck_number);

-- What each fuel account calls this vehicle, as {"Guttman":"5894","Wex":"PT 4805"}.
--
-- The accounts name vehicles in their own namespaces: an entry says truck 635,
-- Guttman's export says 5894, Wex's says PT 4805, and nothing in either file
-- joins them — Wex's VIN column ships blank. So the correspondence has to be
-- recorded once per vehicle, and this is where.
--
-- Deliberately keyed on the ACCOUNT rather than on a card number. A card gets
-- moved between vehicles; the vehicle the account has on file does not change
-- when it does. Mapping the card instead would silently re-attribute every
-- fill the moment one was swapped, which is the discrepancy this is supposed
-- to catch rather than absorb.
ALTER TABLE fuel_vehicles ADD COLUMN IF NOT EXISTS account_refs JSONB;

-- ─────────────────────────────────────────────────
-- FUEL STATEMENT MATCHES
-- One saved reconciliation: an account's statement for a period, lined up
-- against what the field reported. Saving it turns the match from a
-- throwaway screen into a record — a half-worked month can be picked back
-- up, and a truck that comes up short every month stops looking like
-- twelve unrelated one-offs.
--
-- Unique per company, account and period: re-running a month REPLACES its
-- saved match rather than stacking a second one beside it, because two
-- saved matches for one month would each look authoritative.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_statement_matches (
    id                     BIGSERIAL PRIMARY KEY,
    company_code           TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    account                TEXT        NOT NULL,
    period_start           DATE        NOT NULL,
    period_end             DATE        NOT NULL,
    period_month           TEXT,
    ours_total             NUMERIC(12,2),
    statement_total        NUMERIC(12,2),
    difference             NUMERIC(12,2),
    truck_count            INTEGER,
    matched_count          INTEGER,
    variance_count         INTEGER,
    not_in_ours_count      INTEGER,
    not_on_statement_count INTEGER,
    source_note            TEXT,
    created_by_user_id     INTEGER,
    created_by_name        TEXT,
    updated_by_user_id     INTEGER,
    updated_by_name        TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Who last re-matched a month, kept apart from who first reconciled it.
-- Overwriting created_by on a re-save destroyed the record of the person
-- who actually signed the month off — the same mistake the line-level
-- resolved_by is careful not to make.
ALTER TABLE fuel_statement_matches ADD COLUMN IF NOT EXISTS updated_by_user_id INTEGER;
ALTER TABLE fuel_statement_matches ADD COLUMN IF NOT EXISTS updated_by_name    TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_match_period
  ON fuel_statement_matches(company_code, account, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_fuel_match_company
  ON fuel_statement_matches(company_code, period_end DESC);

-- ─────────────────────────────────────────────────
-- FUEL STATEMENT LINES
-- One truck within a saved match. Kept as rows rather than a blob on the
-- match because the whole point of saving is the question "how has THIS
-- truck behaved over the last few months", and that is a GROUP BY over
-- this table rather than a scan of every stored document.
--
-- resolved / resolution_note are what let a month be worked through over
-- more than one sitting: a truck that has been chased down stays ticked,
-- and survives the month being re-matched after the underlying entries
-- are corrected.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_statement_lines (
    id              BIGSERIAL PRIMARY KEY,
    match_id        BIGINT      NOT NULL REFERENCES fuel_statement_matches(id) ON DELETE CASCADE,
    company_code    TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    truck_number    INTEGER,
    ours            NUMERIC(12,2),
    statement       NUMERIC(12,2),
    difference      NUMERIC(12,2),
    fills           INTEGER,
    verdict         TEXT        NOT NULL
                                CHECK (verdict IN ('match','variance','not-in-ours','not-on-statement')),
    resolved        BOOLEAN     NOT NULL DEFAULT FALSE,
    resolution_note TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fuel_line_match ON fuel_statement_lines(match_id);
CREATE INDEX IF NOT EXISTS idx_fuel_line_truck ON fuel_statement_lines(company_code, truck_number);

-- Who ticked a truck off, and when. Added after the first release of the
-- balancing work: a tick is a claim that somebody chased a discrepancy
-- down, and a claim with no name on it is worth less than one with.
ALTER TABLE fuel_statement_lines ADD COLUMN IF NOT EXISTS resolved_by_user_id INTEGER;
ALTER TABLE fuel_statement_lines ADD COLUMN IF NOT EXISTS resolved_by_name    TEXT;
ALTER TABLE fuel_statement_lines ADD COLUMN IF NOT EXISTS resolved_at         TIMESTAMPTZ;

-- ─────────────────────────────────────────────────
-- FUEL MATCH AUDIT LOG
-- One row per state change to a saved reconciliation. Separate from
-- fuel_audit_log because that table is keyed on a fuel_submissions id and
-- this one is keyed on a match — the two describe different objects and
-- sharing a column would mean neither could be joined.
--
-- match_id carries no foreign key ON PURPOSE. The single most important
-- thing this records is a match being DELETED, and a cascade would remove
-- that record along with the match it describes.
--
-- The period is denormalised onto each row for the same reason: after a
-- deletion there is nothing left to join to, and "somebody removed a saved
-- match" is useless without knowing which month went with it.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fuel_match_audit_log (
    id            BIGSERIAL   PRIMARY KEY,
    company_code  TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    match_id      BIGINT      NOT NULL,
    account       TEXT,
    period_start  DATE,
    period_end    DATE,
    action        TEXT        NOT NULL,
    user_id       INTEGER,
    username      TEXT,
    changes       JSONB,
    snapshot      JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE fuel_match_audit_log DROP CONSTRAINT IF EXISTS fuel_match_audit_action_check;
ALTER TABLE fuel_match_audit_log ADD  CONSTRAINT fuel_match_audit_action_check
  CHECK (action IN ('SAVE','RESAVE','TICK','DELETE'));

CREATE INDEX IF NOT EXISTS idx_fuel_match_audit_company ON fuel_match_audit_log(company_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fuel_match_audit_match   ON fuel_match_audit_log(match_id, created_at DESC);

-- ─────────────────────────────────────────────────
-- REPORT RECIPIENT GROUPS
-- Saved email distribution lists for the "Email Report" button on
-- the Executive, Turf, and Paving reports. Company-scoped (visible
-- to every user in the company). project_id is optional — when set,
-- the group floats to the top of the modal when emailing that
-- project's report. report_type is optional — when set, the group
-- only appears for that report variant.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_recipient_groups (
    id            BIGSERIAL PRIMARY KEY,
    company_code  TEXT          NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name          TEXT          NOT NULL,
    emails        JSONB         NOT NULL DEFAULT '[]'::jsonb,
    project_id    TEXT,
    report_type   TEXT,
    created_by    INTEGER,
    created_by_username TEXT,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rrg_company         ON report_recipient_groups(company_code, name);
CREATE INDEX IF NOT EXISTS idx_rrg_company_project ON report_recipient_groups(company_code, project_id);

-- ─────────────────────────────────────────────────
-- JOB DOCUMENT VAULT
-- Per-project document storage. File BYTES live in object storage;
-- these tables hold only metadata, the folder tree, and the audit trail.
--
-- project_id is a plain TEXT column with NO foreign key, exactly like
-- purchase_orders.project_id: each division keeps its own project list
-- (turf in `projects` + fct_projects, paving in fct_paving_projects,
-- kiewit in fct_kiewit_projects), so a single FK could only ever be
-- valid for turf. A NULL project_id means the row belongs to the
-- division-level General / Non-Job area rather than to any job.
-- ─────────────────────────────────────────────────

-- Folder tree. parent_id self-reference gives unlimited nesting.
-- kind: 'fixed'     — the six standard job folders, created with the project
--       'cost_code' — generated from the job's bid items, labelled from the
--                     cost-code master list
--       'user'      — anything a user added by hand
CREATE TABLE IF NOT EXISTS project_folders (
    id           TEXT PRIMARY KEY,
    company_code TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    division     TEXT        NOT NULL DEFAULT 'turf',
    project_id   TEXT,
    parent_id    TEXT        REFERENCES project_folders(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    kind         TEXT        NOT NULL DEFAULT 'user',
    slug         TEXT,
    cost_code    TEXT,
    sort_order   INTEGER     NOT NULL DEFAULT 0,
    archived     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Stable identity for a generated folder, independent of its display name.
-- Matching on the name alone meant renaming 'Photos' to 'Site Photos' made the
-- generator miss it and create 'Photos' all over again on the next load.
ALTER TABLE project_folders ADD COLUMN IF NOT EXISTS slug TEXT;

-- Set when a person renames a generated folder by hand. Cost-code folder
-- labels otherwise follow the cost-code master list on every load, so filling
-- that list in relabels the folders on jobs that already exist; a folder
-- someone renamed keeps the name they chose.
ALTER TABLE project_folders ADD COLUMN IF NOT EXISTS renamed_at TIMESTAMPTZ;

ALTER TABLE project_folders DROP CONSTRAINT IF EXISTS project_folders_kind_chk;
ALTER TABLE project_folders ADD  CONSTRAINT project_folders_kind_chk
  CHECK (kind IN ('fixed','cost_code','user'));

ALTER TABLE project_folders DROP CONSTRAINT IF EXISTS project_folders_division_chk;
ALTER TABLE project_folders ADD  CONSTRAINT project_folders_division_chk
  CHECK (division IN ('turf','dust','paving','kiewit','trucking','intercompany','quarry'));

-- COALESCE(project_id, '') matches the predicate the handler uses. Plain
-- project_id could not: the queries originally said
-- `project_id IS NOT DISTINCT FROM $n` to cover the NULL (General area) case,
-- and that operator is not btree-indexable, so the third column was never used
-- and every read seq-scanned the table.
--
-- New NAMES, not a redefinition of the old ones: CREATE INDEX IF NOT EXISTS is
-- a no-op when the name already exists, so redefining idx_pf_scope in place
-- would silently keep the old definition on every database that already has it.
DROP INDEX IF EXISTS idx_pf_scope;
CREATE INDEX IF NOT EXISTS idx_pf_company_div_proj ON project_folders(company_code, division, COALESCE(project_id, ''));
CREATE INDEX IF NOT EXISTS idx_pf_parent ON project_folders(parent_id);

-- Two folders cannot share a name under the same parent. COALESCE is required
-- because Postgres treats NULLs as distinct in a unique index, which would let
-- duplicate root folders (parent_id NULL) and duplicate division-level folders
-- (project_id NULL) through.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pf_unique_slug ON project_folders
  (company_code, division, COALESCE(project_id, ''), slug) WHERE slug IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pf_unique_name ON project_folders
  (company_code, division, COALESCE(project_id, ''), COALESCE(parent_id, ''), lower(name));

-- One row per stored file. storage_key is the object-store path; nothing here
-- ever holds file bytes.
CREATE TABLE IF NOT EXISTS project_documents (
    id           TEXT        PRIMARY KEY,
    company_code TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    division     TEXT        NOT NULL DEFAULT 'turf',
    project_id   TEXT,
    filename     TEXT        NOT NULL,
    content_type TEXT,
    size_bytes   BIGINT      NOT NULL DEFAULT 0,
    storage_key  TEXT        NOT NULL,
    storage_url  TEXT,
    note         TEXT,
    uploaded_by  TEXT,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ,
    deleted_by   TEXT,
    purge_after  TIMESTAMPTZ
);

-- How many times the purge sweep has failed to delete this object. Ordering
-- the sweep by this first stops a permanently undeletable object from sitting
-- at the head of every batch and starving everything behind it.
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS purge_attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS purge_last_error TIMESTAMPTZ;

ALTER TABLE project_documents DROP CONSTRAINT IF EXISTS project_documents_division_chk;
ALTER TABLE project_documents ADD  CONSTRAINT project_documents_division_chk
  CHECK (division IN ('turf','dust','paving','kiewit','trucking','intercompany','quarry'));

DROP INDEX IF EXISTS idx_pd_scope;
CREATE INDEX IF NOT EXISTS idx_pd_company_div_proj ON project_documents(company_code, division, COALESCE(project_id, ''));
CREATE INDEX IF NOT EXISTS idx_pd_live    ON project_documents(company_code, division, deleted_at);
CREATE INDEX IF NOT EXISTS idx_pd_purge   ON project_documents(purge_after) WHERE purge_after IS NOT NULL;

-- Where a document appears. Several rows per document — one per folder it is
-- filed in, one per purchase order it is attached to. This is what lets a
-- delivery ticket sit in a cost-code folder AND under its PO without storing
-- the file twice, and what will let an invoice hang off a PO line later
-- without a migration.
CREATE TABLE IF NOT EXISTS document_links (
    id           BIGSERIAL   PRIMARY KEY,
    document_id  TEXT        NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
    company_code TEXT        NOT NULL,
    link_type    TEXT        NOT NULL,
    target_id    TEXT        NOT NULL,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE document_links DROP CONSTRAINT IF EXISTS document_links_type_chk;
ALTER TABLE document_links ADD  CONSTRAINT document_links_type_chk
  CHECK (link_type IN ('folder','po'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_dl_unique ON document_links(document_id, link_type, target_id);
CREATE INDEX IF NOT EXISTS idx_dl_target ON document_links(link_type, target_id);

-- Every upload, delete, restore, rename, and link change. Same shape as
-- timesheet_audit_log / fuel_audit_log / dust_control_audit_log.
CREATE TABLE IF NOT EXISTS document_audit_log (
    id           BIGSERIAL   PRIMARY KEY,
    company_code TEXT        NOT NULL,
    division     TEXT        NOT NULL DEFAULT 'turf',
    document_id  TEXT,
    folder_id    TEXT,
    project_id   TEXT,
    action       TEXT        NOT NULL,
    actor        TEXT,
    actor_id     INTEGER,
    detail       JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE document_audit_log DROP CONSTRAINT IF EXISTS document_audit_action_chk;
ALTER TABLE document_audit_log ADD  CONSTRAINT document_audit_action_chk
  CHECK (action IN ('UPLOAD','DELETE','RESTORE','PURGE','RENAME','LINK','UNLINK','FOLDER_CREATE','FOLDER_RENAME','FOLDER_DELETE'));

CREATE INDEX IF NOT EXISTS idx_dal_company ON document_audit_log(company_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dal_doc     ON document_audit_log(document_id, created_at DESC);

-- ─────────────────────────────────────────────────
-- TRUCKING — DRIVER REPORTS
-- What a driver reports back against a haul the Scheduler assigned them:
-- tons, loads, the hours they actually ran, ticket numbers and anything that
-- went wrong.
--
-- Deliberately its own table rather than a column on the schedule or a row in
-- truck_division_entries. The schedule is the dispatcher's, and a phone
-- writing into it would overwrite the board. truck_division_entries is
-- payroll's — those rows arrive from approved timesheets and are swept back
-- out on un-approval, so a driver's note has no standing there. This is a
-- third thing: the field's account of a plan, keyed to the assignment it
-- answers.
--
-- One report per assignment. A driver may revise their own until the office
-- has what it needs; updated_at carries when they last did.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trucking_driver_reports (
    assignment_id  TEXT        NOT NULL,
    company_code   TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    work_date      DATE        NOT NULL,
    driver_name    TEXT        NOT NULL,
    user_id        INTEGER,
    username       TEXT,
    tons           NUMERIC(14,4),
    loads          INTEGER,
    actual_start   TEXT,
    actual_end     TEXT,
    tickets        TEXT,
    notes          TEXT,
    submitted_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_code, assignment_id)
);
CREATE INDEX IF NOT EXISTS idx_tdr_company_date
    ON trucking_driver_reports(company_code, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_tdr_company_driver
    ON trucking_driver_reports(company_code, driver_name, work_date DESC);

-- ─────────────────────────────────────────────────
-- QUARRY SALES SUBMISSIONS
-- The field side of the quarry's Sales Tracking tab. One row per load sold:
-- the date, the pit, who sold it, the customer, the product, the tons and how
-- it was paid — which is exactly the seven columns Sales Tracking opens with.
--
-- Two stages only, unlike Timesheet → Payroll and Fuel → Fuel Admin. There is
-- no office queue to sit in: submitting posts the sale straight into the
-- fct_quarry_sales blob (row id "qss-<id>-row") where the office prices it, so
-- an 'approved' state would name a step nobody performs. A draft is the
-- submitter's alone and can still be edited or thrown away.
--
-- The names are stored beside the ids on purpose. An id resolves against the
-- quarry's Manage Lists, and a customer deleted from that list a year later
-- would otherwise take the name off every sale ever made to them.
--
-- row_id is which Sales Tracking row this submission owns. Derivable from id,
-- and stored anyway: it is what a later sweep would key on, and a column is
-- cheaper to read than a convention nobody can grep for.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quarry_sales_submissions (
    id             BIGSERIAL   PRIMARY KEY,
    company_code   TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    user_id        INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username       TEXT        NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft','submitted')),

    work_date      DATE        NOT NULL,
    location_id    TEXT,
    location_name  TEXT,
    employee_id    TEXT,
    employee_name  TEXT,
    customer_id    TEXT,
    customer_name  TEXT,
    product_id     TEXT,
    product_name   TEXT,
    tons           NUMERIC(14,4),
    payment        TEXT,

    row_id         TEXT,
    submitted_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qss_company_user_date
    ON quarry_sales_submissions(company_code, user_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_qss_company_status
    ON quarry_sales_submissions(company_code, status, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_qss_company_customer
    ON quarry_sales_submissions(company_code, customer_name, work_date DESC);
