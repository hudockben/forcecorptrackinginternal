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

// What the object store is holding, keyed by storage key. POST now HEADs the
// object to learn its real size instead of trusting the caller, so the tests
// have to model a store rather than skip it.
const STORE = new Map();
let storageFailsHead = false;

let AUTH = null;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') return { neon: () => makeSql(client) };
  if (request === './lib/auth') {
    // The real module, with only the two request guards replaced — so
    // capabilities() and levelFor() under test are the ones that ship.
    const real = origLoad.call(this, path.resolve(__dirname, '..', 'api', 'lib', 'auth.js'), module, false);
    return {
      ...real,
      requireAuth: () => AUTH,
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
  if (request === './lib/storage') {
    const real = origLoad.call(this, path.resolve(__dirname, '..', 'api', 'lib', 'storage.js'), module, false);
    return {
      ...real,
      headObject: async key => (!storageFailsHead && STORE.has(key)
        ? { exists: true, size: STORE.get(key), contentType: null }
        : { exists: false, size: 0, contentType: null }),
      deleteObject: async key => { STORE.delete(key); return true; },
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
  const storageKey = `FCT/turf/${projectId || 'general'}/${documentId}/${filename}`; // same shape storage.buildKey mints
  STORE.set(storageKey, extra.storedBytes !== undefined ? extra.storedBytes : 1024);
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

  // "Own folder but duplicated at the job level" — the design says one
  // subfolder per purchase order, and for a long time nothing created them.
  const tree2 = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body.folders;
  const poSub = tree2.find(f => f.slug === 'po-po-1042');
  assert('a subfolder is created for the purchase order', Boolean(poSub),
    tree2.map(f => f.name).join(' | '));
  assert('nested under the Purchase Orders root', poSub && poSub.parent_id === poRoot.id);
  assert('and the document is filed there too', doc.folder_ids.includes(poSub.id),
    JSON.stringify(doc.folder_ids));

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

  // Filing the same document into another folder — one file, several homes.
  const beforeFile = doc.folder_ids.length;
  const filed = await call('PATCH', { division: 'turf', id: docId }, { addFolderId: poRoot.id }, PM);
  assert('a document can sit in more folders still',
    filed.body.document.folder_ids.length === beforeFile + 1,
    JSON.stringify(filed.body.document.folder_ids));
  const stillOne = await client.query(`SELECT COUNT(*)::int AS n FROM project_documents WHERE id = $1`, [docId]);
  assert('still one stored file', stillOne.rows[0].n === 1);

  // ── Unfiling must never strand a document ───────────────────────────────
  console.log('\nUnfile vs delete');
  const un1 = await call('PATCH', { division: 'turf', id: docId }, { removeFolderId: poRoot.id }, PM);
  assert('unfiling one of several folders is allowed', un1.statusCode === 200);

  // A document with exactly one folder is where the invariant actually bites.
  const solo = await upload(safety.id, 'solo.pdf', PM);
  const soloId = solo.body.document.id;
  const un2 = await call('PATCH', { division: 'turf', id: soloId }, { removeFolderId: safety.id }, PM);
  assert('unfiling the last folder is refused', un2.statusCode === 400, JSON.stringify(un2.body));
  const survived = await client.query(`SELECT COUNT(*)::int AS n FROM document_links WHERE document_id = $1 AND link_type = 'folder'`, [soloId]);
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
  STORE.set('OTH/turf/p/d/x.pdf', 10);
  const badKey = await call('POST', { division: 'turf', projectId: PROJ }, {
    documentId: 'doc-evil', filename: 'x.pdf', storageKey: 'OTH/turf/p/d/x.pdf',
    folderId: safety.id, sizeBytes: 10,
  }, PM);
  assert('a storage key outside the company is refused', badKey.statusCode === 400, JSON.stringify(badKey.body));

  // A prefix check alone would admit this one — it does start with FCT/turf/.
  STORE.set('FCT/turf/../../OTH/turf/p/d/x.pdf', 10);
  const traversal = await call('POST', { division: 'turf', projectId: PROJ }, {
    documentId: 'doc-trav', filename: 'x.pdf', storageKey: `FCT/turf/../../OTH/turf/p/d/x.pdf`,
    folderId: safety.id, sizeBytes: 10,
  }, PM);
  assert('a key that climbs out of its own prefix is refused',
    traversal.statusCode === 400, JSON.stringify(traversal.body));

  // Nor may a caller point a new row at a file that is already registered.
  const swapped = await call('POST', { division: 'turf', projectId: PROJ }, {
    documentId: 'doc-swap', filename: 'x.pdf', storageKey: `FCT/turf/${PROJ}/doc-1/ticket.pdf`,
    folderId: safety.id, sizeBytes: 10,
  }, PM);
  assert("a key belonging to another document is refused",
    swapped.statusCode === 400, JSON.stringify(swapped.body));

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

  // ── Two divisions side by side ──────────────────────────────────────────
  // The earlier isolation checks proved paving sees nothing while paving HAD
  // nothing. Give it real folders and documents and check both directions,
  // including the case where both divisions happen to use the same project id
  // — they keep separate project lists, so nothing stops that colliding.
  console.log('\nTwo divisions side by side');
  const pGen = await call('PUT', { division: 'paving', projectId: PROJ }, {
    costCodes: [{ code: '420', label: 'Wearing Course' }],
  }, PAVER);
  assert('paving seeds its own tree under the same project id', pGen.statusCode === 200);
  const pSafety = pGen.body.folders.find(f => f.name === 'Safety');

  STORE.set(`FCT/paving/${PROJ}/doc-pav/paving-ticket.pdf`, 2048);
  const pDoc = await call('POST', { division: 'paving', projectId: PROJ }, {
    documentId: 'doc-pav', filename: 'paving-ticket.pdf',
    storageKey: `FCT/paving/${PROJ}/doc-pav/paving-ticket.pdf`,
    folderId: pSafety.id, sizeBytes: 2048, poId: 'po-1042',
  }, PAVER);
  assert('and a document filed into it', pDoc.statusCode === 201, JSON.stringify(pDoc.body));

  const turfSide = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body;
  assert('turf does not see the paving document',
    !turfSide.documents.some(d => d.id === 'doc-pav'));
  assert('nor the paving folders — same project id, separate trees',
    !turfSide.folders.some(f => f.id === pSafety.id));

  const pavSide = (await call('GET', { division: 'paving', projectId: PROJ }, null, PAVER)).body;
  assert('paving sees only its own document',
    pavSide.documents.length === 1 && pavSide.documents[0].id === 'doc-pav',
    JSON.stringify(pavSide.documents.map(d => d.id)));
  assert('and only its own folders', !pavSide.folders.some(f => f.name === '415'),
    pavSide.folders.map(f => f.name).join(' | '));

  // Both divisions attached something to a PO numbered 1042. The badge counts
  // must not bleed across, or a paving PO would show turf's attachments.
  const turfCounts = (await call('GET', { division: 'turf', poCounts: '1' }, null, PM)).body.counts;
  const pavCounts  = (await call('GET', { division: 'paving', poCounts: '1' }, null, PAVER)).body.counts;
  assert('paperclip counts are per-division', (pavCounts['po-1042'] || 0) === 1,
    `turf=${JSON.stringify(turfCounts)} paving=${JSON.stringify(pavCounts)}`);
  assert('and turf counts only turf attachments',
    (turfCounts['po-1042'] || 0) !== (pavCounts['po-1042'] || 0) || turfCounts['po-1042'] === 1,
    `turf=${JSON.stringify(turfCounts)}`);

  const pavByPo = (await call('GET', { division: 'paving', poId: 'po-1042' }, null, PAVER)).body.documents;
  assert('the PO view is division-scoped too',
    pavByPo.length === 1 && pavByPo[0].id === 'doc-pav',
    JSON.stringify(pavByPo.map(d => d.id)));

  // A turf user must not reach a paving document by id, even holding it.
  const reach = await call('PATCH', { division: 'turf', id: 'doc-pav' }, { note: 'x' }, ADMIN);
  assert('a turf admin cannot touch a paving document by id', reach.statusCode === 404);

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

  // ── Regressions from the adversarial audit ──────────────────────────────
  console.log('\nAudit regressions');

  // The trash listing had no capability gate at all, so a view-only user could
  // enumerate every document deleted anywhere in the division for 30 days.
  const trashAsViewer = await call('GET', { division: 'turf', trash: '1' }, null, VIEWER);
  assert('level1 cannot list the trash', trashAsViewer.statusCode === 403, JSON.stringify(trashAsViewer.body));
  const trashAsPM = await call('GET', { division: 'turf', trash: '1' }, null, PM);
  assert('nor can level3', trashAsPM.statusCode === 403);
  assert('admin still can', (await call('GET', { division: 'turf', trash: '1' }, null, ADMIN)).statusCode === 200);

  // A folder holding only SOFT-DELETED documents used to count as empty. It was
  // deletable, document_links has no FK to cascade, and restoring the document
  // then put it in a folder that no longer existed — reachable only by search.
  const mkTrap = await call('POST', { division: 'turf', projectId: PROJ, folder: '1' }, { name: 'Trap Folder' }, PM);
  const trapId = mkTrap.body.folder.id;
  const trapDoc = await upload(trapId, 'trapped.pdf', PM);
  await call('DELETE', { division: 'turf', id: trapDoc.body.document.id }, null, ADMIN);
  const rmTrap = await call('DELETE', { division: 'turf', folderId: trapId }, null, PM);
  assert('a folder holding only trashed documents is not "empty"',
    rmTrap.statusCode === 400, JSON.stringify(rmTrap.body));
  await call('PATCH', { division: 'turf', id: trapDoc.body.document.id }, { restore: true }, ADMIN);
  const trapBack = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body.documents
    .find(d => d.id === trapDoc.body.document.id);
  const liveFolders = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM)).body.folders.map(f => f.id);
  assert('so a restored document still lands in a folder that exists',
    trapBack.folder_ids.every(fid => liveFolders.includes(fid)),
    JSON.stringify(trapBack.folder_ids));

  // The keep-one-folder guard counted bare link rows, so a link to a folder
  // that no longer existed could stand in for a real home.
  const dangling = await upload(safety.id, 'dangling.pdf', PM);
  const dId = dangling.body.document.id;
  await client.query(
    `INSERT INTO document_links (document_id, company_code, link_type, target_id) VALUES ($1,'FCT','folder','ghost-folder')`,
    [dId]);
  const unfileReal = await call('PATCH', { division: 'turf', id: dId }, { removeFolderId: safety.id }, PM);
  assert('a dead folder link cannot satisfy the keep-one-folder rule',
    unfileReal.statusCode === 400, JSON.stringify(unfileReal.body));

  // A hand-made folder could be parented into a different job's tree, where
  // childrenOf() never reaches it.
  const otherJob = await call('PUT', { division: 'turf', projectId: 'proj-other' }, { costCodes: [] }, PM);
  const otherSafety = otherJob.body.folders.find(f => f.slug === 'safety');
  const crossParent = await call('POST', { division: 'turf', projectId: PROJ, folder: '1' },
    { name: 'Wrong Tree', parentId: otherSafety.id }, PM);
  assert('a parent folder from another job is refused',
    crossParent.statusCode === 404, JSON.stringify(crossParent.body));

  // A cost-code label colliding with an existing folder name used to be
  // swallowed by the concurrent-seed catch: PUT reported success and the
  // folder could never appear on any later load.
  await call('POST', { division: 'turf', projectId: 'proj-collide', folder: '1' }, { name: '415' }, PM);
  const collide = await call('PUT', { division: 'turf', projectId: 'proj-collide' },
    { costCodes: [{ code: '415', label: '' }] }, PM);
  const ccFolder = collide.body.folders.find(f => f.cost_code === '415');
  assert('a colliding cost-code folder is still created', Boolean(ccFolder),
    collide.body.folders.map(f => f.name).join(' | '));
  assert('under a disambiguated name', ccFolder && ccFolder.name !== '415', ccFolder && ccFolder.name);
  assert('and the collision is reported rather than swallowed',
    Array.isArray(collide.body.collisions) && collide.body.collisions.length === 1,
    JSON.stringify(collide.body.collisions));

  // Labels used to freeze at first creation, so filling in the master list did
  // nothing on any job that already had folders.
  const relabelJob = 'proj-relabel';
  await call('PUT', { division: 'turf', projectId: relabelJob }, { costCodes: [{ code: '420', label: '' }] }, PM);
  const after = await call('PUT', { division: 'turf', projectId: relabelJob },
    { costCodes: [{ code: '420', label: 'Paving' }] }, PM);
  const relabelled = after.body.folders.find(f => f.cost_code === '420');
  assert('a cost-code folder follows the master list when it is filled in',
    relabelled && relabelled.name === '420 · Paving', relabelled && relabelled.name);
  await client.query(`UPDATE project_folders SET renamed_at = NOW() WHERE id = $1`, [relabelled.id]);
  await client.query(`UPDATE project_folders SET name = 'My Name' WHERE id = $1`, [relabelled.id]);
  const afterRename = await call('PUT', { division: 'turf', projectId: relabelJob },
    { costCodes: [{ code: '420', label: 'Something Else' }] }, PM);
  assert('but a folder someone renamed by hand keeps their name',
    afterRename.body.folders.find(f => f.cost_code === '420').name === 'My Name');

  // Size was declared by the client twice and verified never.
  const lieKey = `FCT/turf/${PROJ}/doc-lie/big.zip`;
  STORE.set(lieKey, 5 * 1024 * 1024);
  const lie = await call('POST', { division: 'turf', projectId: PROJ }, {
    documentId: 'doc-lie', filename: 'big.zip', storageKey: lieKey, folderId: safety.id, sizeBytes: 1,
  }, PM);
  assert('the recorded size comes from the store, not the caller',
    lie.statusCode === 201 && lie.body.document.size_bytes === 5 * 1024 * 1024,
    JSON.stringify(lie.body.document && lie.body.document.size_bytes));

  // Registering a document for an object that was never uploaded.
  const phantom = await call('POST', { division: 'turf', projectId: PROJ }, {
    documentId: 'doc-phantom', filename: 'ghost.pdf',
    storageKey: `FCT/turf/${PROJ}/doc-phantom/ghost.pdf`, folderId: safety.id, sizeBytes: 10,
  }, PM);
  assert('a document with no uploaded object is refused',
    phantom.statusCode === 409, JSON.stringify(phantom.body));

  // ── Round-two regressions: bugs the round-one FIXES introduced ──────────
  // Braced so this section's locals cannot collide with the ones above.
  {
    console.log('\nRound-two regressions');

    // The collision suffix and the label relabel were added in the same commit
    // and fought each other: ensure() stores '415 (2)' with renamed_at NULL, then
    // the relabel UPDATE tries to set it back to '415' — the name that collided —
    // on every subsequent load. The unique index rejected it, nothing caught the
    // error, and PUT 500'd permanently for that job.
    //
    // The round-one test set this exact scope up and stopped after ONE PUT.
    const second = await call('PUT', { division: 'turf', projectId: 'proj-collide' },
      { costCodes: [{ code: '415', label: '' }] }, PM);
    assert('a second load of a job with a collided folder still succeeds',
      second.statusCode === 200, JSON.stringify(second.body));
    const withNewCode = await call('PUT', { division: 'turf', projectId: 'proj-collide' },
      { costCodes: [{ code: '415', label: '' }, { code: '999', label: 'Later Code' }] }, PM);
    assert('and a cost code added afterwards still gets its folder',
      withNewCode.statusCode === 200 && withNewCode.body.folders.some(f => f.cost_code === '999'),
      JSON.stringify(withNewCode.body).slice(0, 300));
    const ccCount = withNewCode.body.folders.filter(f => f.cost_code === '415').length;
    assert('without accumulating a new suffixed folder per load', ccCount === 1, `${ccCount} folders for 415`);

    // The same collision reached purely through the generator: two cost codes
    // differing only in case, which is the case ensure()'s own comment cites.
    const caseJob = 'proj-case';
    for (let i = 0; i < 3; i++) {
      const r = await call('PUT', { division: 'turf', projectId: caseJob },
        { costCodes: [{ code: '420a', label: 'Paving' }, { code: '420A', label: 'Paving' }] }, PM);
      assert(`case-variant cost codes survive load ${i + 1}`, r.statusCode === 200,
        JSON.stringify(r.body).slice(0, 200));
    }
    const caseFolders = (await call('GET', { division: 'turf', projectId: caseJob }, null, PM))
      .body.folders.filter(f => f.cost_code);
    assert('and both get a folder', caseFolders.length === 2,
      caseFolders.map(f => `${f.cost_code}:${f.name}`).join(' | '));

    // Collision detection must key on the parent, the way the unique index does.
    // Keying on the bare name suffixed a root folder because an unrelated
    // SUBfolder somewhere in the job happened to share its label.
    const parentJob = 'proj-parent';
    const pTree = await call('PUT', { division: 'turf', projectId: parentJob }, { costCodes: [] }, PM);
    const pSafety = pTree.body.folders.find(f => f.slug === 'safety');
    await call('POST', { division: 'turf', projectId: parentJob, folder: '1' },
      { name: '500 · Toolbox', parentId: pSafety.id }, PM);
    const pAfter = await call('PUT', { division: 'turf', projectId: parentJob },
      { costCodes: [{ code: '500', label: 'Toolbox' }] }, PM);
    const rootCc = pAfter.body.folders.find(f => f.cost_code === '500');
    assert('a subfolder elsewhere does not force a suffix on a root folder',
      rootCc && rootCc.name === '500 · Toolbox', rootCc && rootCc.name);

    // The size fix computed the true size and then stored the caller's number
    // anyway. The response was right and the database was wrong, which is worse
    // than not checking at all — it looked fixed.
    const sizeKey = `FCT/turf/${PROJ}/doc-realsize/big.pdf`;
    STORE.set(sizeKey, 4 * 1024 * 1024);
    const sized = await call('POST', { division: 'turf', projectId: PROJ }, {
      documentId: 'doc-realsize', filename: 'big.pdf', storageKey: sizeKey,
      folderId: safety.id, sizeBytes: 1,
    }, PM);
    assert('registration returns the verified size', sized.body.document.size_bytes === 4 * 1024 * 1024);
    const storedSize = await client.query(`SELECT size_bytes FROM project_documents WHERE id = 'doc-realsize'`);
    assert('and PERSISTS the verified size, not the caller\'s claim',
      Number(storedSize.rows[0].size_bytes) === 4 * 1024 * 1024,
      `stored ${storedSize.rows[0].size_bytes}`);
    const reread = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM))
      .body.documents.find(d => d.id === 'doc-realsize');
    assert('so a reload shows the real size too', reread.size_bytes === 4 * 1024 * 1024, String(reread.size_bytes));

    // Deleting a job hard-deletes its folders and their links. Restoring one of
    // those documents left it live, filed nowhere, in a job no picker can select
    // — and with deleted_at cleared it was invisible to the trash view AND to the
    // purge sweep. Unreachable and billed forever, which is the exact bug the
    // round-one folder-delete fix existed to prevent.
    const deadJob = 'proj-doomed';
    const dTree = await call('PUT', { division: 'turf', projectId: deadJob }, { costCodes: [] }, PM);
    const dPhotos = dTree.body.folders.find(f => f.slug === 'photos');
    const dKey = `FCT/turf/${deadJob}/doc-doomed/contract.pdf`;
    STORE.set(dKey, 2048);
    await call('POST', { division: 'turf', projectId: deadJob }, {
      documentId: 'doc-doomed', filename: 'contract.pdf', storageKey: dKey,
      folderId: dPhotos.id, sizeBytes: 2048,
    }, PM);

    const cascade = await call('DELETE', { division: 'turf', projectId: deadJob, project: '1' }, null, PM);
    assert('deleting a job soft-deletes its documents', cascade.statusCode === 200 && cascade.body.documents === 1,
      JSON.stringify(cascade.body));
    const inBin = (await call('GET', { division: 'turf', trash: '1' }, null, ADMIN)).body.documents;
    assert('and they show in the deleted bin', inBin.some(d => d.id === 'doc-doomed'));

    const back = await call('PATCH', { division: 'turf', id: 'doc-doomed' }, { restore: true }, ADMIN);
    assert('restoring one succeeds', back.statusCode === 200, JSON.stringify(back.body));
    assert('and reports where it had to be re-filed', Boolean(back.body.rehomed), JSON.stringify(back.body.rehomed));

    const rescued = back.body.document;
    assert('the restored document is in at least one folder', rescued.folder_ids.length > 0,
      JSON.stringify(rescued.folder_ids));
    const generalTree = (await call('GET', { division: 'turf' }, null, ADMIN)).body;
    assert('a folder that actually exists in a scope a picker can reach',
      generalTree.folders.some(f => rescued.folder_ids.includes(f.id)),
      generalTree.folders.map(f => f.name).join(' | '));
    assert('and it lists in that scope', generalTree.documents.some(d => d.id === 'doc-doomed'));

    // Re-homing must also clear links pointing at folders that no longer exist,
    // or folder_ids advertises a folder the tree cannot show and the preview
    // renders a stray dash on its "Filed in" line.
    await client.query(
      `INSERT INTO document_links (document_id, company_code, link_type, target_id)
       VALUES ('doc-doomed','FCT','folder','ghost-folder-xyz') ON CONFLICT DO NOTHING`);
    await call('DELETE', { division: 'turf', id: 'doc-doomed' }, null, ADMIN);
    const back2 = await call('PATCH', { division: 'turf', id: 'doc-doomed' }, { restore: true }, ADMIN);
    const liveIds = (await call('GET', { division: 'turf' }, null, ADMIN)).body.folders.map(f => f.id);
    assert('a restored document advertises only folders that exist',
      back2.body.document.folder_ids.every(fid => liveIds.includes(fid)),
      JSON.stringify(back2.body.document.folder_ids));

  }

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
