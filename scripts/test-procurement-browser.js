#!/usr/bin/env node
'use strict';
/**
 * The Procurement tab end to end, in a real browser.
 *
 * Run: node scripts/test-procurement-browser.js
 *      (skips cleanly when playwright is not installed: npm i --no-save playwright)
 *      PW_CHROMIUM=/path/to/chrome picks the browser binary.
 *      PROC_SHOTS=/some/dir also saves screenshots of the tab, the Send
 *      checklist and the Suppliers tab there (for looking at, not asserted).
 *
 * scripts/test-procurement-frontend.js drives procurement.js in jsdom against
 * a stub page, and scripts/test-procurement-page.js reads tracker.html's
 * wiring. Neither has the two halves meeting: tracker.html's real combobox
 * (which commits 120 ms after blur, on mousedown, through a synthetic change),
 * its real fctAddSupplier / fctCreatePurchaseOrder, the bid page's button, the
 * tab switch after a send, and a browser's own focus and date inputs. This
 * boots the whole of tracker.html, as an admin, a level1 and a salesman, with
 * the network answered by an in-memory stand-in for the two Procurement APIs
 * that follows the contract (api/procurement.js, api/supplier-contacts.js) —
 * so a save really round-trips: what the page PATCHes is what the next GET
 * returns.
 *
 * The job is turf's own kind: Penn Cambria, job 26119, whose bid has a
 * Stormwater cost code with Geofabric and a perforated drain as sub codes (in
 * these bids the sub code IS the material) and a lump-sum Mobilization line,
 * and one purchase order already raised for the Geofabric.
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
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const SHOTS = process.env.PROC_SHOTS || '';

const server = http.createServer((req, res) => {
  // Vercel's own analytics script, injected by the host in production; not
  // the page's, and a 404 for it would read as a console error below.
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

// The browser runs on this machine's clock, so the dates are worked out from
// it: a fixed date would turn "due soon" into "late" the week after it was
// written.
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = ymd(new Date());
const plusDays = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return ymd(d); };
const us = s => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;

// ── The world the page sees ──────────────────────────────────────────────────
const DRAIN = 'Perimeter Collector Drain 15" Perf';
const PROJECTS = {
  p1: { id: 'p1', 'project-name': 'Penn Cambria', 'job-number': '26119', status: 'In Progress',
    bidItems: [
      { id: 'b1', cost_code: 'Stormwater',   sub_code: 'Geofabric',    unit: 'SF', quantity: '12500' },
      // 901 LF bid, plus a 49 LF change order: Procurement is sent the 950
      // the bid table's Bid Qty column shows.
      { id: 'b2', cost_code: 'Stormwater',   sub_code: DRAIN,          unit: 'LF', quantity: '901',
        change_orders: [{ id: 'co1', qty_delta: '49', description: 'Added run at the east end' }] },
      { id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization', unit: 'LS', quantity: '1' },
    ] },
  p2: { id: 'p2', 'project-name': 'Franklin Field', 'job-number': '26049', status: 'Awarded', bidItems: [] },
};
const PO_GEO = { id: 'po7', po_number: 'PO-0007', title: 'Geofabric', supplier: 'LB Water', status: 'pending',
  date_created: plusDays(-3), project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Geofabric', notes: '', lines: [] };

function makeWorld() {
  return {
    rows: [],                 // procurement_items, deleted ones included
    contacts: [],             // supplier_contacts
    pos: [JSON.parse(JSON.stringify(PO_GEO))],
    lists: { suppliers: [{ name: 'LB Water', state: 'PA', address: '', phone: '814-555-0100', website: '' },
                         { name: 'New Enterprise', state: 'PA', address: '', phone: '', website: '' }],
             employees: [], equipment: [], _crm_lists_seeded: true },
    listsAt: '2026-11-01T12:00:00.000Z',
    posAt: '2026-11-01T00:00:00.000Z',
    log: [],                  // every call to the two Procurement APIs, and the list / PO writes
    seq: 0,
  };
}

// ── api/procurement.js, in memory (contract section 3) ───────────────────────
const EDIT = ['admin', 'level3', 'level2'];
const ALLOWED = ['description', 'quantity', 'unit', 'sca_status', 'date_needed', 'lead_time_days', 'date_ordered',
  'date_delivered', 'vendor', 'quote_number', 'contact', 'email', 'po_id', 'po_auto', 'cost_code', 'sub_code',
  'bid_item_id', 'bid_qty_at_send', 'bid_unit_at_send'];
const BLANK_ROW = {
  source: 'manual', bid_item_id: null, cost_code: '', sub_code: '', description: '', quantity: null, unit: '',
  bid_qty_at_send: null, bid_unit_at_send: null, sca_status: 'Pending', date_needed: null, lead_time_days: null,
  date_ordered: null, date_delivered: null, vendor: '', quote_number: '', contact: '', email: '', po_id: null,
  po_auto: true, version: 1, created_by: 'Ada', updated_by: 'Ada', deleted_at: null,
};
const numOrNull = v => (v === '' || v == null ? null : Number(String(v).replace(/,/g, '')));

// The job's bid as stored (api/procurement.js reads the job's blob): a row is
// tied only to a line on it — anything else is 409 stale_bid.
const onStoredBid = (pid, lineId) => !PROJECTS[pid] || (PROJECTS[pid].bidItems || []).some(b => b.id === lineId);
const STALE = [409, { ok: false, error: 'stale_bid', message: 'That bid line is no longer on the job\'s bid', field: 'bid_item_id' }];

function procurementApi(W, role, method, q, body) {
  if (!q.division) return [400, { ok: false, error: 'division_required' }];
  if (role === 'sales') return [403, { ok: false, error: 'no_access' }];
  const canEdit = EDIT.includes(role);
  const stamp = () => new Date(Date.UTC(2026, 10, 1) + (++W.seq) * 1000).toISOString();
  const live = r => !r.deleted_at;
  const pick = (r, f) => { for (const [k, v] of Object.entries(f)) r[k] = ['quantity', 'bid_qty_at_send'].includes(k) ? numOrNull(v) : v; };
  if (method === 'GET') {
    if (!q.project_id) return [400, { ok: false, error: 'project_id_required' }];
    const items = W.rows.filter(r => r.project_id === q.project_id && (q.include_deleted === '1' || live(r)))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
    return [200, { ok: true, items: JSON.parse(JSON.stringify(items)), canEdit }];
  }
  if (!canEdit) return [403, { ok: false, error: 'read_only', message: 'View only.' }];
  const touch = r => { r.version++; r.updated_at = stamp(); return r; };
  const out = r => JSON.parse(JSON.stringify(r));
  const badField = f => Object.keys(f || {}).find(k => !ALLOWED.includes(k));
  if (method === 'POST' && q.action === 'send') {
    const tied = (body.items || []).map(it => it.bid_item_id)
      .concat((body.restore_ids || []).map(e => (typeof e === 'object' ? e.bid_item_id : (W.rows.find(r => r.id === e) || {}).bid_item_id)).filter(Boolean));
    if (tied.some(id => !onStoredBid(body.project_id, id))) return STALE;
    const restored = [];
    for (const e of body.restore_ids || []) {
      const id = typeof e === 'string' ? e : e && e.id;
      const r = W.rows.find(x => x.id === id && x.project_id === body.project_id && x.deleted_at);
      if (!r) continue;
      r.deleted_at = null;
      if (typeof e === 'object') Object.assign(r, { bid_item_id: e.bid_item_id, cost_code: e.cost_code || '', sub_code: e.sub_code || '' });
      restored.push(out(touch(r)));
    }
    const created = [];
    for (const it of body.items || []) {
      // The bid-line unique index: one bid row per line, deleted rows included.
      if (W.rows.some(r => r.source === 'bid' && r.project_id === body.project_id && r.bid_item_id === it.bid_item_id)) continue;
      if (W.rows.some(r => r.id === it.id)) continue;
      const t = stamp();
      const r = { ...BLANK_ROW, id: it.id, project_id: body.project_id, source: 'bid', bid_item_id: it.bid_item_id,
        cost_code: it.cost_code || '', sub_code: it.sub_code || '', quantity: numOrNull(it.quantity), unit: it.unit || '',
        bid_qty_at_send: numOrNull(it.quantity), bid_unit_at_send: it.unit || '', created_at: t, updated_at: t };
      W.rows.push(r);
      created.push(out(r));
    }
    return [200, { ok: true, created, restored, skipped: (body.items || []).length - created.length }];
  }
  if (method === 'POST') {
    const it = body.item || {};
    if (W.rows.some(r => r.id === it.id)) return [409, { ok: false, error: 'duplicate' }];
    const f = {};
    for (const k of ALLOWED) if (k in it) f[k] = it[k];
    const t = stamp();
    const r = { ...BLANK_ROW, id: it.id, project_id: it.project_id, created_at: t, updated_at: t };
    pick(r, f);
    W.rows.push(r);
    return [201, { ok: true, item: out(r) }];
  }
  if (method === 'PATCH' && q.action === 'bulk') {
    const bad = badField(body.fields);
    if (bad) return [400, { ok: false, error: 'field_not_allowed', field: bad }];
    const rows = W.rows.filter(r => live(r) && (body.ids || []).includes(r.id));
    const pids = [...new Set(rows.map(r => r.project_id))];
    if (pids.length > 1 || (body.project_id && pids.length === 1 && pids[0] !== body.project_id)) {
      return [400, { ok: false, error: 'mixed_projects' }];
    }
    if (!rows.length) return [404, { ok: false, error: 'not_found' }];
    rows.forEach(r => { pick(r, body.fields); touch(r); });
    return [200, { ok: true, items: rows.map(out), missing: body.ids.filter(id => !rows.some(r => r.id === id)) }];
  }
  if (method === 'PATCH') {
    const r = W.rows.find(x => x.id === q.id && live(x));
    if (!r) return [404, { ok: false, error: 'not_found' }];
    const bad = badField(body.fields);
    if (bad) return [400, { ok: false, error: 'field_not_allowed', field: bad }];
    if (!Object.keys(body.fields || {}).length) return [400, { ok: false, error: 'no_fields' }];
    if (body.fields.bid_item_id && !onStoredBid(r.project_id, body.fields.bid_item_id)) return STALE;
    pick(r, body.fields);
    return [200, { ok: true, item: out(touch(r)) }];
  }
  if (method === 'DELETE') {
    let hit;
    if (q.project_id) {
      if (!['admin', 'level3'].includes(role)) return [403, { ok: false, error: 'level3_required' }];
      hit = W.rows.filter(r => live(r) && r.project_id === q.project_id);
    } else {
      const ids = (q.ids || q.id || '').split(',').filter(Boolean);
      hit = W.rows.filter(r => live(r) && ids.includes(r.id));
      if (q.id && !hit.length) return [404, { ok: false, error: 'not_found' }];
    }
    hit.forEach(r => { r.deleted_at = stamp(); touch(r); });
    return [200, { ok: true, deleted: hit.length }];
  }
  return [405, { ok: false, error: 'method_not_allowed' }];
}

// ── api/supplier-contacts.js, in memory ──────────────────────────────────────
function contactsApi(W, role, method, q, body) {
  if (!q.division) return [400, { ok: false, error: 'division_required' }];
  if (role === 'sales') return [403, { ok: false, error: 'no_access' }];
  const canEdit = EDIT.includes(role);
  const L = s => String(s || '').trim().toLowerCase();
  const live = W.contacts.filter(c => !c.deleted_at);
  const out = c => ({ id: c.id, supplier_name: c.supplier_name, name: c.name, email: c.email, phone: c.phone, updated_at: c.updated_at });
  if (method === 'GET') {
    return [200, { ok: true, canEdit, contacts: live.slice()
      .sort((a, b) => L(a.supplier_name).localeCompare(L(b.supplier_name)) || L(a.name).localeCompare(L(b.name))).map(out) }];
  }
  if (!canEdit) return [403, { ok: false, error: 'read_only' }];
  const now = () => new Date(Date.UTC(2026, 10, 2) + (++W.seq) * 1000).toISOString();
  if (method === 'POST' && q.action === 'rename') {
    const moving = live.filter(c => L(c.supplier_name) === L(body.from));
    moving.forEach(c => { c.supplier_name = String(body.to).trim(); c.updated_at = now(); });
    const rows = W.rows.filter(r => L(r.vendor) === L(body.from) && r.vendor !== String(body.to).trim());
    rows.forEach(r => { r.vendor = String(body.to).trim(); r.version++; r.updated_at = now(); });
    // The purchase orders naming it, renamed on the stored list (renamePOs).
    const pos = W.pos.filter(po => L(po.supplier) === L(body.from) && po.supplier !== String(body.to).trim());
    pos.forEach(po => { po.supplier = String(body.to).trim(); });
    if (pos.length) W.posAt = new Date(Date.parse(W.posAt) + 60000).toISOString();
    return [200, { ok: true, moved: moving.length, merged: 0, rows: rows.length, pos: pos.length, po_ids: pos.map(po => po.id) }];
  }
  if (method === 'POST') {
    const sup = String(body.supplier_name || '').trim(), name = String(body.name || '').trim();
    const email = String(body.email || '').trim(), phone = String(body.phone || '').trim();
    if (!sup || (!name && !email)) return [400, { ok: false, error: 'invalid' }];
    const same = live.filter(c => L(c.supplier_name) === L(sup));
    const hit = email ? same.find(c => L(c.email) === L(email)) : same.find(c => L(c.name) === L(name));
    if (hit) {
      if (!hit.name) hit.name = name;
      if (!hit.email) hit.email = email;
      if (!hit.phone) hit.phone = phone;
      return [200, { ok: true, contact: out(hit), existed: true }];
    }
    const c = { id: 'sc' + (++W.seq), supplier_name: sup, name, email, phone, updated_at: now(), deleted_at: null };
    W.contacts.push(c);
    return [201, { ok: true, contact: out(c), existed: false }];
  }
  const c = live.find(x => x.id === q.id);
  if (!c) return [404, { ok: false, error: 'not_found' }];
  if (method === 'PATCH') {
    for (const k of ['name', 'email', 'phone']) if (k in body) c[k] = String(body[k] || '').trim();
    c.updated_at = now();
    return [200, { ok: true, contact: out(c) }];
  }
  if (method === 'DELETE') { c.deleted_at = now(); return [200, { ok: true, id: c.id }]; }
  return [405, { ok: false, error: 'method_not_allowed' }];
}

// ── One signed-in browser page ───────────────────────────────────────────────
async function openPage(browser, W, role, { viewport = { width: 1474, height: 900 }, storage = {} } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // Console errors count too — except a resource the sandbox cannot fetch
  // from the internet (the map library on unpkg), which is not this page's.
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const loc = (m.location() && m.location().url) || '';
    if (/Failed to load resource/.test(m.text()) && !loc.startsWith('http://127.0.0.1')) return;
    errors.push('console: ' + m.text() + (loc ? ` (${loc})` : ''));
  });
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  const user = { id: 7, username: role === 'admin' ? 'ada' : role, name: role === 'admin' ? 'Ada' : role, role,
    companyCode: 'FCT', divisionRoles: { turf: role }, allowedDivisions: ['turf'] };
  await page.addInitScript(({ user, storage }) => {
    localStorage.setItem('fct_token', 'x.y.z');
    localStorage.setItem('fct_user', JSON.stringify(user));
    localStorage.setItem('fct_division', 'turf');
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  }, { user, storage });

  await page.route('**/api/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname;
    const m = req.method();
    const q = Object.fromEntries(u.searchParams);
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    const send = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/supplier-contacts' && m === 'GET' && W.contactsDelay) await sleep(W.contactsDelay);
    if (p === '/api/procurement' && m === 'GET' && !q.include_deleted && W.procGetDelay) await sleep(W.procGetDelay);
    // One PATCH held until the test lets it go (set W.procPatchHold to a promise).
    if (p === '/api/procurement' && m === 'PATCH' && W.procPatchHold) { const h = W.procPatchHold; W.procPatchHold = null; await h; }
    if (p === '/api/procurement' || p === '/api/supplier-contacts') {
      W.log.push({ api: p.slice(5), method: m, q, body, role });
      const [status, b] = (p === '/api/procurement' ? procurementApi : contactsApi)(W, role, m, q, body || {});
      return send(status, b);
    }
    if (p === '/api/purchase-orders') {
      if (m === 'GET') {
        W.poGets = (W.poGets || 0) + 1;
        return send(200, { purchaseOrders: JSON.parse(JSON.stringify(W.pos)), updatedAt: W.posAt });
      }
      // A whole-list save (the Purchase Orders tab's). As api/purchase-orders.js
      // does: a save made from a list older than the stored one (its
      // baseUpdatedAt is not the stored version) keeps the stored orders it
      // did not send — so a delete made from a stale base does not stick.
      if (m === 'PUT' && body && Array.isArray(body.purchaseOrders)) {
        W.log.push({ api: 'purchase-orders', method: m, q, body, role });
        let next = JSON.parse(JSON.stringify(body.purchaseOrders)), merged = 0;
        if (body.baseUpdatedAt && body.baseUpdatedAt !== W.posAt) {
          const sent = new Set(next.map(po => po.id));
          const unseen = W.pos.filter(po => !sent.has(po.id));
          merged = unseen.length;
          next = next.concat(JSON.parse(JSON.stringify(unseen)));
        }
        W.pos = next;
        W.posAt = new Date(Date.parse(W.posAt) + 1000).toISOString();
        return send(200, { ok: true, updatedAt: W.posAt, merged, mergedOrders: merged });
      }
      if (m === 'POST' && body && body.purchaseOrder) {
        // A cold serverless start answers slowly.
        if (W.poDelay) await sleep(W.poDelay);
        W.log.push({ api: 'purchase-orders', method: m, q, body, role });
        const po = { ...body.purchaseOrder, lines: body.purchaseOrder.lines || [] };
        W.pos.push(po);
        return send(200, { ok: true, purchaseOrder: po, rows: [], staleCopy: false, mergedLines: 0 });
      }
      return send(200, { ok: true });
    }
    if (p === '/api/daily-rows') return m === 'GET' ? send(200, { rows: [], hasMore: false }) : send(200, { ok: true });
    if (p === '/api/data/_batch') {
      const values = {};
      for (const k of (q.keys || '').split(',')) {
        if (k.startsWith('fct_project_') && PROJECTS[k.slice(12)]) values[k] = PROJECTS[k.slice(12)];
        if (k === 'fct_lists') values[k] = W.lists;
      }
      return send(200, { values });
    }
    if (p === '/api/data/fct_projects_index') return send(200, { value: Object.keys(PROJECTS) });
    if (p === '/api/data/fct_lists') {
      if (m === 'GET') return send(200, { value: W.lists, updated_at: W.listsAt });
      if (m === 'PUT') {
        W.log.push({ api: 'data/fct_lists', method: m, q, body, role });
        if (body.baseUpdatedAt && body.baseUpdatedAt !== W.listsAt) return send(409, { error: 'conflict' });
        W.lists = body.value;
        W.listsAt = new Date(Date.parse(W.listsAt) + 60000).toISOString();
        return send(200, { ok: true });
      }
    }
    if (p.startsWith('/api/data/fct_project_') && m === 'GET') {
      const pr = PROJECTS[p.slice('/api/data/fct_project_'.length)];
      return send(200, { value: pr || null });
    }
    if (p.startsWith('/api/data/')) return send(200, { value: null });
    return send(200, {});
  });

  await page.goto((await BASE) + '/tracker.html');
  await page.waitForFunction(() => typeof projectsList !== 'undefined' && projectsList.length === 2
    && !!window.FCTProcurement && typeof _listsLoaded !== 'undefined' && _listsLoaded && _poLoadOk, null, { timeout: 20000 });
  await sleep(300);
  return { page, ctx, errors, dialogs };
}

