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
-- Each user belongs to one company, has a role of 'admin' or 'user'
-- Passwords are stored as bcrypt hashes — never plaintext.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT        NOT NULL,
    company_code  TEXT        NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL DEFAULT 'user'
                              CHECK (role IN ('admin', 'user')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (username, company_code)
);

-- ─────────────────────────────────────────────────
-- NOTE: app_data keys are now namespaced as:
--   "{companyCode}:fct_projects"
--   "{companyCode}:fct_lists"
--   "{companyCode}:fct_cost_rows"
-- so each company's data is fully isolated.
-- ─────────────────────────────────────────────────
