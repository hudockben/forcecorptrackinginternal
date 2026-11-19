#!/usr/bin/env node
'use strict';
/**
 * Purchase-order delivery-line attachments, end to end in a real browser.
 *
 * Run: node scripts/test-po-line-attachments-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *      PW_CHROMIUM=/path/to/chrome picks the browser binary.
 *      PO_LINE_SHOTS=/some/dir also saves, at twice the pixels, the PO tab with
 *      its delivery paperclips counting (po-tab.png) and a delivery's
 *      attachments dialog (po-line-dialog.png) there. For looking at, not
 *      asserted.
 *
 * The other suites cover the halves: scripts/test-documents-sql.js the real
 * endpoint on Postgres, scripts/test-documents-frontend.js documents.js in
 * jsdom, scripts/test-po-page.js / test-po-daily-sync.js the pages' markup and
 * wiring, scripts/test-po-attach.js purchase-orders.html's attach. None has
 * them meeting in a browser: the real PO tab (its saves, its focus, its
 * in-place repaint), the real documents.js dialogs and upload, and a Vault
 * that files a delivery's file the way api/documents.js does.
 *
 * The network is answered by in-memory stand-ins that follow the contract:
 *  - /api/purchase-orders and /api/daily-rows keep the division's orders and
 *    job rows, and record Daily Tracking deliveries with the SERVER's own
 *    api/lib/po-sync.js — so the 'dr-' line on the order is the one the real
 *    derivation would store, with its row's cost code;
 *  - /api/documents, /api/document-upload-url and the bucket: a register with
 *    poLineId is validated against the STORED order (404 for an order or a
 *    delivery the server does not have, 400 for another job), then linked to
 *    the order ('po'), filed in its PO subfolder, linked to the delivery
 *    ('po_line', "<poId>:<lineId>") and filed in the cost-code folder of the
 *    delivery's code, else the order's — with the server's own helpers from
 *    api/lib/po-line-docs.js. Detach (PATCH removePoLineId) takes the 'po_line'
 *    link only. The purchasing carve-out is modelled the way the real gate
 *    answers it: every request names an order, and delivery counts come for
 *    that order only.
 *
 * Scenario:
 *  - tracker.html's PO tab as an admin: an order on a job with cost code 420
 *    and two deliveries, one raised by hand and one from Daily Tracking whose
 *    row carries the Stormwater code. Each Invoice / Ticket # cell has an
 *    empty paperclip; attach a ticket to each from its own dialog; the counts
 *    land in place (the cursor stays in the box being typed in), the order's
 *    paperclip counts them too, and the links are what the server keeps;
 *    detaching takes the file off the delivery only.
 *  - tracker.html as a level1: the paperclips are there, a delivery's files
 *    list and download, and nothing offers to attach or detach.
 *  - paving.html: the paperclip draws and opens its delivery.
 *  - purchase-orders.html as a purchasing user: a delivery's paperclip opens
 *    the attachments sheet for that delivery, counted per order, and a file
 *    attached there is registered with its poLineId.
 *
 * Harness traps (see test-row-delete-browser.js): served over HTTP, not
 * file://, and fct_division must match the page or it bounces to
 * divisions.html.
 */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('playwright not installed — skipping browser checks'); process.exit(0); }
const path = require('path');
const http = require('http');
const fs   = require('fs');
const poSync = require('../api/lib/po-sync');
// The server's own rules for a delivery's link and its cost code.
const { poLineTarget, parsePoLineTarget, findLine, lineCostCode, isPoLinePart } = require('../api/lib/po-line-docs');
const { codeKey } = require('../api/lib/procurement-docs');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const SHOTS = process.env.PO_LINE_SHOTS || '';

const server = http.createServer((req, res) => {
  // Vercel's own analytics script, injected by the host in production.
  if (req.url.startsWith('/_vercel/')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(''); }
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('no');
  }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
const BASE = new Promise(r => server.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + server.address().port)));

