-- ForceCorpTracking — Auth Schema
-- Run this in your Neon SQL Editor to create or upgrade the auth tables.

-- ─────────────────────────────────────────────────
-- COMPANIES
-- Each company has a short unique code (e.g. "ACME", "FORCECORP")
-- allowed_divisions controls which lines of business are licensed
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
    code               TEXT PRIMARY KEY,
    name               TEXT        NOT NULL,
    allowed_divisions  TEXT[]      NOT NULL DEFAULT '{turf}',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────
-- USERS
-- Roles (within a company):
--   admin   — company admin: full access + can manage company users
--   level3  — full access to all tabs/actions
--   level2  — insert/edit cost rows & POs; cannot delete projects
--   level1  — view-only for Cost Tracking and Purchase Orders tabs
--
-- divisions: which divisions this user can access within their company.
--   NULL = inherits all of the company's allowed_divisions
--   Set to a subset (e.g. '{turf}') to restrict a user further.
--
-- is_platform_admin: grants cross-company, cross-division access.
--   Reserved for the platform owner. Overrides all role/division checks.
--
-- Passwords are stored as bcrypt hashes — never plaintext.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                 SERIAL PRIMARY KEY,
    username           TEXT        NOT NULL,
    company_code       TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    password_hash      TEXT        NOT NULL,
    role               TEXT        NOT NULL DEFAULT 'level1'
                                   CHECK (role IN ('admin', 'level3', 'level2', 'level1')),
    divisions          TEXT[]      DEFAULT NULL,
    is_platform_admin  BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (username, company_code)
);

-- ─────────────────────────────────────────────────
-- UPGRADE — run these if the tables already exist
-- (safe to run multiple times — IF NOT EXISTS / IF NOT EXISTS guard)
-- ─────────────────────────────────────────────────
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS allowed_divisions TEXT[] NOT NULL DEFAULT '{turf}';

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS divisions         TEXT[]  DEFAULT NULL;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS division_roles     JSONB   DEFAULT NULL;

-- ─────────────────────────────────────────────────
-- NOTE: app_data keys are namespaced as:
--   "{companyCode}:fct_projects"
--   "{companyCode}:fct_lists"
--   "{companyCode}:fct_cost_rows"
-- so each company's data is fully isolated by default.
-- When additional divisions are built their data keys will follow
-- the same pattern: "{companyCode}:{division}_projects", etc.
-- ─────────────────────────────────────────────────
