#!/usr/bin/env node
'use strict';
/**
 * SQL-level integration test for /api/documents.
 *
 * Run: PG_TEST_URL=postgres://... node scripts/test-documents-sql.js
 *      (defaults to postgres://fct_test_user:test@localhost/fct_test)
 *
 * Set the database up first — auth-schema.sql THEN neon-schema.sql, the same
 * order scripts/run-schema.js uses.
 *
 * DESTRUCTIVE: truncates project_folders, project_documents, document_links
 * and document_audit_log. Refuses to run against a database whose name does
 * not look like a test database.
 *
 * Drives the real handler against a real PostgreSQL, so what is asserted is
 * what the database actually does:
 *
 *   - folder generation is idempotent, and survives two users opening the
 *     same job at once (the unique index is the referee)
 *   - a document filed in a cost-code folder and attached to a PO is ONE row
 *     reachable from both, which is the whole premise of document_links
 *   - unfiling never strands a document with no folder
 *   - division and company scoping, against the real WHERE clauses
 *   - the permission ladder: level1 view, level2 upload, level3 manage,
 *     admin destroy
 *   - soft delete leaves the row recoverable and dated 30 days out
 */

const path   = require('path');
const Module = require('module');
const { Client } = require('pg');

const URL = process.env.PG_TEST_URL || 'postgres://fct_test_user:test@localhost/fct_test';

const dbName = (URL.split('/').pop() || '').split('?')[0];
if (!/test/i.test(dbName)) {
  console.error(`Refusing to run: "${dbName}" does not look like a test database.`);
  console.error('This script truncates tables. Point PG_TEST_URL at a scratch database.');
  process.exit(1);
}

process.env.S3_ENDPOINT          = 'https://acct.r2.cloudflarestorage.com';
process.env.S3_BUCKET            = 'fct-test';
process.env.S3_ACCESS_KEY_ID     = 'test';
process.env.S3_SECRET_ACCESS_KEY = 'test';

const client = new Client({ connectionString: URL });

function makeSql(c) {
  return (strings, ...values) => {
    let text = '';
    strings.forEach((s, i) => { text += s + (i < values.length ? '$' + (i + 1) : ''); });
    return c.query(text, values).then(r => r.rows);
  };
}

