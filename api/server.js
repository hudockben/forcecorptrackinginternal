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

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

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
app.all('/api/daily-rows', require('./daily-rows'));

/** Trucking entries */
app.all('/api/trucking', require('./trucking'));

/** Truck division tracking + lists */
app.all('/api/truck-division', require('./truck-division'));

/** Purchase orders + delivery lines */
app.all('/api/purchase-orders', require('./purchase-orders'));

/** Dust control entries */
app.all('/api/dust-rows', require('./dust-rows'));

/** Dust control config (settings + lists) */
app.all('/api/dust-config', require('./dust-config'));

/** Timesheet entries — field submissions + payroll review */
app.all('/api/timesheet-entries',     require('./timesheet-entries'));
app.all('/api/timesheet-jobs',        require('./timesheet-jobs'));
app.all('/api/timesheet-supervisors', require('./timesheet-supervisors'));
app.all('/api/timesheet-audit-log',   require('./timesheet-audit-log'));

/** Company board */
app.all('/api/board', require('./board'));

/** Deadlines */
app.all('/api/deadlines', require('./deadlines'));

/** Sync JSON blobs → normalized tables */
app.post('/api/admin/sync-db', require('./admin/sync-db'));

/** AI schedule analysis */
app.post('/api/ai/schedule-analysis', require('./ai/schedule-analysis'));

/** AI conflict resolution suggestions */
app.post('/api/ai/conflict-resolve', require('./ai/conflict-resolve'));

/** Debug / diagnostics */
app.get('/api/debug', require('./debug'));

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
