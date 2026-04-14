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

/** Purchase orders + delivery lines */
app.all('/api/purchase-orders', require('./purchase-orders'));

/** Dust control entries */
app.all('/api/dust-rows', require('./dust-rows'));

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

/** Liveness / health check */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// All /api/data requests are handled by api/data/[key].js (JWT-scoped per company).
// Those routes are registered above via app.all('/api/data', ...).
// No unscoped legacy routes here.

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`DataWatch running at http://localhost:${PORT}`);
  console.log(`  App:    http://localhost:${PORT}/tracker.html`);
  console.log(`  Health: http://localhost:${PORT}/api/health`);
});
