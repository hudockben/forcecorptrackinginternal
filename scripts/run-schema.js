/**
 * One-time script: applies neon-schema.sql to the Neon database.
 * Run with: node scripts/run-schema.js
 *
 * Lives outside api/ deliberately: every file under api/ is deployed as a
 * serverless function, and this one applies schema DDL at module load. In
 * api/ it was reachable as an unauthenticated GET /api/run-schema that ran
 * the whole schema and locked tables on each hit.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../api/.env') });
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');

(async () => {
  const sql = neon(process.env.DATABASE_URL);
  const schema = fs.readFileSync(path.join(__dirname, '../neon-schema.sql'), 'utf8');

  // Strip -- line comments first so semicolons inside comments don't cause
  // false splits, then split on semicolons and filter blank chunks.
  const stripped = schema
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  const statements = stripped
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    await sql([stmt]);
    const preview = stmt.slice(0, 60).replace(/\s+/g, ' ');
    console.log(`  OK: ${preview}...`);
  }

  console.log('\nSchema applied successfully to Neon.');
})().catch(err => { console.error('Schema error:', err.message); process.exit(1); });
