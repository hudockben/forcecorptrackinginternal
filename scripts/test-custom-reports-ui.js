#!/usr/bin/env node
'use strict';
/**
 * Custom Reporting — the builder UI (custom-reports.js).
 *
 * Run: node scripts/test-custom-reports-ui.js
 *
 * custom-reports.js is the screen: the saved-report list, the three-step
 * builder, the live preview, saving, and the Print / Email / Excel buttons.
 * Here it is driven in jsdom the way a user drives it — clicks, ticks and
 * typing, through the real delegated listeners — with the REAL engine
 * (custom-reports-engine.js) and report-branding.js loaded first, and
 * /api/custom-reports answered by an in-memory stand-in that keeps the API's
 * rules (per-scope unique names, optimistic versions, soft delete, restore,
 * the run log). Nothing is stubbed between the UI and the engine, so a figure
 * or a locked column that the preview shows is the one the engine produced.
 *
 * What it leans on hardest, because these reports go to customers:
 *   - customer-safe: an internal column cannot be ticked while the switch is
 *     off, the switch asks first, the red banner shows while it is on, and the
 *     preview / print / workbook never carry a locked column;
 *   - saving: the POST / PUT bodies, a taken name re-prompting, and two people
 *     saving the same report (version_conflict) both ways out;
 *   - outputs: the print window opened inside the click (pop-up rule) and
 *     written with the branded masthead once, the email modal told the right
 *     report type with onSent logging the run, the .xlsx download;
 *   - user text never turning into markup.
 *
 * A last, optional block opens the tab in headless Chromium at 390 px (phone)
 * and 1440 px and checks nothing scrolls sideways. It is skipped, and says
 * so, where Playwright or a browser is not installed.
 *
 * No DB or server required.
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail !== undefined ? '  — ' + String(detail).slice(0, 400) : ''}`); }
}
const section = t => console.log(`\n${t}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await sleep(0); };
const PREVIEW_WAIT = 320;   // the builder redraws the preview 250 ms after the last change

const ROOT     = path.resolve(__dirname, '..');
const ENGINE   = fs.readFileSync(path.join(ROOT, 'custom-reports-engine.js'), 'utf8');
const BRANDING = fs.readFileSync(path.join(ROOT, 'report-branding.js'), 'utf8');
const UI       = fs.readFileSync(path.join(ROOT, 'custom-reports.js'), 'utf8');

const XSS_NAME = '<img src=x onerror="window.__xss=1">';

// ── Fixture: a paving division with three jobs, POs and trucking ─────────
function fixture() {
  const p1 = {
    id: 'p1', 'project-name': 'Route 30 Resurfacing', 'job-number': '26101', status: 'In Progress',
    client: 'Acme Township', gc: 'BuildCo', address: '100 Main St', 'city-state': 'Greensburg, PA',
    'start-date': '2026-10-01', 'end-date': '2026-12-15', 'contract-amount': '250000', invoiced: '80000',
    bidItems: [
      { id: 'b1', cost_code: 'Paving', sub_code: 'Base Course', description: 'Aggregate base', unit: 'TON', quantity: '2000', unit_cost: '85.57',
        change_orders: [{ date: '2026-10-15', qty_delta: '100', note: 'Extra base at entrance' }] },
      { id: 'b2', cost_code: 'Paving', sub_code: 'Surface Course', unit: 'TON', quantity: '600', unit_cost: '92.25' },
      { id: 'b3', cost_code: 'Milling', sub_code: 'Mill 2in', unit: 'SY', quantity: '5000', unit_cost: '2.4', is_complete: true,
        start_date: '2026-10-01', target_date: '2026-10-10' },
    ],
    dailyRows: [
      { id: 'r1', date: '2026-10-05', cost_code: 'Milling', sub_code: 'Mill 2in', quantity: '2600', labor_hours: '8', employee: 'Joe Secretworker', rate: '47.13' },
      { id: 'r2', date: '2026-10-27', cost_code: 'Paving', sub_code: 'Base Course', quantity: '200', labor_hours: '10', employee: 'Joe Secretworker', rate: '47.13' },
      { id: 'r3', date: '2026-11-02', cost_code: 'Paving', sub_code: 'Base Course', quantity: '350', labor_hours: '10', employee: 'Bob Ray', rate: '40' },
    ],
  };
  const p2 = {
    id: 'p2', 'project-name': 'Elm Street Lot', 'job-number': '26102', status: 'In Progress', client: 'Beta Corp',
    'contract-value': '50000',
    bidItems: [{ id: 'e1', cost_code: 'Sealcoat', sub_code: 'Coat', unit: 'SY', quantity: '4000', unit_cost: '0.5' }],
    dailyRows: [{ id: 's1', date: '2026-11-03', cost_code: 'Sealcoat', sub_code: 'Coat', quantity: '1500', labor_hours: '4', employee: 'Eve Gray', rate: '30' }],
  };
  const p3 = {
    id: 'p3', 'project-name': '<img src=x onerror=alert(1)>', 'job-number': '"><b>9</b>', status: 'Complete', client: 'Acme Township',
    bidItems: [], dailyRows: [],
  };
  const pos = [{ id: 'po1', po_number: 'PO-1001', title: 'Hot Mix Base', supplier: 'Hot Mix Inc', status: 'approved', project_id: 'p1',
    lines: [{ id: 'l1', date: '2026-10-27', invoice_num: 'T-501', qty: '22.5', unit_cost: '61.37', tax_pct: '6' }] }];
  const trucks = [{ id: 't1', tr_number: 'TR-0001', driver: 'Dewey Hauler', truck_type: 'Tri-axle', project_id: 'p1', date: '2026-10-27',
    material_hauled: 'Millings', loads: '6', rate: '95.55', hours: '7.5', status: 'approved' }];
  return { projects: [p1, p2, p3], pos, trucks };
}

// ── /api/custom-reports, in memory ───────────────────────────────────────
// Keeps the rules the UI depends on: visibility, can_edit, per-scope unique
// names (case and whitespace blind), optimistic versions, soft delete and
// restore, kind / customer_safe derived from the definition, the run log.
function makeServer(opts) {
  opts = opts || {};
  const srv = {
    reports: [], runs: [], log: [], next: [],
    me: { userId: 7, username: 'pat' }, canShare: opts.canShare !== false, seq: 100,
  };
  const norm = n => String(n).trim().replace(/\s+/g, ' ').toLowerCase();
  const derive = def => ({
    kind: def && def.jobs && def.jobs.mode === 'saved' && Array.isArray(def.jobs.ids) && def.jobs.ids.length ? 'report' : 'template',
    customer_safe: !(def && def.includeInternal === true),
  });
  const visible = r => !r.deleted_at && (r.visibility === 'shared' || r.owner_user_id === srv.me.userId);
  const mayEdit = r => (r.visibility === 'private' && r.owner_user_id === srv.me.userId) || (r.visibility === 'shared' && srv.canShare);
  const shape = r => Object.assign({}, r, { mine: r.owner_user_id === srv.me.userId, can_edit: mayEdit(r) });
  const clash = (name, vis, owner, except) => srv.reports.some(r => !r.deleted_at && r.id !== except && r.visibility === vis
    && norm(r.name) === norm(name) && (vis === 'shared' || r.owner_user_id === owner));
  let clock = Date.parse('2026-11-01T12:00:00Z');
  const stamp = () => new Date(clock += 60000).toISOString();

  srv.add = row => {
    const r = Object.assign({ id: ++srv.seq, description: null, visibility: 'private', version: 1, owner_user_id: srv.me.userId,
      owner_username: 'pat', updated_by_username: 'pat', updated_at: stamp(), deleted_at: null, deleted_by_username: null,
      run_count: 0, last_run_at: null, definition: { v: 1 } }, row);
    Object.assign(r, derive(r.definition));
    srv.reports.push(r);
    return r;
  };
  srv.find = id => srv.reports.find(r => r.id === Number(id));
  srv.calls = (method, pred) => srv.log.filter(e => e.method === method && (!pred || pred(e)));

  srv.handle = async (url, init) => {
    init = init || {};
    const u = new URL(url, 'http://localhost');
    const q = Object.fromEntries(u.searchParams);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const entry = { method, path: u.pathname, q, auth: init.headers && init.headers.Authorization, body };
    srv.log.push(entry);
    const res = (status, b) => ({ ok: status >= 200 && status < 300, status, json: async () => b });
    if (srv.next.length && (!srv.next[0].match || srv.next[0].match(entry))) {
      const o = srv.next.shift();
      if (o.network) throw new TypeError('Failed to fetch');
      return res(o.status, o.body);
    }
    if (q.division !== 'paving') return res(400, { error: 'Custom reports are not available for this division' });

    if (method === 'GET' && q.runs) return res(200, { runs: srv.runs.slice().reverse() });
    if (method === 'GET' && q.deleted) {
      return res(200, { reports: srv.reports.filter(r => r.deleted_at && mayEdit(r)).map(shape), canShare: srv.canShare, me: srv.me });
    }
    if (method === 'GET') {
      return res(200, { reports: srv.reports.filter(visible).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(shape),
        canShare: srv.canShare, me: srv.me });
    }
    if (method === 'POST' && q.action === 'run') {
      const run = Object.assign({ id: srv.runs.length + 1, created_at: stamp(), run_by_username: 'pat' }, body);
      srv.runs.push(run);
      const r = body.report_id != null ? srv.find(body.report_id) : null;
      if (r && visible(r)) { r.run_count++; r.last_run_at = run.created_at; }
      return res(201, { run });
    }
    if (method === 'POST' && q.action === 'restore') {
      const r = srv.find(q.id);
      if (!r || !r.deleted_at) return res(404, { error: 'Report not found' });
      if (clash(r.name, r.visibility, r.owner_user_id, r.id)) return res(409, { error: 'name_taken' });
      r.deleted_at = null;
      r.updated_at = stamp();
      return res(200, { report: shape(r) });
    }
    if (method === 'POST') {
      if (!body || !body.name || !String(body.name).trim()) return res(400, { error: 'Give the report a name.' });
      if (!body.definition || body.definition.v !== 1) return res(400, { error: 'Unsupported report definition version (expected v: 1)' });
      const vis = body.visibility || 'private';
      if (vis === 'shared' && !srv.canShare) return res(403, { error: 'Only an admin or level 3 user can share a report with the division.' });
      if (clash(body.name, vis, srv.me.userId)) return res(409, { error: 'name_taken' });
      const r = srv.add({ name: String(body.name).trim(), description: body.description || null, visibility: vis, definition: body.definition });
      return res(201, { report: shape(r) });
    }
    if (method === 'PUT') {
      const r = srv.find(q.id);
      if (!r || !visible(r)) return res(404, { error: 'Report not found' });
      if (!mayEdit(r)) return res(403, { error: 'Only an admin or level 3 user can change a shared template.' });
      if (r.version !== body.version) return res(409, { error: 'version_conflict', report: shape(r) });
      const name = body.name !== undefined ? String(body.name).trim() : r.name;
      const vis = body.visibility || r.visibility;
      if (clash(name, vis, r.owner_user_id, r.id)) return res(409, { error: 'name_taken' });
      Object.assign(r, { name, visibility: vis, version: r.version + 1, updated_at: stamp(), updated_by_username: 'pat' });
      if (body.description !== undefined) r.description = body.description;
      if (body.definition !== undefined) { r.definition = body.definition; Object.assign(r, derive(r.definition)); }
      return res(200, { report: shape(r) });
    }
    if (method === 'DELETE') {
      const r = srv.find(q.id);
      if (!r || !visible(r)) return res(404, { error: 'Report not found' });
      if (!mayEdit(r)) return res(403, { error: 'nope' });
      r.deleted_at = stamp();
      r.deleted_by_username = 'pat';
      return res(200, { report: shape(r) });
    }
    return res(405, { error: 'Method not allowed' });
  };
  return srv;
}

// ── A page with the tab on it ────────────────────────────────────────────
// A fresh window per scenario, so module state (readiness, the open report)
// from one cannot prop up another.
function boot(o) {
  o = o || {};
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div class="tab-panel active" id="tab-customrpt"><div id="cr-content"></div></div>
    <div class="tab-panel" id="tab-other"></div></body></html>`,
  { url: 'http://localhost/paving.html', runScripts: 'dangerously', pretendToBeVisual: true });
  const window = dom.window, document = window.document;
  const srv = o.server || makeServer();
  const data = o.data || fixture();
  const h = { dom, window, document, srv, data, opened: [], dwCalls: [], email: [], confirms: [], answers: [], alerts: [],
    blobs: [], downloads: [], authErrors: 0, consoleErrors: [] };
  window.fetch = (url, init) => srv.handle(url, init);
  window.confirm = msg => { h.confirms.push(msg); return h.answers.length ? h.answers.shift() : true; };
  window.alert = msg => { h.alerts.push(msg); };
  window.open = () => {
    if (o.blockPopups) return null;
    const w = { closed: false, written: '', docClosed: 0,
      document: { write: (...c) => { w.written += c.join(''); }, open: () => { w.written = ''; }, close: () => { w.docClosed++; } },
      close: () => { w.closed = true; } };
    h.opened.push(w);
    return w;
  };
  window.openReportEmailModal = opts => { h.email.push(opts); };
  window.URL.createObjectURL = blob => { h.blobs.push(blob); return 'blob:test/' + h.blobs.length; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { h.downloads.push({ name: this.download, href: this.href }); };
  window.console.error = (...a) => { h.consoleErrors.push(a.join(' ')); };
  if (o.engine !== false) window.eval(ENGINE);
  window.eval(BRANDING);
  const realDw = window.dwWrite;
  window.dwWrite = (w, ...c) => { h.dwCalls.push(c.join('')); return realDw(w, ...c); };
  window.eval(UI);

  h.cfg = Object.assign({
    division: 'paving', divisionLabel: 'Paving', apiBase: '/api', getToken: () => 'tok-123',
    user: { username: 'pat' }, perm: { role: 'admin', canSeeCosts: true, canSeeFinancials: true, canShare: true },
    areaUnit: 'SY', ready: () => Promise.resolve(), getProjects: () => data.projects,
    getPurchaseOrders: () => data.pos, getTruckingEntries: () => data.trucks, helpers: {},
    onAuthError: () => { h.authErrors++; },
  }, o.cfg || {});
  window.FCTCustomReports.configure(h.cfg);
  h.mount = document.getElementById('cr-content');
  h.S = () => window.FCTCustomReports._internals.state();
  h.$ = sel => h.mount.querySelector(sel);
  h.$$ = sel => [...h.mount.querySelectorAll(sel)];
  // A real click or keystroke puts focus on the control first; a synthetic
  // event does not, so the helpers do it — the focus checks depend on it.
  h.click = el => {
    if (!el) throw new Error('click: no element');
    if (typeof el.focus === 'function') el.focus();
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  h.act = (act, extra) => h.$(`[data-act="${act}"]${extra || ''}`);
  h.type = (el, value) => { el.focus(); el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  h.change = (el, value) => { if (value !== undefined) el.value = value; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
  h.srcdoc = () => (h.$('.cr-frame') || { getAttribute: () => '' }).getAttribute('srcdoc') || '';
  h.modal = () => document.querySelector('.cr-modal');
  h.toast = () => { const t = document.querySelector('.cr-toast'); return t ? t.textContent : ''; };
  h.sec = type => h.S().doc.def.sections.find(s => s.type === type);
  h.colBox = (secId, key) => h.$(`input[data-bind="col"][data-sec="${secId}"][data-key="${key}"]`);
  h.render = async () => { window.FCTCustomReports.renderTab(h.mount); await tick(); };
  h.close = () => window.close();
  return h;
}
function seed(srv) {
  srv.add({ id: 1, name: 'Acme weekly update', description: 'Every Friday', definition: {
    v: 1, title: 'Weekly Update', jobs: { mode: 'saved', ids: ['p1', 'gone-job'] },
    sections: [{ type: 'job_info' }, { type: 'bid_progress' }] } });
  srv.add({ id: 2, name: 'Division progress template', visibility: 'shared', owner_user_id: 3, owner_username: 'boss',
    updated_by_username: 'boss', definition: { v: 1, sections: [{ type: 'summary_kpis' }, { type: 'bid_progress' }] } });
  srv.add({ id: 3, name: 'Cost check', definition: { v: 1, includeInternal: true, sections: [{ type: 'bid_progress', columns: ['cost_code', 'actual_cost'] }] } });
  srv.add({ id: 4, name: XSS_NAME, description: '"><script>window.__xss=2</script>', definition: { v: 1, sections: [{ type: 'notes', text: 'hi' }] } });
  srv.seq = 100;
  return srv;
}

(async () => {
  // ════════════════════════════════════════════════════════════════════
  section('Loading — waits for the engine, then lists everything');
  {
    const h = boot({ engine: false, server: seed(makeServer()) });
    h.window.FCTCustomReports.renderTab(h.mount);
    assert('without the engine it says it is still loading', /still loading/i.test(h.mount.textContent), h.mount.textContent);
    assert('…and has not called the API yet', h.srv.log.length === 0);
    h.window.eval(ENGINE);
    await sleep(260);
    await tick();
    assert('once the engine arrives the tab renders by itself', !!h.$('.cr-rail') && !/still loading/i.test(h.mount.textContent));

    const gets = h.srv.calls('GET');
    assert('the list is fetched', gets.length === 1);
    assert('every call sends Authorization: Bearer <token>', h.srv.log.every(e => e.auth === 'Bearer tok-123'), JSON.stringify(h.srv.log.map(e => e.auth)));
    assert('every call sends ?division=paving', h.srv.log.every(e => e.q.division === 'paving' && e.path === '/api/custom-reports'));

    const E = h.window.FCTReportEngine;
    const railText = h.$('.cr-rail').textContent;
    assert('all seven starter templates are listed in the rail', E.STARTERS.length === 7 && E.STARTERS.every(s => railText.includes(s.name)));
    assert('the welcome panel offers every starter as a card, plus a blank report',
      h.$$('.cr-card[data-act="starter"]').length === 7 && !!h.$('.cr-card[data-act="new"]'));
    const groups = h.$$('.cr-group');
    const mineG = groups.find(g => /My Reports/.test(g.textContent));
    const sharedG = groups.find(g => /Shared Templates/.test(g.textContent));
    assert('private reports sit under My Reports', /Acme weekly update/.test(mineG.textContent) && /Cost check/.test(mineG.textContent) && !/Division progress/.test(mineG.textContent));
    assert('shared templates sit under Shared Templates', /Division progress template/.test(sharedG.textContent));
    const acme = h.$('[data-act="open"][data-id="1"]');
    assert('a saved-jobs report is badged "Saved jobs" and "Private"', /Saved jobs/.test(acme.textContent) && /Private/.test(acme.textContent));
    assert('a report with internal data is badged Internal', /Internal/.test(h.$('[data-act="open"][data-id="3"]').textContent));
    assert('…and a customer-safe one is not', !/Internal/.test(acme.textContent));
    assert('each item says who updated it and when', /updated by pat · /.test(acme.textContent));

    section('XSS — names are text, never markup');
    assert('a report named <img onerror> creates no element', h.mount.querySelectorAll('img, script').length === 0);
    assert('…and shows its name literally', h.$('[data-act="open"][data-id="4"]').textContent.includes(XSS_NAME));
    assert('…including in its description tooltip', h.$('[data-act="open"][data-id="4"]').getAttribute('title').includes('<script>'));
    assert('nothing ran', h.window.__xss === undefined);
    h.click(h.$('[data-act="open"][data-id="4"]'));
    await tick();
    assert('opened, the name sits in the name box as typed', h.$('[data-bind="name"]').value === XSS_NAME);
    assert('still no element, still nothing ran', h.mount.querySelectorAll('img, script').length === 0 && h.window.__xss === undefined);
    assert('the preview escapes it too', h.srcdoc().includes('&lt;img src=x') || !h.srcdoc().includes('<img'));
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('A starter — open it, pick jobs, watch the preview');
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    await tick();
    const S = h.S();
    assert('opening a starter makes an unsaved new report', S.view === 'edit' && S.doc && S.doc.id === null && S.doc.starterId === 'customer_progress');
    assert('the name box holds the starter name', h.$('[data-bind="name"]').value === 'Customer Progress Update');
    assert('"● Unsaved changes" shows and Save is enabled', !h.$('.cr-dirty').hidden && !h.act('save').disabled);
    assert('the three steps are tabs, step ① selected',
      h.$$('.cr-step[role="tab"]').length === 3 && h.$('#cr-step-1').getAttribute('aria-selected') === 'true');
    assert('the preview frame is sandboxed with no scripts', h.$('.cr-frame').getAttribute('sandbox') === 'allow-same-origin');
    assert('the preview is the print document, DataWatch masthead and all', /data-dw-brand/.test(h.srcdoc()) && /DataWatch/.test(h.srcdoc()));
    assert('with no jobs the preview says to pick some', !h.$('.cr-preview-hint').hidden && /Pick one or more jobs/.test(h.$('.cr-preview-hint').textContent));
    assert('a starter opens asking for jobs', !h.$('.cr-callout').hidden);
    assert('the job list escapes a job named <img onerror>', h.mount.querySelectorAll('.cr-joblist img').length === 0
      && h.$('.cr-joblist').textContent.includes('<img src=x onerror=alert(1)>'));

    section('Job picker');
    const search = h.$('[data-bind="job-search"]');
    h.type(search, 'elm');
    assert('searching filters the checklist', h.$$('.cr-job').length === 1 && /Elm Street Lot/.test(h.$('.cr-joblist').textContent));
    assert('focus stays in the search box while typing', h.document.activeElement === h.$('[data-bind="job-search"]'));
    h.click(h.act('jobs-shown'));
    assert('"Select all shown" picks what the search shows', JSON.stringify(h.S().doc.picked) === '["p2"]');
    assert('"1 job selected"', /1 job selected/.test(h.$('.cr-count').textContent));
    assert('the "pick the jobs" callout goes once a job is picked', h.$('.cr-callout').hidden);
    h.type(h.$('[data-bind="job-search"]'), '');
    h.$$('.cr-job input')[0].click();   // tick Route 30
    assert('ticking a job adds it, in the order picked', JSON.stringify(h.S().doc.picked) === '["p2","p1"]');
    assert('two clients on one report earns a warning', /2 different clients/.test(h.$('.cr-jobwarn').textContent));
    await sleep(PREVIEW_WAIT);
    assert('the preview redraws with both jobs', /Route 30 Resurfacing/.test(h.srcdoc()) && /Elm Street Lot/.test(h.srcdoc()));
    assert('…and the hint goes away', h.$('.cr-preview-hint').hidden);
    h.click(h.act('jobs-active'));
    assert('"All In Progress" selects exactly the In Progress jobs', JSON.stringify(h.S().doc.picked.slice().sort()) === '["p1","p2"]');
    h.change(h.$('[data-bind="jobs-client"]'), 'Acme Township');
    assert('the Client pick selects that client\'s jobs only', JSON.stringify(h.S().doc.picked.slice().sort()) === '["p1","p3"]');
    assert('…and the dropdown resets', h.$('[data-bind="jobs-client"]').value === '');
    h.click(h.act('jobs-clear'));
    assert('Clear empties the selection', h.S().doc.picked.length === 0 && /No jobs selected/.test(h.$('.cr-count').textContent));
    h.$$('.cr-job input')[0].click();
    assert('one job again', JSON.stringify(h.S().doc.picked) === '["p1"]');

    section('Dates and layout');
    h.change(h.$('[data-bind="preset"]'), 'last_week');
    assert('a preset is stored in the definition', h.S().doc.def.dates.preset === 'last_week');
    assert('…and its range is shown in words', /–/.test(h.$('.cr-range').textContent));
    const shown = h.window.FCTReportEngine.resolveDateRange({ preset: 'last_week' });
    h.change(h.$('[data-bind="preset"]'), 'custom');
    assert('switching to Custom starts from the dates just shown',
      h.$('[data-bind="from"]').value === shown.from && h.$('[data-bind="to"]').value === shown.to, `${h.$('[data-bind="from"]').value}`);
    h.change(h.$('[data-bind="from"]'), '2026-10-01');
    h.change(h.$('[data-bind="to"]'), '2026-10-31');
    await sleep(PREVIEW_WAIT);
    assert('a custom range reaches the preview', /Oct 1 – Oct 31, 2026/.test(h.srcdoc()));
    h.$('[data-bind="layout"][value="combined"]').click();
    assert('Combined layout is stored', h.S().doc.def.layout === 'combined');
    assert('…and the page-break box is disabled with it', h.$('[data-bind="pagebreak"]').disabled);
    h.$('[data-bind="layout"][value="separate"]').click();
    h.$('[data-bind="orientation"][value="landscape"]').click();
    await sleep(PREVIEW_WAIT);
    assert('landscape reaches the printed page size', /size:letter landscape/.test(h.srcdoc()));

    section('Step ② — columns, locks and the customer-safe switch');
    h.click(h.$('#cr-step-2'));
    assert('step ② is selected', h.$('#cr-step-2').getAttribute('aria-selected') === 'true' && !!h.$('[data-bind="internal"]'));
    const bp = h.sec('bid_progress');
    assert('sections open folded, with a column summary', !!h.$(`.cr-sec[data-sec="${bp.id}"] .cr-sec-sum`));
    h.click(h.$(`[data-act="sec-toggle"][data-sec="${bp.id}"]`));
    assert('expanding a section shows its columns', !!h.colBox(bp.id, 'description'));
    assert('focus stays on the toggle after it redraws', h.document.activeElement === h.$(`[data-act="sec-toggle"][data-sec="${bp.id}"]`));
    const before = h.srcdoc();
    assert('the preview has no Description column yet', !/>Description</.test(before));
    h.colBox(bp.id, 'description').click();
    assert('ticking a column adds it to the section', bp.columns.includes('description'));
    assert('…in catalog order, after Sub Code', bp.columns.indexOf('description') === bp.columns.indexOf('sub_code') + 1, bp.columns.join());
    await sleep(PREVIEW_WAIT);
    assert('the preview redraws with the new column', />Description</.test(h.srcdoc()) && h.srcdoc() !== before);

    const lockedBox = h.colBox(bp.id, 'actual_cost');
    assert('an internal column is listed with a lock, its box disabled', lockedBox && lockedBox.disabled
      && /🔒/.test(lockedBox.closest('.cr-col').textContent));
    assert('…with a tooltip saying how to unlock it', /Include internal data/.test(lockedBox.closest('.cr-col').getAttribute('title')));
    lockedBox.disabled = false;   // a forged or stale control
    lockedBox.click();
    assert('a locked column cannot be ticked while customer-safe', !bp.columns.includes('actual_cost'));
    await sleep(PREVIEW_WAIT);
    assert('…and never reaches the preview', !/Actual Cost/.test(h.srcdoc()) && !/INTERNAL/.test(h.srcdoc()));

    h.answers.push(false);
    h.$('[data-bind="internal"]').click();
    assert('turning internal data on asks first, in the spec\'s words',
      h.confirms.pop() === 'This report will be able to show costs, rates, hours, employee names and profit. Don\'t send it to a customer. Continue?');
    assert('saying no leaves it customer-safe', h.S().doc.def.includeInternal === false && !h.$('[data-bind="internal"]').checked);
    assert('no red banner', !h.$('.cr-banner-int'));
    h.$('[data-bind="internal"]').click();
    assert('saying yes turns it on', h.S().doc.def.includeInternal === true);
    assert('a red INTERNAL banner shows while it is on', !!h.$('.cr-banner-int') && /Don.t send it to a customer/.test(h.$('.cr-banner-int').textContent));
    const unlocked = h.colBox(bp.id, 'actual_cost');
    assert('the internal columns unlock', unlocked && !unlocked.disabled);
    unlocked.click();
    await sleep(PREVIEW_WAIT);
    assert('an internal column now prints, with the INTERNAL tag on the report',
      /Actual Cost/.test(h.srcdoc()) && /INTERNAL — contains cost data/.test(h.srcdoc()));
    assert('the step strip says Internal', /Internal/.test(h.$('#cr-step-2').textContent));
    h.click(h.act('internal-off'));
    assert('"Make it customer-safe" turns it off without asking', h.S().doc.def.includeInternal === false && h.confirms.length === 1);
    assert('the banner goes', !h.$('.cr-banner-int'));
    assert('the column stays chosen for later, but locked', bp.columns.includes('actual_cost') && h.colBox(bp.id, 'actual_cost').disabled);
    await sleep(PREVIEW_WAIT);
    assert('…and is gone from the preview with the INTERNAL tag', !/Actual Cost/.test(h.srcdoc()) && !/INTERNAL/.test(h.srcdoc()));

    section('Column order, labels and options');
    h.click(h.$(`[data-act="col-up"][data-sec="${bp.id}"][data-key="description"]`));
    assert('↑ moves a column earlier', bp.columns.indexOf('description') === bp.columns.indexOf('sub_code') - 1, bp.columns.join());
    assert('focus follows the moved column', h.document.activeElement === h.$(`[data-act="col-up"][data-sec="${bp.id}"][data-key="description"]`));
    h.click(h.$(`[data-act="col-label"][data-sec="${bp.id}"][data-key="bid_qty"]`));
    const lbl = h.$('[data-bind="col-label"]');
    assert('✎ opens a label box, focused', lbl && h.document.activeElement === lbl);
    h.type(lbl, 'Qty Bid');
    lbl.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert('Enter keeps the new printed label', bp.labels.bid_qty === 'Qty Bid' && !h.$('[data-bind="col-label"]'));
    await sleep(PREVIEW_WAIT);
    assert('the preview prints the custom label', />Qty Bid</.test(h.srcdoc()));
    h.click(h.$(`[data-act="col-label"][data-sec="${bp.id}"][data-key="bid_qty"]`));
    h.type(h.$('[data-bind="col-label"]'), 'Something else');
    h.$('[data-bind="col-label"]').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert('Escape puts the label back', bp.labels.bid_qty === 'Qty Bid');
    h.click(h.$(`[data-act="col-label"][data-sec="${bp.id}"][data-key="bid_qty"]`));
    h.type(h.$('[data-bind="col-label"]'), '   ');
    h.$('[data-bind="col-label"]').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert('a blank label resets to the standard one', !('bid_qty' in bp.labels));

    h.change(h.$(`[data-bind="opt"][data-sec="${bp.id}"][data-key="groupBy"]`), 'none');
    assert('a select option is stored', bp.options.groupBy === 'none');
    h.$(`[data-bind="opt"][data-sec="${bp.id}"][data-key="hideComplete"]`).click();
    assert('a yes/no option is stored', bp.options.hideComplete === true);
    const ccBoxes = h.$$(`[data-bind="opt-cc"][data-sec="${bp.id}"]`);
    assert('the cost-code filter lists the picked job\'s codes', ccBoxes.map(b => b.getAttribute('data-value')).join() === 'Milling,Paving');
    ccBoxes.find(b => b.getAttribute('data-value') === 'Paving').click();
    assert('ticking a code filters to it', JSON.stringify(bp.options.costCodes) === '["Paving"]');
    h.click(h.$(`[data-act="cc-all"][data-sec="${bp.id}"]`));
    assert('"Show all" clears the filter', bp.options.costCodes.length === 0);

    section('Sections — add, move, remove, undo');
    const n0 = h.S().doc.def.sections.length;
    h.click(h.act('add-menu'));
    const items = [...h.document.querySelectorAll('.cr-menu [role="menuitem"]')];
    assert('"+ Add section" lists every section type with a description',
      items.length === h.window.FCTReportEngine.SECTION_ORDER.length && items.every(i => i.querySelector('small')));
    assert('…as a menu, focus on its first item', h.act('add-menu').getAttribute('aria-expanded') === 'true' && h.document.activeElement === items[0]);
    items[0].dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert('arrow keys move through the menu', h.document.activeElement === items[1]);
    h.click(items.find(i => i.getAttribute('data-type') === 'materials'));
    const secs = h.S().doc.def.sections;
    assert('picking one adds it at the end, expanded', secs.length === n0 + 1 && secs[secs.length - 1].type === 'materials'
      && !h.S().collapsed.has(secs[secs.length - 1].id));
    assert('the menu closes', !h.document.querySelector('.cr-menu'));
    const mat = secs[secs.length - 1];
    h.click(h.$(`[data-act="sec-up"][data-sec="${mat.id}"]`));
    assert('↑ moves a section up', h.S().doc.def.sections[n0 - 1].id === mat.id);
    h.click(h.$(`[data-act="sec-remove"][data-sec="${mat.id}"]`));
    assert('✕ removes it', !h.S().doc.def.sections.includes(mat));
    const undo = h.document.querySelector('.cr-toast button');
    assert('…with an Undo', undo && /Undo/.test(undo.textContent));
    undo.click();
    assert('Undo puts it back where it was', h.S().doc.def.sections[n0 - 1] === mat);

    section('Step ③ — header and notes');
    h.click(h.$('#cr-step-3'));
    assert('Prepared for suggests the single job\'s client', /Acme Township/.test(h.$('[data-bind="h-preparedFor"]').placeholder));
    assert('Prepared by suggests the user', /pat/.test(h.$('[data-bind="h-preparedBy"]').placeholder));
    await sleep(PREVIEW_WAIT);
    assert('…and both print when left blank', /Prepared for Acme Township/.test(h.srcdoc()) && /Prepared by pat/.test(h.srcdoc()));
    h.type(h.$('[data-bind="title"]'), 'Route 30 — Week 44');
    h.type(h.$('[data-bind="h-intro"]'), 'Base course is down.\nSurface next week.');
    const note = h.sec('notes');
    h.type(h.$(`[data-bind="sec-text"][data-sec="${note.id}"]`), 'Thanks <b>for</b> your patience.');
    await sleep(PREVIEW_WAIT);
    const doc = h.srcdoc();
    assert('the title, intro and notes reach the preview', /Route 30 — Week 44/.test(doc) && /Base course is down\.<br>Surface next week\./.test(doc)
      && /Thanks &lt;b&gt;for&lt;\/b&gt; your patience\./.test(doc));
    assert('typing does not lose focus', h.document.activeElement === h.$(`[data-bind="sec-text"][data-sec="${note.id}"]`));

    section('Keyboard — the step strip is a tab list');
    h.$('#cr-step-3').focus();
    h.$('#cr-step-3').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert('← moves to the previous step and focuses it', h.S().step === 2 && h.document.activeElement === h.$('#cr-step-2'));
    h.$('#cr-step-2').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert('Home goes to step ①', h.S().step === 1);

    section('Save — new report');
    h.click(h.act('save'));
    await tick();
    let m = h.modal();
    assert('Save on a new report asks for a name', m && m.querySelector('#cr-m-name'));
    assert('…defaulting to the name in the bar', m.querySelector('#cr-m-name').value === 'Customer Progress Update');
    assert('…offering "Share with division" to an admin', !!m.querySelector('#cr-m-share'));
    assert('focus is in the name box', h.document.activeElement === m.querySelector('#cr-m-name'));
    const keepBox = m.querySelector('#cr-m-savejobs');
    assert('with one job picked it offers to keep it with the report, ticked',
      keepBox && keepBox.checked && /Keep this job with the report/.test(m.textContent), m.textContent.slice(0, 200));
    if (keepBox) keepBox.checked = false;   // this one stays a template
    m.querySelector('#cr-m-name').value = 'Route 30 weekly';
    m.querySelector('[data-m="ok"]').click();
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    assert('it POSTs the name and a v1 definition', post && post.body.name === 'Route 30 weekly' && post.body.definition.v === 1);
    assert('…private by default', post.body.visibility === 'private');
    assert('…with every section, in order', post.body.definition.sections.map(s => s.type).join() === h.S().doc.def.sections.map(s => s.type).join());
    assert('…the edits made above', post.body.definition.title === 'Route 30 — Week 44'
      && post.body.definition.sections.find(s => s.type === 'bid_progress').columns.includes('description'));
    assert('…and, unticked "save jobs", as a template with no jobs', post.body.definition.jobs.mode === 'pick' && post.body.definition.jobs.ids.length === 0);
    assert('the blank header lines are not baked in', post.body.definition.header.preparedFor === '' && post.body.definition.header.preparedBy === '');
    assert('the dialog closes', !h.modal());
    assert('the report now has an id and is clean', h.S().doc.id > 100 && h.$('.cr-dirty').hidden && h.act('save').disabled);
    assert('it appears under My Reports, highlighted', /Route 30 weekly/.test(h.$('.cr-item.active').textContent));
    assert('picking different jobs on a template is not an unsaved change', (() => {
      h.click(h.$('#cr-step-1'));
      h.$$('.cr-job input')[1].click();
      return h.$('.cr-dirty').hidden;
    })());
    h.$('[data-bind="save-jobs"]').click();
    assert('ticking "Save these jobs" is', !h.$('.cr-dirty').hidden && !h.act('save').disabled);

    section('Save — existing report (PUT), Ctrl+S');
    const kd = () => h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    h.document.getElementById('tab-customrpt').classList.remove('active');
    kd();
    await tick();
    assert('Ctrl+S does nothing while the tab is hidden', h.srv.calls('PUT').length === 0);
    h.document.getElementById('tab-customrpt').classList.add('active');
    kd();
    await tick();
    const put = h.srv.calls('PUT').pop();
    assert('Ctrl+S saves with a PUT ?id=…', put && put.q.id === String(h.S().doc.id));
    assert('…sending the version it opened', put.body.version === 1);
    assert('…and the jobs, now saved with it', put.body.definition.jobs.mode === 'saved' && JSON.stringify(put.body.definition.jobs.ids) === '["p1","p2"]');
    assert('the version moves on and the report is clean', h.S().doc.version === 2 && h.$('.cr-dirty').hidden);

    section('Outputs — Print / PDF');
    h.click(h.act('print'));
    assert('Print opens the window inside the click', h.opened.length === 1);
    assert('…and writes through dwWrite, with the print script', h.dwCalls.length === 1 && /data-dw-brand/.test(h.dwCalls[0])
      && /window\.print\(\)/.test(h.dwCalls[0]));
    assert('the written page has the DataWatch masthead exactly once', (h.opened[0].written.match(/data-dw-brand/g) || []).length === 1);
    assert('…and the document is closed so it finishes loading', h.opened[0].docClosed === 1);
    await tick();
    let run = h.srv.calls('POST', e => e.q.action === 'run').pop();
    assert('a print run is logged', run && run.body.action === 'print' && run.body.report_id === h.S().doc.id
      && JSON.stringify(run.body.project_ids) === '["p1","p2"]' && run.body.report_name === 'Route 30 weekly');
    assert('…with the job names, range and definition', run.body.project_names[0] === 'Route 30 Resurfacing'
      && run.body.date_from === '2026-10-01' && run.body.date_to === '2026-10-31' && run.body.definition.v === 1);
    assert('…flagged customer-safe', run.body.included_internal === false && run.body.recipients.length === 0);

    section('Outputs — Email');
    h.click(h.act('email'));
    await tick();
    assert('Email opens the shared email modal', h.email.length === 1);
    const em = h.email[0];
    assert('…as a paving_custom_report', em.reportType === 'paving_custom_report');
    assert('…for 2 jobs, with no single project id, and no project name for the server to swap a typed subject for',
      em.projectId === null && em.projectName === null);
    assert('…describing the send for the server-side history (jobs, dates, snapshot, internal flag)',
      em.customReport && em.customReport.report_id === h.S().doc.id && JSON.stringify(em.customReport.project_ids) === '["p1","p2"]'
        && em.customReport.date_from === '2026-10-01' && em.customReport.definition.v === 1 && em.customReport.included_internal === false
        && !('recipients' in em.customReport) && !('action' in em.customReport), JSON.stringify(em.customReport && Object.keys(em.customReport)));
    assert('…subject "<title> — <jobs>"', em.defaultSubject === 'Route 30 — Week 44 — 2 jobs', em.defaultSubject);
    assert('…and the report HTML on demand, branded', typeof em.getHTML === 'function' && /data-dw-brand/.test(em.getHTML()));
    const runsBefore = h.srv.calls('POST', e => e.q.action === 'run').length;
    assert('…with an onSent callback for the send history', typeof em.onSent === 'function');
    if (typeof em.onSent === 'function') await em.onSent({ recipients: ['owner@acme.com'], subject: 'Week 44', recipientCount: 1, pdfAttached: true });
    run = h.srv.calls('POST', e => e.q.action === 'run').pop();
    assert('onSent logs an email run with recipients and subject when the server did not', h.srv.calls('POST', e => e.q.action === 'run').length === runsBefore + 1
      && run.body.action === 'email' && run.body.recipients[0] === 'owner@acme.com' && run.body.subject === 'Week 44');
    if (typeof em.onSent === 'function') await em.onSent({ recipients: ['owner@acme.com'], subject: 'Week 44', recipientCount: 1, pdfAttached: true, logged: true, runId: 9 });
    await tick();
    assert('…and logs nothing more when the server already recorded the send (one row either way)',
      h.srv.calls('POST', e => e.q.action === 'run').length === runsBefore + 1);

    section('Outputs — Excel');
    h.click(h.act('excel'));
    await tick();
    assert('Excel hands a Blob to a download link', h.blobs.length === 1 && h.downloads.length === 1);
    assert('…typed as an .xlsx', h.blobs[0].type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert('…named "<title>-<date>.xlsx"', /^Route-30-Week-44-\d{4}-\d{2}-\d{2}\.xlsx$/.test(h.downloads[0].name), h.downloads[0].name);
    const bytes = Buffer.from(await h.blobs[0].arrayBuffer());
    assert('…and it is a ZIP (PK…)', bytes[0] === 0x50 && bytes[1] === 0x4b);
    // Stored entries: the sheet XML is readable as-is. The locked column is not in it.
    const raw = bytes.toString('utf8');
    assert('the workbook carries no locked column', !/Actual Cost/.test(raw) && /Qty|Bid Qty/.test(raw));
    run = h.srv.calls('POST', e => e.q.action === 'run').pop();
    assert('an excel run is logged', run.body.action === 'excel');
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('Outputs — guards');
  {
    const h = boot({ server: seed(makeServer()), blockPopups: true });
    await h.render();
    h.click(h.$('.cr-card[data-starter="haul_log"]'));
    h.click(h.act('print'));
    assert('with no jobs, Print opens nothing and says why', h.opened.length === 0 && /Pick at least one job/.test(h.toast()));
    h.$$('.cr-job input')[0].click();
    h.click(h.act('print'));
    assert('a blocked pop-up is explained', /Allow pop-ups/.test(h.alerts[0] || ''));
    delete h.window.openReportEmailModal;
    h.click(h.act('email'));
    await tick();
    assert('no email module → a clear message, no crash', /Email module is still loading/.test(h.alerts[1] || ''));
    h.close();
  }
  {
    // Old daily rows still loading: the window opens at once (pop-up rule),
    // the report is written once they are in.
    let release;
    const gate = new Promise(r => { release = r; });
    const h = boot({ server: seed(makeServer()), cfg: { ready: () => gate } });
    await h.render();
    h.click(h.$('.cr-card[data-starter="haul_log"]'));
    assert('the preview says older entries are loading', /Loading older daily entries/.test(h.$('.cr-preview-note').textContent));
    h.$$('.cr-job input')[0].click();
    h.click(h.act('print'));
    assert('Print still opens the window inside the click', h.opened.length === 1 && h.dwCalls.length === 0);
    assert('…showing "Preparing" meanwhile', /Preparing your report/.test(h.opened[0].written));
    release();
    await tick(6);
    assert('…and writes the report when the history is in', h.dwCalls.length === 1 && /data-dw-brand/.test(h.opened[0].written)
      && !/Preparing/.test(h.opened[0].written));
    assert('the preview note clears', h.$('.cr-preview-note').textContent === '');
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    h.click(h.$('.cr-card[data-starter="internal_cost_snapshot"]'));
    assert('the Internal Cost Snapshot starter opens with internal data on, no question asked',
      h.S().doc.def.includeInternal === true && h.confirms.length === 0 && !!h.$('.cr-banner-int'));
    h.$$('.cr-job input')[0].click();
    await sleep(PREVIEW_WAIT);
    assert('…its preview is tagged INTERNAL', /INTERNAL — contains cost data/.test(h.srcdoc()));
    h.answers.push(false);
    h.click(h.act('email'));
    await tick();
    assert('emailing an internal report asks first', /includes internal data/.test(h.confirms[0] || ''));
    assert('…and "no" sends nothing', h.email.length === 0);
    h.click(h.act('print'));
    await tick();
    const run = h.srv.calls('POST', e => e.q.action === 'run').pop();
    assert('an internal print is logged as internal, against no saved report', run.body.included_internal === true && run.body.report_id === null);
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('Roles — financial columns, no-cost roles');
  {
    const h = boot({ server: seed(makeServer({ canShare: false })),
      cfg: { perm: { role: 'level2', canSeeCosts: true, canSeeFinancials: false, canShare: false } } });
    await h.render();
    h.click(h.$('.cr-card[data-starter="internal_cost_snapshot"]'));
    h.$$('.cr-job input')[0].click();
    assert('a role that cannot see Financials gets the note', /1 column hidden — your role can't see contract or profit figures/.test(h.$('.cr-banners').textContent),
      h.$('.cr-banners').textContent);
    h.click(h.$('#cr-step-2'));
    const kpi = h.sec('summary_kpis');
    h.click(h.$(`[data-act="sec-toggle"][data-sec="${kpi.id}"]`));
    assert('…and the financial column is not listed at all', !h.colBox(kpi.id, 'gp_earned') && !!h.colBox(kpi.id, 'actual_cost'));
    await sleep(PREVIEW_WAIT);
    assert('…nor printed', !/GP Earned/.test(h.srcdoc()) && /Actual Cost/.test(h.srcdoc()));
    h.click(h.act('save'));
    await tick();
    assert('no "Share with division" offered without the right', !h.modal().querySelector('#cr-m-share'));
    h.modal().querySelector('[data-m="cancel"]').click();
    h.click(h.act('doc-menu'));
    assert('…nor in the ⋯ menu', !h.document.querySelector('.cr-menu [data-act="share"]'));
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer()), cfg: { perm: { role: 'level1', canSeeCosts: false, canSeeFinancials: false } } });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.click(h.$('#cr-step-2'));
    assert('a role that cannot see costs gets the switch disabled', h.$('[data-bind="internal"]').disabled);
    const bp = h.sec('bid_progress');
    h.click(h.$(`[data-act="sec-toggle"][data-sec="${bp.id}"]`));
    assert('…and no internal columns listed', !h.colBox(bp.id, 'actual_cost') && !!h.colBox(bp.id, 'description'));
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('Saved reports — opening, read-only, missing jobs, the unsaved guard');
  {
    const h = boot({ server: seed(makeServer({ canShare: false })) });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="1"]'));
    await tick();
    let S = h.S();
    assert('a saved-jobs report opens with its jobs ticked', JSON.stringify(S.doc.picked) === '["p1"]' && S.doc.saveJobs);
    assert('a job that no longer exists is dropped with a note', /1 saved job no longer exists and was left out/.test(h.$('.cr-banners').textContent));
    assert('…without counting as an unsaved change', h.$('.cr-dirty').hidden && h.act('save').disabled);
    assert('the name box shows the saved name', h.$('[data-bind="name"]').value === 'Acme weekly update');

    h.type(h.$('[data-bind="name"]'), 'Acme weekly update v2');
    assert('renaming in the bar is an unsaved change', !h.$('.cr-dirty').hidden && !h.act('save').disabled);
    h.answers.push(false);
    h.click(h.$('[data-act="open"][data-id="2"]'));
    assert('opening another report with unsaved changes asks first', /unsaved changes to "Acme weekly update v2"/.test(h.confirms.pop() || ''));
    assert('…and "no" keeps the work', h.S().doc.id === 1 && h.S().doc.name === 'Acme weekly update v2');
    h.answers.push(false);
    h.click(h.act('new'));
    assert('so does + New Report', h.confirms.length === 1 && h.S().doc.id === 1);
    h.confirms.length = 0;
    h.click(h.$('[data-act="open"][data-id="2"]'));   // answer defaults to yes
    await tick();
    S = h.S();
    assert('"yes" opens the other one', S.doc.id === 2);
    assert('a shared template you cannot edit opens read-only, with the banner', S.doc.readOnly
      && /Save As to make your own copy/.test(h.$('.cr-banner-ro').textContent));
    assert('a template opens with no jobs, asking for them', S.doc.picked.length === 0 && !h.$('.cr-callout').hidden);
    h.$$('.cr-job input')[0].click();
    assert('it can still be changed for this run, but Save stays off', h.act('save').disabled);
    h.click(h.act('doc-menu'));
    assert('…and the ⋯ menu has no Delete', !h.document.querySelector('.cr-menu [data-act="delete"]')
      && !!h.document.querySelector('.cr-menu [data-act="duplicate"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="close"]'));   // closes the menu… then the report (no edits stored → no ask)
    await tick();
    assert('"Close report" goes back to the welcome panel', h.S().view === 'home' && !!h.$('.cr-cards'));
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer({ canShare: false })) });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="2"]'));
    h.click(h.act('save-as'));
    await tick();
    const m = h.modal();
    assert('Save As on a shared template suggests "… (copy)"', m.querySelector('#cr-m-name').value === 'Division progress template (copy)');
    m.querySelector('[data-m="ok"]').click();
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    assert('…and POSTs a private copy of the definition', post.body.visibility === 'private'
      && post.body.definition.sections.map(s => s.type).join() === 'summary_kpis,bid_progress');
    assert('the copy is now open, editable', h.S().doc.id > 100 && !h.S().doc.readOnly && !h.$('.cr-banner-ro'));
    h.click(h.$('[data-act="open"][data-id="2"]'));
    await tick();
    h.type(h.$('[data-bind="name"]'), 'Beta Corp version');
    h.click(h.act('save-as'));
    await tick();
    assert('a name already typed in the bar is what Save As offers', h.modal().querySelector('#cr-m-name').value === 'Beta Corp version');
    h.modal().querySelector('[data-m="cancel"]').click();
    assert('Cancel closes the dialog and keeps the report as it was', !h.modal() && h.S().doc.id === 2);
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('Save — name taken, version conflict, errors');
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    h.click(h.act('new'));
    assert('+ New Report opens a blank report', h.S().doc.def.sections.length === 0 && h.S().doc.name === '');
    assert('…whose preview says it has no sections once a job is picked', (() => {
      h.$$('.cr-job input')[0].click();
      h.window.FCTCustomReports.renderTab(h.mount);
      return /no sections/.test(h.$('.cr-preview-hint').textContent);
    })());
    h.click(h.act('save'));
    await tick();
    let m = h.modal();
    assert('a blank report\'s name defaults to "Untitled report"', m.querySelector('#cr-m-name').value === 'Untitled report');
    m.querySelector('#cr-m-name').value = '  acme   WEEKLY update ';
    m.querySelector('[data-m="ok"]').click();
    await tick();
    assert('a name already used (any case or spacing) is refused by the server', h.srv.log[h.srv.log.length - 1].method === 'POST');
    assert('…the dialog stays open and says so', !!h.modal() && /already have a report called/.test(h.modal().querySelector('.cr-m-err').textContent));
    m = h.modal();
    m.querySelector('#cr-m-name').value = 'Acme monthly';
    m.querySelector('#cr-m-name').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    assert('a new name saves (Enter works too)', !h.modal() && h.S().doc.name === 'Acme monthly' && h.S().doc.id > 100);
    m = null;

    // Shared, by an admin, through the dialog.
    h.click(h.act('save-as'));
    await tick();
    h.modal().querySelector('#cr-m-share').checked = true;
    h.modal().querySelector('#cr-m-name').value = 'Division progress template';
    h.modal().querySelector('[data-m="ok"]').click();
    await tick();
    assert('sharing under a taken shared name is refused, saying so', /already a shared template/.test(h.modal().querySelector('.cr-m-err').textContent));
    h.modal().querySelector('#cr-m-name').value = 'Monthly owner update';
    h.modal().querySelector('[data-m="ok"]').click();
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    assert('"Share with division" saves it shared', post.body.visibility === 'shared' && h.S().doc.visibility === 'shared');
    assert('…and it is listed under Shared Templates', /Monthly owner update/.test(h.$$('.cr-group').find(g => /Shared Templates/.test(g.textContent)).textContent));
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="1"]'));
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="title"]'), 'My edit');
    // Someone else saves first.
    Object.assign(h.srv.find(1), { version: 2, name: 'Acme weekly (theirs)', updated_by_username: 'sam',
      definition: { v: 1, title: 'Their edit', jobs: { mode: 'pick', ids: [] }, sections: [{ type: 'notes', text: 'theirs' }] } });
    h.click(h.act('save'));
    await tick();
    let m = h.modal();
    assert('a stale save gets the conflict dialog', m && /Someone else saved this report while you had it open/.test(m.textContent) && /sam/.test(m.textContent));
    const btn = label => [...h.modal().querySelectorAll('[data-choice]')].find(b => b.textContent === label);
    assert('…offering to load theirs or save a copy', !!btn('Load their version') && !!btn('Save mine as a copy'));
    btn('Load their version').click();
    await tick();
    let S = h.S();
    assert('"Load their version" replaces the editor with the server copy', S.doc.version === 2 && S.doc.name === 'Acme weekly (theirs)'
      && S.doc.def.title === 'Their edit' && h.$('.cr-dirty').hidden);

    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="title"]'), 'Mine again');
    h.srv.find(1).version = 3;
    h.click(h.act('save'));
    await tick();
    btn('Save mine as a copy').click();
    await tick();
    m = h.modal();
    assert('"Save mine as a copy" asks for the copy\'s name', m && m.querySelector('#cr-m-name').value === 'Acme weekly (theirs) (copy)');
    m.querySelector('[data-m="ok"]').click();
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    S = h.S();
    assert('…and POSTs my version as a new report', post.body.definition.title === 'Mine again' && S.doc.id > 100 && S.doc.name === 'Acme weekly (theirs) (copy)');
    assert('the original is untouched', h.srv.find(1).definition.title === 'Their edit');

    // The server is down: the work stays.
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="title"]'), 'Unsent work');
    h.srv.next.push({ status: 500, body: { error: 'Database error' } });
    h.click(h.act('save'));
    await tick();
    assert('a failed save says so', /Couldn’t save: Database error/.test(h.toast()));
    assert('…and keeps the edit, still unsaved', h.S().doc.def.title === 'Unsent work' && !h.$('.cr-dirty').hidden && !h.act('save').disabled);
    h.srv.next.push({ network: true });
    h.click(h.act('save'));
    await tick();
    assert('a dropped connection says so too', /Could not reach the server/.test(h.toast()));
    h.click(h.act('save'));
    await tick();
    assert('…and the next try goes through', h.$('.cr-dirty').hidden);

    // 401 hands back to the page.
    h.type(h.$('[data-bind="title"]'), 'x');
    h.srv.next.push({ status: 401, body: { error: 'Unauthorized — please log in' } });
    h.click(h.act('save'));
    await tick();
    assert('a 401 calls the page\'s onAuthError', h.authErrors === 1);
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer()) });
    h.srv.next.push({ status: 500, body: { error: 'Database error' } });
    await h.render();
    assert('a failed list load shows the error with Retry', /Couldn’t load saved reports: Database error/.test(h.$('.cr-rail').textContent) && !!h.act('reload'));
    assert('…and starters still work', !!h.$('.cr-card[data-starter="customer_progress"]'));
    h.click(h.act('reload'));
    await tick();
    assert('Retry loads the list', !h.$('.cr-rail .cr-alert') && /Acme weekly update/.test(h.$('.cr-rail').textContent));
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('Item menu — rename, duplicate, delete, Recently Deleted, restore');
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    const more = id => h.$(`[data-act="item-menu"][data-id="${id}"]`);
    h.click(more(2));
    assert('a shared template you can edit has Rename and Delete', !!h.document.querySelector('.cr-menu [data-act="menu-delete"]'));
    h.click(more(2));
    assert('clicking ⋯ again closes the menu', !h.document.querySelector('.cr-menu'));

    h.click(more(3));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-rename"]'));
    await tick();
    h.modal().querySelector('#cr-m-name').value = 'Cost check — Q4';
    h.modal().querySelector('[data-m="ok"]').click();
    await tick();
    const put = h.srv.calls('PUT').pop();
    assert('Rename PUTs just the name and the version', put.body.name === 'Cost check — Q4' && put.body.version === 1 && put.body.definition === undefined);
    assert('…and the list shows it', /Cost check — Q4/.test(h.$('.cr-rail').textContent));

    h.click(more(1));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-duplicate"]'));
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    assert('Duplicate makes a private "(copy)"', post.body.name === 'Acme weekly update (copy)' && post.body.visibility === 'private');
    assert('…and opens it', h.S().doc.name === 'Acme weekly update (copy)');
    h.click(more(1));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-duplicate"]'));
    await tick();
    assert('a second copy finds the next free name', h.srv.calls('POST', e => !e.q.action).pop().body.name === 'Acme weekly update (copy 2)');

    h.answers.push(false);
    h.click(more(1));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-delete"]'));
    await tick();
    assert('Delete asks first, mentioning Recently Deleted', /Recently Deleted for 30 days/.test(h.confirms.pop()) && h.srv.calls('DELETE').length === 0);
    h.click(more(1));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-delete"]'));
    await tick();
    assert('…then DELETEs', h.srv.calls('DELETE').length === 1 && h.srv.calls('DELETE')[0].q.id === '1');
    assert('…and it leaves the list', !h.$('[data-act="open"][data-id="1"]'));

    h.click(h.act('toggle-deleted'));
    await tick();
    assert('opening Recently Deleted fetches ?deleted=1', h.srv.calls('GET', e => e.q.deleted === '1').length === 1);
    assert('…and lists it with a Restore button', !!h.$('[data-act="restore"][data-id="1"]') && h.act('toggle-deleted').getAttribute('aria-expanded') === 'true');
    h.click(h.$('[data-act="restore"][data-id="1"]'));
    await tick();
    assert('Restore POSTs ?action=restore&id=1', h.srv.calls('POST', e => e.q.action === 'restore' && e.q.id === '1').length === 1);
    assert('…and it is back under My Reports', !!h.$('[data-act="open"][data-id="1"]') && !h.$('[data-act="restore"][data-id="1"]'));

    // A restore whose name is now taken.
    const gone = h.srv.add({ name: 'Old draft', definition: { v: 1 } });
    gone.deleted_at = '2026-11-01T00:00:00Z';
    h.srv.add({ name: 'old draft', definition: { v: 1 } });
    h.click(h.act('toggle-deleted'));
    h.click(h.act('toggle-deleted'));
    await tick();
    h.click(h.$(`[data-act="restore"][data-id="${gone.id}"]`));
    await tick();
    assert('restoring over a taken name explains what to do', /exists now\. Rename it, then restore/.test(h.toast()));

    section('Send History');
    h.srv.runs.push({ id: 9, report_name: '<b>Bold</b> report', action: 'email', project_names: ['Route 30 Resurfacing'], date_from: '2026-10-27',
      date_to: '2026-11-02', recipients: ['owner@acme.com'], subject: 'Week 44', included_internal: true, run_by_username: 'pat', created_at: '2026-11-04T15:00:00Z' });
    h.click(h.act('history'));
    await tick();
    assert('Send History fetches ?runs=1', h.srv.calls('GET', e => e.q.runs === '1').length === 1);
    const table = h.$('.cr-table');
    assert('…and shows a table of runs', table && table.querySelectorAll('tbody tr').length === 1);
    const row = table.querySelector('tbody tr').textContent;
    assert('…with who, report, action, jobs, dates, recipients', /pat/.test(row) && /Email/.test(row) && /Route 30 Resurfacing/.test(row)
      && /Oct 27 – Nov 2, 2026/.test(row) && /owner@acme\.com/.test(row));
    assert('…the Internal flag', /Internal/.test(row));
    assert('…and report names as text', /<b>Bold<\/b> report/.test(row) && !table.querySelector('b'));
    h.click(h.act('back'));
    assert('Back returns to the open report', h.S().view === 'edit');
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  // A PUT the test holds until it says go: the user keeps working while it
  // is out.
  const holdPuts = srv => {
    const gate = { held: [], release() { const g = this.held.splice(0); g.forEach(fn => fn()); } };
    const real = srv.handle;
    srv.handle = (url, init) => {
      if (init && init.method === 'PUT') {
        return new Promise(resolve => gate.held.push(() => resolve(real(url, init))));
      }
      return real(url, init);
    };
    return gate;
  };
  const twoReports = () => {
    const srv = makeServer();
    srv.add({ id: 11, name: 'Acme customer update', definition: { v: 1, title: 'Acme Weekly', jobs: { mode: 'saved', ids: ['p1'] },
      sections: [{ type: 'job_info', columns: ['project-name', 'client'] }, { type: 'notes', text: 'Paving starts Monday.' }] } });
    srv.add({ id: 12, name: 'Internal cost check', definition: { v: 1, title: 'Internal Costs', includeInternal: true, jobs: { mode: 'saved', ids: ['p2'] },
      sections: [{ type: 'daily_production', columns: ['date', 'employee', 'rate', 'labor_cost'], options: { summarize: false } }] } });
    srv.seq = 100;
    return srv;
  };

  section('Print fixes the report at the click (no swap while the old rows load)');
  {
    let release;
    const gate = new Promise(r => { release = r; });
    const h = boot({ server: twoReports(), cfg: { ready: () => gate } });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    h.click(h.act('print'));
    assert('Print opens the window and says "Preparing"', h.opened.length === 1 && /Preparing your report/.test(h.opened[0].written));
    h.click(h.$('[data-act="open"][data-id="12"]'));
    assert('…another report is opened while it waits', h.S().doc.id === 12);
    release();
    await tick(8);
    const w = h.opened[0];
    assert('the window opened for the customer report is closed, not filled with the internal one',
      w.closed === true && !/Internal Costs/.test(w.written) && !/INTERNAL — contains cost data/.test(w.written) && !/Eve Gray/.test(w.written),
      w.written.slice(0, 200));
    assert('…the user is told to click Print again', /click Print again/.test(h.toast()), h.toast());
    assert('…and no print is logged', h.srv.calls('POST', e => e.q.action === 'run').length === 0);
    h.close();
  }
  {
    let release;
    const gate = new Promise(r => { release = r; });
    const h = boot({ server: twoReports(), cfg: { ready: () => gate } });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    h.click(h.act('print'));
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="title"]'), 'Edited while waiting');
    release();
    await tick(8);
    const w = h.opened[0];
    assert('control: staying on it prints the report as it was clicked (an edit during the wait is not in it)',
      !w.closed && /Acme Weekly/.test(w.written) && !/Edited while waiting/.test(w.written) && /window\.print\(\)/.test(w.written));
    const runs = h.srv.calls('POST', e => e.q.action === 'run');
    assert('…and logs one print, against that report', runs.length === 1 && runs[0].body.report_id === 11 && runs[0].body.report_name === 'Acme customer update',
      JSON.stringify(runs.map(r => r.body.report_id)));
    h.close();
  }
  {
    let release;
    const gate = new Promise(r => { release = r; });
    const h = boot({ server: twoReports(), cfg: { ready: () => gate } });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    h.click(h.act('print'));
    h.click(h.act('doc-menu'));
    h.click(h.mount.querySelector('.cr-menu [data-act="close"]'));
    assert('…the report is closed while it waits', h.S().doc === null);
    release();
    await tick(8);
    assert('closing the report meanwhile closes the window, with no "Cannot read properties" error',
      h.opened[0].closed === true && !/Cannot read/.test(h.toast()) && /click Print again/.test(h.toast()), h.toast());
    h.close();
  }

  section('Saving while typing — nothing typed during a save is lost');
  {
    const srv = twoReports();
    const gate = holdPuts(srv);
    const h = boot({ server: srv });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="h-intro"]'), 'First line.');
    h.click(h.act('save'));
    await tick();
    assert('the save is out', gate.held.length === 1 && h.S().saving === true);
    h.type(h.$('[data-bind="h-footer"]'), 'Call Pat at the office.');
    h.type(h.$('[data-bind="name"]'), 'Renamed During Save');
    gate.release();
    await tick(8);
    const d = h.S().doc;
    assert('the footer and the new name typed during the save are still there',
      d.def.header.footer === 'Call Pat at the office.' && d.name === 'Renamed During Save'
        && h.$('[data-bind="name"]').value === 'Renamed During Save' && h.$('[data-bind="h-footer"]').value === 'Call Pat at the office.');
    assert('…the report is at version 2 and still says it has unsaved changes', d.version === 2 && !h.$('.cr-dirty').hidden && !h.act('save').disabled);
    const before = h.confirms.length;
    h.answers.push(false);
    h.click(h.act('new'));
    assert('…so leaving asks first', h.confirms.length === before + 1 && h.S().doc === d, h.confirms.slice(-1)[0]);
    h.click(h.act('save'));
    await tick();
    gate.release();
    await tick(8);
    const put = h.srv.calls('PUT').pop();
    assert('the next Save sends them, against version 2', put.body.version === 2 && put.body.name === 'Renamed During Save'
      && put.body.definition.header.footer === 'Call Pat at the office.' && put.body.definition.header.intro === 'First line.', JSON.stringify(put.body).slice(0, 200));
    assert('…and then it is clean', h.$('.cr-dirty').hidden && h.S().doc.version === 3);
    h.close();
  }

  section('A save that lands after switching reports');
  {
    const srv = twoReports();
    const gate = holdPuts(srv);
    const h = boot({ server: srv });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="h-intro"]'), 'Paving starts Monday.');
    h.click(h.act('save'));
    await tick();
    const before = h.confirms.length;
    h.click(h.$('[data-act="open"][data-id="12"]'));
    assert('switching while the save is out does not offer to "discard" what is being saved', h.confirms.length === before && h.S().doc.id === 12,
      h.confirms.slice(-1)[0]);
    gate.release();
    await tick(8);
    const a = h.S().reports.find(r => r.id === 11);
    assert('the saved copy is put in the list: version 2, with the intro', a && a.version === 2 && a.definition.header.intro === 'Paving starts Monday.',
      a && JSON.stringify({ v: a.version }));
    assert('…and the user is told it saved', /Saved “Acme customer update”/.test(h.toast()), h.toast());
    h.click(h.$('[data-act="open"][data-id="11"]'));
    assert('reopening it shows what was saved', h.S().doc.version === 2 && h.S().doc.def.header.intro === 'Paving starts Monday.');
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="h-footer"]'), 'More.');
    h.click(h.act('save'));
    await tick();
    gate.release();
    await tick(8);
    assert('…and saving again is no false "someone else saved" (PUT with version 2)',
      !h.modal() && h.srv.calls('PUT').pop().body.version === 2 && h.S().doc.version === 3);
    h.close();
  }

  section('Leaving the page with an unsaved report');
  {
    const h = boot({ server: twoReports() });
    await h.render();
    const fire = () => { const e = new h.window.Event('beforeunload', { cancelable: true }); h.window.dispatchEvent(e); return e; };
    let e = fire();
    assert('no report open: nothing asks', !e.defaultPrevented);
    h.click(h.$('[data-act="open"][data-id="11"]'));
    e = fire();
    assert('a clean report: nothing asks', !e.defaultPrevented);
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="h-intro"]'), 'Fifteen minutes of work');
    e = fire();
    assert('an unsaved report: the browser is asked to confirm leaving (Switch Division, Sign Out, refresh, close)',
      e.defaultPrevented);
    h.click(h.act('save'));
    await tick(6);
    e = fire();
    assert('…not once it is saved', !e.defaultPrevented);

    // An expired session: the open report is kept, then offered back.
    h.type(h.$('[data-bind="h-footer"]'), 'Kept over the sign-out');
    h.srv.next.push({ status: 401, body: { error: 'Unauthorized' } });
    h.click(h.act('save'));
    await tick(6);
    const kept = h.window.sessionStorage.getItem('fct_cr_draft_paving');
    assert('a 401 keeps the open report before handing over to the sign-out', h.authErrors === 1 && kept && /Kept over the sign-out/.test(kept));
    const h2 = boot({ server: twoReports() });
    h2.window.sessionStorage.setItem('fct_cr_draft_paving', kept);
    await h2.render();
    await tick(6);
    const m = h2.modal();
    assert('next time the tab opens it offers the report back', m && /Restore your unsaved report/.test(m.textContent) && /Acme customer update/.test(m.textContent));
    [...m.querySelectorAll('[data-choice]')].find(b => /Restore/.test(b.textContent)).click();
    await tick();
    const d = h2.S().doc;
    assert('Restore reopens it with the edits, against the saved copy, still unsaved',
      d && d.id === 11 && d.def.header.footer === 'Kept over the sign-out' && !h2.$('.cr-dirty').hidden
        && !h2.window.sessionStorage.getItem('fct_cr_draft_paving'));
    h2.click(h2.act('save'));
    await tick(6);
    assert('…and Save puts it where it was going', h2.srv.calls('PUT').pop().body.definition.header.footer === 'Kept over the sign-out');
    h.close(); h2.close();
  }

  section('Email checks the size limit before the recipients are typed');
  {
    const h = boot({ server: twoReports() });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    const E = h.window.FCTReportEngine;
    const real = E.buildReportHtml;
    E.buildReportHtml = (...a) => real(...a).replace('</body>', '<p>' + 'x'.repeat(1500000) + '</p></body>');
    h.click(h.act('email'));
    await tick();
    assert('a report over the limit does not open the email modal', h.email.length === 0);
    assert('…it says how big, that it is too big to email, and what to do', /MB — too big to email/.test(h.toast()) && /Print \/ PDF/.test(h.toast())
      && /fewer jobs/.test(h.toast()), h.toast());
    const btn = h.document.querySelector('.cr-toast button');
    assert('…with a "Print / PDF instead" button that prints it', btn && /Print \/ PDF instead/.test(btn.textContent) && (btn.click(), h.opened.length === 1));
    E.buildReportHtml = real;
    h.click(h.act('email'));
    await tick();
    assert('a normal-size report opens the modal', h.email.length === 1);
    h.close();
  }

  section('Saving a job report keeps its jobs');
  {
    const h = boot({ server: makeServer() });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$$('.cr-job input')[0].click();
    const cb = h.$('[data-bind="save-jobs"]');
    assert('the "Save these jobs" box sits with the job count, above the list',
      cb && cb.closest('.cr-field') === h.$('.cr-joblist').closest('.cr-field')
        && (cb.compareDocumentPosition(h.$('.cr-joblist')) & h.window.Node.DOCUMENT_POSITION_FOLLOWING));
    h.click(h.act('save'));
    await tick();
    const m = h.modal();
    assert('Save asks whether to keep the one job, ticked', m && m.querySelector('#cr-m-savejobs') && m.querySelector('#cr-m-savejobs').checked);
    m.querySelector('#cr-m-name').value = 'Job 004 weekly update';
    m.querySelector('[data-m="ok"]').click();
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    assert('…and saves them with it', post.body.definition.jobs.mode === 'saved' && JSON.stringify(post.body.definition.jobs.ids) === '["p1"]');
    assert('the step ① box now shows it, and nothing is unsaved', h.$('[data-bind="save-jobs"]').checked && h.$('.cr-dirty').hidden);
    const id = h.S().doc.id;
    h.click(h.act('doc-menu'));
    h.click(h.mount.querySelector('.cr-menu [data-act="close"]'));
    h.click(h.$(`[data-act="open"][data-id="${id}"]`));
    assert('reopened, it has its job', /1 job selected/.test(h.$('.cr-count').textContent) && h.$('.cr-callout').hidden);
    // A user who unticked it in step ① is not overruled.
    h.click(h.$('.cr-card[data-starter="haul_log"]') || h.$('[data-act="starter"][data-starter="haul_log"]'));
    h.$$('.cr-job input')[0].click();
    h.$('[data-bind="save-jobs"]').click();
    h.$('[data-bind="save-jobs"]').click();
    h.click(h.act('save'));
    await tick();
    const m2 = h.modal();
    assert('…a box unticked in step ① comes unticked into the dialog', m2 && !m2.querySelector('#cr-m-savejobs').checked);
    m2.querySelector('#cr-m-name').value = 'Haul template';
    m2.querySelector('[data-m="ok"]').click();
    await tick();
    assert('…and saves a template', h.srv.calls('POST', e => !e.q.action).pop().body.definition.jobs.mode === 'pick');
    h.close();
  }

  section('Double-clicks do not open and shut a dialog');
  {
    const h = boot({ server: makeServer() });
    await h.render();
    h.click(h.act('new'));
    const save = h.act('save');
    const ev = (el, type, detail) => el.dispatchEvent(new h.window.MouseEvent(type, { bubbles: true, cancelable: true, detail }));
    ev(save, 'mousedown', 1); ev(save, 'mouseup', 1); ev(save, 'click', 1);
    await tick();
    const back = h.modal();
    assert('the first click opens the name dialog', !!back);
    ev(back, 'mousedown', 2); ev(back, 'mouseup', 2); ev(back, 'click', 2);
    assert('the second click of the double-click, landing on the backdrop, leaves it open', !!h.modal());
    h.click(h.act('save'));
    await tick();
    assert('…and a further Save does not stack a second dialog', h.document.querySelectorAll('.cr-modal').length === 1);
    await sleep(550);
    ev(back, 'mousedown', 1); ev(back, 'mouseup', 1); ev(back, 'click', 1);
    assert('a deliberate click on the backdrop later still closes it', !h.modal());
    h.close();
  }

  section('Preview: Fit or 100%, and a full-size tab');
  {
    const h = boot({ server: twoReports() });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    await sleep(PREVIEW_WAIT);
    const frame = () => h.$('.cr-frame');
    assert('the preview has a Fit / 100% toggle, Fit pressed', h.$('[data-act="zoom"][data-zoom="fit"]').getAttribute('aria-pressed') === 'true');
    h.click(h.$('[data-act="zoom"][data-zoom="100"]'));
    assert('100%: the sheet at its printed width, not scaled, the pane scrolling',
      frame().style.width === '816px' && !frame().style.transform && h.$('.cr-frame-wrap').classList.contains('cr-scroll')
        && h.$('[data-act="zoom"][data-zoom="100"]').getAttribute('aria-pressed') === 'true', frame().getAttribute('style'));
    assert('…and the choice is remembered', h.window.localStorage.getItem('fct_cr_preview_zoom') === '100');
    h.click(h.$('[data-act="zoom"][data-zoom="fit"]'));
    assert('Fit puts it back', !h.$('.cr-frame-wrap').classList.contains('cr-scroll') && h.window.localStorage.getItem('fct_cr_preview_zoom') === 'fit');
    h.click(h.act('full-preview'));
    assert('"Open full preview" opens the report in a new tab, without printing it',
      h.opened.length === 1 && /Acme Weekly/.test(h.opened[0].written) && !/window\.print\(\)/.test(h.opened[0].written));
    assert('…and logs nothing (nothing was sent)', h.srv.calls('POST', e => e.q.action === 'run').length === 0);
    h.close();
  }

  section('Email and Excel while the old rows load: one click, one file');
  {
    let release;
    const gate = new Promise(r => { release = r; });
    const h = boot({ server: twoReports(), cfg: { ready: () => gate } });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    h.click(h.act('excel'));
    await tick();
    h.click(h.act('excel'));
    h.click(h.act('excel'));
    await tick();
    assert('Excel says "Preparing…" and takes no more clicks', h.act('excel').disabled && /Preparing/.test(h.act('excel').textContent)
      && h.downloads.length === 0);
    assert('…and a toast says why', /Waiting for older daily entries/.test(h.toast()), h.toast());
    h.click(h.act('email'));
    await tick();
    h.click(h.act('email'));
    assert('Email does the same', h.act('email').disabled && /Preparing/.test(h.act('email').textContent));
    release();
    await tick(10);
    assert('once the rows are in: exactly one download, one email modal', h.downloads.length === 1 && h.email.length === 1,
      `${h.downloads.length} downloads, ${h.email.length} modals`);
    assert('…one Excel run logged', h.srv.calls('POST', e => e.q.action === 'run' && e.body.action === 'excel').length === 1);
    assert('…and the buttons are back', !h.act('excel').disabled && /Excel/.test(h.act('excel').textContent)
      && !h.act('email').disabled && /Email/.test(h.act('email').textContent));
    h.close();
  }

  section('A slow preview waits for typing to pause');
  {
    const h = boot({ server: twoReports() });
    const E = h.window.FCTReportEngine;
    const real = E.buildReportHtml;
    let builds = 0;
    E.buildReportHtml = (...a) => { builds++; const t = Date.now(); while (Date.now() - t < 300) { /* a big report */ } return real(...a); };
    await h.render();
    h.click(h.$('[data-act="open"][data-id="11"]'));
    await sleep(50);
    h.click(h.$('#cr-step-3'));
    const intro = h.$('[data-bind="h-intro"]');
    builds = 0;
    let text = '';
    for (const ch of 'hello') { text += ch; h.type(intro, text); await sleep(300); }
    assert('five keystrokes 300 ms apart rebuild it at most twice, not five times', builds <= 2, `${builds} builds`);
    intro.blur();
    await sleep(1700);
    assert('…and the preview catches up once typing stops', /hello/.test(h.srcdoc()));
    E.buildReportHtml = real;
    h.close();
  }

  section('Opening the tab before the jobs have loaded');
  {
    let release;
    const gate = new Promise(r => { release = r; });
    const live = [];
    const all = fixture().projects;
    const h = boot({ server: makeServer(), cfg: { ready: () => gate, getProjects: () => live } });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    assert('with no jobs yet it says they are loading, not that the division has none',
      /Loading jobs/.test(h.$('.cr-joblist').textContent) && !/No jobs in this division/.test(h.$('.cr-joblist').textContent));
    live.push(...all);
    await sleep(700);
    assert('when they arrive the list and the Client picker redraw, without the user changing step',
      h.$$('.cr-job').length === 3 && !!h.$('[data-bind="jobs-client"]') && h.S().step === 1, h.$('.cr-joblist').textContent.slice(0, 80));
    release();
    await tick(6);
    h.close();
    let release2;
    const gate2 = new Promise(r => { release2 = r; });
    const h2 = boot({ server: makeServer(), cfg: { ready: () => gate2, getProjects: () => [] } });
    await h2.render();
    h2.click(h2.$('.cr-card[data-starter="customer_progress"]'));
    release2();
    await tick(8);
    assert('a division that really has none says so once loading is done', /No jobs in this division yet/.test(h2.$('.cr-joblist').textContent));
    h2.close();
  }

  section('Client…, All In Progress and Clear can be undone');
  {
    const h = boot({ server: makeServer() });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    const pickTwo = () => { h.click(h.act('jobs-clear')); h.$$('.cr-job input')[0].click(); h.$$('.cr-job input')[1].click(); };
    const undo = () => { const b = h.document.querySelector('.cr-toast button'); if (b) b.click(); return !!b; };
    pickTwo();
    h.change(h.$('[data-bind="jobs-client"]'), 'Acme Township');
    assert('Client… replaces the selection and says so, with Undo', /Selected 2 jobs for Acme Township/.test(h.toast())
      && !!h.document.querySelector('.cr-toast button'));
    assert('Undo puts back the two jobs picked by hand', undo() && JSON.stringify(h.S().doc.picked) === '["p1","p2"]'
      && /2 jobs selected/.test(h.$('.cr-count').textContent));
    h.click(h.act('jobs-clear'));
    assert('Clear says how many it cleared, with Undo', /Cleared 2 jobs/.test(h.toast()) && h.S().doc.picked.length === 0);
    assert('…and Undo brings them back', undo() && h.S().doc.picked.length === 2);
    h.click(h.act('jobs-active'));
    assert('All In Progress says what it did, with Undo', /Selected 2 In Progress jobs/.test(h.toast()));
    h.change(h.$('[data-bind="jobs-client"]'), 'Beta Corp');
    assert('…and the latest Undo restores what the latest pick replaced', undo() && JSON.stringify(h.S().doc.picked.slice().sort()) === '["p1","p2"]');
    h.close();
  }

  section('Excel of an internal report asks first');
  {
    const h = boot({ server: twoReports() });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="12"]'));
    h.answers.push(false);
    h.click(h.act('excel'));
    await tick();
    assert('downloading an internal workbook asks, naming what is in it', /workbook includes internal data/.test(h.confirms.slice(-1)[0] || ''));
    assert('…and "no" downloads and logs nothing', h.downloads.length === 0 && h.blobs.length === 0
      && h.srv.calls('POST', e => e.q.action === 'run').length === 0);
    h.click(h.act('excel'));
    await tick();
    assert('"yes" downloads it, named INTERNAL', h.downloads.length === 1 && /-INTERNAL-\d{4}-\d{2}-\d{2}\.xlsx$/.test(h.downloads[0].name), h.downloads[0] && h.downloads[0].name);
    h.click(h.$('[data-act="open"][data-id="11"]'));
    const n = h.confirms.length;
    h.click(h.act('excel'));
    await tick();
    assert('a customer-safe workbook downloads without asking', h.confirms.length === n && h.downloads.length === 2);
    h.close();
  }

  section('Send History keeps the costs flag in view');
  {
    const h = boot({ server: twoReports() });
    await h.render();
    const css = h.document.getElementById('cr-styles').textContent;
    assert('the history table wraps (it overrides the page\'s table{white-space:nowrap})',
      /\.cr-table\{[^}]*white-space:normal[^}]*min-width:0/.test(css) && /data-label="Recipients"\][^{]*\{[^}]*overflow-wrap:anywhere/.test(css));
    h.srv.runs.push({ id: 1, report_name: 'R', action: 'print', project_names: [], recipients: [], included_internal: false, created_at: '2026-11-04T15:00:00Z' });
    h.click(h.act('history'));
    await tick();
    const heads = h.$$('.cr-table th').map(t => t.textContent);
    assert('…and Data (Internal / Customer-safe) sits next to Action, ahead of the long columns',
      heads.indexOf('Data') === heads.indexOf('Action') + 1 && heads.indexOf('Data') < heads.indexOf('Recipients'), heads.join(','));
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('Re-entrant renderTab');
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="3"]'));
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="title"]'), 'Edited');
    await h.render();
    await h.render();
    assert('opening the tab again keeps the open report and its edits', h.S().doc.id === 3 && h.S().doc.def.title === 'Edited' && !h.$('.cr-dirty').hidden);
    assert('…and refreshes the list each time', h.srv.calls('GET', e => !e.q.runs && !e.q.deleted).length === 3);
    const before = h.srv.calls('PUT').length;
    h.click(h.act('save'));
    await tick();
    assert('…without stacking listeners (one click, one save)', h.srv.calls('PUT').length === before + 1);
    assert('a report with internal data reopens with the red banner', !!h.$('.cr-banner-int'));
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('Source rules');
  {
    const code = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert('no inline on…= handlers in the markup it builds', !/\son[a-z]+\s*=\s*["'`]/i.test(code.replace(/window\.onload=\(\)=>/g, '')));
    assert('styles live in one <style id="cr-styles"> scoped under .cr-root', /el\.id = 'cr-styles'/.test(UI) && /\.cr-root\{/.test(UI));
    assert('it uses the engine for rendering, not its own copy', !/function buildReportHtml|function buildXlsx|const CATALOG\s*=/.test(UI)
      && /E\.buildReportHtml/.test(UI) && /E\.buildXlsx/.test(UI));
    assert('phones: panes stack under 900 px', /@media \(max-width:899px\)/.test(UI));
    assert('the module exposes { configure, renderTab, _internals: { state, api } }', (() => {
      const h = boot();
      const M = h.window.FCTCustomReports;
      const ok = typeof M.configure === 'function' && typeof M.renderTab === 'function' && typeof M._internals.state === 'function'
        && typeof M._internals.api.request === 'function';
      h.close();
      return ok;
    })());
  }

  // ════════════════════════════════════════════════════════════════════
  section('In a real browser — phone and desktop widths (optional)');
  await browserCheck();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error(err && err.stack || err);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});

// Headless Chromium at 390 px and 1440 px: nothing scrolls sideways, the
// rail folds behind its toggle on a phone, and the preview sits beside the
// editor on a wide screen. Skipped (with a note) where Playwright or a
// browser is not available.
async function browserCheck() {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (_) { console.log('  - skipped: playwright is not installed'); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log('  - skipped: no browser (' + String(e.message).split('\n')[0] + ')'); return; }
  const data = fixture();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0a0a0f;--surface:#111118;--surface2:#1a1a26;--border:#2a2a3a;--green:#3b82f6;--green-dim:#2563eb;--red:#ef4444;--yellow:#eab308;--text:#e0e0e0;--muted:#666}
    body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:13px}
    .btn{padding:.4rem 1rem;font-size:.78rem;font-weight:600;border:none;border-radius:3px;cursor:pointer;display:inline-flex;align-items:center}
    .btn-green{background:var(--green-dim);color:#fff}.btn-ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
    .tab-panel{display:none}.tab-panel.active{display:block}
    table{border-collapse:collapse;min-width:100%;white-space:nowrap}</style></head><body>
    <div class="tab-panel active"><div id="cr-content" style="padding:1rem"></div></div>
    <script>${BRANDING}</script><script>${ENGINE}</script><script>${UI}</script>
    <script>
      const data = ${JSON.stringify(data)};
      const RUNS = [{ id: 1, report_name: 'Owner update', action: 'email', subject: 'Weekly progress for the owner',
        project_names: ['Route 30 Resurfacing', 'Elm Street Lot', 'Maple Avenue Reconstruction Phase Two', 'Borough Garage Lot'],
        date_from: '2026-10-27', date_to: '2026-11-02', included_internal: true, run_by_username: 'pat', created_at: '2026-11-04T15:00:00Z',
        recipients: ['project.manager.longname@acme-township.example.com', 'township.engineer@acme-township.example.com',
          'construction.inspector@acme-township.example.com', 'accounts.payable@acme-township.example.com', 'owner.representative@acme-township.example.com'] }];
      window.fetch = async (url) => ({ ok: true, status: 200, json: async () => (/runs=1/.test(String(url)) ? { runs: RUNS }
        : { reports: [], canShare: true, me: { userId: 7, username: 'pat' } }) });
      FCTCustomReports.configure({ division: 'paving', divisionLabel: 'Paving', getToken: () => 't', user: { username: 'pat' },
        perm: { role: 'admin', canSeeCosts: true, canSeeFinancials: true }, areaUnit: 'SY', ready: () => Promise.resolve(),
        getProjects: () => data.projects, getPurchaseOrders: () => data.pos, getTruckingEntries: () => data.trucks, helpers: {} });
      FCTCustomReports.renderTab(document.getElementById('cr-content'));
    </script></body></html>`;
  try {
    for (const [w, h] of [[390, 844], [1440, 900]]) {
      const p = await browser.newPage({ viewport: { width: w, height: h } });
      const errors = [];
      p.on('pageerror', e => errors.push(e.message));
      await p.setContent(page);
      await p.waitForSelector('.cr-card');
      const wide = () => p.evaluate(() => document.documentElement.scrollWidth);
      assert(`${w}px: the welcome panel does not scroll sideways`, await wide() <= w, await wide());
      if (w === 390) assert('390px: the rail is folded behind "Reports"', await p.isHidden('.cr-rail') && await p.isVisible('.cr-railbtn'));
      if (w === 1440) assert('1440px: the rail is shown and its toggle is not', await p.isVisible('.cr-rail') && await p.isHidden('.cr-railbtn'));
      await p.click('.cr-card[data-starter="customer_progress"]');
      await p.click('label.cr-job >> nth=0');
      await p.click('#cr-step-2');
      await p.click('[data-act="sec-toggle"] >> nth=2');
      assert(`${w}px: the builder, with a section open, does not scroll sideways`, await wide() <= w, await wide());
      const box = s => p.locator(s).boundingBox();
      const ed = await box('.cr-editor'), pv = await box('.cr-preview');
      if (w === 390) assert('390px: the preview stacks under the editor', pv.y >= ed.y + ed.height - 1);
      if (w === 1440) assert('1440px: the preview sits beside the editor', pv.x >= ed.x + ed.width - 1 && Math.abs(pv.y - ed.y) < 2);
      if (w === 390) {
        await p.click('.cr-railbtn');
        assert('390px: "Reports" opens the rail above the editor', await p.isVisible('.cr-rail'));
        assert('390px: …still without sideways scroll', await wide() <= w, await wide());
      }
      if (w === 1440) {
        // The history: one email to five long addresses about four jobs fits
        // the pane, and the Internal flag is on screen.
        await p.click('[data-act="history"]');
        await p.waitForSelector('.cr-table tbody tr');
        const t = await p.evaluate(() => {
          const wrap = document.querySelector('.cr-tablewrap'), table = wrap.querySelector('table');
          const td = table.querySelector('td[data-label="Recipients"]');
          const data = table.querySelector('td[data-label="Data"]').getBoundingClientRect();
          return { tableW: table.scrollWidth, wrapW: wrap.clientWidth, ws: getComputedStyle(td).whiteSpace,
            dataRight: data.right, wrapRight: wrap.getBoundingClientRect().right };
        });
        assert('1440px: Send History fits its pane, recipients wrapping, the Internal flag in view',
          t.tableW <= t.wrapW + 1 && t.ws === 'normal' && t.dataRight <= t.wrapRight + 1, JSON.stringify(t));
      }
      assert(`${w}px: no script errors`, errors.length === 0, errors.join('; '));
      await p.close();
    }
    // A 1280 px laptop: Fit would shrink the sheet past reading, so the
    // preview shows it at its printed size and scrolls, every column on it.
    {
      const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await p.setContent(page);
      await p.waitForSelector('.cr-card');
      await p.click('.cr-card[data-starter="customer_progress"]');
      await p.click('label.cr-job >> nth=0');
      await p.waitForTimeout(400);
      const f = await p.evaluate(() => {
        const wrap = document.querySelector('.cr-frame-wrap'), frame = wrap.querySelector('.cr-frame');
        return { scroll: wrap.classList.contains('cr-scroll'), width: frame.getBoundingClientRect().width, tf: frame.style.transform,
          sw: wrap.scrollWidth, cw: wrap.clientWidth };
      });
      assert('1280px: the preview is the sheet at 100%, scrolling sideways in its pane, not reflowed and clipped',
        f.scroll && Math.round(f.width) === 816 && !f.tf && f.sw > f.cw, JSON.stringify(f));
      await p.close();
      // 1440: Fit scales it; 100% shows it at its printed size.
      const q = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await q.setContent(page);
      await q.waitForSelector('.cr-card');
      await q.click('.cr-card[data-starter="customer_progress"]');
      await q.click('label.cr-job >> nth=0');
      await q.waitForTimeout(400);
      const fit = await q.evaluate(() => document.querySelector('.cr-frame').style.transform);
      await q.click('[data-act="zoom"][data-zoom="100"]');
      const full = await q.evaluate(() => {
        const wrap = document.querySelector('.cr-frame-wrap'), frame = wrap.querySelector('.cr-frame');
        return { tf: frame.style.transform, w: frame.getBoundingClientRect().width, sw: wrap.scrollWidth, cw: wrap.clientWidth };
      });
      assert('1440px: Fit scales the sheet; 100% shows it full width and scrolls', /scale\(/.test(fit) && !full.tf && Math.round(full.w) === 816
        && full.sw > full.cw, `${fit} ${JSON.stringify(full)}`);
      await q.close();
    }
  } finally {
    await browser.close();
  }
}