// ── Helpers over the grid ────────────────────────────────────────────────────
const cell = (page, rowId, field) => page.locator(`#procurement-root [data-pr="${rowId}"][data-pf="${field}"]`);
const rowTr = (page, rowId) => page.locator(`#procurement-root tr.fctproc-row[data-row="${rowId}"]`);

/** Type into one of tracker's comboboxes and click the option holding `optionText`. */
async function cbPick(page, input, typed, optionText) {
  await input.click();
  await input.fill(typed);
  const opt = page.locator('.cb-menu:not([hidden]) .cb-opt', { hasText: optionText }).first();
  await opt.waitFor({ timeout: 3000 });
  await opt.click();
  await sleep(250);                      // the commit, and the redraw after it
}

/** Somewhere neutral to click: the tab's title, outside every row. */
const clickAway = page => page.locator('#procurement-root .fctproc-title').click();

const patchesFor = (W, id) => W.log.filter(l => l.api === 'procurement' && l.method === 'PATCH' && l.q.id === id);
const fieldsSent = (W, id) => patchesFor(W, id).reduce((acc, l) => ({ ...acc, ...l.body.fields }), {});

async function sendLines(page) {
  return page.$$eval('.fctproc-modal .fctproc-send-line', ls => ls.map(l => ({
    sub: l.querySelector('.sub').textContent.trim(),
    checked: l.querySelector('input').checked,
    disabled: l.querySelector('input').disabled,
    state: ['new', 'added', 'removed'].find(s => l.classList.contains(s)),
    tag: (l.querySelector('.fctproc-tag') || { textContent: '' }).textContent.trim(),
  })));
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name) });
}

