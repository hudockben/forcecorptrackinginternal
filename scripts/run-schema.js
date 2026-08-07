/**
 * One-time script: applies the schema to the Neon database.
 * Run with: node scripts/run-schema.js
 *
 * auth-schema.sql FIRST, then neon-schema.sql. That order is not cosmetic —
 * auth-schema.sql creates `companies` and `users`, and the very first table in
 * neon-schema.sql that references companies(code) fails without them, taking
 * most of the file down with it. Running neon-schema alone against a fresh
 * database left 7 tables of 41. Both files are idempotent, so re-running this
 * against an existing database is a no-op.
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

// Strip -- line comments first so semicolons inside comments don't cause
// false splits, then split on semicolons and filter blank chunks.
function statementsIn(file) {
  const stripped = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');
  return stripped
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

(async () => {
  const sql = neon(process.env.DATABASE_URL);

  for (const file of ['auth-schema.sql', 'neon-schema.sql']) {
    console.log(`\n${file}`);
    for (const stmt of statementsIn(file)) {
      await sql([stmt]);
      const preview = stmt.slice(0, 60).replace(/\s+/g, ' ');
      console.log(`  OK: ${preview}...`);
    }
  }

  console.log('\nSchema applied successfully to Neon.');
})().catch(err => { console.error('Schema error:', err.message); process.exit(1); });