let AUTH = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth') {
    return {
      requireAuth: () => AUTH,
      // Mirror the real guard: resolve the division, then check access, so the
      // isolation assertions below exercise a check that actually exists.
      requireDivision: (req, res) => {
        if (!AUTH) { res.status(401).json({ error: 'Unauthorized' }); return null; }
        const division = (req.query && req.query.division) || 'turf';
        const allowed = AUTH.isPlatformAdmin
          || !!(AUTH.divisionRoles && AUTH.divisionRoles[division] && AUTH.divisionRoles[division] !== 'no_access');
        if (!allowed) { res.status(403).json({ error: 'You do not have access to this division' }); return null; }
        return { payload: AUTH, division };
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.resolve(__dirname, '..', 'api', 'documents.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

const VIEWER  = { companyCode: 'FCT', userId: 1, username: 'viewer',  role: 'level1', divisionRoles: { turf: 'level1' } };
const FOREMAN = { companyCode: 'FCT', userId: 2, username: 'foreman', role: 'level2', divisionRoles: { turf: 'level2' } };
const PM      = { companyCode: 'FCT', userId: 3, username: 'pm',      role: 'level3', divisionRoles: { turf: 'level3' } };
const ADMIN   = { companyCode: 'FCT', userId: 4, username: 'admin',   role: 'admin',  divisionRoles: { turf: 'admin' } };
const PAVER   = { companyCode: 'FCT', userId: 5, username: 'paver',   role: 'level3', divisionRoles: { paving: 'level3' } };
const OTHERCO = { companyCode: 'OTH', userId: 6, username: 'rival',   role: 'admin',  divisionRoles: { turf: 'admin' } };

async function call(method, query, body, auth) {
  AUTH = auth;
  const res = {
    statusCode: 200, body: null,
    setHeader() {}, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, end() { return this; },
  };
  await handler({ method, query: query || {}, body: body || {} }, res);
  return res;
}

const PROJ = 'proj-route-30';

async function seed() {
  await client.query(`TRUNCATE project_folders, project_documents, document_links, document_audit_log RESTART IDENTITY CASCADE`);
  await client.query(`INSERT INTO companies (code, name) VALUES ('FCT','Force Corp') ON CONFLICT (code) DO NOTHING`);
  await client.query(`INSERT INTO companies (code, name) VALUES ('OTH','Rival Co')  ON CONFLICT (code) DO NOTHING`);
}

// Register a document the way the browser does: mint an id, PUT the bytes to
// storage (skipped here), then POST the metadata.
let seq = 0;
async function upload(folderId, filename, auth, extra = {}) {
  const documentId = `doc-${++seq}`;
  const projectId  = extra.projectId !== undefined ? extra.projectId : PROJ;
  const storageKey = `FCT/turf/${projectId || 'general'}/${documentId}/${filename}`;
  return call('POST', { division: 'turf', projectId: projectId || undefined },
    { documentId, filename, storageKey, folderId, sizeBytes: 1024, ...extra }, auth);
}

(async () => {
  await client.connect();
  await seed();

  // ── Folder generation ────────────────────────────────────────────────────
  console.log('\nFolder generation');
  const gen = await call('PUT', { division: 'turf', projectId: PROJ }, {
    costCodes: [
      { code: '420', label: 'Paving' },
      { code: '411', label: 'Excavation' },
      { code: '415', label: '' },
    ],
  }, PM);
  assert('PUT seeds the tree', gen.statusCode === 200, JSON.stringify(gen.body));
  const folders = gen.body.folders;
  const names = folders.map(f => f.name);
  assert('six fixed folders exist',
    ['Contract & Change Orders', 'Permits & Insurance', 'Submittals', 'Safety', 'Photos', 'Closeout']
      .every(n => names.includes(n)), names.join(' | '));
  assert('Purchase Orders root exists', names.includes('Purchase Orders'));
  assert('cost-code folder is labelled from the master list', names.includes('420 · Paving'), names.join(' | '));
  assert('a cost code with no master-list label falls back to the bare code',
    names.includes('415'), names.join(' | '));
  assert('cost-code folders sort after the fixed set and in code order',
    names.indexOf('411 · Excavation') < names.indexOf('420 · Paving')
    && names.indexOf('Purchase Orders') < names.indexOf('411 · Excavation'), names.join(' | '));
  assert('cost_code column is populated for reporting',
    folders.find(f => f.name === '420 · Paving').cost_code === '420');

  const again = await call('PUT', { division: 'turf', projectId: PROJ }, {
    costCodes: [{ code: '420', label: 'Paving' }, { code: '411', label: 'Excavation' }, { code: '415', label: '' }],
  }, PM);
  assert('re-running creates nothing', again.body.created === 0, `created ${again.body.created}`);
  assert('and returns the same folder count', again.body.folders.length === folders.length);

  // A renamed folder must survive regeneration, or a PM's tidy-up is undone
  // every time the tab opens.
  const photos = folders.find(f => f.name === 'Photos');
  await client.query(`UPDATE project_folders SET name = 'Site Photos' WHERE id = $1`, [photos.id]);
  const third = await call('PUT', { division: 'turf', projectId: PROJ }, { costCodes: [] }, PM);
  const thirdNames = third.body.folders.map(f => f.name);
  assert('a renamed fixed folder is not recreated',
    thirdNames.includes('Site Photos') && !thirdNames.includes('Photos'), thirdNames.join(' | '));
  await client.query(`UPDATE project_folders SET name = 'Photos' WHERE id = $1`, [photos.id]);

  // Concurrent seeding — two users opening the same job at the same moment.
  await client.query(`DELETE FROM project_folders WHERE project_id = $1`, [PROJ]);
  const [a, b] = await Promise.all([
    call('PUT', { division: 'turf', projectId: PROJ }, { costCodes: [{ code: '420', label: 'Paving' }] }, PM),
    call('PUT', { division: 'turf', projectId: PROJ }, { costCodes: [{ code: '420', label: 'Paving' }] }, ADMIN),
  ]);
  const dupes = await client.query(
    `SELECT name, COUNT(*) FROM project_folders WHERE project_id = $1 GROUP BY name HAVING COUNT(*) > 1`, [PROJ]);
  assert('concurrent seeding does not duplicate folders', dupes.rows.length === 0,
    JSON.stringify(dupes.rows));
  assert('both concurrent callers get a usable tree',
    a.statusCode === 200 && b.statusCode === 200 && a.body.folders.length === b.body.folders.length);

  const tree    = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body.folders;
  const paving  = tree.find(f => f.cost_code === '420');
  const poRoot  = tree.find(f => f.name === 'Purchase Orders');
  const safety  = tree.find(f => f.name === 'Safety');

  // ── Upload + the two-way PO link ────────────────────────────────────────
  console.log('\nUpload and PO linking');
  const up = await upload(paving.id, 'ticket.pdf', FOREMAN, { poId: 'po-1042', note: '22.14 tons' });
  assert('foreman can upload', up.statusCode === 201, JSON.stringify(up.body));
  const docId = up.body.document.id;

  const listed = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body.documents;
  const doc = listed.find(d => d.id === docId);
  assert('the document is filed in the cost-code folder', doc.folder_ids.includes(paving.id));
  assert('and attached to the PO in the same action', doc.po_ids.includes('po-1042'));

  const stored = await client.query(`SELECT COUNT(*)::int AS n FROM project_documents WHERE id = $1`, [docId]);
  assert('reachable from both places but stored once', stored.rows[0].n === 1);

  const byPo = (await call('GET', { division: 'turf', poId: 'po-1042' }, null, PM)).body.documents;
  assert('the PO view finds it', byPo.length === 1 && byPo[0].id === docId);

  const counts = (await call('GET', { division: 'turf', poCounts: '1' }, null, PM)).body.counts;
  assert('paperclip count is 1', counts['po-1042'] === 1, JSON.stringify(counts));

  // The other direction: upload first, attach to a PO afterwards.
  const later = await upload(safety.id, 'invoice.pdf', PM);
  const linked = await call('PATCH', { division: 'turf', id: later.body.document.id },
    { addPoId: 'po-1042' }, PM);
  assert('a document can be attached to a PO after the fact',
    linked.body.document.po_ids.includes('po-1042'), JSON.stringify(linked.body));
  const counts2 = (await call('GET', { division: 'turf', poCounts: '1' }, null, PM)).body.counts;
  assert('the count follows', counts2['po-1042'] === 2, JSON.stringify(counts2));

  // Filing the same document into a second folder — one file, two homes.
  const filed = await call('PATCH', { division: 'turf', id: docId }, { addFolderId: poRoot.id }, PM);
  assert('a document can sit in two folders', filed.body.document.folder_ids.length === 2);
  const stillOne = await client.query(`SELECT COUNT(*)::int AS n FROM project_documents WHERE id = $1`, [docId]);
  assert('still one stored file', stillOne.rows[0].n === 1);

  // ── Unfiling must never strand a document ───────────────────────────────
  console.log('\nUnfile vs delete');
  const un1 = await call('PATCH', { division: 'turf', id: docId }, { removeFolderId: poRoot.id }, PM);
  assert('unfiling one of two folders is allowed', un1.statusCode === 200);
  const un2 = await call('PATCH', { division: 'turf', id: docId }, { removeFolderId: paving.id }, PM);
  assert('unfiling the last folder is refused', un2.statusCode === 400, JSON.stringify(un2.body));
  const survived = await client.query(`SELECT COUNT(*)::int AS n FROM document_links WHERE document_id = $1 AND link_type = 'folder'`, [docId]);
  assert('so the document keeps a folder', survived.rows[0].n === 1);

  // Unlinking a PO is not a delete.
  await call('PATCH', { division: 'turf', id: docId }, { removePoId: 'po-1042' }, PM);
  const afterUnlink = await client.query(`SELECT deleted_at FROM project_documents WHERE id = $1`, [docId]);
  assert('detaching from a PO leaves the file alone', afterUnlink.rows[0].deleted_at === null);

  // ── Permissions ─────────────────────────────────────────────────────────
  console.log('\nPermissions');
  const viewerUp = await upload(safety.id, 'nope.pdf', VIEWER);
  assert('level1 cannot upload', viewerUp.statusCode === 403, JSON.stringify(viewerUp.body));

  const viewerRead = await call('GET', { division: 'turf', projectId: PROJ }, null, VIEWER);
  assert('level1 can read', viewerRead.statusCode === 200 && viewerRead.body.documents.length > 0);
  assert('and is told what it may do', viewerRead.body.caps.canUpload === false && viewerRead.body.caps.canDelete === false);

  const foremanDelete = await call('DELETE', { division: 'turf', id: docId }, null, FOREMAN);
  assert('level2 cannot delete', foremanDelete.statusCode === 403);
  const pmDelete = await call('DELETE', { division: 'turf', id: docId }, null, PM);
  assert('level3 cannot delete either', pmDelete.statusCode === 403);

  // level2 tidies its own upload but not someone else's.
  const own = await upload(safety.id, 'mine.pdf', FOREMAN);
  const ownEdit = await call('PATCH', { division: 'turf', id: own.body.document.id }, { note: 'mine' }, FOREMAN);
  assert('level2 can edit its own upload', ownEdit.statusCode === 200);
  const othersEdit = await call('PATCH', { division: 'turf', id: later.body.document.id }, { note: 'not mine' }, FOREMAN);
  assert("level2 cannot edit someone else's upload", othersEdit.statusCode === 403);

  // ── Isolation ───────────────────────────────────────────────────────────
  console.log('\nIsolation');
  const pavingRead = await call('GET', { division: 'paving', projectId: PROJ }, null, PAVER);
  assert('a paving user sees no turf documents', pavingRead.body.documents.length === 0);
  const crossDiv = await call('GET', { division: 'turf', projectId: PROJ }, null, PAVER);
  assert('and is refused the turf division outright', crossDiv.statusCode === 403);

  const rival = await call('GET', { division: 'turf', projectId: PROJ }, null, OTHERCO);
  assert('another company sees nothing', rival.body.documents.length === 0 && rival.body.folders.length === 0);

  const rivalPatch = await call('PATCH', { division: 'turf', id: docId }, { note: 'pwned' }, OTHERCO);
  assert('and cannot touch a document by id', rivalPatch.statusCode === 404);

  // A storage key from another company must not be registerable.
  const badKey = await call('POST', { division: 'turf', projectId: PROJ }, {
    documentId: 'doc-evil', filename: 'x.pdf', storageKey: 'OTH/turf/p/d/x.pdf',
    folderId: safety.id, sizeBytes: 10,
  }, PM);
  assert('a storage key outside the company is refused', badKey.statusCode === 400, JSON.stringify(badKey.body));

  // ── Type rules ──────────────────────────────────────────────────────────
  console.log('\nFile types');
  const exe = await upload(safety.id, 'payload.exe', PM);
  assert('a non-allowlisted extension is refused', exe.statusCode === 400);
  const noFolder = await call('POST', { division: 'turf', projectId: PROJ }, {
    documentId: 'doc-nofolder', filename: 'x.pdf', storageKey: `FCT/turf/${PROJ}/doc-nofolder/x.pdf`, sizeBytes: 10,
  }, PM);
  assert('filing is required', noFolder.statusCode === 400, JSON.stringify(noFolder.body));

  const rename = await call('PATCH', { division: 'turf', id: later.body.document.id }, { filename: 'invoice.exe' }, PM);
  assert('a rename cannot change the file type', rename.statusCode === 400);
  const okRename = await call('PATCH', { division: 'turf', id: later.body.document.id }, { filename: 'invoice-signed.pdf' }, PM);
  assert('but a same-type rename works', okRename.statusCode === 200 && okRename.body.document.filename === 'invoice-signed.pdf');

  // ── Soft delete ─────────────────────────────────────────────────────────
  console.log('\nDeletion');
  const del = await call('DELETE', { division: 'turf', id: docId }, null, ADMIN);
  assert('admin can delete', del.statusCode === 200);
  const gone = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body.documents;
  assert('it leaves the listing', !gone.find(d => d.id === docId));

  const row = await client.query(`SELECT deleted_at, deleted_by, purge_after, storage_key FROM project_documents WHERE id = $1`, [docId]);
  assert('the row survives for recovery', row.rows.length === 1 && row.rows[0].deleted_at !== null);
  assert('stamped with who deleted it', row.rows[0].deleted_by === 'admin');
  const days = Math.round((new Date(row.rows[0].purge_after) - new Date(row.rows[0].deleted_at)) / 86400000);
  assert('and dated 30 days out', days === 30, `got ${days} days`);
  assert('the stored object is untouched', Boolean(row.rows[0].storage_key));

  const trash = (await call('GET', { division: 'turf', trash: '1' }, null, ADMIN)).body.documents;
  assert('it shows in the trash view', trash.some(d => d.id === docId));

  const counts3 = (await call('GET', { division: 'turf', poCounts: '1' }, null, PM)).body.counts;
  assert('a deleted document stops counting against its PO', (counts3['po-1042'] || 0) === 1, JSON.stringify(counts3));

  const restored = await call('PATCH', { division: 'turf', id: docId }, { restore: true }, ADMIN);
  assert('admin can restore', restored.statusCode === 200);
  const back = await client.query(`SELECT deleted_at FROM project_documents WHERE id = $1`, [docId]);
  assert('and the file is live again', back.rows[0].deleted_at === null);

  // ── General / Non-Job area ──────────────────────────────────────────────
  console.log('\nGeneral / Non-Job area');
  const gGen = await call('PUT', { division: 'turf' }, {}, PM);
  const gNames = gGen.body.folders.map(f => f.name);
  assert('the division-level area seeds its own buckets',
    ['Shop Supplies', 'Office', 'Unassigned POs'].every(n => gNames.includes(n)), gNames.join(' | '));
  assert('and does not inherit the job folders', !gNames.includes('Submittals'), gNames.join(' | '));

  const shop = gGen.body.folders.find(f => f.name === 'Shop Supplies');
  const shopDoc = await upload(shop.id, 'shop-po.pdf', PM, { projectId: null, poId: 'po-9001' });
  assert('a non-job PO can file paperwork there', shopDoc.statusCode === 201, JSON.stringify(shopDoc.body));
  const genList = (await call('GET', { division: 'turf' }, null, PM)).body.documents;
  assert('which reads back from the general area', genList.some(d => d.id === shopDoc.body.document.id));
  const jobList = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body.documents;
  assert('and does not leak into a job', !jobList.some(d => d.id === shopDoc.body.document.id));

  // ── Folder housekeeping ─────────────────────────────────────────────────
  console.log('\nFolder housekeeping');
  const mk = await call('POST', { division: 'turf', projectId: PROJ, folder: '1' },
    { name: 'Punch List', parentId: safety.id }, PM);
  assert('a user folder can be created', mk.statusCode === 201);
  const dupe = await call('POST', { division: 'turf', projectId: PROJ, folder: '1' },
    { name: 'punch list', parentId: safety.id }, PM);
  assert('a duplicate name under the same parent is refused', dupe.statusCode === 409);

  const rmFixed = await call('DELETE', { division: 'turf', folderId: safety.id }, null, PM);
  assert('a standard folder cannot be deleted', rmFixed.statusCode === 400);
  const rmCost = await call('DELETE', { division: 'turf', folderId: paving.id }, null, PM);
  assert('nor a cost-code folder', rmCost.statusCode === 400);
  const rmUser = await call('DELETE', { division: 'turf', folderId: mk.body.folder.id }, null, PM);
  assert('an empty user folder can be deleted', rmUser.statusCode === 200);

  // ── Audit trail ─────────────────────────────────────────────────────────
  console.log('\nAudit trail');
  const log = await client.query(`SELECT action, actor, document_id FROM document_audit_log ORDER BY id`);
  const actions = log.rows.map(r => r.action);
  for (const a of ['UPLOAD', 'DELETE', 'RESTORE', 'LINK', 'UNLINK', 'RENAME', 'FOLDER_CREATE', 'FOLDER_DELETE']) {
    assert(`${a} is recorded`, actions.includes(a), actions.join(', '));
  }
  const delEntry = log.rows.find(r => r.action === 'DELETE');
  assert('the delete entry names who did it', delEntry && delEntry.actor === 'admin');

  console.log(`\n${passed} passed, ${failed} failed.`);
  await client.end();
  process.exit(failed ? 1 : 0);
})().catch(async err => {
  console.error('\nTest run failed:', err);
  try { await client.end(); } catch {}
  process.exit(1);
});
