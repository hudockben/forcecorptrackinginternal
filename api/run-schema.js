/**
 * One-time script: applies neon-schema.sql to the Neon database.
 * Run with: node api/run-schema.js
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');

(async () => {
  const sql = neon(process.env.DATABASE_URL);
  const schema = fs.readFileSync(path.join(__dirname, '../neon-schema.sql'), 'utf8');

  // Split on semicolons, filter blanks/comments-only chunks
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('--'));

  for (const stmt of statements) {
    await sql([stmt]);
    const preview = stmt.slice(0, 60).replace(/\s+/g, ' ');
    console.log(`  OK: ${preview}...`);
  }

  console.log('\nSchema applied successfully to Neon.');
})().catch(err => { console.error('Schema error:', err.message); process.exit(1); });
