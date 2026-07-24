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

-- Trucking-only daily fields (added after initial release). Captured on the
-- timesheet only when the division is 'trucking', and carried into the matching
-- Truck Tracking columns (unit + description) on payroll approval. Idempotent so
-- existing deployments pick them up the next time run-schema executes.
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS truck_unit        TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS truck_description TEXT;

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