let passed = 0, failed = 0;
const ok = (l, c, d) => {
  if (c) { passed++; console.log('  ✓ ' + l); }
  else   { failed++; console.log('  ✗ ' + l + (d !== undefined && d !== '' ? '  — ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(50);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = a => a.slice().sort();
const CLIP = '\u{1F4CE}';
// A gate the test opens when it is ready: { promise, open }.
const gate = () => { let open; const promise = new Promise(r => { open = r; }); return { promise, open }; };
const PDF = name => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% ' + name + '\n%%EOF\n') });

// ── The divisions the pages are booted into ──────────────────────────────────
const PAGES = {
  turf:   { file: 'tracker.html',  division: 'turf',   lists: 'fct_lists',
            index: 'fct_projects_index',        project: 'fct_project_' },
  paving: { file: 'paving.html',   division: 'paving', lists: 'fct_paving_lists',
            index: 'fct_paving_projects_index', project: 'fct_paving_project_' },
};
const JOB = { id: 'p1', 'project-name': 'Main St', 'job-number': '2601', status: 'In Progress',
  bidItems: [{ id: 'b1', cost_code: '420', sub_code: 'Base', description: 'Stone base', unit: 'TON', quantity: '100' }] };
const LISTS = { equipment: [], employees: [{ name: 'Sam' }, { name: 'Lee' }], suppliers: [{ name: 'Acme Stone' }],
  _crm_lists_seeded: true };

// A page's Daily Tracking row, as the server holds it for the derivation.
const asDbRow = r => ({
  row_id: String(r.id), project_id: r._projectId, date: r.date, employee: r.employee,
  cost_code: r.cost_code, sub_code: r.sub_code, po_num: r.po_num,
  units_purchased: r.units_purchased, unit_cost: r.unit_cost, material_cost: r.material_cost,
  timesheet_entry_id: r.timesheet_entry_id || null,
});

const DOC_FIXED = [['contract-change-orders', 'Contract'], ['change-orders', 'Change Orders'],
  ['permits-insurance', 'Permits & Insurance'], ['submittals', 'Submittals'], ['safety', 'Safety'],
  ['photos', 'Photos'], ['repairs', 'Repairs'], ['closeout', 'Closeout'], ['purchase-orders', 'Purchase Orders']];

/**
 * One company's world: per division, its orders and job rows; one Vault.
 * The turf order PO-0003 is on job p1 under cost code 420, with a delivery
 * raised by hand (L1, INV-7) and the Daily Tracking delivery of row r1, whose
 * own code is Stormwater. It already has one file of its own, on the order
 * and in its PO subfolder.
 */
function makeWorld() {
  const W = {
    seq: 0,
    divs: {},
    docs: { folders: [], documents: [], links: [] },
    stored: [],
    docLog: [],          // every call to the Vault: { api, method, q, body, role }
    poLog: [],           // every write to /api/purchase-orders
    holdLineCounts: null, // a gate the next ?poLineCounts answer waits on
    heldLineCounts: 0,
  };
  const div = (division, orders, rows) => {
    const d = { rows: new Map(rows.map(r => [r.id, r])), blob: orders, updatedAt: '2026-11-10T00:00:00.000Z', v: 0 };
    d.dbRows = () => [...d.rows.values()].map(asDbRow);
    poSync.deriveDailyLines(d.blob, d.dbRows());
    W.divs[division] = d;
    return d;
  };
  div('turf', [{
    id: 'po3', po_number: 'PO-0003', title: 'Aggregate', supplier: 'Acme Stone', status: 'pending',
    date_created: '2026-11-01', project_id: 'p1', cost_code: '420', sub_code: 'Base', notes: '',
    lines: [{ id: 'L1', invoice_num: 'INV-7', date: '2026-11-02', qty: '3', unit_cost: '10', tax_pct: '', tax: '',
              employee: 'Sam', po_row_id: null }],
  }], [{ id: 'r1', _projectId: 'p1', date: '2026-11-03', field_type: 'Material', employee: 'Lee',
         cost_code: 'Stormwater', sub_code: '0420', material: 'Geofabric', supplier: 'Acme Stone',
         po_num: 'PO-0003', units_purchased: '20', unit_cost: '16', material_cost: '320' }]);
  div('paving', [{
    id: 'po5', po_number: 'PO-0005', title: 'Base', supplier: 'Acme Stone', status: 'pending',
    date_created: '2026-11-01', project_id: 'p1', cost_code: '420', sub_code: 'Base', notes: '',
    lines: [{ id: 'L9', invoice_num: 'T-55', date: '2026-11-04', qty: '1', unit_cost: '5', tax_pct: '', tax: '',
              employee: 'Sam', po_row_id: null }],
  }], []);
  div('kiewit', [], []);
  div('purchase_orders', [], []);

  // The job's tree as an earlier order-level attach left it: the fixed
  // folders, the Purchase Orders root, the order's own subfolder, and the 420
  // folder the bid seeds. Stormwater has no folder yet.
  for (const division of ['turf', 'paving']) {
    for (const [slug, name] of DOC_FIXED) addFolder(W, division, 'p1', { slug, name, kind: 'fixed' });
    addFolder(W, division, 'p1', { slug: 'cc-420', name: '420 · Base', kind: 'cost_code', cost_code: '420' });
  }
  const root = W.docs.folders.find(f => f.division === 'turf' && f.slug === 'purchase-orders');
  const sub = addFolder(W, 'turf', 'p1', { slug: 'po-po3', name: 'PO PO-0003', kind: 'fixed', parent_id: root.id });
  W.docs.documents.push({ id: 'doc-quote', division: 'turf', project_id: 'p1', filename: 'quote.pdf',
    content_type: 'application/pdf', size_bytes: 2048, note: null, uploaded_by: 'ada',
    uploaded_at: '2026-11-01T09:00:00.000Z', deleted_at: null });
  W.docs.links.push({ document_id: 'doc-quote', link_type: 'folder', target_id: sub.id },
                    { document_id: 'doc-quote', link_type: 'po', target_id: 'po3' });
  return W;
}

function addFolder(W, division, projectId, { slug, name, kind, cost_code = null, parent_id = null }) {
  const f = { id: `fold${++W.seq}`, division, project_id: projectId, parent_id, name, kind, slug, cost_code,
    sort_order: kind === 'cost_code' ? 800 : W.docs.folders.length, archived: false };
  W.docs.folders.push(f);
  return f;
}

// ── api/documents.js, in memory ──────────────────────────────────────────────
// api/lib/auth.js capabilities(): level1 reads, level2 uploads (and tidies its
// own), level3 manages, admin deletes. 'purchasing' is central purchasing's
// carve-out: it uploads to an order it names, and nothing else.
const UPLOADERS = ['admin', 'level3', 'level2', 'purchasing'];
const docCaps = role => ({
  level: role,
  canUpload: UPLOADERS.includes(role),
  canManage: role === 'admin' || role === 'level3',
  canDelete: role === 'admin',
});
const PO_LINE_ID_SHAPE = 'poLineId and poId must each be 1 to 128 letters, digits, ., - or _';

function documentsApi(W, division, role, username, method, q, body) {
  const D = W.docs;
  const caps = docCaps(role);
  const pid = q.projectId ? String(q.projectId) : null;
  const orders = (W.divs[division] || { blob: [] }).blob;
  const stamp = () => new Date(Date.UTC(2026, 10, 12) + (++W.seq) * 1000).toISOString();
  const linked = (d, type) => [...new Set(D.links.filter(l => l.document_id === d.id && l.link_type === type).map(l => l.target_id))];
  const out = d => ({ id: d.id, project_id: d.project_id, filename: d.filename, content_type: d.content_type,
    size_bytes: d.size_bytes, note: d.note, uploaded_by: d.uploaded_by, uploaded_at: d.uploaded_at, deleted_at: d.deleted_at,
    folder_ids: linked(d, 'folder'), po_ids: linked(d, 'po'), procurement_ids: linked(d, 'procurement'),
    po_line_ids: linked(d, 'po_line') });
  const live = d => !d.deleted_at && d.division === division;
  const newestFirst = (a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at));
  const link = (document_id, link_type, target_id) => {
    if (!D.links.some(l => l.document_id === document_id && l.link_type === link_type && l.target_id === target_id)) {
      D.links.push({ document_id, link_type, target_id });
    }
  };
  const mine = projectId => D.folders.filter(f => f.division === division && (f.project_id || null) === (projectId || null));
  const folderOut = f => ({ id: f.id, parent_id: f.parent_id, name: f.name, kind: f.kind, slug: f.slug,
    cost_code: f.cost_code, sort_order: f.sort_order, archived: f.archived });
  // findCostCodeFolder: exact, then as it reads on screen, then the slug.
  const costCodeFolder = (projectId, code) => {
    const want = String(code).trim(), key = codeKey(want);
    const cc = mine(projectId).filter(f => f.kind === 'cost_code' && f.cost_code != null);
    return cc.find(f => String(f.cost_code).trim() === want) || cc.find(f => codeKey(f.cost_code) === key)
      || mine(projectId).find(f => f.slug === `cc-${code}`) || null;
  };
  // ensurePoFolder: the order's own subfolder under the Purchase Orders root
  // (Unassigned POs in the General area), made on the first attach.
  const ensurePoFolder = (projectId, poId, poNumber) => {
    const root = mine(projectId).find(f => f.slug === (projectId ? 'purchase-orders' : 'unassigned-pos'));
    if (!root) return null;
    const hit = mine(projectId).find(f => f.slug === `po-${poId}`);
    if (hit) return hit;
    return addFolder(W, division, projectId, { slug: `po-${poId}`, name: poNumber ? `PO ${poNumber}` : `PO ${String(poId).slice(0, 8)}`,
      kind: 'fixed', parent_id: root.id });
  };

  if (role === 'no_access') return [403, { error: 'You do not have access to this division' }];
  // The carve-out (api/documents.js poScope): every request names an order of
  // this division, and is held to that order.
  let poScope = null;
  if (role === 'purchasing') {
    poScope = orders.find(o => o.id === q.poId) || null;
    if (!poScope) return [403, { error: 'You do not have access to this division' }];
  }

  if (method === 'GET') {
    if (q.poCounts) {
      const counts = {};
      for (const d of D.documents.filter(live)) for (const id of linked(d, 'po')) counts[id] = (counts[id] || 0) + 1;
      return [200, { counts }];
    }
    if (q.poLineCounts) {
      const onePo = q.poId ? String(q.poId) : null;
      if (poScope && onePo !== poScope.id) return [403, { error: 'You do not have access to this division' }];
      if (onePo !== null && !isPoLinePart(onePo)) return [400, { error: PO_LINE_ID_SHAPE }];
      const counts = {};
      for (const d of D.documents.filter(live)) {
        for (const t of linked(d, 'po_line')) {
          const p = parsePoLineTarget(t);
          if (!p || (onePo !== null && p.poId !== onePo)) continue;
          (counts[p.poId] || (counts[p.poId] = {}))[p.lineId] = ((counts[p.poId] || {})[p.lineId] || 0) + 1;
        }
      }
      return [200, { counts }];
    }
    if (q.poLineId) {
      const onePo = q.poId ? String(q.poId) : null;
      if (poScope && onePo !== poScope.id) return [403, { error: 'You do not have access to this division' }];
      const target = onePo === null ? null : poLineTarget(onePo, q.poLineId);
      if (!target) return [400, { error: PO_LINE_ID_SHAPE }];
      return [200, { documents: D.documents.filter(d => live(d) && linked(d, 'po_line').includes(target)).sort(newestFirst).map(out) }];
    }
    if (q.poId) return [200, { documents: D.documents.filter(d => live(d) && linked(d, 'po').includes(q.poId)).sort(newestFirst).map(out) }];
    if (q.procurementCounts) return [200, { counts: {} }];
    if (q.costCodeCounts) return [200, { counts: {} }];
    if (q.trash) return [200, { documents: [] }];
    return [200, {
      folders: mine(pid).map(folderOut),
      documents: D.documents.filter(d => live(d) && (d.project_id || null) === pid).sort(newestFirst).map(out),
      caps,
    }];
  }

  // The seed: the fixed folders, the Purchase Orders root, one folder per cost
  // code on the job's bid (never from the carve-out, which cannot seed codes).
  if (method === 'PUT') {
    if (!caps.canUpload) return [403, { error: 'You do not have permission to change folders' }];
    if (pid) {
      for (const [slug, name] of DOC_FIXED) {
        if (!mine(pid).some(f => f.slug === slug)) addFolder(W, division, pid, { slug, name, kind: 'fixed' });
      }
      for (const c of (!poScope && body && body.costCodes) || []) {
        if (!c || !c.code) continue;
        const code = String(c.code);
        if (mine(pid).some(f => f.slug === `cc-${code}` || f.cost_code === code)) continue;
        addFolder(W, division, pid, { slug: `cc-${code}`, name: c.label ? `${code} · ${c.label}` : code, kind: 'cost_code', cost_code: code });
      }
    } else if (!mine(null).some(f => f.slug === 'unassigned-pos')) {
      addFolder(W, division, null, { slug: 'unassigned-pos', name: 'Unassigned POs', kind: 'fixed' });
    }
    return [200, { folders: mine(pid).map(folderOut), created: [], reordered: [], relabelled: [], collisions: [] }];
  }

  // Register a file the browser just put in storage.
  if (method === 'POST') {
    if (!caps.canUpload) return [403, { error: 'You do not have permission to upload' }];
    const b = body || {};
    if (poScope && String(b.poId || '') !== poScope.id) return [403, { error: 'You do not have access to this division' }];
    if (!b.documentId || !b.filename || !b.storageKey) return [400, { error: 'documentId, filename and storageKey are required' }];
    if (!W.stored.some(s => s.key === b.storageKey)) return [400, { error: 'That file never reached storage' }];
    const folder = mine(pid).find(f => f.id === b.folderId);
    if (!folder) return [404, { error: 'Folder not found' }];
    const poId = b.poId ? String(b.poId) : null;
    const poLineId = b.poLineId == null || b.poLineId === '' ? null : String(b.poLineId);
    if (poLineId !== null && !poId) return [400, { error: 'poLineId needs the poId of its order' }];
    if (poLineId !== null && !poLineTarget(poId, poLineId)) return [400, { error: PO_LINE_ID_SHAPE }];
    // A delivery has to be on its STORED order, in the order's own job.
    let order = null, line = null;
    if (poLineId) {
      order = orders.find(o => o.id === poId) || null;
      if (!order) return [404, { error: 'Purchase order not found' }];
      line = findLine(order, poLineId);
      if (!line) {
        return [404, { error: 'Delivery line not found',
          detail: 'That delivery is not on the order yet — it may not have been saved. Wait a moment and try again.' }];
      }
      if ((order.project_id ? String(order.project_id) : null) !== pid) return [400, { error: 'That delivery belongs to another job' }];
    }
    const d = { id: b.documentId, division, project_id: pid, filename: b.filename, content_type: 'application/pdf',
      size_bytes: Number(b.sizeBytes) || 0, note: b.note || null, uploaded_by: username, uploaded_at: stamp(), deleted_at: null };
    D.documents.push(d);
    link(d.id, 'folder', folder.id);
    if (poId) {
      link(d.id, 'po', poId);
      const sub = ensurePoFolder(pid, poId, b.poNumber || (order && order.po_number));
      if (sub) link(d.id, 'folder', sub.id);
    }
    let costCodeFolderId = null;
    if (poLineId) {
      link(d.id, 'po_line', poLineTarget(poId, poLineId));
      const code = pid ? lineCostCode(order, line) : null;
      if (code) {
        const cc = costCodeFolder(pid, code) || addFolder(W, division, pid, { slug: `cc-${code}`, name: code, kind: 'cost_code', cost_code: code });
        link(d.id, 'folder', cc.id);
        costCodeFolderId = cc.id;
      }
    }
    return [201, { document: out(d), costCodeFolderId }];
  }

  // Link edits: only the delivery's detach is asked of it here. It takes the
  // 'po_line' link and nothing else.
  if (method === 'PATCH') {
    if (poScope) return [403, { error: 'Only a role in this division can change a document' }];
    const d = D.documents.find(x => x.id === q.id && x.division === division);
    if (!d) return [404, { error: 'Document not found' }];
    if (!caps.canManage && !(caps.canUpload && d.uploaded_by === username)) return [403, { error: 'You can only change your own uploads' }];
    const b = body || {};
    if (!eq(Object.keys(b), ['removePoLineId'])) return [400, { error: 'not modelled here', body: b }];
    if (!parsePoLineTarget(String(b.removePoLineId))) return [400, { error: 'removePoLineId must be "<poId>:<lineId>"' }];
    D.links = D.links.filter(l => !(l.document_id === d.id && l.link_type === 'po_line' && l.target_id === String(b.removePoLineId)));
    return [200, { document: out(d) }];
  }
  return [400, { error: 'not modelled here' }];
}

/** The Vault and the bucket, on a browser context. `role` is the caller's role,
 *  or a function of the division asked about. */
async function routeVault(ctx, page, W, roleIn, username) {
  const base = await BASE;
  const roleFor = typeof roleIn === 'function' ? roleIn : () => roleIn;
  await page.route('**/api/document**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    const q = Object.fromEntries(u.searchParams);
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const send = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const division = q.division;
    const role = roleFor(division);
    if (p === '/api/documents') {
      W.docLog.push({ api: 'documents', method: m, q, body, role });
      if (m === 'GET' && q.poLineCounts && W.holdLineCounts) {
        const h = W.holdLineCounts; W.holdLineCounts = null; W.heldLineCounts++;
        await h.promise;
      }
      const [status, b] = documentsApi(W, division, role, username, m, q, body || {});
      return send(status, b);
    }
    if (p === '/api/document-upload-url') {
      W.docLog.push({ api: 'document-upload-url', method: m, q, body, role });
      if (m === 'DELETE') return send(200, { ok: true });
      if (m !== 'POST' || !docCaps(role).canUpload) return send(403, { error: 'You do not have permission to upload' });
      const documentId = `doc${++W.seq}`;
      const filename = String((body && body.filename) || 'file');
      const storageKey = `FCT/${division}/${(body && body.projectId) || 'general'}/${documentId}/${filename}`;
      return send(200, { documentId, storageKey, uploadUrl: `${base}/upload/${encodeURIComponent(storageKey)}`,
        contentType: 'application/pdf', maxBytes: 50 * 1024 * 1024, expiresIn: 900 });
    }
    if (p === '/api/document-download') {
      W.docLog.push({ api: 'document-download', method: m, q, body, role });
      return send(200, { url: `${base}/_files/${encodeURIComponent(q.id || '')}` });
    }
    return send(404, { error: 'no such endpoint' });
  });
  await ctx.route('**/upload/**', async route => {
    const req = route.request();
    if (req.method() === 'PUT') {
      W.stored.push({ key: decodeURIComponent(new URL(req.url()).pathname.slice('/upload/'.length)),
        bytes: (req.postDataBuffer() || Buffer.alloc(0)).length });
    }
    return route.fulfill({ status: 200, body: '' });
  });
  await ctx.route('**/_files/**', route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'file' }));
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = (m.location() && m.location().url) || '';
    // A resource the sandbox cannot fetch from the internet is not this page's.
    if (/Failed to load resource/.test(m.text()) && !loc.startsWith('http://127.0.0.1')) return;
    // A refusal the page is built to expect (page.__expected403, by URL): a
    // view-only user's folder seed, or purchasing's division-wide paperclip
    // count in a division it holds no order of.
    if (/Failed to load resource: the server responded with a status of 403/.test(m.text())
        && page.__expected403 && page.__expected403(loc)) return;
    errors.push('console: ' + m.text() + (loc ? ` (${loc})` : ''));
  });
  return errors;
}