// ── Admin: the whole flow ────────────────────────────────────────────────────
async function asAdmin(browser, W) {
  console.log('\nadmin');
  const { page, ctx, errors } = await openPage(browser, W, 'admin');

  // Send to Procurement from the bid page before the tab has ever been drawn:
  // the checklist still gets the sheet's styles (they used to arrive only
  // with the tab, leaving it as bare run-together text).
  ok('the tab has not been drawn yet', await page.evaluate(() => activeTab !== 'procurement' && !document.getElementById('fctproc-styles')));
  await page.evaluate(() => openBidView('p1'));
  await page.click('#bid-fs-procurement');
  await page.waitForSelector('.fctproc-modal .fctproc-send-line');
  ok('opened first from the bid page, the checklist is styled', await page.evaluate(() => !!document.getElementById('fctproc-styles')
    && getComputedStyle(document.querySelector('.fctproc-send-line')).display === 'flex'));
  await page.click('.fctproc-modal [data-send="cancel"]');
  await page.evaluate(() => closeBidView());
  ok('…and Cancel sends nothing', !W.log.some(l => l.method !== 'GET'));

  // Open the tab and pick the job.
  await page.click('.tab-btn[data-tab="procurement"]');
  await page.waitForSelector('#fctproc-proj');
  ok('the tab asks for a job first', /Pick a job above/.test(await page.textContent('#fctproc-body')));
  await cbPick(page, page.locator('#fctproc-proj'), 'penn', 'Penn Cambria');
  await until(() => page.locator('#procurement-root .fctproc-job').count());
  ok('picking the job reads its rows', W.log.some(l => l.api === 'procurement' && l.method === 'GET' && l.q.project_id === 'p1' && l.q.division === 'turf'));
  ok('…shows its name and Job #', (await page.textContent('#procurement-root .fctproc-head')).includes('Penn Cambria')
    && (await page.textContent('#procurement-root .fctproc-head')).includes('Job #26119'));
  ok('…and, with no rows yet, says how to bring them in', /No procurement rows for this job yet/.test(await page.textContent('#fctproc-wrap')));
  ok('the job is remembered for next time', await page.evaluate(() => localStorage.getItem('fct_proc_project_turf')) === 'p1');

  // Leave the tab, open the bid, Send to Procurement from there.
  await page.click('.tab-btn[data-tab="info"]');
  await page.evaluate(() => openBidView('p1'));
  await sleep(200);
  ok('the bid page shows Send to Procurement', await page.isVisible('#bid-fs-procurement'));
  ok('…between Import Procore Estimate and + Add Item', await page.evaluate(() => {
    const ids = [...document.querySelectorAll('#bid-fullscreen button[id^="bid-fs-"]')].map(b => b.id);
    return ids.indexOf('bid-fs-procore') + 1 === ids.indexOf('bid-fs-procurement') && ids.indexOf('bid-fs-procurement') + 1 === ids.indexOf('bid-fs-add');
  }));
  await page.click('#bid-fs-procurement');
  await page.waitForSelector('.fctproc-modal .fctproc-send-line');
  let lines = await sendLines(page);
  const byName = n => lines.find(l => l.sub === n) || {};
  ok('the checklist lists every bid line', lines.length === 3, lines);
  ok('…with nothing ticked to start with — Geofabric, the drain and the lump-sum Mobilization all unticked',
    lines.every(l => l.checked === false && l.disabled === false), lines);
  ok('…grouped by cost code', eq(await page.$$eval('.fctproc-modal .fctproc-send-h > span:first-child', s => s.map(x => x.textContent.trim())), ['Stormwater', 'Mobilization']));
  const go = page.locator('.fctproc-modal [data-send="go"]');
  ok('…so Add waits for a tick, and the footer says so', (await go.textContent()).trim() === 'Add' && await go.isDisabled()
    && /Nothing ticked yet/.test(await page.textContent('#fctproc-send-count')), [await go.textContent(), await page.textContent('#fctproc-send-count')]);
  await page.locator('.fctproc-modal .fctproc-send-line', { hasText: 'Geofabric' }).locator('input').check();
  await page.locator('.fctproc-modal .fctproc-send-line', { hasText: 'Perimeter Collector' }).locator('input').check();
  ok('the button counts what goes', (await go.textContent()).trim() === 'Add 2 lines', await go.textContent());
  await shot(page, 'send-modal.png');
  await go.click();
  await until(() => page.evaluate(() => activeTab === 'procurement' && !bidViewProjId));
  const send = W.log.find(l => l.api === 'procurement' && l.method === 'POST' && l.q.action === 'send');
  ok('Send POSTs action=send for the job', send && send.body.project_id === 'p1' && send.q.division === 'turf', send);
  ok('…with the two ticked lines, codes, change-order quantity and unit', send && eq(send.body.items.map(i => [i.bid_item_id, i.cost_code, i.sub_code, i.quantity, i.unit]),
    [['b1', 'Stormwater', 'Geofabric', 12500, 'SF'], ['b2', 'Stormwater', DRAIN, 950, 'LF']]), send && send.body.items);
  ok('…new row ids, and nothing to restore', send && send.body.items.every(i => /^[A-Za-z0-9_-]{1,64}$/.test(i.id)) && eq(send.body.restore_ids, []));
  ok('after the send the bid page closes and the Procurement tab is open', await page.evaluate(() => activeTab === 'procurement'
    && document.getElementById('bid-fullscreen').style.display === 'none'));

  const geo = W.rows.find(r => r.bid_item_id === 'b1').id;
  const drain = W.rows.find(r => r.bid_item_id === 'b2').id;
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 2));
  ok('the sent lines are rows in the tab', await page.locator('#procurement-root tr.fctproc-row').count() === 2);
  ok('…in bid order', eq(await page.$$eval('#procurement-root tr.fctproc-row', t => t.map(r => r.dataset.row)), [geo, drain]));
  ok('…with the bid\'s codes and quantity', (await rowTr(page, drain).textContent()).includes(DRAIN)
    && await cell(page, drain, 'quantity').inputValue() === '950');

  // PO # fills itself for the Geofabric row: the one PO with its codes.
  ok('the Geofabric row\'s PO # fills in from the job\'s PO', await cell(page, geo, 'po').inputValue() === 'PO-0007');
  ok('…marked auto', (await rowTr(page, geo).locator('td.c-po .fctproc-tag').textContent()).trim() === 'auto');
  ok('…which makes it Ordered', (await rowTr(page, geo).locator('td.c-status .fctproc-pill').textContent()).trim() === 'Ordered');
  ok('…with Date Ordered taken from the PO, shown as worked out', await cell(page, geo, 'date_ordered').inputValue() === PO_GEO.date_created
    && await cell(page, geo, 'date_ordered').evaluate(e => e.classList.contains('derived')));
  ok('the drain row has no PO and is Not Ordered', await cell(page, drain, 'po').inputValue() === ''
    && (await rowTr(page, drain).locator('td.c-status .fctproc-pill').textContent()).trim() === 'Not Ordered');
  ok('no PATCH was needed to show any of that', patchesFor(W, geo).length === 0);

  // Date Needed + Lead Time → Order By and the flag; only those two are sent.
  const needed = plusDays(20);
  await cell(page, drain, 'date_needed').fill(needed);
  await cell(page, drain, 'lead_time_days').click();
  await cell(page, drain, 'lead_time_days').fill('10');
  await clickAway(page);
  await until(() => eq(Object.keys(fieldsSent(W, drain)).sort(), ['date_needed', 'lead_time_days']));
  ok('the PATCHes carry only Date Needed and Lead Time', eq(fieldsSent(W, drain), { date_needed: needed, lead_time_days: 10 }), patchesFor(W, drain).map(l => l.body));
  ok('…as field-level PATCHes of the row', patchesFor(W, drain).every(l => l.q.division === 'turf' && l.body.fields && !('id' in l.body.fields)));
  ok('…which the server kept', W.rows.find(r => r.id === drain).date_needed === needed && W.rows.find(r => r.id === drain).lead_time_days === 10);
  ok('Order By = Date Needed − Lead Time', (await rowTr(page, drain).locator('td.c-order_by').textContent()).trim() === us(plusDays(10)),
    await rowTr(page, drain).locator('td.c-order_by').textContent());
  ok('…and the row is flagged Due soon', (await rowTr(page, drain).locator('td.c-status').textContent()).includes('Due soon'));
  ok('…with an amber edge', await rowTr(page, drain).locator('td.c-status').evaluate(e => e.classList.contains('flag-amber')));
  ok('the saved indicator settles', await until(() => page.evaluate(() => /Saved|^$/.test(document.querySelector('#fctproc-save .si-text').textContent))));

  // A vendor nobody has used: "+ Add" puts it on the supplier list.
  await cbPick(page, cell(page, drain, 'vendor'), 'Ferguson Waterworks', '+ Add "Ferguson Waterworks" as new supplier');
  const listPut = await until(() => W.log.find(l => l.api === 'data/fct_lists' && l.method === 'PUT'));
  ok('"+ Add" saves the supplier list', !!listPut);
  ok('…with the new supplier on it, and the ones already there', listPut && eq(listPut.body.value.suppliers.map(s => s.name), ['LB Water', 'New Enterprise', 'Ferguson Waterworks']),
    listPut && listPut.body.value.suppliers);
  ok('…guarded against a colleague\'s save in between (baseUpdatedAt)', listPut && listPut.body.baseUpdatedAt === '2026-11-01T12:00:00.000Z');
  ok('the page\'s own list has it too', await page.evaluate(() => lists.suppliers.some(s => s.name === 'Ferguson Waterworks')));
  ok('the row keeps the vendor', await cell(page, drain, 'vendor').inputValue() === 'Ferguson Waterworks');

  // A contact and an email typed on the row are remembered under the vendor.
  const contactBox = cell(page, drain, 'contact');
  await contactBox.click();
  await contactBox.fill('Dana Reyes');
  await contactBox.press('Tab');
  await sleep(200);
  ok('Tab from Contact lands in Email', await page.evaluate(() => document.activeElement && document.activeElement.dataset.pf === 'email'));
  await page.keyboard.type('dana@ferguson.test');
  // Tab on out of Email lands on the row's own "+ Material"; the click
  // elsewhere after that is when the row is left.
  await page.keyboard.press('Tab');
  ok('Tab from Email lands on the row\'s + Material', await page.evaluate(() => document.activeElement && document.activeElement.dataset.act === 'material'));
  await clickAway(page);
  const remembered = await until(() => W.log.find(l => l.api === 'supplier-contacts' && l.method === 'POST'));
  ok('leaving the row remembers the contact', remembered && eq(remembered.body,
    { supplier_name: 'Ferguson Waterworks', name: 'Dana Reyes', email: 'dana@ferguson.test', phone: '' }), remembered && remembered.body);
  await until(() => fieldsSent(W, drain).email);
  ok('…and the row saved vendor, contact and email', (() => { const f = fieldsSent(W, drain);
    return f.vendor === 'Ferguson Waterworks' && f.contact === 'Dana Reyes' && f.email === 'dana@ferguson.test'; })(), fieldsSent(W, drain));
  ok('only one contact was made of it', W.contacts.length === 1);

  // "+ Material" under the drain, then pick the saved contact on that row.
  await rowTr(page, drain).locator('[data-act="material"]').click();
  const matPost = await until(() => W.log.find(l => l.api === 'procurement' && l.method === 'POST' && !l.q.action));
  ok('+ Material POSTs a manual row under the same bid line', matPost && matPost.body.item.bid_item_id === 'b2'
    && matPost.body.item.sub_code === DRAIN && matPost.body.item.unit === 'LF' && matPost.body.item.project_id === 'p1', matPost && matPost.body);
  const mat = matPost.body.item.id;
  await until(() => rowTr(page, mat).count());
  ok('…drawn right under it', eq(await page.$$eval('#procurement-root tr.fctproc-row', t => t.map(r => r.dataset.row)), [geo, drain, mat]));
  ok('…with Quantity focused to type in (Description is hidden on this page)', await page.evaluate(id => document.activeElement && document.activeElement.dataset.pr === id
    && document.activeElement.dataset.pf === 'quantity', mat));
  ok('…and no Description column on the sheet', await page.locator('#procurement-root [data-pf="description"]').count() === 0
    && !(await page.$$eval('#procurement-root thead th', t => t.map(x => x.textContent.trim()))).some(h => /^Description/.test(h)));
  await page.keyboard.type('24');
  await cbPick(page, cell(page, mat, 'vendor'), 'ferg', 'Ferguson Waterworks');
  ok('the new supplier is offered on the next row', await cell(page, mat, 'vendor').inputValue() === 'Ferguson Waterworks');
  await cell(page, mat, 'contact').click();
  const offered = await page.$$eval('.cb-menu:not([hidden]) .cb-opt', o => o.map(x => x.textContent.trim()));
  ok('the Contact cell offers that vendor\'s saved contacts', offered.length === 1 && offered[0].includes('Dana Reyes') && offered[0].includes('dana@ferguson.test'), offered);
  await page.locator('.cb-menu:not([hidden]) .cb-opt', { hasText: 'Dana Reyes' }).click();
  await sleep(250);
  ok('picking one fills Contact', await cell(page, mat, 'contact').inputValue() === 'Dana Reyes');
  ok('…and Email', await cell(page, mat, 'email').inputValue() === 'dana@ferguson.test');
  await clickAway(page);
  await until(() => fieldsSent(W, mat).email);
  ok('…saved with the quantity and vendor', eq(fieldsSent(W, mat), { quantity: 24, vendor: 'Ferguson Waterworks',
    contact: 'Dana Reyes', email: 'dana@ferguson.test' }), fieldsSent(W, mat));
  ok('…and no second contact was made', W.contacts.length === 1 && W.log.filter(l => l.api === 'supplier-contacts' && l.method === 'POST').length === 1);

  // Bulk: Quote # on two rows at once.
  await page.check(`#procurement-root [data-sel="${drain}"]`);
  await page.check(`#procurement-root [data-sel="${mat}"]`);
  ok('selecting rows shows the bulk bar', /2\s*selected/.test(await page.textContent('#fctproc-bulk')));
  await page.selectOption('#fctproc-bulk-field', 'quote_number');
  await page.fill('#fctproc-bulk-val', 'Q-4471');
  await page.click('[data-act="bulk-apply"]');
  const bulk = await until(() => W.log.find(l => l.api === 'procurement' && l.method === 'PATCH' && l.q.action === 'bulk'));
  ok('Apply sends one bulk PATCH for the two rows', bulk && eq(bulk.body, { ids: [drain, mat], fields: { quote_number: 'Q-4471' }, project_id: 'p1' }), bulk && bulk.body);
  await until(() => cell(page, mat, 'quote_number').inputValue().then(v => v === 'Q-4471'));
  ok('…and both rows show it', await cell(page, drain, 'quote_number').inputValue() === 'Q-4471' && await cell(page, mat, 'quote_number').inputValue() === 'Q-4471');

  // A quick chip.
  await page.click('[data-chip="not_ordered"]');
  await sleep(150);
  ok('the Not ordered chip leaves the two rows not on a PO', eq(await page.$$eval('#procurement-root tr.fctproc-row', t => t.map(r => r.dataset.row)), [drain, mat]));
  ok('…and says so', /2 of 3 rows/.test(await page.textContent('#fctproc-shown')));
  await page.click('[data-chip="all"]');
  await sleep(150);
  ok('All brings the rest back', await page.locator('#procurement-root tr.fctproc-row').count() === 3);

  // Create PO from the two selected rows.
  ok('the selection survived the bulk edit and the chips', /2\s*selected/.test(await page.textContent('#fctproc-bulk')));
  await page.click('[data-act="bulk-po"]');
  const poPost = await until(() => W.log.find(l => l.api === 'purchase-orders' && l.method === 'POST'));
  const npo = poPost && poPost.body.purchaseOrder;
  ok('Create PO POSTs one new order', !!npo && W.log.filter(l => l.api === 'purchase-orders').length === 1);
  ok('…numbered after the last one, pending, dated today, no lines', npo && npo.po_number === 'PO-0008' && npo.status === 'pending'
    && npo.date_created === TODAY && eq(npo.lines, []), npo);
  ok('…seeded from the rows: job, codes, vendor, quote', npo && npo.project_id === 'p1' && npo.cost_code === 'Stormwater'
    && npo.sub_code === DRAIN && npo.supplier === 'Ferguson Waterworks' && npo.notes === 'Quote Q-4471'
    && npo.title === 'Ferguson Waterworks materials', npo);
  const link = await until(() => W.log.filter(l => l.api === 'procurement' && l.q.action === 'bulk').find(l => l.body.fields.po_id));
  ok('…then links both rows to it by id', link && eq(link.body.ids, [drain, mat]) && link.body.fields.po_id === npo.id && link.body.fields.po_auto === true, link && link.body);
  await until(() => cell(page, drain, 'po').inputValue().then(v => v === 'PO-0008'));
  ok('the rows show the new PO number', await cell(page, drain, 'po').inputValue() === 'PO-0008' && await cell(page, mat, 'po').inputValue() === 'PO-0008');
  ok('…and are Ordered now', (await rowTr(page, drain).locator('td.c-status .fctproc-pill').textContent()).trim() === 'Ordered');
  ok('…which the PO tab has too', await page.evaluate(() => purchaseOrders.some(p => p.po_number === 'PO-0008')));
  ok('the selection clears', !(await page.textContent('#fctproc-bulk')).trim());

  // Grouping.
  await page.click('[data-group="vendor"]');
  await sleep(150);
  const vGroups = await page.$$eval('#procurement-root tr.fctproc-grp', g => g.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('Vendor / Quote groups the rows under vendor headers', vGroups.length === 2 && vGroups[0].includes('Ferguson Waterworks')
    && vGroups[0].includes('Q-4471') && vGroups[0].includes('Dana Reyes') && vGroups[1].includes('No vendor yet'), vGroups);
  await page.click('[data-group="cost"]');
  await sleep(150);
  const cGroups = await page.$$eval('#procurement-root tr.fctproc-grp', g => g.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ok('Cost code groups them under Stormwater', cGroups.length === 1 && /^▼\s*Stormwater/.test(cGroups[0]) && /3 rows/.test(cGroups[0]), cGroups);
  await page.click('[data-group="none"]');
  await sleep(150);
  ok('None has no headers', await page.locator('#procurement-root tr.fctproc-grp').count() === 0);
  ok('the grouping is remembered', await page.evaluate(() => localStorage.getItem('fct_proc_group_turf')) === 'none');
  await page.click('[data-group="cost"]');
  await sleep(150);

  // Exports.
  const [xl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="xlsx"]')]);
  ok('Excel downloads as "Procurement - <job> - <date>.xlsx"', xl.suggestedFilename() === `Procurement - Penn Cambria - ${TODAY}.xlsx`, xl.suggestedFilename());
  const xbytes = fs.readFileSync(await xl.path());
  ok('…a zip (an .xlsx)', xbytes.slice(0, 2).toString() === 'PK' && xbytes.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  ok('…holding the rows', xbytes.includes(Buffer.from('Ferguson Waterworks')) && xbytes.includes(Buffer.from('PO-0008')));
  const [cv] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="csv"]')]);
  ok('CSV downloads as "Procurement - <job> - <date>.csv"', cv.suggestedFilename() === `Procurement - Penn Cambria - ${TODAY}.csv`, cv.suggestedFilename());
  const csv = fs.readFileSync(await cv.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  ok('…the columns in the sheet\'s order (no Description, hidden on this page), then the Notes (flags and badges)', csv[0] === ['Status', 'PO #', 'Sub-Contractor Agreement', 'Date Needed', 'Lead Time (days)', 'Order By',
    'Date Ordered', 'Date Delivered', 'Quantity', 'Unit', 'Cost Code', 'Sub Code', 'Vendor', 'Quote #', 'Contact', 'Email', 'Notes']
    .map(h => `"${h}"`).join(','), csv[0]);
  ok('…one line per row, in screen order', csv.length === 4 && csv[1].includes('"PO-0007"') && csv[2].includes('"Dana Reyes"') && csv[3].includes('"Ferguson Waterworks"') && csv[3].includes('"24"'), csv);

  // Send again: what is already there is greyed.
  await page.click('#procurement-root [data-act="send"]');
  await page.waitForSelector('.fctproc-modal .fctproc-send-line');
  lines = await sendLines(page);
  ok('re-opening Send shows the sent lines as already added', byName('Geofabric').state === 'added' && byName('Geofabric').disabled
    && byName(DRAIN).state === 'added' && byName(DRAIN).disabled && byName(DRAIN).tag === 'already added', lines);
  ok('…and only Mobilization left to send, still unticked', byName('Mobilization').state === 'new' && !byName('Mobilization').checked, lines);
  ok('…so there is nothing to send yet', await page.locator('.fctproc-modal [data-send="go"]').isDisabled());
  await page.click('.fctproc-modal [data-send="cancel"]');
  ok('Cancel closes it', await page.locator('.fctproc-modal').count() === 0);

  // + Add Row, then its ✕: the module's own inline confirm, not the page's
  // global "Are you sure?" that answers every .del-btn[data-tab].
  await page.click('#procurement-root [data-act="add"]');
  const addPost = await until(() => W.log.filter(l => l.api === 'procurement' && l.method === 'POST' && !l.q.action)[1]);
  const extra = addPost && addPost.body.item.id;
  ok('+ Add Row POSTs a bare row for the job', addPost && addPost.body.item.project_id === 'p1' && !addPost.body.item.bid_item_id, addPost && addPost.body);
  await until(() => rowTr(page, extra).count());
  await clickAway(page);
  await rowTr(page, extra).locator('[data-act="del"]').click();
  ok('its ✕ asks inline', (await rowTr(page, extra).textContent()).includes('Delete?') && await page.locator('.del-confirm').count() === 0);
  await rowTr(page, extra).locator('[data-act="del-yes"]').click();
  const del = await until(() => W.log.find(l => l.api === 'procurement' && l.method === 'DELETE'));
  ok('Yes deletes that row (softly, on the server)', del && del.q.id === extra && !!W.rows.find(r => r.id === extra).deleted_at, del && del.q);
  await until(() => rowTr(page, extra).count().then(n => n === 0));
  ok('…and it leaves the grid', await page.locator('#procurement-root tr.fctproc-row').count() === 3);

  // ↗ beside a PO number opens that order on the Purchase Orders tab.
  await rowTr(page, geo).locator('[data-act="open-po"]').click();
  await until(() => page.evaluate(() => activeTab === 'po'));
  ok('↗ opens the Purchase Orders tab searched to that order', await page.evaluate(() => activeTab === 'po' && poSearch === 'PO-0007'));
  ok('…showing it', (await page.textContent('#tab-po')).includes('PO-0007'));
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 3));
  ok('coming back, the job and its rows are still there', await page.inputValue('#fctproc-proj') === 'Penn Cambria'
    && await page.locator('#procurement-root tr.fctproc-row').count() === 3);

  // Screenshots of the tab, wide and laptop width (asserted on nowhere).
  if (SHOTS) {
    const scrollTo = x => page.evaluate(x => { const w = document.getElementById('fctproc-wrap'); w.scrollLeft = x === 'end' ? w.scrollWidth : x; }, x);
    await page.evaluate(() => document.querySelectorAll('.fctproc-toast').forEach(t => t.remove()));
    await page.setViewportSize({ width: 1920, height: 1000 });
    await scrollTo(0); await sleep(300);
    await shot(page, 'tab-1920.png');
    await scrollTo('end'); await sleep(200);
    await shot(page, 'tab-1920-right.png');
    await page.setViewportSize({ width: 1474, height: 900 });
    await scrollTo(0); await sleep(300);
    await shot(page, 'tab-1474.png');
    await scrollTo('end'); await sleep(200);
    await shot(page, 'tab-1474-right.png');
    await scrollTo(0);
  }

  // Suppliers tab: the search and the contacts.
  await page.evaluate(() => adminSwitchTab('supplier'));
  await page.waitForSelector('#sup-search');
  await page.fill('#sup-search', 'dana');
  await sleep(200);
  const supNames = await page.$$eval('#supplier-root [data-sup-field="name"]', i => i.map(x => x.value));
  ok('the Suppliers search finds a supplier by its contact', eq(supNames, ['Ferguson Waterworks']), supNames);
  ok('…and keeps the caret in the box', await page.evaluate(() => document.activeElement && document.activeElement.id === 'sup-search'));
  await page.locator('#supplier-root [data-supc-toggle]').first().click();
  await sleep(200);
  const contactVals = await page.$$eval('#supplier-root [data-supc-id]', i => i.map(x => x.value));
  ok('its contacts open with name, email and phone', eq(contactVals, ['Dana Reyes', 'dana@ferguson.test', '']), contactVals);
  await page.fill('#sup-search', '');
  await sleep(200);
  await shot(page, 'suppliers.png');

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}


