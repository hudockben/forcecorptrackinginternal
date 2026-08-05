/**
 * DataWatch API Server
 * Connects to Neon (PostgreSQL) and exposes a simple key-value API
 * that the tracker.html frontend uses in place of localStorage.
 *
 * Endpoints:
 *   GET  /api/data/:key        — fetch a stored value
 *   PUT  /api/data/:key        — upsert a value  { value: <any> }
 *   GET  /api/health           — liveness check
 */

'use strict';

/**
 * Local development server. Not deployed: everything under api/ is built into
 * the serverless bundle, and this file serves /api/data/:key with no auth and
 * calls app.listen() at module load, neither of which belongs in production.
 * Run with: npm --prefix api start
 */

require('dotenv').config({ path: require('path').join(__dirname, '../api/.env') });

const express = require('express');
const path    = require('path');
const { neon } = require('@neondatabase/serverless');

// ── Neon connection ────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  console.error('Create api/.env and add: DATABASE_URL=postgresql://<user>:<pass>@<host>/neondb?sslmode=require');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ── Express setup ──────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '10mb' }));

// Serve static files (index.html, tracker.html) so /api paths work locally
app.use(express.static(path.join(__dirname, '..')));

// ── Routes ─────────────────────────────────────────────────────────────────

/** Daily rows — scalable per-row storage */
app.all('/api/daily-rows', require('../api/daily-rows'));

/** Trucking entries */
app.all('/api/trucking', require('../api/trucking'));

/** Truck division tracking + lists */
app.all('/api/truck-division', require('../api/truck-division'));

/** Purchase orders + delivery lines */
app.all('/api/purchase-orders', require('../api/purchase-orders'));

/** Dust control entries */
app.all('/api/dust-rows', require('../api/dust-rows'));

/** Dust control config (settings + lists) */
app.all('/api/dust-config', require('../api/dust-config'));

/** Timesheet entries — field submissions + payroll review */
app.all('/api/timesheet-entries',       require('../api/timesheet-entries'));
app.all('/api/timesheet-jobs',          require('../api/timesheet-jobs'));
app.all('/api/timesheet-job-costcodes', require('../api/timesheet-job-costcodes'));
app.all('/api/timesheet-supervisors',   require('../api/timesheet-supervisors'));
app.all('/api/timesheet-audit-log',     require('../api/timesheet-audit-log'));

/** Company board */
app.all('/api/board', require('../api/board'));

/** Deadlines */
app.all('/api/deadlines', require('../api/deadlines'));

/** Sync JSON blobs → normalized tables */
app.post('/api/admin/sync-db', require('../api/admin/sync-db'));

/** Report email sender + saved recipient groups */
app.all('/api/email/send-report',       require('../api/email/send-report'));
app.all('/api/email/recipient-groups',  require('../api/email/recipient-groups'));

/** AI schedule analysis */
app.post('/api/ai/schedule-analysis', require('../api/ai/schedule-analysis'));

/** AI conflict resolution suggestions */
app.post('/api/ai/conflict-resolve', require('../api/ai/conflict-resolve'));

/** AI sub-code production estimate (Schedule Estimator "fill in the blanks") */
app.post('/api/ai/estimate-subcode', require('../api/ai/estimate-subcode'));

/** Debug / diagnostics */
app.get('/api/debug', require('../api/debug'));

/** Liveness / health check */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── Legacy key-value store ─────────────────────────────────────────────────
// Data was originally stored without a company prefix. These routes keep all
// existing tdGet/tdPut calls (fct_lists, fct_projects, etc.) working.

const LEGACY_ALLOWED = [
  'fct_projects', 'fct_projects_index', 'fct_lists', 'fct_cost_rows',
  'fct_purchase_orders', 'fct_presence', 'fct_trucking', 'fct_inventory',
  'fct_scale_manual', 'fct_soe_units', 'fct_truck_division', 'fct_truck_division_lists',
];
function isLegacyKey(k) {
  return LEGACY_ALLOWED.includes(k)
    || /^fct_project_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_trend_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_crm_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_lucius_[a-zA-Z0-9_-]+$/.test(k)
    || /^fct_conschedule_[a-zA-Z0-9_-]+$/.test(k)
    || /^dust_[a-zA-Z0-9_-]+$/.test(k);
}

app.get('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  if (!isLegacyKey(key)) return res.status(400).json({ error: `Unknown key "${key}"` });
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${key}`;
    res.json({ value: rows.length ? rows[0].value : null });
  } catch (err) {
    console.error('GET /api/data/:key error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

app.put('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  if (!isLegacyKey(key)) return res.status(400).json({ error: `Unknown key "${key}"` });
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: '`value` field is required' });
  try {
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/data/:key error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DataWatch running at http://localhost:${PORT}`);
  console.log(`  App:    http://localhost:${PORT}/tracker.html`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
});
