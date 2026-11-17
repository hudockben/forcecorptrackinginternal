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
      if (c.method === 'GET') {
        if (db.failGet) return json(503, { ok: false, error: 'db_unavailable', message: 'The database is busy' });
        const items = db.rows.filter(r => r.project_id === c.q.project_id && (c.q.include_deleted ? true : live(r)));
        return json(200, { ok: true, items, canEdit: serverCanEdit });
      }
      if (!serverCanEdit) return json(403, { ok: false, error: 'read_only' });
      if (c.method === 'PATCH' && c.q.action === 'bulk') {
        const items = [];
        c.body.ids.forEach(id => {
          const r = db.rows.find(x => x.id === id && live(x));
          if (r) { Object.assign(r, c.body.fields); r.version++; items.push({ ...r }); }
        });
        return json(200, { ok: true, items, missing: [] });
      }
      if (c.method === 'PATCH') {
        if (db.failPatch > 0) { db.failPatch--; return json(500, { ok: false, error: 'server_error', message: 'Something went wrong' }); }
        const bad = db.refuse && Object.keys(c.body.fields).find(k => db.refuse(k, c.body.fields[k]));
        if (bad) return json(400, { ok: false, error: 'invalid', message: `${bad} is not allowed`, field: bad });
        const r = db.rows.find(x => x.id === c.q.id && live(x));
        if (!r) return json(404, { ok: false, error: 'not_found' });
        Object.assign(r, c.body.fields);
        r.version++;
        r.updated_at = new Date().toISOString();
        return json(200, { ok: true, item: { ...r } });
      }
      if (c.method === 'POST' && c.q.action === 'send') {
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
    if (env.hold && c.method === 'GET' && c.path === '/api/procurement' && !c.q.include_deleted) {
      const h = env.hold;
      env.hold = null;
      await h;
    }
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
  assert('a new EA line starts ticked', flat.b6.state === 'new' && flat.b6.checked);
  assert('an LS line starts unticked', flat.b4.state === 'new' && !flat.b4.checked);
  assert('an HR line starts unticked (unit case-insensitive)', flat.b5.state === 'new' && !flat.b5.checked);
  assert('counts add up', eq(plan.counts, { total: 6, new: 4, added: 1, removed: 1, checked: 1 }), plan.counts);
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
    assert('…a line with no such row is still ticked as new', en.n1.state === 'new' && en.n1.checked && !en.n1.hint);
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
  const headers = env.$$('.fctproc-table th').map(th => th.textContent.replace('▼', '').trim());
  assert('columns in the agreed order', eq(headers, ['', 'Status', 'PO #', 'Sub-Contractor Agreement', 'Date Needed', 'Lead Time (days)',
    'Order By', 'Date Ordered', 'Date Delivered', 'Quantity', 'Unit', 'Cost Code', 'Sub Code', 'Description', 'Vendor', 'Quote #',
    'Contact', 'Email', '']), headers);
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
  assert('SCA Needed -> amber "Sub agmt open"', /Sub agmt open/.test(tr3.querySelector('.c-status').textContent) && tr3.querySelector('.c-status').classList.contains('flag-amber'));
  assert('  with the whole wording as its tooltip', /sub-contractor agreement is needed/.test((tr3.querySelector('.c-status .fctproc-flag') || {}).title || ''));
  assert('bid changed badge with its two actions', /bid 901 → 950 LF/.test(tr2.querySelector('.c-quantity').textContent)
    && !!tr2.querySelector('[data-act="use-bid"]') && !!tr2.querySelector('[data-act="dismiss-bid"]'));
  assert('a bid row whose line is gone is badged "not on bid"', /not on bid/.test(tr4.querySelector('.c-cost_code').textContent));
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
  let d = env.field('r1', 'description');
  d.focus();
  d.value = 'Mirafi 140N';
  env.fire(d, 'input');
  await sleep(200);
  assert('nothing is sent while typing', env.patches().length === 0);
  d.value = 'Mirafi 140N, 15 ft rolls';
  env.fire(d, 'input');
  const q2 = env.field('r1', 'quote_number');
  q2.value = 'Q-55';
  env.fire(q2, 'input');
  await sleep(750);
  let ps = env.patches();
  assert('after 600 ms of quiet: one PATCH for the row', ps.length === 1 && ps[0].q.id === 'r1' && ps[0].q.division === 'turf', ps.map(p => p.q));
  assert('carrying only the two changed fields', ps[0] && eq(ps[0].body, { fields: { description: 'Mirafi 140N, 15 ft rolls', quote_number: 'Q-55' } }), ps[0] && ps[0].body);
  assert('the save indicator says Saved', /Saved/.test(env.$('#fctproc-save').textContent));
  assert('the box being typed in was not redrawn (focus kept)', env.w.document.activeElement === d && d.isConnected);
  d.value = 'Mirafi 140N, 15 ft rolls';
  env.fire(d, 'input');
  await sleep(700);
  assert('an unchanged value is never sent', env.patches().length === 1);
  d.value = 'temp';
  env.fire(d, 'input');
  d.value = 'Mirafi 140N, 15 ft rolls';
  env.fire(d, 'input');
  await sleep(700);
  assert('typing and undoing within the quiet spell sends nothing', env.patches().length === 1);
  d.blur();

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
  const desc2 = env.field('r2', 'description');
  desc2.value = 'Perf pipe';
  env.fire(desc2, 'input');
  env.fire(desc2, 'change');
  await sleep(50);
  ps = env.patches();
  const retry = ps[ps.length - 1];
  assert('the next edit retries the failed field with it', retry.q.id === 'r2' && eq(retry.body.fields, { quote_number: 'QT-FAIL', description: 'Perf pipe' }), retry.body);
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
  assert('picking a bid line sets bid_item_id and both codes', eq(pr3.body.fields, { bid_item_id: 'b3', cost_code: 'E&S', sub_code: 'Silt Sock 12inch' }), pr3.body);
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
  assert('and its Description has focus', env.w.document.activeElement === env.field(newId, 'description'));
  env.field(newId, 'description').blur();
  env.$(`tr[data-row="${newId}"] [data-act="del"]`).click();
  assert('✕ asks first, inline', /Delete\?/.test(env.$(`tr[data-row="${newId}"] .c-actions`).textContent));
  env.$(`tr[data-row="${newId}"] [data-act="del-no"]`).click();
  assert('"No" puts the buttons back', !!env.$(`tr[data-row="${newId}"] [data-act="material"]`));
  env.$(`tr[data-row="${newId}"] [data-act="del"]`).click();
  env.$(`tr[data-row="${newId}"] [data-act="del-yes"]`).click();
  await sleep(30);
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
  env.P._test.state().rows.find(r => r.id === 'r1').vendor = '';
  env.P._test.state().rows.find(r => r.id === 'r4').vendor = '';
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
  assert('a single-row PO is titled by its description', seeds[1].title === 'Mirafi 140N, 15 ft rolls' && seeds[1].sub_code === 'Geofabric', seeds[1]);
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
    'Lead Time (days)', 'Order By', 'Date Ordered', 'Date Delivered', 'Quantity', 'Unit', 'Cost Code', 'Sub Code', 'Description', 'Vendor',
    'Quote #', 'Contact', 'Email', 'Notes']), m.header);
  {
    const NR = [
      row({ id: 'n1', source: 'bid', bid_item_id: 'b2', cost_code: 'Stormwater', sub_code: '15" Perf drain', bid_qty_at_send: 901, bid_unit_at_send: 'LF',
        quantity: 901, unit: 'LF', date_needed: '2026-03-01', sca_status: 'Needed' }),
      row({ id: 'n2', source: 'bid', bid_item_id: 'gone', cost_code: 'Stormwater', sub_code: 'Inlet Type M', date_needed: '2026-03-12' }),
      row({ id: 'n3', source: 'bid', bid_item_id: 'b1', cost_code: 'Stormwater', sub_code: 'Geofabric', bid_qty_at_send: 8110, bid_unit_at_send: 'SF', date_needed: '2026-03-09' }),
      row({ id: 'n4', source: 'manual', description: 'nothing to say' }),
    ];
    const nm = T.exportMatrix(NR, C());
    const notes = nm.rows.map(r => r[17].v), status = nm.rows.map(r => r[0].v), cc = nm.rows.map(r => r[10].v), qty = nm.rows.map(r => r[8]);
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
  const getsBefore = env.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement').length;
  env.field('r1', 'description').focus();
  await env.P.refresh();
  assert('refresh skips while a cell is being edited', env.calls.filter(c => c.method === 'GET' && c.path === '/api/procurement').length === getsBefore);
  env.field('r1', 'description').blur();
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
  assert('a new line starts ticked', byLine.Elbows.checked);
  assert('LS and HR lines start unticked', !byLine.Mobilization.checked && !byLine.Labor.checked);
  const go = s.$('.fctproc-modal [data-send="go"]');
  assert('the button counts what will be sent', go.textContent === 'Send 1 line');
  byLine['15" Perf drain'].checked = true;
  s.fire(byLine['15" Perf drain'], 'change');
  assert('ticking "removed earlier" counts it', go.textContent === 'Send 2 lines');
  s.$$('.fctproc-modal [data-sall]')[2].click();
  assert('group "All" ticks that group', byLine.Mobilization.checked && byLine.Labor.checked && go.textContent === 'Send 4 lines');
  s.$$('.fctproc-modal [data-snone]')[2].click();
  assert('group "None" unticks it', !byLine.Mobilization.checked && go.textContent === 'Send 2 lines');
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
  assert('a failed read -> no checklist, nothing sent', /Nothing was sent/.test(failRead.$('.fctproc-modal').textContent) && !failRead.$('[data-si]'));

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
  const hd = h.field('r1', 'description');
  hd.value = 'typed then closed';
  h.fire(hd, 'input');
  h.w.dispatchEvent(new h.w.Event('pagehide'));
  await tick();
  const kp = h.patches().pop();
  assert('pagehide sends the unsaved edit at once, with keepalive', kp && kp.keepalive && kp.body.fields.description === 'typed then closed', kp);
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
  await sleep(30);

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
    d.value = 'Bad!';
    e.fire(d, 'input');
    const qn = e.field('v1', 'quote_number');
    qn.value = 'Q-1001';
    e.fire(qn, 'input');
    e.fire(qn, 'change');
    await sleep(60);
    const ps = e.patches();
    assert('the refused PATCH carried both cells', ps[0] && eq(ps[0].body.fields, { description: 'Bad!', quote_number: 'Q-1001' }), ps.map(p => p.body));
    assert('…the refused cell is dropped and the rest is sent again at once', ps.length === 2 && eq(ps[1].body.fields, { quote_number: 'Q-1001' }), ps.map(p => p.body));
    assert('…so the other cell is saved', e.db.rows[0].quote_number === 'Q-1001' && e.db.rows[0].description === 'Geofabric');
    assert('…the message names the cell and the value that was refused', e.errors.some(m => /Description "Bad!" was not saved — description is not allowed/.test(m)
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
    await sleep(20);
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
    assert('before: nothing is "not on bid"', e.$$('.c-cost_code .fctproc-tag').length === 0);
    bid = NEWB;
    e.P.rerender();
    assert('the bid replaced under the open tab: every row says "not on bid"', e.$$('.c-cost_code .fctproc-tag').length === 3);
    await e.P.openSendModal('p1');
    const rel = e.patches().map(p => p.q.id + '>' + p.body.fields.bid_item_id).sort();
    assert('the rows are re-linked — each once, not by the redraw AND by Send', eq(rel, ['g1>No1', 'g2>No2', 'm1>No1']), rel);
    assert('…and the PM is told', e.$$('.fctproc-toast').some(t => /Re-linked 3 rows/.test(t.textContent))
      || /Re-linked 3 rows/.test(e.$('.fctproc-modal').textContent));
    assert('…and the grid behind it already shows it', e.$$('.c-cost_code .fctproc-tag').length === 0);
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
      && e.$$('.c-cost_code .fctproc-tag').length === 0, e.$$('tr.fctproc-row').map(t => t.dataset.row));

    // 2. Replace all answered "no" to sending, then the tab opened: the rows
    //    re-link as they load, without anyone opening Send.
    const a = makeEnv({ rows: RROWS.map(r => ({ ...r })), bidLines: NEWB });
    a.P.renderTab(a.root);
    await sleep(40);
    assert('opening the tab re-links them (the full list read first, deleted rows included)',
      a.calls.some(c => c.q.include_deleted === '1') && eq(a.patches().map(p => p.q.id).sort(), ['g1', 'g2', 'm1']));
    assert('…no row says "not on bid" and they keep bid order', a.$$('.c-cost_code .fctproc-tag').length === 0
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
    assert('…once it has the current bid, the rows are simply on it', bea.patches().length === 0 && bea.$$('.c-cost_code .fctproc-tag').length === 0);

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
      e.db.rows[0].bid_item_id === 'z2' && e.$$('.c-cost_code .fctproc-tag').length === 0, e.db.rows[0]);
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
    // The four ticked by default (not the LS and HR lines) went in.
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
    const untick = sub => { const cb = lineEl(sub).querySelector('input'); cb.checked = false; e.fire(cb, 'change'); };
    untick('15" Perf drain');
    untick('Silt Sock 12inch');
    assert('two lines unticked: 2 to send', /Send 2 lines/.test(e.$('.fctproc-modal [data-send="go"]').textContent), e.$('.fctproc-modal [data-send="go"]').textContent);
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
    assert('after the failure, the lines the PM unticked are still unticked', state['15" Perf drain'] === false && state['Silt Sock 12inch'] === false, state);
    assert('…the ones left ticked are still ticked, and one ticked while the list was read again stays ticked',
      state.Geofabric === true && state.Elbows === true && state.Mobilization === true && state.Labor === false, state);
    assert('…the message says nothing was sent', /^Not sent: Gateway timeout/.test(e.$('#fctproc-send-err').textContent), e.$('#fctproc-send-err').textContent);
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
    assert('the message reports what the re-read shows: it went through', /went through after all/.test(said) && /4 lines are now in Procurement/.test(said)
      && !/Not sent/.test(said), said);
    // Part of it in by somebody else, the rest refused: says how many.
    const p = makeEnv({ rows: [] });
    p.P.renderTab(p.root);
    await tick(); await tick(); await tick();
    await p.P.openSendModal('p1');
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
    assert('the empty sheet does not point at Send to Procurement', !/Use <b>Send to Procurement<\/b>|Use Send to Procurement/.test(e.$('#fctproc-wrap').textContent)
      && /no bid lines yet/.test(e.$('#fctproc-wrap').textContent), e.$('#fctproc-wrap').textContent);
    e.$('[data-act="add"]').click();
    await sleep(20);
    const id = e.P._test.state().rows[0].id;
    const codes = e.field(id, 'codes');
    codes.dispatchEvent(new e.w.FocusEvent('focusin', { bubbles: true }));
    e.pick(codes, 'Stormwater');
    assert('a code typed with no bid line to match says why it is not kept', e.$$('.fctproc-toast').some(t => /no bid lines yet/.test(t.textContent)));
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

  console.log('\n[leaving with a change that could not be saved]');
  {
    const e = makeEnv({ rows: [row({ id: 'x1' })] });
    e.P.renderTab(e.root);
    await tick(); await tick(); await tick();
    e.db.failPatch = 5;
    const d = e.field('x1', 'description');
    d.focus(); d.value = 'Type M inlet'; e.fire(d, 'input'); e.fire(d, 'change');
    await sleep(20);
    const ev = new e.w.Event('beforeunload', { cancelable: true });
    e.w.dispatchEvent(ev);
    assert('the browser is asked to confirm leaving', ev.defaultPrevented);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
