#!/usr/bin/env node
'use strict';
/**
 * SQL-level test for scripts/purge-deleted-documents.js.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-document-purge-sql.js
 *
 * DESTRUCTIVE: truncates the document tables. Refuses to run against a
 * database whose name does not look like a test database.
 *
 * The sweep is the only thing that ever removes a stored object, so the two
 * properties worth pinning down are the ones a careless rewrite would break:
 *
 *   - a document still inside its 30-day window is left completely alone
 *   - the object is deleted BEFORE the row. A crash between the two leaves a
 *     row pointing at a missing object, which the next run retries harmlessly;
 *     the reverse orphans an object nothing references and no run can find.
 */
const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';
const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  process.exit(1);
}

process.env.DATABASE_URL = URL;

const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

// Records what the sweep asks storage to remove, and in what order relative to
// the row deletes, without touching a real bucket.
const events = [];
let storageFails = false;

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === '../api/lib/storage') {
    return {
      isConfigured: () => true,
      deleteObject: async key => {
        events.push({ kind: 'storage', key });
        return !storageFails;
      },
    };
  }
  if (request === 'dotenv') return { config: () => ({}) };
  return origLoad.apply(this, arguments);
};

let passed = 0, failed = 0;
const assert = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
};

async function seed() {
  await client.query(`TRUNCATE project_folders, project_documents, document_links, document_audit_log RESTART IDENTITY CASCADE`);
  await client.query(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await client.query(`
    INSERT INTO project_documents
      (id, company_code, division, project_id, filename, content_type, size_bytes, storage_key,
       uploaded_by, deleted_at, deleted_by, purge_after)
    VALUES
      -- past its window: due
      ('d-old',   'FCT','turf','p1','old.pdf',   'application/pdf', 10, 'FCT/turf/p1/d-old/old.pdf',
       'pm', NOW() - INTERVAL '40 days', 'admin', NOW() - INTERVAL '10 days'),
      -- deleted, but still recoverable: must be untouched
      ('d-recent','FCT','turf','p1','recent.pdf','application/pdf', 10, 'FCT/turf/p1/d-recent/recent.pdf',
       'pm', NOW() - INTERVAL '2 days',  'admin', NOW() + INTERVAL '28 days'),
      -- live: must be untouched
      ('d-live',  'FCT','turf','p1','live.pdf',  'application/pdf', 10, 'FCT/turf/p1/d-live/live.pdf',
       'pm', NULL, NULL, NULL)
  `);
  // A link on the due document, to prove the cascade carries it away.
  await client.query(`
    INSERT INTO document_links (document_id, company_code, link_type, target_id)
    VALUES ('d-old','FCT','po','po-1042')
  `);
}

async function runSweep() {
  events.length = 0;
  delete require.cache[require.resolve('../scripts/purge-deleted-documents.js')];
  const argv = process.argv;
  process.argv = [argv[0], argv[1]];
  // The script is a self-executing async IIFE; wait a tick for it to finish.
  require('../scripts/purge-deleted-documents.js');
  await new Promise(r => setTimeout(r, 400));
  process.argv = argv;
}

(async () => {
  await client.connect();
  await seed();

  console.log('\nPurge sweep');
  await runSweep();

  const rows = await client.query(`SELECT id FROM project_documents ORDER BY id`);
  const ids  = rows.rows.map(r => r.id);
  assert('the document past its window is gone', !ids.includes('d-old'), ids.join(', '));
  assert('a document still inside its window survives', ids.includes('d-recent'), ids.join(', '));
  assert('a live document is untouched', ids.includes('d-live'), ids.join(', '));

  const deleted = events.filter(e => e.kind === 'storage');
  assert('exactly one object was deleted from storage', deleted.length === 1,
    JSON.stringify(deleted));
  assert('and it was the right one',
    deleted[0] && deleted[0].key === 'FCT/turf/p1/d-old/old.pdf', JSON.stringify(deleted));

  const links = await client.query(`SELECT COUNT(*)::int AS n FROM document_links WHERE document_id = 'd-old'`);
  assert('its links went with it', links.rows[0].n === 0);

  const log = await client.query(`SELECT action, actor, detail FROM document_audit_log WHERE document_id = 'd-old'`);
  assert('the purge is recorded', log.rows.length === 1 && log.rows[0].action === 'PURGE',
    JSON.stringify(log.rows));
  assert('and names who had deleted it', log.rows.length && log.rows[0].detail.deleted_by === 'admin',
    JSON.stringify(log.rows[0] && log.rows[0].detail));

  // ── A storage failure must not lose track of the object ────────────────
  console.log('\nWhen storage refuses');
  await seed();
  storageFails = true;
  await runSweep();
  storageFails = false;

  const still = await client.query(`SELECT id FROM project_documents WHERE id = 'd-old'`);
  assert('the row is kept when the object could not be deleted', still.rows.length === 1);

  // Next run, storage healthy again — it must pick the same document back up.
  await runSweep();
  const now = await client.query(`SELECT id FROM project_documents WHERE id = 'd-old'`);
  assert('and the next run finishes the job', now.rows.length === 0);

  console.log(`\n${passed} passed, ${failed} failed.`);
  await client.end();
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error('\nTest run failed:', err);
  try { await client.end(); } catch {}
  process.exit(1);
});
