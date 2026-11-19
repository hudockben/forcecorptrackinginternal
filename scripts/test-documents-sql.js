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
 * and document_audit_log, and inserts (then removes) procurement_items rows
 * with ids starting 'dpr-' and app_data job blobs for 'proj-proc-*'. Seeds the
 * FCT turf and paving and the OTH turf purchase-order lists, and puts back
 * whatever they held. Refuses to run against a database whose name does not
 * look like a test database.
 *
 * Drives the real handler against a real PostgreSQL, so what is asserted is
 * what the database actually does:
 *
 *   - folder generation is idempotent, and survives two users opening the
 *     same job at once (the unique index is the referee)
 *   - a document filed in a cost-code folder and attached to a PO is ONE row
 *     reachable from both, which is the whole premise of document_links
 *   - a document attached to a Procurement line is filed in the line's
 *     cost-code folder too (made if missing, found ignoring case and spaces),
 *     with per-job counts and the same scoping and permission rules
 *   - a document attached to a purchase order's delivery line is on the line,
 *     on the order, in the order's PO subfolder and in the cost-code folder of
 *     the line's code (else the order's), checked against the seeded PO list
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

// The procurement lines and job blobs the attachment checks insert. They live
// outside the four truncated tables, so they are removed by hand — before the
// checks (a crashed earlier run) and after them.
async function cleanProcurement() {
  await client.query(`DELETE FROM procurement_items WHERE id LIKE 'dpr-%'`);
  await client.query(`DELETE FROM app_data WHERE key LIKE 'FCT:fct_project_proj-proc-%'`);
  await client.query(`DELETE FROM app_data WHERE key = 'FCT:fct_purchase_orders:turf' AND value::text LIKE '%po-proc-carve%'`);
}