// ── Fixes from review: the table fits the window, dates, the Suppliers tab ────
async function reviewFixes(browser) {
  console.log('\nfit, dates and supplier renames');
  const W = makeWorld();
  // A long job: forty materials, the second of them from LB Water.
  for (let i = 0; i < 40; i++) {
    const t = new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
    W.rows.push({ ...BLANK_ROW, id: 'L' + String(i).padStart(2, '0'), project_id: 'p1', description: `Material ${String(i).padStart(2, '0')}`,
      vendor: i === 1 ? 'LB Water' : '', date_needed: i === 0 ? '2026-12-01' : null, created_at: t, updated_at: t });
  }
  const { page, ctx, errors } = await openPage(browser, W, 'admin', { viewport: { width: 1920, height: 1000 }, storage: { fct_proc_project_turf: 'p1' } });
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 40));
  await sleep(150);
  const fit = () => page.evaluate(() => {
    const w = document.getElementById('fctproc-wrap').getBoundingClientRect();
    const d = document.documentElement;
    return { bottom: Math.round(w.bottom), inner: innerHeight, pageScrolls: d.scrollHeight > d.clientHeight + 1, height: Math.round(w.height) };
  });
  let f = await fit();
  ok('1920×1000: the table box ends inside the window and the page itself does not scroll', f.bottom <= f.inner && !f.pageScrolls && f.height > 400, f);
  await page.locator('#procurement-root [data-sel="L05"]').check();
  await sleep(150);
  f = await fit();
  ok('…with the bulk bar open too', f.bottom <= f.inner && !f.pageScrolls, f);
  await page.setViewportSize({ width: 1474, height: 900 });
  await sleep(250);
  f = await fit();
  ok('1474×900 (the nav on two lines), bulk bar open: still inside the window', f.bottom <= f.inner && !f.pageScrolls && f.height > 250, f);
  await page.locator('#procurement-root [data-act="bulk-clear"]').click();
  await sleep(150);
  f = await fit();
  ok('…and the box grows back when the bar closes', f.bottom <= f.inner && !f.pageScrolls, f);

  // A date typed with a two-digit year, the way Chrome takes it: 0026.
  const box = cell(page, 'L00', 'date_needed');
  const patchesBefore = patchesFor(W, 'L00').length;
  await box.focus();
  await page.keyboard.type('120126', { delay: 60 });
  await clickAway(page);
  await sleep(800);
  const toastText = (await page.$$eval('.fctproc-toast', ts => ts.map(t => t.textContent))).join(' | ');
  ok('a two-digit year is not sent, and the date saved before is not wiped', patchesFor(W, 'L00').length === patchesBefore
    && W.rows.find(r => r.id === 'L00').date_needed === '2026-12-01' && await box.inputValue() === '2026-12-01', [patchesFor(W, 'L00').map(l => l.body), await box.inputValue()]);
  ok('…and the PM is told why', /not saved/.test(toastText) && /all four digits/.test(toastText), toastText);
  await box.focus();
  await page.keyboard.type('01152027', { delay: 60 });
  await clickAway(page);
  await sleep(800);
  ok('typing a whole date sends only that date (not the part-typed years on the way)',
    eq(patchesFor(W, 'L00').slice(patchesBefore).map(l => l.body.fields.date_needed), ['2027-01-15']), patchesFor(W, 'L00').map(l => l.body));

  // Suppliers: a colleague saves a contact after this tab read the list.
  await page.evaluate(() => adminSwitchTab('supplier'));
  await until(() => page.evaluate(() => _supContactsLoad.state === 'ok'));
  W.contacts.push({ id: 'sc-late', supplier_name: 'LB Water', name: 'Pat Kline', email: 'pat@lbwater.com', phone: '', updated_at: '2026-11-03T00:00:00Z', deleted_at: null });
  const nameBox = page.locator('#supplier-root [data-sup-field="name"]').first();
  ok('the first supplier is LB Water', await nameBox.inputValue() === 'LB Water');
  await nameBox.fill('LB Water Service');
  await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
  await sleep(500);
  const renames = W.log.filter(l => l.api === 'supplier-contacts' && l.q.action === 'rename');
  ok('a rename is always sent, even when this tab\'s copy listed no contacts', renames.length === 1
    && eq(renames[0].body, { from: 'LB Water', to: 'LB Water Service' }), renames.map(r => r.body));
  ok('…so the contact saved meanwhile moves with it', W.contacts.find(c => c.id === 'sc-late').supplier_name === 'LB Water Service');
  ok('…and so does the Procurement row\'s Vendor', W.rows.find(r => r.id === 'L01').vendor === 'LB Water Service');

  // A slow contacts read lands while a supplier's name is being typed.
  W.contactsDelay = 1200;
  await page.evaluate(() => { _supContactsLoad = { state: 'idle', at: 0, busy: false }; renderSupplierTab(); });
  const nb = page.locator('#supplier-root [data-sup-field="name"]').first();
  await nb.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Inc', { delay: 450 });
  await until(() => page.evaluate(() => _supContactsLoad.state === 'ok'), 4000);
  const still = await page.evaluate(() => { const a = document.activeElement; return { field: a && a.dataset && a.dataset.supField, value: a && a.value }; });
  ok('the read landing does not redraw the box being typed in', still.field === 'name' && still.value === 'LB Water Service Inc', still);
  ok('…and no rename went out for a half-typed name', W.log.filter(l => l.api === 'supplier-contacts' && l.q.action === 'rename').length === 1);
  W.contactsDelay = 0;
  await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
  await sleep(500);
  const r2 = W.log.filter(l => l.api === 'supplier-contacts' && l.q.action === 'rename');
  ok('leaving the box sends the one rename, for the whole name', r2.length === 2 && eq(r2[1].body, { from: 'LB Water Service', to: 'LB Water Service Inc' }), r2.map(r => r.body));
  ok('…then the tab redraws, the contact counted under the new name',
    await until(() => page.locator('#supplier-root [data-supc-toggle]').first().textContent().then(t => /\b1\b/.test(t))),
    await page.locator('#supplier-root [data-supc-toggle]').first().textContent());

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── level1: read the sheet, change nothing ───────────────────────────────────
async function asLevel1(browser, W) {
  console.log('\nlevel1');
  const before = W.log.length;
  const { page, ctx, errors } = await openPage(browser, W, 'level1', { storage: { fct_proc_project_turf: 'p1' } });
  ok('level1 has the Procurement tab', await page.isVisible('.tab-btn[data-tab="procurement"]'));
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 3));
  ok('it shows the job\'s rows', await page.locator('#procurement-root tr.fctproc-row').count() === 3);
  ok('…as plain text: no inputs, selects or checkboxes in the grid', await page.locator('#fctproc-wrap input, #fctproc-wrap select').count() === 0);
  ok('…no Send, + Add Row (toolbar or section) or row buttons', await page.locator('#procurement-root [data-act="send"], #procurement-root [data-act="add"], #procurement-root [data-grpadd], #procurement-root [data-act="material"], #procurement-root [data-act="del"]').count() === 0);
  ok('…but the values are there', (await page.textContent('#fctproc-wrap')).includes('Ferguson Waterworks')
    && (await page.textContent('#fctproc-wrap')).includes('PO-0008'));
  ok('…and export still works', await page.locator('#procurement-root [data-act="xlsx"]').count() === 1 && await page.locator('#procurement-root [data-act="csv"]').count() === 1);
  await page.click('[data-chip="not_ordered"]');
  await sleep(150);
  ok('…and so do the chips', /0 of 3 rows/.test(await page.textContent('#fctproc-shown')) || /No rows match/.test(await page.textContent('#fctproc-wrap')));
  ok('level1 sent no writes', W.log.slice(before).every(l => l.method === 'GET'), W.log.slice(before).filter(l => l.method !== 'GET'));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── sales: no tab at all ─────────────────────────────────────────────────────