// ── A division page (tracker.html, paving.html) ──────────────────────────────
async function openDivisionPage(browser, W, cfg, role, { scale = 1 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1474, height: 900 }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  // documents.js seeds the job's folders on every open, and a viewer is
  // refused that (and only that) — documents.js says nothing about it.
  page.__expected403 = url => role === 'level1' && /\/api\/documents\?division=turf&projectId=p1$/.test(url);
  const errors = watchErrors(page);
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const username = role === 'admin' ? 'ada' : role;
  const user = { id: 7, username, name: role === 'admin' ? 'Ada' : role, role, companyCode: 'FCT',
    divisionRoles: { [cfg.division]: role }, allowedDivisions: [cfg.division] };
  await page.addInitScript(({ user, division }) => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify(user));
    localStorage.setItem('fct_division', division);
  }, { user, division: cfg.division });

  const D = W.divs[cfg.division];
  const stamp = () => { D.v++; D.updatedAt = new Date(Date.parse('2026-11-10T00:00:00.000Z') + D.v * 1000).toISOString(); };
  const syncRows = ids => {
    const byId = new Map(D.dbRows().map(r => [r.row_id, r]));
    const changed = poSync.applyRowsToOrders(D.blob, byId, ids, { deleted: new Set() });
    if (changed.size) stamp();
    return D.blob.filter(p => changed.has(p.id));
  };
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    if (p.startsWith('/api/document')) return route.fallback();
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { body = {}; }
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/daily-rows') {
      if (m === 'GET') return json({ rows: [...D.rows.values()].map(r => ({ ...r })), hasMore: false });
      if (m === 'PUT') {
        const id = u.searchParams.get('id');
        const before = D.rows.get(id);
        D.rows.set(id, { ...body.row, id, _projectId: body.projectId || (before && before._projectId) });
        const orders = syncRows([id]);
        return json({ ok: true, ...(orders.length ? { po: { orders } } : {}) });
      }
      return json({ ok: true });
    }
    if (p === '/api/purchase-orders') {
      if (m === 'GET') return json({ purchaseOrders: JSON.parse(JSON.stringify(D.blob)), updatedAt: D.updatedAt });
      W.poLog.push({ method: m, q: Object.fromEntries(u.searchParams), body, role });
      if (m === 'POST' && u.searchParams.get('reconcile') === '1') {
        const changed = poSync.deriveDailyLines(D.blob, D.dbRows());
        if (changed.size) stamp();
        return json({ ok: true, changed: changed.size, purchaseOrders: JSON.parse(JSON.stringify(D.blob)), updatedAt: D.updatedAt });
      }
      if (m === 'POST') {
        const po = body.purchaseOrder;
        poSync.deriveDailyLines([po], D.dbRows());
        D.blob = D.blob.filter(x => x.id !== po.id).concat([po]);
        stamp();
        return json({ ok: true, purchaseOrder: po, rows: { removed: 0, written: 0 }, staleCopy: false, mergedLines: 0 });
      }
      if (m === 'PUT') {
        const list = body.purchaseOrders || [];
        const sentById = new Map(list.map(po => [po.id, JSON.stringify(po)]));
        const derived = poSync.deriveDailyLines(list, D.dbRows()).size;
        D.blob = JSON.parse(JSON.stringify(list));
        stamp();
        if (body.editedLineFields && typeof body.editedLineFields === 'object') {
          const orders = list.filter(po => sentById.get(po.id) !== JSON.stringify(po));
          return json({ ok: true, updatedAt: D.updatedAt, merged: 0, derived, orders: JSON.parse(JSON.stringify(orders)) });
        }
        return json({ ok: true, updatedAt: D.updatedAt, merged: 0, derived });
      }
    }
    if (p === '/api/data/_batch') {
      const keys = (u.searchParams.get('keys') || '').split(',');
      const values = {};
      if (keys.includes(cfg.project + 'p1')) values[cfg.project + 'p1'] = JOB;
      if (keys.includes(cfg.lists)) values[cfg.lists] = LISTS;
      return json({ values });
    }
    if (p === '/api/data/' + cfg.index) return json({ value: ['p1'] });
    if (p === '/api/data/' + cfg.lists && m === 'GET') return json({ value: LISTS });
    if (p.startsWith('/api/data/')) return json({ value: null });
    return json({});
  });
  await routeVault(ctx, page, W, role, username);

  await page.goto((await BASE) + '/' + cfg.file);
  await page.waitForFunction(() => typeof purchaseOrders !== 'undefined' && purchaseOrders.length === 1
    && (purchaseOrders[0].lines || []).length > 0 && !!window.FCTDocuments && _poLoadOk, null, { timeout: 20000 });
  await sleep(300);
  return { ctx, page, errors, dialogs };
}

