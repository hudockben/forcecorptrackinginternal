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
    name       VARCHAR(255) NOT NULL UNIQUE,
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