async function asSales(browser, W) {
  console.log('\nsales');
  const before = W.log.length;
  const { page, ctx, errors } = await openPage(browser, W, 'sales');
  ok('sales has no Procurement tab', !(await page.isVisible('.tab-btn[data-tab="procurement"]')));
  ok('…lands on the CRM', await page.evaluate(() => activeTab) === 'crm');
  ok('…and nothing asked the Procurement APIs', W.log.slice(before).length === 0, W.log.slice(before));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── Round two: Tab through cells, dates cleared, one PO per click, a renamed
// supplier's orders, the bid page header ─────────────────────────────────────
async function roundTwoFixes(browser) {
  console.log('\ntabbing, clearing dates, Create PO, supplier rename, bid header');
  const W = makeWorld();
  const t = i => new Date(Date.UTC(2026, 9, 2) + i * 1000).toISOString();
  W.rows.push(
    // As "+ Add Row" makes it: everything blank.
    { ...BLANK_ROW, id: 'T1', project_id: 'p1', description: 'new row', created_at: t(1), updated_at: t(1) },
    // Hand-added, coded off the drain line, a unit of its own.
    { ...BLANK_ROW, id: 'T2', project_id: 'p1', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: DRAIN, unit: 'roll', vendor: 'LB Water',
      description: 'coded', created_at: t(2), updated_at: t(2) },
    // On PO-0007 automatically (same job, codes and vendor), delivered once.
    { ...BLANK_ROW, id: 'T3', project_id: 'p1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF',
      vendor: 'LB Water', description: 'auto po', date_delivered: '2026-11-10', created_at: t(3), updated_at: t(3) },
  );
  W.contacts.push({ id: 'sc1', supplier_name: 'LB Water', name: 'Al Jones', email: 'al.jones@lbwater.com', phone: '', updated_at: t(0), deleted_at: null });
  const { page, ctx, errors } = await openPage(browser, W, 'admin', { viewport: { width: 1920, height: 1000 }, storage: { fct_proc_project_turf: 'p1' } });
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 3));
  await page.click('#procurement-root [data-group="none"]');
  await sleep(200);

  // Tab through every cell of each row, typing nothing. The page's combobox
  // puts its first option into a box whose text matches no option — and Tab
  // used to commit it.
  const before = JSON.stringify(W.rows);
  for (const id of ['T1', 'T2', 'T3']) {
    await page.click(`#procurement-root [data-sel="${id}"]`);
    await page.click(`#procurement-root [data-sel="${id}"]`);
    for (let i = 0; i < 24; i++) { await page.keyboard.press('Tab'); await sleep(60); }
    await clickAway(page);
    await sleep(500);
  }
  const writes = W.log.filter(l => l.api === 'procurement' && l.method !== 'GET');
  ok('Tab through every cell of three rows, typing nothing: nothing is saved', writes.length === 0 && JSON.stringify(W.rows) === before,
    writes.map(l => [l.q.id, l.body && l.body.fields]));
  ok('…the auto-matched row is still on PO-0007 automatically', (await rowTr(page, 'T3').locator('.c-po').textContent()).includes('auto')
    && W.rows.find(r => r.id === 'T3').po_id === null);
  ok('…and no contact was filed', !W.log.some(l => l.api === 'supplier-contacts' && l.method === 'POST'));
  // Typed and then Tab still commits.
  await cell(page, 'T1', 'vendor').click();
  await page.keyboard.type('new ent', { delay: 30 });
  await page.keyboard.press('Tab');
  await sleep(400);
  await clickAway(page);
  await sleep(800);
  ok('typed, then Tab: the vendor picked from the typing is saved', W.rows.find(r => r.id === 'T1').vendor === 'New Enterprise', W.rows.find(r => r.id === 'T1').vendor);

  // Clearing a date from the keyboard: each segment emptied, then away.
  const dd = cell(page, 'T3', 'date_delivered');
  await dd.click({ position: { x: 8, y: 8 } });
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Backspace'); await page.keyboard.press('ArrowRight'); }
  await clickAway(page);
  await sleep(900);
  const toasts = (await page.$$eval('.fctproc-toast', ts => ts.map(x => x.textContent))).join(' | ');
  ok('a date emptied from the keyboard is saved as cleared', W.rows.find(r => r.id === 'T3').date_delivered === null
    && await dd.inputValue() === '', [W.rows.find(r => r.id === 'T3').date_delivered, await dd.inputValue()]);
  ok('…with no "not saved" message', !/not saved/.test(toasts), toasts);

  // Create PO from selected, clicked twice while the first is out.
  W.poDelay = 1200;
  await page.locator('#procurement-root [data-sel="T2"]').check();
  await sleep(150);
  await page.locator('#procurement-root [data-act="bulk-po"]').dblclick();
  ok('while a PO is being created its button is disabled', await page.locator('#procurement-root [data-act="bulk-po"]').isDisabled());
  await sleep(2200);
  const made = W.log.filter(l => l.api === 'purchase-orders' && l.method === 'POST');
  ok('a double click raises ONE purchase order', made.length === 1, made.map(l => l.body.purchaseOrder.po_number));
  ok('…numbered after the last one', made.length && made[0].body.purchaseOrder.po_number === 'PO-0008', made.map(l => l.body.purchaseOrder.po_number));
  W.poDelay = 0;

  // Rename LB Water on Admin > Suppliers: the purchase orders follow, so the
  // rows matched to them stay ordered.
  await page.evaluate(() => adminSwitchTab('supplier'));
  await until(() => page.evaluate(() => _supContactsLoad.state === 'ok'));
  const nameBox = page.locator('#supplier-root [data-sup-field="name"]').first();
  await nameBox.fill('LB Water Works');
  await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
  await sleep(700);
  ok('a supplier rename carries to the purchase orders naming it', W.pos.filter(po => po.supplier === 'LB Water').length === 0
    && W.pos.filter(po => po.supplier === 'LB Water Works').length === 2, W.pos.map(po => po.po_number + ':' + po.supplier));
  await page.click('.tab-btn[data-tab="procurement"]');
  await sleep(600);
  // (Its Date Delivered was cleared above, so "Ordered" comes from the PO.)
  const poShown = await cell(page, 'T3', 'po').inputValue();
  const status = await rowTr(page, 'T3').locator('.c-status .fctproc-pill').textContent();
  ok('…so the row matched to PO-0007 by vendor still finds it, and is still Ordered', poShown === 'PO-0007' && status === 'Ordered', [poShown, status]);

  // The bid page's header on a laptop: every button on one line.
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.evaluate(() => openBidView('p1'));
  await sleep(300);
  const tops = await page.$$eval('#bid-fullscreen > div:first-child [id^="bid-fs-"].btn', bs => bs.filter(b => b.offsetParent).map(b => {
    const r = b.getBoundingClientRect(); return { id: b.id, top: Math.round(r.top), h: Math.round(r.height) };
  }));
  // One line of label is ~30px tall; a label folded onto two is ~50.
  ok('1366 wide: the bid page\'s header buttons sit in one row, no label folded onto two lines',
    tops.length === 7 && new Set(tops.map(x => x.top)).size === 1 && tops.every(x => x.h < 40), tops);
  await shot(page, 'bid-header-1366.png');
  await page.evaluate(() => closeBidView());

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── Round three: a contact added after an edit, a name left blank, a rename's
// orders (server-side), and a page that loaded before it ──────────────────────
async function roundThreeFixes(browser) {
  console.log('\nadd contact after an edit, a blank name, a rename\'s purchase orders');
  const W = makeWorld();
  W.contacts.push({ id: 'scd', supplier_name: 'LB Water', name: 'Dave Ross', email: 'dave@lbwater.com', phone: '', updated_at: '2026-11-01T00:00:00Z', deleted_at: null });
  W.rows.push({ ...BLANK_ROW, id: 'Q1', project_id: 'p1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF',
    vendor: 'LB Water', date_needed: plusDays(5), created_at: '2026-10-03T00:00:00.000Z', updated_at: '2026-10-03T00:00:00.000Z' });
  W.pos.push({ id: 'po10', po_number: 'PO-0010', title: 'Drain', supplier: 'New Enterprise', status: 'pending', date_created: plusDays(-2),
    project_id: 'p2', cost_code: 'Stormwater', sub_code: DRAIN, notes: '', lines: [] });
  // PM B's page, open on another job since before the rename.
  const B = await openPage(browser, W, 'level2', { storage: { fct_proc_project_turf: 'p2' } });
  await B.page.click('.tab-btn[data-tab="procurement"]');
  await B.page.waitForSelector('#fctproc-proj');
  const { page, ctx, errors } = await openPage(browser, W, 'admin');
  await page.evaluate(() => adminSwitchTab('supplier'));
  await until(() => page.evaluate(() => _supContactsLoad.state === 'ok'));
  const lbIdx = await page.evaluate(() => lists.suppliers.findIndex(s => s.name === 'LB Water'));
  await page.click(`#supplier-root [data-supc-toggle="${lbIdx}"]`);
  await page.waitForSelector('#supplier-root [data-supc-id="scd"][data-supc-field="phone"]');

  // A phone typed for Dave, then straight on to a new contact below him: the
  // save of the phone answers while the new one is typed.
  await page.locator('#supplier-root [data-supc-id="scd"][data-supc-field="phone"]').click();
  await page.keyboard.type('814-555-0199');
  await page.locator('#supplier-root [data-supc-new-field="name"]').click();
  await until(() => W.contacts.find(c => c.id === 'scd').phone === '814-555-0199');
  await page.keyboard.type('Sue Park', { delay: 20 }); await page.keyboard.press('Tab');
  await page.keyboard.type('sue@lbwater.com', { delay: 10 }); await page.keyboard.press('Tab');
  await page.keyboard.type('814-555-0142', { delay: 10 });
  const bb = await page.locator('#supplier-root [data-supc-add]').first().boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down(); await sleep(120); await page.mouse.up();      // a person's click
  await until(() => W.contacts.some(c => c.name === 'Sue Park'), 3000);
  await sleep(300);
  ok('after a contact was edited, the new contact typed below it is added by + Add contact',
    W.contacts.some(c => c.name === 'Sue Park' && c.email === 'sue@lbwater.com' && c.phone === '814-555-0142' && !c.deleted_at),
    W.contacts.map(c => `${c.name} <${c.email}> ${c.phone}`));
  ok('…and the tab shows it, its new-contact row empty again', await page.locator('#supplier-root [data-supc-field="name"]').evaluateAll(bs => bs.some(b => b.value === 'Sue Park'))
    && (await page.$$eval('#supplier-root [data-supc-new-field]', bs => bs.map(b => b.value))).every(v => v === ''));

  // The name box emptied and left: the name comes back.
  const neIdx = await page.evaluate(() => lists.suppliers.findIndex(s => s.name === 'New Enterprise'));
  const boxAt = i => page.locator(`#supplier-root [data-sup-field="name"][data-sup-idx="${i}"]`);
  await boxAt(neIdx).click(); await boxAt(neIdx).press('Control+A'); await page.keyboard.press('Backspace');
  await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
  await sleep(500);
  ok('a supplier name left blank gets its name back, here and on the server', await boxAt(neIdx).inputValue() === 'New Enterprise'
    && W.lists.suppliers.some(s => s.name === 'New Enterprise') && !W.lists.suppliers.some(s => s.name === ''), W.lists.suppliers.map(s => s.name));
  ok('…and renames nothing', !W.log.some(l => l.q.action === 'rename'));
  // The lists poll replaces every list entry meanwhile (a colleague's change).
  await page.evaluate(() => { Object.assign(lists, JSON.parse(JSON.stringify(lists))); });
  await boxAt(neIdx).fill('New Enterprise Inc');
  await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
  await until(() => W.log.some(l => l.q.action === 'rename'));
  await sleep(500);
  let renames = W.log.filter(l => l.q.action === 'rename');
  ok('the name typed over it renames from the real name, the list entries refreshed in between or not', renames.length === 1
    && eq(renames[0].body, { from: 'New Enterprise', to: 'New Enterprise Inc' }), renames.map(r => r.body));

  // A colleague approves PO-0007 and deletes PO-0010 on the stored list;
  // this page's copy still has both as they were. Then LB Water is renamed.
  W.pos.find(po => po.id === 'po7').status = 'approved';
  W.pos.find(po => po.id === 'po7').notes = 'approved by Lou';
  W.pos = W.pos.filter(po => po.id !== 'po10');
  await boxAt(lbIdx).fill('LB Water Works');
  await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
  const lbRename = () => W.log.find(l => l.q.action === 'rename' && l.body.from === 'LB Water');
  await until(lbRename);
  await sleep(700);
  ok('LB Water renamed', !!lbRename() && eq(lbRename().body, { from: 'LB Water', to: 'LB Water Works' }), W.log.filter(l => l.q.action === 'rename').map(r => r.body));
  const po7 = W.pos.find(po => po.id === 'po7');
  ok('the purchase orders are renamed on the stored list: only the Supplier of the ones naming it', po7.supplier === 'LB Water Works'
    && po7.status === 'approved' && po7.notes === 'approved by Lou', po7);
  ok('…the page saved no copy of its order list, so a deleted order stays deleted', !W.log.some(l => l.api === 'purchase-orders' && l.method === 'PUT')
    && !W.pos.some(po => po.id === 'po10'), W.pos.map(po => `${po.id}:${po.status}:${po.supplier}`));
  ok('…and this page\'s own copy says the new name', await until(() => page.evaluate(() => (purchaseOrders.find(po => po.id === 'po7') || {}).supplier === 'LB Water Works')));

  // PM B picks the job now: the order list is read again with the rows, so the
  // row (its Vendor renamed too) is still on PO-0007.
  const getsBefore = W.poGets;
  await cbPick(B.page, B.page.locator('#fctproc-proj'), 'penn', 'Penn Cambria');
  await until(() => B.page.locator('#procurement-root tr.fctproc-row[data-row="Q1"]').count());
  await sleep(500);
  ok('a page loaded before the rename reads the order list again when a job is picked', W.poGets > getsBefore, [getsBefore, W.poGets]);
  const q1po = await until(() => cell(B.page, 'Q1', 'po').inputValue().then(v => v === 'PO-0007' && v));
  const q1st = await rowTr(B.page, 'Q1').locator('.c-status .fctproc-pill').textContent();
  ok('…so the row is still on PO-0007, Ordered', q1po === 'PO-0007' && q1st === 'Ordered', [q1po, q1st]);
  // Its copy put back as it was (the poll not run yet): Create PO reads it again first.
  await B.page.evaluate(() => { purchaseOrders.find(po => po.id === 'po7').supplier = 'LB Water'; FCTProcurement.rerender(); });
  ok('(with the page\'s copy behind again, the row reads Not Ordered)', await rowTr(B.page, 'Q1').locator('.c-status .fctproc-pill').textContent() === 'Not Ordered');
  await B.page.locator('#procurement-root [data-sel="Q1"]').check();
  await sleep(150);
  await B.page.locator('#procurement-root [data-act="bulk-po"]').click();
  await B.page.waitForSelector('.fctproc-modal', { timeout: 3000 }).catch(() => {});
  const asked = await B.page.locator('.fctproc-modal').textContent().catch(() => '');
  ok('…Create PO from selected reads the stored list first, and asks — the row is on PO-0007', /already on/.test(asked) && /PO-0007/.test(asked)
    && !W.log.some(l => l.api === 'purchase-orders' && l.method === 'POST'), asked);
  await B.page.locator('.fctproc-modal [data-choice="2"]').click().catch(() => {});

  ok('no page errors', errors.length === 0 && B.errors.length === 0, errors.concat(B.errors).join(' | '));
  await ctx.close();
  await B.ctx.close();
}