async function openPOTab(page, poId) {
  await page.click('.tab-btn[data-tab="po"]');
  await page.waitForSelector('#po-root');
  await page.evaluate(id => { if (!_poExpanded.has(id)) _togglePOLines(id); }, poId);
  await page.waitForSelector(`#po-lines-${poId} button.po-line-clip`);
}

const lineClip = (page, poId, lineId) => page.locator(`button.po-line-clip[data-line-docs-po="${poId}"][data-line-docs-line="${lineId}"]`);
const orderClip = (page, poId) => page.locator(`button[data-po-docs="${poId}"]`);
const lineInput = (page, poId, lineId, field) => page.locator(`input[data-po-id="${poId}"][data-line-id="${lineId}"][data-line-field="${field}"]`);
// The delivery dialog documents.js draws (its body holds the filing note).
const lineDialog = page => page.locator('[data-body]:has([data-line-filing])');
const dialogTitle = page => page.evaluate(() => {
  const body = document.querySelector('[data-body] [data-line-filing]');
  const box = body && body.closest('[data-body]').parentElement;
  const span = box && box.querySelector('span');
  return span ? span.textContent : null;
});
const clipState = loc => loc.evaluate(b => ({ text: b.textContent, lit: b.classList.contains('has-docs'), title: b.title,
  aria: b.getAttribute('aria-label') }));
