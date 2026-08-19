#!/usr/bin/env node
'use strict';
/**
 * Purges documents whose 30-day recovery window has run out.
 *
 * Run:  node scripts/purge-deleted-documents.js [--dry-run] [--limit N]
 *
 * A delete in the app is soft: project_documents.deleted_at is stamped and
 * purge_after is set 30 days out, so a contract removed by mistake comes back.
 * Nothing else acts on purge_after, which means without this sweep the rows
 * clear but the stored objects stay — and keep billing — forever.
 *
 * Order matters: the object goes first, the row second. A crash between the
 * two leaves a row pointing at a missing object, which the next run retries
 * harmlessly. The reverse would leave an object nothing references, invisible
 * to every later run.
 *
 * Lives outside api/ deliberately, like scripts/run-schema.js: everything
 * under api/ deploys as a serverless function, and this one deletes data.
 * Point a scheduler at it — nightly is plenty.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../api/.env') });
const { neon } = require('@neondatabase/serverless');
const storage  = require('../api/lib/storage');

const DRY_RUN = process.argv.includes('--dry-run');
const limitAt = process.argv.indexOf('--limit');
const LIMIT   = limitAt > -1 ? parseInt(process.argv[limitAt + 1], 10) || 500 : 500;

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  if (!DRY_RUN && !storage.isConfigured()) {
    console.error('Object storage is not configured — set S3_ENDPOINT, S3_BUCKET,');
    console.error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or pass --dry-run.');
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL);

  // purge_attempts ASC first, then purge_after: an object the store keeps
  // refusing to delete sinks to the back of the queue instead of sitting at the
  // head of every batch forever. Ordering by purge_after alone meant LIMIT
  // worth of undeletable objects blocked every newer document permanently.
  const due = await sql`
    SELECT id, company_code, division, project_id, filename, storage_key,
           deleted_at, deleted_by, purge_attempts
    FROM   project_documents
    WHERE  deleted_at  IS NOT NULL
      AND  purge_after IS NOT NULL
      AND  purge_after <= NOW()
    ORDER  BY purge_attempts ASC, purge_after ASC
    LIMIT  ${LIMIT}
  `;

  if (!due.length) {
    console.log('Nothing due for purge.');
    return;
  }

  console.log(`${due.length} document${due.length === 1 ? '' : 's'} past the recovery window${DRY_RUN ? ' (dry run)' : ''}:\n`);

  let purged = 0, stuck = 0, restored = 0, lateRestores = 0;
  for (const doc of due) {
    const label = `${doc.company_code}/${doc.division} ${doc.filename}`;
    if (DRY_RUN) {
      console.log(`  would purge  ${label}  (deleted ${new Date(doc.deleted_at).toISOString().slice(0, 10)} by ${doc.deleted_by || 'unknown'})`);
      continue;
    }

    // Re-read immediately before destroying anything. The batch was selected
    // once and then walked with a network round trip per row, so a run over a
    // few hundred documents spans a window in which an admin can restore one.
    // Without this the sweep destroyed the object and the row of a document
    // that was live again on screen.
    const stillDue = await sql`
      SELECT 1 FROM project_documents
      WHERE id = ${doc.id}
        AND deleted_at  IS NOT NULL
        AND purge_after IS NOT NULL
        AND purge_after <= NOW()
    `;
    if (!stillDue.length) {
      console.log(`  restored     ${label} — recovered mid-run, leaving it alone`);
      restored++;
      continue;
    }

    const gone = await storage.deleteObject(doc.storage_key);
    if (!gone) {
      // Leave the row alone so the next run tries again rather than losing
      // track of an object that is still sitting in the bucket — but count the
      // attempt, so a permanently undeletable object stops crowding out the
      // rest of the queue.
      await sql`
        UPDATE project_documents
        SET    purge_attempts = COALESCE(purge_attempts, 0) + 1,
               purge_last_error = NOW()
        WHERE  id = ${doc.id}
      `;
      console.warn(`  SKIPPED      ${label} — storage delete failed (attempt ${(doc.purge_attempts || 0) + 1}), will retry`);
      stuck++;
      continue;
    }

    await sql`
      INSERT INTO document_audit_log
        (company_code, division, document_id, project_id, action, actor, detail)
      VALUES
        (${doc.company_code}, ${doc.division}, ${doc.id}, ${doc.project_id}, 'PURGE', 'system',
         ${JSON.stringify({ filename: doc.filename, deleted_by: doc.deleted_by, storage_key: doc.storage_key })})
    `;
    // document_links rows go with it via ON DELETE CASCADE. The WHERE repeats
    // the due condition so a restore that lands between the re-read above and
    // this statement cannot be destroyed either — at that point the object is
    // already gone, but keeping the row means the loss is visible and
    // recoverable from the audit trail rather than silent.
    const removed = await sql`
      DELETE FROM project_documents
      WHERE id = ${doc.id} AND deleted_at IS NOT NULL AND purge_after <= NOW()
      RETURNING id
    `;
    if (!removed.length) {
      console.warn(`  RESTORED-LATE ${label} — restored after its object was deleted, row kept for investigation`);
      lateRestores++;
      continue;
    }
    console.log(`  purged       ${label}`);
    purged++;
  }

  if (!DRY_RUN) {
    const bits = [`${purged} purged`];
    if (stuck)        bits.push(`${stuck} left for the next run`);
    if (restored)     bits.push(`${restored} restored mid-run and skipped`);
    if (lateRestores) bits.push(`${lateRestores} restored after their object was deleted — NEEDS ATTENTION`);
    console.log(`\n${bits.join(', ')}.`);
  }
})().catch(err => {
  console.error('Purge failed:', err.message);
  process.exit(1);
});