// ── Round three, saving: a box cleared then Tab or Enter, a regroup owed
// after a background change, the filter lists' order ─────────────────────────
async function roundThreeSaveFixes(browser) {
  console.log('\nclearing a box with Tab / Enter, regrouping after a refresh, filter order');
  const W = makeWorld();
  const t = i => new Date(Date.UTC(2026, 9, 2) + i * 1000).toISOString();
  const row = (id, f) => ({ ...BLANK_ROW, id, project_id: 'p1', created_at: t(id.charCodeAt(1)), updated_at: t(id.charCodeAt(1)), ...f });
  W.rows.push(
    row('V1', { description: 'clear vendor', vendor: 'New Enterprise', unit: 'LF', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: DRAIN,
      date_needed: '2026-11-20', quantity: 9 }),
    row('V2', { description: 'clear unit', vendor: 'LB Water', unit: 'SF', date_needed: '2027-01-10', quantity: 12500 }),
    row('V3', { description: 'moved by a colleague', vendor: 'LB Water', date_needed: '2026-12-15', quantity: 1200.5 }),
    row('V4', { description: 'arrow pick', vendor: 'LB Water', date_needed: '2027-02-01', quantity: 100 }),
  );
  const { page, ctx, errors } = await openPage(browser, W, 'level2', { viewport: { width: 1920, height: 1000 }, storage: { fct_proc_project_turf: 'p1' } });
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 4));
  await page.click('#procurement-root [data-group="none"]');
  await sleep(200);
  const saved = id => W.rows.find(r => r.id === id);

  // The box's text is selected on focus: Backspace empties it. The emptied
  // text matches no option, so the combobox highlights the first one — which
  // Tab and Enter used to save in place of the blank.
  await cell(page, 'V1', 'vendor').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Tab');
  await sleep(300); await clickAway(page); await sleep(700);
  ok('Vendor emptied, then Tab: saved blank, not the first supplier', saved('V1').vendor === '' && eq(fieldsSent(W, 'V1'), { vendor: '' }), fieldsSent(W, 'V1'));
  await cell(page, 'V2', 'unit').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await sleep(300); await clickAway(page); await sleep(700);
  ok('Unit emptied, then Enter: saved blank, not the first unit', saved('V2').unit === '' && eq(fieldsSent(W, 'V2'), { unit: '' }), fieldsSent(W, 'V2'));
  await cell(page, 'V1', 'codes').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Tab');
  await sleep(300); await clickAway(page); await sleep(700);
  ok('Sub Code emptied, then Tab: the row is uncoded, not moved to the first bid line', saved('V1').bid_item_id === null && saved('V1').sub_code === '',
    [saved('V1').bid_item_id, saved('V1').sub_code]);
  // Emptied, then an option picked with the arrow keys: that is a choice.
  await cell(page, 'V4', 'vendor').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await sleep(300); await clickAway(page); await sleep(700);
  ok('…emptied, then picked with the arrow keys and Enter: the picked supplier is saved', !!saved('V4').vendor && saved('V4').vendor !== 'LB Water'
    && W.lists.suppliers.some(x => x.name === saved('V4').vendor), saved('V4').vendor);

  // Grouped by vendor. A colleague moves V3 to New Enterprise; the refresh
  // lands while the PM is typing, so it is redrawn around the cell — and
  // the regroup is owed until the PM leaves the table.
  await page.click('#procurement-root [data-group="vendor"]');
  await sleep(300);
  const groupOf = id => page.evaluate(id => {
    let head = '';
    for (const tr of document.querySelectorAll('#fctproc-wrap tbody tr')) {
      if (tr.classList.contains('fctproc-grp')) head = tr.textContent.replace(/\s+/g, ' ').trim();
      else if (tr.dataset.row === id) return head;
    }
    return null;
  }, id);
  ok('(V3 starts under LB Water)', /LB Water/.test(await groupOf('V3')), await groupOf('V3'));
  Object.assign(saved('V3'), { vendor: 'New Enterprise', version: saved('V3').version + 1, updated_at: t(500) });
  W.procGetDelay = 900;
  const refreshing = page.evaluate(() => FCTProcurement.refresh());
  await sleep(100);
  await cell(page, 'V2', 'quote_number').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' x', { delay: 40 });
  await refreshing; await sleep(200);
  W.procGetDelay = 0;
  await clickAway(page); await sleep(900);
  ok('a row moved to another vendor by a colleague mid-edit is regrouped once the PM leaves the table', /New Enterprise/.test(await groupOf('V3')),
    await groupOf('V3'));

  // The same with focus on the select-all box rather than a row's cell.
  W.rows.push(row('V5', { description: 'added by a colleague', vendor: 'LB Water', updated_at: t(600) }));
  W.procGetDelay = 900;
  const refreshing2 = page.evaluate(() => FCTProcurement.refresh());
  await sleep(100);
  await page.locator('#fctproc-selall').focus();
  await refreshing2; await sleep(200);
  W.procGetDelay = 0;
  await clickAway(page); await sleep(700);
  ok('…and a row added meanwhile shows once focus leaves the select-all box', await rowTr(page, 'V5').count() === 1);

  // The filter lists: dates by the day, quantities by size.
  const filterList = async field => {
    await page.locator(`#procurement-root [data-pff="${field}"]`).first().click();
    await page.waitForSelector('#fctproc-ff-list .fctproc-ff-val');
    const vals = await page.$$eval('#fctproc-ff-list .fctproc-ff-val', bs => bs.map(b => b.value));
    await page.keyboard.press('Escape');
    await clickAway(page); await sleep(150);
    return vals;
  };
  const dates = await filterList('date_needed');
  ok('the Date Needed filter lists its dates in date order, across years', eq(dates, ['11/20/2026', '12/15/2026', '01/10/2027', '02/01/2027', '']), dates);
  const qtys = await filterList('quantity');
  ok('the Quantity filter lists its quantities by size', eq(qtys, ['9', '100', '1,200.5', '12,500', '']), qtys);

  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── Round four: a stale bid line refused with its codes, a delete after a