const linksOf = (W, docId) => W.docs.links.filter(l => l.document_id === docId);
const folderBy = (W, division, pred) => W.docs.folders.find(f => f.division === division && f.project_id === 'p1' && pred(f));

async function uploadFromDialog(page, W, file) {
  await lineDialog(page).locator('[data-attach-new]').click();
  await page.waitForSelector('#fctdoc-files');
  await page.setInputFiles('#fctdoc-files', file);
  const before = W.docLog.length;
  await page.click('#fctdoc-go');
  const reg = await until(() => W.docLog.slice(before).find(l => l.api === 'documents' && l.method === 'POST'), 8000);
  return reg;
}

// ── tracker.html as an admin: attach, count, file, detach ────────────────────
async function asAdmin(browser, W) {
  console.log('\ntracker.html as admin');
  const { ctx, page, errors, dialogs } = await openDivisionPage(browser, W, PAGES.turf, 'admin', { scale: SHOTS ? 2 : 1 });
  const D = W.divs.turf;
  ok('the server recorded the Daily Tracking delivery on the order, with its row\'s code',
    eq(D.blob[0].lines.map(l => [l.id, l.cost_code || '']), [['L1', ''], ['dr-r1', 'Stormwater']]),
    D.blob[0].lines.map(l => [l.id, l.cost_code]));

  await openPOTab(page, 'po3');
  const counted = await until(() => W.docLog.some(l => l.method === 'GET' && l.q.poLineCounts));
  const lc = W.docLog.filter(l => l.method === 'GET' && l.q.poLineCounts);
  ok('the tab counts every delivery in one division-wide request', counted && lc.length === 1 && !lc[0].q.poId
    && lc[0].q.division === 'turf', lc.map(l => l.q));

  // Each delivery's Invoice / Ticket # cell holds an empty paperclip.
  for (const lineId of ['L1', 'dr-r1']) {
    const where = await lineClip(page, 'po3', lineId).evaluate((b, id) => {
      const td = b.closest('td');
      const inv = document.querySelector(`input[data-po-id="po3"][data-line-id="${id}"][data-line-field="invoice_num"]`);
      return { inCell: !!td && !!inv && td.contains(inv), firstCell: td && td.cellIndex === 0,
        visible: b.offsetWidth > 0 && b.offsetHeight > 0 };
    }, lineId);
    ok(`${lineId}: a paperclip in its Invoice / Ticket # cell`, where.inCell && where.firstCell && where.visible, where);
    const s = await clipState(lineClip(page, 'po3', lineId));
    ok(`  empty and muted to start with`, s.text === CLIP && !s.lit && s.title === 'Attach a delivery ticket or invoice', s);
  }
  ok('one paperclip per delivery, and no new column', await page.locator('#po-lines-po3 button.po-line-clip').count() === 2
    && await page.locator('#po-lines-po3 thead th').count() === 9,
    [await page.locator('#po-lines-po3 button.po-line-clip').count(), await page.locator('#po-lines-po3 thead th').count()]);
  ok('the order\'s paperclip counts its one file', await orderClip(page, 'po3').textContent() === CLIP + '1',
    await orderClip(page, 'po3').textContent());
  // The clip sits beside the box, on its line.
  const geo = await page.evaluate(() => {
    const i = document.querySelector('input[data-po-id="po3"][data-line-id="L1"][data-line-field="invoice_num"]').getBoundingClientRect();
    const c = document.querySelector('button.po-line-clip[data-line-docs-line="L1"]').getBoundingClientRect();
    return { iRight: i.right, iTop: i.top, iW: i.width, cLeft: c.left, cTop: c.top };
  });
  ok('  beside the box, on its line, with the box still wide enough to type in',
    geo.cLeft >= geo.iRight - 0.5 && Math.abs(geo.cTop - geo.iTop) < 6 && geo.iW >= 70, geo);

  // ── The raised delivery: open, attach ──
  await lineClip(page, 'po3', 'L1').click();
  await lineDialog(page).waitFor({ timeout: 5000 });
  ok('its paperclip opens the delivery\'s dialog, named by its invoice #', await dialogTitle(page) === 'PO PO-0003 · INV-7',
    await dialogTitle(page));
  ok('  listed from ?poLineId with its order', W.docLog.some(l => l.method === 'GET' && l.q.poLineId === 'L1'
    && l.q.poId === 'po3' && l.q.division === 'turf'));
  const filing = await lineDialog(page).locator('[data-line-filing]').textContent();
  ok('  nothing attached yet, and it says where a file goes', /Nothing attached yet/.test(await lineDialog(page).textContent())
    && /PO PO-0003/.test(filing) && /420 cost-code folder/.test(filing), filing);
  ok('  an admin is offered the attach', await lineDialog(page).locator('[data-attach-new]').count() === 1);

  await lineDialog(page).locator('[data-attach-new]').click();
  await page.waitForSelector('#fctdoc-files');
  const sub = folderBy(W, 'turf', f => f.slug === 'po-po3');
  const up = await page.evaluate(() => ({
    folder: document.querySelector('#fctdoc-folder').value,
    po: document.querySelector('#fctdoc-po').value,
    poLocked: document.querySelector('#fctdoc-po').disabled,
    line: (document.querySelector('#fctdoc-poline') || {}).dataset,
    lineText: (document.querySelector('#fctdoc-poline') || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim(),
    hint: (document.querySelector('[data-po-line-hint]') || { textContent: '' }).textContent,
  }));
  ok('the upload opens on the order\'s own PO subfolder', up.folder === sub.id, [up.folder, sub.id]);
  ok('  with the order fixed', up.po === 'po3' && up.poLocked, up);
  ok('  and the delivery fixed beside it', up.line && up.line.poLine === 'po3:L1' && up.lineText === 'Delivery: INV-7', up);
  ok('  saying it is filed on the order and in the 420 folder too', /listed on the order/.test(up.hint) && /420 cost-code folder/.test(up.hint), up.hint);

  await page.setInputFiles('#fctdoc-files', PDF('ticket-7.pdf'));
  // Hold the delivery counts the upload asks for, to type into a delivery
  // while they are out.
  const hold = gate();
  W.holdLineCounts = hold;
  const before = W.docLog.length;
  await page.click('#fctdoc-go');
  const reg = await until(() => W.docLog.slice(before).find(l => l.api === 'documents' && l.method === 'POST'), 8000);
  const ticket = W.docLog.slice(before).find(l => l.api === 'document-upload-url' && l.method === 'POST');
  ok('the ticket names the order\'s job', ticket && ticket.body.projectId === 'p1', ticket && ticket.body);
  ok('the register body carries poId and poLineId, on the order\'s job', reg && reg.body.poId === 'po3'
    && reg.body.poLineId === 'L1' && reg.q.projectId === 'p1' && reg.body.folderId === sub.id && reg.body.poNumber === 'PO-0003',
    reg && { q: reg.q, body: reg.body });
  ok('  and nothing else new', reg && eq(sorted(Object.keys(reg.body)),
    sorted(['documentId', 'filename', 'storageKey', 'sizeBytes', 'folderId', 'poId', 'poNumber', 'note', 'poLineId'])),
    reg && Object.keys(reg.body));
  const d1 = reg && reg.body.documentId;
  ok('the server files it: order, delivery, PO subfolder, and the 420 folder', eq(sorted(linksOf(W, d1).map(l => `${l.link_type}:${l.target_id}`)),
    sorted(['po:po3', 'po_line:po3:L1', `folder:${sub.id}`, `folder:${folderBy(W, 'turf', f => f.cost_code === '420').id}`])),
    linksOf(W, d1));

  // The upload is in; its delivery count is out. Type into the delivery.
  ok('the dialog closed and the delivery count was asked for', await until(() => W.heldLineCounts === 1, 5000)
    && await page.locator('#fctdoc-files').count() === 0);
  const qty = lineInput(page, 'po3', 'L1', 'qty');
  await qty.click();
  await page.keyboard.press('End');
  await page.keyboard.type('5');
  await page.evaluate(() => { document.querySelectorAll('#po-root button.po-line-clip, #po-root button[data-po-docs]').forEach(b => { b.__kept = true; }); });
  hold.open();
  const lit = await until(async () => (await lineClip(page, 'po3', 'L1').textContent()) === CLIP + '1', 5000);
  const after = await page.evaluate(() => {
    const a = document.activeElement;
    const clip = document.querySelector('button.po-line-clip[data-line-docs-line="L1"]');
    return { field: a && a.dataset && a.dataset.lineField, line: a && a.dataset && a.dataset.lineId, value: a && a.value,
      sameClip: !!(clip && clip.__kept), sameOrderClip: !!(document.querySelector('button[data-po-docs="po3"]') || {}).__kept };
  });
  ok('the delivery\'s paperclip counts it when the count lands', lit, await lineClip(page, 'po3', 'L1').textContent());
  ok('  repainted in place: the same button, the cursor still in the box with what was typed',
    after.sameClip && after.sameOrderClip && after.field === 'qty' && after.line === 'L1' && after.value === '35', after);
  const s1 = await clipState(lineClip(page, 'po3', 'L1'));
  ok('  lit, with a tooltip that counts', s1.lit && s1.title === '1 document attached to this delivery' && s1.aria === s1.title, s1);
  ok('  the other delivery still reads nothing', (await clipState(lineClip(page, 'po3', 'dr-r1'))).text === CLIP);
  ok('the order\'s paperclip counts it as well', await until(async () => (await orderClip(page, 'po3').textContent()) === CLIP + '2'),
    await orderClip(page, 'po3').textContent());
  // What was typed is saved, the delivery with it.
  await until(() => D.blob[0].lines.some(l => l.id === 'L1' && l.qty === '35'), 4000);
  ok('the typed quantity is still saved', D.blob[0].lines.some(l => l.id === 'L1' && l.qty === '35'),
    D.blob[0].lines.map(l => [l.id, l.qty]));
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const box = await page.locator('#po-root').boundingBox();
    await page.screenshot({ path: path.join(SHOTS, 'po-tab.png'),
      clip: { x: 0, y: Math.max(0, box.y - 8), width: 1474, height: Math.min(520, 900 - Math.max(0, box.y - 8)) } });
  }

  // ── The Daily Tracking delivery: its own code's folder ──
  await lineClip(page, 'po3', 'dr-r1').click();
  await lineDialog(page).waitFor({ timeout: 5000 });
  ok('the Daily Tracking delivery\'s dialog is named by its date', await dialogTitle(page) === 'PO PO-0003 · Nov 3, 2026',
    await dialogTitle(page));
  const filingDr = await lineDialog(page).locator('[data-line-filing]').textContent();
  ok('  and files under its row\'s code, not the order\'s', /Stormwater cost-code folder/.test(filingDr) && !/420/.test(filingDr), filingDr);
  const reg2 = await uploadFromDialog(page, W, PDF('geofabric-ticket.pdf'));
  ok('its register body names that delivery', reg2 && reg2.body.poId === 'po3' && reg2.body.poLineId === 'dr-r1'
    && reg2.q.projectId === 'p1', reg2 && reg2.body);
  const storm = folderBy(W, 'turf', f => f.kind === 'cost_code' && f.cost_code === 'Stormwater');
  ok('the server made the Stormwater folder on the spot', !!storm, W.docs.folders.filter(f => f.kind === 'cost_code'));
  const d2 = reg2 && reg2.body.documentId;
  ok('  and filed it there, on the order and in its subfolder — not in 420', storm && eq(sorted(linksOf(W, d2).map(l => `${l.link_type}:${l.target_id}`)),
    sorted(['po:po3', 'po_line:po3:dr-r1', `folder:${sub.id}`, `folder:${storm.id}`])), linksOf(W, d2));
  ok('its paperclip counts it, and the order\'s counts three', await until(async () =>
    (await lineClip(page, 'po3', 'dr-r1').textContent()) === CLIP + '1' && (await orderClip(page, 'po3').textContent()) === CLIP + '3'),
    [await lineClip(page, 'po3', 'dr-r1').textContent(), await orderClip(page, 'po3').textContent()]);
  ok('  the raised delivery still counts its own one', (await lineClip(page, 'po3', 'L1').textContent()) === CLIP + '1');

  // ── The order's own dialog names the delivery each file hangs off ──
  await orderClip(page, 'po3').click();
  const orderList = await until(async () => {
    const t = await page.locator('[data-body]').last().textContent();
    return /ticket-7\.pdf/.test(t) && t;
  });
  ok('the order\'s paperclip lists both deliveries\' files, tagged with their delivery',
    orderList && /quote\.pdf/.test(orderList) && /delivery INV-7/.test(orderList) && /delivery Nov 3, 2026/.test(orderList), orderList);
  await page.keyboard.press('Escape');

  // ── Detach from the raised delivery ──
  await lineClip(page, 'po3', 'L1').click();
  await lineDialog(page).waitFor({ timeout: 5000 });
  const row = lineDialog(page).locator(`[data-line-doc="${d1}"]`);
  ok('the delivery lists its file, with Download and Detach', await row.count() === 1
    && await row.locator('[data-ldl]').count() === 1 && await row.locator('[data-detach]').count() === 1);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'po-line-dialog.png') });
  const patchFrom = W.docLog.length;
  await row.locator('[data-detach]').click();
  const patch = await until(() => W.docLog.slice(patchFrom).find(l => l.method === 'PATCH'));
  ok('Detach asks first', dialogs.some(m => /Detach ticket-7\.pdf from this delivery/.test(m)), dialogs);
  ok('  and PATCHes the delivery\'s link only', patch && patch.q.id === d1 && eq(patch.body, { removePoLineId: 'po3:L1' }),
    patch && { q: patch.q, body: patch.body });
  ok('the file is off the delivery, still on the order and in both folders', eq(sorted(linksOf(W, d1).map(l => `${l.link_type}:${l.target_id}`)),
    sorted(['po:po3', `folder:${sub.id}`, `folder:${folderBy(W, 'turf', f => f.cost_code === '420').id}`])), linksOf(W, d1));
  ok('  the dialog redraws empty', await until(async () => /Nothing attached yet/.test(await lineDialog(page).textContent())));
  ok('  its paperclip reads nothing again, muted', await until(async () => {
    const s = await clipState(lineClip(page, 'po3', 'L1'));
    return s.text === CLIP && !s.lit;
  }), await clipState(lineClip(page, 'po3', 'L1')));
  ok('  while the order\'s paperclip still counts it', (await orderClip(page, 'po3').textContent()) === CLIP + '3',
    await orderClip(page, 'po3').textContent());
  ok('  and the other delivery keeps its file', (await lineClip(page, 'po3', 'dr-r1').textContent()) === CLIP + '1');
  await page.keyboard.press('Escape');

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
  return { d2 };
}

