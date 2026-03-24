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

/** Company board */
app.all('/api/board', require('./board'));

/** Deadlines */
app.all('/api/deadlines', require('./deadlines'));

/** AI schedule analysis */
app.post('/api/ai/schedule-analysis', require('./ai/schedule-analysis'));

/** AI conflict resolution suggestions */
app.post('/api/ai/conflict-resolve', require('./ai/conflict-resolve'));

/** Weekly report — POST (UI-triggered) or GET (Vercel Cron) */
app.all('/api/reports/weekly', require('./reports/weekly'));

/** Liveness / health check */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * GET /api/data/:key
 * Returns the stored JSON value for the given key.
 * Responds with { value: null } when the key has not been saved yet.
 */
app.get('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  try {
    const rows = await sql`
      SELECT value FROM app_data WHERE key = ${key}
    `;
    const value = rows.length ? rows[0].value : null;
    res.json({ value });
  } catch (err) {
    console.error('GET /api/data/:key error:', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

/**
 * PUT /api/data/:key
 * Body: { "value": <any JSON> }
 * Upserts the value for the given key and returns { ok: true }.
 */
app.put('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (value === undefined) {
    return res.status(400).json({ error: '`value` field is required in request body' });
  }

  // Only allow the keys the app uses
  const ALLOWED_KEYS = ['fct_projects', 'fct_projects_index', 'fct_lists', 'fct_cost_rows', 'fct_purchase_orders', 'fct_presence'];
  const isAllowed = ALLOWED_KEYS.includes(key) || /^fct_project_[a-zA-Z0-9_-]+$/.test(key);
  if (!isAllowed) {
    return res.status(400).json({ error: `Unknown key "${key}". Allowed: ${ALLOWED_KEYS.join(', ')}, fct_project_*` });
  }

  try {
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}, NOW())
      ON CONFLICT (key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
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
