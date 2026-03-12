-- ForceCorpTracking — Auth Schema
-- Run this in your Neon SQL Editor to add multi-company/user support.

-- ─────────────────────────────────────────────────
-- COMPANIES
-- Each company has a short unique code (e.g. "ACME", "FORCECORP")
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
    code       TEXT PRIMARY KEY,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────
-- USERS
-- Roles:
--   admin   — company admin: full access + can manage company users
--   level3  — full access to all tabs/actions
--   level2  — insert/edit cost rows & POs; cannot delete projects
--   level1  — view-only for Cost Tracking and Purchase Orders tabs
-- Passwords are stored as bcrypt hashes — never plaintext.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT        NOT NULL,
    company_code  TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL DEFAULT 'level1'
                              CHECK (role IN ('admin', 'level3', 'level2', 'level1')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (username, company_code)
);

-- If upgrading from old schema, run:
--   ALTER TABLE users DROP CONSTRAINT users_role_check;
--   ALTER TABLE users ADD CONSTRAINT users_role_check
--     CHECK (role IN ('admin', 'level3', 'level2', 'level1'));
--   UPDATE users SET role = 'level3' WHERE role = 'user';

-- ─────────────────────────────────────────────────
-- NOTE: app_data keys are now namespaced as:
--   "{companyCode}:fct_projects"
--   "{companyCode}:fct_lists"
--   "{companyCode}:fct_cost_rows"
-- so each company's data is fully isolated.
-- ─────────────────────────────────────────────────