// ── tracker.html as a level1: see, list, download; never attach or detach ────
async function asViewer(browser, W, { d2 }) {
  console.log('\ntracker.html as level1');
  const { ctx, page, errors } = await openDivisionPage(browser, W, PAGES.turf, 'level1');
  await openPOTab(page, 'po3');
  ok('the paperclips are drawn for a viewer too', await page.locator('#po-lines-po3 button.po-line-clip').count() === 2);
  ok('  counting what is attached', await until(async () => (await lineClip(page, 'po3', 'dr-r1').textContent()) === CLIP + '1'),
    await lineClip(page, 'po3', 'dr-r1').textContent());
  const empty = await clipState(lineClip(page, 'po3', 'L1'));
  ok('  and an empty one does not offer an attach', empty.text === CLIP && empty.title === 'No documents attached to this delivery', empty);

  await lineClip(page, 'po3', 'dr-r1').click();
  await lineDialog(page).waitFor({ timeout: 5000 });
  const row = lineDialog(page).locator(`[data-line-doc="${d2}"]`);
  ok('the delivery\'s file is listed', await row.count() === 1 && /geofabric-ticket\.pdf/.test(await row.textContent()));
  ok('  with no Attach and no Detach', await lineDialog(page).locator('[data-attach-new]').count() === 0
    && await lineDialog(page).locator('[data-detach]').count() === 0);
  const dlFrom = W.docLog.length;
  const [tab] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 5000 }).catch(() => null),
    row.locator('[data-ldl]').click(),
  ]);
  const dl = await until(() => W.docLog.slice(dlFrom).find(l => l.api === 'document-download'));
  ok('  and downloads', dl && dl.q.id === d2 && !!tab, dl && dl.q);
  if (tab) await tab.close().catch(() => {});
  ok('a viewer wrote nothing to the Vault', !W.docLog.some(l => l.role === 'level1' && ['POST', 'PATCH', 'DELETE'].includes(l.method)),
    W.docLog.filter(l => l.role === 'level1' && l.method !== 'GET').map(l => l.method + ' ' + l.api));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── paving.html: the same paperclip ──────────────────────────────────────────
