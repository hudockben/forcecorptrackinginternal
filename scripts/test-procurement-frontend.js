#!/usr/bin/env node
'use strict';
/**
 * Front-end test for the Procurement tab (procurement.js).
 *
 * Run: node scripts/test-procurement-frontend.js
 *
 * Three halves:
 *
 *  1. The pure rules, through FCTProcurement._test: which PO a row is on,
 *     status and the late / due-soon flags around today (month and year
 *     boundaries included), Order By, "bid changed", what Send to Procurement
 *     offers, the re-link after a Procore "Replace all", the bid ordering, the
 *     filters and chips, and the CSV defusing. Code comparison uses the PAGE'S
 *     own _codeKey, lifted out of tracker.html, so a change to how the page
 *     compares codes is felt here too.
 *
 *  2. The tab itself in jsdom against a small in-memory stand-in for
 *     /api/procurement and /api/supplier-contacts: an editor and a viewer
 *     render, per-field saving (only the changed cells, after the quiet spell,
 *     retried after a failure), the combobox commits, bulk edit, Create PO
 *     from selected, filters, exports.
 *
 *  3. Send to Procurement: the re-link PATCH, the checklist (LS/HR unticked,
 *     "already added", "removed earlier") and the exact payload posted.
 *
 * The page's combobox (cbHtml) is stubbed with the same markup contract the
 * page uses: passthrough attributes on the input, and a pick shows up as the
 * input's value + dataset.cbValue followed by synthetic input and change.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { fnSource } = require('./lib/fn-source');

const read = f => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const SRC = read('procurement.js');

let failed = 0, passed = 0;
const assert = (msg, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + msg); return; }
  failed++;
  console.error('  ✗ ' + msg);
  if (detail !== undefined) console.error('      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600));
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => sleep(0);

// The page's own code comparison, when tracker.html still carries it.
let codeKey = null;
try {
  const fn = fnSource(read('tracker.html'), '_codeKey');
  if (fn) codeKey = new Function(`${fn}; return _codeKey;`)();
} catch { /* fall back to the module's copy below */ }

// ── Fixtures ──────────────────────────────────────────────────────────────
const TODAY = '2026-03-10';
const LINES = [
  { id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric',        unit: 'SF', quantity: 8110, index: 0 },
  { id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain',   unit: 'LF', quantity: 950,  index: 1 },
  { id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows',           unit: 'EA', quantity: 12,   index: 2 },
  { id: 'b3', cost_code: 'E&S',        sub_code: 'Silt Sock 12inch', unit: 'LF', quantity: 1200, index: 3 },
  { id: 'b4', cost_code: 'General',    sub_code: 'Mobilization',     unit: 'LS', quantity: 1,    index: 4 },
  { id: 'b5', cost_code: 'General',    sub_code: 'Labor',            unit: 'hr', quantity: 40,   index: 5 },
];
const POS = [
  { id: 'po1', po_number: 'PO-0001', project_id: 'p1', cost_code: 'stormwater ', sub_code: 'GEOFABRIC', supplier: 'Acme Supply', date_created: '2026-03-01', status: 'pending' },
  { id: 'po3', po_number: 'PO-0003', project_id: 'p1', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', supplier: 'LB Water', date_created: '2026-02-20T15:04:05Z', status: 'approved' },
  { id: 'po9', po_number: 'PO-0009', project_id: 'p2', cost_code: 'Stormwater', sub_code: 'Geofabric', supplier: 'Acme Supply', date_created: '2026-03-02', status: 'pending' },
];
const PROJECTS = [
  { id: 'p1', 'project-name': 'Penn Cambria Field', 'job-number': '2614', status: 'In Progress' },
  { id: 'p2', 'project-name': 'Hempfield Stadium',  'job-number': '2588', status: 'Complete' },
  { id: 'p3', 'project-name': 'Bidding Job',        'job-number': '',     status: '' },
];
const SUPPLIERS = ['LB Water', 'Acme Supply', 'Beta Corp'];

const row = (o) => ({
  id: 'r', project_id: 'p1', source: 'manual', bid_item_id: null, cost_code: '', sub_code: '', description: '',
  quantity: null, unit: '', bid_qty_at_send: null, bid_unit_at_send: null, sca_status: 'Pending',
  date_needed: null, lead_time_days: null, date_ordered: null, date_delivered: null, vendor: '', quote_number: '',
  contact: '', email: '', po_id: null, po_auto: true, version: 1, created_at: '2026-03-01T10:00:00Z', ...o,
});

// ── jsdom harness ─────────────────────────────────────────────────────────
// A fake API that behaves like the contract in PROCUREMENT_DESIGN.md §3:
// field-level PATCH, bulk PATCH, idempotent send, soft delete, contacts.
// The checklist starts with nothing ticked. A test that sends "the four"
// (every new line of LINES but the LS and HR ones) ticks them itself.
const FOUR = ['Geofabric', '15" Perf drain', 'Elbows', 'Silt Sock 12inch'];
function tickLines(env, subs = FOUR) {
  env.$$('.fctproc-modal .fctproc-send-line').forEach(l => {
    const cb = l.querySelector('input');
    if (subs.includes(l.querySelector('.sub').textContent) && !cb.disabled && !cb.checked) { cb.checked = true; env.fire(cb, 'change'); }
  });
}

function makeEnv({ perm = { canView: true, canEdit: true }, rows = [], serverCanEdit = true, contacts = [],
                   bidLines = LINES, purchaseOrders = POS.map(p => ({ ...p })), storage = { fct_proc_project_turf: 'p1' }, poLoaded = true } = {}) {
  // Warnings the module logs on purpose (a refresh that failed, a contact it
  // could not remember) are kept, not printed; real errors still print.
  const warns = [];
  const vc = new VirtualConsole();
  vc.on('error', (...a) => console.error(...a));
  vc.on('jsdomError', e => console.error(e));
  vc.on('warn', (...a) => warns.push(a.map(String).join(' ')));
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  if (!w.TextEncoder) w.TextEncoder = require('util').TextEncoder;
  const env = {
    dom, w, warns, calls: [], errors: [], cbCalls: [], created: [], events: [], toasts: [],
    db: { rows: rows.map(r => ({ ...r })), contacts: contacts.map(c => ({ ...c })), failPatch: 0, failGet: false },
    store: { ...storage },
  };
  const db = env.db;
  const json = (status, body) => ({ status, body });
  const live = r => !r.deleted_at;
  env.handle = (c) => {
    if (c.path === '/api/procurement') {
      if (c.method === 'GET' && c.q.action === 'materials') {
        // The material library (api/procurement.js materialLibrary), as set
        // on the env by the test that needs it.
        if (db.failMaterials) return json(503, { ok: false, error: 'db_unavailable', message: 'The database is busy' });
        return json(200, { ok: true, materials: db.materials || [], canEdit: serverCanEdit });
      }
      if (c.method === 'GET' && c.q.action === 'breakdowns') {
        // What a sub code was bought as on other jobs (materialBreakdowns).
        if (db.failBreakdowns) return json(503, { ok: false, error: 'db_unavailable', message: 'The database is busy' });
        const want = String(c.q.sub_code || '').trim().toLowerCase();
        const breakdowns = (db.breakdowns || []).filter(b => b.project_id !== c.q.exclude_project)
          .map(b => ({ ...b, items: b.items.filter(it => String(it.sub_code || '').trim().toLowerCase() === want) }))
          .filter(b => b.items.length);
        return json(200, { ok: true, breakdowns, canEdit: serverCanEdit });
      }
      if (c.method === 'GET') {
        if (db.failGet) return json(503, { ok: false, error: 'db_unavailable', message: 'The database is busy' });
        const items = db.rows.filter(r => r.project_id === c.q.project_id && (c.q.include_deleted ? true : live(r)));
        return json(200, { ok: true, items, canEdit: serverCanEdit });
      }
      if (!serverCanEdit) return json(403, { ok: false, error: 'read_only' });
      if (c.method === 'PATCH' && c.q.action === 'bulk') {
        if (db.bulkOk != null) {
          if (db.bulkOk <= 0) { db.bulkOk = null; return json(503, { ok: false, error: 'db_unavailable', message: 'The database is busy' }); }
          db.bulkOk--;
        }
        const sameV = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) && a != null && b != null : (a == null ? null : a) === (b == null ? null : b));
        const items = [], conflicts = [];
        c.body.ids.forEach(id => {
          const r = db.rows.find(x => x.id === id && live(x));
          if (!r) return;
          const ex = c.body.expect;
          if (ex && Object.keys(ex).some(k => !sameV(r[k], ex[k]) && !(k in c.body.fields && sameV(r[k], c.body.fields[k])))) { conflicts.push({ ...r }); return; }
          Object.assign(r, c.body.fields); r.version++; items.push({ ...r });
        });
        return json(200, { ok: true, items, missing: [], ...(c.body.expect ? { conflicts } : {}) });
      }
      if (c.method === 'PATCH') {
        if (db.failPatch > 0) { db.failPatch--; return json(500, { ok: false, error: 'server_error', message: 'Something went wrong' }); }
        const bad = db.refuse && Object.keys(c.body.fields).find(k => db.refuse(k, c.body.fields[k]));
        if (bad) return json(400, { ok: false, error: 'invalid', message: `${bad} is not allowed`, field: bad });
        const r = db.rows.find(x => x.id === c.q.id && live(x));
        if (!r) return json(404, { ok: false, error: 'not_found' });
        // A cell that no longer holds what the person saw (api/procurement.js
        // expect): nothing is written, and the row as it is goes back.
        const same = (a, b) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) && a != null && b != null : (a == null ? null : a) === (b == null ? null : b));
        // A cell already holding the value being saved is no conflict.
        const moved = Object.keys(c.body.expect || {}).filter(k => !same(r[k], c.body.expect[k])
          && !(k in c.body.fields && same(r[k], c.body.fields[k]))).sort();
        if (moved.length) {
          return json(409, { ok: false, error: 'conflict', message: `This was changed since you started editing it (last by ${r.updated_by || 'someone else'})`,
            fields: moved, item: { ...r }, changed_by: r.updated_by || null, changed_at: r.updated_at || null });
        }
        // The row just before this write: who saved it last (the answer's was).
        const was = { version: r.version, updated_by: r.updated_by || null, updated_at: r.updated_at || null };
        Object.assign(r, c.body.fields);
        r.version++;
        r.updated_at = new Date().toISOString();
        r.updated_by = 'Pat PM';
        // Written, and the answer lost on the way back.
        if (db.losePatch > 0) { db.losePatch--; return { ...json(200, {}), lost: true }; }
        return json(200, { ok: true, item: { ...r }, was });
      }
      if (c.method === 'POST' && c.q.action === 'add') {
        // Several hand-added rows at once; an id already here is `existing`.
        // db.loseAdd: the rows go in but the answer is lost on the way back.
        // db.refuseAdd: refused outright, nothing goes in.
        if (db.refuseAdd) return json(409, { ok: false, error: 'stale_bid', message: 'Not added: that bid line is no longer on the job\'s bid', field: 'bid_item_id' });
        const created = [], existing = [];
        const t0 = Date.now();
        c.body.items.forEach((it, i) => {
          const was = db.rows.find(r => r.id === it.id);
          if (was) { if (was.project_id === c.body.project_id && live(was)) existing.push({ ...was }); return; }
          const r = row({ ...it, project_id: c.body.project_id, source: 'manual', created_at: new Date(t0 + i).toISOString() });
          db.rows.push(r);
          created.push({ ...r });
        });
        const res = json(created.length ? 201 : 200, { ok: true, created, existing, skipped: 0 });
        if (db.loseAdd > 0) { db.loseAdd--; return { ...res, lost: true }; }
        return res;
      }
      if (c.method === 'POST' && c.q.action === 'send') {
        if (db.failSend) return json(500, { ok: false, error: 'server_error', message: 'Something went wrong' });
        const created = [], restored = [];
        let skipped = 0;
        c.body.items.forEach(it => {
          if (db.rows.some(r => r.source === 'bid' && r.bid_item_id === it.bid_item_id && r.project_id === c.body.project_id)) { skipped++; return; }
          const r = row({ ...it, project_id: c.body.project_id, source: 'bid', bid_qty_at_send: it.quantity, bid_unit_at_send: it.unit, created_at: new Date().toISOString() });
          db.rows.push(r); created.push({ ...r });
        });
        (c.body.restore_ids || []).forEach(e => {
          const r = db.rows.find(x => x.id === (typeof e === 'string' ? e : e.id));
          if (!r) return;
          r.deleted_at = null;
          if (typeof e === 'object') Object.assign(r, { bid_item_id: e.bid_item_id, cost_code: e.cost_code, sub_code: e.sub_code });
          r.version++;
          restored.push({ ...r });
        });
        return json(200, { ok: true, created, restored, skipped });
      }
      if (c.method === 'POST') {
        if (db.rows.some(r => r.id === c.body.item.id)) return json(409, { ok: false, error: 'duplicate' });
        const r = row({ ...c.body.item, source: 'manual', created_at: new Date().toISOString() });
        db.rows.push(r);
        return json(201, { ok: true, item: { ...r } });
      }
      if (c.method === 'DELETE') {
        const ids = c.q.ids ? c.q.ids.split(',') : [c.q.id];
        let n = 0;
        ids.forEach(id => { const r = db.rows.find(x => x.id === id && live(x)); if (r) { r.deleted_at = '2026-03-10T00:00:00Z'; n++; } });
        if (!c.q.ids && !n) return json(404, { ok: false, error: 'not_found', message: 'That row does not exist any more.' });
        return json(200, { ok: true, deleted: n });
      }
    }
    if (c.path === '/api/supplier-contacts') {
      if (c.method === 'GET') return json(200, { ok: true, contacts: db.contacts, canEdit: true });
      if (c.method === 'POST' && c.q.action === 'rename') {
        let moved = 0;
        db.contacts.forEach(k => { if (k.supplier_name.toLowerCase() === c.body.from.toLowerCase()) { k.supplier_name = c.body.to; moved++; } });
        let n = 0;
        db.rows.forEach(r => { if (r.vendor.toLowerCase() === c.body.from.toLowerCase() && r.vendor !== c.body.to) { r.vendor = c.body.to; r.version++; n++; } });
        // The orders the server renamed (api/supplier-contacts.js renamePOs).
        const pos = (db.pos || []).filter(po => po.supplier.toLowerCase() === c.body.from.toLowerCase() && po.supplier !== c.body.to);
        pos.forEach(po => { po.supplier = c.body.to; });
        return json(200, { ok: true, moved, merged: 0, rows: n, pos: pos.length, po_ids: pos.map(po => po.id) });
      }
      if (c.method === 'POST') {
        const hit = db.contacts.find(k => k.supplier_name.toLowerCase() === c.body.supplier_name.toLowerCase()
          && (c.body.email ? k.email.toLowerCase() === c.body.email.toLowerCase() : k.name.toLowerCase() === c.body.name.toLowerCase()));
        if (hit) return json(200, { ok: true, contact: hit, existed: true });
        const k = { id: 'c' + (db.contacts.length + 1), ...c.body };
        db.contacts.push(k);
        return json(201, { ok: true, contact: k, existed: false });
      }
      if (c.method === 'PATCH') {
        const k = db.contacts.find(x => x.id === c.q.id);
        Object.assign(k, c.body);
        return json(200, { ok: true, contact: k });
      }
      if (c.method === 'DELETE') { db.contacts = db.contacts.filter(x => x.id !== c.q.id); return json(200, { ok: true }); }
    }
    return json(404, { ok: false, error: 'no_route' });
  };
  w.fetch = async (url, init = {}) => {
    const u = new URL(String(url), 'http://localhost');
    const c = {
      method: init.method || 'GET', path: u.pathname, q: Object.fromEntries(u.searchParams),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null, keepalive: !!init.keepalive,
      auth: init.headers && init.headers.Authorization,
    };
    env.calls.push(c);
    const res = env.handle(c);
    const text = JSON.stringify(res.body);
    // A row's PATCH answered only when the test lets it (set env.patchHold).
    if (env.patchHold && c.method === 'PATCH' && c.path === '/api/procurement' && !c.q.action) {
      const h = env.patchHold;
      env.patchHold = null;
      await h;
    }
    if (env.postHold && c.method === 'POST' && c.path === '/api/procurement') {
      const h = env.postHold;
      env.postHold = null;
      await h;
    }
    if (env.hold && c.method === 'GET' && c.path === '/api/procurement' && !c.q.include_deleted) {
      const h = env.hold;
      env.hold = null;
      await h;
    }
    // The request was acted on, and its answer never arrived.
    if (res && res.lost) throw new w.TypeError('Failed to fetch');
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(text) };
  };
  // The page's combobox markup contract (tracker.html cbHtml).
  w.cbHtml = (listKey, value, placeholder, pass, wrap) => {
    env.cbCalls.push({ listKey, value, placeholder, pass, wrap });
    const e = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<div class="cb" data-list="${e(listKey)}"${pass ? ' data-passthrough="1"' : ''}${wrap ? ' ' + wrap : ''}>`
      + `<input type="text" class="cb-input" value="${e(value)}" placeholder="${e(placeholder)}"${pass ? ' ' + pass : ''}>`
      + '<div class="cb-menu" hidden></div></div>';
  };
  w.URL.createObjectURL = blob => { env.lastBlob = blob; return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { env.lastDownload = this.download; };
  w.addEventListener('fct:procurement-sent', e => env.events.push(e.detail));
  w.eval(SRC);
  env.P = w.FCTProcurement;
  env.cfg = {
    division: 'turf',
    apiBase: '/api',
    getToken: () => 'tok',
    getUserName: () => 'Pat PM',
    perm,
    getProjects: () => PROJECTS,
    getProject: id => PROJECTS.find(p => p.id === id) || null,
    getBidLines: id => (id === 'p1' ? bidLines : []),
    getPurchaseOrders: () => purchaseOrders,
    isPOListLoaded: () => poLoaded,
    codeKey: codeKey || undefined,
    getSuppliers: () => SUPPLIERS,
    addSupplier: async name => { env.created.push(['supplier', name]); return name; },
    createPurchaseOrder: async seed => { const po = { id: 'npo' + (env.created.length + 1), po_number: 'PO-01' + env.created.length, ...seed, date_created: TODAY }; env.created.push(['po', seed]); purchaseOrders.push(po); return po; },
    openPurchaseOrder: id => env.created.push(['open', id]),
    showSaveError: msg => env.errors.push(msg),
    today: () => TODAY,
    storage: {
      getItem: k => (k in env.store ? env.store[k] : null),
      setItem: (k, v) => { env.store[k] = String(v); },
      removeItem: k => { delete env.store[k]; },
    },
  };
  if (!codeKey) delete env.cfg.codeKey;
  env.P.configure(env.cfg);
  env.root = w.document.getElementById('root');
  env.$ = sel => w.document.querySelector(sel);
  env.$$ = sel => [...w.document.querySelectorAll(sel)];
  env.fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  // A combobox commit, as tracker's cbCommitInput delivers it.
  env.pick = (el, value, cbValue) => {
    el.value = value;
    if (cbValue == null) delete el.dataset.cbValue; else el.dataset.cbValue = cbValue;
    env.fire(el, 'input');
    env.fire(el, 'change');
  };
  env.field = (rowId, f) => env.$(`[data-pr="${rowId}"][data-pf="${f}"]`);
  env.patches = () => env.calls.filter(c => c.method === 'PATCH');
  return env;
}

// ════════════════════════════════════════════════════════════════════════
(async () => {
  const boot = makeEnv();
  const T = boot.P._test;
  const CK = codeKey || T.defaultCodeKey;
  const C = (over = {}) => ({ purchaseOrders: POS, bidLines: LINES, codeKey: CK, today: TODAY, projectId: 'p1', poLoaded: true, ...over });

  console.log('\n[module shape]');
  assert('procurement.js defines FCTProcurement once', typeof boot.P === 'object');
  for (const k of ['configure', 'renderTab', 'rerender', 'refresh', 'openSendModal', 'cbOptions', 'cbFilter'])
    assert(`exposes ${k}()`, typeof boot.P[k] === 'function');
  for (const k of ['load', 'list', 'upsert', 'update', 'remove', 'rename'])
    assert(`contacts.${k}() exists`, typeof boot.P.contacts[k] === 'function');
  for (const k of ['effectivePO', 'effectiveDateOrdered', 'orderBy', 'statusOf', 'flagsOf', 'liveCodes', 'bidChange',
    'sendPlan', 'relinkPlan', 'sortRows', 'applyFilters', 'csvEscape', 'addDays'])
    assert(`_test.${k} exists`, typeof T[k] === 'function');
  assert("the page's own _codeKey was lifted from tracker.html", typeof codeKey === 'function');
  boot.w.eval(SRC);
  assert('loading the script twice keeps the first instance', boot.w.FCTProcurement === boot.P);
  assert('no "del-btn" with data-tab (tracker\'s global delete handler would hijack it)',
    !/class="[^"]*del-btn[^"]*"[^>]*data-tab|data-tab[^>]*class="[^"]*del-btn/.test(SRC));
  assert('no listener keys off tracker\'s data-f / data-i / data-tab attributes',
    !/data-f="|data-i="|data-tab="/.test(SRC));

  // ── addDays ────────────────────────────────────────────────────────────
  console.log('\n[addDays]');
  assert('+1 across a month end', T.addDays('2026-01-31', 1) === '2026-02-01');
  assert('+1 across a year end', T.addDays('2026-12-31', 1) === '2027-01-01');
  assert('-1 into February', T.addDays('2026-03-01', -1) === '2026-02-28');
  assert('-1 into a leap February', T.addDays('2028-03-01', -1) === '2028-02-29');
  assert('across the spring DST change', T.addDays('2026-03-08', 1) === '2026-03-09');
  assert('across the fall DST change', T.addDays('2026-11-01', 1) === '2026-11-02');
  assert('-60 days lands on March 1 (no Feb 29 in 2026)', T.addDays('2026-04-30', -60) === '2026-03-01');
  assert('0 days is the same date', T.addDays('2026-05-05', 0) === '2026-05-05');
  assert('a non-date gives blank', T.addDays('soon', 1) === '');
  assert('an impossible date gives blank', T.addDays('2026-02-30', 1) === '');
  assert('a NaN offset gives blank', T.addDays('2026-01-01', NaN) === '');
  assert('a timestamp is read by its date', T.addDays('2026-01-01T23:59:00Z', 1) === '2026-01-02');

  // ── orderBy ───────────────────────────────────────────────────────────
  console.log('\n[orderBy]');
  assert('Date Needed minus Lead Time', T.orderBy(row({ date_needed: '2026-03-20', lead_time_days: 10 })) === '2026-03-10');
  assert('back across a month boundary', T.orderBy(row({ date_needed: '2026-03-05', lead_time_days: 5 })) === '2026-02-28');
  assert('back into a leap day', T.orderBy(row({ date_needed: '2028-03-01', lead_time_days: 1 })) === '2028-02-29');
  assert('back across a year boundary', T.orderBy(row({ date_needed: '2026-01-03', lead_time_days: 5 })) === '2025-12-29');
  assert('lead time 0 is the needed date', T.orderBy(row({ date_needed: '2026-03-20', lead_time_days: 0 })) === '2026-03-20');
  assert('a lead time typed as text still counts', T.orderBy(row({ date_needed: '2026-03-20', lead_time_days: '7' })) === '2026-03-13');
  assert('no lead time -> blank', T.orderBy(row({ date_needed: '2026-03-20' })) === '');
  assert('no date needed -> blank', T.orderBy(row({ lead_time_days: 5 })) === '');

  // ── liveCodes ─────────────────────────────────────────────────────────
  console.log('\n[liveCodes]');
  let lc = T.liveCodes(row({ source: 'bid', bid_item_id: 'b1', cost_code: 'Old', sub_code: 'Old sub' }), C());
  assert("a row on a bid line shows the line's current codes", lc.cost_code === 'Stormwater' && lc.sub_code === 'Geofabric' && !lc.notOnBid, lc);
  lc = T.liveCodes(row({ source: 'bid', bid_item_id: 'gone', cost_code: 'Stormwater', sub_code: 'Rip rap' }), C());
  assert('a bid row whose line is gone keeps its stored codes, flagged "not on bid"', lc.sub_code === 'Rip rap' && lc.notOnBid && !lc.line);
  lc = T.liveCodes(row({ source: 'manual', bid_item_id: 'gone', cost_code: 'X', sub_code: 'Y' }), C());
  assert('a hand-added row coded off a line that has gone is flagged too', lc.notOnBid);
  lc = T.liveCodes(row({ source: 'manual', cost_code: 'X', sub_code: 'Y' }), C());
  assert('a hand-added row never tied to a line is not flagged', !lc.notOnBid && lc.cost_code === 'X');

  // ── effectivePO ───────────────────────────────────────────────────────
  console.log('\n[effectivePO]');
  const r1 = row({ id: 'r1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' });
  let e = T.effectivePO(r1, C());
  assert('exactly one PO with the codes -> auto', e.kind === 'auto' && e.po.id === 'po1', e.kind);
  assert('codes compare case/space-insensitively (the page\'s _codeKey)', e.kind === 'auto');
  e = T.effectivePO({ ...r1, cost_code: 'stale', sub_code: 'stale' }, C());
  assert("matching uses the bid line's live codes, not the stored copy", e.kind === 'auto' && e.po.id === 'po1');
  const po2 = { id: 'po2', po_number: 'PO-0002', project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Geo-fabric'.replace('-', ''), supplier: '', date_created: '2026-03-05' };
  e = T.effectivePO(r1, C({ purchaseOrders: POS.concat(po2) }));
  assert('two matching POs -> multiple, nothing picked', e.kind === 'multiple' && e.candidates.length === 2 && !e.po, e.kind);
  e = T.effectivePO({ ...r1, vendor: 'Beta Corp' }, C());
  assert('a PO for a different vendor is not a match', e.kind === 'none', e.kind);
  e = T.effectivePO({ ...r1, vendor: 'Beta Corp' }, C({ purchaseOrders: POS.concat(po2) }));
  assert('a PO with no supplier yet still matches a row with a vendor', e.kind === 'auto' && e.po.id === 'po2', e.kind);
  e = T.effectivePO({ ...r1, vendor: '  acme   SUPPLY ' }, C());
  assert('vendor compared trimmed and case-insensitive', e.kind === 'auto' && e.po.id === 'po1', e.kind);
  e = T.effectivePO({ ...r1, project_id: 'p2' }, C({ projectId: 'p2' }));
  assert("only POs on the row's own job", e.kind === 'auto' && e.po.id === 'po9');
  e = T.effectivePO({ ...r1, po_id: 'po3' }, C());
  assert('a linked PO wins whatever its codes', e.kind === 'linked' && e.po.id === 'po3');
  e = T.effectivePO({ ...r1, po_id: 'deleted-po' }, C());
  assert('a linked PO that was deleted -> "PO removed"', e.kind === 'removed' && !e.po);
  // A linked PO moved to another job on the Purchase Orders tab is not this
  // job's order any more: red, and the row is not "Ordered" by it.
  e = T.effectivePO({ ...r1, project_id: 'p1', po_id: 'po9' }, C());
  assert('a linked PO now on ANOTHER job -> "moved", not linked', e.kind === 'moved' && e.po.id === 'po9', e.kind);
  assert('…the row is Not Ordered, with no Date Ordered from it',
    T.statusOf({ ...r1, project_id: 'p1', po_id: 'po9' }, C()) === 'Not Ordered'
    && T.effectiveDateOrdered({ ...r1, project_id: 'p1', po_id: 'po9' }, C()) === '');
  assert('…and its PO # reads "PO on another job"', T.fieldValue({ ...r1, project_id: 'p1', po_id: 'po9' }, 'po', C()) === 'PO on another job');
  e = T.effectivePO({ ...r1, project_id: 'p1', po_id: 'pox' }, C({ purchaseOrders: POS.concat({ id: 'pox', po_number: 'PO-0011', project_id: '', cost_code: '', sub_code: '' }) }));
  assert('…so is one taken off every job', e.kind === 'moved', e.kind);
  e = T.effectivePO({ ...r1, po_auto: false }, C());
  assert('"No PO" stays No PO even when a PO matches', e.kind === 'nopo');
  e = T.effectivePO({ ...r1, po_auto: false }, C({ poLoaded: false }));
  assert('"No PO" does not wait for the PO list', e.kind === 'nopo');
  e = T.effectivePO(r1, C({ poLoaded: false }));
  assert('PO list not loaded -> loading, not blank', e.kind === 'loading');
  e = T.effectivePO({ ...r1, po_id: 'po3' }, C({ poLoaded: false }));
  assert('a linked PO is "loading" too until the list arrives', e.kind === 'loading');
  e = T.effectivePO(row({ id: 'x' }), C({ purchaseOrders: [{ id: 'blank', po_number: 'PO-0100', project_id: 'p1', cost_code: '', sub_code: '' }] }));
  assert('a row with no codes does not match a PO raised with blank codes', e.kind === 'none', e.kind);
  e = T.effectivePO(row({ cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }), C());
  assert('a hand-added row matches on its typed codes', e.kind === 'auto' && e.po.id === 'po3');
  assert('vendorCompatible: blank either side matches', T.vendorCompatible('', 'X') && T.vendorCompatible('X', '') && !T.vendorCompatible('A', 'B'));

  // ── effectiveDateOrdered ──────────────────────────────────────────────
  console.log('\n[effectiveDateOrdered]');
  assert('the row\'s own date wins', T.effectiveDateOrdered({ ...r1, date_ordered: '2026-02-01' }, C()) === '2026-02-01');
  assert("else the auto-matched PO's date", T.effectiveDateOrdered(r1, C()) === '2026-03-01');
  assert("a PO's ISO timestamp is read as its date", T.effectiveDateOrdered({ ...r1, po_id: 'po3' }, C()) === '2026-02-20');
  assert('a removed PO gives nothing', T.effectiveDateOrdered({ ...r1, po_id: 'gone' }, C()) === '');
  assert('several matching POs give nothing', T.effectiveDateOrdered(r1, C({ purchaseOrders: POS.concat(po2) })) === '');
  assert('No PO gives nothing', T.effectiveDateOrdered({ ...r1, po_auto: false }, C()) === '');

  // ── statusOf ──────────────────────────────────────────────────────────
  console.log('\n[statusOf]');
  const plain = row({ id: 'p', cost_code: 'Nothing', sub_code: 'Matches' });
  assert('nothing -> Not Ordered', T.statusOf(plain, C()) === 'Not Ordered');
  assert('Date Ordered -> Ordered', T.statusOf({ ...plain, date_ordered: '2026-03-02' }, C()) === 'Ordered');
  assert('an auto-matched PO -> Ordered', T.statusOf(r1, C()) === 'Ordered');
  assert('a linked PO -> Ordered', T.statusOf({ ...plain, po_id: 'po3' }, C()) === 'Ordered');
  assert('Date Delivered beats everything -> Delivered', T.statusOf({ ...plain, date_delivered: '2026-03-03' }, C()) === 'Delivered');
  assert('a removed PO counts as no PO', T.statusOf({ ...plain, po_id: 'gone' }, C()) === 'Not Ordered');
  assert('several matching POs count as no PO', T.statusOf(r1, C({ purchaseOrders: POS.concat(po2) })) === 'Not Ordered');
  assert('No PO + a date ordered -> Ordered', T.statusOf({ ...r1, po_auto: false, date_ordered: '2026-03-01' }, C()) === 'Ordered');
  // While the PO list has not loaded, a row whose own dates do not settle it
  // is not known — never "Not Ordered" (and so never Late) by default.
  assert('PO list loading -> "…" (not known) until it arrives', T.statusOf(r1, C({ poLoaded: false })) === '…');
  assert('…the same for a row linked to a PO by id', T.statusOf({ ...plain, po_id: 'po3' }, C({ poLoaded: false })) === '…');
  assert('…but its own Date Ordered still says Ordered', T.statusOf({ ...r1, date_ordered: '2026-03-02' }, C({ poLoaded: false })) === 'Ordered');
  assert('…and Date Delivered still says Delivered', T.statusOf({ ...r1, date_delivered: '2026-03-02' }, C({ poLoaded: false })) === 'Delivered');
  assert('…and "No PO" is Not Ordered whatever the list holds', T.statusOf({ ...r1, po_auto: false }, C({ poLoaded: false })) === 'Not Ordered');
  assert('…and so is a row with no codes (it can match no PO)', T.statusOf(row({ id: 'nc' }), C({ poLoaded: false })) === 'Not Ordered');
  {
    const lateish = { ...r1, date_needed: '2026-03-01' };
    const c = C({ poLoaded: false });
    assert('not known -> no Late / Due soon / Late delivery flag, and no Late or Due chip',
      T.flagsOf(lateish, c).length === 0 && !T.chipMatch('late', lateish, c) && !T.chipMatch('due14', { ...r1, date_needed: '2026-03-12' }, c)
        && !T.chipMatch('not_ordered', lateish, c), T.flagsOf(lateish, c));
    assert('…but it is still "not delivered", and SCA Needed still flags', T.chipMatch('not_delivered', lateish, c)
      && T.flagsOf({ ...lateish, sca_status: 'Needed' }, c).map(f => f.key).join() === 'sca_open');
  }

  // ── flagsOf ───────────────────────────────────────────────────────────
  console.log('\n[flagsOf]');
  const keys = (r, c = C()) => T.flagsOf(r, c).map(f => f.key).join(',');
  assert('needed yesterday, not ordered -> Late', keys({ ...plain, date_needed: '2026-03-09' }) === 'late');
  assert('needed today -> Due soon (not late)', keys({ ...plain, date_needed: '2026-03-10' }) === 'due_soon');
  assert('needed in 14 days -> Due soon', keys({ ...plain, date_needed: '2026-03-24' }) === 'due_soon');
  assert('needed in 15 days -> no flag', keys({ ...plain, date_needed: '2026-03-25' }) === '');
  assert('order-by passed (lead time) -> Late even though needed is far off',
    keys({ ...plain, date_needed: '2026-04-30', lead_time_days: 60 }) === 'late');
  assert('order-by in the window -> Due soon', keys({ ...plain, date_needed: '2026-05-01', lead_time_days: 50 }) === 'due_soon');
  assert('order-by past the window -> no flag', keys({ ...plain, date_needed: '2026-06-01', lead_time_days: 10 }) === '');
  assert('month boundary: Jan 31 + 14 = Feb 14 is due soon',
    keys({ ...plain, date_needed: '2026-02-14' }, C({ today: '2026-01-31' })) === 'due_soon');
  assert('month boundary: Feb 15 is not', keys({ ...plain, date_needed: '2026-02-15' }, C({ today: '2026-01-31' })) === '');
  assert('year boundary: Dec 25 + 14 = Jan 8 is due soon',
    keys({ ...plain, date_needed: '2027-01-08' }, C({ today: '2026-12-25' })) === 'due_soon');
  assert('year boundary: Jan 9 is not', keys({ ...plain, date_needed: '2027-01-09' }, C({ today: '2026-12-25' })) === '');
  assert('leap year: Feb 15 + 14 = Feb 29 is due soon',
    keys({ ...plain, date_needed: '2028-02-29' }, C({ today: '2028-02-15' })) === 'due_soon');
  assert('ordered and needed yesterday -> Late delivery',
    keys({ ...plain, date_ordered: '2026-03-01', date_needed: '2026-03-09' }) === 'late_delivery');
  assert('ordered and needed today -> no flag', keys({ ...plain, date_ordered: '2026-03-01', date_needed: '2026-03-10' }) === '');
  assert('ordered with a passed order-by is not "Late" (it is ordered)',
    keys({ ...plain, date_ordered: '2026-03-01', date_needed: '2026-03-20', lead_time_days: 30 }) === '');
  assert('delivered -> no date flags', keys({ ...plain, date_delivered: '2026-03-08', date_needed: '2026-03-01' }) === '');
  assert('SCA Needed -> Sub agreement open', keys({ ...plain, sca_status: 'Needed' }) === 'sca_open');
  assert('SCA Needed stacks with Late', keys({ ...plain, sca_status: 'Needed', date_needed: '2026-03-01' }) === 'late,sca_open');
  assert('SCA Executed -> nothing', keys({ ...plain, sca_status: 'Executed' }) === '');
  assert('no dates -> no flags', keys(plain) === '');
  const lf = T.flagsOf({ ...plain, date_needed: '2026-03-09' }, C())[0];
  assert('Late is red with an explaining title', lf.level === 'red' && /03\/09\/2026/.test(lf.title), lf);
  assert('Due soon / Sub agreement open are amber',
    T.flagsOf({ ...plain, date_needed: '2026-03-12', sca_status: 'Needed' }, C()).every(f => f.level === 'amber'));

  // ── bidChange ─────────────────────────────────────────────────────────
  console.log('\n[bidChange]');
  const sent = row({ source: 'bid', bid_item_id: 'b2', bid_qty_at_send: 901, bid_unit_at_send: 'LF', quantity: 901, unit: 'LF' });
  let bc = T.bidChange(sent, C());
  assert('qty moved -> "bid 901 → 950 LF"', bc && bc.label === 'bid 901 → 950 LF', bc && bc.label);
  assert('carries the new qty and unit', bc && bc.toQty === 950 && bc.toUnit === 'LF' && bc.qtyChanged && !bc.unitChanged);
  assert('unchanged -> null', T.bidChange({ ...sent, bid_qty_at_send: 950 }, C()) === null);
  bc = T.bidChange({ ...sent, bid_qty_at_send: 950, bid_unit_at_send: 'SF' }, C());
  assert('unit moved -> both units in the label', bc && bc.label === 'bid 950 SF → 950 LF', bc && bc.label);
  assert('unit compared case-insensitively', T.bidChange({ ...sent, bid_qty_at_send: 950, bid_unit_at_send: 'lf' }, C()) === null);
  bc = T.bidChange(row({ source: 'bid', bid_item_id: 'b1', bid_qty_at_send: 8110, bid_unit_at_send: 'SF' }),
    C({ bidLines: [{ ...LINES[0], quantity: 8500 }] }));
  assert('thousands are grouped in the label', bc && bc.label === 'bid 8,110 → 8,500 SF', bc && bc.label);
  assert('a hand-added row never reports a bid change', T.bidChange({ ...sent, source: 'manual' }, C()) === null);
  assert('a row whose line is gone reports none (it is "not on bid")', T.bidChange({ ...sent, bid_item_id: 'gone' }, C()) === null);
  assert('blank at send and blank now -> null',
    T.bidChange(row({ source: 'bid', bid_item_id: 'b1', bid_unit_at_send: 'SF' }), C({ bidLines: [{ ...LINES[0], quantity: null }] })) === null);
  assert('qty as a string from the server still compares as a number',
    T.bidChange(T.normRow({ ...sent, bid_qty_at_send: '950.0000' }), C()) === null);

  // ── sendPlan ──────────────────────────────────────────────────────────
  console.log('\n[sendPlan]');
  const planRows = [
    row({ id: 'live1', source: 'bid', bid_item_id: 'b1' }),
    row({ id: 'dead2', source: 'bid', bid_item_id: 'b2', deleted_at: '2026-03-02T00:00:00Z' }),
    row({ id: 'man3', source: 'manual', bid_item_id: 'b3' }),
  ];
  const plan = T.sendPlan(LINES.slice().reverse(), planRows);
  const flat = Object.fromEntries(plan.groups.flatMap(g => g.lines).map(x => [x.line.id, x]));
  assert('groups by cost code in bid order', eq(plan.groups.map(g => g.cost_code), ['Stormwater', 'E&S', 'General']),
    plan.groups.map(g => g.cost_code));
  assert('lines follow the bid index, not the array order', eq(plan.groups[0].lines.map(x => x.line.id), ['b1', 'b2', 'b6']));
  assert('a line a live bid row has -> "added", unticked', flat.b1.state === 'added' && !flat.b1.checked && flat.b1.rowId === 'live1');
  assert('a line whose bid row was deleted -> "removed", unticked, restores that row',
    flat.b2.state === 'removed' && !flat.b2.checked && flat.b2.restoreId === 'dead2');
  // Not "added" (a hand row may be an extra material coded off the line),
  // but not ticked by default either: Send would put a second row of the
  // same material beside the one the PM started by hand.
  assert('a hand-added row on a line does not make it "added"…', flat.b3.state === 'new');
  assert('…but the line starts unticked, saying it has a hand-added row',
    !flat.b3.checked && flat.b3.handRows === 1 && /hand-added row/.test(flat.b3.hint), flat.b3);
  assert('nothing starts ticked: a new EA line, an LS line and an HR line all start unticked, the PM ticks what to add',
    flat.b6.state === 'new' && !flat.b6.checked && flat.b4.state === 'new' && !flat.b4.checked && flat.b5.state === 'new' && !flat.b5.checked
    && !flat.b6.hint);
  assert('counts add up', eq(plan.counts, { total: 6, new: 4, added: 1, removed: 1, checked: 0 }), plan.counts);
  assert('a live row wins over a deleted one for the same line',
    T.sendPlan([LINES[0]], [row({ id: 'd', source: 'bid', bid_item_id: 'b1', deleted_at: 'x' }), row({ id: 'l', source: 'bid', bid_item_id: 'b1' })])
      .groups[0].lines[0].state === 'added');
  assert('no bid lines -> no groups', T.sendPlan([], planRows).groups.length === 0);
  {
    // After a Procore "Replace all": every line has a new id; the job's rows
    // still name the old ones. r4 was deleted on purpose (with a quote typed).
    const NEWL = [
      { id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
      { id: 'n4', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', unit: 'LF', quantity: 2400, index: 1 },
      { id: 'n5', cost_code: 'E&S', sub_code: 'Inlet protection', unit: 'EA', quantity: 4, index: 2 },
      { id: 'n6', cost_code: 'E&S', sub_code: 'Inlet protection', unit: 'EA', quantity: 2, index: 3 },
    ];
    const r4 = row({ id: 'r4', source: 'bid', bid_item_id: 'b4', cost_code: 'e&s', sub_code: 'silt sock 12INCH', quote_number: 'Q-SILT-1', deleted_at: '2026-03-03T00:00:00Z' });
    let sp = T.sendPlan(NEWL, [row({ id: 'r1', source: 'bid', bid_item_id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric' }), r4], CK);
    let en = Object.fromEntries(sp.groups.flatMap(g => g.lines).map(x => [x.line.id, x]));
    assert('Replace all: a line deleted earlier under its OLD id is still "removed earlier", unticked',
      en.n4.state === 'removed' && !en.n4.checked && en.n4.restoreId === 'r4', en.n4);
    assert('…and its restore carries the new line (a deleted row cannot be PATCHed)',
      eq(en.n4.relink, { bid_item_id: 'n4', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }), en.n4.relink);
    assert('…a line kept by id needs no relink', en.n1.state === 'added' && !en.n1.relink);
    assert('…the counts know it', sp.counts.removed === 1 && sp.counts.new === 2, sp.counts);
    sp = T.sendPlan(NEWL, [row({ id: 'd5', source: 'bid', bid_item_id: 'b5', cost_code: 'E&S', sub_code: 'Inlet protection', deleted_at: 'x' })], CK);
    en = Object.fromEntries(sp.groups.flatMap(g => g.lines).map(x => [x.line.id, x]));
    assert('…not when two new lines share its codes (no guessing)', en.n5.state === 'new' && en.n6.state === 'new');
    sp = T.sendPlan(NEWL, [r4, row({ id: 'live', source: 'bid', bid_item_id: 'n4', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' })], CK);
    en = Object.fromEntries(sp.groups.flatMap(g => g.lines).map(x => [x.line.id, x]));
    assert('…not when a bid row already has the new line', en.n4.state === 'added');
    sp = T.sendPlan(NEWL, [r4, row({ id: 'orph', source: 'bid', bid_item_id: 'b9', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' })], CK);
    en = Object.fromEntries(sp.groups.flatMap(g => g.lines).map(x => [x.line.id, x]));
    assert('…not when a LIVE orphan is the one the re-link gives that line to', en.n4.state === 'new' && !en.n4.relink, en.n4);
    sp = T.sendPlan(NEWL, [row({ id: 'dm', source: 'manual', bid_item_id: 'b4', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', deleted_at: 'x' })], CK);
    assert('…and a deleted hand-added row is not a bid line\'s "removed earlier"', sp.counts.removed === 0);
    sp = T.sendPlan(NEWL, [
      row({ id: 'old', source: 'bid', bid_item_id: 'b4', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', deleted_at: 'x', created_at: '2026-01-01T00:00:00Z' }),
      row({ id: 'older', source: 'bid', bid_item_id: 'b0', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', deleted_at: 'x', created_at: '2025-12-01T00:00:00Z' }),
    ], CK);
    assert('…two deleted rows for one line: one is offered back (the earlier one), never both',
      sp.counts.removed === 1 && sp.groups.flatMap(g => g.lines).find(x => x.line.id === 'n4').restoreId === 'older');
  }

  {
    // After a Replace all, two new lines with the SAME codes (the estimate's
    // own duplicates) are not re-linked — section 1: only when exactly one
    // candidate exists. Send must not then tick them as new: the job's rows
    // for that material are still there, badged "not on bid".
    const DUP = [
      { id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 12500, index: 0 },
      { id: 'n2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', unit: 'LF', quantity: 901, index: 1 },
      { id: 'n2b', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', unit: 'LF', quantity: 450, index: 2 },
      { id: 'n3', cost_code: 'E&S', sub_code: 'PVC Pipe 4"', unit: 'LF', quantity: 80, index: 3 },
      { id: 'n3b', cost_code: 'E&S', sub_code: 'PVC pipe  4"', unit: 'LF', quantity: 40, index: 4 },
    ];
    const worked = [
      row({ id: 'R2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', vendor: 'LB Water', quote_number: 'FW-2231' }),
      row({ id: 'R2b', source: 'bid', bid_item_id: 'b2b', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', vendor: 'LB Water' }),
      row({ id: 'R3', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'PVC Pipe 4"' }),
    ];
    assert('duplicate codes: the re-link leaves them alone (exactly one candidate only)',
      T.relinkPlan(DUP, worked, CK).length === 0, T.relinkPlan(DUP, worked, CK));
    const sp = T.sendPlan(DUP, worked, CK);
    const en = Object.fromEntries(sp.groups.flatMap(g => g.lines).map(x => [x.line.id, x]));
    assert('…Send offers both drain lines UNTICKED, not "new / ticked"',
      en.n2.state === 'new' && !en.n2.checked && en.n2b.state === 'new' && !en.n2b.checked, [en.n2, en.n2b]);
    assert('…saying rows with these codes are on the job but not on the bid',
      /2 rows on this job have these codes but are not on the bid/.test(en.n2.hint) && eq(en.n2.orphans.sort(), ['R2', 'R2b']), en.n2.hint);
    assert('…the same for lines that differ only in case or spacing',
      !en.n3.checked && !en.n3b.checked && /1 row on this job has these codes/.test(en.n3b.hint), [en.n3.hint, en.n3b.hint]);
    assert('…a line with no such row is new, with no hint (and, like every line, unticked)', en.n1.state === 'new' && !en.n1.checked && !en.n1.hint);
    // A live orphan whose re-link PATCH failed is just as much the line's.
    const sp2 = T.sendPlan([DUP[0]], [row({ id: 'G', source: 'bid', bid_item_id: 'old1', cost_code: 'Stormwater', sub_code: 'Geofabric' })], CK);
    assert('…and an orphan whose re-link failed keeps its line unticked',
      sp2.groups[0].lines[0].state === 'new' && !sp2.groups[0].lines[0].checked, sp2.groups[0].lines[0]);
    // A deleted orphan is not a live row: its line is offered as before.
    const sp3 = T.sendPlan(DUP.slice(0, 2), [row({ id: 'D', source: 'bid', bid_item_id: 'old9', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', deleted_at: 'x' })], CK);
    assert('…a DELETED orphan does not hold a line back (it is "removed earlier")', sp3.groups[0].lines[1].state === 'removed');
  }

  // ── codeSyncPlan ──────────────────────────────────────────────────────
  console.log('\n[codeSyncPlan]');
  {
    const L = [{ id: 'b2', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf', unit: 'LF', quantity: 901, index: 0 },
               { id: 'b3', cost_code: 'E&S', sub_code: '', unit: 'LF', quantity: 1, index: 1 }];
    const cs = T.codeSyncPlan(L, [
      row({ id: 'R2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"' }),
      row({ id: 'M2', source: 'manual', bid_item_id: 'b2', cost_code: 'stormwater', sub_code: 'perimeter drain 15IN perf' }),
      row({ id: 'R3', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock' }),
      row({ id: 'G', source: 'bid', bid_item_id: 'gone', cost_code: 'X', sub_code: 'Y' }),
      row({ id: 'D', source: 'bid', bid_item_id: 'b2', cost_code: 'Old', sub_code: 'Old', deleted_at: 'x' }),
    ], CK);
    assert('a row whose line was renamed on the bid page gets the line\'s codes stored',
      eq(cs, [{ id: 'R2', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf', sync: true }]), cs);
    assert('…not one that differs only in case or spacing, a line half way through a rename (blank code), a line that is gone, or a deleted row', cs.length === 1);
    assert('sameBid: same ids and codes (any case) agree', T.sameBid(L, L.map(l => ({ ...l, cost_code: l.cost_code.toUpperCase(), quantity: 5 })), CK));
    assert('…another id or another sub code does not', !T.sameBid(L, [L[0], { ...L[1], id: 'n3' }], CK)
      && !T.sameBid(L, [L[0], { ...L[1], sub_code: 'Silt Sock' }], CK));
  }

  // ── relinkPlan ────────────────────────────────────────────────────────
  console.log('\n[relinkPlan]');
  const NEW = [
    { id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
    { id: 'n2', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', unit: 'LF', quantity: 1200, index: 1 },
    { id: 'n3', cost_code: 'E&S', sub_code: 'Inlet protection', unit: 'EA', quantity: 4, index: 2 },
    { id: 'n4', cost_code: 'E&S', sub_code: 'Inlet protection', unit: 'EA', quantity: 2, index: 3 },
  ];
  let rp = T.relinkPlan(NEW, [row({ id: 'o1', source: 'bid', bid_item_id: 'old1', cost_code: 'stormwater', sub_code: ' Geofabric ' })], CK);
  assert('an orphan re-links to the one new line with its codes',
    eq(rp, [{ id: 'o1', bid_item_id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric' }]), rp);
  rp = T.relinkPlan(NEW, [row({ id: 'o3', source: 'bid', bid_item_id: 'old3', cost_code: 'E&S', sub_code: 'Inlet protection' })], CK);
  assert('two candidate lines -> left alone', rp.length === 0, rp);
  rp = T.relinkPlan(NEW, [row({ id: 'o2', source: 'bid', bid_item_id: 'old2', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }),
    row({ id: 'has', source: 'bid', bid_item_id: 'n2' })], CK);
  assert('a line another bid row already has -> left alone', rp.length === 0, rp);
  rp = T.relinkPlan(NEW, [row({ id: 'o2', source: 'bid', bid_item_id: 'old2', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }),
    row({ id: 'gone', source: 'bid', bid_item_id: 'n2', deleted_at: 'x' })], CK);
  assert('a line a DELETED bid row holds is claimed too (the unique index counts it)', rp.length === 0, rp);
  rp = T.relinkPlan(NEW, [
    row({ id: 'late', source: 'bid', bid_item_id: 'oldB', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', created_at: '2026-03-05T00:00:00Z' }),
    row({ id: 'early', source: 'bid', bid_item_id: 'oldA', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', created_at: '2026-03-01T00:00:00Z' }),
  ], CK);
  assert('two orphans, one line -> only the earlier row takes it', rp.length === 1 && rp[0].id === 'early', rp);
  rp = T.relinkPlan(NEW, [row({ id: 'd', source: 'bid', bid_item_id: 'old1', cost_code: 'Stormwater', sub_code: 'Geofabric', deleted_at: 'x' })], CK);
  assert('a deleted orphan is not re-linked (it cannot be edited)', rp.length === 0);
  rp = T.relinkPlan(NEW, [row({ id: 'm', source: 'manual', bid_item_id: 'old1', cost_code: 'Stormwater', sub_code: 'Geofabric' })], CK);
  assert('a hand-added row ("+ Material") whose line is gone follows the one new line with its codes',
    eq(rp, [{ id: 'm', bid_item_id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric' }]), rp);
  rp = T.relinkPlan(NEW, [
    row({ id: 'b', source: 'bid', bid_item_id: 'old1', cost_code: 'Stormwater', sub_code: 'Geofabric', created_at: '2026-03-01T00:00:00Z' }),
    row({ id: 'm1', source: 'manual', bid_item_id: 'old1', cost_code: 'Stormwater', sub_code: 'Geofabric', created_at: '2026-03-02T00:00:00Z' }),
    row({ id: 'm2', source: 'manual', bid_item_id: 'old1', cost_code: 'Stormwater', sub_code: 'Geofabric', created_at: '2026-03-03T00:00:00Z' }),
  ], CK);
  assert('…the bid row and its materials all follow it (materials may share a line; only bid rows claim one)',
    eq(rp.map(x => x.id + '>' + x.bid_item_id), ['b>n1', 'm1>n1', 'm2>n1']), rp);
  rp = T.relinkPlan(NEW, [row({ id: 'm', source: 'manual', bid_item_id: 'n2', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }),
    row({ id: 'has', source: 'bid', bid_item_id: 'n2' })], CK);
  assert('a hand-added row already on a current line is untouched', rp.length === 0, rp);
  rp = T.relinkPlan(NEW, [row({ id: 'm', source: 'manual', bid_item_id: 'old3', cost_code: 'E&S', sub_code: 'Inlet protection' })], CK);
  assert('a hand-added row with two candidate lines is left alone', rp.length === 0, rp);
  rp = T.relinkPlan(NEW, [row({ id: 'free', source: 'manual', bid_item_id: null, cost_code: 'Stormwater', sub_code: 'Geofabric' })], CK);
  assert('a hand-added row never tied to a line is not tied to one now', rp.length === 0, rp);
  rp = T.relinkPlan(NEW, [row({ id: 'md', source: 'manual', bid_item_id: 'old1', cost_code: 'Stormwater', sub_code: 'Geofabric', deleted_at: 'x' })], CK);
  assert('a deleted hand-added row is left alone', rp.length === 0, rp);
  rp = T.relinkPlan(NEW, [row({ id: 'ok', source: 'bid', bid_item_id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric' })], CK);
  assert('a row already on a current line is untouched', rp.length === 0);
  rp = T.relinkPlan(NEW, [row({ id: 'dash', source: 'bid', bid_item_id: 'x', cost_code: 'E–S'.replace('–', '&'), sub_code: 'Silt  Sock 12INCH' })], CK);
  assert('codes match through _codeKey (spacing, case)', rp.length === 1 && rp[0].bid_item_id === 'n2', rp);
  rp = T.relinkPlan(NEW, [row({ id: 'blank', source: 'bid', bid_item_id: 'x' })], CK);
  assert('an orphan with no codes is left alone', rp.length === 0);

  // ── sortRows ──────────────────────────────────────────────────────────
  console.log('\n[sortRows]');
  const sorted = T.sortRows([
    row({ id: 'unknown', source: 'manual', created_at: '2026-01-01T00:00:00Z' }),
    row({ id: 'm1-late', source: 'manual', bid_item_id: 'b1', created_at: '2026-03-05T00:00:00Z' }),
    row({ id: 'b3-bid', source: 'bid', bid_item_id: 'b3', created_at: '2026-03-01T00:00:00Z' }),
    row({ id: 'm1-early', source: 'manual', bid_item_id: 'b1', created_at: '2026-03-02T00:00:00Z' }),
    row({ id: 'b1-bid', source: 'bid', bid_item_id: 'b1', created_at: '2026-03-09T00:00:00Z' }),
    row({ id: 'orphan', source: 'bid', bid_item_id: 'gone', created_at: '2026-02-01T00:00:00Z' }),
  ], C()).map(r => r.id);
  assert('bid order, the bid row first, then materials oldest first, unknown lines last',
    eq(sorted, ['b1-bid', 'm1-early', 'm1-late', 'b3-bid', 'orphan', 'unknown']), sorted);
  assert('does not reorder the array it was given', (() => { const a = [row({ id: 'z', bid_item_id: 'b3' }), row({ id: 'a', bid_item_id: 'b1' })]; T.sortRows(a, C()); return a[0].id === 'z'; })());

  // ── applyFilters ──────────────────────────────────────────────────────
  console.log('\n[applyFilters]');
  const FR = [
    row({ id: 'f1', source: 'bid', bid_item_id: 'b1', vendor: 'Acme Supply', description: 'Mirafi 140N', date_needed: '2026-03-20' }),        // auto PO-0001: Ordered
    row({ id: 'f2', source: 'bid', bid_item_id: 'b2', vendor: 'LB Water', quote_number: 'QT2242818', date_needed: '2026-03-08' }),         // Not ordered, late
    row({ id: 'f3', source: 'manual', bid_item_id: 'b2', vendor: 'LB Water', sca_status: 'Needed', date_needed: '2026-03-15' }),          // due soon, sca open
    row({ id: 'f4', source: 'bid', bid_item_id: 'b6', date_delivered: '2026-03-05', contact: 'Sales' }),                                   // Delivered
    row({ id: 'f5', source: 'manual', cost_code: 'X', sub_code: 'Y', date_ordered: '2026-03-01', date_needed: '2026-03-12' }),            // ordered, needed soon
  ];
  const ids = (state) => T.applyFilters(FR, state, C()).map(r => r.id).join(',');
  assert('no filters -> everything', ids({}) === 'f1,f2,f3,f4,f5');
  assert('search finds a vendor', ids({ search: 'acme' }) === 'f1');
  assert('search finds a PO number shown in the PO cell', ids({ search: 'po-0001' }) === 'f1');
  assert('search finds a description', ids({ search: 'mirafi' }) === 'f1');
  assert('search finds a quote #', ids({ search: 'qt2242' }) === 'f2');
  assert('search finds a sub code from the bid', ids({ search: 'perf drain' }) === 'f2,f3');
  assert('every word has to match', ids({ search: 'lb water needed' }) === 'f3' && ids({ search: 'qt2242 acme' }) === '');
  assert('search reads the flag labels too', ids({ search: 'water sub agreement' }) === 'f3');
  assert('search reads the flags', ids({ search: 'late' }) === 'f2');
  assert('search reads displayed dates', ids({ search: '03/20' }) === 'f1');
  assert('column filter: vendor', ids({ filters: { vendor: new Set(['LB Water']) } }) === 'f2,f3');
  assert('column filter: (blank) vendor', ids({ filters: { vendor: new Set(['']) } }) === 'f4,f5');
  assert('column filter: status', ids({ filters: { status: new Set(['Ordered', 'Delivered']) } }) === 'f1,f4,f5');
  assert('column filter: PO # as shown', ids({ filters: { po: new Set(['PO-0001']) } }) === 'f1');
  assert('column filter: SCA', ids({ filters: { sca_status: ['Needed'] } }) === 'f3');
  assert('column filter: sub code (live)', ids({ filters: { sub_code: new Set(['Geofabric']) } }) === 'f1');
  assert('filters combine with search', ids({ search: 'water', filters: { status: new Set(['Not Ordered']) } }) === 'f2,f3');
  assert('an empty filter set filters nothing', ids({ filters: { vendor: new Set() } }) === 'f1,f2,f3,f4,f5');
  assert('chip: Not ordered', ids({ chip: 'not_ordered' }) === 'f2,f3');
  assert('chip: Due in 14 days (not ordered by key date, ordered by needed date)', ids({ chip: 'due14' }) === 'f1,f3,f5', ids({ chip: 'due14' }));
  assert('chip: Late', ids({ chip: 'late' }) === 'f2');
  assert('chip: Sub agreement open', ids({ chip: 'sca_open' }) === 'f3');
  assert('chip: Not delivered', ids({ chip: 'not_delivered' }) === 'f1,f2,f3,f5');
  assert('chip + search', ids({ chip: 'not_ordered', search: 'lb' }) === 'f2,f3');

  // ── csvEscape ─────────────────────────────────────────────────────────
  console.log('\n[csvEscape]');
  assert('plain text is quoted', T.csvEscape('Geofabric') === '"Geofabric"');
  assert('quotes are doubled', T.csvEscape('15" Perf') === '"15"" Perf"');
  assert('= is defused', T.csvEscape('=HYPERLINK("x")') === '"\'=HYPERLINK(""x"")"');
  assert('+ is defused', T.csvEscape('+1 555 0100') === '"\'+1 555 0100"');
  assert('@ is defused', T.csvEscape('@SUM(A1)') === '"\'@SUM(A1)"');
  assert('- text is defused', T.csvEscape('-foo') === '"\'-foo"');
  assert('a negative number is NOT defused', T.csvEscape('-5') === '"-5"' && T.csvEscape('-5.25') === '"-5.25"');
  assert('a tab-led value is defused', T.csvEscape('\tx') === '"\'\tx"');
  assert('null -> empty field', T.csvEscape(null) === '""' && T.csvEscape(undefined) === '""');
  assert('numbers stay numbers', T.csvEscape(8110) === '"8110"');

  // ── cbOptions / cbFilter ──────────────────────────────────────────────
  console.log('\n[combobox lists]');
  {
    const env = makeEnv({ rows: [row({ id: 'r1', source: 'bid', bid_item_id: 'b1', vendor: 'Acme Supply' })],
      contacts: [{ id: 'c1', supplier_name: 'ACME supply', name: 'Dana', email: 'dana@acme.test', phone: '' },
                 { id: 'c2', supplier_name: 'LB Water', name: '', email: 'sales@lb.test', phone: '555' }] });
    const P = env.P;
    let o = P.cbOptions('proc_projects');
    assert('jobs: live ones only, with Job # as the note', eq(o.map(x => x.value), ['p3', 'p1']) && o.find(x => x.value === 'p1').meta === 'Job #2614', o);
    env.P.renderTab(env.root);
    await tick(); await tick();
    env.$('#fctproc-showall').checked = true;
    env.fire(env.$('#fctproc-showall'), 'change');
    o = P.cbOptions('proc_projects');
    assert('"Show all jobs" lists the rest, and is remembered', o.length === 3 && env.store.fct_proc_showall_turf === '1');
    assert('jobs filter on the job number too', eq(P.cbFilter('proc_projects', '2588', o).map(x => x.value), ['p2']));
    o = P.cbOptions('proc_vendors');
    assert('vendors: the supplier list, sorted', eq(o, ['Acme Supply', 'Beta Corp', 'LB Water']), o);
    const part = P.cbFilter('proc_vendors', 'acme', o);
    assert('typing part of a supplier lists it first, "+ Add" for the typed text after',
      part[0] === 'Acme Supply' && part.length === 2 && part[1].value === '__new__:acme', part);
    assert('typing a supplier in other case offers no "+ Add"', P.cbFilter('proc_vendors', 'ACME SUPPLY', o).every(x => typeof x === 'string'));
    const add = P.cbFilter('proc_vendors', ' Zed Co ', o);
    assert('a new name -> "+ Add" appended last', eq(add[add.length - 1],
      { value: '__new__:Zed Co', label: '+ Add "Zed Co" as new supplier', meta: 'new', metaCls: 'new' }), add);
    assert('an empty box offers no "+ Add"', P.cbFilter('proc_vendors', '  ', o).length === 3);
    o = P.cbOptions('proc_units');
    assert('units: the bid unit list', o.includes('LF') && o.includes('TON') && o.includes('LS') && !o.includes(''));
    o = P.cbOptions('proc_codes:p1');
    assert('codes: the job\'s bid lines, value = bid line id, "Cost / Sub"',
      o[0].value === 'b1' && o[0].label === 'Stormwater / Geofabric' && /SF/.test(o[0].meta), o[0]);
    o = P.cbOptions('proc_pos:r1');
    assert('POs: Auto, No PO, then this job\'s POs only',
      o[0].value === '__auto__' && o[1].value === '__none__' && eq(o.slice(2).map(x => x.value).sort(), ['po1', 'po3']), o.map(x => x.value));
    assert('Auto says which PO it is matching', /PO-0001/.test(o[0].meta), o[0]);
    assert('each PO carries supplier and codes', /Acme Supply/.test(o.find(x => x.value === 'po1').meta));
    o = P.cbOptions('proc_contacts:r1');
    assert("contacts: the row vendor's contacts, matched case-insensitively", o.length === 1 && o[0].value === 'c1' && o[0].label === 'Dana' && o[0].meta === 'dana@acme.test', o);
    assert('an unknown key gives nothing', P.cbOptions('proc_nope').length === 0 && P.cbOptions('proc_pos:missing').length === 0);
  }

  // ── Render: editor ────────────────────────────────────────────────────
  console.log('\n[render — editor]');
  const EROWS = [
    row({ id: 'r1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: 8110, unit: 'SF',
      bid_qty_at_send: 8110, bid_unit_at_send: 'SF', vendor: 'Acme Supply', date_needed: '2026-03-20', created_at: '2026-03-01T00:00:00Z' }),
    row({ id: 'r2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', quantity: 901, unit: 'LF',
      bid_qty_at_send: 901, bid_unit_at_send: 'LF', vendor: 'LB Water', quote_number: 'QT1', date_needed: '2026-03-08',
      description: '<img src=x onerror="window.__xss=1">', created_at: '2026-03-01T00:00:01Z' }),
    row({ id: 'r3', source: 'manual', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', description: 'Elbows 15"',
      vendor: 'LB Water', quote_number: 'QT1', sca_status: 'Needed', created_at: '2026-03-02T00:00:00Z' }),
    row({ id: 'r4', source: 'bid', bid_item_id: 'gone', cost_code: 'E&S', sub_code: 'Old line', vendor: '"><script>window.__xss=2</script>',
      po_id: 'deleted-po', created_at: '2026-03-03T00:00:00Z' }),
  ];
  const env = makeEnv({ rows: EROWS,
    contacts: [{ id: 'c1', supplier_name: 'Acme Supply', name: 'Dana', email: 'dana@acme.test', phone: '' }] });
  env.P.renderTab(env.root);
  await tick(); await tick(); await tick();
  const get = env.calls.find(c => c.method === 'GET' && c.path === '/api/procurement');
  assert('reads the remembered job\'s rows with the division', get && get.q.division === 'turf' && get.q.project_id === 'p1' && !get.q.include_deleted, get);
  assert('sends the bearer token', get && get.auth === 'Bearer tok');
  assert('loads the supplier contacts once', env.calls.filter(c => c.path === '/api/supplier-contacts').length === 1);
  assert('header shows the job name and Job #', /Penn Cambria Field/.test(env.$('.fctproc-head').textContent) && /Job #2614/.test(env.$('.fctproc-head').textContent));
  assert('the job picker is the page combobox, proc_projects', env.cbCalls.some(c => c.listKey === 'proc_projects' && c.value === 'Penn Cambria Field'));
  assert('the picker carries the job id as its resolved value', env.$('#fctproc-proj').dataset.cbValue === 'p1');
  assert('one table row per procurement row', env.$$('tr.fctproc-row').length === 4);
  assert('grouped by cost code by default: green group rows', env.$$('tr.fctproc-grp').length === 2
    && /Stormwater/.test(env.$$('tr.fctproc-grp')[0].textContent) && /3 rows/.test(env.$$('tr.fctproc-grp')[0].textContent),
    env.$$('tr.fctproc-grp').map(t => t.textContent.replace(/\s+/g, ' ')));
  assert('rows in bid order (bid row, then its material, orphan last)', eq(env.$$('tr.fctproc-row').map(t => t.dataset.row), ['r1', 'r2', 'r3', 'r4']));
  const headers = env.$$('.fctproc-table th').map(th => th.dataset.label || '');
  // The paperclip (attached documents) rides in the Status cell, so it adds
  // no column: the sheet is exactly as wide as it was before attachments.
  assert('columns in the agreed order — fields that belong together sharing a column', eq(headers, ['', 'Status', 'PO #', 'Date Needed',
    'Lead Time · Order By · Ordered · Delivered', 'Quantity', 'Unit', 'Material', 'Cost Code / Sub Code', 'Vendor / Quote #', 'Contact / Email', '']), headers);
  {
    const fbs = th => [...th.querySelectorAll('[data-pff]')].map(b => b.dataset.pff);
    const sh = env.$('th.c-status'), vh = env.$('th.c-supplier'), kh = env.$('th.c-contact_email');
    assert('  Status keeps its filter and adds the Sub-Contractor Agreement\'s, still pinned left', eq(fbs(sh), ['status', 'sca_status'])
      && sh.classList.contains('stk') && /Sub-Contractor Agreement/.test(sh.querySelector('[data-pff="sca_status"]').closest('.fctproc-hp').title));
    assert('  Vendor over Quote #, and Contact over Email, each with its filter', eq(fbs(vh), ['vendor', 'quote_number']) && eq(fbs(kh), ['contact', 'email'])
      && !!vh.querySelector('.fctproc-stack') && !!kh.querySelector('.fctproc-stack'));
    const sup = env.$('tr[data-row="r1"] td.c-supplier'), con = env.$('tr[data-row="r1"] td.c-contact_email');
    assert('  a row\'s Vendor sits over its Quote #, its Contact over its Email — the same boxes as before',
      sup.querySelector('.fctproc-stack > .c-vendor [data-pf="vendor"]') === env.field('r1', 'vendor')
      && sup.querySelector('.fctproc-stack > .c-quote_number [data-pf="quote_number"]') === env.field('r1', 'quote_number')
      && con.querySelector('.fctproc-stack > .c-contact [data-pf="contact"]') === env.field('r1', 'contact')
      && con.querySelector('.fctproc-stack > .c-email [data-pf="email"]') === env.field('r1', 'email')
      && env.field('r1', 'quote_number').placeholder === 'Quote #' && env.field('r1', 'email').getAttribute('aria-label') === 'Email');
    const stc = env.$('tr[data-row="r1"] td.c-status');
    assert('  the Status cell: the pill, then the agreement tag (a picker under it), then the flags', !!stc.querySelector('.fctproc-statusbox > .c-pill .fctproc-pill')
      && stc.querySelector('.fctproc-statusbox > .c-sca_status [data-pf="sca_status"]') === env.field('r1', 'sca_status')
      && stc.querySelector('.c-sca_status .fctproc-scatag').textContent === 'Agmt pending' && !!stc.querySelector('.fctproc-statusbox > .c-flags'));
  }
  {
    const oh = env.$('th.c-ordering'), ch = env.$('th.c-codes');
    const fbs = th => [...th.querySelectorAll('[data-pff]')].map(b => b.dataset.pff);
    assert('  the ordering header names its four fields 2 × 2, each with its own filter', !!oh.querySelector('.fctproc-grid2')
      && eq(fbs(oh), ['lead_time_days', 'order_by', 'date_ordered', 'date_delivered'])
      && eq([...oh.querySelectorAll('.fctproc-hp')].map(h => h.textContent.replace('▼', '').trim()), ['Lead Time', 'Order By', 'Ordered', 'Delivered']), fbs(oh));
    assert('  the codes header names both, with a filter each, a slash between', eq(fbs(ch), ['cost_code', 'sub_code'])
      && /Cost Code\s*▼\s*\/\s*Sub Code/.test(ch.textContent) && /books to/.test(ch.querySelector('[data-pff="sub_code"]').closest('.fctproc-hp').title));
    const ord = env.$('tr[data-row="r1"] td.c-ordering');
    assert('  a row\'s ordering cell holds its four fields, 2 × 2', !!ord && !!ord.querySelector('.fctproc-grid2')
      && eq([...ord.querySelectorAll('.fctproc-part')].map(p => p.className.replace('fctproc-part ', '')), ['c-lead_time_days', 'c-order_by', 'c-date_ordered', 'c-date_delivered'])
      && ord.querySelector('.c-lead_time_days [data-pf="lead_time_days"]') === env.field('r1', 'lead_time_days')
      && ord.querySelector('.c-date_ordered [data-pf="date_ordered"]') === env.field('r1', 'date_ordered')
      && ord.querySelector('.c-date_delivered [data-pf="date_delivered"]') === env.field('r1', 'date_delivered'));
    assert('  …each box saying what it is (no room for labels)', env.field('r1', 'lead_time_days').getAttribute('aria-label') === 'Lead Time (days)'
      && env.field('r1', 'date_ordered').getAttribute('aria-label') === 'Date Ordered' && env.field('r1', 'date_delivered').getAttribute('aria-label') === 'Date Delivered'
      && /^Order By/.test(ord.querySelector('.c-order_by .fctproc-txt').title));
    const cc = env.$('tr[data-row="r1"] td.c-codes');
    assert('  a bid row\'s codes read "Stormwater / Geofabric", the cost code muted', cc.querySelector('.fctproc-cc').textContent === 'Stormwater'
      && cc.querySelector('.fctproc-sc').textContent === 'Geofabric' && /Stormwater\s*\/\s*Geofabric/.test(cc.textContent) && cc.querySelector('.fctproc-codes').title === 'Stormwater / Geofabric');
    const hc = env.$('tr[data-row="r3"] td.c-codes');
    assert('  a hand-added row picks its line in the sub code\'s place, its cost code beside it', hc.querySelector('.fctproc-cc').textContent === 'Stormwater'
      && hc.querySelector('.c-sub_code [data-pf="codes"]') === env.field('r3', 'codes') && env.field('r3', 'codes').getAttribute('aria-label') === 'Sub Code');
  }
  assert('  no paperclip column', !env.$$('.fctproc-table th').some(th => /\u{1F4CE}/u.test(th.textContent) || th.title === 'Attached documents')
    && !env.$('td.c-files'));
  assert('select + Status columns are pinned left', env.$('th.c-sel').classList.contains('stk') && env.$$('.fctproc-table th')[1].classList.contains('stk'));
  assert('a checkbox per row and a select-all', env.$$('[data-sel]').length === 4 && !!env.$('#fctproc-selall'));
  assert('Send to Procurement and + Add Row for editors', !!env.$('[data-act="send"]') && !!env.$('[data-act="add"]'));
  assert('Excel and CSV export', !!env.$('[data-act="xlsx"]') && !!env.$('[data-act="csv"]'));
  const tr1 = env.$('tr[data-row="r1"]'), tr2 = env.$('tr[data-row="r2"]'), tr3 = env.$('tr[data-row="r3"]'), tr4 = env.$('tr[data-row="r4"]');
  assert('auto-matched PO shows its number with an "auto" tag', env.field('r1', 'po').value === 'PO-0001' && /auto/.test(tr1.querySelector('.c-po').textContent));
  assert('the PO has a button that opens it', !!tr1.querySelector('[data-act="open-po"][data-po="po1"]'));
  tr1.querySelector('[data-act="open-po"]').click();
  assert('clicking it calls cfg.openPurchaseOrder', env.created.some(c => c[0] === 'open' && c[1] === 'po1'));
  assert('auto PO -> Ordered (blue pill)', tr1.querySelector('.fctproc-pill').textContent === 'Ordered' && tr1.querySelector('.fctproc-pill').classList.contains('st-ord'));
  assert("derived Date Ordered shows the PO's date, muted", env.field('r1', 'date_ordered').value === '2026-03-01' && env.field('r1', 'date_ordered').classList.contains('derived'));
  assert('not ordered + needed yesterday -> Late (red edge)', /Late/.test(tr2.querySelector('.c-status').textContent) && tr2.querySelector('.c-status').classList.contains('flag-red'));
  // Shown short so the Status column stays narrow; the whole wording is its tooltip, and the export's.
  assert('SCA Needed -> the Status cell\'s agreement tag reads "Agmt needed", amber, and the cell has an amber edge',
    tr3.querySelector('.c-status .fctproc-scatag').textContent === 'Agmt needed' && tr3.querySelector('.c-status .fctproc-scatag').classList.contains('sca-Needed')
    && tr3.querySelector('.c-status').classList.contains('flag-amber'));
  assert('  …said once: no "Sub agmt open" flag beside it, and the whole wording as its tooltip',
    !/Sub agmt open/.test(tr3.querySelector('.c-status .c-flags').textContent) && tr3.querySelector('.c-status .fctproc-scawrap').title === 'Sub-Contractor Agreement: Needed');
  assert('bid changed badge with its two actions', /bid 901 → 950 LF/.test(tr2.querySelector('.c-quantity').textContent)
    && !!tr2.querySelector('[data-act="use-bid"]') && !!tr2.querySelector('[data-act="dismiss-bid"]'));
  assert('a bid row whose line is gone is badged "not on bid"', /not on bid/.test(tr4.querySelector('.c-codes').textContent));
  assert('a linked PO that was deleted shows "PO removed" in red', tr4.querySelector('.c-po').classList.contains('po-removed')
    && env.field('r4', 'po').placeholder === 'PO removed');
  assert('bid rows show their codes read-only', !env.field('r1', 'codes') && /Geofabric/.test(tr1.querySelector('.c-sub_code').textContent));
  assert('hand-added rows pick their codes from the bid (proc_codes:p1)', !!env.field('r3', 'codes')
    && env.cbCalls.some(c => c.listKey === 'proc_codes:p1') && env.field('r3', 'codes').dataset.cbValue === 'b2');
  const tableCbs = env.cbCalls.filter(c => c.listKey !== 'proc_projects');
  assert('every combobox in the table asks for a fixed menu', tableCbs.length > 0 && tableCbs.every(c => c.wrap === 'data-cb-fixed="1"'));
  for (const k of ['proc_vendors', 'proc_units', 'proc_contacts:r1', 'proc_pos:r1'])
    assert(`renders a ${k} combobox`, env.cbCalls.some(c => c.listKey === k));
  assert('SCA is a select with the four values', eq([...env.field('r1', 'sca_status').options].map(o => o.value), ['Pending', 'Needed', 'Not Needed', 'Executed']));
  assert('dates are date inputs', env.field('r1', 'date_needed').type === 'date' && env.field('r1', 'date_needed').value === '2026-03-20');
  assert('lead time and quantity are number inputs', env.field('r1', 'lead_time_days').type === 'number' && env.field('r1', 'quantity').value === '8110');
  assert('email is a plain text box (a phone number is allowed)', env.field('r1', 'email').type === 'text');
  assert('typed HTML is shown as text, never run', env.w.__xss === undefined && !env.$('#root img') && !env.$('#root script')
    && env.field('r2', 'description').value === '<img src=x onerror="window.__xss=1">');
  assert('header counts per status', /Not Ordered\s*3/.test(env.$('#fctproc-counts').textContent) && /Ordered\s*1/.test(env.$('#fctproc-counts').textContent.replace('Not Ordered', ''))
    && /Delivered\s*0/.test(env.$('#fctproc-counts').textContent) && /Late\s*1/.test(env.$('#fctproc-counts').textContent),
    env.$('#fctproc-counts').textContent.replace(/\s+/g, ' '));
  assert('chips with counts', env.$$('[data-chip]').length === 6 && /Late\s*1/.test(env.$('[data-chip="late"]').textContent));

  // ── Saving ────────────────────────────────────────────────────────────
  console.log('\n[saving]');
  // Email is a plain text box: saved as typed, after a quiet spell.
  let d = env.field('r1', 'email');
  d.focus();
  d.value = 'orders@acme';
  env.fire(d, 'input');
  await sleep(200);
  assert('nothing is sent while typing', env.patches().length === 0);
  d.value = 'orders@acme.test';
  env.fire(d, 'input');
  const q2 = env.field('r1', 'quote_number');
  q2.value = 'Q-55';
  env.fire(q2, 'input');
  await sleep(750);
  let ps = env.patches();
  assert('after 600 ms of quiet: one PATCH for the row', ps.length === 1 && ps[0].q.id === 'r1' && ps[0].q.division === 'turf', ps.map(p => p.q));
  assert('carrying only the two changed fields, with what was in them when the editing began (both blank)',
    ps[0] && eq(ps[0].body, { fields: { email: 'orders@acme.test', quote_number: 'Q-55' }, expect: { email: '', quote_number: '' } }), ps[0] && ps[0].body);
  assert('the save indicator says Saved', /Saved/.test(env.$('#fctproc-save').textContent));
  assert('the box being typed in was not redrawn (focus kept)', env.w.document.activeElement === d && d.isConnected);
  d.value = 'orders@acme.test';
  env.fire(d, 'input');
  await sleep(700);
  assert('an unchanged value is never sent', env.patches().length === 1);
  d.value = 'temp';
  env.fire(d, 'input');
  d.value = 'orders@acme.test';
  env.fire(d, 'input');
  await sleep(700);
  assert('typing and undoing within the quiet spell sends nothing', env.patches().length === 1);
  d.blur();

  // Material is the page's combobox: named when it commits (Enter, Tab, a
  // pick or leaving the box), not on every key.
  const mat = env.field('r1', 'description');
  assert('Material is a proc_materials picker, blank showing the bid\'s Sub Code', mat.classList.contains('cb-input')
    && env.cbCalls.some(c => c.listKey === 'proc_materials:r1') && mat.value === '' && mat.placeholder === 'Geofabric', [mat.value, mat.placeholder]);
  mat.focus();
  mat.value = 'Mirafi 140N, 15 ft';
  env.fire(mat, 'input');
  await sleep(700);
  assert('…typing in it sends nothing yet', env.patches().length === 1);
  env.pick(mat, 'Mirafi 140N, 15 ft rolls', '__typed__');
  mat.blur();
  await sleep(700);
  ps = env.patches();
  assert('…its commit saves the name as typed, alone', ps.length === 2 && eq(ps[1].body.fields, { description: 'Mirafi 140N, 15 ft rolls' }), ps.map(p => p.body));

  // A failed save keeps the value and is retried with the next edit.
  env.db.failPatch = 1;
  const v = env.field('r2', 'quote_number');
  v.value = 'QT-FAIL';
  env.fire(v, 'input');
  env.fire(v, 'change');            // blur commits at once
  await sleep(50);
  assert('a failed save calls cfg.showSaveError', env.errors.length === 1 && /could not be saved/.test(env.errors[0]), env.errors);
  assert('the indicator says Not saved', /Not saved/.test(env.$('#fctproc-save').textContent));
  assert('the typed value is kept on screen', env.field('r2', 'quote_number').value === 'QT-FAIL');
  const desc2 = env.field('r2', 'email');
  desc2.value = 'perf@pipe.test';
  env.fire(desc2, 'input');
  env.fire(desc2, 'change');
  await sleep(50);
  ps = env.patches();
  const retry = ps[ps.length - 1];
  assert('the next edit retries the failed field with it', retry.q.id === 'r2' && eq(retry.body.fields, { quote_number: 'QT-FAIL', email: 'perf@pipe.test' }), retry.body);
  assert('and the server now has both', env.db.rows.find(r => r.id === 'r2').quote_number === 'QT-FAIL');

  // Dates and selects redraw the derived cells.
  const dn = env.field('r3', 'date_needed');
  dn.value = '2026-03-01';
  env.fire(dn, 'change');
  assert('a date edit redraws status and flags at once', /Late/.test(env.$('tr[data-row="r3"] .c-status').textContent));
  const lt = env.field('r1', 'lead_time_days');
  lt.focus();
  lt.value = '15';
  env.fire(lt, 'input');
  assert('Order By follows the lead time as it is typed', env.$('tr[data-row="r1"] .c-order_by').textContent.trim() === '03/05/2026', env.$('tr[data-row="r1"] .c-order_by').textContent);
  assert('…without replacing the box being typed in', env.w.document.activeElement === lt && lt.isConnected);
  lt.blur();
  env.fire(lt, 'change');
  const sca = env.field('r1', 'sca_status');
  sca.value = 'Executed';
  env.fire(sca, 'change');
  await sleep(700);
  const r1Fields = Object.assign({}, ...env.patches().filter(p => p.q.id === 'r1').map(p => p.body.fields));
  assert('lead time saves as a number, SCA as its value', r1Fields.lead_time_days === 15 && r1Fields.sca_status === 'Executed', r1Fields);
  assert('the number box sent on its change (blur) without waiting', env.patches().some(p => p.q.id === 'r1' && eq(p.body.fields, { lead_time_days: 15 })));
  const r3d = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('a date saves as YYYY-MM-DD', r3d && r3d.body.fields.date_needed === '2026-03-01', r3d && r3d.body);

  // Use bid qty / Dismiss
  env.$('tr[data-row="r2"] [data-act="use-bid"]').click();
  await sleep(50);
  const ub = env.patches().filter(p => p.q.id === 'r2').pop();
  assert('"Use bid qty" sends the quantity and the new baseline (unit unchanged, so not sent)',
    eq(ub.body.fields, { bid_qty_at_send: 950, quantity: 950 }), ub.body);
  assert('…and the badge goes', !/bid 901/.test(env.$('tr[data-row="r2"] .c-quantity').textContent));

  // ── Combobox commits ──────────────────────────────────────────────────
  console.log('\n[combobox commits]');
  let po = env.field('r3', 'po');
  env.pick(po, 'No PO', '__none__');
  await sleep(700);
  let pr3 = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('PO picker: "No PO" -> po_id null, po_auto false', pr3 && pr3.body.fields.po_id === undefined && pr3.body.fields.po_auto === false, pr3 && pr3.body);
  po = env.field('r3', 'po');
  env.pick(po, 'PO-0003', 'po3');
  await sleep(700);
  pr3 = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('PO picker: a PO -> its id is stored, never its number', pr3.body.fields.po_id === 'po3' && !JSON.stringify(pr3.body).includes('PO-0003'), pr3.body);
  await sleep(250);
  assert('the cell then shows that PO\'s number', env.field('r3', 'po').value === 'PO-0003');
  po = env.field('r3', 'po');
  env.pick(po, 'nonsense', null);
  await sleep(700);
  assert('text matching no PO changes nothing', env.patches().filter(p => p.q.id === 'r3').pop().body.fields.po_id === 'po3'
    && env.db.rows.find(r => r.id === 'r3').po_id === 'po3');
  po = env.field('r3', 'po');
  env.pick(po, 'Auto', '__auto__');
  await sleep(700);
  pr3 = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('PO picker: Auto -> back to matching (po_auto already true, so only po_id is sent)',
    eq(pr3.body.fields, { po_id: null }) && env.db.rows.find(r => r.id === 'r3').po_auto === true, pr3.body);

  let ven = env.field('r3', 'vendor');
  env.pick(ven, '+ Add "Zed Co" as new supplier', '__new__:Zed Co');
  await sleep(700);
  assert('"+ Add" calls cfg.addSupplier with the typed name', env.created.some(c => c[0] === 'supplier' && c[1] === 'Zed Co'));
  pr3 = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('…and sets the vendor to it', pr3.body.fields.vendor === 'Zed Co', pr3.body);
  ven = env.field('r3', 'vendor');
  env.pick(ven, 'acme supply', null);
  await sleep(700);
  pr3 = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('a typed supplier in the wrong case takes the list\'s spelling', pr3.body.fields.vendor === 'Acme Supply', pr3.body);
  const ct = env.field('r3', 'contact');
  env.pick(ct, 'Dana', 'c1');
  await sleep(700);
  pr3 = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('picking a saved contact fills Contact AND Email', pr3.body.fields.contact === 'Dana' && pr3.body.fields.email === 'dana@acme.test', pr3.body);
  const codes = env.field('r3', 'codes');
  env.pick(codes, 'E&S / Silt Sock 12inch', 'b3');
  await sleep(700);
  pr3 = env.patches().filter(p => p.q.id === 'r3').pop();
  assert('picking a bid line sets bid_item_id and both codes, and the blank Quantity and Unit from the line',
    eq(pr3.body.fields, { bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', unit: 'LF', quantity: 1200 }), pr3.body);
  const un = env.field('r3', 'unit');
  env.pick(un, 'lf', null);
  await sleep(700);
  assert('a typed unit takes the list\'s spelling', env.patches().filter(p => p.q.id === 'r3').pop().body.fields.unit === 'LF');
  env.pick(env.field('r3', 'unit'), 'roll', null);
  await sleep(700);
  assert('a unit not on the list is kept as typed', env.patches().filter(p => p.q.id === 'r3').pop().body.fields.unit === 'roll');

  // Contact typed by hand is remembered under the vendor when the row is left.
  const ct1 = env.field('r1', 'contact');
  ct1.focus();
  env.pick(ct1, 'Morgan', null);
  const em1 = env.field('r1', 'email');
  em1.focus();
  em1.value = 'morgan@acme.test';
  env.fire(em1, 'input');
  em1.blur();
  await sleep(50);
  const up = env.calls.filter(c => c.path === '/api/supplier-contacts' && c.method === 'POST').pop();
  assert('a new contact typed on a row is saved under its vendor', up && eq(up.body, { supplier_name: 'Acme Supply', name: 'Morgan', email: 'morgan@acme.test', phone: '' }), up && up.body);
  const n0 = env.calls.filter(c => c.path === '/api/supplier-contacts' && c.method === 'POST').length;
  env.field('r1', 'email').focus();
  env.field('r1', 'email').blur();
  await sleep(50);
  assert('…once, not every time the row is left', env.calls.filter(c => c.path === '/api/supplier-contacts' && c.method === 'POST').length === n0);
  await sleep(700);

  // ── + Material, delete ────────────────────────────────────────────────
  console.log('\n[row actions]');
  env.$('tr[data-row="r1"] [data-act="material"]').click();
  await sleep(30);
  const post = env.calls.filter(c => c.method === 'POST' && c.path === '/api/procurement' && !c.q.action).pop();
  assert('+ Material POSTs a manual row under the same bid line', post && post.body.item.bid_item_id === 'b1' && post.body.item.cost_code === 'Stormwater'
    && post.body.item.sub_code === 'Geofabric' && post.body.item.unit === 'SF' && post.body.item.project_id === 'p1' && /^[A-Za-z0-9_-]{1,64}$/.test(post.body.item.id), post && post.body);
  const newId = post.body.item.id;
  const order = env.$$('tr.fctproc-row').map(t => t.dataset.row);
  assert('the new row sits in its bid line\'s block', order.indexOf(newId) === order.indexOf('r1') + 1, order);
  assert('and its Material has focus, to name it', env.w.document.activeElement === env.field(newId, 'description'));
  env.field(newId, 'description').blur();
  env.$(`tr[data-row="${newId}"] [data-act="del"]`).click();
  assert('✕ asks first, inline', /Delete\?/.test(env.$(`tr[data-row="${newId}"] .c-actions`).textContent));
  env.$(`tr[data-row="${newId}"] [data-act="del-no"]`).click();
  assert('"No" puts the buttons back', !!env.$(`tr[data-row="${newId}"] [data-act="material"]`));
  env.$(`tr[data-row="${newId}"] [data-act="del"]`).click();
  env.$(`tr[data-row="${newId}"] [data-act="del-yes"]`).click();
  // (Material, left a moment ago, commits first — 120 ms after it is left.)
  await sleep(300);
  const del = env.calls.filter(c => c.method === 'DELETE').pop();
  assert('"Yes" deletes that one row', del && del.q.id === newId && !env.$(`tr[data-row="${newId}"]`), del && del.q);
  env.$('[data-act="add"]').click();
  await sleep(30);
  const added = env.calls.filter(c => c.method === 'POST' && c.path === '/api/procurement' && !c.q.action).pop();
  assert('+ Add Row POSTs a bare manual row for the job', added.body.item.project_id === 'p1' && !added.body.item.bid_item_id && added.body.item.id !== newId);
  env.w.document.activeElement.blur();

  // ── Filters, chips, grouping ──────────────────────────────────────────
  console.log('\n[filters]');
  const search = env.$('#fctproc-search');
  search.focus();
  search.value = 'lb water';
  env.fire(search, 'input');
  assert('search narrows the table', env.$$('tr.fctproc-row').map(t => t.dataset.row).join() === 'r2', env.$$('tr.fctproc-row').map(t => t.dataset.row));
  assert('…and the search box keeps focus', env.w.document.activeElement === env.$('#fctproc-search'));
  assert('"Clear filters" appears', !env.$('#fctproc-clear').hidden);
  env.$('#fctproc-clear').click();
  assert('Clear filters brings every row back and empties the box', env.$$('tr.fctproc-row').length === 5 && env.$('#fctproc-search').value === '');
  env.$('[data-chip="late"]').click();
  assert('the Late chip shows only late rows', env.$$('tr.fctproc-row').every(t => /Late/.test(t.querySelector('.c-status').textContent)) && env.$$('tr.fctproc-row').length >= 1);
  env.$('[data-chip="all"]').click();
  env.$('[data-pff="vendor"]').click();
  const dd = env.$('#fctproc-filter-dd');
  assert('a column filter opens the checkbox list', dd && dd.style.display === 'flex' && dd.querySelectorAll('.fctproc-ff-val').length >= 3);
  [...dd.querySelectorAll('.fctproc-ff-val')].forEach(cb => { cb.checked = cb.value === 'LB Water'; });
  dd.querySelector('[data-ff="apply"]').click();
  assert('applying it keeps only those rows', env.$$('tr.fctproc-row').map(t => t.dataset.row).join() === 'r2');
  assert('and marks the column\'s filter button', env.$('[data-pff="vendor"]').classList.contains('active'));
  env.$('[data-pff="vendor"]').click();
  env.$('#fctproc-filter-dd [data-ff="clear"]').click();
  assert('Clear on the column brings the rows back', env.$$('tr.fctproc-row').length === 5);
  env.$('[data-group="vendor"]').click();
  const vg = env.$$('tr.fctproc-grp').map(t => t.textContent.replace(/\s+/g, ' ').trim());
  assert('group by Vendor / Quote: vendor groups, "No vendor yet" last', vg.length >= 3 && /No vendor yet/.test(vg[vg.length - 1]), vg);
  assert('the vendor group header carries the quote #', vg.some(t => /LB Water/.test(t) && /QT-FAIL|QT1/.test(t)), vg);
  assert('grouping is remembered', env.store.fct_proc_group_turf === 'vendor');
  env.$$('tr.fctproc-grp')[0].click();
  assert('a group header folds its rows away', env.$$('tr.fctproc-row').length < 5);
  env.$('[data-group="none"]').click();
  assert('no grouping: no group rows', env.$$('tr.fctproc-grp').length === 0 && env.$$('tr.fctproc-row').length === 5);
  env.$('[data-group="cost"]').click();

  // ── Bulk edit ─────────────────────────────────────────────────────────
  console.log('\n[bulk edit]');
  const sel = id => { const b = env.$(`[data-sel="${id}"]`); b.checked = true; env.fire(b, 'change'); };
  sel('r2'); sel('r3');
  assert('selecting rows shows the bulk bar', /2\s*selected/.test(env.$('#fctproc-bulk').textContent));
  const bf = env.$('#fctproc-bulk-field');
  bf.value = 'quote_number';
  env.fire(bf, 'change');
  env.$('#fctproc-bulk-val').value = 'QT2242818';
  env.$('[data-act="bulk-apply"]').click();
  await sleep(50);
  const bulk = env.patches().filter(p => p.q.action === 'bulk').pop();
  assert('Apply sends one bulk PATCH, pinned to the open job', bulk && eq(bulk.body, { ids: ['r2', 'r3'], fields: { quote_number: 'QT2242818' }, project_id: 'p1' }), bulk && bulk.body);
  assert('…and the rows show it', env.field('r2', 'quote_number').value === 'QT2242818' && env.field('r3', 'quote_number').value === 'QT2242818');
  env.$('#fctproc-bulk-field').value = 'po';
  env.fire(env.$('#fctproc-bulk-field'), 'change');
  assert('PO link offers Auto, No PO and the job\'s POs', [...env.$('#fctproc-bulk-val').options].map(o => o.value).slice(0, 2).join() === '__auto__,__none__');
  env.$('#fctproc-bulk-val').value = '__none__';
  env.$('[data-act="bulk-apply"]').click();
  await sleep(50);
  assert('bulk "No PO"', eq(env.patches().filter(p => p.q.action === 'bulk').pop().body.fields, { po_id: null, po_auto: false }));
  env.$('#fctproc-bulk-field').value = 'date_needed';
  env.fire(env.$('#fctproc-bulk-field'), 'change');
  env.$('#fctproc-bulk-val').value = '2026-04-01';
  env.$('[data-act="bulk-apply"]').click();
  await sleep(50);
  assert('bulk date', eq(env.patches().filter(p => p.q.action === 'bulk').pop().body.fields, { date_needed: '2026-04-01' }));
  env.$('#fctproc-selall').checked = true;
  env.fire(env.$('#fctproc-selall'), 'change');
  assert('select-all ticks every row shown', env.$$('[data-sel]').every(b => b.checked) && /5\s*selected/.test(env.$('#fctproc-bulk').textContent));
  env.$('[data-act="bulk-clear"]').click();
  assert('Clear selection', !env.$('#fctproc-bulk').textContent.trim() && env.$$('[data-sel]').every(b => !b.checked));

  // Create PO from selected
  console.log('\n[create PO from selected]');
  sel('r2'); sel('r4');
  env.$('[data-act="bulk-po"]').click();
  await sleep(30);
  assert('two vendors -> refused with a reason, no PO made', !env.created.some(c => c[0] === 'po')
    && env.$$('.fctproc-toast').some(t => /different vendors/.test(t.textContent)));
  env.$('[data-act="bulk-clear"]').click();
  // Two LB Water rows on one sub code -> one PO, no question asked.
  env.db.rows.find(r => r.id === 'r3').bid_item_id = 'b2';
  env.P._test.state().rows.find(r => r.id === 'r3').bid_item_id = 'b2';
  env.P._test.state().rows.find(r => r.id === 'r3').vendor = 'LB Water';
  env.db.rows.find(r => r.id === 'r3').vendor = 'LB Water';
  env.P.rerender();
  sel('r2'); sel('r3');
  env.$('[data-act="bulk-po"]').click();
  await sleep(60);
  const seed = env.created.filter(c => c[0] === 'po').map(c => c[1]);
  assert('one sub code -> one PO, seeded from the rows', seed.length === 1 && seed[0].project_id === 'p1' && seed[0].cost_code === 'Stormwater'
    && seed[0].sub_code === '15" Perf drain' && seed[0].supplier === 'LB Water' && seed[0].title === 'LB Water materials' && seed[0].notes === 'Quote QT2242818', seed);
  const link = env.patches().filter(p => p.q.action === 'bulk').pop();
  assert('…and the rows are linked to its id', eq(link.body.ids, ['r2', 'r3']) && /^npo/.test(link.body.fields.po_id), link.body);
  assert('selection clears after', !env.$('#fctproc-bulk').textContent.trim());
  // Rows on two sub codes -> asked.
  // (In the stub's store too: Create PO reads the rows again before it decides.)
  ['r1', 'r4'].forEach(id => { env.P._test.state().rows.find(r => r.id === id).vendor = ''; env.db.rows.find(r => r.id === id).vendor = ''; });
  env.P.rerender();
  sel('r1'); sel('r4');
  env.$('[data-act="bulk-po"]').click();
  await sleep(30);
  // r1 is already on PO-0001 (matched automatically): asked about first.
  const onPo = env.$$('.fctproc-modal [data-choice]');
  assert('a row already on a PO -> asked before anything is created', onPo.length === 3
    && /1<\/b> of the 2 selected rows is already on <b>PO-0001/.test(env.$('.fctproc-modal [data-body]').innerHTML)
    && /Only the 1 row with no PO/.test(onPo[0].textContent) && /Create a new PO anyway, for all 2 rows/.test(onPo[1].textContent)
    && /Cancel/.test(onPo[2].textContent),
    env.$('.fctproc-modal') && env.$('.fctproc-modal').textContent.replace(/\s+/g, ' '));
  onPo[1].click();
  await sleep(30);
  const choice = env.$$('.fctproc-modal [data-choice]');
  assert('several sub codes -> asked: one per sub code / one for all / cancel', choice.length === 3
    && /One PO per sub code \(recommended/.test(choice[0].textContent) && /One PO for all, coded to/.test(choice[1].textContent));
  choice[0].click();
  await sleep(80);
  const seeds = env.created.filter(c => c[0] === 'po').map(c => c[1]);
  assert('"one per sub code" makes one PO per code', seeds.length === 3 && seeds[1].sub_code !== seeds[2].sub_code, seeds.slice(1));
  assert('a single-row PO is titled by its Material', seeds[1].title === 'Mirafi 140N, 15 ft rolls' && seeds[1].sub_code === 'Geofabric', seeds[1]);
  assert('…or, with none, by its sub code', seeds[2].title === 'Old line' && seeds[2].supplier === '' && seeds[2].notes === '', seeds[2]);

  // Bulk delete
  sel('r4');
  env.$('[data-act="bulk-del"]').click();
  assert('Delete selected asks first', /Delete 1 row\?/.test(env.$('#fctproc-bulk').textContent));
  env.$('[data-act="bulk-del-yes"]').click();
  await sleep(30);
  assert('…then deletes', env.calls.filter(c => c.method === 'DELETE').pop().q.id === 'r4' && !env.$('tr[data-row="r4"]'));

  // ── Exports ───────────────────────────────────────────────────────────
  console.log('\n[export]');
  const XR = [row({ id: 'x1', source: 'bid', bid_item_id: 'b1', quantity: 8110, unit: 'SF', contact: '=HYPERLINK("http://evil")',
    date_needed: '2026-03-20', lead_time_days: 10, description: 'Geo "fabric"' })];
  const m = T.exportMatrix(XR, C());
  assert('export columns = the table\'s, minus checkbox and buttons, then the Notes the table shows beside them', eq(m.header, ['Status', 'PO #', 'Sub-Contractor Agreement', 'Date Needed',
    'Lead Time (days)', 'Order By', 'Date Ordered', 'Date Delivered', 'Quantity', 'Unit', 'Material', 'Cost Code', 'Sub Code', 'Vendor',
    'Quote #', 'Contact', 'Email', 'Notes']), m.header);
  assert('…Material is the row\'s own name', m.rows[0][10].v === 'Geo "fabric"', m.rows[0][10]);
  {
    const NR = [
      row({ id: 'n1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', bid_qty_at_send: 901, bid_unit_at_send: 'LF',
        quantity: 901, unit: 'LF', date_needed: '2026-03-01', sca_status: 'Needed' }),
      row({ id: 'n2', source: 'bid', bid_item_id: 'gone', cost_code: 'Stormwater', sub_code: 'Inlet Type M', date_needed: '2026-03-12' }),
      row({ id: 'n3', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', bid_qty_at_send: 8110, bid_unit_at_send: 'SF', date_needed: '2026-03-09' }),
      row({ id: 'n4', source: 'manual', description: 'nothing to say' }),
    ];
    const nm = T.exportMatrix(NR, C());
    const notes = nm.rows.map(r => r[17].v), status = nm.rows.map(r => r[0].v), cc = nm.rows.map(r => r[11].v), qty = nm.rows.map(r => r[8]);
    assert('…or, with none, its Sub Code (the bid line\'s current one, else the stored copy): a coded row\'s Material is never blank',
      eq(nm.rows.map(r => r[10].v), ['15" Perf drain', 'Inlet Type M', 'Geofabric', 'nothing to say']), nm.rows.map(r => r[10].v));
    assert('Notes carries the Status flags and the "bid changed" badge', notes[0] === 'Late; Sub agreement open; Bid changed: bid 901 → 950 LF', notes[0]);
    assert('…"Not on bid" and "Due soon"', notes[1] === 'Due soon; Not on bid', notes[1]);
    assert('…"Late delivery" for an ordered row needed yesterday', notes[2] === 'Late delivery', notes[2]);
    assert('…and nothing for a row with nothing to flag', notes[3] === '', notes[3]);
    assert('…while Status, Cost Code and Quantity keep their plain values (they still filter and sum)',
      eq(status, ['Not Ordered', 'Not Ordered', 'Ordered', 'Not Ordered']) && cc[1] === 'Stormwater' && qty[0].t === 'n' && qty[0].v === 901, [status, cc, qty[0]]);
    const ncsv = T.buildCsv(NR, C()).replace(/^\uFEFF/, '').split('\r\n');
    assert('…and the CSV has it as its last column', ncsv[0].endsWith(',"Email","Notes"') && ncsv[1].endsWith('"Late; Sub agreement open; Bid changed: bid 901 → 950 LF"'), ncsv[1]);
  }
  const csv = T.buildCsv(XR, C());
  const lines = csv.replace(/^﻿/, '').split('\r\n');
  assert('CSV starts with a UTF-8 BOM', csv.charCodeAt(0) === 0xFEFF);
  assert('CSV header row', lines[0].startsWith('"Status","PO #","Sub-Contractor Agreement"'));
  assert('CSV carries the derived values (status, auto PO, order by, PO date)', lines[1].startsWith('"Ordered","PO-0001","Pending","2026-03-20","10","2026-03-10","2026-03-01",""'), lines[1]);
  assert('CSV defuses a formula typed into a cell', lines[1].includes('"\'=HYPERLINK(""http://evil"")"'), lines[1]);
  assert('CSV quantity is a plain number', lines[1].includes('"8110","SF"'));
  const parts = T.xlsxParts(XR, C());
  const sheet = parts.find(p => p.name === 'xl/worksheets/sheet1.xml').data;
  assert('XLSX: one sheet named Procurement', /<sheet name="Procurement"/.test(parts.find(p => p.name === 'xl/workbook.xml').data));
  assert('XLSX: quantity is a number cell', sheet.includes('<c r="I2"><v>8110</v></c>'), sheet.slice(0, 200));
  assert('XLSX: dates are real dates (serial + date style)', sheet.includes(`<c r="D2" s="2"><v>${Math.round(Date.UTC(2026, 2, 20) / 86400000) + 25569}</v></c>`));
  assert('XLSX: text is escaped', sheet.includes('=HYPERLINK(&quot;http://evil&quot;)') && sheet.includes('Geo &quot;fabric&quot;'));
  assert('XLSX: header row frozen and filterable', /state="frozen"/.test(sheet) && /<autoFilter ref="A1:R2"\/>/.test(sheet));
  const blob = T.buildXlsx(XR, C());
  const buf = Buffer.from(typeof blob.arrayBuffer === 'function' ? await blob.arrayBuffer()
    : await new Promise(res => { const fr = new env.w.FileReader(); fr.onload = () => res(fr.result); fr.readAsArrayBuffer(blob); }));
  assert('XLSX is a ZIP (PK header)', buf[0] === 0x50 && buf[1] === 0x4b && buf.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  env.$('[data-act="csv"]').click();
  assert('the CSV button downloads "Procurement - <job> - <date>.csv"', env.lastDownload === 'Procurement - Penn Cambria Field - 2026-03-10.csv', env.lastDownload);
  env.$('[data-act="xlsx"]').click();
  assert('the Excel button downloads the .xlsx', env.lastDownload === 'Procurement - Penn Cambria Field - 2026-03-10.xlsx' && env.lastBlob.type.includes('spreadsheetml'));

  // ── refresh / rerender ────────────────────────────────────────────────
  console.log('\n[refresh]');
  const procGets = () => env.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement').length;
  const getsBefore = procGets();
  env.field('r1', 'quote_number').focus();
  await env.P.refresh();
  assert('refresh is held while the caret is in a cell (nothing is put under a box being edited)', procGets() === getsBefore);
  env.field('r1', 'quote_number').blur();
  await sleep(20);
  assert('…and read the moment the caret leaves the cells', procGets() === getsBefore + 1);
  const selBox = env.$('[data-sel="r1"]');
  selBox.focus();
  await env.P.refresh();
  assert('a ticked row box holding the focus does not hold the refresh', procGets() === getsBefore + 2 && env.w.document.activeElement === env.$('[data-sel="r1"]'));
  env.$('#fctproc-search').focus();
  await env.P.refresh();
  assert('…nor does the search box', procGets() === getsBefore + 3);
  env.$('#fctproc-search').blur();
  env.db.rows.find(r => r.id === 'r2').vendor = 'Changed Elsewhere';
  env.db.rows.find(r => r.id === 'r2').version = 99;
  const wrap = env.$('#fctproc-wrap');
  wrap.scrollTop = 0;
  await env.P.refresh();
  assert('refresh re-reads and shows another user\'s change', env.field('r2', 'vendor').value === 'Changed Elsewhere');
  env.db.failGet = true;
  await env.P.refresh();
  assert('a failed refresh leaves the rows on screen', env.$$('tr.fctproc-row').length >= 3 && !env.$('.fctproc-err'));
  assert('…and only logs a warning', env.warns.some(w => /refresh failed/.test(w)));
  env.db.failGet = false;

  // ── Viewer ────────────────────────────────────────────────────────────
  console.log('\n[render — viewer]');
  const view = makeEnv({ perm: { canView: true, canEdit: false }, rows: EROWS });
  view.P.renderTab(view.root);
  await tick(); await tick(); await tick();
  assert('viewer sees the rows', view.$$('tr.fctproc-row').length === 4);
  assert('no checkboxes, no editable cells', view.$$('[data-sel]').length === 0 && view.$$('[data-pr]').length === 0 && !view.$('#fctproc-selall'));
  assert('no Send / Add / row buttons', !view.$('[data-act="send"]') && !view.$('[data-act="add"]') && !view.$('[data-act="material"]') && !view.$('[data-act="del"]'));
  assert('no "Use bid qty" for a viewer', !view.$('[data-act="use-bid"]') && /bid 901 → 950 LF/.test(view.$('tr[data-row="r2"] .c-quantity').textContent));
  assert('plain text values', /Acme Supply/.test(view.$('tr[data-row="r1"] .c-vendor').textContent) && /PO-0001/.test(view.$('tr[data-row="r1"] .c-po').textContent));
  assert('the PO number still opens the PO', !!view.$('tr[data-row="r1"] [data-act="open-po"]'));
  assert('Status is pinned first', view.$$('.fctproc-table th')[0].textContent.startsWith('Status') && view.$$('.fctproc-table th')[0].style.left === '0rem');
  assert('filters, grouping and export still work', !!view.$('#fctproc-search') && !!view.$('[data-group="vendor"]') && !!view.$('[data-act="xlsx"]') && !!view.$('[data-pff="status"]'));
  assert('no combobox but the job picker', view.cbCalls.every(c => c.listKey === 'proc_projects'));
  await view.P.openSendModal('p1');
  assert('a viewer cannot open Send to Procurement', !view.$('.fctproc-modal') && !view.calls.some(c => c.q.include_deleted));
  const sro = makeEnv({ perm: { canView: true, canEdit: true }, rows: EROWS, serverCanEdit: false });
  sro.P.renderTab(sro.root);
  await tick(); await tick(); await tick();
  assert('the API saying canEdit:false makes it read-only too', sro.$$('[data-pr]').length === 0 && !sro.$('[data-act="send"]'));
  const none = makeEnv({ perm: { canView: false, canEdit: false } });
  none.P.renderTab(none.root);
  assert('no view permission -> no access message, no fetch', /do not have access/.test(none.root.textContent) && !none.calls.some(c => c.path === '/api/procurement'));

  // ── Loading states ────────────────────────────────────────────────────
  console.log('\n[loading states]');
  const fresh = makeEnv({ storage: {} });
  fresh.P.renderTab(fresh.root);
  assert('nothing picked -> a prompt, no fetch', /Pick a job/.test(fresh.root.textContent) && !fresh.calls.some(c => c.path === '/api/procurement'));
  const pin = fresh.$('#fctproc-proj');
  fresh.pick(pin, 'Penn Cambria Field', 'p1');
  await tick(); await tick();
  assert('picking a job loads it and remembers it', fresh.calls.some(c => c.path === '/api/procurement' && c.q.project_id === 'p1') && fresh.store.fct_proc_project_turf === 'p1');
  fresh.pick(fresh.$('#fctproc-proj'), 'no such job', null);
  assert('text matching no job puts the current one back', fresh.$('#fctproc-proj').value === 'Penn Cambria Field' && fresh.store.fct_proc_project_turf === 'p1');
  const broken = makeEnv({ rows: EROWS });
  broken.db.failGet = true;
  broken.P.renderTab(broken.root);
  await tick(); await tick(); await tick();
  assert('a failed read shows an error, never an empty job', !!broken.$('.fctproc-err') && !broken.$('tr.fctproc-row') && !/No procurement rows/.test(broken.root.textContent));
  assert('…with no way to add rows into it', !broken.$('[data-act="add"]') && !broken.$('[data-act="send"]'));
  broken.db.failGet = false;
  broken.$('[data-act="retry"]').click();
  await tick(); await tick(); await tick();
  assert('"Try again" loads it', broken.$$('tr.fctproc-row').length === 4);
  const loading = makeEnv({ rows: EROWS, poLoaded: false });
  loading.P.renderTab(loading.root);
  await tick(); await tick(); await tick();
  assert('PO list not loaded: the PO cell says "…", not blank', loading.field('r1', 'po').placeholder === '…' && loading.field('r1', 'po').value === '');
  const emptyJob = makeEnv({ rows: [] });
  emptyJob.P.renderTab(emptyJob.root);
  await tick(); await tick(); await tick();
  assert('an empty job says so and points at Send / + Add Row', /No procurement rows for this job yet/.test(emptyJob.root.textContent));

  // ── Send to Procurement ───────────────────────────────────────────────
  console.log('\n[send to procurement]');
  const SROWS = [
    row({ id: 'have1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
    row({ id: 'skip2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', deleted_at: '2026-03-02T00:00:00Z' }),
    row({ id: 'orph3', source: 'bid', bid_item_id: 'old-b3', cost_code: 'E&S', sub_code: 'silt sock 12INCH', created_at: '2026-02-01T00:00:00Z' }),
  ];
  const s = makeEnv({ rows: SROWS });
  s.P.renderTab(s.root);
  await tick(); await tick(); await tick();
  await s.P.openSendModal('p1');
  const sget = s.calls.find(c => c.method === 'GET' && c.q.include_deleted);
  assert('reads the job\'s rows including deleted ones', sget && sget.q.include_deleted === '1' && sget.q.project_id === 'p1');
  const rel = s.patches().find(p => p.q.id === 'orph3');
  assert('re-links the orphaned row (PATCH bid_item_id + codes) — as soon as the tab read the job, before any Send',
    rel && eq(rel.body.fields, { bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }), rel && rel.body);
  const modalEl = s.$('.fctproc-modal');
  assert('the checklist opens', !!modalEl);
  const boxes = s.$$('.fctproc-modal [data-si]');
  const byLine = {};
  boxes.forEach(b => { byLine[b.closest('label').querySelector('.sub').textContent] = b; });
  assert('grouped by cost code', s.$$('.fctproc-send-h').map(h => h.firstElementChild.textContent).join('|') === 'Stormwater|E&S|General');
  assert('a line already in Procurement is greyed "already added"', byLine.Geofabric.disabled && /already added/.test(byLine.Geofabric.closest('label').textContent));
  assert('the re-linked line counts as already added', byLine['Silt Sock 12inch'].disabled);
  assert('a line whose row was deleted is unticked "removed earlier"', !byLine['15" Perf drain'].checked && !byLine['15" Perf drain'].disabled
    && /removed earlier/.test(byLine['15" Perf drain'].closest('label').textContent));
  assert('nothing starts ticked: not a new line, nor LS and HR lines', !byLine.Elbows.checked && !byLine.Mobilization.checked && !byLine.Labor.checked);
  const go = s.$('.fctproc-modal [data-send="go"]');
  assert('…so Add waits for a tick', go.disabled, go.textContent);
  assert('…and the note says so, and points at All', /nothing starts ticked/.test(s.$('.fctproc-modal').textContent) && !/start unticked/.test(s.$('.fctproc-modal').textContent));
  byLine.Elbows.checked = true;
  s.fire(byLine.Elbows, 'change');
  assert('the button counts what will be sent', go.textContent === 'Add 1 line' && !go.disabled);
  byLine['15" Perf drain'].checked = true;
  s.fire(byLine['15" Perf drain'], 'change');
  assert('ticking "removed earlier" counts it', go.textContent === 'Add 2 lines');
  s.$$('.fctproc-modal [data-sall]')[2].click();
  assert('group "All" ticks that group', byLine.Mobilization.checked && byLine.Labor.checked && go.textContent === 'Add 4 lines');
  s.$$('.fctproc-modal [data-snone]')[2].click();
  assert('group "None" unticks it', !byLine.Mobilization.checked && go.textContent === 'Add 2 lines');
  go.click();
  await sleep(30);
  const sendCall = s.calls.find(c => c.method === 'POST' && c.q.action === 'send');
  assert('POSTs action=send for the job', sendCall && sendCall.q.division === 'turf' && sendCall.body.project_id === 'p1');
  const it = sendCall && sendCall.body.items;
  assert('new lines go as items with a fresh id and the bid\'s codes, qty and unit', it && it.length === 1
    && eq({ ...it[0], id: undefined }, { id: undefined, bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 12, unit: 'EA' })
    && /^[A-Za-z0-9_-]{1,64}$/.test(it[0].id), it);
  assert('the ticked "removed earlier" line restores its row', sendCall && eq(sendCall.body.restore_ids, ['skip2']));
  assert('the modal closes', !s.$('.fctproc-modal'));
  assert('fct:procurement-sent fires with the job', s.events.length === 1 && s.events[0].projectId === 'p1', s.events);
  assert('the sent rows appear in the table', !!s.$('tr[data-row="skip2"]') && s.$$('tr.fctproc-row').length === 4);
  await s.P.openSendModal('p1');
  const again = s.$$('.fctproc-modal [data-si]');
  assert('sending again offers only what is still new', again.filter(b => !b.disabled && b.checked).length === 0
    && s.$('.fctproc-modal [data-send="go"]').disabled);
  s.$('.fctproc-modal [data-send="cancel"]').click();
  assert('Cancel closes without sending', !s.$('.fctproc-modal') && s.calls.filter(c => c.q.action === 'send').length === 1);

  // Send from the bid page for a job the tab is not showing.
  const other = makeEnv({ rows: [], storage: {} });
  other.P.renderTab(other.root);
  await other.P.openSendModal('p1');
  other.$('.fctproc-modal [data-sall]').click();
  other.$('.fctproc-modal [data-send="go"]').click();
  await sleep(40);
  assert('sending a job selects it in the tab', other.P._test.state().projectId === 'p1' && other.store.fct_proc_project_turf === 'p1');
  assert('…and announces it', other.events.length === 1 && other.events[0].projectId === 'p1');
  const nolines = makeEnv({ rows: [], bidLines: [] });
  await nolines.P.openSendModal('p1');
  assert('no bid lines -> says so, nothing to send', /no bid lines yet/.test(nolines.$('.fctproc-modal').textContent) && !nolines.$('[data-send="go"]'));
  const failRead = makeEnv({ rows: [] });
  failRead.db.failGet = true;
  await failRead.P.openSendModal('p1');
  assert('a failed read -> no checklist, nothing sent', /Nothing was added/.test(failRead.$('.fctproc-modal').textContent) && !failRead.$('[data-si]'));

  // ── Contacts client ───────────────────────────────────────────────────
  console.log('\n[contacts client]');
  const cenv = makeEnv({ contacts: [{ id: 'c1', supplier_name: 'Acme Supply', name: 'Dana', email: 'dana@acme.test', phone: '' }] });
  cenv.db.pos = [{ id: 'po-acme', supplier: 'acme supply' }, { id: 'po-lb', supplier: 'LB Water' }];
  const K = cenv.P.contacts;
  const list1 = await K.load();
  await K.load();
  assert('load() reads once per division and caches', list1.length === 1 && cenv.calls.filter(c => c.path === '/api/supplier-contacts').length === 1
    && cenv.calls[0].q.division === 'turf');
  assert('list() matches the supplier case-insensitively', K.list(' acme SUPPLY').length === 1 && K.list('Nobody').length === 0 && K.list('').length === 0);
  let changed = 0;
  const off = K.onChange(() => changed++);
  const made = await K.upsert({ supplier_name: 'Acme Supply', name: 'Lee', email: 'lee@acme.test', phone: '555-0100' });
  assert('upsert() posts and adds to the cache', made.name === 'Lee' && K.list('acme supply').length === 2 && changed === 1);
  const same = await K.upsert({ supplier_name: 'ACME SUPPLY', name: '', email: 'LEE@acme.test' });
  assert('upsert() of a known email returns the existing contact', same.id === made.id && K.list('acme supply').length === 2);
  await K.update(made.id, { phone: '555-0199' });
  assert('update() patches and refreshes the cache', K.list('acme supply').find(c => c.id === made.id).phone === '555-0199'
    && cenv.calls.filter(c => c.method === 'PATCH').pop().q.id === made.id);
  const ans = await K.rename('Acme Supply', 'Acme Supply Co');
  assert('rename() moves the contacts and re-reads', ans.moved === 2 && K.list('Acme Supply Co').length === 2 && K.list('Acme Supply').length === 0, ans);
  assert('…and answers what the server did to the purchase orders as well', ans.pos === 1 && eq(ans.po_ids, ['po-acme']) && !('po_error' in ans), ans);
  await K.remove('c1');
  assert('remove() deletes and drops it from the cache', K.all().every(c => c.id !== 'c1') && cenv.calls.filter(c => c.method === 'DELETE').pop().q.id === 'c1');
  off();
  cenv.cfg.division = 'paving';
  cenv.P.configure({ division: 'paving' });
  assert('the cache is per division', K.all().length === 0 && !K.loaded);

  // ── Flush on the page going away ──────────────────────────────────────
  console.log('\n[flush on hide]');
  const h = makeEnv({ rows: EROWS });
  h.P.renderTab(h.root);
  await tick(); await tick(); await tick();
  const hd = h.field('r1', 'quote_number');
  hd.value = 'typed then closed';
  h.fire(hd, 'input');
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  await tick();
  const kp = h.patches().pop();
  assert('pagehide sends the unsaved edit at once, with keepalive', kp && kp.keepalive && kp.body.fields.quote_number === 'typed then closed', kp);
  await sleep(700);
  assert('…and not a second time when the timer would have fired', h.patches().length === 1);

  // ── Dismiss, rerender mid-edit, deleted elsewhere, refresh retry ──────
  console.log('\n[edge cases]');
  const x = makeEnv({ rows: [
    row({ id: 'k1', source: 'bid', bid_item_id: 'b2', bid_qty_at_send: 901, bid_unit_at_send: 'SF', quantity: 880, unit: 'SF', vendor: 'LB Water' }),
    row({ id: 'k2', source: 'bid', bid_item_id: 'b1', vendor: 'Acme Supply', description: 'geo' }),
  ] });
  x.P.renderTab(x.root);
  await tick(); await tick(); await tick();
  assert('a unit change shows both units', /bid 901 SF → 950 LF/.test(x.$('tr[data-row="k1"] .c-quantity').textContent));
  x.$('tr[data-row="k1"] [data-act="dismiss-bid"]').click();
  await sleep(30);
  const dis = x.patches().pop();
  assert('"Dismiss" moves only the baseline, never the typed quantity',
    eq(dis.body.fields, { bid_qty_at_send: 950, bid_unit_at_send: 'LF' }) && x.db.rows.find(r => r.id === 'k1').quantity === 880, dis.body);
  assert('…and the badge goes', !/bid 901/.test(x.$('tr[data-row="k1"] .c-quantity').textContent));

  const typing = x.field('k2', 'description');
  typing.focus();
  typing.value = 'geo fabric';
  x.fire(typing, 'input');
  x.cfg.getPurchaseOrders().push({ id: 'po7', po_number: 'PO-0007', project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Geofabric', supplier: '', date_created: '2026-03-09' });
  x.P.rerender();
  assert('rerender() picks up a new PO (now two match: amber "pick")', x.$('tr[data-row="k2"] .c-po').classList.contains('po-multi')
    && x.field('k2', 'po').placeholder === '2 POs match — pick');
  assert('…without touching the box being typed in', x.w.document.activeElement === typing && typing.isConnected && typing.value === 'geo fabric');
  typing.blur();
  // (The picker commits 120 ms after it is left; the sheet's refresh waits for that.)
  await sleep(260);

  // Enter moves down a column, like the sheet.
  const q1 = x.field('k2', 'quote_number');  // k2 (b1) sorts above k1 (b2)
  q1.focus();
  q1.dispatchEvent(new x.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert('Enter moves to the same column on the next row', x.w.document.activeElement === x.field('k1', 'quote_number'));
  x.w.document.activeElement.blur();

  // Someone else deleted the row being edited.
  x.db.rows.find(r => r.id === 'k1').deleted_at = 'x';
  const gone = x.field('k1', 'quote_number');
  gone.value = 'Q9';
  x.fire(gone, 'input');
  x.fire(gone, 'change');
  await sleep(30);
  assert('a save into a row deleted elsewhere drops the row and says why',
    !x.$('tr[data-row="k1"]') && x.errors.some(m => /deleted by someone else/.test(m)), x.errors);

  // A failed save is retried by the next refresh, and the refresh keeps the value.
  x.db.failPatch = 1;
  const kd = x.field('k2', 'quote_number');
  kd.value = 'Q-RETRY';
  x.fire(kd, 'input');
  x.fire(kd, 'change');
  await sleep(30);
  assert('the failed value stays on screen', x.field('k2', 'quote_number').value === 'Q-RETRY' && x.db.rows.find(r => r.id === 'k2').quote_number === '');
  await x.P.refresh();
  assert('refresh() retries it before re-reading', x.db.rows.find(r => r.id === 'k2').quote_number === 'Q-RETRY'
    && x.field('k2', 'quote_number').value === 'Q-RETRY' && /Saved/.test(x.$('#fctproc-save').textContent));

  // The open job deleted elsewhere: rerender() says so instead of a table.
  const jobs = makeEnv({ rows: EROWS });
  const list = PROJECTS.slice();
  jobs.P.configure({ getProjects: () => list, getProject: id => list.find(p => p.id === id) || null });
  jobs.P.renderTab(jobs.root);
  await tick(); await tick(); await tick();
  list[0] = { ...list[0], 'project-name': 'Penn Cambria HS (renamed)' };
  jobs.P.rerender();
  assert('rerender() shows a renamed job in the picker', jobs.$('#fctproc-proj').value === 'Penn Cambria HS (renamed)');
  list.splice(0, 1);
  jobs.P.rerender();
  assert('rerender() after the job was deleted: a note, no table', /no longer on the job list/.test(jobs.root.textContent) && !jobs.$('tr.fctproc-row'));

  // The page's job list not loaded yet when the tab first draws.
  const late = makeEnv({ rows: EROWS });
  let ready = [];
  late.P.configure({ getProjects: () => ready, getProject: id => ready.find(p => p.id === id) || null });
  late.P.renderTab(late.root);
  await tick(); await tick(); await tick();
  assert('job list not loaded yet: "Loading the job list…", not "no longer on the list"',
    /Loading the job list/.test(late.root.textContent) && !/no longer/.test(late.root.textContent));
  ready = PROJECTS.slice();
  late.P.rerender();
  assert('…and once it arrives, rerender() draws the job\'s rows and picker',
    late.$$('tr.fctproc-row').length === 4 && late.$('#fctproc-proj').value === 'Penn Cambria Field' && late.$('#fctproc-proj').dataset.cbValue === 'p1');


  // ══ Fixes from review ═══════════════════════════════════════════════════
  console.log('\n[a date the server would refuse]');
  {
    const e = makeEnv({ rows: [row({ id: 'd1', date_needed: '2026-03-20', description: 'Geofabric' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const box = e.field('d1', 'date_needed');
    assert('date boxes carry the years the server takes', box.min === '1900-01-01' && box.max === '2999-12-31');
    box.focus();
    // What Chrome hands over while 12/01/2026 is typed, then the slip 3026.
    for (const v of ['0002-12-01', '0020-12-01', '0202-12-01']) { box.value = v; e.fire(box, 'change'); }
    assert('a half-typed year is marked, not saved', box.classList.contains('bad') && e.P._test.pending().pend.size === 0);
    box.value = '3026-12-01';
    e.fire(box, 'change');
    await sleep(700);
    assert('a year past 2999 is never sent', e.patches().length === 0);
    box.blur();
    e.fire(box, 'focusout');
    await sleep(20);
    const t = e.$$('.fctproc-toast').map(x => x.textContent).join(' | ');
    assert('leaving the box says so, naming the date and the rule', /Date Needed: 12\/01\/3026 was not saved/.test(t) && /1900–2999/.test(t) && /back to 03\/20\/2026/.test(t), t);
    assert('…and puts the saved date back in the cell', e.field('d1', 'date_needed').value === '2026-03-20' && !e.field('d1', 'date_needed').classList.contains('bad'));
    const b2 = e.field('d1', 'date_needed');
    b2.focus();
    b2.value = '0026-12-01';                       // "12/01/26": a two-digit year
    e.fire(b2, 'change');
    b2.blur(); e.fire(b2, 'focusout');
    await sleep(700);
    assert('a two-digit year never wipes the saved date', e.patches().length === 0 && e.db.rows[0].date_needed === '2026-03-20'
      && e.field('d1', 'date_needed').value === '2026-03-20');
    assert('…and the message says to type all four digits', e.$$('.fctproc-toast').some(x => /all four digits/.test(x.textContent)));
    const b3 = e.field('d1', 'date_needed');
    b3.value = '2026-12-01';
    e.fire(b3, 'change');
    await sleep(700);
    assert('a good date after that saves as usual', e.patches().length === 1 && e.patches()[0].body.fields.date_needed === '2026-12-01');
  }

  console.log('\n[a value the server refuses]');
  {
    const e = makeEnv({ rows: [row({ id: 'v1', description: 'Geofabric', date_needed: '2026-03-20' })] });
    e.db.refuse = (k, v) => k === 'description' && String(v).includes('!');
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const d = e.field('v1', 'description');
    e.pick(d, 'Bad!', '__typed__');
    const qn = e.field('v1', 'quote_number');
    qn.value = 'Q-1001';
    e.fire(qn, 'input');
    e.fire(qn, 'change');
    await sleep(60);
    const ps = e.patches();
    assert('the refused PATCH carried both cells', ps[0] && eq(ps[0].body.fields, { description: 'Bad!', quote_number: 'Q-1001' }), ps.map(p => p.body));
    assert('…the refused cell is dropped and the rest is sent again at once', ps.length === 2 && eq(ps[1].body.fields, { quote_number: 'Q-1001' }), ps.map(p => p.body));
    assert('…so the other cell is saved', e.db.rows[0].quote_number === 'Q-1001' && e.db.rows[0].description === 'Geofabric');
    assert('…the message names the cell and the value that was refused', e.errors.some(m => /Material "Bad!" was not saved — description is not allowed/.test(m)
      && /the rest of the row's changes go on without it/.test(m)), e.errors);
    assert('…and the cell is back to what is saved', e.field('v1', 'description').value === 'Geofabric' && e.P._test.state().rows[0].description === 'Geofabric');
    const c2 = e.field('v1', 'contact');
    e.pick(c2, 'Pat', null);
    await sleep(700);
    assert('the next edit of the row is not dragged down with it', eq(e.patches().pop().body.fields, { contact: 'Pat' }) && e.db.rows[0].contact === 'Pat');
    await e.P.refresh();
    assert('…and the poll does not send the refused value again', e.patches().length === 3 && !e.P._test.pending().pend.size);
  }

  console.log('\n[picking a saved contact]');
  {
    const e = makeEnv({
      rows: [row({ id: 'k1', vendor: 'LB Water', contact: 'Pat Kline', email: 'pat@lbwater.com' })],
      contacts: [
        { id: 'c1', supplier_name: 'LB Water', name: 'Pat Kline', email: 'pat@lbwater.com', phone: '' },
        { id: 'c2', supplier_name: 'LB Water', name: 'Dave Ross', email: '', phone: '814-555-0101' },
        { id: 'c3', supplier_name: 'LB Water', name: 'Sam', email: '', phone: '' },
      ],
    });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    e.pick(e.field('k1', 'contact'), 'Dave Ross', 'c2');
    await sleep(700);
    assert('a contact with no email: his phone goes in Email, never the last person\'s address',
      eq(e.patches().pop().body.fields, { contact: 'Dave Ross', email: '814-555-0101' }) && e.db.rows[0].email === '814-555-0101');
    e.pick(e.field('k1', 'contact'), 'Sam', 'c3');
    await sleep(700);
    assert('a contact with neither: Email is emptied', eq(e.patches().pop().body.fields, { contact: 'Sam', email: '' }) && e.db.rows[0].email === '');
    await sleep(30);
    assert('…and the cell shows it', e.field('k1', 'email').value === '');
  }

  console.log('\n[a slow poll answer]');
  {
    const e = makeEnv({ rows: [row({ id: 'p1r', description: 'Geofabric' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    let release;
    e.hold = new Promise(r => { release = r; });
    const poll = e.P.refresh();                     // its GET reads the row now (vendor '')
    await tick();
    e.pick(e.field('p1r', 'vendor'), 'LB Water', null);
    await sleep(700);                               // the save is answered: version 2
    assert('the save landed', e.db.rows[0].vendor === 'LB Water' && e.db.rows[0].version === 2);
    release();
    await poll;
    await sleep(10);
    assert('the older poll answer does not put the old vendor back', e.field('p1r', 'vendor').value === 'LB Water'
      && e.P._test.state().rows[0].vendor === 'LB Water' && e.P._test.state().rows[0].version === 2, e.P._test.state().rows[0]);
    // "+ Add Row" while a poll is out: the answer predates the row.
    e.hold = new Promise(r => { release = r; });
    const poll2 = e.P.refresh();
    await tick();
    e.$('[data-act="add"]').click();
    await sleep(20);
    const added = e.P._test.state().rows.find(r => r.id !== 'p1r');
    assert('the new row is there, with focus', !!added && e.w.document.activeElement === e.field(added.id, 'description'));
    release();
    await poll2;
    await sleep(10);
    assert('…and stays when the older answer lands (it is not "deleted elsewhere")', !!e.$(`tr[data-row="${added.id}"]`)
      && e.w.document.activeElement === e.field(added.id, 'description'));
    e.field(added.id, 'description').blur();
    // A row deleted here while a poll is out is not brought back by its answer.
    e.hold = new Promise(r => { release = r; });
    const poll3 = e.P.refresh();
    await tick();
    e.$(`tr[data-row="${added.id}"] [data-act="del"]`).click();
    e.$(`tr[data-row="${added.id}"] [data-act="del-yes"]`).click();
    await sleep(300);
    release();
    await poll3;
    await sleep(10);
    assert('…and a row deleted meanwhile is not brought back by it', !e.$(`tr[data-row="${added.id}"]`) && e.P._test.state().rows.length === 1);
    e.db.rows[0].vendor = 'Elsewhere';
    e.db.rows[0].version = 9;
    await e.P.refresh();
    assert('the next poll still takes another user\'s newer change', e.field('p1r', 'vendor').value === 'Elsewhere');
  }

  console.log('\n[a Procore "Replace all"]');
  {
    // The job as sent from the old bid: a bid row, a "+ Material" under it, a
    // line deleted on purpose (with a quote typed on it).
    const OLD = [
      { id: 'o1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
      { id: 'o2', cost_code: 'Stormwater', sub_code: '15" Perf drain', unit: 'LF', quantity: 950, index: 1 },
      { id: 'o3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', unit: 'LF', quantity: 1200, index: 2 },
    ];
    const NEWB = OLD.map(l => ({ ...l, id: 'N' + l.id }));
    const RROWS = [
      row({ id: 'g1', source: 'bid', bid_item_id: 'o1', cost_code: 'Stormwater', sub_code: 'Geofabric', bid_qty_at_send: 8110, bid_unit_at_send: 'SF', created_at: '2026-03-01T00:00:01Z' }),
      row({ id: 'g2', source: 'bid', bid_item_id: 'o2', cost_code: 'Stormwater', sub_code: '15" Perf drain', bid_qty_at_send: 950, bid_unit_at_send: 'LF', created_at: '2026-03-01T00:00:02Z' }),
      row({ id: 'g3', source: 'bid', bid_item_id: 'o3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', quote_number: 'Q-SILT-1', created_at: '2026-03-01T00:00:03Z', deleted_at: '2026-03-02T00:00:00Z' }),
      row({ id: 'm1', source: 'manual', bid_item_id: 'o1', cost_code: 'Stormwater', sub_code: 'Geofabric', description: 'Geogrid BX1200', created_at: '2026-03-01T00:00:04Z' }),
    ];
    // 0. Send opened from the bid page right after the Replace all, the tab
    //    never drawn: the checklist itself re-links first, and says so.
    {
      const b = makeEnv({ rows: RROWS.map(r => ({ ...r })), bidLines: NEWB });
      await b.P.openSendModal('p1');
      const rel0 = b.patches().map(p => p.q.id + '>' + p.body.fields.bid_item_id).sort();
      assert('Send re-links the bid rows AND the "+ Material" row to the new lines', eq(rel0, ['g1>No1', 'g2>No2', 'm1>No1']), rel0);
      const said = b.$('.fctproc-modal').textContent.replace(/\s+/g, ' ');
      assert('…and says so, naming the lines',
        said.includes('Re-linked 3 rows to the current bid lines with the same cost and sub code (Stormwater / Geofabric; Stormwater / 15" Perf drain)'), said);
    }
    // 1. Replace all done while the tab is open on the job (the bid poll
    //    redraws it): the redraw re-links the rows, and Send opened straight
    //    after waits for that rather than PATCHing the same rows again. The
    //    grid shows it at once — Send or Cancel.
    let bid = OLD;
    const e = makeEnv({ rows: RROWS });
    e.P.configure({ getBidLines: id => (id === 'p1' ? bid : []) });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    assert('before: nothing is "not on bid"', e.$$('.c-codes .fctproc-tag').length === 0);
    bid = NEWB;
    e.P.rerender();
    assert('the bid replaced under the open tab: every row says "not on bid"', e.$$('.c-codes .fctproc-tag').length === 3);
    await e.P.openSendModal('p1');
    const rel = e.patches().map(p => p.q.id + '>' + p.body.fields.bid_item_id).sort();
    assert('the rows are re-linked — each once, not by the redraw AND by Send', eq(rel, ['g1>No1', 'g2>No2', 'm1>No1']), rel);
    assert('…and the PM is told', e.$$('.fctproc-toast').some(t => /Re-linked 3 rows/.test(t.textContent))
      || /Re-linked 3 rows/.test(e.$('.fctproc-modal').textContent));
    assert('…and the grid behind it already shows it', e.$$('.c-codes .fctproc-tag').length === 0);
    const lines = Object.fromEntries(e.$$('.fctproc-modal .fctproc-send-line').map(l => [l.querySelector('.sub').textContent, l]));
    const silt = lines['Silt Sock 12inch'];
    assert('the line deleted before the re-import is still "removed earlier", unticked',
      silt && silt.classList.contains('removed') && !silt.querySelector('input').checked && /removed earlier/.test(silt.textContent));
    assert('…so nothing is ticked to send', e.$('.fctproc-modal [data-send="go"]').disabled);
    silt.querySelector('input').checked = true;
    e.fire(silt.querySelector('input'), 'change');
    e.$('.fctproc-modal [data-send="go"]').click();
    await sleep(40);
    const sc = e.calls.filter(c => c.q.action === 'send').pop();
    assert('ticking it restores THAT row, tied to the new line', sc && sc.body.items.length === 0
      && eq(sc.body.restore_ids, [{ id: 'g3', bid_item_id: 'No3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }]), sc && sc.body);
    const g3 = e.db.rows.find(r => r.id === 'g3');
    assert('…with its quote, and no second row for the line', !g3.deleted_at && g3.quote_number === 'Q-SILT-1' && g3.bid_item_id === 'No3'
      && e.db.rows.filter(r => r.sub_code === 'Silt Sock 12inch').length === 1);
    assert('…shown in bid order, not "not on bid"', e.$$('tr.fctproc-row').map(t => t.dataset.row).join() === 'g1,m1,g2,g3'
      && e.$$('.c-codes .fctproc-tag').length === 0, e.$$('tr.fctproc-row').map(t => t.dataset.row));

    // 2. Replace all answered "no" to sending, then the tab opened: the rows
    //    re-link as they load, without anyone opening Send.
    const a = makeEnv({ rows: RROWS.map(r => ({ ...r })), bidLines: NEWB });
    a.P.renderTab(a.root);
    await sleep(40);
    assert('opening the tab re-links them (the full list read first, deleted rows included)',
      a.calls.some(c => c.q.include_deleted === '1') && eq(a.patches().map(p => p.q.id).sort(), ['g1', 'g2', 'm1']));
    assert('…no row says "not on bid" and they keep bid order', a.$$('.c-codes .fctproc-tag').length === 0
      && a.$$('tr.fctproc-row').map(t => t.dataset.row).join() === 'g1,m1,g2');
    assert('…and the PM is told', a.$$('.fctproc-toast').some(t => /Re-linked 3 rows/.test(t.textContent)));
    // A row whose new line is held by a deleted bid row is left alone — and
    // not tried again on every poll.
    const held = makeEnv({ rows: [
      row({ id: 'h1', source: 'bid', bid_item_id: 'old', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row({ id: 'h2', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', deleted_at: 'x' }),
    ] });
    held.P.renderTab(held.root);
    await sleep(40);
    const gets = () => held.calls.filter(c => c.q.include_deleted === '1').length;
    const g0 = gets();
    assert('a line a deleted bid row holds is not taken', held.patches().length === 0 && g0 === 1);
    await held.P.refresh(); await sleep(20);
    await held.P.refresh(); await sleep(20);
    assert('…and the polls do not keep asking', gets() === g0 && held.patches().length === 0);
    const viewer = makeEnv({ perm: { canView: true, canEdit: false }, rows: RROWS.map(r => ({ ...r })), bidLines: NEWB });
    viewer.P.renderTab(viewer.root);
    await sleep(40);
    assert('a viewer never re-links', viewer.patches().length === 0 && !viewer.calls.some(c => c.q.include_deleted));
  }

  console.log('\n[create PO for rows already on one]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'a1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', vendor: 'Acme Supply' }),
      row({ id: 'a2', source: 'manual', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', vendor: 'Acme Supply', po_auto: false, description: 'Stakes' }),
      row({ id: 'a3', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', vendor: 'Acme Supply', po_id: 'po3' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const sel = id => { const b = e.$(`[data-sel="${id}"]`); b.checked = true; e.fire(b, 'change'); };
    sel('a1');
    e.$('[data-act="bulk-po"]').click();
    await sleep(20);
    let ch = e.$$('.fctproc-modal [data-choice]');
    assert('one row, already on PO-0001 -> asked; no "only the rows with no PO" when there are none',
      ch.length === 2 && /already on <b>PO-0001/.test(e.$('.fctproc-modal').innerHTML) && /anyway/.test(ch[0].textContent), ch.map(c => c.textContent));
    ch[1].click();
    await sleep(20);
    assert('Cancel creates nothing and moves no link', !e.created.some(c => c[0] === 'po') && !e.patches().length);
    sel('a2'); sel('a3');
    e.$('[data-act="bulk-po"]').click();
    await sleep(20);
    assert('rows on two different POs are both named', /2<\/b> of the 3 selected rows are already on <b>PO-0001, PO-0003/.test(e.$('.fctproc-modal').innerHTML),
      e.$('.fctproc-modal').textContent.replace(/\s+/g, ' '));
    ch = e.$$('.fctproc-modal [data-choice]');
    assert('…"Only the 1 row with no PO" is offered first', /Only the 1 row with no PO/.test(ch[0].textContent));
    ch[0].click();
    await sleep(40);
    const made = e.created.filter(c => c[0] === 'po').map(c => c[1]);
    const link = e.patches().filter(p => p.q.action === 'bulk').pop();
    assert('…which makes one PO for that row only', made.length === 1 && made[0].title === 'Stakes' && link && eq(link.body.ids, ['a2']), [made, link && link.body]);
    assert('…and leaves the others on their POs', e.db.rows.find(r => r.id === 'a1').po_id === null && e.db.rows.find(r => r.id === 'a3').po_id === 'po3');
    const m = makeEnv({ rows: [row({ id: 'x1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' })],
      purchaseOrders: POS.concat({ id: 'po2', po_number: 'PO-0002', project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Geofabric', supplier: '', date_created: '2026-03-02' }) });
    m.P.renderTab(m.root);
    await tick(); await tick(); await tick();
    const mb = m.$('[data-sel="x1"]'); mb.checked = true; m.fire(mb, 'change');
    m.$('[data-act="bulk-po"]').click();
    await sleep(20);
    assert('a row several POs match is mentioned too', /matches several existing POs/.test(m.$('.fctproc-modal').textContent));
  }

  console.log('\n[a vendor typed, not on the supplier list]');
  {
    const list = SUPPLIERS.slice();
    const e = makeEnv({ rows: [row({ id: 'f1', description: 'Turf' })] });
    e.P.configure({ getSuppliers: () => list, addSupplier: async n => { list.push(n); return n; } });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    e.pick(e.field('f1', 'vendor'), 'Acme Turf Supply', null);
    await sleep(10);
    const td = e.$('tr[data-row="f1"] .c-vendor');
    assert('it is kept, but marked amber with the reason', e.P._test.state().rows[0].vendor === 'Acme Turf Supply' && td.classList.contains('vendor-off')
      && /not on the supplier list/.test(e.field('f1', 'vendor').title));
    const ct = e.field('f1', 'contact');
    ct.focus();
    e.pick(ct, 'Bob Smith', null);
    const em = e.field('f1', 'email');
    em.focus();
    em.value = 'bob@acme.test';
    e.fire(em, 'input');
    em.blur();
    await sleep(30);
    const posted = () => e.calls.filter(c => c.path === '/api/supplier-contacts' && c.method === 'POST');
    assert('…and a contact typed on the row is not saved under it (Suppliers could never show it)', posted().length === 0);
    e.pick(e.field('f1', 'vendor'), '+ Add "Acme Turf Supply" as new supplier', '__new__:Acme Turf Supply');
    await sleep(40);
    assert('once "+ Add" puts it on the list, the contact is remembered', posted().length === 1
      && eq(posted()[0].body, { supplier_name: 'Acme Turf Supply', name: 'Bob Smith', email: 'bob@acme.test', phone: '' }), posted().map(c => c.body));
    assert('…and the amber mark goes', !e.$('tr[data-row="f1"] .c-vendor').classList.contains('vendor-off'));
    const v = makeEnv({ perm: { canView: true, canEdit: false }, rows: [row({ id: 'f2', vendor: 'Nobody Co' })] });
    v.P.renderTab(v.root);
    await tick(); await tick(); await tick();
    assert('a viewer sees the mark too', v.$('tr[data-row="f2"] .c-vendor').classList.contains('vendor-off'));
  }

  console.log('\n[a phone number typed in Email]');
  {
    const e = makeEnv({ rows: [row({ id: 'ph', vendor: 'LB Water' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const ct = e.field('ph', 'contact');
    ct.focus();
    e.pick(ct, 'Rick Alvarez', null);
    const em = e.field('ph', 'email');
    em.focus();
    em.value = '717-555-0142 cell';
    e.fire(em, 'input');
    em.blur();
    await sleep(700);
    const up = e.calls.filter(c => c.path === '/api/supplier-contacts' && c.method === 'POST').pop();
    assert('it is saved as the contact\'s Phone, not his Email', up && eq(up.body, { supplier_name: 'LB Water', name: 'Rick Alvarez', email: '', phone: '717-555-0142 cell' }), up && up.body);
    assert('…while the row\'s Email cell keeps exactly what was typed', e.db.rows[0].email === '717-555-0142 cell');
    const T2 = e.P._test;
    assert('an address with an @ is never a phone', typeof T2.looksLikePhone === 'function' && !T2.looksLikePhone('717-555-0142@txt.example')
      && T2.looksLikePhone('(814) 555 0101') && T2.looksLikePhone('+1 717 555 0142 ext 12') && !T2.looksLikePhone('call the office') && !T2.looksLikePhone('12-34'));
    const none = makeEnv({ rows: [row({ id: 'pn', vendor: 'LB Water', email: '' })] });
    none.P.renderTab(none.root);
    await tick(); await tick(); await tick();
    const em2 = none.field('pn', 'email');
    em2.focus(); em2.value = '717-555-0142'; none.fire(em2, 'input'); em2.blur();
    await sleep(30);
    assert('a phone with no name is not a contact (nothing posted)', !none.calls.some(c => c.path === '/api/supplier-contacts' && c.method === 'POST'));
  }

  console.log('\n[group headers after an edit]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'q1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain' }),
      row({ id: 'q2', source: 'manual', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', created_at: '2026-03-02T00:00:00Z' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const head = () => e.$('tr.fctproc-grp').textContent.replace(/\s+/g, ' ');
    assert('before: 2 rows · 2 not ordered', /2 rows · 2 not ordered/.test(head()) && !/late/.test(head()), head());
    const dn = e.field('q1', 'date_needed');
    dn.value = '2026-03-01';
    e.fire(dn, 'change');
    assert('a date that makes a row late shows in its group header at once', /2 rows · 2 not ordered · 1 late/.test(head()), head());
    const dd = e.field('q2', 'date_delivered');
    dd.value = '2026-03-09';
    e.fire(dd, 'change');
    assert('…and a delivery takes it off "not ordered"', /2 rows · 1 not ordered · 1 late/.test(head()), head());
  }

  console.log('\n[while the PO list has not loaded]');
  {
    const e = makeEnv({ rows: [row({ id: 'l1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', date_needed: '2026-03-01' }),
      row({ id: 'l2', date_ordered: '2026-02-01' })], poLoaded: false });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const pill = e.$('tr[data-row="l1"] .fctproc-pill');
    assert('a row that may be on a PO shows "…", not "Not Ordered", and is not flagged Late',
      pill.textContent === '…' && pill.classList.contains('st-unk') && !/Late/.test(e.$('tr[data-row="l1"] .c-status').textContent));
    assert('…a row with its own Date Ordered still shows Ordered', e.$('tr[data-row="l2"] .fctproc-pill').textContent === 'Ordered');
    assert('…the header does not count it as not ordered or late', /Not Ordered\s*0/.test(e.$('#fctproc-counts').textContent)
      && /POs loading…\s*1/.test(e.$('#fctproc-counts').textContent) && !/Late/.test(e.$('#fctproc-counts').textContent), e.$('#fctproc-counts').textContent.replace(/\s+/g, ' '));
    e.$('[data-act="csv"]').click();
    assert('…and the export waits for the list rather than writing "Not Ordered"', !e.lastDownload
      && e.$$('.fctproc-toast').some(t => /have not loaded yet/.test(t.textContent)));
  }

  console.log('\n[a supplier renamed]');
  {
    const e = makeEnv({ rows: [row({ id: 's1', vendor: 'LB Water' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const before = e.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement').length;
    await e.P.contacts.rename('LB Water', 'LB Water Service');
    assert('the open job is read again, so its rows show the new name', e.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement').length === before + 1
      && e.field('s1', 'vendor').value === 'LB Water Service');
  }


  console.log('\n[re-link only against the bid the server holds]');
  {
    const OLD = [
      { id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
      { id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', unit: 'LF', quantity: 950, index: 1 },
    ];
    const NEWB = OLD.map(l => ({ ...l, id: 'n' + l.id.slice(1) }));
    // Ada has already re-linked the rows to the new lines; Bea's page still
    // holds the old bid (her poll has not brought the Replace all in yet).
    const relinked = [
      row({ id: 'R1', source: 'bid', bid_item_id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row({ id: 'R2', source: 'bid', bid_item_id: 'n2', cost_code: 'Stormwater', sub_code: '15" Perf drain' }),
      row({ id: 'M1', source: 'manual', bid_item_id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric', description: 'Stakes' }),
    ];
    let mine = OLD, server = NEWB;
    const bea = makeEnv({ rows: relinked });
    bea.P.configure({ getBidLines: id => (id === 'p1' ? mine : []), getFreshBidLines: async () => server });
    bea.P.renderTab(bea.root);
    await sleep(40);
    assert('a page holding an OLD bid never moves rows back to its lines', bea.patches().length === 0, bea.patches().map(p => p.body));
    assert('…and says nothing about re-linking', !bea.$$('.fctproc-toast').some(t => /Re-linked/.test(t.textContent)));
    mine = NEWB;                       // the page's poll catches up
    bea.P.rerender();
    await bea.P.refresh(); await sleep(30);
    assert('…once it has the current bid, the rows are simply on it', bea.patches().length === 0 && bea.$$('.c-codes .fctproc-tag').length === 0);

    // A boot drawn from a cached copy behind the server, and a bid read
    // that failed: no re-link, and nothing marked tried, so it happens once
    // the two agree.
    let fail = true;
    const ada = makeEnv({ rows: relinked.map(r => ({ ...r, bid_item_id: r.bid_item_id.replace('n', 'b') })) });
    ada.P.configure({ getBidLines: id => (id === 'p1' ? NEWB : []), getFreshBidLines: async () => { if (fail) throw new Error('offline'); return NEWB; } });
    ada.P.renderTab(ada.root);
    await sleep(40);
    assert('the bid could not be read: no re-link yet', ada.patches().length === 0);
    fail = false;
    await ada.P.refresh(); await sleep(40);
    const moved = ada.patches().map(p => p.q.id + '>' + p.body.fields.bid_item_id).sort();
    assert('…read on the next load, the rows re-link to the current lines', eq(moved, ['M1>n1', 'R1>n1', 'R2>n2']), moved);
    const t = ada.$$('.fctproc-toast').map(x => x.textContent).join(' | ');
    assert('…and the message names the lines they moved to', /Re-linked 3 rows to the current bid lines with the same cost and sub code \(Stormwater \/ Geofabric; Stormwater \/ 15" Perf drain\)/.test(t), t);

    // Send to Procurement from a page whose bid is not the server's.
    const stale = makeEnv({ rows: [] });
    stale.P.configure({ getBidLines: id => (id === 'p1' ? OLD : []), getFreshBidLines: async () => NEWB });
    await stale.P.openSendModal('p1');
    assert('Send refuses a checklist from a bid that is not the saved one', /not the one saved/.test(stale.$('.fctproc-modal').textContent)
      && !stale.$('.fctproc-modal [data-send="go"]') && !stale.calls.some(c => c.q.action === 'send'));
  }

  console.log('\n[stored codes follow a line renamed on the bid page]');
  {
    let bid = [{ id: 'b2', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf', unit: 'LF', quantity: 950, index: 0 }];
    const e = makeEnv({ rows: [row({ id: 'R2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', quote_number: 'Q1' })] });
    e.P.configure({ getBidLines: id => (id === 'p1' ? bid : []), getFreshBidLines: async () => bid });
    e.P.renderTab(e.root);
    await sleep(40);
    const p = e.patches();
    assert('loading the job stores the line\'s current codes on the row', p.length === 1 && eq(p[0].body.fields, { cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf' }), p.map(x => x.body));
    assert('…quietly (it is not a re-link)', !e.$$('.fctproc-toast').some(t => /Re-linked/.test(t.textContent)));
    // Then a Replace all with the new spelling: the row finds its new line.
    bid = [{ id: 'z2', cost_code: 'Stormwater', sub_code: 'Perimeter Drain 15in Perf', unit: 'LF', quantity: 950, index: 0 }];
    e.P.rerender();
    await e.P.refresh(); await sleep(40);
    assert('…so after a Replace all with that spelling, the row re-links to the new line',
      e.db.rows[0].bid_item_id === 'z2' && e.$$('.c-codes .fctproc-tag').length === 0, e.db.rows[0]);
  }

  console.log('\n[a combobox tabbed through saves nothing]');
  {
    const e = makeEnv({ rows: [row({ id: 't1', source: 'manual', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', unit: 'roll' }),
      row({ id: 't2' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    // What tracker's combobox does on Tab when the box's text matches no
    // option: the FIRST option goes into the box, then input + change.
    const tabThrough = (el, label, cbValue) => {
      el.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
      el.value = label;
      if (cbValue == null) delete el.dataset.cbValue; else el.dataset.cbValue = cbValue;
      el._cbBypassFilter = true;
      e.fire(el, 'input'); e.fire(el, 'change');
      delete el._cbBypassFilter;
    };
    tabThrough(e.field('t1', 'codes'), 'Stormwater / Geofabric', 'b1');
    tabThrough(e.field('t1', 'unit'), 'SF');
    tabThrough(e.field('t2', 'vendor'), 'LB Water');
    tabThrough(e.field('t2', 'po'), 'Auto', '__auto__');
    await e.P._test.flushAll(); await sleep(20);
    assert('Tab through Sub Code, Unit, Vendor and PO # without typing: nothing is saved', e.patches().length === 0, e.patches().map(p => p.body));
    assert('…and the boxes show what they held', e.field('t1', 'unit').value === 'roll' && e.field('t2', 'vendor').value === '');
    // Typed, then Tab: that is a choice.
    const v = e.field('t2', 'vendor');
    v.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    v.value = 'acme'; e.fire(v, 'input');           // real typing (no bypass flag)
    v.value = 'Acme Supply'; v._cbBypassFilter = true; e.fire(v, 'input'); e.fire(v, 'change'); delete v._cbBypassFilter;
    await e.P._test.flushAll(); await sleep(20);
    assert('…typed and then Tab: the vendor is saved', e.db.rows.find(r => r.id === 't2').vendor === 'Acme Supply');
    // An option picked with the arrow keys is a choice too.
    const u = e.field('t1', 'unit');
    u.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    u.dispatchEvent(new e.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    u.value = 'LF'; u._cbBypassFilter = true; e.fire(u, 'input'); e.fire(u, 'change'); delete u._cbBypassFilter;
    await e.P._test.flushAll(); await sleep(20);
    assert('…and so is one moved to with the arrow keys', e.db.rows.find(r => r.id === 't1').unit === 'LF');
  }

  console.log('\n[contacts: only what was typed or picked is remembered]');
  {
    const e = makeEnv({
      rows: [row({ id: 'k1', vendor: 'LB Water', contact: 'Dave Ross', email: 'dave@lbwater.com' }),
             row({ id: 'k2', vendor: 'LB Water', contact: 'Mike Hanlon', email: 'mhanlon@lbwater.com' })],
      contacts: [{ id: 'c1', supplier_name: 'LB Water', name: 'Dave Ross', email: 'dave.ross@lbwater.com', phone: '' },
                 { id: 'c2', supplier_name: 'LB Water', name: 'Mike Hanlon', email: 'mhanlon@lbwater.com', phone: '' }],
    });
    e.P.renderTab(e.root);
    await sleep(30);
    const posts = () => e.calls.filter(c => c.path === '/api/supplier-contacts' && c.method === 'POST');
    // Only a Date Delivered typed on a row whose contact an admin has since
    // corrected: leaving it must not save the old address back.
    const dd = e.field('k1', 'date_delivered');
    dd.focus(); dd.value = '2026-03-09'; e.fire(dd, 'change'); dd.blur();
    await sleep(30);
    assert('a row left after an edit elsewhere does not re-save its old contact', posts().length === 0, posts().map(c => c.body));
    // Typed into Email: remembered.
    const em = e.field('k1', 'email');
    em.focus(); em.value = 'dross@lbwater.com'; e.fire(em, 'input'); em.blur();
    await sleep(30);
    assert('…a contact typed on the row is', posts().length === 1 && posts()[0].body.email === 'dross@lbwater.com', posts().map(c => c.body));

    // Vendor changed on a row whose contact is the old vendor's: cleared.
    const vd = e.field('k2', 'vendor');
    vd.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(vd, 'Beta Corp');
    vd.blur();
    await sleep(30);
    const k2 = e.P._test.state().rows.find(r => r.id === 'k2');
    assert('a new vendor clears the old vendor\'s saved contact from the row', k2.vendor === 'Beta Corp' && k2.contact === '' && k2.email === '', k2);
    assert('…says so', e.$$('.fctproc-toast').some(t => /Contact and Email cleared: Mike Hanlon is a contact of LB Water, not of Beta Corp/.test(t.textContent)));
    assert('…and files nobody under the new vendor', !posts().some(c => /beta/i.test(c.body.supplier_name)), posts().map(c => c.body));
    // An address another supplier already has is not filed under this one.
    const k1 = e.field('k1', 'contact');
    e.pick(e.field('k1', 'vendor'), 'Acme Supply');
    await sleep(10);
    e.pick(k1, 'Somebody');
    const em1 = e.field('k1', 'email');
    em1.focus(); em1.value = 'mhanlon@lbwater.com'; e.fire(em1, 'input'); em1.blur();
    await sleep(30);
    assert('…and an email that is another supplier\'s contact is not filed again', !posts().some(c => /acme/i.test(c.body.supplier_name)), posts().map(c => c.body));
  }

  console.log('\n[clearing a date from the keyboard]');
  {
    const e = makeEnv({ rows: [row({ id: 'd1', date_delivered: '2026-03-05' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const dd = e.field('d1', 'date_delivered');
    dd.focus();
    // Chrome: the first Backspace leaves the box part-filled (marked bad);
    // the last one empties it and fires no change at all.
    dd.dataset.badDate = 'that is not a whole date';
    dd.value = '';
    dd.blur();
    await e.P._test.flushAll(); await sleep(20);
    assert('a date box emptied all the way is saved as a cleared date', e.db.rows[0].date_delivered == null, e.db.rows[0].date_delivered);
    assert('…with no "not saved" message', !e.$$('.fctproc-toast').some(t => /not saved/.test(t.textContent)));
  }

  console.log('\n[a refresh that lands while a cell is being typed in]');
  {
    const e = makeEnv({ rows: [row({ id: 'w1', description: 'one' }), row({ id: 'w2', description: 'two', created_at: '2026-03-01T10:00:01Z' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    let release;
    // A colleague's edit and a row they added, which the next read returns.
    e.db.rows[1].description = 'changed elsewhere'; e.db.rows[1].version = 5;
    e.db.rows.push(row({ id: 'w3', description: 'added elsewhere', created_at: '2026-03-01T10:00:02Z' }));
    e.hold = new Promise(r => { release = r; });
    const pending = e.P.refresh();                 // the poll starts with nothing focused
    await tick();
    const v = e.field('w1', 'vendor');
    v.focus();                                     // ...then the PM starts typing
    release(); await pending; await tick();
    assert('the cell being typed in is the same box, still focused', e.w.document.activeElement === v && v.isConnected);
    assert('…the other row shows the colleague\'s change', e.field('w2', 'description').value === 'changed elsewhere');
    assert('…the added row waits for the table to be left', !e.$('tr[data-row="w3"]'));
    v.blur();
    await sleep(320);                             // a combobox commits 120 ms after blur
    assert('…and appears once it is', !!e.$('tr[data-row="w3"]'));
  }

  console.log('\n[Create PO from selected: one click, one PO]');
  {
    const e = makeEnv({ rows: [row({ id: 'c1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', vendor: 'LB Water' })] });
    let made = 0, releasePO;
    e.P.configure({ createPurchaseOrder: seed => new Promise(r => { made++; releasePO = () => r({ id: 'npo' + made, po_number: 'PO-07' + made, ...seed }); }) });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const sel = e.$('[data-sel="c1"]'); sel.checked = true; e.fire(sel, 'change');
    e.$('[data-act="bulk-po"]').click();
    await tick();
    assert('while the PO is being created the button is disabled', e.$('[data-act="bulk-po"]').disabled);
    e.$('[data-act="bulk-po"]').click();
    e.P._test.state();
    await tick();
    releasePO(); await sleep(30);
    assert('a second click meanwhile raises no second PO', made === 1, made);
  }

  console.log('\n[a send whose answer is lost]');
  {
    const e = makeEnv({ rows: [] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    await e.P.openSendModal('p1');
    tickLines(e);
    const handle = e.handle;
    let lose = true;
    e.handle = c => {
      const res = handle(c);
      if (lose && c.q.action === 'send') { lose = false; return { status: 504, body: { ok: false, error: 'timeout', message: 'Gateway timeout' } }; }
      return res;
    };
    e.$('.fctproc-modal [data-send="go"]').click();
    await sleep(40);
    assert('the server applied it but the page got a 504: the error is shown',
      /Gateway timeout/.test(e.$('.fctproc-modal #fctproc-send-err').textContent), e.$('.fctproc-modal #fctproc-send-err').textContent);
    const lines = [...e.$$('.fctproc-modal .fctproc-send-line')];
    // The four ticked went in.
    assert('…the checklist is read again: those lines are now "already added"', lines.filter(l => l.classList.contains('added')).length === 4
      && e.$('.fctproc-modal [data-send="go"]').disabled, lines.map(l => l.className));
    assert('…and the sheet behind shows the rows the server has', e.$$('tr.fctproc-row').length === 4, e.$$('tr.fctproc-row').length);
  }

  console.log('\n[a send that failed keeps the PM\'s own ticks]');
  {
    const e = makeEnv({ rows: [] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    await e.P.openSendModal('p1');
    const lineEl = sub => e.$$('.fctproc-modal .fctproc-send-line').find(l => l.querySelector('.sub').textContent === sub);
    tickLines(e, ['Geofabric', 'Elbows']);
    assert('two lines ticked: 2 to send', /Add 2 lines/.test(e.$('.fctproc-modal [data-send="go"]').textContent), e.$('.fctproc-modal [data-send="go"]').textContent);
    // The send fails and the server does nothing; the re-read is slow, and
    // the PM ticks the LS line while it is out.
    const handle = e.handle;
    let fail = true, releaseRead = null;
    e.handle = c => {
      if (fail && c.q.action === 'send') { fail = false; return { status: 504, body: { ok: false, error: 'timeout', message: 'Gateway timeout' } }; }
      return handle(c);
    };
    const fetch0 = e.w.fetch;
    e.w.fetch = async (url, init) => {
      if (/include_deleted=1/.test(String(url)) && releaseRead === null) await new Promise(r => { releaseRead = r; });
      return fetch0(url, init);
    };
    e.$('.fctproc-modal [data-send="go"]').click();
    for (let i = 0; i < 20 && !releaseRead; i++) await tick();
    const mob = lineEl('Mobilization').querySelector('input');
    mob.checked = true; e.fire(mob, 'change');
    releaseRead();
    await sleep(40);
    const state = Object.fromEntries(e.$$('.fctproc-modal .fctproc-send-line').map(l => [l.querySelector('.sub').textContent, l.querySelector('input').checked]));
    assert('after the failure, the lines the PM left unticked are still unticked', state['15" Perf drain'] === false && state['Silt Sock 12inch'] === false, state);
    assert('…the ones left ticked are still ticked, and one ticked while the list was read again stays ticked',
      state.Geofabric === true && state.Elbows === true && state.Mobilization === true && state.Labor === false, state);
    assert('…the message says nothing was sent', /^Not added: Gateway timeout/.test(e.$('#fctproc-send-err').textContent), e.$('#fctproc-send-err').textContent);
    e.$('.fctproc-modal [data-send="go"]').click();
    await sleep(40);
    const sent = e.db.rows.map(r => r.sub_code).sort();
    assert('the next click sends only what the PM chose', eq(sent, ['Elbows', 'Geofabric', 'Mobilization']), sent);
  }

  console.log('\n[a send whose answer was lost says it went through]');
  {
    const e = makeEnv({ rows: [] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    await e.P.openSendModal('p1');
    tickLines(e);
    const handle = e.handle;
    let lose = true;
    e.handle = c => {
      const res = handle(c);   // the server applies it…
      if (lose && c.q.action === 'send') { lose = false; return { status: 504, body: { ok: false, error: 'timeout', message: 'Gateway timeout' } }; }
      return res;              // …and the answer is lost on the way back
    };
    e.$('.fctproc-modal [data-send="go"]').click();
    await sleep(40);
    const said = e.$('#fctproc-send-err').textContent;
    assert('the message reports what the re-read shows: it went through', /added after all/.test(said) && /4 lines are now in Procurement/.test(said)
      && !/Not added/.test(said), said);
    // Part of it in by somebody else, the rest refused: says how many.
    const p = makeEnv({ rows: [] });
    p.P.renderTab(p.root);
    await tick(); await tick(); await tick();
    await p.P.openSendModal('p1');
    tickLines(p);
    const h2 = p.handle;
    p.handle = c => {
      if (c.q.action === 'send') {
        // A colleague's send of the Geofabric line lands; this one is lost.
        h2({ ...c, body: { ...c.body, items: c.body.items.filter(it => it.bid_item_id === 'b1') } });
        return { status: 502, body: { ok: false, error: 'bad_gateway', message: 'Bad gateway' } };
      }
      return h2(c);
    };
    p.$('.fctproc-modal [data-send="go"]').click();
    await sleep(40);
    const said2 = p.$('#fctproc-send-err').textContent;
    assert('…and when only some of the ticked lines are in, says how many', /^1 of the 4 lines you ticked is now in Procurement/.test(said2), said2);
  }

  console.log('\n[the re-link checks the bid again, and the server refuses a stale one]');
  {
    const OLDB = [
      { id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
      { id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15in', unit: 'LF', quantity: 950, index: 1 },
    ];
    const NEWB = OLDB.map(l => ({ ...l, id: 'n' + l.id.slice(1) }));
    // Ada's page holds b1, b2 and has a code sync to do; while her full read
    // is out, Bea's Replace all lands and her page re-links the rows to n1, n2.
    let server = OLDB;
    const e = makeEnv({ rows: [
      row({ id: 'R1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row({ id: 'R2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15"', created_at: '2026-03-01T10:00:01Z' }),
    ], bidLines: OLDB });
    e.P.configure({ getFreshBidLines: async () => server });
    const handle = e.handle;
    e.handle = c => {
      if (c.q.include_deleted && server === OLDB) {
        server = NEWB;
        e.db.rows.forEach(r => { r.bid_item_id = 'n' + r.bid_item_id.slice(1); r.version++; });
      }
      return handle(c);
    };
    e.P.renderTab(e.root);
    await sleep(60);
    const moves = e.patches().filter(p => 'bid_item_id' in p.body.fields).map(p => p.q.id + '>' + p.body.fields.bid_item_id);
    assert('a bid replaced on the server while the rows were read: no row is moved back to the old lines', moves.length === 0, moves);
    assert('…and nobody is told rows were re-linked', !e.$$('.fctproc-toast').some(t => /Re-linked/.test(t.textContent)));
    assert('…the rows stay on the current lines', e.db.rows.map(r => r.bid_item_id).join() === 'n1,n2', e.db.rows.map(r => r.bid_item_id));

    // The bid moves between the second check and the PATCH: the server
    // refuses it (stale_bid), nothing more is sent, nothing is marked tried.
    let srv = OLDB;
    const f = makeEnv({ rows: [
      row({ id: 'S1', source: 'bid', bid_item_id: 'gone1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row({ id: 'S2', source: 'bid', bid_item_id: 'gone2', cost_code: 'Stormwater', sub_code: 'Perf Drain 15in', created_at: '2026-03-01T10:00:01Z' }),
    ], bidLines: OLDB });
    let pageBid = OLDB;
    f.P.configure({ getFreshBidLines: async () => srv, getBidLines: id => (id === 'p1' ? pageBid : []) });
    const h2 = f.handle;
    let tried = 0;
    f.handle = c => {
      if (c.method === 'PATCH' && c.body && c.body.fields && c.body.fields.bid_item_id) {
        tried++;
        srv = NEWB;     // a colleague's Replace all lands just now
        if (!srv.some(l => l.id === c.body.fields.bid_item_id)) {
          return { status: 409, body: { ok: false, error: 'stale_bid', message: 'That bid line is no longer on the job\'s bid', field: 'bid_item_id' } };
        }
      }
      return h2(c);
    };
    f.P.renderTab(f.root);
    await sleep(60);
    assert('the server refusing a re-link (stale_bid) stops the pass after that one row', tried === 1 && f.db.rows.every(r => r.bid_item_id.startsWith('gone')), { tried, rows: f.db.rows.map(r => r.bid_item_id) });
    assert('…with no "Re-linked" message', !f.$$('.fctproc-toast').some(t => /Re-linked/.test(t.textContent)));
    pageBid = NEWB;          // the page's own poll catches up
    f.P.rerender();
    await sleep(60);
    const moved2 = f.patches().filter(p => p.body.fields.bid_item_id && p.body.fields.bid_item_id.startsWith('n')).map(p => p.q.id + '>' + p.body.fields.bid_item_id).sort();
    assert('…and once the page has the current bid, the rows re-link to it (nothing was marked tried)', eq(moved2, ['S1>n1', 'S2>n2']), moved2);

    // A cell saved against a line the server's bid no longer has: refused
    // for good, not retried on every edit.
    const g = makeEnv({ rows: [row({ id: 'H1', description: 'stakes' })] });
    g.P.renderTab(g.root);
    await tick(); await tick(); await tick();
    const h3 = g.handle;
    g.handle = c => (c.method === 'PATCH' && c.body.fields.bid_item_id
      ? { status: 409, body: { ok: false, error: 'stale_bid', message: 'That bid line is no longer on the job\'s bid', field: 'bid_item_id' } }
      : h3(c));
    const codes = g.field('H1', 'codes');
    codes.dispatchEvent(new g.w.FocusEvent('focusin', { bubbles: true }));
    g.pick(codes, 'Stormwater / Geofabric', 'b1');
    await g.P._test.flushAll(); await sleep(30);
    const pend = g.P._test.pending();
    assert('a cell tied to a line the server no longer has is refused once, not kept to send again',
      !pend.failed.has('H1') && !(pend.pend.get('H1') || {}).bid_item_id && g.errors.some(m => /no longer on the job's bid/.test(m)), { failed: [...pend.failed], errors: g.errors });
    const h1 = g.P._test.state().rows.find(r => r.id === 'H1');
    assert('…and the Quantity and Unit that pick filled in go back with it', h1.quantity == null && h1.unit === ''
      && g.field('H1', 'quantity').value === '' && !g.P._test.pending().pend.has('H1'), { q: h1.quantity, u: h1.unit, pend: [...g.P._test.pending().pend] });
    assert('…named as the one pick', g.errors.some(m => /Cost \/ Sub Code was not saved/.test(m)) && !g.errors.some(m => /Quantity|Unit/.test(m)), g.errors);
  }

  console.log('\n[Create PO reads the order list again first]');
  {
    const pos = POS.map(p => ({ ...p }));
    const e = makeEnv({ rows: [row({ id: 'z1', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', vendor: 'LB Water Works' })], purchaseOrders: pos });
    let refreshed = 0;
    // The stored list says PO-0003 is LB Water Works now (renamed elsewhere);
    // the page's copy still says LB Water until it is read again.
    e.P.configure({ refreshPurchaseOrders: async () => { refreshed++; pos.find(p => p.id === 'po3').supplier = 'LB Water Works'; return true; } });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    assert('on the page\'s stale copy the row looks unordered', e.$('tr[data-row="z1"] .fctproc-pill').textContent === 'Not Ordered');
    let asked = null;
    e.w.document.addEventListener('click', () => {}, true);
    const sel = e.$('[data-sel="z1"]'); sel.checked = true; e.fire(sel, 'change');
    e.$('[data-act="bulk-po"]').click();
    await sleep(30);
    asked = e.$('.fctproc-modal') && e.$('.fctproc-modal').textContent;
    assert('Create PO reads the list again before deciding', refreshed === 1);
    assert('…and so asks, the row being on PO-0003 after all, rather than raising a second order',
      /already on/.test(asked || '') && /PO-0003/.test(asked || '') && !e.created.some(x => x[0] === 'po'), asked);
    // Picking a job reads the list again too.
    e.P._test.selectProject('p2');
    await sleep(20);
    assert('…and so does picking a job', refreshed === 2, refreshed);
  }

  console.log('\n[Create PO while the page holds a purchase-order change not stored yet]');
  {
    // A save of the list failed and is owed: the host could not read the
    // stored list (it would drop that change), so whether the row is already
    // on an order — a colleague's — cannot be told from the page's copy.
    const e = makeEnv({ rows: [row({ id: 'u1', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', vendor: 'Acme' })] });
    let unsaved = true, refreshed = 0;
    e.P.configure({ refreshPurchaseOrders: async () => { refreshed++; return false; }, poListUnsaved: () => unsaved });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const sel = e.$('[data-sel="u1"]'); sel.checked = true; e.fire(sel, 'change');
    e.$('[data-act="bulk-po"]').click();
    await sleep(30);
    assert('nothing is created while the stored list could not be read for an unsaved PO change',
      refreshed === 1 && !e.created.some(x => x[0] === 'po') && !e.$('.fctproc-modal'), e.created);
    assert('…and the PM is told why', e.$$('.fctproc-toast').some(t => /has not been saved yet[\s\S]*No PO was created/.test(t.textContent)),
      e.$$('.fctproc-toast').map(t => t.textContent));
    assert('…with the row still selected, to try again', e.$('[data-sel="u1"]').checked);
    // Saved now: the same click raises the order.
    unsaved = false;
    e.$('[data-act="bulk-po"]').click();
    await sleep(40);
    assert('once it is saved, Create raises the order', e.created.filter(x => x[0] === 'po').length === 1, e.created);
  }

  console.log('\n[a contact typed against a supplier renamed meanwhile]');
  {
    const e = makeEnv({ rows: [row({ id: 'j1', vendor: 'LB Water' })] });
    let listed = ['LB Water Works'];
    e.P.configure({ isSupplierListed: async name => listed.some(n => n.toLowerCase() === String(name).toLowerCase()) });
    e.P.renderTab(e.root);
    await sleep(30);
    const posts = () => e.calls.filter(c => c.path === '/api/supplier-contacts' && c.method === 'POST' && !c.q.action);
    const ct = e.field('j1', 'contact');
    ct.focus(); ct.value = 'Joe Brandt'; e.fire(ct, 'input'); e.fire(ct, 'change'); ct.blur();
    await sleep(40);
    assert('not filed under a name no longer on the list', posts().length === 0);
    assert('…and the PM is told so, not just the console', e.$$('.fctproc-toast').some(t => /Joe Brandt was not saved as a contact/.test(t.textContent)),
      e.$$('.fctproc-toast').map(t => t.textContent));
    // The Vendor put right: leaving the row files the contact there.
    const v = e.field('j1', 'vendor');
    v.focus();
    e.pick(v, 'Beta Corp');
    listed = ['LB Water Works', 'Beta Corp'];
    v.blur();
    await sleep(40);
    assert('…once the Vendor is put right, the contact is filed under it', posts().length === 1 && posts()[0].body.supplier_name === 'Beta Corp'
      && posts()[0].body.name === 'Joe Brandt', posts().map(c => c.body));
  }

  console.log('\n[+ Add Row when the answer is lost]');
  {
    const e = makeEnv({ rows: [] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const fetch0 = e.w.fetch;
    let drop = true;
    e.w.fetch = async (url, init) => {
      const r = await fetch0(url, init);
      if (drop && init && init.method === 'POST' && !/action=/.test(String(url))) { drop = false; throw new TypeError('Failed to fetch'); }
      return r;
    };
    e.$('[data-act="add"]').click();
    await sleep(40);
    assert('the row the server added is shown once, with no error', e.db.rows.length === 1 && e.$$('tr.fctproc-row').length === 1 && !e.errors.length,
      { db: e.db.rows.length, shown: e.$$('tr.fctproc-row').length, errors: e.errors });
  }

  console.log('\n[a linked PO moved to another job]');
  {
    const e = makeEnv({ rows: [row({ id: 'mv', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', po_id: 'po9' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const td = e.$('tr[data-row="mv"] .c-po');
    assert('shows red "on another job", not that PO as this job\'s order', td.classList.contains('po-removed')
      && /PO-0009 is on another job/.test(e.field('mv', 'po').placeholder) && e.field('mv', 'po').value === '', e.field('mv', 'po').placeholder);
    assert('…and the row is Not Ordered', e.$('tr[data-row="mv"] .fctproc-pill').textContent === 'Not Ordered');
  }

  console.log('\n[a job with no bid lines]');
  {
    const e = makeEnv({ rows: [], bidLines: [] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    assert('the empty sheet does not point at Send to Procurement', !/Use <b>(Send|Add) to Procurement<\/b>|Use (Send|Add) to Procurement/.test(e.$('#fctproc-wrap').textContent)
      && /no bid lines yet/.test(e.$('#fctproc-wrap').textContent), e.$('#fctproc-wrap').textContent);
    e.$('[data-act="add"]').click();
    await sleep(20);
    const id = e.P._test.state().rows[0].id;
    const codes = e.field(id, 'codes');
    codes.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(codes, 'Stormwater');
    assert('a code typed with no bid line to match says why it is not kept', e.$$('.fctproc-toast').some(t => /no bid lines yet/.test(t.textContent)));
  }

  console.log('\n[a Sub Code pick fills Quantity and Unit from the bid line]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'q1' }),                                   // + Add Row: blank
      row({ id: 'q2', unit: 'TON' }),                      // a unit of the PM's own
      row({ id: 'q3', quantity: 75 }),                     // a quantity typed first
      row({ id: 'q4', cost_code: 'Stormwater' }),          // + Add Row on a section
      // Coded before picks filled Quantity and Unit: its line picked again.
      row({ id: 'q5', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }),
      row({ id: 'q6', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', quantity: 300, unit: 'LF' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const pickLine = async (id, label, lineId) => {
      const box = e.field(id, 'codes');
      box.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
      e.pick(box, label, lineId);
      await e.P._test.flushAll(); await sleep(20);
    };
    const saved = id => e.db.rows.find(r => r.id === id);
    const last = id => e.patches().filter(p => p.q.id === id).pop();

    await pickLine('q1', 'Stormwater / Geofabric', 'b1');
    assert('a blank row takes the line\'s quantity and unit with the codes',
      eq(last('q1').body.fields, { bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110 }), last('q1').body);
    assert('…and shows them', e.field('q1', 'quantity').value.replace(/,/g, '') === '8110' && e.field('q1', 'unit').value === 'SF',
      { q: e.field('q1', 'quantity').value, u: e.field('q1', 'unit').value });

    await pickLine('q1', 'Stormwater / 15" Perf drain', 'b2');
    assert('a corrected pick brings the new line\'s numbers (the old ones were the old line\'s)',
      saved('q1').quantity === 950 && saved('q1').unit === 'LF', saved('q1'));

    const qty = e.field('q1', 'quantity');
    qty.focus(); qty.value = '400'; e.fire(qty, 'input'); e.fire(qty, 'change'); qty.blur();
    await e.P._test.flushAll(); await sleep(20);
    await pickLine('q1', 'E&S / Silt Sock 12inch', 'b3');
    assert('a quantity the PM typed is kept on the next pick', saved('q1').quantity === 400 && saved('q1').unit === 'LF'
      && saved('q1').bid_item_id === 'b3', saved('q1'));

    await pickLine('q2', 'Stormwater / Geofabric', 'b1');
    assert('a unit of the PM\'s own keeps the bid\'s quantity out too (it is counted in the bid\'s unit)',
      saved('q2').bid_item_id === 'b1' && saved('q2').unit === 'TON' && saved('q2').quantity == null, saved('q2'));

    await pickLine('q3', 'Stormwater / Elbows', 'b6');
    assert('a quantity typed before the pick stays; the blank unit is filled',
      saved('q3').quantity === 75 && saved('q3').unit === 'EA', saved('q3'));

    await pickLine('q4', 'Stormwater / Geofabric', 'b1');
    assert('a row added on a cost-code section fills too', saved('q4').quantity === 8110 && saved('q4').unit === 'SF', saved('q4'));

    // Clearing the Sub Code leaves Quantity and Unit as they are.
    const box = e.field('q4', 'codes');
    box.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(box, '', null);
    await e.P._test.flushAll(); await sleep(20);
    assert('emptying the Sub Code keeps Quantity and Unit', saved('q4').bid_item_id == null && saved('q4').quantity === 8110 && saved('q4').unit === 'SF', saved('q4'));

    await pickLine('q5', 'E&S / Silt Sock 12inch', 'b3');
    assert('a row already on a line, with Quantity and Unit blank: picking that line again fills them, and only them',
      eq(last('q5') && last('q5').body.fields, { unit: 'LF', quantity: 1200 }), last('q5') && last('q5').body);
    const n6 = e.patches().filter(p => p.q.id === 'q6').length;
    await pickLine('q6', 'E&S / Silt Sock 12inch', 'b3');
    assert('…and with them filled in, picking it again saves nothing', e.patches().filter(p => p.q.id === 'q6').length === n6
      && saved('q6').quantity === 300, saved('q6'));
  }

  console.log('\n[every column filters]');
  {
    const e = makeEnv({ rows: [row({ id: 'f1', date_needed: '2026-04-01' }), row({ id: 'f2', created_at: '2026-03-01T10:00:01Z' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const fbs = e.$$('[data-pff]').map(b => b.dataset.pff);
    for (const f of ['date_needed', 'lead_time_days', 'order_by', 'date_ordered', 'date_delivered', 'quantity', 'description', 'email']) {
      assert(`a filter on ${f}`, fbs.includes(f));
    }
    e.$('[data-pff="date_needed"]').click();
    const blank = [...e.w.document.querySelectorAll('#fctproc-ff-list .fctproc-ff-val')].find(c => c.value === '');
    [...e.w.document.querySelectorAll('#fctproc-ff-list .fctproc-ff-val')].forEach(c => { c.checked = c === blank; });
    e.w.document.querySelector('#fctproc-filter-dd [data-ff="apply"]').click();
    assert('…"(blank)" Date Needed finds the row the late flags never catch', e.$$('tr.fctproc-row').map(t => t.dataset.row).join() === 'f2');
  }

  console.log('\n[bulk Contact + Email offers the vendor\'s saved contacts]');
  {
    const e = makeEnv({ rows: [row({ id: 'u1', vendor: 'LB Water' }), row({ id: 'u2', vendor: 'lb water', created_at: '2026-03-01T10:00:01Z' })],
      contacts: [{ id: 'c9', supplier_name: 'LB Water', name: 'Mike Hanlon', email: 'mhanlon@lbwater.com', phone: '' }] });
    e.P.renderTab(e.root);
    await sleep(30);
    for (const id of ['u1', 'u2']) { const b = e.$(`[data-sel="${id}"]`); b.checked = true; e.fire(b, 'change'); }
    const f = e.$('#fctproc-bulk-field'); f.value = 'contact_email'; e.fire(f, 'change');
    const c = e.$('#fctproc-bulk-contact');
    assert('the bulk Contact is the vendor\'s contact picker', c.classList.contains('cb-input') && /proc_contacts:u1/.test(c.closest('.cb').dataset.list));
    e.pick(c, 'Mike Hanlon', 'c9');
    assert('…and picking one fills Email too', e.$('#fctproc-bulk-email').value === 'mhanlon@lbwater.com');
  }

  console.log('\n[a column the page hides (Material, for a page that wants the bid\'s names alone)]');
  {
    const e = makeEnv({ rows: [row({ id: 'h1', description: 'secret glue', quote_number: 'Q-1' }), row({ id: 'h2', description: 'other thing', quote_number: 'Q-2' })] });
    e.P.configure({ hiddenColumns: ['description'] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const heads = e.$$('#fctproc-wrap thead th').map(t => t.dataset.label || '');
    assert('no Material column or cells on the sheet; the rest are there', !heads.includes('Material') && !e.field('h1', 'description')
      && heads.includes('Vendor / Quote #') && !!e.field('h1', 'quote_number') && e.$$('tr.fctproc-row').length === 2, heads);
    assert('…and the table is that column narrower', parseFloat(e.$('.fctproc-table').style.width) > 0
      && !e.$$('#fctproc-wrap col').some(c => c.style.width === '18rem'), e.$('.fctproc-table').style.width);
    const search = e.$('#fctproc-search');
    search.value = 'secret'; e.fire(search, 'input');
    await sleep(350);
    assert('the search does not look in it', e.$$('tr.fctproc-row').length === 0, e.$$('tr.fctproc-row').map(t => t.dataset.row));
    search.value = 'Q-1'; e.fire(search, 'input');
    await sleep(350);
    assert('…but does in the columns shown', e.$$('tr.fctproc-row').map(t => t.dataset.row).join() === 'h1');
    search.value = ''; e.fire(search, 'input');
    await sleep(350);
    e.P._test.state().filters = { description: new Set(['other thing']) };
    e.P.rerender();
    assert('a filter left on it narrows nothing', e.$$('tr.fctproc-row').length === 2);
    e.P._test.state().filters = {};
    const m = e.P._test.exportMatrix(e.P._test.state().rows, C());
    assert('the Excel / CSV columns leave it out', !m.header.includes('Material') && m.header.includes('Quote #') && m.header.length === 17
      && m.rows.every(r => r.length === 17) && !m.rows.some(r => r.some(c => c.v === 'secret glue')), m.header);
    assert('…so does the CSV text', !/secret glue|Material/.test(e.P._test.buildCsv(e.P._test.state().rows, C())));
    const html = e.P._test.buildPrintHtml(C(), { printedAt: new Date(2026, 10, 17) });
    assert('…and the print view', !/<th>Material<\/th>/.test(html) && !/secret glue/.test(html) && /Q-1/.test(html));
    e.$('[data-act="add"]').click();
    await sleep(40);
    const added = e.P._test.state().rows.find(r => r.id !== 'h1' && r.id !== 'h2');
    assert('+ Add Row puts the cursor in Quantity, Material being hidden', !!added && e.w.document.activeElement === e.field(added.id, 'quantity'));
    assert('…and what is stored in it is kept', e.db.rows.find(r => r.id === 'h1').description === 'secret glue'
      && e.P._test.state().rows.find(r => r.id === 'h1').description === 'secret glue');
    e.P.configure({ hiddenColumns: [] });
    e.P.rerender();
    assert('shown again once the page stops hiding it, with what it held', !!e.field('h1', 'description') && e.field('h1', 'description').value === 'secret glue');
  }

  console.log('\n[a row added from a section: a cost code alone, no bid line]');
  {
    const Tt = boot.P._test;
    const own = { id: 'pos1', po_number: 'PO-0050', project_id: 'p1', cost_code: 'Stormwater', sub_code: '', supplier: 'LB Water', date_created: '2026-03-03', status: 'pending' };
    const ctx = C({ purchaseOrders: POS.concat([own]) });
    const blank = row({ id: 's1', cost_code: 'Stormwater' });
    assert('a hand-added row with a cost code and no sub code matches no order — not the one a sibling raised for that code',
      Tt.effectivePO(blank, ctx).kind === 'none' && Tt.statusOf(blank, ctx) === 'Not Ordered' && !Tt.effectiveDateOrdered(blank, ctx),
      Tt.effectivePO(blank, ctx).kind);
    assert('…with a vendor too', Tt.effectivePO({ ...blank, vendor: 'LB Water' }, ctx).kind === 'none');
    assert('…while the sibling linked to it still reads Ordered on it', Tt.effectivePO({ ...blank, id: 's0', po_id: 'pos1' }, ctx).kind === 'linked'
      && Tt.statusOf({ ...blank, id: 's0', po_id: 'pos1' }, ctx) === 'Ordered');
    assert('…and a row on a bid line still auto-matches as before', Tt.effectivePO(row({ id: 's2', source: 'bid', bid_item_id: 'b1' }), ctx).kind === 'auto');
    assert('its cost code still on the bid: no flag', !Tt.liveCodes(blank, ctx).costGone && !Tt.liveCodes(blank, ctx).notOnBid);
    const left = row({ id: 's3', cost_code: 'Storm Sewer (old)' });
    assert('its cost code gone from the bid (renamed there): flagged', Tt.liveCodes(left, ctx).costGone === true && !Tt.liveCodes(left, ctx).notOnBid);
    assert('…and the flag is in the export notes', /Cost code not on bid/.test(Tt.exportMatrix([left], ctx).rows[0].slice(-1)[0].v));
    assert('…but not on a job with no bid lines in hand, nor on a row with no cost code',
      !Tt.liveCodes(left, C({ bidLines: [] })).costGone && !Tt.liveCodes(row({ id: 's4' }), ctx).costGone);
    const e = makeEnv({ rows: [row({ id: 's3', cost_code: 'Storm Sewer (old)' }), row({ id: 's5', cost_code: 'Stormwater' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const tag = id => e.$(`tr[data-row="${id}"] .c-codes .fctproc-tag`);
    assert('the sheet tags it "not on bid", and says why', !!tag('s3') && /no line on the bid has this cost code/i.test(tag('s3').title) && !tag('s5'),
      tag('s3') && tag('s3').title);
  }

  console.log('\n[Create PO titles, and messages, with Material hidden]');
  {
    const e = makeEnv({ rows: [
      row({ id: 't1', vendor: 'LB Water', description: 'hidden text' }),
      row({ id: 't2', vendor: 'LB Water', cost_code: 'Stormwater', description: 'hidden too' }),
      row({ id: 't3', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', vendor: 'Beta Corp', description: 'old note' }),
    ] });
    e.P.configure({ hiddenColumns: ['description'] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const create = async id => {
      e.P._test.state().selected.clear();
      const sel = e.$(`[data-sel="${id}"]`); sel.checked = true; e.fire(sel, 'change');
      e.$('[data-act="bulk-po"]').click();
      await sleep(40);
      const go = e.$('.fctproc-modal button.btn-green, .fctproc-modal [data-po="go"]');
      if (go) { go.click(); await sleep(40); }
      return (e.created.filter(x => x[0] === 'po').pop() || [])[1];
    };
    let seed = await create('t1');
    assert('a hand-added row with no code: the PO is titled after the vendor, never blank, and not from the hidden Material',
      seed && seed.title === 'LB Water materials', seed);
    seed = await create('t2');
    assert('…with a cost code alone: titled with the cost code', seed && seed.title === 'Stormwater', seed);
    seed = await create('t3');
    assert('…on a bid line: titled with its Sub Code, not the hidden Material', seed && seed.title === 'Elbows', seed);
    const codes = e.field('t1', 'codes');
    codes.focus(); e.pick(codes, 'Inlet couplers 15in', null); codes.blur();
    await sleep(20);
    const said = e.$$('.fctproc-toast').map(t => t.textContent).join(' | ');
    assert('a Sub Code typed that is not on the bid: the message says to pick one, and does not point at the hidden Material',
      /is not a line on this job's bid — pick one from the list\./.test(said) && !/Material|Description/.test(said), said);
  }
  {
    const e = makeEnv({ rows: [row({ id: 't4', vendor: 'LB Water', description: 'Couplers' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const sel = e.$('[data-sel="t4"]'); sel.checked = true; e.fire(sel, 'change');
    e.$('[data-act="bulk-po"]').click();
    await sleep(40);
    const seed = (e.created.filter(x => x[0] === 'po').pop() || [])[1];
    assert('with Material shown, one row\'s PO is titled from its Material', seed && seed.title === 'Couplers', seed);
    const codes = e.field('t4', 'codes');
    codes.focus(); e.pick(codes, 'Inlet couplers 15in', null); codes.blur();
    await sleep(20);
    assert('…and the message says the job\'s own name goes in Material', e.$$('.fctproc-toast').some(t => /own name for the material goes in Material/.test(t.textContent)),
      e.$$('.fctproc-toast').map(t => t.textContent));
  }

  console.log('\n[leaving with a change that could not be saved]');
  {
    const e = makeEnv({ rows: [row({ id: 'x1' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    e.db.failPatch = 5;
    const d = e.field('x1', 'description');
    d.focus(); e.pick(d, 'Type M inlet', '__typed__');
    await sleep(20);
    const ev = new e.w.Event('beforeunload', { cancelable: true });
    e.w.dispatchEvent(ev);
    assert('the browser is asked to confirm leaving', ev.defaultPrevented);
  }

  // ── Attached documents ────────────────────────────────────────────────
  // The page's document hooks, as tracker.html hands them over: counts read
  // out of a cache the page keeps, a refresh that settles once that cache is
  // fresh, and the two openers. Every call is recorded. `hold` keeps the next
  // refresh out until release(); `next` / `nextCc` are what it brings back.
  // The opener notes, at the moment it is called, how many saves had gone and
  // what the server held for the line — so a test can tell what came first.
  const CLIP = '\u{1F4CE}', FOLDER = '\u{1F4C1}';
  function withDocs(e, { counts = {}, cc = {} } = {}) {
    const d = {
      counts: { ...counts }, cc: { ...cc }, asks: [], opened: [], folders: [], countArgs: [], ccArgs: [],
      next: null, nextCc: null, fail: false, hold: false, release: null,
    };
    const settle = () => {
      if (d.fail) throw new Error('the documents could not be read');
      if (d.next) { d.counts = d.next; d.next = null; }
      if (d.nextCc) { d.cc = d.nextCc; d.nextCc = null; }
    };
    e.P.configure({
      attachmentCount: (pid, id) => { d.countArgs.push([pid, id]); return pid === 'p1' ? d.counts[id] || 0 : 0; },
      costCodeDocCount: (pid, code) => { d.ccArgs.push([pid, code]); return pid === 'p1' ? d.cc[code] || 0 : 0; },
      refreshAttachmentCounts: pid => {
        d.asks.push(pid);
        if (!d.hold) return Promise.resolve().then(settle);
        return new Promise(res => { d.release = () => { d.release = null; res(); }; }).then(settle);
      },
      openAttachments: line => {
        const saved = e.db.rows.find(r => r.id === (line && line.id));
        d.opened.push({ line, patches: e.patches().filter(c => c.q.id === (line && line.id)).length, saved: saved ? { ...saved } : null });
      },
      openCostCodeFolder: o => { d.folders.push(o); },
    });
    return d;
  }
  const drawn = async e => { e.P.renderTab(e.root); await tick(); await tick(); await tick(); await sleep(30); };

  console.log('\n[the paperclip on each line]');
  {
    const AROWS = [
      row({ id: 'a1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row({ id: 'a2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', created_at: '2026-03-01T10:00:01Z' }),
      row({ id: 'a3', created_at: '2026-03-01T10:00:02Z' }),
    ];
    const e = makeEnv({ rows: AROWS });
    const d = withDocs(e, { counts: { a1: 2, a2: 1 } });
    await drawn(e);
    const clip = id => e.$(`tr[data-row="${id}"] td.c-status button.fctproc-clip`);
    const pillOf = id => e.$(`tr[data-row="${id}"] td.c-status .fctproc-pill`);
    assert('every line has a paperclip, in its Status cell right after the status pill', ['a1', 'a2', 'a3'].every(id => !!clip(id)
      && pillOf(id).nextElementSibling === clip(id)));
    assert('  and only there: one per line, no column of its own', e.$$('[data-act="files"]').length === 3 && !e.$('td.c-files')
      && e.$$('tr.fctproc-row').every(tr => tr.querySelectorAll('[data-act="files"]').length === 1)
      && !e.$$('.fctproc-table th').some(th => th.textContent.trim() === CLIP));
    assert('  so it stays pinned at the left with Status', clip('a1').closest('td').classList.contains('stk'));
    assert('  a plain button the sheet answers (data-act="files", the row\'s id)',
      clip('a1').tagName === 'BUTTON' && clip('a1').type === 'button' && clip('a1').dataset.act === 'files' && clip('a1').dataset.row === 'a1');
    assert('  with its count beside it, green, and the count in its tooltip',
      clip('a1').textContent === CLIP + '2' && clip('a1').classList.contains('has') && clip('a1').title === '2 attached documents',
      [clip('a1').textContent, clip('a1').className, clip('a1').title]);
    assert('  one document said in the singular', clip('a2').textContent === CLIP + '1' && clip('a2').title === '1 attached document');
    assert('  none: no number, muted, and an editor is offered to attach one',
      clip('a3').textContent === CLIP && !clip('a3').classList.contains('has') && clip('a3').title === 'Attach a document');
    assert('  its label is read out the same as its tooltip', clip('a1').getAttribute('aria-label') === '2 attached documents');
    assert('  counted by job and line', d.countArgs.some(([p, id]) => p === 'p1' && id === 'a1') && d.countArgs.every(([p]) => p === 'p1'));
    assert('  the count is a badge on the button (it never widens it), none when nothing is attached',
      !!clip('a1').querySelector('span.n') && clip('a1').querySelector('span.n').textContent === '2' && !clip('a3').querySelector('.n'));
    d.counts.a2 = 120;
    e.P.rerender();
    assert('  a count past 99 reads 99+ on the badge, the real number in the tooltip and label',
      clip('a2').querySelector('.n').textContent === '99+' && clip('a2').title === '120 attached documents'
      && clip('a2').getAttribute('aria-label') === '120 attached documents');
    d.counts.a2 = 1;
    e.P.rerender();
    const css = (e.$('#fctproc-styles') || {}).textContent || '';
    assert('the stylesheet draws a count green and none muted',
      /\.fctproc-clip \{[^}]*color: var\(--muted/.test(css) && /\.fctproc-clip\.has \{[^}]*color: var\(--green/.test(css));

    const m = e.P._test.exportMatrix(e.P._test.state().rows, C());
    assert('the Excel / CSV columns are the ones they were: no paperclip, no count', m.header.length === 18
      && m.header[1] === 'PO #' && m.header[2] === 'Sub-Contractor Agreement' && !m.header.some(h => /\u{1F4CE}|attach|document/iu.test(h)), m.header);
    const printed = e.P._test.buildPrintHtml(C(), { printedAt: new Date(2026, 10, 17) });
    assert('  and the print view', !/\u{1F4CE}|&#128206;|fctproc-clip|Attached documents/u.test(printed));

    const v = makeEnv({ perm: { canView: true, canEdit: false }, rows: AROWS });
    const dv = withDocs(v, { counts: { a1: 3 } });
    await drawn(v);
    const vclip = id => v.$(`tr[data-row="${id}"] td.c-status button.fctproc-clip`);
    assert('a viewer has the paperclips too (it is not an editor\'s control)', !!vclip('a1') && !!vclip('a3')
      && v.$$('[data-pr]').length === 0);
    assert('  with the count', vclip('a1').textContent === CLIP + '3' && vclip('a1').title === '3 attached documents');
    assert('  and, with nothing attached, says so rather than offering to attach', vclip('a3').title === 'No documents attached');
    vclip('a1').click();
    await sleep(20);
    assert('  clicking it opens the line\'s documents (a viewer may list and download them)',
      dv.opened.length === 1 && dv.opened[0].line.id === 'a1' && dv.opened[0].line.project_id === 'p1', dv.opened);
    assert('  and saves nothing', v.patches().length === 0);

    // A status flag shares the cell: pill, then paperclip, then the flags.
    const f = makeEnv({ rows: [row({ id: 'f1', sca_status: 'Needed' })] });
    const df = withDocs(f, { counts: { f1: 1 } });
    await drawn(f);
    const fcell = f.$('tr[data-row="f1"] td.c-status');
    const fclip = fcell && fcell.querySelector('.fctproc-clip');
    assert('a line with a status flag keeps its paperclip, beside the pill, ahead of the agreement and the flags',
      !!fclip && fcell.classList.contains('flag-amber')
      && fcell.querySelector('.fctproc-pill').nextElementSibling === fclip
      && fclip.closest('.fctproc-part').nextElementSibling === fcell.querySelector('.c-sca_status')
      && fclip.textContent === CLIP + '1', fcell && fcell.innerHTML);
    assert('  the agreement tag and the Status filter read the status alone, not the paperclip',
      /Agmt needed/.test(fcell.querySelector('.fctproc-scatag').textContent) && f.P._test.fieldValue(f.P._test.state().rows[0], 'status', C()) === 'Not Ordered');
    fclip.click();
    await sleep(20);
    assert('  and it opens that line\'s documents', df.opened.length === 1 && df.opened[0].line.id === 'f1');
  }

  console.log('\n[a page with no document hooks]');
  {
    const e = makeEnv({ rows: [row({ id: 'n1', cost_code: 'Stormwater' })] });
    await drawn(e);
    const cell = () => e.$('tr[data-row="n1"] td.c-status');
    const clipIn = () => cell().querySelector('.fctproc-clip');
    assert('the Status cell has its pill and no paperclip, and nothing failed', !!cell() && !!cell().querySelector('.fctproc-pill')
      && !clipIn() && !e.$('[data-act="files"]') && e.$$('tr.fctproc-row').length === 1);
    assert('  no folder chip on the sections', !!e.$('tr.fctproc-grp') && !e.$('[data-grpdocs]'));
    await e.P.refresh();
    assert('  a refresh asks nothing of the page and still works', e.$$('tr.fctproc-row').length === 1
      && (await e.P.refreshAttachmentCounts()) === false);
    e.P.configure({ attachmentCount: () => 4 });
    e.P.rerender();
    assert('a count with nothing to open the documents draws no button that would do nothing', !clipIn());
    e.P.configure({ openAttachments: () => {}, attachmentCount: () => { throw new Error('not loaded'); } });
    e.P.rerender();
    assert('a count that throws reads as none, and the row still draws', !!clipIn() && clipIn().textContent === CLIP
      && e.$$('tr.fctproc-row').length === 1);
    e.P.configure({ attachmentCount: () => 'lots' });
    e.P.rerender();
    assert('  so does one that is not a number', clipIn().textContent === CLIP);
    e.P.configure({ attachmentCount: () => -2 });
    e.P.rerender();
    assert('  or a negative one', clipIn().textContent === CLIP);
    e.P.configure({ openCostCodeFolder: () => {}, costCodeDocCount: () => { throw new Error('not loaded'); } });
    e.P.rerender();
    assert('a folder count that throws: the chip, with no number', !!e.$('[data-grpdocs]') && e.$('[data-grpdocs]').textContent === FOLDER);
    e.P.configure({ openAttachments: () => { throw new Error('dialog broke'); } });
    e.$('[data-act="files"]').click();
    await sleep(20);
    assert('an opener that throws is logged, not left to break the sheet', e.warns.some(w => /could not open the attachments/.test(w))
      && e.$$('tr.fctproc-row').length === 1);
  }

  console.log('\n[the paperclip saves a Sub Code just picked, first]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'm1' }),
      row({ id: 'm2', created_at: '2026-03-01T10:00:01Z' }),
      row({ id: 'm3', cost_code: '  Stormwater  ', created_at: '2026-03-01T10:00:02Z' }),
      // A bid row whose line was renamed on the bid since: the line's codes are the live ones.
      row({ id: 'm4', source: 'bid', bid_item_id: 'b3', cost_code: 'Erosion (old)', sub_code: 'Silt sock', created_at: '2026-03-01T10:00:03Z' }),
      row({ id: 'm5', description: 'Type M inlet grate', created_at: '2026-03-01T10:00:04Z' }),
      row({ id: 'm6', created_at: '2026-03-01T10:00:05Z' }),
    ] });
    const d = withDocs(e);
    await drawn(e);
    const clip = id => e.$(`tr[data-row="${id}"] [data-act="files"]`);

    const box = e.field('m1', 'codes');
    box.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(box, 'Stormwater / Geofabric', 'b1');
    const sentFor = id => e.patches().filter(c => c.q.id === id).length;
    assert('a Sub Code picked is waiting for the quiet spell', e.P._test.pending().pend.has('m1') && sentFor('m1') === 0);
    clip('m1').click();
    await sleep(60);
    assert('clicking the paperclip sends it at once, and opens the documents only once it is saved',
      d.opened.length === 1 && d.opened[0].patches === 1 && d.opened[0].saved.bid_item_id === 'b1' && d.opened[0].saved.cost_code === 'Stormwater',
      d.opened[0]);
    assert('  the line handed over: its id, job, live codes and what to call it',
      eq(d.opened[0].line, { id: 'm1', project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Geofabric', label: 'Stormwater / Geofabric' }), d.opened[0].line);

    // Pressing the paperclip is what leaves the Sub Code box, and the page's
    // combobox commits 120 ms after that: the click comes first.
    const box2 = e.field('m2', 'codes');
    box2.focus();
    box2.value = 'Stormwater / Elbows';
    box2.dataset.cbValue = 'b6';
    e.fire(box2, 'input');
    const clip2 = clip('m2');
    clip2.focus();
    assert('leaving the box marks it as about to commit', box2.dataset.pcommit === '1');
    clip2.click();
    clip2.click();
    await sleep(70);
    assert('  while it is still committing, nothing is opened', d.opened.length === 1 && sentFor('m2') === 0);
    e.fire(box2, 'change');               // the combobox's commit, as tracker's cbCommitInput sends it
    await sleep(150);
    assert('  once it has committed, the pick is saved, and only then are the documents opened — once, for two clicks',
      d.opened.length === 2 && d.opened[1].saved.bid_item_id === 'b6' && d.opened[1].patches === 1
      && d.opened[1].line.cost_code === 'Stormwater' && d.opened[1].line.sub_code === 'Elbows', d.opened.slice(1));

    clip('m3').click();
    await sleep(20);
    assert('the cost code is handed over trimmed', d.opened[2] && d.opened[2].line.cost_code === 'Stormwater' && d.opened[2].line.label === 'Stormwater', d.opened[2]);
    clip('m4').click();
    await sleep(20);
    assert('a row on a bid line renamed since: the line\'s codes as the sheet shows them, not the stored copy',
      d.opened[3] && d.opened[3].line.cost_code === 'E&S' && d.opened[3].line.sub_code === 'Silt Sock 12inch'
      && d.opened[3].line.label === 'E&S / Silt Sock 12inch', d.opened[3]);
    clip('m5').click();
    await sleep(20);
    assert('a line with no codes is called by its Material', d.opened[4] && d.opened[4].line.label === 'Type M inlet grate'
      && d.opened[4].line.cost_code === '' && d.opened[4].line.sub_code === '', d.opened[4]);
    e.P.configure({ hiddenColumns: ['description'] });
    e.P.rerender();
    clip('m5').click();
    await sleep(20);
    assert('  but not when the page hides that column: then just "Procurement line"', d.opened[5] && d.opened[5].line.label === 'Procurement line', d.opened[5]);
    e.P.configure({ hiddenColumns: [] });
    e.P.rerender();

    // A save that fails: the message says so, and the documents open anyway.
    e.db.failPatch = 1;
    const box6 = e.field('m6', 'codes');
    box6.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(box6, 'E&S / Silt Sock 12inch', 'b3');
    const errorsBefore = e.errors.length;
    clip('m6').click();
    await sleep(60);
    assert('a pick whose save fails: said, and the documents still open (the file follows the code once it is saved)',
      d.opened.length === 7 && e.errors.length > errorsBefore && e.P._test.pending().failed.has('m6'), d.opened.length);
    e.db.failPatch = 0;
  }

  console.log('\n[a line re-coded: the counts are read again at once]');
  {
    // The server moves a line's files to its new cost code's folder before it
    // answers the save (api/procurement.js). The section chips are counted
    // again as soon as the save lands, rather than up to a poll later — but
    // only when the line has something attached to move.
    const e = makeEnv({ rows: [
      row({ id: 'q1', cost_code: 'Stormwater' }),
      row({ id: 'q2', cost_code: 'Stormwater', created_at: '2026-03-01T10:00:01Z' }),
      row({ id: 'q3', cost_code: 'E&S', created_at: '2026-03-01T10:00:02Z' }),
    ] });
    const d = withDocs(e, { counts: { q1: 1 }, cc: { Stormwater: 1 } });
    await drawn(e);
    const read = d.asks.length;
    assert('reading the rows asked once', read === 1, d.asks);
    const settleSaves = async () => { await e.P._test.flushAll(); await tick(); await tick(); await sleep(10); };

    const box2 = e.field('q2', 'codes');
    box2.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(box2, 'E&S / Silt Sock 12inch', 'b3');
    await settleSaves();
    assert('a Sub Code picked on a line with nothing attached is saved, and asks for no counts',
      e.patches().filter(c => c.q.id === 'q2').length === 1 && d.asks.length === read, d.asks);

    d.nextCc = { Stormwater: 0, 'E&S': 1 };
    const box1 = e.field('q1', 'codes');
    box1.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(box1, 'E&S / Silt Sock 12inch', 'b3');
    const sentAt = e.calls.length;
    await settleSaves();
    assert('a Sub Code picked on a line with a file attached asks for the counts as soon as the save lands',
      d.asks.length === read + 1 && d.asks[d.asks.length - 1] === 'p1'
        && e.calls.slice(sentAt - 1).some(c => c.method === 'PATCH' && c.q.id === 'q1'), d.asks);
    const esChip = e.$('[data-grpdocs="E&S"]');
    assert('…and the section chip the file moved to shows it', esChip && esChip.textContent === FOLDER + '1',
      esChip && esChip.textContent);

    const v = e.field('q1', 'vendor');
    v.focus(); v.value = 'Acme Supply'; e.fire(v, 'input'); e.fire(v, 'change'); v.blur();
    await settleSaves();
    assert('a save of another cell on that line asks for nothing',
      e.patches().some(c => c.q.id === 'q1' && 'vendor' in c.body.fields) && d.asks.length === read + 1, d.asks);
  }

  console.log('\n[re-links and restores move files: the counts are read again]');
  {
    const OLD = [
      { id: 'o1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
      { id: 'o3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', unit: 'LF', quantity: 1200, index: 1 },
    ];
    const RROWS = () => [
      row({ id: 'g1', source: 'bid', bid_item_id: 'o1', cost_code: 'Stormwater', sub_code: 'Geofabric', created_at: '2026-03-01T00:00:01Z' }),
      row({ id: 'g3', source: 'bid', bid_item_id: 'o3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', created_at: '2026-03-01T00:00:03Z',
        deleted_at: '2026-03-02T00:00:00Z' }),
    ];
    // The re-link the tab runs as it loads, on a job whose bid was replaced.
    // Only rows whose cost AND sub code match a new line re-link, so the new
    // lines carry the old codes; the bid page renames them afterwards.
    const SAME = OLD.map(l => ({ ...l, id: 'N' + l.id }));
    const a = makeEnv({ rows: RROWS(), bidLines: SAME });
    const da = withDocs(a, { counts: { g1: 2 } });
    a.P.renderTab(a.root);
    await sleep(60);
    assert('a re-link of a line with files attached asks for the counts again, after the PATCH',
      a.patches().some(p => p.q.id === 'g1') && da.asks.length === 2 && da.asks.every(p => p === 'p1'), da.asks);
    const n = makeEnv({ rows: RROWS(), bidLines: SAME });
    const dn = withDocs(n, { counts: {} });
    n.P.renderTab(n.root);
    await sleep(60);
    assert('…and of lines with nothing attached, asks nothing more than the read of the rows',
      n.patches().some(p => p.q.id === 'g1') && dn.asks.length === 1, dn.asks);

    // A deleted line ticked in Add to Procurement comes back on its line's
    // replacement. The sheet cannot tell from here whether the server's
    // copy of that line moved the code (the bid page may have renamed it
    // since), so a line with files attached is counted again either way.
    const s = makeEnv({ rows: RROWS(), bidLines: SAME });
    const ds = withDocs(s, { counts: { g3: 1 } });
    s.P.renderTab(s.root);
    await sleep(40);
    const asked = ds.asks.length;
    await s.P.openSendModal('p1');
    const silt = s.$$('.fctproc-modal .fctproc-send-line').find(l => l.querySelector('.sub').textContent === 'Silt Sock 12inch');
    silt.querySelector('input').checked = true;
    s.fire(silt.querySelector('input'), 'change');
    s.$('.fctproc-modal [data-send="go"]').click();
    await sleep(60);
    const sent = s.calls.filter(c => c.q.action === 'send').pop();
    assert('a line with a file attached, restored onto a new bid line, asks for the counts again',
      sent && eq(sent.body.restore_ids, [{ id: 'g3', bid_item_id: 'No3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }])
        && ds.asks.length === asked + 1, { asks: ds.asks, sent: sent && sent.body });
  }

  console.log('\n[a cost-code section\'s folder chip]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'g1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', vendor: 'Acme Supply' }),
      row({ id: 'g2', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', vendor: 'LB Water', created_at: '2026-03-01T10:00:01Z' }),
      row({ id: 'g3', description: 'odd part', created_at: '2026-03-01T10:00:02Z' }),
    ] });
    const d = withDocs(e, { cc: { Stormwater: 3 } });
    await drawn(e);
    const head = key => e.$(`tr.fctproc-grp[data-grp="${key}"]`);
    const chip = key => e.$(`tr.fctproc-grp[data-grp="${key}"] [data-grpdocs]`);
    const st = e.P._test.state();
    assert('a cost-code section has a folder chip, with what its folder holds',
      !!chip('c:stormwater') && chip('c:stormwater').textContent === FOLDER + '3' && chip('c:stormwater').classList.contains('has')
      && chip('c:stormwater').dataset.grpdocs === 'Stormwater' && /^3 documents filed under cost code Stormwater/.test(chip('c:stormwater').title),
      chip('c:stormwater') && [chip('c:stormwater').textContent, chip('c:stormwater').title]);
    assert('  an empty folder: the chip, with no number', chip('c:e&s') && chip('c:e&s').textContent === FOLDER
      && !chip('c:e&s').classList.contains('has') && chip('c:e&s').title === 'Open the document folder for cost code E&S');
    assert('"No cost code" has none: no folder is made for a blank code', !!head('c:') && !chip('c:'));
    assert('  counted for this job, by the section\'s code', d.ccArgs.some(([p, c]) => p === 'p1' && c === 'Stormwater'));
    chip('c:stormwater').click();
    assert('clicking it opens that cost code\'s folder on this job', eq(d.folders, [{ projectId: 'p1', costCode: 'Stormwater' }]), d.folders);
    assert('  and does not fold the section', st.collapsed.size === 0 && !!e.$('tr[data-row="g1"]'));

    const k = chip('c:stormwater');
    assert('it is a real button, reached with Tab', k.tagName === 'BUTTON' && k.type === 'button');
    k.focus();
    for (const key of ['Enter', ' ']) {
      k.dispatchEvent(new e.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      k.dispatchEvent(new e.w.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      k.click();                          // what Enter / Space on a button do
    }
    assert('  Enter and Space on it open the folder and fold nothing', d.folders.length === 3 && st.collapsed.size === 0
      && !!e.$('tr[data-row="g1"]') && e.w.document.activeElement === k);
    d.cc.Stormwater = 4;
    e.P.rerender();
    assert('  its count follows the page\'s, and the focus stays on it', e.w.document.activeElement === k && k.isConnected
      && k.textContent === FOLDER + '4' && /^4 documents/.test(k.title));
    e.$('[data-chip="all"]').click();      // a whole-table redraw
    assert('  …through a whole-table redraw too', e.w.document.activeElement && e.w.document.activeElement.dataset.grpdocs === 'Stormwater');
    head('c:stormwater').querySelector('.tw').click();
    assert('the header itself still folds the section', st.collapsed.has('c:stormwater') && !e.$('tr[data-row="g1"]'));
    head('c:stormwater').querySelector('.tw').click();

    e.$('[data-group="vendor"]').click();
    assert('a vendor section has no folder chip (it mixes cost codes)', e.$$('tr.fctproc-grp').length === 3 && !e.$('[data-grpdocs]'));
    e.$('[data-group="none"]').click();
    assert('  nor is there one with no grouping', !e.$('tr.fctproc-grp') && !e.$('[data-grpdocs]'));
    e.$('[data-group="cost"]').click();

    const v = makeEnv({ perm: { canView: true, canEdit: false }, rows: [row({ id: 'g1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' })] });
    const dv = withDocs(v, { cc: { Stormwater: 2 } });
    await drawn(v);
    const vk = v.$('[data-grpdocs="Stormwater"]');
    assert('a viewer has the chip too', !!vk && vk.textContent === FOLDER + '2' && !v.$('[data-grpadd]'));
    vk.click();
    assert('  and it opens the folder', eq(dv.folders, [{ projectId: 'p1', costCode: 'Stormwater' }]) && v.P._test.state().collapsed.size === 0);
  }

  console.log('\n[the counts are read with the rows, and redrawn where they changed]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'k1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row({ id: 'k2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', created_at: '2026-03-01T10:00:01Z' }),
      row({ id: 'k3', created_at: '2026-03-01T10:00:02Z' }),
    ] });
    const d = withDocs(e, { counts: { k1: 1 }, cc: { Stormwater: 1 } });
    d.hold = true;
    await drawn(e);
    const clip = id => e.$(`tr[data-row="${id}"] [data-act="files"]`);
    const tr = id => e.$(`tr[data-row="${id}"]`);
    const chip = () => e.$('[data-grpdocs="Stormwater"]');
    assert('reading the job\'s rows asks the page for its counts', eq(d.asks, ['p1']), d.asks);
    assert('  the sheet is drawn meanwhile from the counts in hand', clip('k1').textContent === CLIP + '1' && clip('k2').textContent === CLIP);
    const before = { k1: tr('k1'), k2: tr('k2'), k3: tr('k3'), chip: chip() };
    d.next = { k1: 1, k2: 2 };
    d.nextCc = { Stormwater: 3 };
    d.release();
    await tick(); await tick();
    assert('once they are in, the paperclip whose count moved shows it, green', clip('k2').textContent === CLIP + '2'
      && clip('k2').classList.contains('has') && clip('k2').title === '2 attached documents');
    assert('  that row alone is redrawn; the rest are left as they were', tr('k1') === before.k1 && tr('k3') === before.k3 && tr('k2') !== before.k2);
    assert('  and the section\'s folder chip shows the new count, in place', chip() === before.chip && chip().textContent === FOLDER + '3'
      && chip().classList.contains('has'));

    d.hold = false;
    const still = { k1: tr('k1'), k2: tr('k2'), k3: tr('k3'), chip: chip() };
    await e.P.refresh();
    await tick(); await tick();
    assert('every poll of the rows asks again', eq(d.asks, ['p1', 'p1']), d.asks);
    assert('  counts that did not move redraw nothing', tr('k1') === still.k1 && tr('k2') === still.k2 && tr('k3') === still.k3
      && chip() === still.chip);

    d.counts = { k1: 1, k2: 2, k3: 5 };
    d.cc = { Stormwater: 4 };
    e.P.rerender();
    assert('a rerender (the page\'s counts moved after a document was attached) draws the new counts',
      clip('k3').textContent === CLIP + '5' && chip().textContent === FOLDER + '4');

    // A count that lands while a cell of the same row is being typed in.
    const qty = e.field('k2', 'quantity');
    qty.focus();
    qty.value = '12';
    e.fire(qty, 'input');
    d.next = { k1: 1, k2: 7, k3: 5 };
    const ok = await e.P.refreshAttachmentCounts();
    assert('the page can ask for the counts again itself', ok === true && d.asks.length === 3);
    assert('  a row being typed in gets its new count, and keeps the box being typed in', clip('k2').textContent === CLIP + '7'
      && e.field('k2', 'quantity') === qty && e.w.document.activeElement === qty && qty.value === '12');
    qty.blur();
    await e.P._test.flushAll();

    // Held while a press in the sheet is down, so the paperclip under the
    // pointer is not replaced before the click lands on it.
    d.next = { k1: 9, k2: 7, k3: 5 };
    clip('k1').dispatchEvent(new e.w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    const pressed = clip('k1');
    await e.P.refreshAttachmentCounts();
    assert('a count that lands while the mouse is down on the sheet waits', clip('k1') === pressed && pressed.textContent === CLIP + '1');
    e.w.document.dispatchEvent(new e.w.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await sleep(5);
    assert('  and is drawn once the button is up', clip('k1').textContent === CLIP + '9');

    d.fail = true;
    const failedRead = await e.P.refreshAttachmentCounts();
    assert('a count that could not be read leaves the numbers drawn, with a warning', failedRead === false
      && clip('k1').textContent === CLIP + '9' && e.warns.some(w => /could not read the attachment counts/.test(w)));
    d.fail = false;

    // Another job opened before the counts came back: they are not drawn
    // over it, and its own read asks for its own.
    d.hold = true;
    const askedP1 = e.P.refreshAttachmentCounts();
    await tick();
    const releaseP1 = d.release;
    d.hold = false;
    e.P._test.selectProject('p2');
    await tick(); await tick(); await tick();
    if (releaseP1) releaseP1();
    assert('a count that comes back for a job no longer open is dropped', typeof releaseP1 === 'function' && (await askedP1) === false);
    await tick(); await tick();
    assert('  and the job opened asks for its own', d.asks[d.asks.length - 1] === 'p2', d.asks);
  }

  // ── A site: several jobs on one sheet ─────────────────────────────────
  // The Hempfield fields: each its own job (own bid, rows, POs, costs), the
  // same Site typed on each, bought for at one time. The two live fields'
  // bids were copied from one another, so they carry the SAME line ids and
  // codes — a row must only ever be matched against its own job's.
  console.log('\n[site — several jobs on one sheet]');
  {
    const SP = [
      { id: 'h1', 'project-name': 'Hempfield Baseball', 'job-number': '26057', status: 'In Progress', site: 'Hempfield' },
      { id: 'h2', 'project-name': 'Hempfield Softball', 'job-number': '26058', status: 'Awarded', site: ' hempfield ' },
      { id: 'h3', 'project-name': 'Hempfield Founders Park', 'job-number': '26090', status: 'Complete', site: 'Hempfield' },
      { id: 'p1', 'project-name': 'Penn Cambria Field', 'job-number': '2614', status: 'In Progress' },
    ];
    const SL = {
      h1: [{ id: 'L1', cost_code: 'Storm Water', sub_code: 'Geofabric', unit: 'SF', quantity: 8000, index: 0 },
           { id: 'L2', cost_code: 'Storm Water', sub_code: '15" Elbows', unit: 'EA', quantity: 3, index: 1 }],
      h2: [{ id: 'L1', cost_code: 'Storm Water', sub_code: 'Geofabric', unit: 'SF', quantity: 5000, index: 0 },
           { id: 'L2', cost_code: 'Storm Water', sub_code: '15" Elbows', unit: 'EA', quantity: 2, index: 1 }],
      h3: [{ id: 'L1', cost_code: 'Storm Water', sub_code: 'Geofabric', unit: 'SF', quantity: 100, index: 0 }],
      p1: LINES,
    };
    const SPOS = [
      // Baseball's Geofabric is on an order; Softball's is not.
      { id: 'hpo1', po_number: 'PO-2601', project_id: 'h1', cost_code: 'Storm Water', sub_code: 'Geofabric', supplier: 'LB Water', date_created: '2026-03-01', status: 'pending' },
    ];
    const SR = [
      row({ id: 'a1', project_id: 'h1', source: 'bid', bid_item_id: 'L1', cost_code: 'Storm Water', sub_code: 'Geofabric', quantity: 8000, unit: 'SF',
        bid_qty_at_send: 8000, bid_unit_at_send: 'SF', vendor: 'LB Water', quote_number: '224818', created_at: '2026-03-01T00:00:00Z' }),
      row({ id: 'a2', project_id: 'h1', source: 'bid', bid_item_id: 'L2', cost_code: 'Storm Water', sub_code: '15" Elbows', quantity: 3, unit: 'EA',
        bid_qty_at_send: 3, bid_unit_at_send: 'EA', vendor: 'LB Water', quote_number: '224818', created_at: '2026-03-01T00:00:01Z' }),
      row({ id: 'b1', project_id: 'h2', source: 'bid', bid_item_id: 'L1', cost_code: 'Storm Water', sub_code: 'Geofabric', quantity: 5000, unit: 'SF',
        bid_qty_at_send: 5000, bid_unit_at_send: 'SF', vendor: 'LB Water', quote_number: '224818', created_at: '2026-03-01T00:00:02Z' }),
      row({ id: 'b2', project_id: 'h2', source: 'bid', bid_item_id: 'L2', cost_code: 'Storm Water', sub_code: '15" Elbows', quantity: 2, unit: 'EA',
        bid_qty_at_send: 2, bid_unit_at_send: 'EA', vendor: 'LB Water', quote_number: '224818', created_at: '2026-03-01T00:00:03Z' }),
      row({ id: 'c1', project_id: 'h3', source: 'bid', bid_item_id: 'L1', cost_code: 'Storm Water', sub_code: 'Geofabric', quantity: 100, unit: 'SF',
        bid_qty_at_send: 100, bid_unit_at_send: 'SF', created_at: '2026-03-01T00:00:04Z' }),
    ];
    const e = makeEnv({ rows: SR, purchaseOrders: SPOS.map(p => ({ ...p })), storage: { fct_proc_project_turf: 'p1' } });
    e.P.configure({ getProjects: () => SP, getProject: id => SP.find(p => p.id === id) || null, getBidLines: id => SL[id] || [] });
    const T2 = e.P._test;

    // The picker.
    const opts = e.P.cbOptions('proc_projects');
    const siteOpt = opts.find(o => o.value === 'site:hempfield');
    assert('the picker offers the site, beside its jobs', !!siteOpt && siteOpt.label === 'Hempfield — all 2 jobs'
      && opts.some(o => o.value === 'h1') && opts.some(o => o.value === 'h2'), opts);
    assert('  a Site typed with other spacing or case is the same site', siteOpt && /#26057, #26058/.test(siteOpt.meta), siteOpt);
    assert('  the finished field is left off, as it is off the picker', siteOpt && !/26090/.test(siteOpt.meta));
    assert('  typing a job number finds the site too', e.P.cbFilter('proc_projects', '26058', opts).some(o => o.value === 'site:hempfield'));
    assert('a job with no Site gets no site entry', !opts.some(o => o.value.startsWith('site:') && o.value !== 'site:hempfield'));

    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const pickerEl = e.$('#fctproc-proj');
    e.pick(pickerEl, siteOpt.label, siteOpt.value);
    await sleep(20);
    const gets = e.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement' && !c.q.include_deleted).map(c => c.q.project_id);
    assert('opening the site reads each of its jobs', gets.includes('h1') && gets.includes('h2') && !gets.includes('h3'), gets);
    assert('  and is remembered', e.store.fct_proc_project_turf === 'site:hempfield');
    assert('the head names the site and its jobs', /Hempfield/.test(e.$('.fctproc-head').textContent)
      && /Hempfield Baseball\s*#26057/.test(e.$('.fctproc-head').textContent) && /Hempfield Softball\s*#26058/.test(e.$('.fctproc-head').textContent),
      e.$('.fctproc-head').textContent.replace(/\s+/g, ' '));
    const sheaders = e.$$('.fctproc-table th').map(th => th.dataset.label || '');
    assert('a Job column, after Status', sheaders[1] === 'Status' && sheaders[2] === 'Job', sheaders);
    assert('every row of both jobs, job by job', eq(e.$$('tr.fctproc-row').map(t => t.dataset.row), ['a1', 'a2', 'b1', 'b2']));
    const bands = e.$$('tr.fctproc-jobband');
    assert('a band per job, in order, each over its own cost-code section', bands.length === 2
      && /Hempfield Baseball/.test(bands[0].textContent) && /Job #26057/.test(bands[0].textContent)
      && /Hempfield Softball/.test(bands[1].textContent)
      && bands[0].nextElementSibling.classList.contains('fctproc-grp') && /Storm Water/.test(bands[0].nextElementSibling.textContent)
      && bands[1].nextElementSibling.classList.contains('fctproc-grp') && /Storm Water/.test(bands[1].nextElementSibling.textContent),
      e.$$('tr.fctproc-grp').map(t => t.textContent.replace(/\s+/g, ' ')));
    assert('  each band counts its own job', /2 rows · 1 not ordered/.test(bands[0].textContent) && /2 rows · 2 not ordered/.test(bands[1].textContent),
      bands.map(b => b.textContent.replace(/\s+/g, ' ')));
    assert('the Job cell names the row\'s job', /Hempfield Softball/.test(e.$('tr[data-row="b1"] .c-job').textContent));
    // Each row against its own job's bid and POs.
    assert('a row matches its own job\'s PO (Baseball\'s Geofabric is ordered)', e.$('tr[data-row="a1"] .fctproc-pill').textContent === 'Ordered'
      && e.field('a1', 'po').value === 'PO-2601');
    assert('  and never a sister job\'s (Softball\'s Geofabric is not)', e.$('tr[data-row="b1"] .fctproc-pill').textContent === 'Not Ordered'
      && e.field('b1', 'po').value === '');
    assert('the bid lines are each job\'s own, though the ids are the same (no false "bid changed")',
      !e.$('tr[data-row="a1"] .fctproc-bidchg') && !e.$('tr[data-row="b1"] .fctproc-bidchg'));
    const sctx = T2.makeCtx();
    assert('  the row\'s codes come from its own bid', T2.liveCodes(T2.state().rows.find(r => r.id === 'b1'), sctx).line === SL.h2[0]
      && T2.liveCodes(T2.state().rows.find(r => r.id === 'a1'), sctx).line === SL.h1[0]);

    // Adding rows goes to a job.
    const posts = () => e.calls.filter(c => c.method === 'POST' && c.path === '/api/procurement' && !c.q.action);
    bands[1].querySelector('[data-grpadd]').click();
    await sleep(20);
    assert('a band\'s + Add Row adds to that job', posts().length === 1 && posts()[0].body.item.project_id === 'h2', posts().map(p => p.body));
    e.$('[data-act="add"]').click();
    await sleep(10);
    const which = e.$$('.fctproc-modal [data-choice]');
    assert('the head\'s + Add Row asks which job', which.length === 3 && /Hempfield Baseball \(#26057\)/.test(which[0].textContent)
      && /Hempfield Softball/.test(which[1].textContent) && /Cancel/.test(which[2].textContent));
    which[0].click();
    await sleep(20);
    assert('  and adds to the one picked', posts().length === 2 && posts()[1].body.item.project_id === 'h1');
    const grpBaseball = e.$$('tr.fctproc-grp:not(.fctproc-jobband)').find(t => t.previousElementSibling && t.previousElementSibling.dataset.jobband === 'h1');
    assert('a cost-code section\'s + Add Row adds under its code, on its job', !!grpBaseball);
    grpBaseball.querySelector('[data-grpadd]').click();
    await sleep(20);
    assert('  (Storm Water, Hempfield Baseball)', posts().length === 3 && posts()[2].body.item.project_id === 'h1'
      && posts()[2].body.item.cost_code === 'Storm Water', posts()[2] && posts()[2].body);
    // Tidy the hand-added rows away, so the rest of the section reads the four.
    const added = posts().map(p => p.body.item.id);
    e.db.rows = e.db.rows.filter(r => !added.includes(r.id));
    // (The new row's Quantity has focus, and a refresh never reads mid-edit.)
    if (e.w.document.activeElement && e.w.document.activeElement.blur) e.w.document.activeElement.blur();
    await e.P.refresh();
    await sleep(10);
    assert('(the four rows again)', e.$$('tr.fctproc-row').length === 4);

    // Folding a job folds its sections; its box ticks its rows.
    e.$('tr.fctproc-jobband[data-jobband="h1"]').click();
    assert('folding a job band hides its sections', !e.$('tr[data-row="a1"]') && !!e.$('tr[data-row="b1"]')
      && e.$$('tr.fctproc-jobband').length === 2);
    e.$('tr.fctproc-jobband[data-jobband="h1"]').click();
    const jbox = e.$('tr.fctproc-jobband[data-jobband="h2"] .fctproc-grpsel');
    jbox.checked = true;
    e.fire(jbox, 'change');
    assert('a band\'s box ticks every row of that job', e.P._test.state().selected.size === 2
      && e.P._test.state().selected.has('b1') && e.P._test.state().selected.has('b2'));

    // Bulk edit across jobs: one edit per job, each pinned to its own.
    const sel2 = id => { const b = e.$(`[data-sel="${id}"]`); b.checked = true; e.fire(b, 'change'); };
    sel2('a2');
    e.$('#fctproc-bulk-field').value = 'quote_number';
    e.fire(e.$('#fctproc-bulk-field'), 'change');
    e.$('#fctproc-bulk-val').value = 'Q-777';
    e.$('[data-act="bulk-apply"]').click();
    await sleep(40);
    const bulks = e.patches().filter(p => p.q.action === 'bulk');
    assert('a bulk edit across two jobs is one edit per job, each pinned to its job', bulks.length === 2
      && bulks.some(b => b.body.project_id === 'h1' && eq(b.body.ids, ['a2']))
      && bulks.some(b => b.body.project_id === 'h2' && eq(b.body.ids.slice().sort(), ['b1', 'b2'])), bulks.map(b => b.body));
    assert('  and lands on every row', ['a2', 'b1', 'b2'].every(id => e.db.rows.find(r => r.id === id).quote_number === 'Q-777'));
    const clearBtn = e.$('[data-act="bulk-clear"]');
    if (clearBtn) clearBtn.click();

    // Set PO in the bulk bar: a PO is one job's.
    sel2('a1');
    e.$('#fctproc-bulk-field').value = 'po';
    e.fire(e.$('#fctproc-bulk-field'), 'change');
    const poOpts = () => [...e.$('#fctproc-bulk-val').options].map(o => o.value);
    assert('Set PO on one job\'s rows offers that job\'s orders', poOpts().includes('hpo1'), poOpts());
    sel2('b1');
    assert('  across two jobs, only Auto and No PO', eq(poOpts(), ['__auto__', '__none__']), poOpts());
    e.$('#fctproc-bulk-field').value = 'vendor';
    e.fire(e.$('#fctproc-bulk-field'), 'change');
    e.$('[data-act="bulk-clear"]').click();

    // Create PO from selected: one per job, so each field carries its cost.
    sel2('a2'); sel2('b1'); sel2('b2');
    e.$('[data-act="bulk-po"]').click();
    await sleep(30);
    let ch = e.$$('.fctproc-modal [data-choice]');
    assert('rows on two jobs -> asked, saying each job gets its own PO', ch.length === 3
      && /are on <b>2<\/b> jobs/.test(e.$('.fctproc-modal [data-body]').innerHTML)
      && /Each job gets its own PO to LB Water/.test(e.$('.fctproc-modal [data-body]').textContent)
      && /One PO per job and sub code/.test(ch[0].textContent) && /One PO per job, each coded/.test(ch[1].textContent),
      e.$('.fctproc-modal') && e.$('.fctproc-modal').textContent.replace(/\s+/g, ' '));
    ch[1].click();
    await sleep(80);
    const sseeds = e.created.filter(c => c[0] === 'po').map(c => c[1]);
    assert('"one per job" makes one PO on each job', sseeds.length === 2 && sseeds[0].project_id === 'h1' && sseeds[1].project_id === 'h2'
      && sseeds.every(s => s.supplier === 'LB Water' && s.notes === 'Quote Q-777'), sseeds);
    const links = e.patches().filter(p => p.q.action === 'bulk').slice(-2);
    assert('  and each job\'s rows are linked to its own PO', links.length === 2
      && links.some(l => l.body.project_id === 'h1' && eq(l.body.ids, ['a2']) && l.body.fields.po_id === 'npo1')
      && links.some(l => l.body.project_id === 'h2' && eq(l.body.ids.slice().sort(), ['b1', 'b2']) && l.body.fields.po_id === 'npo2'),
      links.map(l => l.body));
    assert('  said in the toast', e.$$('.fctproc-toast').some(t => /Created 2 POs, each on its own job/.test(t.textContent)));

    // Grouped by vendor: one LB Water section across the site, Job column says whose.
    e.$('[data-group="vendor"]').click();
    // (a1 kept quote 224818; the bulk edit above put the other three on Q-777.)
    const vq = e.$$('tr.fctproc-grp').find(t => /Q-777/.test(t.textContent));
    const under = [];
    for (let n = vq && vq.nextElementSibling; n && !n.classList.contains('fctproc-grp'); n = n.nextElementSibling) under.push(n.dataset.row);
    assert('grouped by vendor: no job bands, and one supplier / quote section spans the jobs', !e.$('tr.fctproc-jobband')
      && !!vq && /3 rows/.test(vq.textContent) && eq(under, ['a2', 'b1', 'b2'])
      && /Hempfield Baseball/.test(e.$('tr[data-row="a2"] .c-job').textContent) && /Hempfield Softball/.test(e.$('tr[data-row="b1"] .c-job').textContent),
      e.$$('tr.fctproc-grp').map(t => t.textContent.replace(/\s+/g, ' ')));
    e.$('[data-group="cost"]').click();

    // Filter and search by job.
    e.$('#fctproc-search').value = 'softball';
    e.fire(e.$('#fctproc-search'), 'input');
    await sleep(5);
    assert('the search finds a job by name', eq(e.$$('tr.fctproc-row').map(t => t.dataset.row), ['b1', 'b2']), e.$$('tr.fctproc-row').map(t => t.dataset.row));
    e.$('[data-act="clear"]').click();

    // Exports carry the job.
    const csv = T2.buildCsv(e.P._test.state().rows.slice().sort((a, b) => a.id.localeCompare(b.id)), T2.makeCtx()).replace(/^﻿/, '').split('\r\n');
    assert('the CSV starts with a Job column', /^"Job","Status","PO #"/.test(csv[0]) && /^"Hempfield Baseball"/.test(csv[1]) && /^"Hempfield Softball"/.test(csv[3]), csv.slice(0, 4));
    const single = T2.buildCsv(e.P._test.state().rows.slice(0, 1), T2.makeCtx('h1')).replace(/^﻿/, '').split('\r\n');
    assert('  a job\'s own sheet has none', /^"Status"/.test(single[0]));
    e.$('[data-act="csv"]').click();
    assert('the file is named for the site', e.lastDownload === 'Procurement - Hempfield (site) - 2026-03-10.csv', e.lastDownload);
    const html = T2.buildPrintHtml(T2.makeCtx(), { printedAt: new Date('2026-03-10T12:00:00Z') });
    assert('the print view heads each job\'s sections with the job', /<tr class="job"><td colspan="\d+"><b>Hempfield Baseball<\/b>/.test(html)
      && /<tr class="job"><td colspan="\d+"><b>Hempfield Softball<\/b>/.test(html) && /Procurement — Hempfield \(site\)/.test(html)
      && /Jobs: Hempfield Baseball \(#26057\) · Hempfield Softball \(#26058\)/.test(html));

    // Add to Procurement is one job's bid.
    e.$('tr.fctproc-jobband[data-jobband="h2"] [data-grpsend]').click();
    await sleep(30);
    assert('a band\'s Add to Procurement opens that job\'s checklist', /Add to Procurement — Hempfield Softball/.test(e.$('.fctproc-modal').textContent));
    e.$('.fctproc-modal [data-send="cancel"]').click();
    await sleep(5);
    e.$('[data-act="send"]').click();
    await sleep(10);
    const sendWhich = e.$$('.fctproc-modal [data-choice]');
    assert('the head\'s Add to Procurement asks which job first', sendWhich.length === 3 && /Bring in the bid lines of which job/.test(e.$('.fctproc-modal').textContent));
    sendWhich[2].click();
    await sleep(5);

    // Show all jobs takes in the finished field.
    const before = e.calls.length;
    const all = e.$('#fctproc-showall');
    all.checked = true;
    e.fire(all, 'change');
    await sleep(30);
    const newGets = e.calls.slice(before).filter(c => c.method === 'GET' && c.path === '/api/procurement' && !c.q.include_deleted).map(c => c.q.project_id);
    assert('ticking Show all jobs reads the site again with its finished field', newGets.includes('h3') && e.$$('tr.fctproc-jobband').length === 3
      && !!e.$('tr[data-row="c1"]'), newGets);
    all.checked = false;
    e.fire(all, 'change');
    await sleep(30);
    assert('  and unticking lets it go again', !e.$('tr[data-row="c1"]') && e.$$('tr.fctproc-jobband').length === 2);

    // Back to a job: its own sheet, as before.
    e.P._test.selectProject('p1');
    await sleep(20);
    const pheaders = e.$$('.fctproc-table th').map(th => th.textContent.replace('▼', '').trim());
    assert('opening a job again: no Job column, no bands', !pheaders.includes('Job') && !e.$('tr.fctproc-jobband'));
  }

  // ── Material: the job's name for what is bought ─────────────────────────
  // The bid stays in the estimate's words ("Infill Crumb Rubber", "12\"
  // Concrete Curb") — what cost is tracked by. The sheet names what this job
  // actually buys ("20/40 Mesh rubber crumb infill"), and one bid line can be
  // bought as many materials. Material is that name; blank reads as the
  // row's Sub Code.
  console.log('\n[Material: the job\'s own name for what is bought, beside the codes it books to]');
  {
    assert('a row with a Material of its own is called by it (trimmed)',
      T.materialOf(row({ source: 'bid', bid_item_id: 'b1', description: '  8 oz nonwoven geotextile ' }), C()) === '8 oz nonwoven geotextile');
    assert('…a blank one reads as its bid line\'s CURRENT Sub Code, not the stored copy',
      T.materialOf(row({ source: 'bid', bid_item_id: 'b2', sub_code: 'Perf drain (old name)' }), C()) === '15" Perf drain');
    assert('…the stored copy once the line is gone from the bid', T.materialOf(row({ source: 'bid', bid_item_id: 'gone', sub_code: 'Inlet Type M' }), C()) === 'Inlet Type M');
    assert('…and blank on a row with neither', T.materialOf(row({}), C()) === '');
    assert('the Material filter and search read it as shown', T.fieldValue(row({ source: 'bid', bid_item_id: 'b1' }), 'description', C()) === 'Geofabric'
      && T.applyFilters([row({ id: 'm', source: 'bid', bid_item_id: 'b6', description: '15" TEE watertight w/ gasket' })], { search: 'tee gasket' }, C()).length === 1
      && T.applyFilters([row({ id: 'm', source: 'bid', bid_item_id: 'b6' })], { search: 'elbows' }, C()).length === 1);
    const two = (a, b) => ({ rows: [row({ id: 'a', description: a }), row({ id: 'b', description: b })], cost_code: 'Stormwater', sub_code: 'Geofabric' });
    assert('a PO for several rows that are all one Material is titled by it', T.poTitle(two('Mirafi 140N', 'mirafi 140n'), 'Acme Supply') === 'Mirafi 140N');
    assert('…several different ones, by the vendor as before', T.poTitle(two('Mirafi 140N', 'Staples'), 'Acme Supply') === 'Acme Supply materials'
      && T.poTitle(two('Mirafi 140N', ''), 'Acme Supply') === 'Acme Supply materials');
    assert('a line\'s documents are called by its Material, with the codes it books to',
      T.lineLabel(row({ description: '15" TEE watertight w/ gasket' }), { cost_code: 'Stormwater', sub_code: 'Elbows' }) === '15" TEE watertight w/ gasket — Stormwater / Elbows');
    assert('…and by the codes alone when it has none (or it is the Sub Code again)',
      T.lineLabel(row({}), { cost_code: 'Stormwater', sub_code: 'Elbows' }) === 'Stormwater / Elbows'
      && T.lineLabel(row({ description: 'elbows' }), { cost_code: 'Stormwater', sub_code: 'Elbows' }) === 'Stormwater / Elbows');
  }
  {
    // Names bought on earlier jobs (api/procurement.js materialLibrary).
    const LIB = [
      { material: '15" Elbow 45°', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'EA', vendor: 'LB Water', jobs: 2, last_used: '2026-02-01T00:00:00Z' },
      { material: '15" TEE watertight w/ gasket', sub_code: 'ELBOWS ', cost_code: 'stormwater', unit: 'EA', vendor: 'LB Water', jobs: 1, last_used: '2026-02-20T00:00:00Z' },
      { material: 'Perforated 15" SLCPP', sub_code: '15" Perf drain', cost_code: 'Stormwater', unit: 'LF', vendor: 'LB Water', jobs: 5, last_used: '2026-01-05T00:00:00Z' },
      { material: '8 oz nonwoven geotextile', sub_code: 'Geofabric', cost_code: 'Stormwater', unit: 'SY', vendor: 'Acme Supply', jobs: 4, last_used: '2026-01-04T00:00:00Z' },
      { material: '12" Filtration sock', sub_code: 'Silt Sock 12inch', cost_code: 'E&S', unit: 'LF', vendor: 'Frank Roberts', jobs: 6, last_used: '2025-12-01T00:00:00Z' },
    ];
    const e = makeEnv({ rows: [
      // A bid line, and the materials "+ Material" broke it into (each copies
      // the bid row's unit, with no quantity yet).
      row({ id: 'e1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 12, unit: 'EA', bid_qty_at_send: 12, bid_unit_at_send: 'EA' }),
      row({ id: 'e2', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', unit: 'EA', created_at: '2026-03-02T00:00:00Z' }),
      // On PO-0001 (matched by its codes) and with no vendor of its own.
      row({ id: 'g1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: 8110, unit: 'SF', bid_qty_at_send: 8110, bid_unit_at_send: 'SF' }),
      // + Add Row: nothing yet.
      row({ id: 'n1', created_at: '2026-03-03T00:00:00Z' }),
      // + Add Row on the Stormwater section: a cost code alone.
      row({ id: 'c1', cost_code: 'Stormwater', created_at: '2026-03-04T00:00:00Z' }),
      // Coded to a line the bid no longer has, whose sub code nothing was bought under.
      row({ id: 'o1', bid_item_id: 'gone', cost_code: 'Stormwater', sub_code: 'Inlet Type M', created_at: '2026-03-05T00:00:00Z' }),
    ] });
    e.db.materials = LIB;
    e.P.renderTab(e.root);
    await sleep(30);
    const gets = e.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement');
    assert('the library is read once, after the rows', gets.length === 2 && gets[0].q.project_id === 'p1' && gets[1].q.action === 'materials'
      && gets[1].q.division === 'turf' && !gets[1].q.project_id, gets.map(g => g.q));
    assert('…and kept', e.P._test.library().list.length === 5);
    await e.P.refresh();
    await sleep(10);
    assert('a poll does not read it again (it is read every few minutes at most)', e.calls.filter(c => c.q.action === 'materials').length === 1);

    const heads = e.$$('.fctproc-table th');
    const th = label => heads.find(h => h.dataset.label === label);
    assert('Material sits between Unit and the codes, and says what blank means', !!th('Material') && heads.indexOf(th('Material')) === heads.indexOf(th('Unit')) + 1
      && heads.indexOf(th('Cost Code / Sub Code')) === heads.indexOf(th('Material')) + 1 && /Blank shows the bid's Sub Code/.test(th('Material').title));
    assert('Sub Code says it is what the cost books to', /books to/.test(th('Cost Code / Sub Code').querySelector('[data-pff="sub_code"]').closest('.fctproc-hp').title));
    assert('a blank Material shows the bid\'s Sub Code as its placeholder', e.field('e1', 'description').placeholder === 'Elbows'
      && /Same as the bid's Sub Code \(Elbows\)/.test(e.field('e1', 'description').title));
    assert('…and a row with no codes asks what it is', e.field('n1', 'description').placeholder === 'What is it?');

    const labels = opts => opts.map(o => o.label);
    let opts = e.P.cbOptions('proc_materials:e2');
    assert('the picker opens on the names used under the row\'s Sub Code (most jobs first) — not its neighbours\' materials',
      eq(labels(opts), ['15" Elbow 45°', '15" TEE watertight w/ gasket']), labels(opts));
    assert('…each with what it was bought by and from, and how often',
      opts[0].meta === 'EA · LB Water · 2 jobs' && opts[1].meta === 'EA · LB Water · 1 job', opts.map(o => o.meta));
    const c1opts = e.P.cbOptions('proc_materials:c1');
    assert('a row with a cost code alone is offered its cost code\'s names, saying which sub code each was under',
      eq(labels(c1opts), ['Perforated 15" SLCPP', '8 oz nonwoven geotextile', '15" Elbow 45°', '15" TEE watertight w/ gasket'])
      && c1opts[0].meta === 'under 15" Perf drain · LF · LB Water · 5 jobs', c1opts.map(o => [o.label, o.meta]));
    assert('…and so is a row whose sub code nothing was bought under yet', eq(labels(e.P.cbOptions('proc_materials:o1')), labels(c1opts)));
    const n1opts = e.P.cbOptions('proc_materials:n1');
    assert('a row with no codes yet is offered the names used most, anywhere', n1opts.length === 5 && n1opts[0].label === '12" Filtration sock'
      && n1opts[0].meta === 'under E&S / Silt Sock 12inch · LF · Frank Roberts · 6 jobs', n1opts.map(o => [o.label, o.meta]));

    let f = e.P.cbFilter('proc_materials:e2', 'sock', opts);
    assert('typing searches every name, what was typed first (Enter must not swap it for a suggestion)',
      f[0].value === '__typed__' && f[0].label === 'sock' && eq(labels(f.slice(1)), ['12" Filtration sock']), f.map(o => [o.value, o.label]));
    f = e.P.cbFilter('proc_materials:e2', '  15" elbow 45° ', opts);
    assert('…unless it is one of them word for word: then that one, to pick', f.length === 1 && f[0].label === '15" Elbow 45°' && f[0].value.startsWith('__lib__:'), f);
    f = e.P.cbFilter('proc_materials:e2', 'lb water', opts);
    assert('…the vendor and unit beside a name are searched too', f.length >= 4 && f.slice(1).every(o => /LB Water/.test(o.meta)), labels(f));
    assert('…and an emptied box shows the row\'s list again', e.P.cbFilter('proc_materials:e2', '', opts) === opts);

    // Picking a name brings its unit and vendor into cells still blank.
    const pickName = async (id, label) => {
      const o = e.P.cbFilter('proc_materials:' + id, label, e.P.cbOptions('proc_materials:' + id)).find(x => x.label === label);
      const el = e.field(id, 'description');
      el.focus();
      e.pick(el, o.label, o.value);
      el.blur();
      await sleep(700);
      return e.patches().filter(p => p.q.id === id).pop();
    };
    let p = await pickName('e2', 'Perforated 15" SLCPP');
    assert('a "+ Material" row: the name, its unit over the one copied from the bid row (no quantity yet), and its vendor',
      p && eq(p.body.fields, { description: 'Perforated 15" SLCPP', unit: 'LF', vendor: 'LB Water' }), p && p.body);
    p = await pickName('e1', '15" TEE watertight w/ gasket');
    assert('a row with a quantity keeps its unit (the number is counted in it); the blank vendor is filled',
      p && eq(p.body.fields, { description: '15" TEE watertight w/ gasket', vendor: 'LB Water' }), p && p.body);
    p = await pickName('g1', '8 oz nonwoven geotextile');
    assert('a row already on a PO takes the name only: its order\'s supplier is its vendor',
      p && eq(p.body.fields, { description: '8 oz nonwoven geotextile' }) && e.db.rows.find(r => r.id === 'g1').vendor === '', p && p.body);
    assert('…and the cell shows the name', e.field('g1', 'description').value === '8 oz nonwoven geotextile');

    // A name typed here is offered on the next row at once, before any read.
    const el = e.field('e2', 'description');
    el.focus();
    e.pick(el, 'Flat drain 12in', '__typed__');
    el.blur();
    await sleep(700);
    opts = e.P.cbOptions('proc_materials:e1');
    const here = opts.find(o => o.label === 'Flat drain 12in');
    assert('a name typed on this sheet is offered under its Sub Code straight away', !!here, opts.map(o => [o.label, o.meta]));
    assert('…after the rest, as one this job already has', here && here.meta === 'LF · LB Water · already on this job' && opts[opts.length - 1] === here,
      opts.map(o => [o.label, o.meta]));
    assert('…a row\'s own picked name is no new entry (it is the library\'s)', opts.filter(o => o.label === '15" TEE watertight w/ gasket').length === 1);
    // Emptied, the row reads as its Sub Code again. (The commit redrew the
    // row, so its box is a new one.)
    const el2 = e.field('e2', 'description');
    assert('the committed name is in the redrawn box', el2 !== el && el2.value === 'Flat drain 12in');
    el2.focus();
    e.pick(el2, '', null);
    el2.blur();
    await sleep(700);
    assert('emptying Material saves it blank, and the row reads as the bid again', e.db.rows.find(r => r.id === 'e2').description === ''
      && e.field('e2', 'description').value === '' && e.field('e2', 'description').placeholder === 'Elbows');

    const m = e.P._test.exportMatrix(e.P._test.state().rows, e.P._test.makeCtx());
    const mi = m.header.indexOf('Material');
    assert('the Excel / CSV Material column: the job\'s names, a blank one as its Sub Code',
      eq(m.rows.map(r => r[mi].v).sort(), ['', '', '15" TEE watertight w/ gasket', '8 oz nonwoven geotextile', 'Elbows', 'Inlet Type M'].sort()), m.rows.map(r => r[mi].v));
    const html = e.P._test.buildPrintHtml(e.P._test.makeCtx());
    assert('…and the print view has it, ahead of the codes', /<th>Unit<\/th><th>Material<\/th><th>Sub Code<\/th>/.test(html) && /8 oz nonwoven geotextile/.test(html),
      (html.match(/<thead>.*?<\/thead>/s) || [''])[0]);
    assert('nothing went wrong on the way', !e.errors.length, e.errors);
  }
  {
    // A library that cannot be read is no failure: the cell takes typing.
    const e = makeEnv({ rows: [row({ id: 'w1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', unit: 'EA', quantity: 12 })] });
    e.db.failMaterials = true;
    e.P.renderTab(e.root);
    await sleep(30);
    assert('a library read that fails is only a warning', !e.errors.length && e.warns.some(w => /material library/.test(w)) && !!e.field('w1', 'description'), e.warns);
    const f = e.P.cbFilter('proc_materials:w1', '15" TEE', e.P.cbOptions('proc_materials:w1'));
    assert('…and the picker still takes what is typed', f.length === 1 && f[0].value === '__typed__');
    assert('…tried again on the next load', e.P._test.library().at === 0);
  }
  {
    const e = makeEnv({ perm: { canView: true, canEdit: false }, serverCanEdit: false, rows: [
      row({ id: 'v1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows' }),
      row({ id: 'v2', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', description: '8 oz nonwoven geotextile' }),
    ] });
    e.db.materials = [{ material: 'x', sub_code: 'Elbows', cost_code: 'Stormwater', unit: '', vendor: '', jobs: 1 }];
    e.P.renderTab(e.root);
    await sleep(30);
    const cell = id => e.$(`tr[data-row="${id}"] td.c-description`);
    assert('a viewer sees a blank Material as the Sub Code, greyed', cell('v1').textContent.trim() === 'Elbows' && !!cell('v1').querySelector('.fctproc-frombid')
      && /Same as the bid's Sub Code/.test(cell('v1').querySelector('.fctproc-frombid').title));
    assert('…and a named one as it is', cell('v2').textContent.trim() === '8 oz nonwoven geotextile' && !cell('v2').querySelector('.fctproc-frombid'));
    assert('…with no picker, and no library read (a viewer names nothing)', !e.field('v1', 'description') && !e.calls.some(c => c.q.action === 'materials'));
  }

  // ── The compact columns: a cell of several fields ───────────────────────
  console.log('\n[one cell, several fields: the parts around the one in use are redrawn]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'o1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', date_needed: '2026-04-20', lead_time_days: 5, vendor: 'Beta Corp' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const del = e.field('o1', 'date_delivered');
    del.focus();
    assert('Date Ordered starts blank (no PO matches the row)', e.field('o1', 'date_ordered').value === '' && !e.field('o1', 'date_ordered').classList.contains('derived'));
    e.cfg.getPurchaseOrders().push({ id: 'po8', po_number: 'PO-0008', project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Elbows', supplier: 'Beta Corp', date_created: '2026-03-08' });
    e.P.rerender();
    await tick();
    const ordNow = e.field('o1', 'date_ordered');
    assert('an order raised elsewhere shows its date in Date Ordered, in the same cell as the box in use', ordNow.value === '2026-03-08' && ordNow.classList.contains('derived'),
      [ordNow.value, ordNow.className]);
    assert('…while the Date Delivered box being used is the same box, still focused', e.field('o1', 'date_delivered') === del && e.w.document.activeElement === del);
    del.blur();

    // A field's own filter, from its place in the 2 × 2 header.
    e.$('th.c-ordering [data-pff="order_by"]').click();
    const vals = [...e.w.document.querySelectorAll('#fctproc-ff-list .fctproc-ff-val')].map(b => b.value);
    assert('the Order By filter button in the ordering header lists Order By dates', eq(vals, ['04/15/2026']), vals);
    e.$('#fctproc-filter-dd [data-ff="clear"]').click();
    e.P._test.state().filters = { date_delivered: new Set(['']) };
    e.P.rerender();
    assert('…and a filter set on one field marks that field\'s button only', e.$('th.c-ordering [data-pff="date_delivered"]').classList.contains('active')
      && !e.$('th.c-ordering [data-pff="order_by"]').classList.contains('active') && e.$$('tr.fctproc-row').length === 1);
    e.P._test.state().filters = {};
    e.P.rerender();
  }

  // ── "+ Material": copy a line's material list from another job ──────────
  console.log('\n[+ Material: copy the material list a bid line was bought as on another job]');
  {
    const BD = [
      { project_id: 'p2', last_used: '2026-03-01T00:00:00Z', items: [
        { id: 'x1', source: 'bid', material: 'Elbow 15" 90°', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 4, unit: 'EA', vendor: 'lb water' },
        { id: 'x2', source: 'manual', material: '15" TEE watertight w/ gasket', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 2, unit: 'EA', vendor: 'LB Water' },
        { id: 'x3', source: 'manual', material: '15" Elbow 45°', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 3, unit: 'EA', vendor: 'LB Water' },
        { id: 'x4', source: 'manual', material: 'Gasket lube', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 1, unit: 'GAL', vendor: 'Beta Corp' },
      ] },
      { project_id: 'p3', last_used: '2026-02-01T00:00:00Z', items: [
        { id: 'y1', source: 'manual', material: 'Elbow kit', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: null, unit: 'EA', vendor: '' },
      ] },
    ];
    const LIB2 = [
      { material: '15" Elbow 45°', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'EA', vendor: 'LB Water', jobs: 2 },
      { material: 'Elbow 15" 90°', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'EA', vendor: 'LB Water', jobs: 1 },
      { material: '15" TEE watertight w/ gasket', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'EA', vendor: 'LB Water', jobs: 1 },
      { material: 'Gasket lube', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'GAL', vendor: 'Beta Corp', jobs: 1 },
      { material: 'Elbow kit', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'EA', vendor: '', jobs: 1 },
    ];
    const mk = (rows, extra = {}) => {
      const e = makeEnv({ rows, ...extra });
      e.db.materials = LIB2;
      e.db.breakdowns = BD;
      return e;
    };
    const ROWS = () => [
      row({ id: 'd1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 12, unit: 'EA', bid_qty_at_send: 12, bid_unit_at_send: 'EA' }),
      row({ id: 'd2', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', description: '15" Elbow 45°', unit: 'EA', created_at: '2026-03-02T00:00:00Z' }),
      row({ id: 'g1', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: 8110, unit: 'SF', bid_qty_at_send: 8110, bid_unit_at_send: 'SF' }),
    ];
    const e = mk(ROWS());
    e.P.renderTab(e.root);
    await sleep(40);
    const btn = id => e.$(`tr[data-row="${id}"] [data-act="material"]`);
    assert('the rows are drawn before the library comes, and take their dots when it does (no second read)',
      e.calls.filter(c => c.q.action === 'materials').length === 1 && e.calls.findIndex(c => c.q.action === 'materials') > e.calls.findIndex(c => c.q.project_id === 'p1'));
    assert('"+ Material" on a line bought as materials on another job carries a dot, and says what it offers',
      !!btn('d1').querySelector('.fctproc-pastdot') && !!btn('d2').querySelector('.fctproc-pastdot') && /copy the list it was bought as on another job/.test(btn('d1').title));
    assert('…a line nothing was named under elsewhere has none', !btn('g1').querySelector('.fctproc-pastdot'));
    {
      const T2 = e.P._test, ctx = T2.makeCtx();
      const rowsNow = T2.state().rows;
      assert('a name only this job has is no list from another job', T2.hasPastList(rowsNow.find(r => r.id === 'd1'), ctx)
        && (e.db.materials = [{ ...LIB2[0], jobs: 1 }], T2.loadLibrary({ force: true }).then(() => true)));
      await sleep(10);
      assert('…(15" Elbow 45° is on 1 job: this one)', !T2.hasPastList(rowsNow.find(r => r.id === 'd1'), T2.makeCtx()));
      e.db.materials = LIB2;
      await T2.loadLibrary({ force: true });
    }

    // No list for the line: a blank row, as before, with no read.
    btn('g1').click();
    await sleep(40);
    let posts = e.calls.filter(c => c.method === 'POST');
    assert('on a line with no list, "+ Material" adds a blank row straight away', posts.length === 1 && !posts[0].q.action && posts[0].body.item.bid_item_id === 'b1'
      && !e.calls.some(c => c.q.action === 'breakdowns') && !e.$('.fctproc-modal'), posts.map(p => p.body));
    e.w.document.activeElement && e.w.document.activeElement.blur && e.w.document.activeElement.blur();

    // A list: the dialog.
    btn('d1').click();
    await sleep(40);
    const bget = e.calls.find(c => c.q.action === 'breakdowns');
    assert('on a line with a list, it reads the other jobs\' lists of its sub code, this job left out', bget && bget.q.sub_code === 'Elbows' && bget.q.exclude_project === 'p1', bget && bget.q);
    const dlg = e.$('.fctproc-modal');
    assert('…and opens the copy dialog for the line', !!dlg && /Add materials — Stormwater \/ Elbows/.test(dlg.textContent));
    const jobs = () => e.$$('.fctproc-modal [data-cj]');
    assert('…the jobs it was bought on, most recent first, the first picked', jobs().length === 2 && jobs()[0].checked
      && /Hempfield Stadium · Job #2588/.test(e.$$('.fctproc-modal .fctproc-copyjob')[0].textContent) && /4 materials · 03\/01\/2026/.test(e.$$('.fctproc-modal .fctproc-copyjob')[0].textContent));
    const lines = () => e.$$('.fctproc-modal [data-ci]').map(l => ({ name: l.querySelector('.sub').textContent, on: l.querySelector('input').checked,
      here: /already here/.test(l.textContent), own: !l.querySelector('.own').hidden, meta: l.querySelector('.qty').textContent }));
    let ls = lines();
    assert('…its materials, each ticked but one this job already has', eq(ls.map(l => [l.name, l.on, l.here]), [
      ['Elbow 15" 90°', true, false], ['15" TEE watertight w/ gasket', true, false], ['15" Elbow 45°', false, true], ['Gasket lube', true, false]]), ls);
    assert('…with what each was bought by, how much and from whom there', ls[3].meta === '1 GAL · Beta Corp' && ls[0].meta === '4 EA · lb water', ls.map(l => l.meta));
    assert('…the other job\'s own row names this line\'s own row (it has no name yet), said on it and in the count',
      ls[0].own && !ls[1].own && /2 new rows · names this line's own row/.test(e.$('.fctproc-modal [data-copy="count"]').textContent)
      && e.$('.fctproc-modal [data-copy="go"]').textContent === 'Add 3 materials');
    // The other job: its one material names the line's own row.
    jobs()[1].checked = true; e.fire(jobs()[1], 'change');
    ls = lines();
    assert('picking the other job shows its list instead', eq(ls.map(l => l.name), ['Elbow kit']) && ls[0].own
      && /0 new rows · names this line's own row/.test(e.$('.fctproc-modal [data-copy="count"]').textContent));
    jobs()[0].checked = true; e.fire(jobs()[0], 'change');
    assert('…and back, the ticks as they were', eq(lines().map(l => l.on), [true, true, false, true]));
    const none = e.$('.fctproc-modal [data-copy="none"]');
    none.click();
    assert('None unticks the list, and Add waits for a tick', lines().every(l => !l.on) && e.$('.fctproc-modal [data-copy="go"]').disabled);
    e.$('.fctproc-modal [data-copy="all"]').click();
    const lube = e.$('.fctproc-modal [data-cx="3"]');
    lube.checked = false; e.fire(lube, 'change');
    assert('All ticks every line, and one can be let go again', eq(lines().map(l => l.on), [true, true, true, false])
      && e.$('.fctproc-modal [data-copy="go"]').textContent === 'Add 3 materials');
    const qty = e.$('.fctproc-modal [data-copy="qty"]');
    qty.checked = true; e.fire(qty, 'change');
    e.$('.fctproc-modal [data-copy="go"]').click();
    // (A picker left a moment ago is still committing — 120 ms after it is
    // left; the new rows are drawn once it has, not under it.)
    await sleep(300);
    const add = e.calls.find(c => c.method === 'POST' && c.q.action === 'add');
    assert('Add sends the new rows in one request: this job\'s codes, the names, units, vendors (as the supplier list spells them) and, asked, quantities',
      add && add.body.project_id === 'p1' && eq(add.body.items.map(i => [i.bid_item_id, i.cost_code, i.sub_code, i.description, i.unit, i.vendor, i.quantity]), [
        ['b6', 'Stormwater', 'Elbows', '15" TEE watertight w/ gasket', 'EA', 'LB Water', 2],
        ['b6', 'Stormwater', 'Elbows', '15" Elbow 45°', 'EA', 'LB Water', 3]]) && add.body.items.every(i => /^[A-Za-z0-9_-]{1,64}$/.test(i.id)), add && add.body);
    assert('…the dialog closes, the rows are on the sheet under the line, and the PM is told',
      !e.$('.fctproc-modal') && add.body.items.every(i => !!e.$(`tr[data-row="${i.id}"]`)) && e.$$('.fctproc-toast').some(t => /Added 3 materials from Hempfield Stadium/.test(t.textContent)),
      e.$$('.fctproc-toast').map(t => t.textContent));
    await sleep(700);
    const own = e.patches().filter(p => p.q.id === 'd1').pop();
    assert('…and the line\'s own row is named after the other job\'s, with its quantity (asked for; the unit is the same) and vendor',
      own && eq(own.body.fields, { description: 'Elbow 15" 90°', quantity: 4, vendor: 'LB Water' }), own && own.body);
    const order = e.$$('tr.fctproc-row').map(t => t.dataset.row);
    assert('…the copied rows sit under the line, after its own rows', order.indexOf(add.body.items[0].id) > order.indexOf('d2') && order.indexOf(add.body.items[1].id) > order.indexOf(add.body.items[0].id)
      && order.indexOf('g1') < order.indexOf('d1'), order);
    assert('nothing went wrong on the way', !e.errors.length, e.errors);

    // Once the line's own row has a name, it is not renamed again.
    btn('d1').click();
    await sleep(40);
    assert('opened again: the names now here are let be, and nothing names the own row (it has a name)',
      eq(lines().map(l => [l.on, l.here, l.own]), [[false, true, false], [false, true, false], [false, true, false], [true, false, false]]), lines());
    e.$('.fctproc-modal [data-copy="blank"]').click();
    await sleep(40);
    posts = e.calls.filter(c => c.method === 'POST' && !c.q.action);
    assert('"Just a blank row" closes it and adds one blank row under the line', !e.$('.fctproc-modal') && posts.length === 2
      && posts[1].body.item.bid_item_id === 'b6' && !posts[1].body.item.description);
  }
  {
    // The answer to the add is lost: tried again with the same ids, each row goes in once.
    const e = makeEnv({ rows: [
      row({ id: 'd1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', description: 'Elbow 15" 90°', quantity: 12, unit: 'EA' }),
    ] });
    e.db.materials = [{ material: 'Gasket lube', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'GAL', vendor: 'Beta Corp', jobs: 1 }];
    e.db.breakdowns = [{ project_id: 'p2', last_used: '2026-03-01T00:00:00Z', items: [
      { id: 'x4', source: 'manual', material: 'Gasket lube', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 1, unit: 'GAL', vendor: 'Beta Corp' }] }];
    e.db.loseAdd = 1;
    e.P.renderTab(e.root);
    await sleep(40);
    e.$('tr[data-row="d1"] [data-act="material"]').click();
    await sleep(40);
    assert('a single-job list shows that job without a choice to make', !e.$('.fctproc-modal [data-cj]') && /Hempfield Stadium/.test(e.$('.fctproc-modal .fctproc-copyjob.single').textContent));
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(60);
    const adds = e.calls.filter(c => c.method === 'POST' && c.q.action === 'add');
    assert('an answer lost on the way back: sent again with the same ids', adds.length === 2 && eq(adds[0].body, adds[1].body));
    assert('…so the material is there once, and on the sheet once', e.db.rows.filter(r => r.description === 'Gasket lube').length === 1
      && e.$$('tr.fctproc-row').length === 2 && !e.$('.fctproc-modal') && !e.errors.length, e.errors);
  }
  {
    // The bid's whole-line quantity on the own row makes way for the
    // material's unit; the lists cannot be read: a blank row as before.
    const e = makeEnv({ rows: [
      row({ id: 'm1', source: 'bid', bid_item_id: 'b4', cost_code: 'General', sub_code: 'Mobilization', quantity: 1, unit: 'LS', bid_qty_at_send: 1, bid_unit_at_send: 'LS' }),
      row({ id: 'm2', source: 'bid', bid_item_id: 'b5', cost_code: 'General', sub_code: 'Labor', quantity: 30, unit: 'hr', bid_qty_at_send: 40, bid_unit_at_send: 'hr' }),
    ] });
    e.db.materials = [
      { material: 'Office trailer', sub_code: 'Mobilization', cost_code: 'General', unit: 'MO', vendor: 'Beta Corp', jobs: 2 },
      // Also bought under the line elsewhere, not copied here: the line still has a list to offer.
      { material: 'Portable generator', sub_code: 'Mobilization', cost_code: 'General', unit: 'MO', vendor: 'Beta Corp', jobs: 1 },
      { material: 'Laborer (temp)', sub_code: 'Labor', cost_code: 'General', unit: 'DAY', vendor: 'Beta Corp', jobs: 2 },
    ];
    e.db.breakdowns = [{ project_id: 'p2', last_used: '2026-03-01T00:00:00Z', items: [
      { id: 'z1', source: 'bid', material: 'Office trailer', cost_code: 'General', sub_code: 'Mobilization', quantity: 3, unit: 'MO', vendor: 'Beta Corp' },
      { id: 'z2', source: 'bid', material: 'Laborer (temp)', cost_code: 'General', sub_code: 'Labor', quantity: 10, unit: 'DAY', vendor: 'Beta Corp' }] }];
    e.P.renderTab(e.root);
    await sleep(40);
    e.$('tr[data-row="m1"] [data-act="material"]').click();
    await sleep(40);
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(700);
    let p = e.patches().filter(x => x.q.id === 'm1').pop();
    assert('the own row\'s 1 LS as the bid sent it makes way for the material\'s unit (no quantity copied)',
      p && eq(p.body.fields, { description: 'Office trailer', unit: 'MO', quantity: null, vendor: 'Beta Corp' }) && !e.calls.some(c => c.q.action === 'add'), p && p.body);
    e.db.breakdowns = [{ ...e.db.breakdowns[0], items: [e.db.breakdowns[0].items[1]] }];
    e.$('tr[data-row="m2"] [data-act="material"]').click();
    await sleep(40);
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(700);
    p = e.patches().filter(x => x.q.id === 'm2').pop();
    assert('…but a quantity the PM typed is theirs: kept, with its unit', p && eq(p.body.fields, { description: 'Laborer (temp)', vendor: 'Beta Corp' }), p && p.body);
    e.db.failBreakdowns = true;
    const before = e.calls.filter(c => c.method === 'POST').length;
    e.$('tr[data-row="m1"] [data-act="material"]').click();
    await sleep(40);
    const after = e.calls.filter(c => c.method === 'POST');
    assert('the lists cannot be read: "+ Material" adds a blank row, as it always did', after.length === before + 1 && !after[after.length - 1].q.action
      && !e.$('.fctproc-modal') && e.warns.some(w => /material lists of other jobs/.test(w)) && !e.errors.length);
  }
  {
    const e = makeEnv({ perm: { canView: true, canEdit: false }, serverCanEdit: false, rows: [
      row({ id: 'v1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows' })] });
    e.db.materials = [{ material: 'Gasket lube', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'GAL', vendor: '', jobs: 3 }];
    e.P.renderTab(e.root);
    await sleep(40);
    assert('a viewer has no "+ Material" to copy with', !e.$('tr[data-row="v1"] [data-act="material"]') && !e.$('.fctproc-pastdot'));
    const lead = e.$('tr[data-row="v1"] td.c-ordering .c-lead_time_days');
    assert('…and a blank Lead Time reads as nothing, not a lone "d"', lead.textContent.trim() === '' && !lead.querySelector('.fctproc-u'), lead.innerHTML);
  }

  console.log('\n[the Sub-Contractor Agreement in the Status cell; Vendor / Quote # and Contact / Email stacked]');
  {
    const e = makeEnv({ rows: [
      row({ id: 's1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', date_needed: '2026-05-20', vendor: 'Not A Listed Co', quote_number: 'Q-9' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const cell = () => e.$('tr[data-row="s1"] td.c-status');
    const sel = e.field('s1', 'sca_status');
    assert('the agreement is a picker of the four values, said in full in its menu', eq([...sel.options].map(o => [o.value, o.textContent]),
      [['Pending', 'Pending'], ['Needed', 'Needed'], ['Not Needed', 'Not needed'], ['Executed', 'Executed']]));
    assert('…and searching the words its tag shows finds the row', T.applyFilters([row({ id: 'g', sca_status: 'Needed' })], { search: 'agmt needed' }, C()).length === 1
      && T.applyFilters([row({ id: 'g', sca_status: 'Not Needed' })], { search: 'no agmt' }, C()).length === 1
      && T.applyFilters([row({ id: 'g', sca_status: 'Pending' })], { search: 'agmt needed' }, C()).length === 0);
    assert('…laid over its tag, which is what shows', sel.closest('.fctproc-scawrap').querySelector('.fctproc-scatag').getAttribute('aria-hidden') === 'true'
      && sel.getAttribute('aria-label') === 'Sub-Contractor Agreement' && !cell().classList.contains('flag-amber'));
    sel.focus();
    sel.value = 'Needed';
    e.fire(sel, 'change');
    assert('picking "Needed": the tag says so and turns amber at once, while the picker keeps focus',
      e.w.document.activeElement === sel && sel.isConnected && cell().querySelector('.fctproc-scatag').textContent === 'Agmt needed'
      && cell().querySelector('.fctproc-scatag').classList.contains('sca-Needed') && sel.closest('.fctproc-scawrap').title === 'Sub-Contractor Agreement: Needed');
    assert('…and the cell around it takes its amber edge without waiting for the picker to be left', cell().classList.contains('flag-amber'));
    await sleep(700);
    sel.blur();
    assert('…saved as the full value', e.db.rows[0].sca_status === 'Needed' && e.patches().pop().body.fields.sca_status === 'Needed');
    assert('a vendor off the supplier list is marked on its own line, not the Quote # beneath it',
      !!e.$('tr[data-row="s1"] td.c-supplier .c-vendor.vendor-off') && !e.$('tr[data-row="s1"] td.c-supplier').classList.contains('vendor-off')
      && !e.$('tr[data-row="s1"] td.c-supplier .c-quote_number').classList.contains('vendor-off'));
    // Typing in one line of a stacked cell: the other line is redrawn around it.
    const q = e.field('s1', 'quote_number');
    q.focus();
    e.P._test.state().rows[0].vendor = 'LB Water';
    e.P.rerender();
    assert('while Quote # is typed in, a vendor changed elsewhere shows over it — the box in use left as it is',
      e.field('s1', 'quote_number') === q && e.w.document.activeElement === q && e.field('s1', 'vendor').value === 'LB Water'
      && !e.$('tr[data-row="s1"] .vendor-off'));
    q.blur();
  }
  {
    const e = makeEnv({ perm: { canView: true, canEdit: false }, serverCanEdit: false, rows: [
      row({ id: 'w1', sca_status: 'Executed', vendor: 'LB Water', quote_number: 'Q-1', contact: 'Dana', email: 'dana@lbwater.test' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const tag = e.$('tr[data-row="w1"] td.c-status .fctproc-scatag');
    assert('a viewer sees the agreement as a tag (executed: a tick), with its full wording as the tooltip, and nothing to pick', !!tag && tag.textContent === 'Agmt \u2713'
      && tag.title === 'Sub-Contractor Agreement: Executed' && !e.field('w1', 'sca_status'));
    assert('…and Vendor over Quote #, Contact over Email, as text', e.$('tr[data-row="w1"] .c-vendor').textContent.trim() === 'LB Water'
      && e.$('tr[data-row="w1"] .c-quote_number').textContent.trim() === 'Q-1' && e.$('tr[data-row="w1"] .c-contact').textContent.trim() === 'Dana'
      && e.$('tr[data-row="w1"] .c-email').textContent.trim() === 'dana@lbwater.test');
  }

  // ── Two people on one sheet ─────────────────────────────────────────────
  console.log('\n[two people on one sheet: a cell changed elsewhere is never written over unseen]');
  {
    const colleague = (e, id, fields) => {
      const r = e.db.rows.find(x => x.id === id);
      Object.assign(r, fields);
      r.version++;
      r.updated_at = '2026-03-10T14:14:00Z';
      r.updated_by = 'Dana Reyes';
    };
    const e = makeEnv({ rows: [
      row({ id: 'c1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', quote_number: 'Q-1', vendor: 'LB Water' }),
      row({ id: 'c2', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', quote_number: 'Q-2', vendor: 'LB Water', date_needed: '2026-04-01' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    // Dana changes c1's Quote # on her sheet; this one has not refreshed.
    colleague(e, 'c1', { quote_number: 'Q-DANA' });
    const q = e.field('c1', 'quote_number');
    q.focus(); q.value = 'Q-MINE'; e.fire(q, 'input');
    const em = e.field('c1', 'email');
    em.focus(); em.value = 'orders@lbwater.test'; e.fire(em, 'input');
    em.blur(); e.fire(em, 'change');
    await sleep(80);
    const first = e.patches()[0];
    assert('the save carries what was in each cell when the editing began', first && eq(first.body.expect, { quote_number: 'Q-1', email: '' }), first && first.body);
    assert('Dana changed that Quote # meanwhile: nothing is written over hers', e.db.rows[0].quote_number === 'Q-DANA');
    const dlg = e.$('.fctproc-modal');
    assert('…and the dialog says what, who saved it last and when, and shows what is saved beside yours', !!dlg && /Changed by someone else/i.test(dlg.textContent)
      && /Elbows was changed while you were editing it \(last saved by Dana Reyes at (\w{3} \d{1,2}, )?\d{1,2}:\d{2}/.test(dlg.textContent.replace(/\s+/g, ' '))
      && eq([...dlg.querySelectorAll('.fctproc-conflict tbody tr')].map(tr => [...tr.children].map(td => td.textContent)), [['Quote #', 'Q-DANA', 'Q-MINE']]),
      dlg && dlg.textContent.replace(/\s+/g, ' '));
    assert('…the sheet shows hers, marked as changed by her', e.field('c1', 'quote_number').value === 'Q-DANA'
      && e.$('tr[data-row="c1"] .c-quote_number').classList.contains('fctproc-chg') && /^Changed by Dana Reyes/.test(e.$('tr[data-row="c1"] .c-quote_number').title));
    assert('the other cell of the same save went in on its own, at once', e.db.rows[0].email === 'orders@lbwater.test'
      && eq(e.patches()[1].body, { fields: { email: 'orders@lbwater.test' }, expect: { email: '' } }), e.patches().map(p => p.body));
    e.$('.fctproc-modal [data-conflict="mine"]').click();
    await sleep(60);
    const keep = e.patches().pop();
    assert('"Keep mine" writes yours over hers — knowingly: the save now expects hers', eq(keep.body, { fields: { quote_number: 'Q-MINE' }, expect: { quote_number: 'Q-DANA' } })
      && e.db.rows[0].quote_number === 'Q-MINE' && e.field('c1', 'quote_number').value === 'Q-MINE' && !e.$('.fctproc-modal'), keep && keep.body);
    assert('…and the cell is no longer marked as hers', !e.$('tr[data-row="c1"] .c-quote_number').classList.contains('fctproc-chg'));

    // Again on c2, and this time hers is kept.
    colleague(e, 'c2', { date_needed: '2026-04-15' });
    const dn = e.field('c2', 'date_needed');
    dn.focus(); dn.value = '2026-04-20'; e.fire(dn, 'change'); dn.blur();
    await sleep(700);
    assert('a date changed on both sheets: asked again', !!e.$('.fctproc-modal') && /04\/15\/2026/.test(e.$('.fctproc-conflict').textContent) && /04\/20\/2026/.test(e.$('.fctproc-conflict').textContent));
    const before = e.patches().length;
    e.$('.fctproc-modal [data-conflict="theirs"]').click();
    await sleep(700);
    assert('"Keep saved": nothing is sent, and her date stays on both', e.patches().length === before && e.db.rows[1].date_needed === '2026-04-15'
      && e.field('c2', 'date_needed').value === '2026-04-15' && !e.$('.fctproc-modal'));
    // Closing the dialog keeps hers too.
    colleague(e, 'c2', { quote_number: 'Q-D2' });
    const q2 = e.field('c2', 'quote_number');
    q2.focus(); q2.value = 'Q-ME2'; e.fire(q2, 'input'); q2.blur(); e.fire(q2, 'change');
    await sleep(80);
    const n2 = e.patches().length;
    e.$('.fctproc-modal [data-close]').click();
    await sleep(700);
    assert('closing the dialog without a pick keeps hers: nothing written over it', e.patches().length === n2 && e.db.rows[1].quote_number === 'Q-D2' && e.field('c2', 'quote_number').value === 'Q-D2');
    assert('nothing went wrong on the way', !e.errors.length, e.errors);
  }
  {
    // A picker is saved when it is left: what it showed when it took focus is
    // what it "saw" — not a colleague's value that reached the page meanwhile.
    const e = makeEnv({ rows: [row({ id: 'p1r', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', vendor: 'LB Water' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const qn = e.field('p1r', 'quote_number');
    qn.focus(); qn.value = 'Q-7'; e.fire(qn, 'input');
    const r = e.db.rows[0];
    r.vendor = 'Beta Corp'; r.version++; r.updated_by = 'Dana Reyes'; r.updated_at = '2026-03-10T15:00:00Z';
    const v = e.field('p1r', 'vendor');
    v.focus();
    await sleep(750);       // the Quote # save is answered, carrying Dana's vendor
    assert('the Quote # went in, and its answer brought Dana\'s vendor to the page, behind the picker in use', e.db.rows[0].quote_number === 'Q-7'
      && e.P._test.state().rows[0].vendor === 'Beta Corp' && v.value === 'LB Water');
    e.pick(v, 'Acme Supply', 'Acme Supply');
    v.blur();
    await sleep(100);
    const vp = e.patches().filter(p => 'vendor' in p.body.fields).pop();
    assert('picking a vendor in it expects the one it showed (LB Water), so Dana\'s is not written over unseen', vp && vp.body.expect.vendor === 'LB Water'
      && e.db.rows[0].vendor === 'Beta Corp' && !!e.$('.fctproc-modal'), vp && vp.body);
  }
  {
    // What other people change shows on the sheet when it refreshes.
    const e = makeEnv({ rows: [
      row({ id: 'h1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', date_needed: '2026-04-01', vendor: 'LB Water' }),
      row({ id: 'h2', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', quantity: 8110, unit: 'SF' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const r1 = e.db.rows[0];
    Object.assign(r1, { description: '15" Elbow 45°', date_delivered: '2026-03-09', vendor: 'Beta Corp' });
    r1.version++; r1.updated_by = 'Dana Reyes'; r1.updated_at = '2026-03-10T14:14:00Z';
    e.db.rows.push(row({ id: 'h3', source: 'manual', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', description: 'Gasket lube',
      created_by: 'Dana Reyes', updated_by: 'Dana Reyes', created_at: '2026-03-10T14:15:00Z', updated_at: '2026-03-10T14:15:00Z' }));
    await e.P.refresh();
    await sleep(20);
    const tr1 = e.$('tr[data-row="h1"]');
    assert('a refresh marks each cell Dana changed — a column of its own or a part of one — with who and when',
      tr1.querySelector('td.c-description').classList.contains('fctproc-chg') && /^Changed by Dana Reyes at /.test(tr1.querySelector('td.c-description').title)
      && tr1.querySelector('.c-date_delivered').classList.contains('fctproc-chg') && tr1.querySelector('.c-vendor').classList.contains('fctproc-chg'));
    assert('…and only those: what she did not change is not marked', !tr1.querySelector('td.c-date_needed').classList.contains('fctproc-chg')
      && !tr1.querySelector('.c-quote_number').classList.contains('fctproc-chg') && !e.$('tr[data-row="h2"] .fctproc-chg'));
    assert('a row she added is marked as a whole, "Added by Dana Reyes"', e.$('tr[data-row="h3"]').classList.contains('fctproc-new')
      && /^Added by Dana Reyes/.test(e.$('tr[data-row="h3"]').title));
    // Your own saves are not "changed by someone else".
    const qn = e.field('h2', 'quote_number');
    qn.focus(); qn.value = 'Q-OWN'; e.fire(qn, 'input'); qn.blur(); e.fire(qn, 'change');
    await sleep(80);
    await e.P.refresh();
    await sleep(20);
    assert('a cell this page saved itself is not marked when the refresh brings it back', !e.$('tr[data-row="h2"] .c-quote_number').classList.contains('fctproc-chg'));
    const r2 = e.db.rows[1];
    r2.unit = 'SY'; r2.version++; r2.updated_by = 'Pat PM';
    await e.P.refresh();
    await sleep(20);
    assert('nor one changed under your own name (another window of yours)', !e.$('tr[data-row="h2"] td.c-unit').classList.contains('fctproc-chg'));
    // Changing a marked cell takes the mark off it.
    const dsel = e.field('h1', 'description');
    dsel.focus(); e.pick(dsel, 'Elbow 15" 90°', '__typed__'); dsel.blur();
    await sleep(30);
    assert('changing a marked cell yourself takes its mark off', !e.$('tr[data-row="h1"] td.c-description').classList.contains('fctproc-chg')
      && e.$('tr[data-row="h1"] .c-vendor').classList.contains('fctproc-chg'));
    // The marks fade after a while.
    e.P._test.setRecentMs(150);
    const r1b = e.db.rows[0];
    r1b.lead_time_days = 9; r1b.version++; r1b.updated_by = 'Dana Reyes';
    await sleep(700);
    await e.P.refresh();
    await sleep(20);
    assert('a fresh change is marked…', e.$('tr[data-row="h1"] .c-lead_time_days').classList.contains('fctproc-chg'));
    await sleep(500);
    assert('…and the row\'s marks fade on their own after their while', !e.$('tr[data-row="h1"] .fctproc-chg') && !e.$('tr[data-row="h1"] td.fctproc-chg'));
    assert('…each row on its own clock: the row Dana added earlier is still marked', e.$('tr[data-row="h3"]').classList.contains('fctproc-new'));
    e.P._test.setRecentMs(2 * 60 * 1000);
  }

  console.log('\n[two people on one sheet: review fixes — the cell in use, same values, lost answers, a Sub Code pick, a job switch]');
  {
    const dana = (e, id, f) => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = 'Dana Reyes'; r.updated_at = new Date().toISOString(); };
    const e = makeEnv({ rows: [
      row({ id: 'k1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', quote_number: 'Q-1' }),
      row({ id: 'k2', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', quote_number: 'Q-2' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    // Still in the box when the answer comes: the save went on a pause in the typing.
    dana(e, 'k1', { quote_number: 'Q-DANA' });
    let qb = e.field('k1', 'quote_number');
    qb.focus(); qb.value = 'Q-MI'; e.fire(qb, 'input');
    await sleep(700);
    assert('a conflict found by a save made mid-typing: the dialog is up, and the box is no longer in use', !!e.$('.fctproc-modal')
      && e.w.document.activeElement && e.w.document.activeElement.getAttribute('role') === 'dialog');
    assert('…the box shows what is saved (hers), behind the dialog', e.field('k1', 'quote_number').value === 'Q-DANA');
    assert('…the cell is held: nothing more of it is sent', e.P._test.held().has('k1\u0000quote_number'));
    const n0 = e.patches().length;
    // What the box held as it was left (a browser commits it then), or a late keystroke.
    qb = e.field('k1', 'quote_number'); qb.value = 'Q-MINE'; e.fire(qb, 'input');
    await sleep(700);
    assert('what reaches the held cell after the conflict is not saved over hers…', e.patches().length === n0 && e.db.rows[0].quote_number === 'Q-DANA',
      e.patches().slice(n0).map(x => x.body));
    assert('…it is "Yours" in the dialog, which follows it', eq([...e.$$('.fctproc-conflict tbody td')].map(td => td.textContent), ['Quote #', 'Q-DANA', 'Q-MINE']));
    e.$('.fctproc-modal [data-conflict="theirs"]').click();
    await sleep(700);
    assert('"Keep saved": hers stays, in the database and in the box, and the cell is let go', e.patches().length === n0 && e.db.rows[0].quote_number === 'Q-DANA'
      && e.field('k1', 'quote_number').value === 'Q-DANA' && !e.P._test.held().size && !e.$('.fctproc-modal'));
    // The same, and "Keep mine": the newest of yours goes.
    dana(e, 'k2', { quote_number: 'Q-D2' });
    qb = e.field('k2', 'quote_number');
    qb.focus(); qb.value = 'Q-X'; e.fire(qb, 'input');
    await sleep(700);
    qb = e.field('k2', 'quote_number'); qb.value = 'Q-XY'; e.fire(qb, 'input');
    e.$('.fctproc-modal [data-conflict="mine"]').click();
    await sleep(80);
    const km = e.patches().pop();
    assert('"Keep mine" saves the newest of yours, knowingly over hers', eq(km.body, { fields: { quote_number: 'Q-XY' }, expect: { quote_number: 'Q-D2' } })
      && e.db.rows[1].quote_number === 'Q-XY' && e.field('k2', 'quote_number').value === 'Q-XY', km.body);

    // Both set the same value: nothing to ask.
    dana(e, 'k1', { quote_number: 'Q-SAME' });
    qb = e.field('k1', 'quote_number');
    qb.focus(); qb.value = 'Q-SAME'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('both people put in the same value: saved, no dialog', !e.$('.fctproc-modal') && e.db.rows[0].quote_number === 'Q-SAME');

    // A save that landed, its answer lost, sent again with the old expectation.
    e.db.losePatch = 1;
    qb = e.field('k2', 'quote_number');
    qb.focus(); qb.value = 'Q-LOST'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('(the answer of a save that landed is lost: kept, said)', e.db.rows[1].quote_number === 'Q-LOST' && e.errors.some(x => /could not be saved/.test(x)));
    const un = e.field('k2', 'unit');
    un.focus(); e.pick(un, 'SF', 'SF'); un.blur();
    await sleep(700);
    const lostSends = e.patches().filter(x => x.q.id === 'k2' && x.body.fields.quote_number === 'Q-LOST');
    assert('…sent again, still expecting what was there before it: the cell already holds it, so no "changed by someone else" about your own save',
      lostSends.length === 2 && eq(lostSends[1].body.expect, { quote_number: 'Q-XY' }) && !e.$('.fctproc-modal') && e.db.rows[1].unit === 'SF',
      e.patches().filter(x => x.q.id === 'k2').map(x => x.body));
    assert('nothing else went wrong', e.errors.length === 1, e.errors);
  }
  {
    // A Sub Code pick whose line was changed elsewhere: the Quantity and Unit
    // it filled in are part of it — asked about with it, not saved without it.
    const e = makeEnv({ rows: [row({ id: 's1', source: 'manual', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const r = e.db.rows[0];
    Object.assign(r, { bid_item_id: null, cost_code: '', sub_code: '' }); r.version++; r.updated_by = 'Dana Reyes';
    const box = e.field('s1', 'codes');
    box.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(box, 'Stormwater / Geofabric', 'b1');
    await e.P._test.flushAll(); await sleep(30);
    const sent = e.patches().filter(x => x.q.id === 's1');
    assert('the pick goes with the Quantity and Unit it filled in', sent[0] && sent[0].body.fields.quantity === 8110 && sent[0].body.fields.unit === 'SF', sent[0] && sent[0].body);
    assert('the line was changed elsewhere: the dialog asks about the codes and the Quantity and Unit together',
      eq([...e.$$('.fctproc-conflict tbody tr')].map(tr => [...tr.children].map(td => td.textContent)).sort(),
        [['Cost / Sub Code', '(blank)', 'Geofabric'], ['Quantity', '(blank)', '8110'], ['Unit', '(blank)', 'SF']]),
      [...e.$$('.fctproc-conflict tbody tr')].map(tr => [...tr.children].map(td => td.textContent)));
    assert('…and the Quantity and Unit were not saved on their own meanwhile', sent.length === 1 && r.quantity == null && r.unit === '', sent.map(x => x.body));
    e.$('.fctproc-modal [data-conflict="theirs"]').click();
    await sleep(700);
    assert('"Keep saved": the row is as Dana left it — no bid quantity for a line it is not on', r.bid_item_id === null && r.quantity == null && r.unit === ''
      && e.patches().filter(x => x.q.id === 's1').length === 1);
  }
  {
    // The answer comes after another job was opened: said, not dropped.
    const e = makeEnv({ rows: [row({ id: 'j1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', quote_number: 'Q-1' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const r = e.db.rows[0];
    r.quote_number = 'Q-DANA'; r.version++; r.updated_by = 'Dana Reyes';
    let release; e.patchHold = new Promise(res => { release = res; });
    const qb = e.field('j1', 'quote_number');
    qb.focus(); qb.value = 'Q-J'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(30);
    e.pick(e.$('#fctproc-proj'), 'Bidding Job', 'p3');
    await sleep(30);
    release();
    await sleep(60);
    assert('a conflict answered after another job was opened is not dropped without a word', !e.$('.fctproc-modal')
      && e.errors.some(x => /Quote # "Q-J" was not saved — it was changed by someone else meanwhile \(last by Dana Reyes\)/.test(x)), e.errors);
    assert('…and nothing was written over hers', r.quote_number === 'Q-DANA' && !e.P._test.held().size);
  }

  console.log('\n[cells others changed: in a save\'s answer, after a bulk edit, under a box\'s own tooltip, a row brought back]');
  {
    const e = makeEnv({ rows: [
      row({ id: 'm1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', vendor: 'LB Water', quote_number: 'Q-1' }),
      row({ id: 'm2', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', quote_number: 'Q-2' }),
    ] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    const r1 = e.db.rows[0];
    r1.vendor = 'Beta Corp'; r1.version++; r1.updated_by = 'Dana Reyes'; r1.updated_at = new Date().toISOString();
    const qb = e.field('m1', 'quote_number');
    qb.focus(); qb.value = 'Q-OWN'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    const vpart = e.$('tr[data-row="m1"] .fctproc-part.c-vendor');
    assert('Dana\'s vendor, brought in by this page\'s own save\'s answer, is marked as hers', e.field('m1', 'vendor').value === 'Beta Corp'
      && vpart.classList.contains('fctproc-chg') && /^Changed by Dana Reyes at /.test(vpart.title), vpart.className + ' | ' + vpart.title);
    assert('…and the cell this page saved is not', !e.$('tr[data-row="m1"] .fctproc-part.c-quote_number').classList.contains('fctproc-chg'));
    assert('the box inside a marked cell says it too (the browser shows the innermost tooltip)', /Changed by Dana Reyes/.test(e.field('m1', 'vendor').title || '')
      || /Changed by Dana Reyes/.test((e.field('m1', 'vendor').closest('[title]') || {}).title || ''), e.field('m1', 'vendor').outerHTML.slice(0, 300));
    // A Quote # someone else changed, then bulk-set here.
    const r2 = e.db.rows[1];
    r2.quote_number = 'Q-D'; r2.version++; r2.updated_by = 'Dana Reyes'; r2.updated_at = new Date().toISOString();
    await e.P.refresh(); await sleep(20);
    const qin = e.field('m2', 'quote_number');
    assert('a marked Quote # box carries "Changed by" in its own tooltip, beside its value', e.$('tr[data-row="m2"] .c-quote_number').classList.contains('fctproc-chg')
      && /^Q-D\nChanged by Dana Reyes at /.test(qin.title), JSON.stringify(qin.title));
    const pickRow = id => { const b = e.$(`[data-sel="${id}"]`); b.checked = true; e.fire(b, 'change'); };
    pickRow('m2');
    e.$('#fctproc-bulk-field').value = 'quote_number'; e.fire(e.$('#fctproc-bulk-field'), 'change');
    e.$('#fctproc-bulk-val').value = 'Q-BULK';
    e.$('[data-act="bulk-apply"]').click();
    await sleep(60);
    assert('a bulk edit of a marked cell takes its mark off (the value is yours now)', e.field('m2', 'quote_number').value === 'Q-BULK'
      && !e.$('tr[data-row="m2"] .c-quote_number').classList.contains('fctproc-chg'));
    // A row someone brings back (deleted, then Send): not "Added by" whoever made it weeks ago.
    e.db.rows.push(row({ id: 'm3', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', version: 4,
      created_by: 'Lee Ames', created_at: '2026-02-01T15:00:00Z', updated_by: 'Dana Reyes', updated_at: new Date().toISOString() }));
    await e.P.refresh(); await sleep(20);
    assert('a row brought back is marked "Brought back by" whoever did it, now', /^Brought back by Dana Reyes at \d/.test(e.$('tr[data-row="m3"]').title), e.$('tr[data-row="m3"]').title);
    e.db.rows.push(row({ id: 'm4', source: 'manual', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', description: 'Stakes',
      created_by: 'Dana Reyes', created_at: new Date().toISOString(), updated_by: 'Dana Reyes', updated_at: new Date().toISOString() }));
    await e.P.refresh(); await sleep(20);
    assert('…and a new one "Added by" its maker', /^Added by Dana Reyes at \d/.test(e.$('tr[data-row="m4"]').title));
  }

  console.log('\n[+ Material copy: one at a time, all or nothing, the own row decided late]');
  {
    const LIST = [{ project_id: 'p2', last_used: '2026-03-01T00:00:00Z', items: [
      { id: 'x1', source: 'bid', material: 'Elbow 15" 90°', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 4, unit: 'EA', vendor: 'LB Water' },
      { id: 'x2', source: 'manual', material: 'Gasket lube', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 1, unit: 'GAL', vendor: 'Beta Corp' }] }];
    const LIB = [
      { material: 'Elbow 15" 90°', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'EA', vendor: 'LB Water', jobs: 1 },
      { material: 'Gasket lube', sub_code: 'Elbows', cost_code: 'Stormwater', unit: 'GAL', vendor: 'Beta Corp', jobs: 1 },
      // The same sub code under another cost code is another line.
      { material: 'Elbow (sanitary)', sub_code: 'Elbows', cost_code: 'Sanitary', unit: 'EA', vendor: '', jobs: 4 },
    ];
    const fresh = () => {
      const e = makeEnv({ rows: [
        row({ id: 'k1', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 12, unit: 'EA', bid_qty_at_send: 12, bid_unit_at_send: 'EA' }),
        // Its line is gone from the bid.
        row({ id: 'k2', source: 'bid', bid_item_id: 'gone', cost_code: 'Stormwater', sub_code: 'Elbows', quantity: 3, unit: 'EA', created_at: '2026-03-02T00:00:00Z' }),
      ] });
      e.db.materials = LIB;
      e.db.breakdowns = LIST.map(l => ({ ...l, items: l.items.slice() }));
      return e;
    };
    let e = fresh();
    e.P.renderTab(e.root);
    await sleep(40);
    assert('a row whose line is gone from the bid has nothing to copy under', !e.$('tr[data-row="k2"] .fctproc-pastdot') && !!e.$('tr[data-row="k1"] .fctproc-pastdot'));
    const btn = () => e.$('tr[data-row="k1"] [data-act="material"]');
    btn().click(); btn().click();
    await sleep(40);
    assert('a double click reads the lists once and opens one dialog', e.calls.filter(c => c.q.action === 'breakdowns').length === 1 && e.$$('.fctproc-modal').length === 1);
    const bget = e.calls.find(c => c.q.action === 'breakdowns');
    assert('…asking for the line\'s cost code too (the same sub code under another cost code is another line)', bget.q.cost_code === 'Stormwater' && bget.q.sub_code === 'Elbows');
    // Refused: nothing changes, the own row included, and the dialog stays.
    e.db.refuseAdd = true;
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(60);
    await sleep(700);
    assert('an add the server refuses changes nothing: the line\'s own row keeps no name, its 12 EA, and is not saved',
      !e.patches().some(p => p.q.id === 'k1') && e.P._test.state().rows.find(r => r.id === 'k1').description === ''
      && e.P._test.state().rows.find(r => r.id === 'k1').quantity === 12, e.patches().map(p => p.body));
    assert('…the dialog stays open to try again, saying what went wrong', !!e.$('.fctproc-modal') && e.errors.some(m => /could not be added.*no longer on the job's bid/.test(m))
      && e.$('.fctproc-modal [data-copy="go"]').textContent === 'Add 2 materials', e.errors);
    // Both tries lost: the next Add sends the very same ids.
    e.db.refuseAdd = false;
    e.db.loseAdd = 2;
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(80);
    const a1 = e.calls.filter(c => c.q.action === 'add');
    assert('two answers lost: the dialog is still there, the PM told it may have gone in', a1.length === 3 && !!e.$('.fctproc-modal') && e.errors.some(m => /may not have been added/.test(m)));
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(80);
    const a2 = e.calls.filter(c => c.q.action === 'add');
    assert('…Add again sends the same ids, so the material that went in is there once', a2.length === 4 && eq(a2[3].body.items.map(i => i.id), a2[1].body.items.map(i => i.id))
      && e.db.rows.filter(r => r.description === 'Gasket lube').length === 1 && !e.$('.fctproc-modal'), a2.map(a => a.body.items.map(i => i.id)));
    await sleep(700);
    const own = e.patches().filter(p => p.q.id === 'k1').pop();
    assert('…and only then is the line\'s own row named', own && own.body.fields.description === 'Elbow 15" 90°', own && own.body);
    assert('once everything there is here, "+ Material" offers no list (no dot)', !e.$('tr[data-row="k1"] .fctproc-pastdot'));

    // The own row named by someone else while the dialog is open.
    e = fresh();
    e.P.renderTab(e.root);
    await sleep(40);
    e.$('tr[data-row="k1"] [data-act="material"]').click();
    await sleep(40);
    assert('the dialog offers to name the line\'s own row', /names this line's own row/.test(e.$('.fctproc-modal [data-copy="count"]').textContent));
    const k1 = e.P._test.state().rows.find(r => r.id === 'k1');
    k1.description = 'Named by a colleague';
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(80);
    const add = e.calls.filter(c => c.q.action === 'add').pop();
    assert('…named meanwhile: its material goes in as a row of its own, nothing is dropped, the count is right',
      add && eq(add.body.items.map(i => i.description), ['Elbow 15" 90°', 'Gasket lube']) && !e.patches().some(p => p.q.id === 'k1' && 'description' in p.body.fields)
      && e.$$('.fctproc-toast').some(t => /Added 2 materials from Hempfield Stadium — fill in/.test(t.textContent)), e.$$('.fctproc-toast').map(t => t.textContent));

    // Copy the quantities: never over a quantity the PM typed on the own row.
    e = fresh();
    e.P._test.state();
    e.db.rows.find(r => r.id === 'k1').quantity = 7;
    e.P.renderTab(e.root);
    await sleep(40);
    e.$('tr[data-row="k1"] [data-act="material"]').click();
    await sleep(40);
    const qty = e.$('.fctproc-modal [data-copy="qty"]');
    qty.checked = true; e.fire(qty, 'change');
    e.$('.fctproc-modal [data-copy="go"]').click();
    await sleep(800);
    const ownq = e.patches().filter(p => p.q.id === 'k1').pop();
    const addq = e.calls.filter(c => c.q.action === 'add').pop();
    assert('"copy the quantities" leaves a quantity the PM typed on the own row as it is (the new rows take theirs)',
      ownq && eq(ownq.body.fields, { description: 'Elbow 15" 90°', vendor: 'LB Water' }) && addq.body.items[0].quantity === 1, [ownq && ownq.body, addq && addq.body.items]);
  }

  console.log('\n[bug sweep: the save path]');
  {
    const dana = (e, id, f, by = 'Dana Reyes') => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = by; r.updated_at = new Date().toISOString(); };
    const rowsOf = e => e.$$('tr.fctproc-row').map(t => t.dataset.row);

    // A Vendor pick that cleared the old vendor's contact, refused as a conflict.
    let e = makeEnv({ rows: [row({ id: 'v1', vendor: 'Acme Supply', contact: 'Dana', email: 'dana@acme.test' })],
      contacts: [{ id: 'c1', supplier_name: 'Acme Supply', name: 'Dana', email: 'dana@acme.test', phone: '' }] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'v1', { vendor: 'Beta Corp' });
    e.pick(e.field('v1', 'vendor'), 'LB Water');
    await sleep(700);
    let vp = e.patches().filter(p => p.q.id === 'v1');
    assert('a Vendor pick that clears the old vendor\'s Contact / Email goes as one save', vp[0] && eq(vp[0].body.fields, { vendor: 'LB Water', contact: '', email: '' }), vp.map(p => p.body));
    assert('…refused (the vendor was changed elsewhere): Contact and Email are not saved without it', vp.length === 1
      && e.db.rows[0].contact === 'Dana' && e.db.rows[0].email === 'dana@acme.test', vp.map(p => p.body));
    assert('…they are asked about with it', eq([...e.$$('.fctproc-conflict tbody tr')].map(tr => tr.children[0].textContent), ['Vendor', 'Contact', 'Email']),
      e.$('.fctproc-modal') && e.$('.fctproc-modal').textContent.replace(/\s+/g, ' '));
    e.$('.fctproc-modal [data-conflict="theirs"]').click();
    await sleep(700);
    assert('"Keep saved": their vendor, and the contact with it, as they were', e.db.rows[0].vendor === 'Beta Corp' && e.db.rows[0].contact === 'Dana'
      && e.db.rows[0].email === 'dana@acme.test' && e.patches().length === 1 && e.field('v1', 'contact').value === 'Dana');

    // A Material from the library brings its Unit and Vendor: asked about with it.
    e = makeEnv({ rows: [row({ id: 'm1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', unit: 'LS' })] });
    e.db.materials = [{ material: 'Perforated 15" SLCPP', sub_code: '15" Perf drain', cost_code: 'Stormwater', unit: 'LF', vendor: 'LB Water', jobs: 5 }];
    e.P.renderTab(e.root);
    await sleep(60);
    dana(e, 'm1', { description: 'Perf pipe (Dana)' });
    const opt = e.P.cbOptions('proc_materials:m1').find(o => o.label === 'Perforated 15" SLCPP');
    e.pick(e.field('m1', 'description'), opt.label, opt.value);
    await sleep(700);
    vp = e.patches().filter(p => p.q.id === 'm1');
    assert('a library Material refused as a conflict: its Unit and Vendor are not saved on their own',
      vp.length === 1 && eq(vp[0].body.fields, { description: 'Perforated 15" SLCPP', unit: 'LF', vendor: 'LB Water' })
      && e.db.rows[0].unit === 'LS' && e.db.rows[0].vendor === '', vp.map(p => p.body));
    assert('…the dialog asks about the three together', eq([...e.$$('.fctproc-conflict tbody tr')].map(tr => tr.children[0].textContent), ['Material', 'Unit', 'Vendor']),
      e.$('.fctproc-modal') && e.$('.fctproc-modal').textContent.replace(/\s+/g, ' '));
    e.$('.fctproc-modal [data-conflict="mine"]').click();
    await sleep(700);
    assert('…and "Keep mine" saves all three', e.db.rows[0].description === 'Perforated 15" SLCPP' && e.db.rows[0].unit === 'LF' && e.db.rows[0].vendor === 'LB Water');

    // A save whose answer was lost, and the same cell changed again while it
    // was out (typed in two bursts over a dropping connection).
    e = makeEnv({ rows: [row({ id: 'l1', quote_number: 'Q-OLD' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.db.losePatch = 1;
    let releaseLost;
    e.patchHold = new Promise(r => { releaseLost = r; });
    let qb = e.field('l1', 'quote_number');
    qb.focus(); qb.value = 'Q-1'; e.fire(qb, 'input');
    await sleep(700);                                   // the save goes on a pause in the typing
    qb.value = 'Q-2'; e.fire(qb, 'input');
    releaseLost();
    await sleep(30);
    assert('(the first save landed; its answer was lost)', e.db.rows[0].quote_number === 'Q-1' && e.errors.some(m => /could not be saved/.test(m)));
    qb.blur(); e.fire(qb, 'change');
    await sleep(700);
    const lp = e.patches();
    assert('changed again: no "changed by someone else" about the page\'s own save — it is sent on, expecting what landed',
      !e.$('.fctproc-modal') && e.db.rows[0].quote_number === 'Q-2' && eq(lp[lp.length - 1].body, { fields: { quote_number: 'Q-2' }, expect: { quote_number: 'Q-1' } }),
      lp.map(p => p.body));

    // A row deleted here while its save is out.
    e = makeEnv({ rows: [row({ id: 'g1', quote_number: 'A' }), row({ id: 'g2' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    let release;
    e.patchHold = new Promise(r => { release = r; });
    qb = e.field('g1', 'quote_number');
    qb.focus(); qb.value = 'B'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(30);
    e.$('tr[data-row="g1"] [data-act="del"]').click();
    e.$('tr[data-row="g1"] [data-act="del-yes"]').click();
    await sleep(60);
    release();
    await sleep(60);
    e.P.rerender();
    assert('a row deleted while its save was out is not brought back by the save\'s answer', !e.$('tr[data-row="g1"]')
      && !e.P._test.state().rows.some(r => r.id === 'g1') && !e.errors.some(m => /deleted by someone else/.test(m)), rowsOf(e));

    // Deleting a row someone else deleted first.
    e = makeEnv({ rows: [row({ id: 'd1' }), row({ id: 'd2' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.db.rows[0].deleted_at = '2026-03-10T00:00:00Z';
    e.$('tr[data-row="d1"] [data-act="del"]').click();
    e.$('tr[data-row="d1"] [data-act="del-yes"]').click();
    await sleep(80);
    assert('deleting a row someone else deleted first: it goes, with no "could not delete" and no "Not saved"', !e.$('tr[data-row="d1"]')
      && !e.errors.length && !/Not saved/.test(e.$('#fctproc-save').textContent), [e.errors, e.$('#fctproc-save').textContent]);

    // A failed save, another job opened and this one again.
    e = makeEnv({ rows: [row({ id: 'j1', quote_number: 'Q-1' }), row({ id: 'j2', project_id: 'p2' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.db.failPatch = 9;
    qb = e.field('j1', 'quote_number');
    qb.focus(); qb.value = 'Q-2'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    e.P._test.selectProject('p2');
    await sleep(40);
    e.P._test.selectProject('p1');
    await sleep(60);
    assert('a failed edit, the job opened again: the cell shows the edit still waiting to go, not the saved value',
      e.field('j1', 'quote_number').value === 'Q-2' && e.P._test.pending().pend.has('j1'), e.field('j1', 'quote_number').value);
    assert('(the indicator says "Not saved")', /Not saved/.test(e.$('#fctproc-save').textContent));
    e.$('[data-act="add"]').click();
    await sleep(400);
    assert('+ Add Row meanwhile: the indicator still says "Not saved", not "Saved"', /Not saved/.test(e.$('#fctproc-save').textContent)
      && e.P._test.state().rows.length === 2, e.$('#fctproc-save').textContent);

    // "Keep mine", and a third person's save while the dialog was open.
    e = makeEnv({ rows: [row({ id: 't1', date_needed: '2027-01-10' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 't1', { date_needed: '2027-01-15' });
    const dn = e.field('t1', 'date_needed');
    dn.focus(); dn.value = '2027-01-20'; e.fire(dn, 'change'); dn.blur();
    await sleep(700);
    assert('(the dialog: saved 01/15, yours 01/20)', !!e.$('.fctproc-modal') && /01\/15\/2027/.test(e.$('.fctproc-conflict').textContent));
    dana(e, 't1', { date_needed: '2027-01-25' }, 'Cal Ortiz');
    await e.P.refresh();
    e.$('.fctproc-modal [data-conflict="mine"]').click();
    await sleep(700);
    assert('"Keep mine" after a third person saved meanwhile: theirs is not written over unseen — asked again, with it',
      e.db.rows[0].date_needed === '2027-01-25' && !!e.$('.fctproc-modal') && /01\/25\/2027/.test(e.$('.fctproc-conflict').textContent)
      && /Cal Ortiz/.test(e.$('.fctproc-modal').textContent), e.$('.fctproc-modal') && e.$('.fctproc-modal').textContent.replace(/\s+/g, ' '));

    // A box left stale by a refresh, and the PM moving within the row.
    e = makeEnv({ rows: [row({ id: 's1', quote_number: 'Q-2' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 's1', { quote_number: 'Q-DANA' });
    let releaseGet;
    e.hold = new Promise(r => { releaseGet = r; });
    const poll = e.P.refresh();
    await tick();
    qb = e.field('s1', 'quote_number');
    qb.focus();
    releaseGet();
    await poll;
    await sleep(10);
    assert('(a refresh that lands while the box has focus leaves it as it is, marked)', qb.isConnected && qb.value === 'Q-2'
      && e.$('tr[data-row="s1"] .c-quote_number').classList.contains('fctproc-chg'));
    e.field('s1', 'email').focus();
    await sleep(10);
    assert('moving to another cell of the row: the box left shows what is saved now', e.field('s1', 'quote_number').value === 'Q-DANA');
    qb = e.field('s1', 'quote_number');
    qb.focus(); qb.value = 'Q-DANA-rev'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('…so an edit made on coming back is of the value that is there', e.db.rows[0].quote_number === 'Q-DANA-rev' && !e.$('.fctproc-modal'));

    // Text typed in a picker, and the page closed or reloaded.
    e = makeEnv({ rows: [row({ id: 'u1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    const vb = e.field('u1', 'vendor');
    vb.focus(); vb.value = 'New Ent'; e.fire(vb, 'input');
    const ev = new e.w.Event('beforeunload', { cancelable: true });
    e.w.dispatchEvent(ev);
    assert('leaving with text typed in a picker asks first ("Leave site?")', ev.defaultPrevented);
    e.w.dispatchEvent(new e.w.Event('pagehide'));
    await sleep(30);
    const up = e.patches().filter(p => p.q.id === 'u1').pop();
    assert('…and on the way out it is committed and sent', up && up.keepalive && eq(up.body.fields, { vendor: 'New Ent' }), up && up.body);

    // An action of the PM's own, answered while they type in another cell.
    e = makeEnv({ rows: [row({ id: 'o1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    let releasePost;
    e.postHold = new Promise(r => { releasePost = r; });
    e.$('[data-act="add"]').click();
    await sleep(20);
    qb = e.field('o1', 'quote_number');
    qb.focus(); qb.value = 'Q-12'; e.fire(qb, 'input');
    qb.dispatchEvent(new e.w.KeyboardEvent('keydown', { key: '2', bubbles: true }));
    releasePost();
    await sleep(80);
    assert('+ Add Row answered while the PM types in another cell: that box keeps the focus and the typing (not rebuilt, not moved to the new row)',
      e.w.document.activeElement === qb && qb.isConnected && qb.value === 'Q-12', e.w.document.activeElement && e.w.document.activeElement.outerHTML.slice(0, 80));
    qb.blur();
    await sleep(40);
    assert('…the new row is drawn once the cell is left', e.P._test.state().rows.length === 2 && rowsOf(e).length === 2, rowsOf(e));

    // The sheet's start-up finishing (the tab drawn again) while a cell is being typed in.
    qb = e.field('o1', 'quote_number');
    qb.focus(); qb.value = 'Q-123'; e.fire(qb, 'input');
    e.P.renderTab(e.root);
    assert('the tab drawn again while a cell is typed in: redrawn around it, the box and its text kept',
      e.w.document.activeElement === qb && qb.isConnected && qb.value === 'Q-123');
    qb.blur();
  }
  console.log('\n[bug sweep: the sheet, its orders, its lists]');
  {
    const dana = (e, id, f) => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = 'Dana Reyes'; r.updated_at = new Date().toISOString(); };
    const rowsOf = e => e.$$('tr.fctproc-row').map(t => t.dataset.row);
    const key = (el, k) => { const ev = new el.ownerDocument.defaultView.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev; };

    // Past midnight with the sheet open: Due soon turns Late on the next poll.
    let e = makeEnv({ rows: [row({ id: 'n1', date_needed: '2026-03-20', lead_time_days: 10 })] });
    let day = TODAY;
    e.cfg.today = () => day;
    e.P.configure(e.cfg);
    e.P.renderTab(e.root);
    await sleep(40);
    assert('(Order By today: Due soon)', /Due soon/.test(e.$('tr[data-row="n1"]').textContent) && !/Late/.test(e.$('tr[data-row="n1"]').textContent));
    day = '2026-03-11';
    await e.P.refresh();
    assert('past midnight, nothing changed on the server: the next poll shows it Late, and counts it', /Late/.test(e.$('tr[data-row="n1"]').textContent)
      && !/Due soon/.test(e.$('tr[data-row="n1"]').textContent) && /Late\s*1/.test(e.$('.fctproc-counts, #fctproc-body').textContent.replace(/\s+/g, ' ')),
      e.$('tr[data-row="n1"]').textContent.replace(/\s+/g, ' '));

    // A row a colleague put on an order this page has not read yet.
    e = makeEnv({ rows: [row({ id: 'q1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain' })] });
    let rereads = 0;
    e.cfg.refreshPurchaseOrders = async () => { rereads++; return true; };
    e.P.configure(e.cfg);
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'q1', { po_id: 'po77' });
    await e.P.refresh();
    await sleep(10);
    assert('a row linked to an order the page does not have yet: the order list is read again at once', rereads === 1, rereads);
    await e.P.refresh();
    await sleep(10);
    assert('…once per set of such orders, not on every poll', rereads === 1, rereads);

    // The arrow keys and the wheel in the grid.
    e = makeEnv({ rows: [row({ id: 'a1', quantity: 400, created_at: '2026-03-01T10:00:00Z' }), row({ id: 'a2', quantity: 5, created_at: '2026-03-01T10:00:01Z' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    const [top, bottom] = rowsOf(e);
    let qn = e.field(top, 'quantity');
    qn.focus();
    let ev = key(qn, 'ArrowDown');
    assert('↓ in Quantity moves to the next row\'s Quantity — it does not step the value', ev.defaultPrevented
      && e.w.document.activeElement === e.field(bottom, 'quantity') && e.field(top, 'quantity').value === qn.value && !e.P._test.pending().pend.size);
    ev = key(e.field(bottom, 'quantity'), 'ArrowUp');
    assert('↑ moves back up', ev.defaultPrevented && e.w.document.activeElement === e.field(top, 'quantity'));
    ev = key(e.field(top, 'date_needed'), 'ArrowDown');
    assert('…and so in a date', ev.defaultPrevented);
    const sca = e.field(top, 'sca_status');
    ev = key(sca, 'ArrowDown');
    assert('…and in the Sub Agmt choice, which is not stepped to the next one', ev.defaultPrevented && sca.value === 'Pending');
    const vend = e.field(top, 'vendor');
    ev = key(vend, 'ArrowDown');
    assert('a picker keeps its arrows for its list', !ev.defaultPrevented);
    qn = e.field(top, 'quantity');
    qn.focus();
    qn.dispatchEvent(new e.w.Event('wheel', { bubbles: true }));
    assert('the wheel over a focused Quantity lets go of the box (the sheet scrolls; the value is not stepped)', e.w.document.activeElement !== qn);

    // The column filter's Search, then Apply.
    e = makeEnv({ rows: [row({ id: 'f1', vendor: 'LB Water' }), row({ id: 'f2', vendor: 'Acme Supply' }), row({ id: 'f3', vendor: 'Beta Corp' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.$('[data-pff="vendor"]').click();
    const search = e.$('#fctproc-ff-search');
    search.value = 'LB';
    e.fire(search, 'input');
    e.$('#fctproc-filter-dd [data-ff="apply"]').click();
    assert('Search in a column filter, then Apply: only the matches are kept, as in Excel', eq(rowsOf(e), ['f1']), rowsOf(e));
    e.$('[data-pff="vendor"]').click();
    const s2 = e.$('#fctproc-ff-search');
    s2.value = 'Corp';
    e.fire(s2, 'input');
    const all = e.$('#fctproc-ff-all');
    all.checked = true;
    e.fire(all, 'change');
    e.$('#fctproc-filter-dd [data-ff="apply"]').click();
    assert('…(Select All) with a search ticks the matches only (LB Water, ticked before but not a match, is not kept)', eq(rowsOf(e), ['f3']), rowsOf(e));

    // A PO raised for one material is not taken by the materials beside it.
    const PX = { id: 'pX', po_number: 'PO-0100', project_id: 'p1', cost_code: 'Stormwater', sub_code: '15" Perf drain', supplier: 'Acme Supply', date_created: '2026-03-09' };
    const sib = row({ id: 'sib', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', date_needed: '2026-03-25', lead_time_days: 14 });
    const linked = row({ id: 'own', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', po_id: 'pX' });
    assert('a material under a bid line is not "on" the PO raised for the material beside it (linked to that one)',
      T.effectivePO(sib, C({ purchaseOrders: [PX], rows: [linked, sib] })).kind === 'none'
      && T.statusOf(sib, C({ purchaseOrders: [PX], rows: [linked, sib] })) === 'Not Ordered');
    assert('…while a PO nobody is linked to still matches by its codes', T.effectivePO(sib, C({ purchaseOrders: [PX], rows: [sib] })).kind === 'auto');

    // Create PO decides on the rows as stored, and links only while they are as decided.
    e = makeEnv({ rows: [row({ id: 'cp1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', vendor: 'Acme Supply' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.cfg.getPurchaseOrders().push({ id: 'poB', po_number: 'PO-0200', project_id: 'p1', cost_code: 'General', sub_code: 'Labor', supplier: 'Acme Supply', date_created: TODAY });
    dana(e, 'cp1', { po_id: 'poB' });
    let box = e.$('[data-sel="cp1"]'); box.checked = true; e.fire(box, 'change');
    e.$('[data-act="bulk-po"]').click();
    await sleep(80);
    assert('Create PO for a row a colleague just put on an order: asked first (the rows are read again), nothing raised',
      !e.created.some(c => c[0] === 'po') && !!e.$('.fctproc-modal') && /already on <b>PO-0200/.test(e.$('.fctproc-modal [data-body]').innerHTML),
      e.$('.fctproc-modal') && e.$('.fctproc-modal').textContent.replace(/\s+/g, ' '));
    const cancelPO = e.$$('.fctproc-modal [data-choice]').pop();
    if (cancelPO) cancelPO.click();
    await sleep(20);
    e = makeEnv({ rows: [row({ id: 'cp2', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', vendor: 'Acme Supply' })] });
    const make = e.cfg.createPurchaseOrder;
    e.cfg.createPurchaseOrder = async seed => {
      const po = await make(seed);
      // A colleague's link lands while the order is being raised.
      e.cfg.getPurchaseOrders().push({ id: 'poC', po_number: 'PO-0300', project_id: 'p1', cost_code: 'General', sub_code: 'Labor', supplier: 'Acme Supply', date_created: TODAY });
      dana(e, 'cp2', { po_id: 'poC' });
      return po;
    };
    e.P.configure(e.cfg);
    e.P.renderTab(e.root);
    await sleep(40);
    box = e.$('[data-sel="cp2"]'); box.checked = true; e.fire(box, 'change');
    e.$('[data-act="bulk-po"]').click();
    await sleep(120);
    const lk = e.patches().filter(p => p.q.action === 'bulk').pop();
    assert('the link to the new PO is sent only while each row\'s PO cell is as decided (expect)', lk && eq(lk.body.expect, { po_id: null, po_auto: true }), lk && lk.body);
    assert('…a row a colleague linked meanwhile stays on theirs, and the PM is told the new PO may be for ordered material',
      e.db.rows[0].po_id === 'poC' && e.errors.some(m => /put on an order by someone else while it was being raised/.test(m)), e.errors);

    // Re-picking a Sub Code under a quantity the PM typed.
    e = makeEnv({ rows: [row({ id: 'rp1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.pick(e.field('rp1', 'codes'), 'Geofabric', 'b1');
    await sleep(700);
    assert('(the pick brings 8110 SF)', e.db.rows[0].unit === 'SF' && Number(e.db.rows[0].quantity) === 8110, e.db.rows[0]);
    qn = e.field('rp1', 'quantity');
    qn.focus(); qn.value = '400'; e.fire(qn, 'input'); qn.blur(); e.fire(qn, 'change');
    await sleep(700);
    e.pick(e.field('rp1', 'codes'), '15" Perf drain', 'b2');
    await sleep(700);
    assert('re-coded to a line bought by another unit: the quantity typed keeps its unit (400 SF does not become 400 LF)',
      e.db.rows[0].bid_item_id === 'b2' && Number(e.db.rows[0].quantity) === 400 && e.db.rows[0].unit === 'SF', e.db.rows[0]);

    // One sub code under two cost codes: two lines, each with its own list.
    const L2 = [
      { id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
      { id: 'b7', cost_code: 'Base', sub_code: 'Geofabric', unit: 'SY', quantity: 900, index: 1 },
    ];
    e = makeEnv({ bidLines: L2, rows: [
      row({ id: 'gS', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }),
      row({ id: 'gB', source: 'bid', bid_item_id: 'b7', cost_code: 'Base', sub_code: 'Geofabric', description: 'Mirafi 140N' }),
    ] });
    e.db.materials = [{ material: 'Mirafi 140N', sub_code: 'Geofabric', cost_code: 'Stormwater', unit: 'SY', vendor: 'Acme Supply', jobs: 2 }];
    e.P.renderTab(e.root);
    await sleep(60);
    const T3 = e.P._test;
    assert('a material named on another cost code\'s line of the same sub code is not "already here" on this one',
      T3.hasPastList(T3.state().rows.find(r => r.id === 'gS'), T3.makeCtx()));

    // Add to Procurement closed while it reads "Adding…", and the send fails.
    e = makeEnv({ rows: [] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.P.openSendModal('p1');
    await sleep(60);
    tickLines(e, ['Geofabric']);
    e.db.failSend = true;
    let releaseSend;
    e.postHold = new Promise(r => { releaseSend = r; });
    e.$('.fctproc-modal [data-send="go"]').click();
    await sleep(10);
    e.$('.fctproc-modal [data-send="cancel"]').click();
    releaseSend();
    await sleep(80);
    assert('Add to Procurement closed mid-send, and the send failed: said on the page', !e.$('.fctproc-modal')
      && e.errors.some(m => /may not have gone through/.test(m)), e.errors);

    // A bulk edit sent in parts, the second failing.
    e = makeEnv({ rows: [row({ id: 'bp1', vendor: 'Acme Supply', contact: 'Dana', email: 'dana@acme.test' }), row({ id: 'bp2', vendor: 'Acme Supply' })],
      contacts: [{ id: 'c1', supplier_name: 'Acme Supply', name: 'Dana', email: 'dana@acme.test', phone: '' }] });
    e.P.renderTab(e.root);
    await sleep(40);
    ['bp1', 'bp2'].forEach(id => { const b = e.$(`[data-sel="${id}"]`); b.checked = true; e.fire(b, 'change'); });
    e.$('#fctproc-bulk-field').value = 'vendor';
    e.fire(e.$('#fctproc-bulk-field'), 'change');
    e.$('#fctproc-bulk-valbox .cb-input').value = 'LB Water';
    e.db.bulkOk = 1;
    e.$('[data-act="bulk-apply"]').click();
    await sleep(120);
    assert('a bulk edit whose second part fails says how many rows it did change, and shows them changed',
      e.errors.some(m => /saved on 1 of the 2 rows/.test(m)) && e.field('bp2', 'vendor').value === 'LB Water' && e.db.rows[1].vendor === 'LB Water', e.errors);

    // Deleting several hundred rows at once.
    const many = Array.from({ length: 450 }, (_, i) => row({ id: 'z' + String(i).padStart(3, '0') }));
    e = makeEnv({ rows: many });
    e.P.renderTab(e.root);
    await sleep(60);
    e.$('#fctproc-selall').checked = true;
    e.fire(e.$('#fctproc-selall'), 'change');
    e.$('[data-act="bulk-del"]').click();
    e.$('[data-act="bulk-del-yes"]').click();
    await sleep(400);
    const dels = e.calls.filter(c => c.method === 'DELETE');
    assert('deleting 450 rows at once goes in parts of 200 (the ids ride in the address, which the host caps)',
      eq(dels.map(d => d.q.ids.split(',').length), [200, 200, 50]) && !rowsOf(e).length && e.db.rows.every(r => r.deleted_at), dels.map(d => d.q.ids && d.q.ids.split(',').length));

    // The Excel file with a character XML cannot carry.
    const xp = T.xlsxParts([row({ id: 'x1', description: 'Bad ￾ char', vendor: 'Half \uD800 pair', quote_number: 'Ok 😀' })], C());
    const xs = xp.find(p => p.name === 'xl/worksheets/sheet1.xml').data;
    const xtext = typeof xs === 'string' ? xs : new TextDecoder().decode(xs);
    assert('Excel: U+FFFE and half a surrogate pair are left out (one of them made the whole file unreadable); a whole pair stays',
      !/[￾￿]/.test(xtext) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(xtext) && /Bad  char/.test(xtext) && /😀/.test(xtext), xtext.slice(0, 200));
  }
  {
    // The automatic re-link after a Replace all, racing a colleague's pick.
    const dana = (e, id, f) => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = 'Dana Reyes'; r.updated_at = new Date().toISOString(); };
    const NEWL = [
      { id: 'n1', cost_code: 'Stormwater', sub_code: 'Geofabric', unit: 'SF', quantity: 8110, index: 0 },
      { id: 'n6', cost_code: 'Stormwater', sub_code: 'Elbows', unit: 'EA', quantity: 12, index: 1 },
    ];
    const ex = makeEnv({ rows: [row({ id: 'RX', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' })] });
    ex.P.configure({ getBidLines: id => (id === 'p1' ? NEWL : []), getFreshBidLines: async () => NEWL });
    const h = ex.handle;
    let raced = false;
    ex.handle = c => {
      if (!raced && c.method === 'PATCH' && c.q.id === 'RX') { raced = true; dana(ex, 'RX', { bid_item_id: 'n6', sub_code: 'Elbows' }); }
      return h(c);
    };
    ex.P.renderTab(ex.root);
    await sleep(120);
    const rx = ex.patches().filter(p => p.q.id === 'RX');
    assert('the automatic re-link is sent only while the row is as it was read (expect)',
      rx[0] && eq(rx[0].body.expect, { bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' }), rx.map(p => p.body));
    assert('…so a colleague\'s Sub Code pick made while it ran is kept, with nothing said', ex.db.rows[0].bid_item_id === 'n6'
      && rx.length === 1 && !ex.errors.length && !ex.$('.fctproc-modal') && !ex.warns.some(w => /re-link failed/.test(w)), [ex.db.rows[0].bid_item_id, ex.errors, ex.warns]);
    assert('…and the row is drawn with the colleague\'s pick, marked as theirs (left as it was, the next edit of it would expect theirs unseen)',
      /Elbows/.test(ex.$('tr[data-row="RX"]').textContent) && !!ex.$('tr[data-row="RX"] .fctproc-chg'), ex.$('tr[data-row="RX"]').textContent.replace(/\s+/g, ' '));
  }

  console.log('\n[bug sweep: the review of its fixes]');
  {
    const dana = (e, id, f, by = 'Dana Reyes') => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = by; r.updated_at = new Date().toISOString(); };
    const rowsOf = e => e.$$('tr.fctproc-row').map(t => t.dataset.row);
    const later = async (e, ms, fn) => {
      const realW = e.w.Date.now, real = Date.now, t = Date.now() + ms;
      e.w.Date.now = () => t; Date.now = () => t;
      try { return await fn(); } finally { e.w.Date.now = realW; Date.now = real; }
    };

    // The window switched away while the caret sits in a box, a refresh,
    // and the PM back in it: the save still expects what the box showed.
    let e = makeEnv({ rows: [row({ id: 'w1', quote_number: 'Q1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    let qb = e.field('w1', 'quote_number');
    qb.focus();
    qb.dispatchEvent(new e.w.FocusEvent('focusout', { bubbles: true }));     // the window loses the focus; the box keeps it
    await sleep(450);
    dana(e, 'w1', { quote_number: 'Q-COLLEAGUE' });
    await later(e, 5000, () => e.P.refresh());
    assert('(nothing was put under the box in use)', qb.isConnected && qb.value === 'Q1');
    qb.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));      // the window comes back
    qb.value = 'Q1-9'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('back from another window: the save expects what the box showed, so the colleague\'s change is asked about, not written over',
      e.db.rows[0].quote_number === 'Q-COLLEAGUE' && !!e.$('.fctproc-modal') && eq(e.patches()[0].body.expect, { quote_number: 'Q1' }), e.patches().map(p => p.body));

    // A row button pressed with the caret in a box of the same row.
    e = makeEnv({ rows: [row({ id: 'b1', quote_number: 'Q1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.field('b1', 'quote_number').focus();
    const del = e.$('tr[data-row="b1"] [data-act="del"]');
    del.focus();                                       // the press moves the focus to it
    await sleep(10);
    assert('the caret moved from a box to a row button of the same row: the button is not redrawn under the press (its click lands)',
      del.isConnected && e.$('tr[data-row="b1"] [data-act="del"]') === del && e.w.document.activeElement === del);

    // The PM's own save of another cell landed after the colleague's change.
    e = makeEnv({ rows: [row({ id: 'o1', quote_number: 'Q-OLD', quantity: 5 })] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'o1', { quote_number: 'Q-DANA' });
    const qn = e.field('o1', 'quantity');
    qn.focus(); qn.value = '6'; e.fire(qn, 'input');
    qb = e.field('o1', 'quote_number');
    qb.focus();
    await sleep(700);                                  // the quantity goes on the pause
    assert('(the quantity went in, saved under the PM\'s name)', Number(e.db.rows[0].quantity) === 6 && e.db.rows[0].updated_by === 'Pat PM');
    qb.value = 'Q-PM'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    const dlg = e.$('.fctproc-modal');
    assert('a colleague\'s change, the row last saved by the PM\'s own other save: "Changed by someone else", naming nobody — not "you, in another window"',
      !!dlg && /Changed by someone else/.test(dlg.textContent) && !/another window/.test(dlg.textContent) && !/last saved by/.test(dlg.textContent),
      dlg && dlg.textContent.replace(/\s+/g, ' '));

    // A Vendor pick made while another save of the row was out, both refused.
    e = makeEnv({ rows: [row({ id: 'p1r', vendor: 'Acme Supply', contact: 'Dana', email: 'dana@acme.test', quote_number: 'Q-1' })],
      contacts: [{ id: 'c1', supplier_name: 'Acme Supply', name: 'Dana', email: 'dana@acme.test', phone: '' }] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'p1r', { vendor: 'Beta Corp', quote_number: 'Q-D' });
    let releaseQ;
    e.patchHold = new Promise(r => { releaseQ = r; });
    qb = e.field('p1r', 'quote_number');
    qb.focus(); qb.value = 'Q-PM'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(30);
    e.pick(e.field('p1r', 'vendor'), 'LB Water');
    await sleep(10);
    releaseQ();
    await sleep(700);
    const seen = [];
    for (let i = 0; i < 3 && e.$('.fctproc-modal'); i++) {
      seen.push([...e.$$('.fctproc-conflict tbody tr')].map(tr => tr.children[0].textContent));
      e.$('.fctproc-modal [data-conflict="theirs"]').click();
      await sleep(700);
    }
    assert('a Vendor pick made while another save was out, both refused: its Contact / Email are still asked about with it, and "Keep saved" keeps theirs',
      seen.some(l => eq(l, ['Vendor', 'Contact', 'Email'])) && e.db.rows[0].vendor === 'Beta Corp' && e.db.rows[0].contact === 'Dana'
        && e.db.rows[0].email === 'dana@acme.test', [seen, e.db.rows[0].vendor, e.db.rows[0].contact]);

    // Create PO: a colleague's link brought in by a refresh while a question is open.
    e = makeEnv({ rows: [
      row({ id: 'cq1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', vendor: 'Acme Supply' }),
      row({ id: 'cq2', source: 'bid', bid_item_id: 'b6', cost_code: 'Stormwater', sub_code: 'Elbows', vendor: 'Acme Supply' }),
    ] });
    e.P.renderTab(e.root);
    await sleep(40);
    ['cq1', 'cq2'].forEach(id => { const b = e.$(`[data-sel="${id}"]`); b.checked = true; e.fire(b, 'change'); });
    e.$('[data-act="bulk-po"]').click();
    await sleep(80);
    assert('(two sub codes: asked how)', /span <b>2<\/b> sub codes/.test(e.$('.fctproc-modal [data-body]').innerHTML));
    e.cfg.getPurchaseOrders().push({ id: 'poZ', po_number: 'PO-0400', project_id: 'p1', cost_code: 'General', sub_code: 'Labor', supplier: 'Acme Supply', date_created: TODAY });
    dana(e, 'cq1', { po_id: 'poZ' });
    await e.P.refresh();
    e.$('.fctproc-modal [data-choice="0"]').click();
    await sleep(150);
    assert('a colleague\'s link that a refresh brought in while the question was open is not written over: the row stays on theirs, and the PM is told',
      e.db.rows[0].po_id === 'poZ' && e.errors.some(m => /put on an order by someone else/.test(m)), [e.db.rows[0].po_id, e.errors]);

    // Create PO right after the PM's own PO # change, still on its way.
    e = makeEnv({ rows: [row({ id: 'cw', source: 'bid', bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch', vendor: 'LB Water', po_id: 'po3' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.pick(e.field('cw', 'po'), 'Auto', '__none__');
    const bw = e.$('[data-sel="cw"]'); bw.checked = true; e.fire(bw, 'change');
    e.$('[data-act="bulk-po"]').click();
    await sleep(150);
    const made = e.created.filter(c => c[0] === 'po');
    assert('Create PO straight after the PM\'s own PO # change: the change goes first, and the row is linked — not refused as someone else\'s',
      made.length === 1 && /^npo/.test(String(e.db.rows[0].po_id)) && !e.errors.some(m => /someone else/.test(m)), [made.length, e.db.rows[0].po_id, e.errors]);

    // + Add Row answered while the PM types elsewhere, then Enter to the next row.
    e = makeEnv({ rows: [row({ id: 'e1', created_at: '2026-03-01T10:00:00Z' }), row({ id: 'e2', created_at: '2026-03-01T10:00:01Z' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    let releaseP;
    e.postHold = new Promise(r => { releaseP = r; });
    e.$('[data-act="add"]').click();
    await sleep(20);
    const [top, bottom] = rowsOf(e);
    qb = e.field(top, 'quote_number');
    qb.focus(); qb.value = 'Q-7'; e.fire(qb, 'input');
    qb.dispatchEvent(new e.w.KeyboardEvent('keydown', { key: '7', bubbles: true }));
    releaseP();
    await sleep(80);
    assert('(the new row waits while the PM types)', rowsOf(e).length === 2);
    e.field(top, 'quote_number').dispatchEvent(new e.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(40);
    assert('…moved on to the next row with Enter: the new row is drawn, and the caret is where Enter put it',
      rowsOf(e).length === 3 && e.w.document.activeElement === e.field(bottom, 'quote_number'), [rowsOf(e), e.w.document.activeElement && e.w.document.activeElement.outerHTML.slice(0, 80)]);

    // Two rows on one PO by their codes; the PM links one of them.
    e = makeEnv({ rows: [
      row({ id: 'sA', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', created_at: '2026-03-01T10:00:00Z' }),
      row({ id: 'sB', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', description: 'Staples', created_at: '2026-03-01T10:00:01Z' }),
    ] });
    e.P.renderTab(e.root);
    await sleep(40);
    assert('(both read Ordered on PO-0001 by their codes)', ['sA', 'sB'].every(id => e.$(`tr[data-row="${id}"] .fctproc-pill`).textContent === 'Ordered'));
    e.pick(e.field('sA', 'po'), 'PO-0001', 'po1');
    await sleep(20);
    assert('one of them linked to it: the other is redrawn at once as not on it', e.$('tr[data-row="sA"] .fctproc-pill').textContent === 'Ordered'
      && e.$('tr[data-row="sB"] .fctproc-pill').textContent === 'Not Ordered', ['sA', 'sB'].map(id => e.$(`tr[data-row="${id}"] .fctproc-pill`).textContent));

    // A link re-pointed to another job takes nothing from this job's rows.
    const PM = { id: 'pm', po_number: 'PO-0500', project_id: 'p1', cost_code: 'Stormwater', sub_code: 'Geofabric', supplier: 'Acme Supply', date_created: '2026-03-09' };
    const r1 = row({ id: 'R1', project_id: 'p1', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric' });
    const r2 = row({ id: 'R2', project_id: 'p2', bid_item_id: 'x1', cost_code: 'Stormwater', sub_code: 'Geofabric', po_id: 'pm' });
    assert('a row whose PO was re-pointed to another job does not take that order from the rows of the job it is on now',
      T.effectivePO(r2, C({ purchaseOrders: [PM], rows: [r1, r2], projectId: null })).kind === 'moved'
        && T.effectivePO(r1, C({ purchaseOrders: [PM], rows: [r1, r2], projectId: null })).kind === 'auto');
  }

  console.log('\n[bug sweep: the second review of its fixes]');
  {
    const dana = (e, id, f, by = 'Dana Reyes') => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = by; r.updated_at = new Date().toISOString(); };
    const shifted = async (e, ms, fn) => {
      const realW = e.w.Date.now, real = Date.now, base = Date.now();
      e.w.Date.now = () => real() + ms; Date.now = () => real() + ms;
      try { return await fn(); } finally { e.w.Date.now = realW; Date.now = real; void base; }
    };
    // A full redraw owed: the PM's own + Add Row, answered while the caret
    // is in `box` (the new row is drawn once it may be).
    const oweRedraw = async (e, box) => {
      let rel;
      e.postHold = new Promise(r => { rel = r; });
      e.$('[data-act="add"]').click();
      await sleep(20);
      box.focus();
      rel();
      await sleep(80);
    };

    // Enter down a Quantity column with a redraw owed: the next box is not
    // drawn again under the caret (its select-all would be lost).
    let e = makeEnv({ rows: [row({ id: 'q1', quantity: 700, created_at: '2026-03-01T10:00:00Z' }), row({ id: 'q2', quantity: 950, created_at: '2026-03-01T10:00:01Z' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    await oweRedraw(e, e.field('q1', 'quantity'));
    assert('(the PM\'s own new row, answered while the caret was in a cell: drawn later)', e.$$('tr.fctproc-row').length === 2 && e.P._test.state().rows.length === 3);
    e.field('q1', 'quantity').dispatchEvent(new e.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const next = e.w.document.activeElement;
    await sleep(30);
    assert('Enter to the next row\'s Quantity with a redraw owed: that box is not rebuilt under the caret (Enter\'s select-all stays)',
      next && next.dataset.pr === 'q2' && e.w.document.activeElement === next && next.isConnected);
    e.field('q2', 'quote_number').focus();
    await sleep(30);
    assert('…the owed redraw is paid once the caret is in a text box nothing was typed in', e.$$('tr.fctproc-row').length === 3
      && e.w.document.activeElement.dataset.pr === 'q2' && e.w.document.activeElement.dataset.pf === 'quote_number');

    // A box typed in, the window switched away and back, a redraw owed.
    e = makeEnv({ rows: [row({ id: 't1', created_at: '2026-03-01T10:00:00Z' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    let qb = e.field('t1', 'quote_number');
    await oweRedraw(e, qb);
    qb.dispatchEvent(new e.w.KeyboardEvent('keydown', { key: 'Q', bubbles: true }));
    qb.value = 'Q-7'; e.fire(qb, 'input');
    qb.dispatchEvent(new e.w.FocusEvent('focusout', { bubbles: true }));     // the window switched away…
    qb.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));      // …and back: the owed redraw is tried
    await sleep(30);
    assert('a box typed in keeps counting as typed in when the window comes back to it: not rebuilt by the owed redraw',
      e.w.document.activeElement === qb && qb.isConnected && qb.value === 'Q-7' && e.$$('tr.fctproc-row').length === 1);
    qb.blur();
    await sleep(700);

    // Typed in, saved, a pause, a colleague's change of that cell, typed in again.
    e = makeEnv({ rows: [row({ id: 's1', quote_number: 'Q1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    qb = e.field('s1', 'quote_number');
    qb.focus(); qb.value = 'Q1-7'; e.fire(qb, 'input');
    await sleep(700);
    assert('(the first save landed)', e.db.rows[0].quote_number === 'Q1-7');
    dana(e, 's1', { quote_number: 'Q-DANA' });
    await shifted(e, 5000, () => e.P.refresh());
    assert('(the refresh kept the box as the PM left it)', qb.isConnected && qb.value === 'Q1-7');
    qb.value = 'Q1-78'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('typed in again after a pause: the save expects what the box showed (the PM\'s own saved value), so the colleague\'s change is asked about',
      e.db.rows[0].quote_number === 'Q-DANA' && !!e.$('.fctproc-modal') && eq(e.patches().pop().body.expect, { quote_number: 'Q1-7' }), e.patches().map(p => p.body));

    // A picker in use for more than ten minutes, a colleague's change, a click away.
    e = makeEnv({ rows: [row({ id: 'p1v', vendor: 'LB Water' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    const vb = e.field('p1v', 'vendor');
    vb.focus();
    await shifted(e, 11 * 60 * 1000, async () => {
      dana(e, 'p1v', { vendor: 'Beta Corp' });
      await e.P.refresh();
      e.field('p1v', 'quote_number').focus();       // clicked away; the picker commits a moment later
      e.pick(vb, 'Acme Supply');
      await sleep(700);                               // (still in the row: the save goes on the pause)
    });
    assert('a picker in use for over ten minutes, committed on a click away: it still expects what it showed — the colleague\'s vendor is asked about',
      e.db.rows[0].vendor === 'Beta Corp' && !!e.$('.fctproc-modal'), [e.db.rows[0].vendor, e.patches().map(p => p.body)]);

    // A row button pressed without the focus moving to it (Safari), the row redrawn meanwhile.
    e = makeEnv({ rows: [row({ id: 'm1', quote_number: 'Q1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    qb = e.field('m1', 'quote_number');
    qb.focus();
    const xb = e.$('tr[data-row="m1"] [data-act="del"]');
    xb.dispatchEvent(new e.w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    qb.blur();                                        // the box loses the focus to the page, not the button
    await sleep(20);
    assert('a row button pressed without taking the focus, the row redrawn as the box is left: the pressed button is kept (its click arrives)', xb.isConnected);
    e.w.document.dispatchEvent(new e.w.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    xb.click();
    await sleep(20);
    assert('…the click lands ("Delete?"), and the row is drawn whole after it', /Delete\?/.test(e.$('tr[data-row="m1"] .c-actions').textContent));

    // Job A scrolled, B opened, A opened again: A starts at the top.
    e = makeEnv({ rows: [row({ id: 'w1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.P._test.state().wrapScroll = { top: 900, left: 0, sig: e.P._test.viewSig() };
    e.P._test.selectProject('p2');
    await sleep(20);
    e.P._test.selectProject('p1');
    await sleep(20);
    assert('another job opened: the place in the last one is forgotten (A → B → A starts A at the top)', e.P._test.state().wrapScroll == null);
  }

  console.log('\n[bug sweep: the third review — a poll answer landing just as a cell takes the caret]');
  {
    const dana = (e, id, f, by = 'Dana Reyes') => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = by; r.updated_at = new Date().toISOString(); };
    // A poll whose GET went out with the caret elsewhere, answered just after
    // the PM clicked into `box`: the box is kept as it is, over a newer value.
    const raceInto = async (e, box) => {
      let rel;
      e.hold = new Promise(r => { rel = r; });
      const poll = e.P.refresh();
      await tick();
      box.focus();
      rel();
      await poll;
      await sleep(10);
    };

    // Kept stale, then left for the row's own tick box.
    let e = makeEnv({ rows: [row({ id: 'k1', quote_number: 'Q-1' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'k1', { quote_number: 'Q-DANA' });
    let qb = e.field('k1', 'quote_number');
    await raceInto(e, qb);
    assert('(a poll answer landing as the box took the caret: the box kept as it was, marked stale)', qb.isConnected && qb.value === 'Q-1' && qb.dataset.stale === '1');
    e.$('[data-sel="k1"]').focus();
    await sleep(10);
    assert('left for the row\'s own tick box: the box is drawn afresh with what is saved now', e.field('k1', 'quote_number').value === 'Q-DANA'
      && !e.field('k1', 'quote_number').dataset.stale);
    qb = e.field('k1', 'quote_number');
    qb.focus(); qb.value = 'Q-DANA-2'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('…so coming back, the PM edits the value that is there', e.db.rows[0].quote_number === 'Q-DANA-2' && !e.$('.fctproc-modal'));

    // Kept stale, then left for a button in the same cell (Use bid qty beside Quantity).
    e = makeEnv({ rows: [row({ id: 'u1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', quantity: 901, unit: 'LF', bid_qty_at_send: 901, bid_unit_at_send: 'LF' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'u1', { quantity: 1000 });
    const qn = e.field('u1', 'quantity');
    await raceInto(e, qn);
    const ub = e.$('tr[data-row="u1"] [data-act="use-bid"]');
    assert('(the Quantity box kept stale, with Use bid qty in the same cell)', qn.dataset.stale === '1' && !!ub && qn.closest('td').contains(ub));
    ub.focus();
    await sleep(10);
    assert('left for a button in the same cell: the box alone is drawn afresh (the button stays, its click arrives)',
      e.field('u1', 'quantity') !== qn && /^1,?000$/.test(e.field('u1', 'quantity').value) && ub.isConnected, e.field('u1', 'quantity').value);

    // Kept stale and idle, a redraw owed: not rebuilt under the caret.
    e = makeEnv({ rows: [row({ id: 'i1', quote_number: 'Q-100', created_at: '2026-03-01T10:00:00Z' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'i1', { quote_number: 'Q-2291-REV' });
    e.db.rows.push(row({ id: 'i2', created_at: '2026-03-02T10:00:00Z', created_by: 'Dana Reyes', updated_by: 'Dana Reyes' }));
    qb = e.field('i1', 'quote_number');
    await raceInto(e, qb);
    assert('(a colleague\'s row and a change of this very cell came in as it took the caret: a redraw is owed)', !e.$('tr[data-row="i2"]') && qb.dataset.stale === '1');
    qb.dispatchEvent(new e.w.FocusEvent('focusout', { bubbles: true }));
    qb.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    await sleep(30);
    assert('a stale box nothing was typed in is not rebuilt by the owed redraw (its old selection would cut into the new value)',
      e.w.document.activeElement === qb && qb.isConnected && qb.value === 'Q-100');
    qb.value = 'Q-101'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('…typed over: what the PM saw is expected, so the colleague\'s value is asked about', e.db.rows[0].quote_number === 'Q-2291-REV' && !!e.$('.fctproc-modal'),
      e.patches().map(p => p.body));

    // Idle, its row about to leave the table (the Not ordered chip): not redrawn away.
    e = makeEnv({ rows: [row({ id: 'n1', quote_number: 'Q-1', created_at: '2026-03-01T10:00:00Z' }), row({ id: 'n2', created_at: '2026-03-01T10:00:01Z' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    e.$('[data-chip="not_ordered"]').click();
    dana(e, 'n1', { date_ordered: '2026-03-09' });
    qb = e.field('n1', 'quote_number');
    await raceInto(e, qb);
    qb.dispatchEvent(new e.w.FocusEvent('focusout', { bubbles: true }));
    qb.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    await sleep(30);
    assert('an idle box whose row the owed redraw would hide (now ordered, under "Not ordered"): kept, and the focus with it',
      e.w.document.activeElement === qb && qb.isConnected);
    qb.value = 'Q-77'; e.fire(qb, 'input'); qb.blur(); e.fire(qb, 'change');
    await sleep(80);
    assert('…so what is typed is saved, not lost', e.db.rows[0].quote_number === 'Q-77');

    // A row's tick box with the focus, the row redrawn by a refresh.
    e = makeEnv({ rows: [row({ id: 't1', vendor: 'LB Water' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    const tickBox = e.$('[data-sel="t1"]');
    tickBox.checked = true; e.fire(tickBox, 'change');
    tickBox.focus();
    dana(e, 't1', { vendor: 'Beta Corp' });
    await e.P.refresh();
    await sleep(10);
    assert('a row\'s tick box keeps the focus when a refresh redraws the row', e.w.document.activeElement === e.$('[data-sel="t1"]')
      && e.field('t1', 'vendor').value === 'Beta Corp');
  }

  console.log('\n[bug sweep: the final review]');
  {
    const dana = (e, id, f, by = 'Dana Reyes') => { const r = e.db.rows.find(x => x.id === id); Object.assign(r, f); r.version++; r.updated_by = by; r.updated_at = new Date().toISOString(); };
    const raceInto = async (e, box) => {
      let rel;
      e.hold = new Promise(r => { rel = r; });
      const poll = e.P.refresh();
      await tick();
      box.focus();
      rel();
      await poll;
      await sleep(10);
    };

    // The Sub Agmt choice kept stale, then left: its visible tag follows.
    let e = makeEnv({ rows: [row({ id: 'a1', sca_status: 'Pending' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    dana(e, 'a1', { sca_status: 'Executed' });
    const sel = e.field('a1', 'sca_status');
    await raceInto(e, sel);
    const tag = () => e.$('tr[data-row="a1"] .fctproc-scatag');
    assert('(the Sub Agmt choice kept as it was while it had the focus: the tag still reads pending)', sel.dataset.stale === '1' && /pending/i.test(tag().textContent));
    e.field('a1', 'quote_number').focus();
    await sleep(10);
    assert('left for another cell: the tag the PM reads is drawn afresh with the colleague\'s Executed, not only the hidden choice list',
      !/pending/i.test(tag().textContent) && e.field('a1', 'sca_status').value === 'Executed', tag().textContent);
    await e.P.refresh();
    e.field('a1', 'sca_status').focus();
    e.field('a1', 'sca_status').value = 'Needed';
    e.fire(e.field('a1', 'sca_status'), 'change');
    await sleep(700);
    assert('…so a pick made then is made in sight of it', e.db.rows[0].sca_status === 'Needed' && eq(e.patches().pop().body.expect, { sca_status: 'Executed' }));

    // The refresh owed while the caret was in a cell, and a press that leaves it.
    e = makeEnv({ rows: [row({ id: 'm1' }), row({ id: 'm2' })] });
    e.P.renderTab(e.root);
    await sleep(40);
    const gets = () => e.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement').length;
    const qb = e.field('m1', 'quote_number');
    qb.focus();
    await e.P.refresh();
    const g0 = gets();
    const add = e.$('[data-act="add"]');
    add.dispatchEvent(new e.w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    qb.blur();
    await sleep(30);
    assert('a press that leaves the cell: the refresh owed waits for the button to come up (its answer could replace what is pressed)', gets() === g0);
    e.w.document.dispatchEvent(new e.w.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await sleep(30);
    assert('…and is read once it is up', gets() === g0 + 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