// The PO lists the delivery-line checks seed. Each is one shared app_data row,
// so whatever it held is saved first and put back afterwards (or removed, when
// there was none) — after a crash too.
const PO_BLOB_KEYS = ['FCT:fct_purchase_orders:turf', 'FCT:fct_purchase_orders:paving', 'OTH:fct_purchase_orders:turf'];
let savedPoBlobs = null;
async function savePoBlobs() {
  savedPoBlobs = new Map();
  for (const key of PO_BLOB_KEYS) {
    const row = (await client.query(`SELECT value FROM app_data WHERE key = $1`, [key])).rows[0];
    savedPoBlobs.set(key, row ? row.value : undefined);
  }
}
async function restorePoBlobs() {
  if (!savedPoBlobs) return;
  for (const [key, value] of savedPoBlobs) {
    if (value === undefined) await client.query(`DELETE FROM app_data WHERE key = $1`, [key]);
    else await client.query(`UPDATE app_data SET value = $1::jsonb WHERE key = $2`, [JSON.stringify(value), key]);
  }
  savedPoBlobs = null;
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
  const STANDARD = ['Contract', 'Change Orders', 'Permits & Insurance', 'Submittals',
                    'Safety', 'Photos', 'Repairs', 'Closeout'];
  assert('every standard folder exists', STANDARD.every(n => names.includes(n)), names.join(' | '));
  assert('and they render in the order the list declares them',
    names.slice(0, STANDARD.length).join('|') === STANDARD.join('|'), names.join(' | '));
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
  assert('and moves nothing, since the tree is already in order',
    again.body.reordered === 0, `reordered ${again.body.reordered}`);

  // ── Changing the standard list has to reach the jobs that already have a
  // tree. Wind this job back to what an older release left behind: no Repairs
  // and no Change Orders folder, the contract folder still carrying both jobs
  // in its name, and the numbering that went with all that.
  const CC = [{ code: '420', label: 'Paving' }, { code: '411', label: 'Excavation' }, { code: '415', label: '' }];
  await client.query(
    `DELETE FROM project_folders WHERE project_id = $1 AND slug IN ('repairs', 'change-orders')`, [PROJ]);
  await client.query(
    `UPDATE project_folders SET name = 'Contract & Change Orders' WHERE project_id = $1 AND slug = 'contract-change-orders'`,
    [PROJ]);
  // 0 contract, 1 permits, 2 submittals, 3 safety, 4 photos, 5 closeout,
  // 6 Purchase Orders, 7+ cost codes — the numbering before either folder
  // joined the list.
  const OLD_ORDER = ['contract-change-orders', 'permits-insurance', 'submittals', 'safety',
                     'photos', 'closeout', 'purchase-orders', 'cc-411', 'cc-415', 'cc-420'];
  for (let i = 0; i < OLD_ORDER.length; i++) {
    await client.query(`UPDATE project_folders SET sort_order = $1 WHERE project_id = $2 AND slug = $3`,
      [i, PROJ, OLD_ORDER[i]]);
  }

  const legacy = await call('PUT', { division: 'turf', projectId: PROJ }, { costCodes: CC }, PM);
  const legacyNames = legacy.body.folders.map(f => f.name);
  assert('an existing job gets the folders that joined the list since it was seeded',
    legacyNames.includes('Repairs') && legacyNames.includes('Change Orders'), legacyNames.join(' | '));
  assert('exactly those two are created', legacy.body.created === 2, `created ${legacy.body.created}`);
  assert('and a standard folder that was split follows its new name',
    legacyNames.includes('Contract') && !legacyNames.includes('Contract & Change Orders'),
    legacyNames.join(' | '));
  assert('reported as a relabel, not as a second folder',
    legacy.body.relabelled === 1, `relabelled ${legacy.body.relabelled}`);
  assert('everything lands where the list puts it, not after the numbering it inherited',
    legacyNames.join('|') === [...STANDARD, 'Purchase Orders', '411 · Excavation', '415', '420 · Paving'].join('|'),
    legacyNames.join(' | '));
  assert('and the folders they displaced are renumbered, and say so',
    legacy.body.reordered === 9, `reordered ${legacy.body.reordered}`);

  // Once straightened out it stays straight — none of that may run again on
  // every single load.
  const settled = await call('PUT', { division: 'turf', projectId: PROJ }, { costCodes: CC }, PM);
  assert('and the next load moves nothing',
    settled.body.reordered === 0 && settled.body.relabelled === 0 && settled.body.created === 0,
    JSON.stringify({ reordered: settled.body.reordered, relabelled: settled.body.relabelled, created: settled.body.created }));

  // The documents already filed in the folder that was renamed stay in it —
  // a split must not strand a job's contract paperwork.
  const contractFolder = legacy.body.folders.find(f => f.name === 'Contract');
  const contractDoc = await upload(contractFolder.id, 'signed-contract.pdf', PM);
  assert('a document filed in the renamed folder is still filed there',
    contractDoc.statusCode === 201
      && contractDoc.body.document.folder_ids.includes(contractFolder.id),
    JSON.stringify(contractDoc.body));

  // A folder renamed by hand must survive regeneration, or a PM's tidy-up is
  // undone every time the tab opens. renamed_at is what marks it as theirs —
  // the generator owns the name of every folder that carries no such mark,
  // which is how a split or a relabel reaches a job that already has a tree.
  const photos = folders.find(f => f.name === 'Photos');
  await client.query(
    `UPDATE project_folders SET name = 'Site Photos', renamed_at = NOW() WHERE id = $1`, [photos.id]);
  const third = await call('PUT', { division: 'turf', projectId: PROJ }, { costCodes: [] }, PM);
  const thirdNames = third.body.folders.map(f => f.name);
  assert('a folder renamed by hand is neither recreated nor relabelled',
    thirdNames.includes('Site Photos') && !thirdNames.includes('Photos'), thirdNames.join(' | '));

  // Same folder, mark cleared: now the list owns the name again.
  await client.query(
    `UPDATE project_folders SET renamed_at = NULL WHERE id = $1`, [photos.id]);
  const fourth = await call('PUT', { division: 'turf', projectId: PROJ }, { costCodes: [] }, PM);
  const fourthNames = fourth.body.folders.map(f => f.name);
  assert('an unmarked folder follows the name the list declares',
    fourthNames.includes('Photos') && !fourthNames.includes('Site Photos'), fourthNames.join(' | '));

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
  const GENERAL = ['Shop Supplies', 'Office', 'Repairs', 'Unassigned POs'];
  assert('the division-level area seeds its own buckets',
    GENERAL.every(n => gNames.includes(n)), gNames.join(' | '));
  assert('in the order the list declares them',
    gNames.slice(0, GENERAL.length).join('|') === GENERAL.join('|'), gNames.join(' | '));
  assert('and does not inherit the job folders', !gNames.includes('Submittals'), gNames.join(' | '));

  // Repairs exists in both scopes under the same slug. The unique index keys a
  // slug per project, so these have to be two folders — one folder shared
  // between the shop and every job would put a job's repair paperwork in front
  // of anyone who opened the division-level area.
  const genRepairs = gGen.body.folders.find(f => f.name === 'Repairs');
  const jobRepairs = (await call('GET', { division: 'turf', projectId: PROJ }, null, PM))
    .body.folders.find(f => f.name === 'Repairs');
  assert('the shop\'s Repairs and a job\'s are different folders',
    Boolean(genRepairs) && Boolean(jobRepairs) && genRepairs.id !== jobRepairs.id,
    `${genRepairs && genRepairs.id} vs ${jobRepairs && jobRepairs.id}`);

  // The division-level area is seeded by its own branch, so wind it back the
  // same way and check a newly standard bucket lands in place there too.
  await client.query(`DELETE FROM project_folders WHERE project_id IS NULL AND division = 'turf' AND slug = 'repairs'`);
  await client.query(
    `UPDATE project_folders SET sort_order = 2 WHERE project_id IS NULL AND division = 'turf' AND slug = 'unassigned-pos'`);
  const gLegacy = await call('PUT', { division: 'turf' }, {}, PM);
  const gLegacyNames = gLegacy.body.folders.map(f => f.name);
  assert('an existing division-level area gets it too, in place',
    gLegacyNames.slice(0, GENERAL.length).join('|') === GENERAL.join('|'), gLegacyNames.join(' | '));
  assert('creating one folder and moving the one it displaced',
    gLegacy.body.created === 1 && gLegacy.body.reordered === 1,
    `created ${gLegacy.body.created}, reordered ${gLegacy.body.reordered}`);

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

  // ── Procurement line attachments ────────────────────────────────────────
  // A file attached to a line on the Procurement sheet is one document with a
  // 'procurement' link to the line, filed in the folder the person picked AND
  // in the folder for the line's cost code — so each cost-code folder compiles
  // every attachment of its section. Braced so these locals stay local.
  {
    console.log('\nProcurement line attachments');
    const PJ  = 'proj-proc-1';
    const PJ2 = 'proj-proc-2';
    const PJ3 = 'proj-proc-3';
    await cleanProcurement();
    // upload() files into PROJ by default; these checks work on their own jobs.
    const att = (folderId, filename, auth, extra = {}) => upload(folderId, filename, auth, { projectId: PJ, ...extra });

    const procRow = (id, o = {}) => client.query(
      `INSERT INTO procurement_items (id, company_code, division, project_id, source, bid_item_id, cost_code, sub_code, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, o.company || 'FCT', o.division || 'turf', o.projectId || PJ, o.bidItemId ? 'bid' : 'manual',
       o.bidItemId || null, o.costCode === undefined ? '' : o.costCode, o.subCode || '', o.deletedAt || null]);
    const docRow = async id => (await call('GET', { division: 'turf', projectId: PJ }, null, PM))
      .body.documents.find(d => d.id === id);
    const countsFor = async (pid, auth = PM, division = 'turf') =>
      (await call('GET', { division, procurementCounts: '1', projectId: pid }, null, auth)).body.counts;
    const docsStored = async id =>
      (await client.query(`SELECT COUNT(*)::int AS n FROM project_documents WHERE id = $1`, [id])).rows[0].n;
    const ccFolders = async (pid, code) => (await client.query(
      `SELECT * FROM project_folders WHERE company_code = 'FCT' AND division = 'turf' AND project_id = $1
         AND kind = 'cost_code' AND lower(btrim(cost_code)) = lower(btrim($2))`, [pid, code])).rows;

    // The job's tree, seeded the way the Documents tab seeds it from the bid.
    const seeded = await call('PUT', { division: 'turf', projectId: PJ }, {
      costCodes: [{ code: '420', label: 'Paving' }, { code: 'Stormwater', label: '' }],
    }, PM);
    const tree = seeded.body.folders;
    const fSafety = tree.find(f => f.slug === 'safety');
    const fPhotos = tree.find(f => f.slug === 'photos');
    const fPaving = tree.find(f => f.cost_code === '420');
    const fStorm  = tree.find(f => f.cost_code === 'Stormwater');
    assert('the procurement job has its cost-code folders seeded', Boolean(fSafety && fPaving && fStorm),
      tree.map(f => f.name).join(' | '));

    // The job's stored bid: b1 is code 420, b3 is on the bid with no code.
    await client.query(
      `INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`FCT:fct_project_${PJ}`, JSON.stringify({ id: PJ, bidItems: [
        { id: 'b1', cost_code: '420', sub_code: 'Base', quantity: 10, unit: 'TN' },
        { id: 'b3', sub_code: 'Uncoded line', quantity: 1, unit: 'LS' },
      ] })]);

    await procRow('dpr-1', { costCode: '420', subCode: 'Base' });
    await procRow('dpr-bid', { bidItemId: 'b1', costCode: 'OLD-CODE', subCode: 'Base' });
    await procRow('dpr-case', { costCode: '  STORMWATER ' });
    await procRow('dpr-none', { costCode: '' });
    await procRow('dpr-blankbid', { bidItemId: 'b3', costCode: 'Stormwater' });
    await procRow('dpr-new', { costCode: '510' });
    await procRow('dpr-del', { costCode: '420', deletedAt: new Date() });
    await procRow('dpr-other', { projectId: PJ2, costCode: '420' });
    await procRow('dpr-j2', { projectId: PJ2, costCode: '420' });
    await procRow('dpr-pav', { division: 'paving', costCode: '420' });
    await procRow('dpr-rival', { company: 'OTH', costCode: '420' });
    await procRow('dpr-620a', { projectId: PJ3, costCode: '620' });
    await procRow('dpr-620b', { projectId: PJ3, costCode: '620' });

    // ── Attached at upload ──
    const up1 = await att(fSafety.id, 'geofabric-quote.pdf', FOREMAN, { procurementId: 'dpr-1' });
    assert('a foreman attaches a file to a procurement line (201)', up1.statusCode === 201, JSON.stringify(up1.body));
    const d1 = up1.body.document;
    assert('the answer carries the line and both folders',
      d1 && JSON.stringify(d1.procurement_ids) === '["dpr-1"]'
        && d1.folder_ids.length === 2 && d1.folder_ids.includes(fSafety.id) && d1.folder_ids.includes(fPaving.id),
      JSON.stringify(d1));
    assert('and names the cost-code folder it was compiled into', up1.body.costCodeFolderId === fPaving.id,
      JSON.stringify(up1.body.costCodeFolderId));
    const l1 = await docRow(d1.id);
    assert('the job listing files it in the picked folder', l1 && l1.folder_ids.includes(fSafety.id), JSON.stringify(l1));
    assert('AND in the line\'s cost-code folder', l1 && l1.folder_ids.includes(fPaving.id), JSON.stringify(l1));
    assert('and lists the procurement link', l1 && JSON.stringify(l1.procurement_ids) === '["dpr-1"]', JSON.stringify(l1));
    assert('stored once however many places it shows', await docsStored(d1.id) === 1);
    const procLink = await client.query(
      `SELECT company_code, created_by FROM document_links WHERE document_id = $1 AND link_type = 'procurement' AND target_id = 'dpr-1'`, [d1.id]);
    assert('the procurement link is the company\'s, and says who made it',
      procLink.rows.length === 1 && procLink.rows[0].company_code === 'FCT' && procLink.rows[0].created_by === 'foreman',
      JSON.stringify(procLink.rows));
    const upAudit = (await client.query(
      `SELECT detail FROM document_audit_log WHERE action = 'UPLOAD' AND document_id = $1`, [d1.id])).rows[0];
    assert('the upload audit names the line and the cost-code folder',
      upAudit && upAudit.detail.procurement_id === 'dpr-1' && upAudit.detail.cost_code_folder_id === fPaving.id,
      JSON.stringify(upAudit));

    const plain = await att(fSafety.id, 'plain.pdf', PM);
    assert('an upload with no line has no procurement links and no cost-code folder',
      plain.statusCode === 201 && plain.body.document.procurement_ids.length === 0
        && plain.body.costCodeFolderId === null && plain.body.document.folder_ids.length === 1, JSON.stringify(plain.body));

    // Picking the cost-code folder itself files it there once.
    const up2 = await att(fPaving.id, 'delivery-ticket.pdf', PM, { procurementId: 'dpr-1' });
    assert('picking the cost-code folder itself files it there once',
      up2.statusCode === 201 && JSON.stringify(up2.body.document.folder_ids) === JSON.stringify([fPaving.id])
        && up2.body.costCodeFolderId === fPaving.id, JSON.stringify(up2.body));
    const dupLinks = (await client.query(
      `SELECT COUNT(*)::int AS n FROM document_links WHERE document_id = $1 AND link_type = 'folder'`, [up2.body.document.id])).rows[0].n;
    assert('with one folder link, not two', dupLinks === 1, String(dupLinks));

    // ── Listing and counting ──
    const byLine = await call('GET', { division: 'turf', procurementId: 'dpr-1', projectId: PJ }, null, PM);
    assert('GET ?procurementId lists the line\'s documents, newest first',
      byLine.statusCode === 200 && byLine.body.documents.map(d => d.id).join(',') === [up2.body.document.id, d1.id].join(','),
      JSON.stringify(byLine.body));
    assert('each with its folder, PO and procurement ids',
      byLine.body.documents.every(d => Array.isArray(d.folder_ids) && Array.isArray(d.po_ids) && d.procurement_ids.includes('dpr-1')));
    const byLineAnyJob = await call('GET', { division: 'turf', procurementId: 'dpr-1' }, null, PM);
    assert('without a projectId it still finds them', byLineAnyJob.body.documents.length === 2, JSON.stringify(byLineAnyJob.body));
    const byLineOtherJob = await call('GET', { division: 'turf', procurementId: 'dpr-1', projectId: PJ2 }, null, PM);
    assert('scoped to another job it finds nothing', byLineOtherJob.body.documents.length === 0, JSON.stringify(byLineOtherJob.body));
    const viewerList = await call('GET', { division: 'turf', procurementId: 'dpr-1', projectId: PJ }, null, VIEWER);
    assert('a view-only user can list a line\'s documents', viewerList.statusCode === 200 && viewerList.body.documents.length === 2,
      JSON.stringify(viewerList.body));
    const badList = await call('GET', { division: 'turf', procurementId: 'not a row!' }, null, PM);
    assert('a malformed line id is refused (400)', badList.statusCode === 400, JSON.stringify(badList.body));

    let c = await countsFor(PJ);
    assert('GET ?procurementCounts gives each line its count', c['dpr-1'] === 2, JSON.stringify(c));
    const viewerCounts = await call('GET', { division: 'turf', procurementCounts: '1', projectId: PJ }, null, VIEWER);
    assert('and a view-only user can read them too', viewerCounts.statusCode === 200 && viewerCounts.body.counts['dpr-1'] === 2,
      JSON.stringify(viewerCounts.body));

    // Another job of the same company keeps its own counts.
    const seeded2 = await call('PUT', { division: 'turf', projectId: PJ2 }, { costCodes: [{ code: '420', label: 'Paving' }] }, PM);
    const j2Safety = seeded2.body.folders.find(f => f.slug === 'safety');
    const j2Paving = seeded2.body.folders.find(f => f.cost_code === '420');
    const upJ2 = await att(j2Safety.id, 'j2.pdf', PM, { projectId: PJ2, procurementId: 'dpr-j2' });
    assert('a line on another job files into THAT job\'s cost-code folder',
      upJ2.statusCode === 201 && upJ2.body.costCodeFolderId === j2Paving.id && j2Paving.id !== fPaving.id,
      JSON.stringify(upJ2.body));
    c = await countsFor(PJ);
    const c2 = await countsFor(PJ2);
    assert('counts are per job', !('dpr-j2' in c) && c2['dpr-j2'] === 1 && !('dpr-1' in c2),
      `PJ=${JSON.stringify(c)} PJ2=${JSON.stringify(c2)}`);

    // Other company and other division see none of it.
    const rivalList = await call('GET', { division: 'turf', procurementId: 'dpr-1', projectId: PJ }, null, OTHERCO);
    const rivalCounts = await countsFor(PJ, OTHERCO);
    assert('another company sees no attachments and no counts',
      rivalList.statusCode === 200 && rivalList.body.documents.length === 0 && Object.keys(rivalCounts).length === 0,
      JSON.stringify({ list: rivalList.body, counts: rivalCounts }));
    const pavList = await call('GET', { division: 'paving', procurementId: 'dpr-1', projectId: PJ }, null, PAVER);
    const pavCounts = await countsFor(PJ, PAVER, 'paving');
    assert('another division sees none either',
      pavList.statusCode === 200 && pavList.body.documents.length === 0 && Object.keys(pavCounts).length === 0,
      JSON.stringify({ list: pavList.body, counts: pavCounts }));

    // ── Refused attachments: nothing is written ──
    const refused = async (label, folderId, extra, status, auth = PM) => {
      const r = await att(folderId, 'refused.pdf', auth, extra);
      const id = `doc-${seq}`;
      assert(label, r.statusCode === status && (await docsStored(id)) === 0, `${r.statusCode} ${JSON.stringify(r.body)}`);
      return r;
    };
    await refused('a malformed procurementId is refused (400), nothing registered', fSafety.id, { procurementId: 'bad id!' }, 400);
    await refused('a 65-character procurementId is refused (400)', fSafety.id, { procurementId: 'x'.repeat(65) }, 400);
    const nf = await refused('a line that does not exist → 404, nothing registered', fSafety.id, { procurementId: 'dpr-nope' }, 404);
    assert('the 404 says which thing was missing, and why',
      nf.body.error === 'Procurement line not found' && typeof nf.body.detail === 'string' && nf.body.detail.length > 0,
      JSON.stringify(nf.body));
    await refused('a line on another job → 404', fSafety.id, { procurementId: 'dpr-other' }, 404);
    await refused('a line deleted from the sheet → 404', fSafety.id, { procurementId: 'dpr-del' }, 404);
    await refused('a line of another division → 404', fSafety.id, { procurementId: 'dpr-pav' }, 404);
    await refused('a line of another company → 404', fSafety.id, { procurementId: 'dpr-rival' }, 404);
    await refused('a view-only user cannot attach (403)', fSafety.id, { procurementId: 'dpr-1' }, 403, VIEWER);
    const general = (await call('PUT', { division: 'turf' }, {}, PM)).body.folders;
    const office  = general.find(f => f.slug === 'office');
    const gen = await refused('a General / Non-Job upload cannot attach to a line (404)', office.id,
      { projectId: null, procurementId: 'dpr-1' }, 404);
    assert('and says lines belong to a job', /job/i.test(gen.body.detail || ''), JSON.stringify(gen.body));

    // Another company attaching to our line by id, through its own tree.
    const rivalTree = (await call('PUT', { division: 'turf', projectId: PJ }, { costCodes: [] }, OTHERCO)).body.folders;
    const rivalSafety = rivalTree.find(f => f.slug === 'safety');
    STORE.set(`OTH/turf/${PJ}/doc-rival-proc/x.pdf`, 10);
    const rivalUp = await call('POST', { division: 'turf', projectId: PJ }, {
      documentId: 'doc-rival-proc', filename: 'x.pdf', storageKey: `OTH/turf/${PJ}/doc-rival-proc/x.pdf`,
      folderId: rivalSafety.id, sizeBytes: 10, procurementId: 'dpr-1',
    }, OTHERCO);
    assert('another company cannot attach to our line (404), nothing registered',
      rivalUp.statusCode === 404 && (await docsStored('doc-rival-proc')) === 0, JSON.stringify(rivalUp.body));

    // Central purchasing reaches a division only for one purchase order's
    // paperwork. Attaching to a job's procurement line is not part of that.
    const BUYER = { companyCode: 'FCT', userId: 7, username: 'buyer', role: 'level1', divisionRoles: { purchase_orders: 'level3' } };
    // The division's PO list is one shared row; whatever it held is put back.
    const poBlobWas = (await client.query(`SELECT value FROM app_data WHERE key = 'FCT:fct_purchase_orders:turf'`)).rows[0];
    await client.query(
      `INSERT INTO app_data (key, value) VALUES ('FCT:fct_purchase_orders:turf', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify([{ id: 'po-proc-carve', po_number: 'PO-77', project_id: PJ }])]);
    const poRootPJ = tree.find(f => f.slug === 'purchase-orders');
    STORE.set(`FCT/turf/${PJ}/doc-carve/receipt.pdf`, 10);
    const carveBody = { documentId: 'doc-carve', filename: 'receipt.pdf', storageKey: `FCT/turf/${PJ}/doc-carve/receipt.pdf`,
      folderId: poRootPJ.id, sizeBytes: 10, poId: 'po-proc-carve' };
    const carve = await call('POST', { division: 'turf', poId: 'po-proc-carve' }, { ...carveBody, procurementId: 'dpr-1' }, BUYER);
    assert('the purchasing carve-out cannot attach to a procurement line (403)',
      carve.statusCode === 403 && (await docsStored('doc-carve')) === 0, JSON.stringify(carve.body));
    const carveOk = await call('POST', { division: 'turf', poId: 'po-proc-carve' }, carveBody, BUYER);
    assert('while the same receipt without a line still files under its order (201)', carveOk.statusCode === 201,
      JSON.stringify(carveOk.body));
    const carveGet = await call('GET', { division: 'turf', procurementId: 'dpr-1', projectId: PJ }, null, BUYER);
    assert('and the carve-out cannot list a line\'s attachments (403)', carveGet.statusCode === 403, JSON.stringify(carveGet.body));
    const carveCounts = await call('GET', { division: 'turf', procurementCounts: '1', projectId: PJ }, null, BUYER);
    assert('nor read the sheet\'s counts (403)', carveCounts.statusCode === 403, JSON.stringify(carveCounts.body));
    if (poBlobWas) {
      await client.query(`UPDATE app_data SET value = $1::jsonb WHERE key = 'FCT:fct_purchase_orders:turf'`,
        [JSON.stringify(poBlobWas.value)]);
    } else {
      await client.query(`DELETE FROM app_data WHERE key = 'FCT:fct_purchase_orders:turf'`);
    }

    // ── Which cost code a line files under ──
    const upBid = await att(fSafety.id, 'bid-line.pdf', PM, { procurementId: 'dpr-bid' });
    assert('a line tied to a bid line files under the bid line\'s code, not its stale stored copy',
      upBid.statusCode === 201 && upBid.body.costCodeFolderId === fPaving.id
        && upBid.body.document.folder_ids.includes(fPaving.id), JSON.stringify(upBid.body));
    assert('and no folder is made for the stale code', (await ccFolders(PJ, 'OLD-CODE')).length === 0);

    const stormBefore = (await ccFolders(PJ, 'Stormwater')).length;
    const upCase = await att(fSafety.id, 'case.pdf', PM, { procurementId: 'dpr-case' });
    assert('"  STORMWATER " finds the seeded "Stormwater" folder (case and spaces ignored)',
      upCase.statusCode === 201 && upCase.body.costCodeFolderId === fStorm.id, JSON.stringify(upCase.body));
    assert('rather than making a second one', (await ccFolders(PJ, 'Stormwater')).length === stormBefore && stormBefore === 1);

    const upNone = await att(fPhotos.id, 'uncoded.pdf', PM, { procurementId: 'dpr-none' });
    assert('a line with no cost code files only in the folder picked',
      upNone.statusCode === 201 && upNone.body.costCodeFolderId === null
        && JSON.stringify(upNone.body.document.folder_ids) === JSON.stringify([fPhotos.id])
        && JSON.stringify(upNone.body.document.procurement_ids) === '["dpr-none"]', JSON.stringify(upNone.body));
    const upBlank = await att(fPhotos.id, 'blank-bid.pdf', PM, { procurementId: 'dpr-blankbid' });
    assert('a bid line with no code counts as no code, even when the stored copy has one',
      upBlank.statusCode === 201 && upBlank.body.costCodeFolderId === null
        && JSON.stringify(upBlank.body.document.folder_ids) === JSON.stringify([fPhotos.id]), JSON.stringify(upBlank.body));

    // A code nobody has opened the Documents tab for yet: its folder is made.
    assert('no 510 folder before', (await ccFolders(PJ, '510')).length === 0);
    const upNew = await att(fSafety.id, 'curb.pdf', PM, { procurementId: 'dpr-new' });
    const made510 = await ccFolders(PJ, '510');
    assert('a code with no folder gets one, and the file is filed in it',
      upNew.statusCode === 201 && made510.length === 1 && upNew.body.costCodeFolderId === made510[0].id
        && upNew.body.document.folder_ids.includes(made510[0].id), JSON.stringify({ body: upNew.body, made510 }));
    const f510 = made510[0];
    assert('made the way the seed makes one: top level, kind cost_code, slug cc-510, named with the code',
      f510 && f510.parent_id === null && f510.kind === 'cost_code' && f510.slug === 'cc-510'
        && f510.cost_code === '510' && f510.name === '510' && f510.created_by === 'pm', JSON.stringify(f510));
    const mkAudit = (await client.query(
      `SELECT detail FROM document_audit_log WHERE action = 'FOLDER_CREATE' AND folder_id = $1`, [f510.id])).rows;
    assert('and its creation is in the audit trail', mkAudit.length === 1 && mkAudit[0].detail.via === 'procurement_cost_code',
      JSON.stringify(mkAudit));
    const upNew2 = await att(fPhotos.id, 'curb-2.pdf', PM, { procurementId: 'dpr-new' });
    assert('a second file for the same code reuses that folder',
      upNew2.body.costCodeFolderId === f510.id && (await ccFolders(PJ, '510')).length === 1, JSON.stringify(upNew2.body));
    // The next time the Documents tab opens, the seed finds it by its code.
    const reseed = await call('PUT', { division: 'turf', projectId: PJ }, {
      costCodes: [{ code: '420', label: 'Paving' }, { code: 'Stormwater', label: '' }, { code: '510', label: 'Curb' }],
    }, PM);
    const after510 = reseed.body.folders.filter(f => f.cost_code === '510');
    assert('the next seed relabels that SAME folder instead of making a second',
      reseed.statusCode === 200 && reseed.body.created === 0 && after510.length === 1
        && after510[0].id === f510.id && after510[0].name === '510 · Curb', JSON.stringify(after510));
    assert('and sorts it among the job\'s other cost codes',
      after510[0].sort_order > fPaving.sort_order && after510[0].sort_order < 800, String(after510[0].sort_order));
    const stillFiled = await docRow(upNew.body.document.id);
    assert('with the file still in it', stillFiled.folder_ids.includes(f510.id), JSON.stringify(stillFiled));

    // A folder somebody made by hand already has the code's name.
    const seeded3 = await call('PUT', { division: 'turf', projectId: PJ3 }, { costCodes: [] }, PM);
    const j3Safety = seeded3.body.folders.find(f => f.slug === 'safety');
    const handMade = await call('POST', { division: 'turf', projectId: PJ3, folder: '1' }, { name: '620' }, PM);
    assert('a hand-made folder named "620" exists at the top of the job', handMade.statusCode === 201, JSON.stringify(handMade.body));
    const up620 = await att(j3Safety.id, 'pipe.pdf', PM, { projectId: PJ3, procurementId: 'dpr-620a' });
    const cc620 = await ccFolders(PJ3, '620');
    assert('the line still gets a real cost-code folder, under a suffixed name',
      up620.statusCode === 201 && cc620.length === 1 && cc620[0].name === '620 (2)' && cc620[0].kind === 'cost_code'
        && up620.body.costCodeFolderId === cc620[0].id, JSON.stringify({ body: up620.body, cc620 }));
    assert('and the file is NOT put in the hand-made folder',
      !up620.body.document.folder_ids.includes(handMade.body.folder.id), JSON.stringify(up620.body.document.folder_ids));
    const up620b = await att(j3Safety.id, 'pipe-2.pdf', PM, { projectId: PJ3, procurementId: 'dpr-620b' });
    assert('another line with that code finds the same folder (no "620 (3)")',
      up620b.body.costCodeFolderId === cc620[0].id && (await ccFolders(PJ3, '620')).length === 1, JSON.stringify(up620b.body));

    // ── Attaching and detaching after the fact ──
    const loose = await att(fPhotos.id, 'site-photo.jpg', FOREMAN);
    const looseId = loose.body.document.id;
    const viewerAdd = await call('PATCH', { division: 'turf', id: looseId }, { addProcurementId: 'dpr-1' }, VIEWER);
    assert('a view-only user cannot attach an existing file (403)', viewerAdd.statusCode === 403, JSON.stringify(viewerAdd.body));
    const pmsDoc = plain.body.document.id;
    const foremanOther = await call('PATCH', { division: 'turf', id: pmsDoc }, { addProcurementId: 'dpr-1' }, FOREMAN);
    assert('a level2 cannot attach someone else\'s file (403)', foremanOther.statusCode === 403, JSON.stringify(foremanOther.body));
    for (const [id, status, what] of [
      ['bad id!', 400, 'a malformed line id (400)'],
      ['dpr-nope', 404, 'a line that does not exist (404)'],
      ['dpr-other', 404, 'a line on another job (404)'],
      ['dpr-del', 404, 'a deleted line (404)'],
      ['dpr-pav', 404, 'a line of another division (404)'],
    ]) {
      const r = await call('PATCH', { division: 'turf', id: looseId }, { addProcurementId: id }, FOREMAN);
      assert(`attaching after the fact refuses ${what}`, r.statusCode === status, JSON.stringify(r.body));
    }
    const genDoc = await att(office.id, 'general.pdf', PM, { projectId: null });
    const genAdd = await call('PATCH', { division: 'turf', id: genDoc.body.document.id }, { addProcurementId: 'dpr-1' }, PM);
    assert('a General / Non-Job file cannot be attached to a job\'s line (404)', genAdd.statusCode === 404, JSON.stringify(genAdd.body));
    const stillLoose = await docRow(looseId);
    assert('and none of those refusals linked anything',
      stillLoose.procurement_ids.length === 0 && JSON.stringify(stillLoose.folder_ids) === JSON.stringify([fPhotos.id]),
      JSON.stringify(stillLoose));

    const added = await call('PATCH', { division: 'turf', id: looseId }, { addProcurementId: 'dpr-1' }, FOREMAN);
    assert('a level2 attaches its own file to a line after the fact',
      added.statusCode === 200 && added.body.document.procurement_ids.includes('dpr-1'), JSON.stringify(added.body));
    assert('which files it in the line\'s cost-code folder too',
      added.body.document.folder_ids.includes(fPaving.id) && added.body.document.folder_ids.includes(fPhotos.id),
      JSON.stringify(added.body.document.folder_ids));
    c = await countsFor(PJ);
    assert('and the line\'s count follows', c['dpr-1'] === 3, JSON.stringify(c));
    const pmAdd = await call('PATCH', { division: 'turf', id: looseId }, { addProcurementId: 'dpr-new' }, PM);
    assert('a level3 may attach anyone\'s file, to a second line',
      pmAdd.statusCode === 200 && pmAdd.body.document.procurement_ids.length === 2
        && pmAdd.body.document.folder_ids.includes(f510.id), JSON.stringify(pmAdd.body));

    const removed = await call('PATCH', { division: 'turf', id: looseId }, { removeProcurementId: 'dpr-1' }, FOREMAN);
    assert('detaching takes the line off', removed.statusCode === 200
      && JSON.stringify(removed.body.document.procurement_ids) === '["dpr-new"]', JSON.stringify(removed.body));
    assert('but leaves the file in the cost-code folder it was put in (as a PO detach does)',
      removed.body.document.folder_ids.includes(fPaving.id), JSON.stringify(removed.body.document.folder_ids));
    const looseRow = await client.query(`SELECT deleted_at FROM project_documents WHERE id = $1`, [looseId]);
    assert('and never deletes the file', looseRow.rows[0].deleted_at === null);
    c = await countsFor(PJ);
    assert('the count drops back', c['dpr-1'] === 2 && c['dpr-new'] === 3, JSON.stringify(c));

    const trail = (await client.query(
      `SELECT action, detail FROM document_audit_log WHERE document_id = $1 ORDER BY id`, [looseId])).rows;
    const has = (action, test) => trail.some(r => r.action === action && r.detail && test(r.detail));
    assert('the trail has the LINK to the line',
      has('LINK', d => d.link_type === 'procurement' && d.target_id === 'dpr-1'), JSON.stringify(trail));
    assert('the LINK to the cost-code folder it brought with it',
      has('LINK', d => d.link_type === 'folder' && d.target_id === fPaving.id && d.via === 'procurement_cost_code'
        && d.procurement_id === 'dpr-1'), JSON.stringify(trail));
    assert('and the UNLINK from the line',
      has('UNLINK', d => d.link_type === 'procurement' && d.target_id === 'dpr-1'), JSON.stringify(trail));

    // ── Deleted files and other link types never count ──
    await call('DELETE', { division: 'turf', id: up2.body.document.id }, null, ADMIN);
    c = await countsFor(PJ);
    assert('a deleted file stops counting against its line', c['dpr-1'] === 1, JSON.stringify(c));
    const afterDel = await call('GET', { division: 'turf', procurementId: 'dpr-1', projectId: PJ }, null, PM);
    assert('and leaves the line\'s list', afterDel.body.documents.length === 1 && afterDel.body.documents[0].id === d1.id,
      JSON.stringify(afterDel.body.documents.map(d => d.id)));
    const trashRow = (await call('GET', { division: 'turf', trash: '1' }, null, ADMIN)).body.documents
      .find(d => d.id === up2.body.document.id);
    assert('the trash view still shows which line it was on', trashRow && trashRow.procurement_ids.includes('dpr-1'),
      JSON.stringify(trashRow));

    // A PO whose id happens to read like a line's, and a folder link: neither is a procurement attachment.
    const poOnly = await att(fSafety.id, 'po-only.pdf', PM, { poId: 'dpr-po-lookalike' });
    await call('PATCH', { division: 'turf', id: poOnly.body.document.id }, { addPoId: 'dpr-new' }, PM);
    c = await countsFor(PJ);
    assert('a PO link never counts as a procurement attachment',
      !('dpr-po-lookalike' in c) && c['dpr-new'] === 3, JSON.stringify(c));
    const poLook = await call('GET', { division: 'turf', procurementId: 'dpr-po-lookalike', projectId: PJ }, null, PM);
    assert('nor lists under a line of that id', poLook.body.documents.length === 0, JSON.stringify(poLook.body));
    assert('no count is keyed by a folder id', !Object.keys(c).some(k => tree.some(f => f.id === k)), JSON.stringify(c));
    const poCountsNow = (await call('GET', { division: 'turf', poCounts: '1' }, null, PM)).body.counts;
    assert('and the PO counts never include procurement links',
      !('dpr-1' in poCountsNow) && poCountsNow['dpr-new'] === 1, JSON.stringify(poCountsNow));
    const byPoLine = (await call('GET', { division: 'turf', poId: 'dpr-po-lookalike' }, null, PM)).body.documents;
    assert('PO-scoped reads carry procurement_ids too', byPoLine.length === 1 && Array.isArray(byPoLine[0].procurement_ids),
      JSON.stringify(byPoLine));

    // ── A code that reads the same on screen finds the same folder ──
    // The bid's code was pasted out of Excel with a non-breaking space after
    // it, so the seed made its folder with that space. A row added from the
    // sheet's section stores the code trimmed (the browser and the API both
    // trim, and a JS trim strips that space). Postgres btrim() does not, so
    // attaching to that row used to make a second "Stormwater" folder beside
    // the seeded one, and the section's files were split between the two.
    // The same for a dash typed one way on the bid and another on the sheet.
    const PJ4 = 'proj-proc-4';
    const NBSP_CODE = 'Stormwater ';
    const DASH_CODE = 'Walkway – Wearing';
    const seeded4 = await call('PUT', { division: 'turf', projectId: PJ4 }, {
      costCodes: [{ code: NBSP_CODE, label: '' }, { code: DASH_CODE, label: '' }],
    }, PM);
    const tree4 = seeded4.body.folders || [];
    const j4Safety = tree4.find(f => f.slug === 'safety');
    const fNbsp = tree4.find(f => f.cost_code === NBSP_CODE);
    const fDash = tree4.find(f => f.cost_code === DASH_CODE);
    assert('the job seeds a folder for each code exactly as the bid spells it',
      Boolean(j4Safety && fNbsp && fDash), tree4.map(f => JSON.stringify(f.cost_code)).join(' | '));
    // An older case variant, sorted ahead of everything: a match on letter
    // case alone would take it, and an exact match (spaces aside) must not.
    await client.query(
      `INSERT INTO project_folders (id, company_code, division, project_id, name, kind, slug, cost_code, sort_order)
       VALUES ('dpr-f-upper', 'FCT', 'turf', $1, 'STORMWATER (old)', 'cost_code', 'cc-STORMWATER', 'STORMWATER', 0)`, [PJ4]);
    await client.query(
      `INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [`FCT:fct_project_${PJ4}`, JSON.stringify({ id: PJ4, bidItems: [
        { id: 'nb1', cost_code: NBSP_CODE, sub_code: 'Geofabric', quantity: 10, unit: 'SY' },
      ] })]);
    await procRow('dpr-nb-tied', { projectId: PJ4, bidItemId: 'nb1', costCode: 'Stormwater', subCode: 'Geofabric' });
    await procRow('dpr-nb-add', { projectId: PJ4, costCode: 'Stormwater' });
    await procRow('dpr-dash', { projectId: PJ4, costCode: 'walkway - wearing' });
    const folders4 = async () => Number((await client.query(
      `SELECT count(*) FROM project_folders WHERE company_code = 'FCT' AND project_id = $1`, [PJ4])).rows[0].count);
    const n4 = await folders4();

    const upAdd = await att(j4Safety.id, 'section-row.pdf', PM, { projectId: PJ4, procurementId: 'dpr-nb-add' });
    assert('a row added from the section (stored "Stormwater") files in the folder the bid seeded with a non-breaking space',
      upAdd.statusCode === 201 && upAdd.body.costCodeFolderId === fNbsp.id
        && upAdd.body.document.folder_ids.includes(fNbsp.id), JSON.stringify(upAdd.body));
    assert('…not in the case variant sorted ahead of it',
      !upAdd.body.document.folder_ids.includes('dpr-f-upper'), JSON.stringify(upAdd.body.document.folder_ids));
    assert('…and no second Stormwater folder is made', await folders4() === n4, `${n4} -> ${await folders4()}`);
    const upTied = await att(j4Safety.id, 'tied-row.pdf', PM, { projectId: PJ4, procurementId: 'dpr-nb-tied' });
    assert('the row tied to that bid line files in the same folder',
      upTied.statusCode === 201 && upTied.body.costCodeFolderId === fNbsp.id, JSON.stringify(upTied.body));
    const upDash = await att(j4Safety.id, 'dash-row.pdf', PM, { projectId: PJ4, procurementId: 'dpr-dash' });
    assert('a hyphen typed where the bid has an en dash, in another case, finds the bid\'s folder',
      upDash.statusCode === 201 && upDash.body.costCodeFolderId === fDash.id && await folders4() === n4,
      JSON.stringify(upDash.body));

    // ── Restored after its line was re-coded ──
    // While a file sits in the bin its line can be re-coded, and the re-file
    // that follows a re-code moves only live files. The restore has to put it
    // under the line's code as it is now, or the line's paperclip counts it in
    // a section whose folder never holds it.
    const procDocs = require(path.resolve(__dirname, '..', 'api', 'lib', 'procurement-docs.js'));
    await procRow('dpr-rc', { costCode: 'Stormwater' });
    const upRc = await att(fSafety.id, 'geofabric-restore.pdf', PM, { procurementId: 'dpr-rc' });
    const rcId = upRc.body.document.id;
    assert('a file attached to a Stormwater line is in the Stormwater folder',
      upRc.statusCode === 201 && upRc.body.costCodeFolderId === fStorm.id, JSON.stringify(upRc.body));
    await call('DELETE', { division: 'turf', id: rcId }, null, ADMIN);
    await client.query(`UPDATE procurement_items SET cost_code = 'Storm Drainage' WHERE id = 'dpr-rc'`);
    await procDocs.refileProcurementDocs(makeSql(client), {
      companyCode: 'FCT', division: 'turf', username: 'pm',
      changes: [{ rowId: 'dpr-rc', projectId: PJ, fromCode: 'Stormwater', toCode: 'Storm Drainage' }],
    });
    assert('the re-code leaves the file in the bin where it was, with no folder made for it',
      (await ccFolders(PJ, 'Storm Drainage')).length === 0);
    const rcTrailBefore = (await client.query(
      `SELECT count(*)::int AS n FROM document_audit_log WHERE document_id = $1`, [rcId])).rows[0].n;
    const restoredRc = await call('PATCH', { division: 'turf', id: rcId }, { restore: true }, ADMIN);
    const sdF = await ccFolders(PJ, 'Storm Drainage');
    assert('restoring it (200) files it under the line\'s cost code now, in a folder made for it',
      restoredRc.statusCode === 200 && sdF.length === 1 && restoredRc.body.document
        && restoredRc.body.document.folder_ids.includes(sdF[0].id), JSON.stringify({ body: restoredRc.body, sdF }));
    assert('…keeping every folder it was already in',
      restoredRc.body.document.folder_ids.includes(fSafety.id) && restoredRc.body.document.folder_ids.includes(fStorm.id),
      JSON.stringify(restoredRc.body.document.folder_ids));
    assert('…still attached to the line, which counts it again',
      JSON.stringify(restoredRc.body.document.procurement_ids) === '["dpr-rc"]' && (await countsFor(PJ))['dpr-rc'] === 1);
    const rcTrail = (await client.query(
      `SELECT action, actor, folder_id, detail FROM document_audit_log WHERE document_id = $1 ORDER BY id`, [rcId])).rows.slice(rcTrailBefore);
    assert('…the restore and the new filing are both in the trail, naming the line',
      rcTrail.length === 2 && rcTrail[0].action === 'RESTORE' && rcTrail[1].action === 'LINK'
        && rcTrail[1].actor === 'admin' && rcTrail[1].folder_id === (sdF[0] && sdF[0].id)
        && rcTrail[1].detail.link_type === 'folder' && rcTrail[1].detail.via === 'procurement_cost_code'
        && rcTrail[1].detail.procurement_id === 'dpr-rc', JSON.stringify(rcTrail));

    // Restored with nothing changed: no filing, and nothing more in the trail.
    await call('DELETE', { division: 'turf', id: rcId }, null, ADMIN);
    const sameBefore = (await client.query(
      `SELECT count(*)::int AS n FROM document_audit_log WHERE document_id = $1`, [rcId])).rows[0].n;
    const restoredSame = await call('PATCH', { division: 'turf', id: rcId }, { restore: true }, ADMIN);
    const sameTrail = (await client.query(
      `SELECT action FROM document_audit_log WHERE document_id = $1 ORDER BY id`, [rcId])).rows.slice(sameBefore);
    assert('a file restored under the code it already sits in is filed nowhere new',
      restoredSame.statusCode === 200 && sameTrail.length === 1 && sameTrail[0].action === 'RESTORE'
        && restoredSame.body.document.folder_ids.length === 3, JSON.stringify({ sameTrail, f: restoredSame.body.document }));

    // A line deleted from the sheet while the file was in the bin puts it in
    // no section: the restore does not file it under that line's code.
    await procRow('dpr-rc-gone', { costCode: 'Stormwater' });
    const upGone = await att(fSafety.id, 'gone-line.pdf', PM, { procurementId: 'dpr-rc-gone' });
    await call('DELETE', { division: 'turf', id: upGone.body.document.id }, null, ADMIN);
    await client.query(`UPDATE procurement_items SET cost_code = 'Gone Code', deleted_at = NOW() WHERE id = 'dpr-rc-gone'`);
    const restoredGone = await call('PATCH', { division: 'turf', id: upGone.body.document.id }, { restore: true }, ADMIN);
    assert('a file whose line was deleted meanwhile is restored where it was, with no folder made for that line',
      restoredGone.statusCode === 200 && (await ccFolders(PJ, 'Gone Code')).length === 0
        && JSON.stringify([...restoredGone.body.document.folder_ids].sort()) === JSON.stringify([fSafety.id, fStorm.id].sort()),
      JSON.stringify(restoredGone.body.document));

    await cleanProcurement();
  }

  // ── Purchase-order delivery-line attachments ────────────────────────────
  // A file attached to one delivery line of an order is one document with a
  // 'po_line' link ("<poId>:<lineId>"), the order's own 'po' link (so the
  // order's paperclip lists it and its PO subfolder holds it), and a folder
  // link to the cost-code folder of the line's code, else the order's. The
  // line is checked against the division's PO list, the source of truth.
  // Braced so these locals stay local.
  {
    console.log('\nPurchase-order delivery-line attachments');
    const PJ  = 'proj-pol-1';
    const PJ2 = 'proj-pol-2';
    const UUID_LINE = 'dr-6f1c2a8e-1b2c-4d3e-9f00-aabbccddeeff';
    // The PO lists are shared rows; whatever they held is put back afterwards.
    await savePoBlobs();
    const setBlob = (key, list) => client.query(
      `INSERT INTO app_data (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(list)]);
    const PO1 = {
      id: 'pol-po-1', po_number: 'PO-501', project_id: PJ, cost_code: '420', sub_code: 'Base', lines: [
        { id: 'L1', invoice_num: 'INV-1', date: '2026-11-02', qty: '10', unit_cost: '40' },
        // A Daily Tracking delivery carries its row's code, which differs from the order header's.
        { id: 'dr-row1', source: 'daily', cost_code: 'Stormwater', sub_code: 'Geo', po_row_id: 'row1', invoice_num: '' },
        // A blank line code falls back to the order's.
        { id: 'dr-row2', source: 'daily', cost_code: '   ', sub_code: '', po_row_id: 'row2' },
        // A code no folder has been seeded for yet.
        { id: 'dr-row3', source: 'daily', cost_code: '515', sub_code: '', po_row_id: 'row3' },
      ],
    };
    const PO2 = { id: 'pol-po-2', po_number: 'PO-502', project_id: PJ, cost_code: '420',
      lines: [{ id: 'L2' }, { id: UUID_LINE, source: 'daily', cost_code: '', po_row_id: '6f1c2a8e-1b2c-4d3e-9f00-aabbccddeeff' }] };
    const POGEN = { id: 'pol-po-gen', po_number: 'PO-503', project_id: null, cost_code: '420', lines: [{ id: 'G1' }] };
    const PONOCODE = { id: 'pol-po-nocode', po_number: 'PO-504', project_id: PJ, cost_code: '', lines: [{ id: 'N1' }] };
    const POJ2 = { id: 'pol-po-j2', po_number: 'PO-505', project_id: PJ2, cost_code: '420', lines: [{ id: 'J1' }] };
    await setBlob('FCT:fct_purchase_orders:turf', [PO1, PO2, POGEN, PONOCODE, POJ2]);
    await setBlob('FCT:fct_purchase_orders:paving', [{ id: 'pol-po-pav', po_number: 'PV-1', project_id: PJ, cost_code: '420', lines: [{ id: 'P1' }] }]);
    // The same order and line ids in another company.
    await setBlob('OTH:fct_purchase_orders:turf', [{ id: 'pol-po-1', po_number: 'R-1', project_id: PJ, cost_code: '420', lines: [{ id: 'L1' }] }]);

    // A register in any company and division, the way the browser does it.
    let polSeq = 0;
    // keyProjectId: the job the storage key was minted for, when the query
    // names none (the carve-out files into the ORDER's job, whatever it says).
    const reg = async (auth, { division = 'turf', projectId = PJ, keyProjectId, folderId, query = {}, ...extra }) => {
      const documentId = `doc-pol-${++polSeq}`;
      const keyJob = keyProjectId !== undefined ? keyProjectId : projectId;
      const storageKey = `${auth.companyCode}/${division}/${keyJob || 'general'}/${documentId}/delivery-${polSeq}.pdf`;
      STORE.set(storageKey, 2048);
      const r = await call('POST', { division, ...(projectId ? { projectId } : {}), ...query },
        { documentId, filename: `delivery-${polSeq}.pdf`, storageKey, folderId, sizeBytes: 2048, ...extra }, auth);
      r.documentId = documentId;
      return r;
    };
    const docsStored = async id =>
      (await client.query(`SELECT COUNT(*)::int AS n FROM project_documents WHERE id = $1`, [id])).rows[0].n;
    const linksOf = async id => (await client.query(
      `SELECT link_type, target_id FROM document_links WHERE document_id = $1 ORDER BY link_type, target_id`, [id])).rows;
    const lineCounts = async (auth = PM, query = {}, division = 'turf') =>
      call('GET', { division, poLineCounts: '1', ...query }, null, auth);
    const lineList = async (poId, lineId, auth = PM, division = 'turf') =>
      call('GET', { division, ...(poId !== undefined ? { poId } : {}), ...(lineId !== undefined ? { poLineId: lineId } : {}) }, null, auth);

    // The pair's helpers (api/lib/po-line-docs.js).
    const pl = require(path.resolve(__dirname, '..', 'api', 'lib', 'po-line-docs.js'));
    assert('a line target is "<poId>:<lineId>", and parses back',
      pl.poLineTarget('pol-po-1', 'dr-row1') === 'pol-po-1:dr-row1'
        && JSON.stringify(pl.parsePoLineTarget('pol-po-1:dr-row1')) === JSON.stringify({ poId: 'pol-po-1', lineId: 'dr-row1' }));
    assert('either part malformed, missing or carrying a colon is no target',
      pl.poLineTarget('pol-po-1', '') === null && pl.poLineTarget('', 'L1') === null && pl.poLineTarget('a:b', 'L1') === null
        && pl.parsePoLineTarget('L1') === null && pl.parsePoLineTarget('a:b:c') === null && pl.parsePoLineTarget(':L1') === null
        && pl.parsePoLineTarget(42) === null && pl.isPoLinePart('x'.repeat(128)) && !pl.isPoLinePart('x'.repeat(129))
        && pl.isPoLinePart('lz4k1q.9-x_Y') && !pl.isPoLinePart('a b'));
    assert('findLine finds by id on the order, and nothing elsewhere',
      pl.findLine({ lines: [null, { id: 7 }, { id: 'L1' }] }, 'L1').id === 'L1' && pl.findLine({ lines: [{ id: 7 }] }, '7').id === 7
        && pl.findLine({ lines: [{ id: 'L1' }] }, 'L2') === null && pl.findLine({}, 'L1') === null && pl.findLine(null, 'L1') === null);
    assert('lineCostCode: the line\'s own code, else the order\'s, else none',
      pl.lineCostCode({ cost_code: '420' }, { cost_code: 'Stormwater' }) === 'Stormwater'
        && pl.lineCostCode({ cost_code: '420' }, { cost_code: '  ' }) === '420'
        && pl.lineCostCode({ cost_code: '420' }, {}) === '420'
        && pl.lineCostCode({ cost_code: '' }, { cost_code: '' }) === null
        && pl.lineCostCode({}, null) === null);

    // Schema: the link type is admitted, and a wrong one still is not.
    const chk = (await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'document_links_type_chk'`)).rows[0];
    assert('the schema admits the \'po_line\' link type', chk && /'po_line'/.test(chk.def), JSON.stringify(chk));
    let badType = null;
    try {
      await client.query(`INSERT INTO document_links (document_id, company_code, link_type, target_id)
        VALUES ('doc-1', 'FCT', 'po_lines', 'x')`);
    } catch (err) { badType = err; }
    assert('…and still refuses a type it does not list', Boolean(badType) && /document_links_type_chk/.test(badType.message),
      badType && badType.message);

    // The job's tree, seeded the way the Documents tab seeds it from the bid.
    const tree = (await call('PUT', { division: 'turf', projectId: PJ }, {
      costCodes: [{ code: '420', label: 'Paving' }, { code: 'Stormwater', label: '' }],
    }, PM)).body.folders;
    const fPoRoot = tree.find(f => f.slug === 'purchase-orders');
    const fSafety = tree.find(f => f.slug === 'safety');
    const fPaving = tree.find(f => f.cost_code === '420');
    const fStorm  = tree.find(f => f.cost_code === 'Stormwater');
    assert('fixture: the job has its PO root and cost-code folders', Boolean(fPoRoot && fSafety && fPaving && fStorm),
      tree.map(f => f.name).join(' | '));

    // ── Attached at upload ──
    const up1 = await reg(FOREMAN, { folderId: fPoRoot.id, poId: 'pol-po-1', poNumber: 'PO-501', poLineId: 'L1' });
    assert('a foreman attaches a file to a delivery line (201)', up1.statusCode === 201, JSON.stringify(up1.body));
    const d1 = up1.body.document || {};
    assert('the answer carries the line as "<poId>:<lineId>", and the order',
      JSON.stringify(d1.po_line_ids) === '["pol-po-1:L1"]' && JSON.stringify(d1.po_ids) === '["pol-po-1"]', JSON.stringify(d1));
    assert('and the order\'s cost-code folder (420), named at the top level too',
      up1.body.costCodeFolderId === fPaving.id && d1.folder_ids.includes(fPaving.id) && d1.folder_ids.includes(fPoRoot.id)
        && new Set(d1.folder_ids).size === d1.folder_ids.length, JSON.stringify(up1.body));
    const tree2 = (await call('GET', { division: 'turf', projectId: PJ }, null, PM)).body;
    const fPoSub = tree2.folders.find(f => f.slug === 'po-pol-po-1');
    assert('the order gets its own PO subfolder under Purchase Orders', fPoSub && fPoSub.parent_id === fPoRoot.id
      && fPoSub.name === 'PO PO-501', JSON.stringify(fPoSub));
    const links1 = await linksOf(up1.documentId);
    const has = (rows, t, id) => rows.some(r => r.link_type === t && r.target_id === id);
    assert('stored links: the po_line, the order\'s po link, the picked folder, the PO subfolder and the 420 folder',
      has(links1, 'po_line', 'pol-po-1:L1') && has(links1, 'po', 'pol-po-1') && has(links1, 'folder', fPoRoot.id)
        && has(links1, 'folder', fPoSub && fPoSub.id) && has(links1, 'folder', fPaving.id) && links1.length === 5,
      JSON.stringify(links1));
    assert('stored once however many places it shows', await docsStored(up1.documentId) === 1);
    const listed1 = tree2.documents.find(d => d.id === up1.documentId);
    assert('the job listing carries po_line_ids', listed1 && JSON.stringify(listed1.po_line_ids) === '["pol-po-1:L1"]',
      JSON.stringify(listed1));
    const lineLink = (await client.query(
      `SELECT company_code, created_by FROM document_links WHERE document_id = $1 AND link_type = 'po_line'`, [up1.documentId])).rows;
    assert('the line link is the company\'s, and says who made it',
      lineLink.length === 1 && lineLink[0].company_code === 'FCT' && lineLink[0].created_by === 'foreman', JSON.stringify(lineLink));
    const upAudit = (await client.query(
      `SELECT detail FROM document_audit_log WHERE action = 'UPLOAD' AND document_id = $1`, [up1.documentId])).rows[0];
    assert('the upload audit names the order, the line and the cost-code folder',
      upAudit && upAudit.detail.po_id === 'pol-po-1' && upAudit.detail.po_line_id === 'pol-po-1:L1'
        && upAudit.detail.cost_code_folder_id === fPaving.id, JSON.stringify(upAudit));

    const upDr = await reg(PM, { folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'dr-row1' });
    assert('a Daily Tracking delivery files under ITS row\'s code (Stormwater), not the order\'s 420',
      upDr.statusCode === 201 && upDr.body.costCodeFolderId === fStorm.id && upDr.body.document.folder_ids.includes(fStorm.id)
        && !upDr.body.document.folder_ids.includes(fPaving.id), JSON.stringify(upDr.body));
    assert('picking the PO subfolder files it there once',
      upDr.body.document.folder_ids.filter(f => f === fPoSub.id).length === 1
        && (await linksOf(upDr.documentId)).filter(r => r.link_type === 'folder').length === 2, JSON.stringify(await linksOf(upDr.documentId)));
    const upBlank = await reg(PM, { folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'dr-row2' });
    assert('a line whose own code is blank files under the order\'s code',
      upBlank.statusCode === 201 && upBlank.body.costCodeFolderId === fPaving.id, JSON.stringify(upBlank.body));
    const noFolder515 = (await client.query(
      `SELECT count(*)::int AS n FROM project_folders WHERE project_id = $1 AND cost_code = '515'`, [PJ])).rows[0].n;
    const up515 = await reg(PM, { folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'dr-row3' });
    const f515 = (await client.query(
      `SELECT * FROM project_folders WHERE project_id = $1 AND cost_code = '515'`, [PJ])).rows;
    assert('a code with no folder yet gets one, made the way the seed makes one, and the file is in it',
      noFolder515 === 0 && up515.statusCode === 201 && f515.length === 1 && f515[0].kind === 'cost_code'
        && f515[0].slug === 'cc-515' && f515[0].parent_id === null && up515.body.costCodeFolderId === f515[0].id,
      JSON.stringify({ body: up515.body, f515 }));
    const upNoCode = await reg(PM, { folderId: fPoRoot.id, poId: 'pol-po-nocode', poLineId: 'N1' });
    assert('an order and line with no code at all file only in the picked folder and the PO subfolder',
      upNoCode.statusCode === 201 && upNoCode.body.costCodeFolderId === null
        && JSON.stringify(upNoCode.body.document.po_line_ids) === '["pol-po-nocode:N1"]'
        && (await linksOf(upNoCode.documentId)).filter(r => r.link_type === 'folder').length === 2,
      JSON.stringify({ body: upNoCode.body, links: await linksOf(upNoCode.documentId) }));
    const upUuid = await reg(PM, { folderId: fPoRoot.id, poId: 'pol-po-2', poLineId: UUID_LINE });
    const po2Sub = (await call('GET', { division: 'turf', projectId: PJ }, null, PM)).body.folders.find(f => f.slug === 'po-pol-po-2');
    assert('with no poNumber sent, the order\'s PO subfolder is named from the order itself',
      po2Sub && po2Sub.name === 'PO PO-502', JSON.stringify(po2Sub));
    assert('a Daily Tracking line id with a UUID row id is a valid line', upUuid.statusCode === 201
      && JSON.stringify(upUuid.body.document.po_line_ids) === JSON.stringify([`pol-po-2:${UUID_LINE}`]), JSON.stringify(upUuid.body));
    const upL2 = await reg(PM, { folderId: fPoRoot.id, poId: 'pol-po-2', poLineId: 'L2' });
    assert('a line on a second order of the job (201)', upL2.statusCode === 201, JSON.stringify(upL2.body));

    // An order on no job: filed in the General area, under Unassigned POs, never in a cost-code folder.
    const general = (await call('PUT', { division: 'turf' }, {}, PM)).body.folders;
    const fUnassigned = general.find(f => f.slug === 'unassigned-pos');
    const upGen = await reg(PM, { projectId: null, folderId: fUnassigned.id, poId: 'pol-po-gen', poLineId: 'G1' });
    const genSub = (await call('GET', { division: 'turf' }, null, PM)).body.folders.find(f => f.slug === 'po-pol-po-gen');
    assert('a General-area order\'s line: 201, no cost-code folder, its PO subfolder under Unassigned POs',
      upGen.statusCode === 201 && upGen.body.costCodeFolderId === null && genSub && genSub.parent_id === fUnassigned.id
        && has(await linksOf(upGen.documentId), 'folder', genSub.id)
        && has(await linksOf(upGen.documentId), 'po_line', 'pol-po-gen:G1'), JSON.stringify({ body: upGen.body, genSub }));

    // ── Refused: nothing is written ──
    const refused = async (label, opts, status, auth = PM) => {
      const r = await reg(auth, opts);
      assert(label, r.statusCode === status && (await docsStored(r.documentId)) === 0
        && (await linksOf(r.documentId)).length === 0, `${r.statusCode} ${JSON.stringify(r.body)}`);
      return r;
    };
    const nfPo = await refused('an order that is not in the division\'s list → 404, nothing registered',
      { folderId: fPoRoot.id, poId: 'pol-po-nope', poLineId: 'L1' }, 404);
    assert('the 404 says the order was missing', nfPo.body.error === 'Purchase order not found', JSON.stringify(nfPo.body));
    const nfLine = await refused('a line that is not on the order → 404, nothing registered',
      { folderId: fPoRoot.id, poId: 'pol-po-1', poLineId: 'L9' }, 404);
    assert('the 404 says the delivery was missing, and why',
      nfLine.body.error === 'Delivery line not found' && /not on the order yet/.test(nfLine.body.detail || ''), JSON.stringify(nfLine.body));
    await refused('a line of ANOTHER order of the job → 404', { folderId: fPoRoot.id, poId: 'pol-po-2', poLineId: 'L1' }, 404);
    await refused('poLineId without poId → 400', { folderId: fPoRoot.id, poLineId: 'L1' }, 400);
    await refused('a malformed line id → 400', { folderId: fPoRoot.id, poId: 'pol-po-1', poLineId: 'bad id!' }, 400);
    await refused('a line id with a colon → 400', { folderId: fPoRoot.id, poId: 'pol-po-1', poLineId: 'L1:x' }, 400);
    await refused('a 129-character line id → 400', { folderId: fPoRoot.id, poId: 'pol-po-1', poLineId: 'x'.repeat(129) }, 400);
    await refused('a malformed order id alongside a line → 400', { folderId: fPoRoot.id, poId: 'pol po 1', poLineId: 'L1' }, 400);
    const otherJob = await refused('a file in the General area cannot hang off a job\'s delivery (400)',
      { projectId: null, folderId: fUnassigned.id, poId: 'pol-po-1', poLineId: 'L1' }, 400);
    assert('…and says the delivery belongs to another job', otherJob.body.error === 'That delivery belongs to another job',
      JSON.stringify(otherJob.body));
    const tj2 = (await call('PUT', { division: 'turf', projectId: PJ2 }, { costCodes: [] }, PM)).body.folders;
    await refused('nor can a file on another job (400)',
      { projectId: PJ2, folderId: tj2.find(f => f.slug === 'purchase-orders').id, poId: 'pol-po-1', poLineId: 'L1' }, 400);
    await refused('a view-only user cannot attach (403)', { folderId: fPoRoot.id, poId: 'pol-po-1', poLineId: 'L1' }, 403, VIEWER);
    const pavTree = (await call('PUT', { division: 'paving', projectId: PJ }, { costCodes: [] }, PAVER)).body.folders;
    const pavRoot = pavTree.find(f => f.slug === 'purchase-orders');
    await refused('a turf order\'s line, named from paving → 404 (another division\'s list)',
      { division: 'paving', folderId: pavRoot.id, poId: 'pol-po-1', poLineId: 'L1' }, 404, PAVER);
    const pavUp = await reg(PAVER, { division: 'paving', folderId: pavRoot.id, poId: 'pol-po-pav', poLineId: 'P1' });
    assert('paving attaches to its own order\'s line (201)', pavUp.statusCode === 201, JSON.stringify(pavUp.body));
    const rivalTree = (await call('PUT', { division: 'turf', projectId: PJ }, { costCodes: [] }, OTHERCO)).body.folders;
    const rivalUp = await reg(OTHERCO, { folderId: rivalTree.find(f => f.slug === 'purchase-orders').id, poId: 'pol-po-1', poLineId: 'L1' });
    assert('another company attaches to ITS order of the same ids (201)', rivalUp.statusCode === 201, JSON.stringify(rivalUp.body));
    await refused('another company cannot reach a line only OUR order has → 404',
      { folderId: rivalTree.find(f => f.slug === 'purchase-orders').id, poId: 'pol-po-2', poLineId: 'L2' }, 404, OTHERCO);
    const plainPo = await reg(PM, { folderId: fPoRoot.id, poId: 'pol-po-1' });
    assert('a plain order attachment is unchanged: 201, no line link', plainPo.statusCode === 201
      && JSON.stringify(plainPo.body.document.po_line_ids) === '[]'
      && !(await linksOf(plainPo.documentId)).some(r => r.link_type === 'po_line'), JSON.stringify(plainPo.body));
    const unchecked = await reg(PM, { folderId: fPoRoot.id, poId: 'po-not-in-any-list' });
    assert('and a plain order id is still not checked against the list (201)', unchecked.statusCode === 201,
      JSON.stringify(unchecked.body));

    // ── Counting ──
    let c = await lineCounts();
    assert('?poLineCounts gives every order\'s lines their counts, division-wide',
      c.statusCode === 200 && c.body.counts['pol-po-1'] && c.body.counts['pol-po-1'].L1 === 1
        && c.body.counts['pol-po-1']['dr-row1'] === 1 && c.body.counts['pol-po-1']['dr-row2'] === 1
        && c.body.counts['pol-po-1']['dr-row3'] === 1 && c.body.counts['pol-po-2'].L2 === 1
        && c.body.counts['pol-po-2'][UUID_LINE] === 1 && c.body.counts['pol-po-gen'].G1 === 1
        && c.body.counts['pol-po-nocode'].N1 === 1, JSON.stringify(c.body));
    assert('a plain order attachment never counts against a line',
      !('po-not-in-any-list' in c.body.counts) && Object.keys(c.body.counts['pol-po-1']).length === 4, JSON.stringify(c.body));
    const one = await lineCounts(PM, { poId: 'pol-po-1' });
    assert('…and with &poId, that one order only',
      one.statusCode === 200 && JSON.stringify(Object.keys(one.body.counts)) === '["pol-po-1"]'
        && JSON.stringify(one.body.counts['pol-po-1']) === JSON.stringify(c.body.counts['pol-po-1']), JSON.stringify(one.body));
    // An order whose id STARTS like pol-po-1's, and one an underscore wildcard
    // would match: neither may leak into pol-po-1's per-order answer.
    const lookalike = await reg(PM, { folderId: fPoRoot.id, poId: 'pol-po-1x' });
    await client.query(`INSERT INTO document_links (document_id, company_code, link_type, target_id)
      VALUES ($1, 'FCT', 'po_line', 'pol-po-1x:L1'), ($1, 'FCT', 'po_line', 'pol_po_1:L1')`, [lookalike.documentId]);
    const near = await lineCounts(PM, { poId: 'pol-po-1' });
    assert('an order id that merely starts like another, or matches it as a pattern, is a different order',
      lookalike.statusCode === 201 && JSON.stringify(Object.keys(near.body.counts)) === '["pol-po-1"]'
        && JSON.stringify(near.body.counts['pol-po-1']) === JSON.stringify(c.body.counts['pol-po-1']), JSON.stringify(near.body));
    const wild = await lineCounts(PM, { poId: 'pol_po_1' });
    assert('…and each counts on its own', JSON.stringify(wild.body.counts) === JSON.stringify({ pol_po_1: { L1: 1 } }),
      JSON.stringify(wild.body));
    await client.query(`DELETE FROM document_links WHERE document_id = $1 AND link_type = 'po_line'`, [lookalike.documentId]);
    const badCountPo = await lineCounts(PM, { poId: 'bad po!' });
    assert('a malformed &poId is refused (400)', badCountPo.statusCode === 400, JSON.stringify(badCountPo.body));
    const viewerCounts = await lineCounts(VIEWER);
    assert('a view-only user reads the counts', viewerCounts.statusCode === 200
      && JSON.stringify(viewerCounts.body.counts) === JSON.stringify(c.body.counts), JSON.stringify(viewerCounts.body));
    let pc = (await call('GET', { division: 'turf', poCounts: '1' }, null, PM)).body.counts;
    assert('the order\'s own paperclip counts its line attachments too (4 lines + 1 plain = 5)',
      pc['pol-po-1'] === 5 && pc['pol-po-2'] === 2, JSON.stringify(pc));
    const rivalCounts = await lineCounts(OTHERCO);
    assert('another company counts only its own line attachments',
      rivalCounts.statusCode === 200 && JSON.stringify(rivalCounts.body.counts) === JSON.stringify({ 'pol-po-1': { L1: 1 } }),
      JSON.stringify(rivalCounts.body));
    const pavCounts = await lineCounts(PAVER, {}, 'paving');
    assert('another division counts only its own',
      pavCounts.statusCode === 200 && JSON.stringify(pavCounts.body.counts) === JSON.stringify({ 'pol-po-pav': { P1: 1 } }),
      JSON.stringify(pavCounts.body));
    assert('and ours never include theirs', c.body.counts['pol-po-1'].L1 === 1 && !('pol-po-pav' in c.body.counts));

    // ── Listing one line ──
    const up1b = await reg(PM, { folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'L1' });
    const l1 = await lineList('pol-po-1', 'L1');
    assert('?poLineId&poId lists the line\'s documents, newest first',
      l1.statusCode === 200 && l1.body.documents.map(d => d.id).join(',') === [up1b.documentId, up1.documentId].join(','),
      JSON.stringify(l1.body));
    assert('each carrying the line, the order and its folders',
      l1.body.documents.every(d => d.po_line_ids.includes('pol-po-1:L1') && d.po_ids.includes('pol-po-1')
        && Array.isArray(d.folder_ids) && Array.isArray(d.procurement_ids)), JSON.stringify(l1.body));
    const viewerList = await lineList('pol-po-1', 'L1', VIEWER);
    assert('a view-only user can list a line\'s documents', viewerList.statusCode === 200 && viewerList.body.documents.length === 2,
      JSON.stringify(viewerList.body));
    const crossOrder = await lineList('pol-po-2', 'L1');
    assert('the same line id under another order lists nothing', crossOrder.statusCode === 200 && crossOrder.body.documents.length === 0,
      JSON.stringify(crossOrder.body));
    const noPo = await lineList(undefined, 'L1');
    assert('a line with no order is refused (400)', noPo.statusCode === 400, JSON.stringify(noPo.body));
    const badLine = await lineList('pol-po-1', 'bad line!');
    assert('a malformed line id is refused (400)', badLine.statusCode === 400, JSON.stringify(badLine.body));
    const rivalList = await lineList('pol-po-1', 'L1', OTHERCO);
    assert('another company lists only its own',
      rivalList.statusCode === 200 && rivalList.body.documents.map(d => d.id).join() === rivalUp.documentId, JSON.stringify(rivalList.body));
    const pavList = await lineList('pol-po-1', 'L1', PAVER, 'paving');
    assert('another division lists none of ours', pavList.statusCode === 200 && pavList.body.documents.length === 0,
      JSON.stringify(pavList.body));
    const byOrder = (await call('GET', { division: 'turf', poId: 'pol-po-1' }, null, PM)).body.documents;
    assert('the order\'s paperclip lists every line attachment, with its po_line_ids',
      [up1, up1b, upDr, upBlank, up515].every(u => byOrder.some(d => d.id === u.documentId))
        && byOrder.find(d => d.id === up1.documentId).po_line_ids.includes('pol-po-1:L1'), JSON.stringify(byOrder.map(d => d.id)));

    // ── Detaching ──
    const viewerDetach = await call('PATCH', { division: 'turf', id: up1.documentId }, { removePoLineId: 'pol-po-1:L1' }, VIEWER);
    assert('a view-only user cannot detach (403)', viewerDetach.statusCode === 403, JSON.stringify(viewerDetach.body));
    const foremanOther = await call('PATCH', { division: 'turf', id: up1b.documentId }, { removePoLineId: 'pol-po-1:L1' }, FOREMAN);
    assert('a level2 cannot detach someone else\'s file (403)', foremanOther.statusCode === 403, JSON.stringify(foremanOther.body));
    for (const bad of ['L1', 'pol-po-1:', ':L1', 'pol-po-1:L1:x', 'pol po:L1']) {
      const r = await call('PATCH', { division: 'turf', id: up1.documentId }, { removePoLineId: bad, filename: 'renamed.pdf' }, FOREMAN);
      assert(`detaching refuses "${bad}" (400) and writes nothing`, r.statusCode === 400
        && (await client.query(`SELECT filename FROM project_documents WHERE id = $1`, [up1.documentId])).rows[0].filename !== 'renamed.pdf',
        JSON.stringify(r.body));
    }
    const detached = await call('PATCH', { division: 'turf', id: up1.documentId }, { removePoLineId: 'pol-po-1:L1' }, FOREMAN);
    assert('a level2 detaches its own file from the line',
      detached.statusCode === 200 && JSON.stringify(detached.body.document.po_line_ids) === '[]', JSON.stringify(detached.body));
    assert('…which stays on the order, in the PO subfolder and in the cost-code folder',
      JSON.stringify(detached.body.document.po_ids) === '["pol-po-1"]' && detached.body.document.folder_ids.includes(fPoSub.id)
        && detached.body.document.folder_ids.includes(fPaving.id) && detached.body.document.folder_ids.includes(fPoRoot.id),
      JSON.stringify(detached.body.document));
    assert('…and is never deleted', (await client.query(
      `SELECT deleted_at FROM project_documents WHERE id = $1`, [up1.documentId])).rows[0].deleted_at === null);
    c = await lineCounts();
    pc = (await call('GET', { division: 'turf', poCounts: '1' }, null, PM)).body.counts;
    assert('the line\'s count drops; the order\'s does not', c.body.counts['pol-po-1'].L1 === 1 && pc['pol-po-1'] === 6,
      JSON.stringify({ lines: c.body.counts['pol-po-1'], orders: pc['pol-po-1'] }));
    assert('the order\'s paperclip still lists it',
      (await call('GET', { division: 'turf', poId: 'pol-po-1' }, null, PM)).body.documents.some(d => d.id === up1.documentId));
    assert('and the line\'s list no longer does',
      (await lineList('pol-po-1', 'L1')).body.documents.map(d => d.id).join() === up1b.documentId);
    const trail = (await client.query(
      `SELECT action, detail FROM document_audit_log WHERE document_id = $1 ORDER BY id`, [up1.documentId])).rows;
    assert('the trail has the UNLINK from the line',
      trail.some(r => r.action === 'UNLINK' && r.detail && r.detail.link_type === 'po_line' && r.detail.target_id === 'pol-po-1:L1'),
      JSON.stringify(trail));
    const pmDetach = await call('PATCH', { division: 'turf', id: upDr.documentId }, { removePoLineId: 'pol-po-1:dr-row1' }, PM);
    assert('a level3 may detach anyone\'s file', pmDetach.statusCode === 200
      && pmDetach.body.document.po_line_ids.length === 0 && pmDetach.body.document.folder_ids.includes(fStorm.id), JSON.stringify(pmDetach.body));

    // ── Deleted files never count ──
    await call('DELETE', { division: 'turf', id: upBlank.documentId }, null, ADMIN);
    c = await lineCounts();
    assert('a deleted file stops counting against its line', !('dr-row2' in c.body.counts['pol-po-1']), JSON.stringify(c.body.counts));
    assert('and leaves the line\'s list', (await lineList('pol-po-1', 'dr-row2')).body.documents.length === 0);
    const trashRow = (await call('GET', { division: 'turf', trash: '1' }, null, ADMIN)).body.documents
      .find(d => d.id === upBlank.documentId);
    assert('the trash view still shows which delivery it was on',
      trashRow && JSON.stringify(trashRow.po_line_ids) === '["pol-po-1:dr-row2"]', JSON.stringify(trashRow));
    const restored = await call('PATCH', { division: 'turf', id: upBlank.documentId }, { restore: true }, ADMIN);
    assert('restoring it puts it back on the line', restored.statusCode === 200
      && JSON.stringify(restored.body.document.po_line_ids) === '["pol-po-1:dr-row2"]'
      && (await lineCounts()).body.counts['pol-po-1']['dr-row2'] === 1, JSON.stringify(restored.body));

    // ── A line deleted from the order touches no documents ──
    await setBlob('FCT:fct_purchase_orders:turf', [{ ...PO1, lines: PO1.lines.filter(l => l.id !== 'dr-row3') }, PO2, POGEN, PONOCODE, POJ2]);
    assert('the line\'s files keep their link once the delivery leaves the order',
      (await lineList('pol-po-1', 'dr-row3')).body.documents.map(d => d.id).join() === up515.documentId
        && (await lineCounts()).body.counts['pol-po-1']['dr-row3'] === 1);
    await refused('but nothing new can be attached to it (404)', { folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'dr-row3' }, 404);
    await setBlob('FCT:fct_purchase_orders:turf', [PO1, PO2, POGEN, PONOCODE, POJ2]);
    assert('and a delivery that comes back finds its files', (await lineList('pol-po-1', 'dr-row3')).body.documents.length === 1);

    // ── Central purchasing's carve-out, bound to one order ──
    const BUYER = { companyCode: 'FCT', userId: 9, username: 'buyer-pol', role: 'level1', divisionRoles: { purchase_orders: 'level3' } };
    const carve = await reg(BUYER, { projectId: null, keyProjectId: PJ, query: { poId: 'pol-po-1' }, folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'L1' });
    assert('the carve-out attaches a receipt to a line of ITS order (201)', carve.statusCode === 201, JSON.stringify(carve.body));
    assert('…filed in the order\'s job, under the order, the line and the cost-code folder',
      carve.body.document && carve.body.document.project_id === PJ
        && JSON.stringify(carve.body.document.po_line_ids) === '["pol-po-1:L1"]' && carve.body.costCodeFolderId === fPaving.id
        && has(await linksOf(carve.documentId), 'po', 'pol-po-1'), JSON.stringify(carve.body));
    await refused('the carve-out cannot attach to a line its order does not have (404)',
      { projectId: null, keyProjectId: PJ, query: { poId: 'pol-po-1' }, folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'L2' }, 404, BUYER);
    await refused('nor to another order\'s line (403)',
      { projectId: null, keyProjectId: PJ, query: { poId: 'pol-po-1' }, folderId: fPoSub.id, poId: 'pol-po-2', poLineId: 'L2' }, 403, BUYER);
    await refused('nor name an order the division does not have (403)',
      { projectId: null, keyProjectId: PJ, query: { poId: 'pol-po-nope' }, folderId: fPoSub.id, poId: 'pol-po-nope', poLineId: 'L1' }, 403, BUYER);
    await refused('nor file a line\'s receipt outside purchase-order folders (403)',
      { projectId: null, keyProjectId: PJ, query: { poId: 'pol-po-1' }, folderId: fSafety.id, poId: 'pol-po-1', poLineId: 'L1' }, 403, BUYER);
    const carveCounts = await lineCounts(BUYER, { poId: 'pol-po-1' });
    assert('the carve-out reads its order\'s line counts, and only those',
      carveCounts.statusCode === 200 && JSON.stringify(Object.keys(carveCounts.body.counts)) === '["pol-po-1"]'
        && carveCounts.body.counts['pol-po-1'].L1 === 2, JSON.stringify(carveCounts.body));
    const carveAll = await lineCounts(BUYER);
    assert('but not the division\'s (403)', carveAll.statusCode === 403, JSON.stringify(carveAll.body));
    const carveList = await lineList('pol-po-1', 'L1', BUYER);
    assert('the carve-out lists its order\'s line', carveList.statusCode === 200
      && carveList.body.documents.some(d => d.id === carve.documentId), JSON.stringify(carveList.body));
    const carveNoPo = await call('GET', { division: 'turf', poLineId: 'L1' }, null, BUYER);
    assert('but nothing without naming the order (403)', carveNoPo.statusCode === 403, JSON.stringify(carveNoPo.body));
    const carveDetach = await call('PATCH', { division: 'turf', id: carve.documentId, poId: 'pol-po-1' },
      { removePoLineId: 'pol-po-1:L1' }, BUYER);
    assert('and cannot detach anything (403)', carveDetach.statusCode === 403
      && has(await linksOf(carve.documentId), 'po_line', 'pol-po-1:L1'), JSON.stringify(carveDetach.body));

    // ── Off the order is off its deliveries ──
    // The Vault's "Link to PO" dialog takes a file off an order (removePoId).
    // A delivery's file is on its order too, so that takes it off the order's
    // deliveries as well: a delivery must never list a file its order no
    // longer holds — purchasing download through the order's link, and were
    // shown a file they could not open.
    const unPo = await reg(FOREMAN, { folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'L1' });
    // The same file on another order's delivery, and on two orders whose ids
    // merely look like pol-po-1's (a prefix, and a LIKE wildcard): all stay.
    await client.query(`INSERT INTO document_links (document_id, company_code, link_type, target_id)
      VALUES ($1, 'FCT', 'po', 'pol-po-2'), ($1, 'FCT', 'po_line', 'pol-po-2:L2'),
             ($1, 'FCT', 'po_line', 'pol-po-1x:L1'), ($1, 'FCT', 'po_line', 'pol_po_1:L1')`, [unPo.documentId]);
    const unBefore = (await lineCounts(PM, { poId: 'pol-po-1' })).body.counts['pol-po-1'].L1;
    const unlinked = await call('PATCH', { division: 'turf', id: unPo.documentId }, { removePoId: 'pol-po-1' }, FOREMAN);
    const ud = (unlinked.body && unlinked.body.document) || { po_ids: [], po_line_ids: [], folder_ids: [] };
    assert('removing a delivery file\'s order link takes it off that order\'s deliveries too (200)',
      unlinked.statusCode === 200 && !ud.po_ids.includes('pol-po-1') && !ud.po_line_ids.includes('pol-po-1:L1'),
      JSON.stringify(unlinked.body));
    assert('…and off nothing else: another order and its delivery, and look-alike order ids, keep theirs',
      JSON.stringify(ud.po_ids) === '["pol-po-2"]'
        && JSON.stringify([...ud.po_line_ids].sort()) === JSON.stringify(['pol-po-1x:L1', 'pol-po-2:L2', 'pol_po_1:L1']),
      JSON.stringify(ud));
    assert('…and it stays in every folder it was filed in',
      ud.folder_ids.includes(fPoSub.id) && ud.folder_ids.includes(fPaving.id), JSON.stringify(ud.folder_ids));
    const unLinks = await linksOf(unPo.documentId);
    assert('stored: no po_line link to pol-po-1 is left behind',
      !unLinks.some(r => r.link_type === 'po_line' && r.target_id.split(':')[0] === 'pol-po-1')
        && !has(unLinks, 'po', 'pol-po-1'), JSON.stringify(unLinks));
    const unAfter = await lineCounts(PM, { poId: 'pol-po-1' });
    assert('the delivery\'s paperclip stops counting it',
      unAfter.body.counts['pol-po-1'].L1 === unBefore - 1, JSON.stringify({ before: unBefore, after: unAfter.body }));
    assert('…and its list stops listing it',
      !(await lineList('pol-po-1', 'L1')).body.documents.some(d => d.id === unPo.documentId));
    assert('…as does the order\'s, as before',
      !(await call('GET', { division: 'turf', poId: 'pol-po-1' }, null, PM)).body.documents.some(d => d.id === unPo.documentId));
    const carveUn = await lineList('pol-po-1', 'L1', BUYER);
    assert('so purchasing are never listed a delivery file they cannot open',
      carveUn.statusCode === 200 && !carveUn.body.documents.some(d => d.id === unPo.documentId), JSON.stringify(carveUn.body));
    const unTrail = (await client.query(
      `SELECT action, detail FROM document_audit_log WHERE document_id = $1 AND action = 'UNLINK' ORDER BY id`,
      [unPo.documentId])).rows;
    assert('the trail records the order AND each delivery it came off, and nothing else',
      unTrail.some(r => r.detail.link_type === 'po' && r.detail.target_id === 'pol-po-1')
        && unTrail.some(r => r.detail.link_type === 'po_line' && r.detail.target_id === 'pol-po-1:L1' && r.detail.via === 'removePoId')
        && unTrail.length === 2, JSON.stringify(unTrail));
    await client.query(`DELETE FROM document_links WHERE document_id = $1 AND link_type IN ('po', 'po_line')`, [unPo.documentId]);

    // ── On the order exactly when on the delivery ──
    // A register cut off part-way (a platform timeout, a dropped connection)
    // must not leave a delivery's file on the order alone: "is it on the
    // order?" is how a purchasing phone decides that an attach it never heard
    // back from went through. Fail whichever statement writes the line link.
    const realQuery = client.query;
    client.query = function (text, values) {
      if (typeof text === 'string' && /INSERT INTO document_links/.test(text) && /'po_line'/.test(text)) {
        return Promise.reject(new Error('Connection terminated unexpectedly'));
      }
      return realQuery.apply(this, arguments);
    };
    const origErr = console.error;
    let cut;
    try {
      console.error = () => {};
      cut = await reg(PM, { folderId: fPoSub.id, poId: 'pol-po-1', poLineId: 'dr-row1' });
    } finally {
      client.query = realQuery;
      console.error = origErr;
    }
    const cutOnOrder = (await call('GET', { division: 'turf', poId: 'pol-po-1' }, null, PM)).body.documents
      .some(d => d.id === cut.documentId);
    const cutOnLine = (await lineList('pol-po-1', 'dr-row1')).body.documents.some(d => d.id === cut.documentId);
    assert('a register cut off at the delivery\'s link fails (500)…', cut.statusCode === 500, JSON.stringify(cut.body));
    assert('…and leaves the file on the order exactly when it is on the delivery',
      cutOnOrder === cutOnLine, JSON.stringify({ cutOnOrder, cutOnLine, links: await linksOf(cut.documentId) }));
    await client.query(`DELETE FROM document_links WHERE document_id = $1`, [cut.documentId]);
    await client.query(`DELETE FROM project_documents WHERE id = $1`, [cut.documentId]);

    await restorePoBlobs();
    const back = (await client.query(
      `SELECT key FROM app_data WHERE key IN ('FCT:fct_purchase_orders:turf','FCT:fct_purchase_orders:paving','OTH:fct_purchase_orders:turf')
         AND value::text LIKE '%pol-po-%'`)).rows;
    assert('the PO lists are put back as they were', back.length === 0, JSON.stringify(back));
  }

  // ── The folder chips' counts, counts only ──────────────────────────────
  // GET ?costCodeCounts=1 answers what the browser used to count from the
  // job's whole listing (documents.js countByCostCode), without the listing.
  // Held to that: the same numbers, in the same order, as counting the
  // listing GET returns for the same job.
  {
    console.log('\nCost-code folder counts (?costCodeCounts)');
    const { countByCostCode } = require(path.resolve(__dirname, '..', 'api', 'lib', 'cost-code-counts.js'));
    const CJ = 'proj-ccc-1', CJ2 = 'proj-ccc-2';
    const ccCounts = (pid, auth = PM, extra = {}) =>
      call('GET', { division: 'turf', costCodeCounts: '1', ...(pid ? { projectId: pid } : {}), ...extra }, null, auth);
    const listing = async pid => (await call('GET', { division: 'turf', projectId: pid }, null, PM)).body;

    const none = await ccCounts(CJ);
    assert('a job with no folders yet answers 200 with no counts', none.statusCode === 200
      && JSON.stringify(none.body.counts) === JSON.stringify({}) && /^[0-9a-f]{32}$/.test(none.body.version || ''),
      JSON.stringify(none.body));

    // Codes as a bid really carries them: integer-like ones (which reorder a
    // plain object), and Stormwater twice, once with a trailing space.
    const t1 = (await call('PUT', { division: 'turf', projectId: CJ }, {
      costCodes: [{ code: '420', label: 'Paving' }, { code: '411', label: '' }, { code: 'Stormwater', label: '' },
        { code: 'Stormwater ', label: 'Storm Sewer' }, { code: 'Empty', label: '' }],
    }, PM)).body.folders;
    await call('PUT', { division: 'turf', projectId: CJ2 }, { costCodes: [{ code: '420', label: 'Paving' }] }, PM);
    const f = c => t1.find(x => x.kind === 'cost_code' && x.cost_code === c);
    const safetyC = t1.find(x => x.slug === 'safety');
    const sub = (await call('POST', { division: 'turf', projectId: CJ, folder: '1' }, { name: 'Tickets', parentId: f('420').id }, PM)).body.folder;
    const subsub = (await call('POST', { division: 'turf', projectId: CJ, folder: '1' }, { name: 'Week 1', parentId: sub.id }, PM)).body.folder;
    assert('fixture: the cost-code folders and a nested subfolder exist',
      Boolean(f('420') && f('411') && f('Stormwater') && f('Stormwater ') && f('Empty') && sub && subsub),
      t1.map(x => `${x.name}|${x.cost_code}`).join(' / '));

    const up = async (folderId, name, pid = CJ) => (await upload(folderId, name, PM, { projectId: pid })).body.document.id;
    await up(f('420').id, 'a.pdf');
    await up(sub.id, 'in-sub.pdf');
    await up(subsub.id, 'two-down.pdf');
    const both = await up(f('420').id, 'both.pdf');
    await call('PATCH', { division: 'turf', id: both }, { addFolderId: sub.id }, PM);          // 420 and its subfolder: once
    const gone = await up(f('420').id, 'deleted.pdf');
    await call('DELETE', { division: 'turf', id: gone }, null, ADMIN);                          // in the bin: not counted
    await up(f('411').id, 'b.pdf');
    const sw = await up(f('Stormwater').id, 'sw.pdf');
    await call('PATCH', { division: 'turf', id: sw }, { addFolderId: f('Stormwater ').id }, PM); // both spellings: once
    await up(f('Stormwater ').id, 'sw-space.pdf');
    await up(safetyC.id, 'safety.pdf');                                                         // not a cost-code folder
    await up((await listing(CJ2)).folders.find(x => x.cost_code === '420').id, 'other-job.pdf', CJ2);

    const got = await ccCounts(CJ);
    const lst = await listing(CJ);
    const fromListing = countByCostCode(lst.folders, lst.documents);
    assert('?costCodeCounts gives each cost code its count: subfolders included, each file once, the bin and other jobs left out',
      got.statusCode === 200 && got.body.counts['420'] === 4 && got.body.counts['411'] === 1
        && got.body.counts.Stormwater === 2 && got.body.counts.Empty === 0, JSON.stringify(got.body));
    assert('…exactly what counting the job\'s whole listing gives, codes in the same order',
      JSON.stringify(Object.entries(got.body.counts)) === JSON.stringify(Object.entries(fromListing)),
      `${JSON.stringify(got.body.counts)} vs ${JSON.stringify(fromListing)}`);
    assert('…and nothing but the counts and the job\'s fingerprint: no folders, no documents, no file names',
      Object.keys(got.body).sort().join() === 'counts,version' && !/pdf/.test(JSON.stringify(got.body)), JSON.stringify(got.body));
    assert('another job is counted on its own', JSON.stringify((await ccCounts(CJ2)).body.counts) === JSON.stringify({ 420: 1 }));

    const viewerGot = await ccCounts(CJ, VIEWER);
    assert('a view-only user reads the same counts (they may read the listing)', viewerGot.statusCode === 200
      && JSON.stringify(viewerGot.body) === JSON.stringify(got.body), JSON.stringify(viewerGot.body));
    const rival = await ccCounts(CJ, OTHERCO);
    assert('another company sees none of it', rival.statusCode === 200
      && JSON.stringify(rival.body.counts) === JSON.stringify({}), JSON.stringify(rival.body));
    const paver = await call('GET', { division: 'paving', costCodeCounts: '1', projectId: CJ }, null, PAVER);
    assert('nor does the same job id in another division', paver.statusCode === 200
      && JSON.stringify(paver.body.counts) === JSON.stringify({}), JSON.stringify(paver.body));
    const noTurf = await ccCounts(CJ, PAVER);
    assert('a user without the division is refused (403)', noTurf.statusCode === 403, JSON.stringify(noTurf.body));
    const BUYER2 = { companyCode: 'FCT', userId: 8, username: 'buyer2', role: 'level1', divisionRoles: { purchase_orders: 'level3' } };
    const carve = await ccCounts(CJ, BUYER2);
    assert('central purchasing without a role in the division is refused (403)', carve.statusCode === 403, JSON.stringify(carve.body));
    const general = await ccCounts(null);
    assert('no projectId counts the General area, as the listing does (no cost-code folders there)',
      general.statusCode === 200 && JSON.stringify(general.body.counts) === JSON.stringify(
        countByCostCode((await call('GET', { division: 'turf' }, null, PM)).body.folders,
          (await call('GET', { division: 'turf' }, null, PM)).body.documents)), JSON.stringify(general.body));

    // A folder seeded before the cost_code column, known only by its slug.
    await client.query(
      `INSERT INTO project_folders (id, company_code, division, project_id, parent_id, name, kind, slug, cost_code, sort_order)
       VALUES ('ccc-legacy', 'FCT', 'turf', $1, NULL, '530 · Curb', 'cost_code', 'cc-530', NULL, 50)`, [CJ]);
    await up('ccc-legacy', 'legacy.pdf');
    const withLegacy = await ccCounts(CJ);
    const lst2 = await listing(CJ);
    assert('a slug-only cost-code folder from before the cost_code column is counted by its slug, as the browser does',
      withLegacy.body.counts['530'] === 1
        && JSON.stringify(Object.entries(withLegacy.body.counts)) === JSON.stringify(Object.entries(countByCostCode(lst2.folders, lst2.documents))),
      JSON.stringify(withLegacy.body.counts));

    // Two codes that read alike, in folders whose sort_order, name and id
    // orders all disagree: the endpoint's keys come out in the listing's
    // order, which is the order costCodeCount()'s codeKey fallback searches.
    await client.query(
      `INSERT INTO project_folders (id, company_code, division, project_id, parent_id, name, kind, slug, cost_code, sort_order)
       VALUES ('ccc-a', 'FCT', 'turf', $1, NULL, 'ZZ Walkway', 'cost_code', 'cc-Walk – Way', 'Walk – Way', 60),
              ('ccc-b', 'FCT', 'turf', $1, NULL, 'AA Walkway', 'cost_code', 'cc-Walk - Way', 'Walk - Way', 61)`, [CJ]);
    await up('ccc-a', 'walk-1.pdf');
    await up('ccc-a', 'walk-2.pdf');
    await up('ccc-b', 'walk-3.pdf');
    const ordered = (await ccCounts(CJ)).body.counts;
    const lst3 = await listing(CJ);
    const keysOf = o => Object.keys(o).filter(k => /^Walk/.test(k));
    assert('codes that read alike come out in the listing\'s folder order (sort_order, then name), not by name or id',
      JSON.stringify(keysOf(ordered)) === JSON.stringify(['Walk – Way', 'Walk - Way'])
        && JSON.stringify(Object.keys(ordered)) === JSON.stringify(Object.keys(countByCostCode(lst3.folders, lst3.documents))),
      JSON.stringify(Object.keys(ordered)));

    // The job's fingerprint: the listing and every count answer carry it, and
    // it moves whenever anything the listing shows moves — counted or not.
    const ver = async (pid = CJ) => (await ccCounts(pid)).body.version;
    const v0 = await ver();
    const listedV = (await listing(CJ)).version;
    assert('the listing and the counts carry the same fingerprint for an unchanged job',
      /^[0-9a-f]{32}$/.test(v0 || '') && listedV === v0 && (await ver()) === v0, `${listedV} / ${v0}`);
    const swapOut = (await listing(CJ)).documents.find(d => d.filename === 'b.pdf');
    await call('DELETE', { division: 'turf', id: swapOut.id }, null, ADMIN);
    await up(f('411').id, 'b-rev2.pdf');
    const vSwap = await ver();
    assert('a file swapped for another moves no count but moves the fingerprint',
      (await ccCounts(CJ)).body.counts['411'] === 1 && vSwap !== v0, `${v0} -> ${vSwap}`);
    const renameMe = (await listing(CJ)).documents.find(d => d.filename === 'b-rev2.pdf');
    await call('PATCH', { division: 'turf', id: renameMe.id }, { filename: 'b-rev2 (signed).pdf' }, PM);
    const vRename = await ver();
    assert('so does a rename', vRename !== vSwap);
    await call('PATCH', { division: 'turf', id: renameMe.id }, { addFolderId: safetyC.id }, PM);
    const vLink = await ver();
    assert('and filing a file in one more folder', vLink !== vRename);
    await call('POST', { division: 'turf', projectId: CJ, folder: '1' }, { name: 'Submittals 2', parentId: f('411').id }, PM);
    const vFolder = await ver();
    assert('and a new empty folder', vFolder !== vLink);
    await up((await listing(CJ2)).folders.find(x => x.cost_code === '420').id, 'other-job-2.pdf', CJ2);
    assert('but nothing on another job moves it', (await ver()) === vFolder);
    assert('…and a listing read now carries the fingerprint the counts give', (await listing(CJ)).version === vFolder);
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
  try { await cleanProcurement(); } catch {}
  try { await restorePoBlobs(); } catch {}
  try { await client.end(); } catch {}
  process.exit(1);
});