async function onPaving(browser, W) {
  console.log('\npaving.html as admin');
  const { ctx, page, errors } = await openDivisionPage(browser, W, PAGES.paving, 'admin');
  await openPOTab(page, 'po5');
  const where = await lineClip(page, 'po5', 'L9').evaluate(b => {
    const inv = document.querySelector('input[data-po-id="po5"][data-line-id="L9"][data-line-field="invoice_num"]');
    return { inCell: b.closest('td').contains(inv), text: b.textContent };
  });
  ok('the delivery\'s paperclip is in its Invoice / Ticket # cell', where.inCell && where.text === CLIP, where);
  ok('  counted division-wide for paving', W.docLog.some(l => l.method === 'GET' && l.q.poLineCounts && l.q.division === 'paving' && !l.q.poId));
  await lineClip(page, 'po5', 'L9').click();
  await lineDialog(page).waitFor({ timeout: 5000 });
  ok('it opens that delivery', await dialogTitle(page) === 'PO PO-0005 · T-55', await dialogTitle(page));
  ok('  listed from paving\'s Vault', W.docLog.some(l => l.method === 'GET' && l.q.poLineId === 'L9' && l.q.poId === 'po5' && l.q.division === 'paving'));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── purchase-orders.html: the delivery's sheet, and an upload to it ──────────
const CATALOG = {
  divisions: [
    { division: 'turf', label: 'Turf Management', projects: [
      { id: 'p1', name: 'Main St', jobNumber: '2601', codes: [{ cost_code: '420', sub_code: 'Base', description: 'Stone base' }], done: false },
    ] },
    { division: 'paving', label: 'Paving', projects: [] },
    { division: 'kiewit', label: 'Kiewit Pinetree', projects: [] },
  ],
  vendors: [{ name: 'Acme Stone' }], employees: [{ name: 'Sam' }], truncated: [],
};

async function onPurchasing(browser, W) {
  console.log('\npurchase-orders.html as central purchasing');
  const ctx = await browser.newContext({ viewport: { width: 1474, height: 900 } });
  const page = await ctx.newPage();
  // loadDocCounts asks every list it shows for its order counts, naming one of
  // its orders for the carve-out; a list with no order names none, and the
  // gate refuses it. The page shows no counts there and says nothing.
  page.__expected403 = url => /\/api\/documents\?division=(kiewit|paving)&poCounts=1$/.test(url)
    && !W.divs[/division=(\w+)/.exec(url)[1]].blob.length;
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify({ id: 9, username: 'buyer', name: 'Buyer', companyCode: 'FCT',
      divisionRoles: { purchase_orders: 'level2' } }));
    localStorage.setItem('fct_division', 'purchase_orders');
  });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    if (p.startsWith('/api/document')) return route.fallback();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/po-catalog') return json(CATALOG);
    if (p === '/api/purchase-orders') {
      const D = W.divs[u.searchParams.get('division')];
      if (!D) return json({ purchaseOrders: [] });
      if (m === 'GET') return json({ purchaseOrders: JSON.parse(JSON.stringify(D.blob)), updatedAt: D.updatedAt });
      const body = JSON.parse(req.postData() || '{}');
      W.poLog.push({ method: m, q: Object.fromEntries(u.searchParams), body, role: 'purchasing' });
      const po = body.purchaseOrder;
      D.blob = D.blob.filter(x => x.id !== po.id).concat([JSON.parse(JSON.stringify(po))]);
      return json({ purchaseOrder: po, mergedLines: 0 });
    }
    return json({});
  });
  // Purchasing holds a role in its own General list only; in the divisions it
  // reaches an order's paperwork through the carve-out.
  await routeVault(ctx, page, W, d => (d === 'purchase_orders' ? 'level2' : 'purchasing'), 'buyer');
  await page.goto((await BASE) + '/purchase-orders.html');
  await until(async () => (await page.locator('#po-body tr.po-head').count()) > 0, 15000);

  const countsFrom = W.docLog.length;
  await page.locator('#po-body tr.po-head', { hasText: 'PO-0003' }).locator('td').first().click();
  const clips = page.locator('#po-body .line-clip');
  ok('a paperclip on each delivery of the order', await until(async () => (await clips.count()) === 2), await clips.count());
  const lc = await until(() => W.docLog.slice(countsFrom).find(l => l.method === 'GET' && l.q.poLineCounts));
  ok('opening the order counts its deliveries, for that order', lc && lc.q.poId === 'po3' && lc.q.division === 'turf', lc && lc.q);
  ok('  never division-wide, which the carve-out is refused',
    !W.docLog.some(l => l.role === 'purchasing' && l.q.poLineCounts && !l.q.poId));
  const drClip = page.locator('#po-body .line-clip[data-clip-line="dr-r1"]');
  ok('  the Daily Tracking delivery shows the file attached on the turf tab',
    await until(async () => (await drClip.textContent()) === CLIP + '1'), await drClip.textContent());

  await page.locator('#po-body .line-clip[data-clip-line="L1"]').click();
  const sheet = page.locator('#docs-sheet');
  ok('the delivery\'s paperclip opens the attachments sheet for that delivery',
    await until(async () => /PO-0003 · INV-7 — attachments/.test(await sheet.textContent()) && /Nothing attached yet/.test(await sheet.textContent())),
    await sheet.textContent());
  ok('  listed from ?poLineId with its order', W.docLog.some(l => l.role === 'purchasing' && l.method === 'GET'
    && l.q.poLineId === 'L1' && l.q.poId === 'po3'));
  ok('  saying it is filed in the 420 folder too', /420 cost-code folder/.test(await sheet.textContent()));

  const upFrom = W.docLog.length;
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    page.locator('#doc-add').click(),
  ]);
  if (chooser) await chooser.setFiles(PDF('delivery-slip.pdf'));
  else await page.setInputFiles('#attach-capture', PDF('delivery-slip.pdf'));
  const reg = await until(() => W.docLog.slice(upFrom).find(l => l.api === 'documents' && l.method === 'POST'), 8000);
  ok('the upload registers with the delivery and its order', reg && reg.body.poLineId === 'L1' && reg.body.poId === 'po3'
    && reg.q.projectId === 'p1', reg && { q: reg.q, body: reg.body });
  ok('  every leg naming the order', W.docLog.slice(upFrom).filter(l => l.method !== 'GET').every(l => l.q.poId === 'po3'),
    W.docLog.slice(upFrom).map(l => l.method + ' ' + JSON.stringify(l.q)));
  const d3 = reg && reg.body.documentId;
  ok('  filed on the delivery, the order and the 420 folder',
    d3 && linksOf(W, d3).some(l => l.link_type === 'po_line' && l.target_id === 'po3:L1')
    && linksOf(W, d3).some(l => l.link_type === 'folder' && l.target_id === folderBy(W, 'turf', f => f.cost_code === '420').id), d3 && linksOf(W, d3));
  ok('the sheet lists it', await until(async () => /delivery-slip\.pdf/.test(await sheet.textContent()), 5000), await sheet.textContent());
  ok('  and the delivery\'s paperclip counts it', await until(async () =>
    (await page.locator('#po-body .line-clip[data-clip-line="L1"]').textContent()) === CLIP + '1'));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const W = makeWorld();
    const r = await asAdmin(browser, W);
    await asViewer(browser, W, r);
    await onPaving(browser, W);
    await onPurchasing(browser, W);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