// rename, the bulk bar under a refresh, the sheet under a refresh ────────────
async function roundFourFixes(browser) {
  console.log('\na refused bid line, a delete after a rename, the bulk bar and the sheet under a refresh');
  const t = i => new Date(Date.UTC(2026, 9, 3) + i * 1000).toISOString();

  // ── A Sub Code picked from a bid that has since been replaced elsewhere ──
  {
    const W = makeWorld();
    W.rows.push({ ...BLANK_ROW, id: 'H1', project_id: 'p1', description: '', created_at: t(1), updated_at: t(1) });
    const { page, ctx, errors } = await openPage(browser, W, 'level2', { viewport: { width: 1920, height: 1000 }, storage: { fct_proc_project_turf: 'p1' } });
    const saved = PROJECTS.p1.bidItems;
    try {
      await page.click('.tab-btn[data-tab="procurement"]');
      await until(() => rowTr(page, 'H1').count());
      // A colleague's Procore "Replace all" lands on the server (new line
      // ids); this page has not read the bid since.
      PROJECTS.p1.bidItems = saved.map(b => ({ ...b, id: 'n' + b.id }));
      await page.evaluate(() => { const b = document.getElementById('save-error-banner'); window.__banner = [];
        new MutationObserver(() => window.__banner.push(b.textContent.replace(/\s+/g, ' ').trim())).observe(b, { childList: true, subtree: true, characterData: true }); });
      await cell(page, 'H1', 'quote_number').click();
      await page.keyboard.type('Couplers', { delay: 10 });
      await cbPick(page, cell(page, 'H1', 'codes'), 'Perim', 'Perimeter');
      await sleep(1500);
      const ps = patchesFor(W, 'H1');
      const h1 = W.rows.find(r => r.id === 'H1');
      ok('a Sub Code pick refused as no longer on the bid (stale_bid) saves none of its codes: the row stays uncoded',
        h1.bid_item_id === null && h1.cost_code === '' && h1.sub_code === '', [h1.bid_item_id, h1.cost_code, h1.sub_code]);
      ok('…no save carries the codes without their line, and the line is not sent again', ps.every(l => !('sub_code' in l.body.fields) || 'bid_item_id' in l.body.fields)
        && ps.filter(l => 'bid_item_id' in l.body.fields).length === 1, ps.map(l => l.body.fields));
      ok('…the Quote # typed in the same edit is saved', h1.quote_number === 'Couplers', h1.quote_number);
      const shown = { sub: await cell(page, 'H1', 'codes').inputValue(), cost: (await rowTr(page, 'H1').locator('.c-cost_code').textContent()).trim() };
      ok('…and the cells are back to what was saved, as the message says', shown.sub === '' && shown.cost === '', shown);
      const qu = { q: await cell(page, 'H1', 'quantity').inputValue(), u: await cell(page, 'H1', 'unit').inputValue() };
      ok('…the Quantity and Unit that pick filled in too, saved and shown', h1.quantity == null && h1.unit === '' && qu.q === '' && qu.u === '',
        { saved: [h1.quantity, h1.unit], qu });
      const banner = (await page.evaluate(() => window.__banner)).filter(Boolean).pop() || '';
      ok('…the message names the pick once ("Cost / Sub Code was not saved")', /Cost \/ Sub Code was not saved/.test(banner) && !/Sub Code, Cost Code/.test(banner), banner);
      // The refusal itself is the browser's logged 409, and expected.
      const other = errors.filter(e => !/status of 409 \(Conflict\).*\/api\/procurement/.test(e));
      ok('no page errors', other.length === 0, other.join(' | '));
    } finally {
      PROJECTS.p1.bidItems = saved;
      await ctx.close();
    }
  }

  // ── …and a live line picked while that refused pick was still out ───────
  {
    const W = makeWorld();
    W.rows.push({ ...BLANK_ROW, id: 'H2', project_id: 'p1', description: 'Couplers', created_at: t(2), updated_at: t(2) });
    const { page, ctx, errors } = await openPage(browser, W, 'level2', { viewport: { width: 1920, height: 1000 }, storage: { fct_proc_project_turf: 'p1' } });
    const saved = PROJECTS.p1.bidItems;
    let release = () => {};
    try {
      await page.click('.tab-btn[data-tab="procurement"]');
      await until(() => rowTr(page, 'H2').count());
      // Only the drain line was replaced elsewhere; Geofabric (same Cost
      // Code) is still on the bid.
      PROJECTS.p1.bidItems = saved.map(b => (b.id === 'b2' ? { ...b, id: 'nb2' } : b));
      W.procPatchHold = new Promise(r => { release = r; });
      await cbPick(page, cell(page, 'H2', 'codes'), 'Perim', 'Perimeter');
      await clickAway(page);
      await sleep(300);
      // Before the drain pick is answered, the PM picks Geofabric instead.
      await cbPick(page, cell(page, 'H2', 'codes'), 'Geofab', 'Geofabric');
      await clickAway(page);
      await sleep(300);
      release();
      await until(() => W.rows.find(r => r.id === 'H2').bid_item_id === 'b1');
      await sleep(400);
      const h2 = W.rows.find(r => r.id === 'H2');
      ok('a live line picked while a refused (stale_bid) pick was out is saved with all of its codes, the shared Cost Code included',
        h2.bid_item_id === 'b1' && h2.cost_code === 'Stormwater' && h2.sub_code === 'Geofabric', [h2.bid_item_id, h2.cost_code, h2.sub_code, patchesFor(W, 'H2').map(l => l.body.fields)]);
      ok('…with its own Quantity and Unit (12,500 SF), not the refused drain line\'s 950 LF',
        Number(h2.quantity) === 12500 && h2.unit === 'SF', [h2.quantity, h2.unit, patchesFor(W, 'H2').map(l => l.body.fields)]);
      const other = errors.filter(e => !/status of 409 \(Conflict\).*\/api\/procurement/.test(e));
      ok('no page errors', other.length === 0, other.join(' | '));
    } finally {
      release();
      W.procPatchHold = null;
      PROJECTS.p1.bidItems = saved;
      await ctx.close();
    }
  }

  // ── A purchase order deleted after a supplier rename ─────────────────────
  {
    const W = makeWorld();
    W.pos.push({ id: 'po8', po_number: 'PO-0008', title: 'Infill', supplier: 'Acme Supply', status: 'pending', date_created: plusDays(-2),
      project_id: 'p1', cost_code: 'Synthetic Turf', sub_code: 'Infill', notes: '', lines: [] });
    const { page, ctx, errors } = await openPage(browser, W, 'admin');
    await page.evaluate(() => adminSwitchTab('supplier'));
    await until(() => page.evaluate(() => _supContactsLoad.state === 'ok'));
    const lbIdx = await page.evaluate(() => lists.suppliers.findIndex(s => s.name === 'LB Water'));
    const box = page.locator(`#supplier-root [data-sup-field="name"][data-sup-idx="${lbIdx}"]`);
    await box.fill('LB Water Works');
    await page.locator('#supplier-root').click({ position: { x: 5, y: 5 } });
    await until(() => W.log.some(l => l.q.action === 'rename'));
    await until(() => page.evaluate(() => (purchaseOrders.find(po => po.id === 'po7') || {}).supplier === 'LB Water Works'));
    await sleep(600);
    ok('after a rename the server made to the order list, the page holds that list\'s version', await page.evaluate(() => _poBaseUpdatedAt) === W.posAt,
      [await page.evaluate(() => _poBaseUpdatedAt), W.posAt]);
    await page.evaluate(() => deletePO('po8'));
    const put = await until(() => W.log.find(l => l.api === 'purchase-orders' && l.method === 'PUT'));
    await sleep(300);
    ok('…so an order deleted next is saved against it, and stays deleted', !!put && !W.pos.some(po => po.id === 'po8')
      && W.pos.some(po => po.id === 'po7' && po.supplier === 'LB Water Works'), W.pos.map(po => `${po.id}:${po.supplier}`));
    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ── The sheet and its bulk bar while the order list changes ──────────────
  {
    const W = makeWorld();
    const row = (id, f) => ({ ...BLANK_ROW, id, project_id: 'p1', created_at: t(id.charCodeAt(1)), updated_at: t(id.charCodeAt(1)), ...f });
    W.rows.push(
      row('F1', { description: 'geofabric pins', vendor: 'New Enterprise', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row('F2', { description: 'staples', quote_number: 'staples', vendor: 'New Enterprise', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row('F3', { description: 'mob trailer', vendor: 'LB Water', bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization' }),
      row('F4', { description: 'mob fuel', vendor: 'LB Water', bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization' }),
    );
    const { page, ctx, errors } = await openPage(browser, W, 'level2', { viewport: { width: 1920, height: 1000 },
      storage: { fct_proc_project_turf: 'p1', fct_proc_group_turf: 'cost' } });
    await page.click('.tab-btn[data-tab="procurement"]');
    await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 4));
    await sleep(300);
    let k = 0;
    const raisePO = (pid, f) => W.pos.push({ id: 'pr' + (++k), po_number: 'PO-80' + k, title: 'x', supplier: 'Else', status: 'pending',
      date_created: plusDays(-1), project_id: pid, cost_code: '', sub_code: '', notes: '', lines: [], ...f });
    const reread = () => page.evaluate(() => _poReread());
    const activeIs = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.dataset.act ? `${a.dataset.act}@${a.dataset.row}` : a.id || a.tagName) : null; });

    // Tab out of an edited Email: its save is answered while focus is on the
    // row's "+ Material" — which keeps it.
    await cell(page, 'F1', 'email').click();
    await page.keyboard.type('pins@ne.com', { delay: 10 });
    await page.keyboard.press('Tab');
    await until(() => W.rows.find(r => r.id === 'F1').email === 'pins@ne.com');
    await sleep(300);
    const afterEmail = await activeIs();
    await page.keyboard.press('Tab');
    ok('Tab out of an edited Email lands on "+ Material", and stays there once the save is answered; Tab goes on to the row\'s ✕',
      afterEmail === 'material@F1' && await activeIs() === 'del@F1', [afterEmail, await activeIs()]);
    await clickAway(page); await sleep(300);

    // An order raised on another job lands while a cell is typed in: nothing
    // on this job changes, so no row is rebuilt — now, or when the table is left.
    await page.evaluate(() => { document.querySelector('#procurement-root tr.fctproc-row[data-row="F4"]').__mark = 1; });
    await cell(page, 'F2', 'quote_number').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' x', { delay: 20 });
    raisePO('p2');
    await reread();
    const kept = () => page.evaluate(() => !!document.querySelector('#procurement-root tr.fctproc-row[data-row="F4"]').__mark);
    const midEdit = await kept();
    await clickAway(page); await sleep(500);
    ok('an order list change that touches no row of this job rebuilds no row mid-edit, nor when the table is left', midEdit && await kept(), [midEdit, await kept()]);

    // One that does (an order for the Mobilization line) is redrawn around the
    // cell, in place.
    await cell(page, 'F2', 'quote_number').click();
    await page.keyboard.press('End');
    await page.keyboard.type('y', { delay: 20 });
    raisePO('p1', { supplier: 'LB Water', cost_code: 'Mobilization', sub_code: 'Mobilization' });
    await reread();
    ok('an order for the Mobilization line shows on its rows mid-edit', await until(() => cell(page, 'F3', 'po').inputValue().then(v => /PO-80/.test(v))));
    await clickAway(page);
    ok('…and the typing goes on and is saved', await until(() => W.rows.find(r => r.id === 'F2').quote_number === 'staples xy'), W.rows.find(r => r.id === 'F2').quote_number);
    await sleep(400);

    // A colleague moves F1 to the Mobilization line; the refresh lands while
    // the PM types, so the regroup is owed until the table is left. The PM
    // leaves it with a press on a group header: that click still folds it.
    const f1 = W.rows.find(r => r.id === 'F1');
    Object.assign(f1, { bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization', version: f1.version + 1, updated_at: t(700) });
    W.procGetDelay = 700;
    const refreshing = page.evaluate(() => FCTProcurement.refresh());
    await sleep(100);
    await cell(page, 'F2', 'quote_number').click();
    await page.keyboard.press('End');
    await page.keyboard.type('z', { delay: 20 });
    await refreshing; await sleep(200);
    W.procGetDelay = 0;
    // On the section's name (the label stays in view while the table is
    // scrolled sideways — to the Quote # cell by now — and the section's
    // + Add Row sits just after it).
    const hdr = await page.locator('#fctproc-wrap tr.fctproc-grp', { hasText: 'Stormwater' }).locator('.gl > span:not(.tw):not(.gm)').boundingBox();
    await page.mouse.move(hdr.x + hdr.width / 2, hdr.y + hdr.height / 2);
    await page.mouse.down(); await sleep(80); await page.mouse.up();
    await sleep(600);
    const folded = await page.evaluate(() => [...FCTProcurement._test.state().collapsed].some(g => /stormwater/i.test(g)));
    ok('a press on a group header that leaves a cell with a regroup owed still folds the group (the redraw waits for the button to come up)', folded,
      await page.evaluate(() => [...FCTProcurement._test.state().collapsed]));
    const underMob = await page.evaluate(() => {
      let head = '';
      for (const tr of document.querySelectorAll('#fctproc-wrap tbody tr')) {
        if (tr.classList.contains('fctproc-grp')) head = tr.textContent; else if (tr.dataset.row === 'F1') return /Mobilization/.test(head);
      }
      return false;
    });
    ok('…and the owed regroup is drawn after it (F1 under Mobilization)', underMob);
    if (folded) { await page.locator('#fctproc-wrap tr.fctproc-grp', { hasText: 'Stormwater' }).click(); await sleep(200); }

    // The bulk bar: a Quote # typed there survives the order list changing.
    await page.locator('#procurement-root [data-sel="F1"]').check();
    await page.locator('#procurement-root [data-sel="F2"]').check();
    await page.selectOption('#fctproc-bulk-field', 'quote_number');
    await page.locator('#fctproc-bulk-val').click();
    await page.keyboard.type('Q-7', { delay: 20 });
    raisePO('p2');
    await reread();
    const typed = await page.evaluate(() => ({ active: document.activeElement.id, val: document.getElementById('fctproc-bulk-val').value }));
    await page.keyboard.type('77', { delay: 20 });
    const typedOn = await page.evaluate(() => ({ active: document.activeElement.id, val: document.getElementById('fctproc-bulk-val').value }));
    ok('a refresh of the order list while a value is typed in the bulk bar keeps the value and the focus, and typing goes on',
      eq(typed, { active: 'fctproc-bulk-val', val: 'Q-7' }) && eq(typedOn, { active: 'fctproc-bulk-val', val: 'Q-777' }), [typed, typedOn]);
    // Left (not applied), and redrawn again: still there, and Apply uses it.
    await clickAway(page); await sleep(200);
    raisePO('p2');
    await reread();
    ok('…and once the box is left, a later refresh keeps it too', await page.locator('#fctproc-bulk-val').inputValue() === 'Q-777');
    await page.locator('#procurement-root [data-act="bulk-apply"]').click();
    await until(() => W.rows.filter(r => r.quote_number === 'Q-777').length === 2);
    ok('…Apply sets it on the rows ticked', W.rows.filter(r => r.quote_number === 'Q-777').map(r => r.id).sort().join() === 'F1,F2',
      W.rows.map(r => `${r.id}:${r.quote_number}`));

    // A bulk button with focus ("Apply to 2", say) is no reason to keep the
    // bar stale: an order raised meanwhile shows in its PO list, and the
    // button keeps focus.
    await page.selectOption('#fctproc-bulk-field', 'po');
    await page.focus('#procurement-root [data-act="bulk-apply"]');
    raisePO('p1', { supplier: 'LB Water', cost_code: 'Mobilization', sub_code: 'Mobilization' });
    const newNo = W.pos[W.pos.length - 1].po_number;
    await reread();
    await sleep(200);
    const bar = await page.evaluate(() => ({ active: document.activeElement && document.activeElement.dataset.act,
      opts: [...document.querySelectorAll('#fctproc-bulk-val option')].map(o => o.textContent.split(' — ')[0].trim()) }));
    ok('…a refresh while a bulk button has focus redraws the bar (the new order is in its PO list), and the button keeps focus',
      bar.active === 'bulk-apply' && bar.opts.includes(newNo), [newNo, bar]);

    ok('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

// ── The section checkbox on each group header ─────────────────────────────
async function sectionSelect(browser) {
  console.log('\nthe section checkbox: tick a whole section, then delete or bulk-edit it');
  const t = i => new Date(Date.UTC(2026, 9, 4) + i * 1000).toISOString();
  const row = (id, f) => ({ ...BLANK_ROW, id, project_id: 'p1', created_at: t(id.charCodeAt(1)), updated_at: t(id.charCodeAt(1)), ...f });
  const W = makeWorld();
  W.rows.push(
    row('S1', { description: 'geofabric pins', vendor: 'New Enterprise', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
    row('S2', { description: 'staples', quote_number: 'Q-STAPLES', vendor: 'New Enterprise', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
    row('S3', { description: 'drain couplers', vendor: 'LB Water', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: DRAIN }),
    row('S4', { description: 'mob trailer', vendor: 'LB Water', bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization' }),
    row('S5', { description: 'mob fuel', vendor: 'LB Water', bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization' }),
  );
  const storage = { fct_proc_project_turf: 'p1', fct_proc_group_turf: 'cost' };
  const { page, ctx, errors } = await openPage(browser, W, 'level2', { viewport: { width: 1474, height: 900 }, storage });
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 5));
  await sleep(300);
  const box = name => page.locator('#fctproc-wrap tr.fctproc-grp', { hasText: name }).locator('[data-grpsel]');
  const state = () => page.evaluate(() => ({
    selected: [...FCTProcurement._test.state().selected].sort().join(),
    rowsTicked: [...document.querySelectorAll('#fctproc-wrap [data-sel]:checked')].map(b => b.dataset.sel).sort().join(),
    boxes: Object.fromEntries([...document.querySelectorAll('#fctproc-wrap [data-grpsel]')].map(b =>
      [b.closest('tr').textContent.match(/Stormwater|Mobilization/)[0], b.indeterminate ? 'some' : b.checked ? 'all' : 'none'])),
    bar: ((document.querySelector('#fctproc-bulk b') || {}).textContent || '0'),
    folded: [...FCTProcurement._test.state().collapsed].length,
  }));

  ok('an editor gets a box on each section header', await box('Stormwater').count() === 1 && await box('Mobilization').count() === 1);
  await box('Stormwater').click();
  await sleep(200);
  let s = await state();
  ok('ticking a section ticks every row in it, and only those', s.selected === 'S1,S2,S3' && s.rowsTicked === 'S1,S2,S3', JSON.stringify(s));
  ok('…the bulk bar counts them', s.bar === '3', s.bar);
  ok('…and the click does not fold the section', s.folded === 0, s.folded);
  ok('…its box reads ticked, the other section\'s not', s.boxes.Stormwater === 'all' && s.boxes.Mobilization === 'none', JSON.stringify(s.boxes));

  await page.locator('#procurement-root [data-sel="S2"]').uncheck();
  await sleep(150);
  s = await state();
  ok('unticking one of its rows leaves the section box half-ticked', s.boxes.Stormwater === 'some' && s.selected === 'S1,S3', JSON.stringify(s));
  await page.locator('#procurement-root [data-sel="S2"]').check();
  await sleep(150);
  ok('ticking it again ticks the section box', (await state()).boxes.Stormwater === 'all');
  await box('Stormwater').click();
  await sleep(150);
  s = await state();
  ok('unticking the section box unticks its rows', s.selected === '' && s.boxes.Stormwater === 'none' && s.bar === '0', JSON.stringify(s));

  // Keyboard: Space on the focused box ticks it and does not fold.
  await box('Mobilization').focus();
  await page.keyboard.press('Space');
  await sleep(150);
  s = await state();
  ok('Space on a section box ticks it, without folding', s.selected === 'S4,S5' && s.folded === 0, JSON.stringify(s));
  await page.locator('#procurement-root [data-act="bulk-clear"]').click();
  await sleep(150);
  ok('Clear selection unticks the section box too', (await state()).boxes.Mobilization === 'none');

  // A search narrows what a section box ticks to the rows shown.
  await page.fill('#fctproc-search', 'Q-STAPLES');
  await sleep(400);
  await box('Stormwater').click();
  await sleep(150);
  s = await state();
  ok('with a search on, a section box ticks only the rows shown', s.selected === 'S2', JSON.stringify(s));
  await page.locator('#procurement-root [data-act="bulk-clear"]').click();
  await page.fill('#fctproc-search', '');
  await sleep(400);

  // A folded section's box still ticks its rows.
  await page.locator('#fctproc-wrap tr.fctproc-grp', { hasText: 'Mobilization' }).locator('.tw').click();
  await sleep(200);
  ok('(the Mobilization section is folded)', (await state()).folded === 1);
  await box('Mobilization').click();
  await sleep(150);
  s = await state();
  ok('a folded section\'s box ticks its rows too, and leaves it folded', s.selected === 'S4,S5' && s.bar === '2' && s.folded === 1, JSON.stringify(s));

  // Then Delete selected removes exactly that section.
  await page.locator('#procurement-root [data-act="bulk-del"]').click();
  await page.locator('#procurement-root [data-act="bulk-del-yes"]').click();
  await until(() => W.rows.filter(r => r.deleted_at).length === 2);
  await sleep(300);
  ok('Delete selected then deletes that section\'s rows, and no others',
    W.rows.filter(r => r.deleted_at).map(r => r.id).sort().join() === 'S4,S5' && W.rows.filter(r => !r.deleted_at).length === 3,
    W.rows.map(r => `${r.id}:${r.deleted_at ? 'deleted' : 'live'}`).join());
  ok('…and the section is gone from the sheet', await page.locator('#fctproc-wrap tr.fctproc-grp', { hasText: 'Mobilization' }).count() === 0
    && await page.locator('#procurement-root tr.fctproc-row').count() === 3);

  // A bulk edit of a section: Date Needed on every Stormwater row.
  await box('Stormwater').click();
  await page.selectOption('#fctproc-bulk-field', 'date_needed');
  await page.fill('#fctproc-bulk-val', '2026-12-15');
  await page.locator('#procurement-root [data-act="bulk-apply"]').click();
  await until(() => W.rows.filter(r => !r.deleted_at && r.date_needed === '2026-12-15').length === 3);
  ok('a bulk edit after ticking a section sets the field on every row in it',
    W.rows.filter(r => !r.deleted_at).every(r => r.date_needed === '2026-12-15'), W.rows.map(r => `${r.id}:${r.date_needed}`).join());
  await shot(page, 'section-select.png');
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // A view-only user gets no boxes.
  const W2 = makeWorld();
  W2.rows.push(row('V1', { description: 'pins', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }));
  const v = await openPage(browser, W2, 'level1', { storage });
  await v.page.click('.tab-btn[data-tab="procurement"]');
  await until(() => v.page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 1));
  await sleep(300);
  ok('a view-only user gets no section boxes', await v.page.locator('#fctproc-wrap [data-grpsel]').count() === 0
    && await v.page.locator('#fctproc-wrap tr.fctproc-grp').count() > 0);
  await v.ctx.close();
}

// ── + Add Row on a section header ───────────────────────────────────────────
async function sectionAdd(browser) {
  console.log('\n+ Add Row on a section header: a row added in that section, not under "No cost code"');
  const t = i => new Date(Date.UTC(2026, 9, 6) + i * 1000).toISOString();
  const row = (id, f) => ({ ...BLANK_ROW, id, project_id: 'p1', created_at: t(id.charCodeAt(1)), updated_at: t(id.charCodeAt(1)), ...f });
  const W = makeWorld();
  W.rows.push(
    row('A1', { description: 'geofabric pins', vendor: 'LB Water', quote_number: 'Q-12', contact: 'Dana Reyes', email: 'dana@lbwater.com',
      bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
    row('A2', { description: 'drain couplers', vendor: 'LB Water', quote_number: 'Q-12', contact: 'Dana Reyes', email: 'dana@lbwater.com',
      bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: DRAIN }),
    row('A3', { description: 'mob trailer', vendor: 'New Enterprise', contact: 'Sam', bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization' }),
    row('A4', { description: 'mob fuel', vendor: 'New Enterprise', contact: 'Pat', bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization' }),
    row('A5', { description: 'misc', vendor: '' }),
  );
  const storage = { fct_proc_project_turf: 'p1', fct_proc_group_turf: 'cost' };
  const { page, ctx, errors } = await openPage(browser, W, 'level2', { viewport: { width: 1474, height: 900 }, storage });
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 5));
  await sleep(300);
  const hdr = name => page.locator('#fctproc-wrap tr.fctproc-grp', { hasText: name });
  const addIn = name => hdr(name).locator('[data-grpadd]');
  const posts = () => W.log.filter(l => l.api === 'procurement' && l.method === 'POST' && !l.q.action);
  // The section header each row is drawn under, in sheet order.
  const sections = () => page.evaluate(() => {
    const out = {}; let head = '';
    document.querySelectorAll('#fctproc-wrap tbody tr').forEach(tr => {
      if (tr.classList.contains('fctproc-grp')) head = tr.querySelector('.gl > span:not(.tw):not(.gm)').textContent.trim();
      else if (tr.dataset.row) out[tr.dataset.row] = head;
    });
    return out;
  });
  const folded = () => page.evaluate(() => [...FCTProcurement._test.state().collapsed].length);
  // Adds through the section's button; answers the new row's id once drawn.
  const addVia = async (name, how = 'click') => {
    const before = posts().length;
    if (how === 'enter') { await addIn(name).focus(); await page.keyboard.press('Enter'); } else await addIn(name).click();
    const p = await until(() => posts()[before], 4000);
    if (!p) return null;
    await until(() => rowTr(page, p.body.item.id).count(), 4000);
    await sleep(200);
    return p.body.item;
  };

  ok('an editor gets + Add Row on every section header',
    await addIn('Stormwater').count() === 1 && await addIn('Mobilization').count() === 1 && await addIn('No cost code').count() === 1);
  ok('…which says where the row goes', await addIn('Stormwater').getAttribute('title') === 'Add a row under Stormwater', await addIn('Stormwater').getAttribute('title'));

  let it = await addVia('Stormwater');
  ok('a section\'s + Add Row POSTs a row with that section\'s cost code, no bid line or sub code',
    it && it.cost_code === 'Stormwater' && !it.bid_item_id && !it.sub_code && it.project_id === 'p1', it);
  let sec = await sections();
  ok('…the row is drawn in that section, after its rows', it && sec[it.id] === 'Stormwater'
    && await page.evaluate(id => { const tr = document.querySelector(`#fctproc-wrap tr[data-row="${id}"]`); const n = tr.nextElementSibling; return !n || n.classList.contains('fctproc-grp'); }, it.id), sec);
  ok('…the click does not fold the section', await folded() === 0);
  ok('…and Quantity has focus, ready to type (Description is hidden)', await page.evaluate(id => { const a = document.activeElement; return !!a && a.dataset.pr === id && a.dataset.pf === 'quantity'; }, it.id));
  ok('…its Cost Code reads Stormwater, and Sub Code offers the bid lines', /Stormwater/.test(await rowTr(page, it.id).locator('.fctproc-codes').textContent())
    && await rowTr(page, it.id).locator('[data-pf="codes"]').count() === 1);
  await page.keyboard.type('12');
  await clickAway(page);
  await until(() => W.rows.some(r => r.id === it.id && r.quantity === 12), 4000);
  ok('typing a quantity saves it on the new row', W.rows.some(r => r.id === it.id && r.quantity === 12 && r.cost_code === 'Stormwater'),
    W.rows.filter(r => r.id === it.id).map(r => [r.quantity, r.cost_code]));

  // A folded section opens to take its row.
  await hdr('Mobilization').locator('.tw').click();
  await sleep(200);
  ok('(the Mobilization section is folded)', await folded() === 1);
  it = await addVia('Mobilization');
  sec = await sections();
  ok('+ Add Row on a folded section opens it and adds the row there', it && it.cost_code === 'Mobilization' && sec[it.id] === 'Mobilization'
    && await folded() === 0 && sec.A3 === 'Mobilization', sec);

  // Keyboard: Enter on the focused button.
  it = await addVia('Stormwater', 'enter');
  ok('Enter on a section\'s + Add Row adds a row there, without folding', it && it.cost_code === 'Stormwater' && (await sections())[it.id] === 'Stormwater'
    && await folded() === 0);
  // Its Sub Code picked: Quantity and Unit come over from the bid line, the
  // change order included (901 + 49), as Add to Procurement gives them.
  await cbPick(page, cell(page, it.id, 'codes'), 'Perim', 'Perimeter');
  await clickAway(page);
  {
    const id = it.id;
    await until(() => W.rows.some(r => r.id === id && r.bid_item_id === 'b2' && Number(r.quantity) === 950), 4000);
    const r = W.rows.find(x => x.id === id);
    const qu = { q: (await cell(page, id, 'quantity').inputValue()).replace(/,/g, ''), u: await cell(page, id, 'unit').inputValue() };
    ok('picking its Sub Code brings the bid line\'s Quantity and Unit (950 LF, change order included), saved and shown',
      r.bid_item_id === 'b2' && Number(r.quantity) === 950 && r.unit === 'LF' && qu.q === '950' && qu.u === 'LF', { saved: [r.bid_item_id, r.quantity, r.unit], qu });
  }

  // "No cost code" gives a blank row, as the toolbar's + Add Row does.
  it = await addVia('No cost code');
  ok('+ Add Row under "No cost code" POSTs a blank row', it && !it.cost_code && !it.vendor && (await sections())[it.id] === 'No cost code', it);

  // A search that the new row does not match: it shows all the same.
  await page.fill('#fctproc-search', 'Perimeter');
  await sleep(400);
  it = await addVia('Stormwater');
  ok('with a search on, the new row shows in its section anyway', it && (await sections())[it.id] === 'Stormwater');
  await page.fill('#fctproc-search', '');
  await sleep(400);

  // Vendor / Quote: the vendor and quote # — and the contact and email when
  // the section agrees on one.
  await page.click('[data-group="vendor"]');
  await sleep(250);
  ok('grouped by vendor, the headers carry + Add Row too', await addIn('LB Water').count() === 1 && await addIn('No vendor yet').count() === 1);
  ok('…saying which vendor and quote', await addIn('LB Water').getAttribute('title') === 'Add a row for LB Water, quote # Q-12', await addIn('LB Water').getAttribute('title'));
  ok('…beside the section name, ahead of the quote, contact and counts (a long header cannot push it off a narrow screen)',
    await hdr('LB Water').locator('.gl > span:not(.tw):not(.gm) + [data-grpadd]').count() === 1);
  it = await addVia('LB Water');
  ok('a vendor section\'s + Add Row POSTs its vendor, quote #, contact and email, and no cost code',
    it && it.vendor === 'LB Water' && it.quote_number === 'Q-12' && it.contact === 'Dana Reyes' && it.email === 'dana@lbwater.com' && !it.cost_code, it);
  ok('…and the row is drawn in that section', it && (await sections())[it.id] === 'LB Water');
  it = await addVia('New Enterprise');
  ok('where the section\'s rows have different contacts, only the vendor is filled in',
    it && it.vendor === 'New Enterprise' && !it.contact && !it.email && !it.quote_number && (await sections())[it.id] === 'New Enterprise', it);
  it = await addVia('No vendor yet');
  ok('+ Add Row under "No vendor yet" POSTs a blank row', it && !it.vendor && !it.cost_code && (await sections())[it.id] === 'No vendor yet', it);
  await page.click('[data-group="none"]');
  await sleep(200);
  ok('with no grouping there are no section buttons (the toolbar\'s + Add Row stays)',
    await page.locator('#fctproc-wrap [data-grpadd]').count() === 0 && await page.locator('#procurement-root [data-act="add"]').count() === 1);
  await page.click('[data-group="cost"]');
  // A PO raised for a row added in a section, then another row added there:
  // the new row is not on that order (a cost code alone matches nothing).
  await sleep(250);
  const a1 = await addVia('Stormwater');
  await cbPick(page, cell(page, a1.id, 'vendor'), 'LB', 'LB Water');
  await clickAway(page);
  await sleep(300);
  const poPosts = () => W.log.filter(l => l.api === 'purchase-orders' && l.method === 'POST');
  const nPo = poPosts().length;
  await page.check(`#procurement-root [data-sel="${a1.id}"]`);
  await page.click('#procurement-root [data-act="bulk-po"]');
  const made = await until(() => poPosts()[nPo], 6000);
  const madePO = made && made.body.purchaseOrder;
  ok('Create PO from a row added in a section raises its order, titled with the cost code (not blank)',
    madePO && madePO.cost_code === 'Stormwater' && !madePO.sub_code && madePO.title === 'Stormwater' && madePO.supplier === 'LB Water', madePO);
  await until(() => rowTr(page, a1.id).locator('td.c-status').textContent().then(t => /^\s*Ordered/.test(t)), 4000);
  const a2 = await addVia('Stormwater');
  await sleep(300);
  const a2Status = (await rowTr(page, a2.id).locator('td.c-status').textContent()).replace(/\s+/g, ' ').trim();
  const a2Po = await cell(page, a2.id, 'po').inputValue().catch(() => '?');
  ok('…then another row added in that section reads Not Ordered, on no PO — not "auto" on the first row\'s order',
    /^Not Ordered/.test(a2Status) && a2Po === '', { a2Status, a2Po });
  await shot(page, 'section-add.png');
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // A view-only user gets no section buttons.
  const W2 = makeWorld();
  W2.rows.push(row('V1', { description: 'pins', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }));
  const v = await openPage(browser, W2, 'level1', { storage });
  await v.page.click('.tab-btn[data-tab="procurement"]');
  await until(() => v.page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 1));
  await sleep(300);
  ok('a view-only user gets no + Add Row on the section headers', await v.page.locator('#fctproc-wrap [data-grpadd]').count() === 0
    && await v.page.locator('#fctproc-wrap tr.fctproc-grp').count() > 0);
  await v.ctx.close();
}

// ── Print / PDF ─────────────────────────────────────────────────────────────
async function printPdf(browser) {
  console.log('\nPrint / PDF: the rows shown, in their sections, in a print window');
  const t = i => new Date(Date.UTC(2026, 9, 5) + i * 1000).toISOString();
  const row = (id, f) => ({ ...BLANK_ROW, id, project_id: 'p1', created_at: t(id.charCodeAt(1)), updated_at: t(id.charCodeAt(1)), ...f });
  const W = makeWorld();
  W.rows.push(
    row('P1', { description: 'geofabric pins', vendor: 'LB Water', quote_number: 'Q-77', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric',
      quantity: 1234567890, unit: 'SF', date_needed: '2026-12-12', lead_time_days: 21 }),
    row('P2', { description: 'mob trailer', quote_number: '<img src=x onerror="window.__xss=1">', vendor: 'New Enterprise', bid_item_id: 'b3', cost_code: 'Mobilization', sub_code: 'Mobilization', quantity: 1, unit: 'LS' }),
  );
  const storage = { fct_proc_project_turf: 'p1', fct_proc_group_turf: 'cost' };
  const { page, ctx, errors } = await openPage(browser, W, 'level2', { viewport: { width: 1474, height: 900 }, storage });
  await page.click('.tab-btn[data-tab="procurement"]');
  await until(() => page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 2));
  await sleep(300);
  // The print window, caught: what is written into it.
  const capture = () => page.evaluate(() => {
    window.__printed = '';
    window.open = () => ({ document: { write: (...c) => { window.__printed += c.join(''); }, close() {} } });
  });
  const printed = () => page.evaluate(() => window.__printed);
  const heads = html => [...html.matchAll(/<th>([^<]*)<\/th>/g)].map(m => m[1]);

  ok('a PDF button sits beside Excel and CSV', await page.locator('#procurement-root [data-act="pdf"]').count() === 1);
  await capture();
  await page.locator('#procurement-root [data-act="pdf"]').click();
  let html = await printed();
  ok('it writes a print page titled with the job, which opens the print dialog',
    /<title>Procurement — Penn Cambria — Job #26119<\/title>/.test(html) && /window\.print\(\)/.test(html), html.slice(0, 300));
  ok('…through the DataWatch report header, like the other reports', /DATAWATCH|datawatch/i.test(html.replace(/<title>.*?<\/title>/, '')));
  ok('…landscape', /@page \{ size: landscape/.test(html));
  ok('grouped by cost code: a section per cost code, and no Cost Code column', /class="grp"[^]*Stormwater[^]*class="grp"[^]*Mobilization/.test(html)
    && !heads(html).includes('Cost Code') && heads(html).includes('Sub Code') && heads(html).includes('Vendor'), heads(html).join('|'));
  ok('every row is on it, with its values', /Geofabric/.test(html) && /1,234,567,890/.test(html) && /12\/12\/2026/.test(html) && /Q-77/.test(html));
  ok('a worked-out date (Order By) prints in italics, with a note saying so', /class="one calc">11\/21\/2026/.test(html) && /Dates in italics are worked out/.test(html));
  ok('text from the rows is escaped', /&lt;img src=x/.test(html) && !/<img src=x/.test(html));
  ok('no Description column (hidden on this page), and none of its text', !heads(html).includes('Description') && !/geofabric pins|mob trailer/.test(html), heads(html).join('|'));

  await page.click('[data-group="vendor"]');
  await sleep(200);
  await capture();
  await page.locator('#procurement-root [data-act="pdf"]').click();
  html = await printed();
  ok('grouped by vendor: a section per vendor and quote, and no Vendor or Quote # column',
    /class="grp"[^]*LB Water[^]*Quote # <b>Q-77<\/b>/.test(html) && !heads(html).includes('Vendor') && !heads(html).includes('Quote #') && heads(html).includes('Cost Code'),
    heads(html).join('|'));

  await page.fill('#fctproc-search', 'Q-77');
  await sleep(400);
  await capture();
  await page.locator('#procurement-root [data-act="pdf"]').click();
  html = await printed();
  ok('a search narrows what prints, and the page says it is filtered', /Q-77/.test(html) && !/Mobilization/.test(html) && /1 of 2 rows \(filtered\)/.test(html));
  await page.fill('#fctproc-search', '');
  await sleep(300);

  // A blocked pop-up is said, not silently dropped.
  await page.evaluate(() => { window.open = () => null; });
  await page.locator('#procurement-root [data-act="pdf"]').click();
  ok('a blocked pop-up is explained', await until(() => page.locator('text=Allow pop-ups for this site').count()));
  ok('no page errors, nothing from the rows ran', errors.length === 0 && !(await page.evaluate(() => window.__xss)), errors.join(' | '));
  await ctx.close();

  // The real thing: a window opens on the click and asks to print.
  const real = await openPage(browser, W, 'level1', { storage });
  await real.ctx.addInitScript(() => { window.print = () => { window.__printCalled = true; }; });
  await real.page.click('.tab-btn[data-tab="procurement"]');
  await until(() => real.page.locator('#procurement-root tr.fctproc-row').count().then(n => n === 2));
  const [pop] = await Promise.all([real.ctx.waitForEvent('page'), real.page.locator('#procurement-root [data-act="pdf"]').click()]);
  await pop.waitForLoadState('load');
  await sleep(300);
  ok('a view-only user can print too: the window opens and the print dialog is asked for',
    await pop.title() === 'Procurement — Penn Cambria — Job #26119' && await pop.evaluate(() => !!window.__printCalled));
  ok('…with both rows on it', await pop.locator('tbody tr:not(.grp)').count() === 2);
  await real.ctx.close();
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const W = makeWorld();
    await asAdmin(browser, W);
    await asLevel1(browser, W);
    await asSales(browser, W);
    await reviewFixes(browser);
    await roundTwoFixes(browser);
    await roundThreeFixes(browser);
    await roundThreeSaveFixes(browser);
    await roundFourFixes(browser);
    await sectionSelect(browser);
    await sectionAdd(browser);
    await printPdf(browser);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
