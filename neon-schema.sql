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
    id         SERIAL PRIMARY KEY,
    list_name  VARCHAR(50)  NOT NULL,
    value      VARCHAR(255) NOT NULL,
    sort_order INTEGER      NOT NULL DEFAULT 0,
    UNIQUE (list_name, value)
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
