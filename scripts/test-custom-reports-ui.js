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
const { JSDOM, VirtualConsole } = require('jsdom');

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
// CR_UI_FILE points the suite at another copy of the builder — used to prove
// the checks catch a deliberately broken one without touching the repo file.
const UI       = fs.readFileSync(process.env.CR_UI_FILE || path.join(ROOT, 'custom-reports.js'), 'utf8');

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

// ── The API, in memory ───────────────────────────────────────────────────
// /api/custom-reports keeps the rules the UI depends on: visibility,
// can_edit, per-scope unique names (case and whitespace blind), optimistic
// versions, soft delete and restore, kind / customer_safe derived from the
// definition, the run log (with v2's job / action / kind filters, paging,
// one run, its archived copy and who may open it), v ∈ {1,2} and the 409
// client_outdated for a v1 save over a v2 report. Beside it: report
// contacts, company branding, the Team Directory, recipient groups and the
// custom-report schedules, each with the validation the UI shows.
function makeServer(opts) {
  opts = opts || {};
  const srv = {
    reports: [], runs: [], archives: {}, log: [], next: [],
    me: { userId: 7, username: 'pat' }, canShare: opts.canShare !== false, seq: 100,
    contacts: [], contactSeq: 500, contactsCanEdit: opts.contactsCanEdit !== false,
    branding: opts.branding === undefined ? null : opts.branding, brandingFail: false,
    people: opts.people || [], peopleFail: false,
    groups: opts.groups || [], schedules: [], schedSeq: 900, schedRuns: [],
    runPage: opts.runPage || 100, division: opts.division || 'paving',
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
  // Calls to /api/custom-reports (what most of the suite counts) …
  srv.calls = (method, pred) => srv.log.filter(e => e.path === '/api/custom-reports' && e.method === method && (!pred || pred(e)));
  // … and to any other endpoint.
  srv.callsTo = (path, method, pred) => srv.log.filter(e => e.path === path && (!method || e.method === method) && (!pred || pred(e)));
  srv.addRun = row => {
    const run = Object.assign({ id: srv.runs.length + 1, created_at: stamp(), run_by_username: 'pat', run_by_user_id: 7, action: 'email',
      run_kind: 'user', schedule_id: null, resent_from_run_id: null, recipients: [], project_ids: [], project_names: [],
      included_internal: false, definition: {} }, row);
    srv.runs.push(run);
    return run;
  };
  const runRow = r => {
    const o = Object.assign({}, r, { has_archive: !!srv.archives[r.id] });
    delete o.definition;
    return o;
  };

  srv.handle = async (url, init) => {
    init = init || {};
    const u = new URL(url, 'http://localhost');
    const q = Object.fromEntries(u.searchParams);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const entry = { method, path: u.pathname, q, auth: init.headers && init.headers.Authorization, body };
    srv.log.push(entry);
    const res = (status, b) => ({ ok: status >= 200 && status < 300, status, json: async () => b });
    // A queued answer is for the next /api/custom-reports call unless it says
    // which call it is for.
    if (srv.next.length && (srv.next[0].match ? srv.next[0].match(entry) : entry.path === '/api/custom-reports')) {
      const o = srv.next.shift();
      if (o.network) throw new TypeError('Failed to fetch');
      return res(o.status, o.body);
    }

    // ── company-wide endpoints (no division) ──
    if (u.pathname === '/api/company/branding') {
      if (srv.brandingFail) return res(500, { error: 'Database error' });
      return res(200, { ok: true, branding: srv.branding, canEdit: false });
    }
    if (u.pathname === '/api/employees') {
      if (srv.peopleFail) return res(500, { error: 'Database error' });
      return res(200, { employees: srv.people });
    }
    if (u.pathname === '/api/email/recipient-groups') {
      if (srv.groupsGate) await srv.groupsGate();
      if (srv.groupsFail) return res(500, { error: 'Database error' });
      // As the real endpoint: a report type keeps the general groups and its own.
      const rt = q.report_type;
      return res(200, { ok: true, groups: srv.groups.filter(g => !rt || !g.report_type || g.report_type === rt), isAdmin: true });
    }
    if (q.division !== srv.division) return res(400, { error: 'This is not available for this division' });

    // ── /api/report-contacts ──
    if (u.pathname === '/api/report-contacts') {
      const live = srv.contacts.filter(c => !c.deleted_at);
      if (method === 'GET' && srv.contactsFail) return res(500, { error: 'Database error' });
      if (method === 'GET') {
        let list = live;
        if (q.project_ids || q.client_keys) {
          const ids = q.project_ids ? q.project_ids.split(',') : [];
          const keys = q.client_keys ? q.client_keys.split(',') : [];
          list = live.filter(c => (c.project_id != null && ids.includes(String(c.project_id))) || (c.client_key && keys.includes(c.client_key)));
        }
        return res(200, { ok: true, contacts: list, canEdit: srv.contactsCanEdit });
      }
      if (!srv.contactsCanEdit) return res(403, { error: 'Only level 2 users and up can change contacts.' });
      if (method === 'POST') {
        const email = String(body.email || '').toLowerCase();
        if (!/@/.test(email)) return res(400, { error: 'Enter a valid email address.' });
        const ck = body.project_id ? null : String(body.client_name || '').trim().toLowerCase();
        if (live.some(c => String(c.project_id || '') === String(body.project_id || '') && String(c.client_key || '') === String(ck || '') && c.email === email)) {
          return res(409, { error: 'duplicate' });
        }
        const c = { id: ++srv.contactSeq, project_id: body.project_id || null, client_key: ck, client_name: body.client_name || null,
          name: body.name || null, title: body.title || null, organization: body.organization || null, email, phone: body.phone || null,
          role: body.role || 'other', auto_add: body.auto_add !== false, updated_at: stamp(), updated_by_username: 'pat' };
        srv.contacts.push(c);
        return res(201, { contact: c });
      }
      const c = srv.contacts.find(x => x.id === Number(q.id) && !x.deleted_at);
      if (!c) return res(404, { error: 'Contact not found' });
      if (method === 'PUT') { Object.assign(c, body, { updated_at: stamp() }); return res(200, { contact: c }); }
      if (method === 'DELETE') { c.deleted_at = stamp(); return res(200, { ok: true }); }
      return res(405, { error: 'Method not allowed' });
    }

    // ── /api/custom-report-schedules ──
    if (u.pathname === '/api/custom-report-schedules') {
      if (method === 'GET' && q.runs) return res(200, { runs: srv.schedRuns.filter(r => String(r.schedule_id) === q.runs) });
      if (method === 'GET') {
        // As the real endpoint: the general groups, this division's custom
        // report type's, and any a schedule here sends to.
        const used = new Set(srv.schedules.flatMap(x => (x.group_ids || []).map(Number)));
        // As the real endpoint: whether the report is customer-safe is the report's, now.
        const live = x => { const r = srv.find(x.custom_report_id); if (r && !r.deleted_at) { x.report_customer_safe = r.customer_safe !== false; x.report_name = r.name; } return x; };
        // The body is built now — report_customer_safe read from each report
        // as the server sees it at this moment (live() stamps it onto the
        // schedule) — then, if a gate is set, the answer is held so a later
        // save can land before it returns (models an in-flight GET that
        // answers after a newer request was wanted).
        // Copies, as a JSON answer is: the page's rows are never the server's.
        const body = { schedules: srv.canShare ? srv.schedules.map(live).map(x => JSON.parse(JSON.stringify(x))) : [], canSchedule: srv.canShare,
          groups: srv.groups.filter(g => !g.report_type || g.report_type === `${srv.division}_custom_report` || used.has(Number(g.id)))
            .map(g => ({ id: g.id, name: g.name, count: (g.emails || []).length })) };
        if (srv.schedsLateGate) await srv.schedsLateGate();
        return res(200, body);
      }
      if (!srv.canShare) return res(403, { error: 'Only an admin or level 3 user can schedule reports.' });
      if (method === 'POST' && q.action === 'run') {
        const s = srv.schedules.find(x => x.id === Number(q.id));
        if (!s) return res(404, { error: 'Schedule not found' });
        if (srv.sendNowGate) await srv.sendNowGate;
        s.last_status = 'sent'; s.last_run_at = stamp(); s.last_message = 'Sent 2 emails';
        return res(200, { ok: true, result: { status: 'sent', sent: 2, total: 2, recipientCount: 3, message: 'Sent 2 emails' } });
      }
      const validate = b => {
        const r = srv.find(b.custom_report_id);
        if (!r || !visible(r)) return 'The saved report was not found.';
        if (!r.customer_safe || (r.definition && r.definition.includeInternal === true)) return 'Only customer-safe reports can be scheduled.';
        if (r.definition && r.definition.dates && r.definition.dates.preset === 'custom') return { error: 'fixed_dates', message: 'Scheduled reports need a relative date range like Last week' };
        if (!(b.group_ids || []).length && !(b.emails || []).length && !b.use_job_contacts) return 'Add at least one recipient.';
        if (r.kind === 'report' && b.jobs_mode !== 'saved') return 'A report with saved jobs sends its saved jobs.';
        if (r.kind === 'template' && !['each', 'all_in_progress'].includes(b.jobs_mode)) return 'Pick which jobs to send.';
        if (srv.rejectNext) { const m = srv.rejectNext; srv.rejectNext = null; return m; }
        return null;
      };
      if (method === 'POST') {
        const bad = validate(body || {});
        if (bad) return res(400, typeof bad === 'string' ? { error: bad } : bad);
        const r = srv.find(body.custom_report_id);
        const s = Object.assign({ id: ++srv.schedSeq, report_name: r.name, next_run_at: '2026-11-09T12:00:00Z', last_run_at: null,
          last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: stamp(),
          project_id: body.jobs_mode === 'each' ? '*' : null }, body);
        srv.schedules.push(s);
        return res(201, { schedule: JSON.parse(JSON.stringify(s)) });
      }
      const s = srv.schedules.find(x => x.id === Number(q.id));
      if (!s) return res(404, { error: 'Schedule not found' });
      if (method === 'PUT') {
        const bad = validate(Object.assign({}, s, body));
        if (bad) return res(400, typeof bad === 'string' ? { error: bad } : bad);
        Object.assign(s, body, { updated_at: stamp() });
        return res(200, { schedule: JSON.parse(JSON.stringify(s)) });
      }
      if (method === 'DELETE') { srv.schedules = srv.schedules.filter(x => x !== s); return res(200, { ok: true }); }
      return res(405, { error: 'Method not allowed' });
    }

    // ── /api/custom-reports ──
    if (method === 'GET' && q.run) {
      const r = srv.runs.find(x => x.id === Number(q.run));
      if (!r) return res(404, { error: 'Run not found' });
      if (q.archive) {
        const html = srv.archives[r.id];
        if (!html) return res(404, { error: 'No archived copy' });
        const sender = r.run_by_user_id === srv.me.userId;
        if (r.included_internal && !sender && !srv.canShare) return res(403, { error: 'internal_archive' });
        return res(200, { html });
      }
      return res(200, { run: Object.assign({}, r, { has_archive: !!srv.archives[r.id] }) });
    }
    if (method === 'GET' && q.runs) {
      let list = srv.runs.slice().reverse();
      if (q.report_id) list = list.filter(r => String(r.report_id) === q.report_id);
      if (q.project_id) list = list.filter(r => (r.project_ids || []).map(String).includes(q.project_id));
      if (q.action) list = list.filter(r => r.action === q.action);
      if (q.kind) list = list.filter(r => r.run_kind === q.kind);
      if (q.before_id) list = list.filter(r => r.id < Number(q.before_id));
      const page = list.slice(0, srv.runPage);
      return res(200, { runs: page.map(runRow), next_before_id: list.length > page.length ? page[page.length - 1].id : null });
    }
    if (method === 'GET' && q.deleted) {
      return res(200, { reports: srv.reports.filter(r => r.deleted_at && mayEdit(r)).map(shape), canShare: srv.canShare, me: srv.me });
    }
    if (method === 'GET') {
      return res(200, { reports: srv.reports.filter(visible).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(shape),
        canShare: srv.canShare, me: srv.me });
    }
    if (method === 'POST' && q.action === 'run') {
      if (!body.definition || ![1, 2].includes(body.definition.v)) return res(400, { error: 'Unsupported report definition version' });
      const run = srv.addRun(Object.assign({ created_at: stamp(), run_by_username: 'pat' }, body));
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
      if (!body.definition || ![1, 2].includes(body.definition.v)) return res(400, { error: 'Unsupported report definition version (expected v: 1 or 2)' });
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
      if (body.definition !== undefined) {
        if (![1, 2].includes(body.definition.v)) return res(400, { error: 'Unsupported report definition version' });
        if (body.definition.v === 1 && r.definition && r.definition.v === 2) return res(409, { error: 'client_outdated' });
      }
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
  // jsdom's own errors are collected; "not implemented: navigation" (the
  // Reload button's location.reload) is expected and dropped.
  const jsdomErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', err => {
    if (/Not implemented: navigation/.test(String(err && err.message))) return;
    jsdomErrors.push(err);
    console.error('  [jsdom] ' + (err && (err.stack || err.message)));
  });
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div class="tab-panel active" id="tab-customrpt"><div id="cr-content"></div></div>
    <div class="tab-panel" id="tab-other"></div></body></html>`,
  { url: 'http://localhost/paving.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole });
  const window = dom.window, document = window.document;
  const srv = o.server || makeServer();
  const data = o.data || fixture();
  const h = { dom, window, document, srv, data, opened: [], dwCalls: [], email: [], confirms: [], answers: [], alerts: [],
    blobs: [], downloads: [], authErrors: 0, consoleErrors: [], jsdomErrors };
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
    const crCalls = h.srv.log.filter(e => e.path === '/api/custom-reports');
    assert('every /api/custom-reports call sends ?division=paving', crCalls.length && crCalls.every(e => e.q.division === 'paving'));
    assert('the company branding is fetched once, company-wide (no ?division=)',
      h.srv.callsTo('/api/company/branding', 'GET').length === 1 && !h.srv.callsTo('/api/company/branding')[0].q.division);
    assert('the Team Directory is fetched once, as people', h.srv.callsTo('/api/employees', 'GET', e => e.q.view === 'people').length === 1
      && !h.srv.callsTo('/api/employees')[0].q.division);
    assert('the division saved contacts are fetched (for the job badges), with ?division=paving',
      h.srv.callsTo('/api/report-contacts', 'GET').length === 1 && h.srv.callsTo('/api/report-contacts')[0].q.division === 'paving');
    assert('nothing else is called', h.srv.log.every(e => ['/api/custom-reports', '/api/company/branding', '/api/employees',
      '/api/report-contacts', '/api/custom-report-schedules'].includes(e.path)), h.srv.log.map(e => e.path).join());

    const E = h.window.FCTReportEngine;
    const railText = h.$('.cr-rail').textContent;
    const pavStarters = typeof E.startersFor === 'function' ? E.startersFor('paving')
      : E.STARTERS.filter(s => !Array.isArray(s.divisions) || s.divisions.includes('paving'));
    assert('every paving starter template is listed in the rail', pavStarters.length >= 7 && pavStarters.every(s => railText.includes(s.name)),
      pavStarters.map(s => s.name).join());
    assert('the welcome panel offers every starter as a card, plus a blank report',
      h.$$('.cr-card[data-act="starter"]').length === pavStarters.length && !!h.$('.cr-card[data-act="new"]'));
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
    assert('it POSTs the name and a v2 definition (the engine VERSION)', post && post.body.name === 'Route 30 weekly'
      && post.body.definition.v === h.window.FCTReportEngine.VERSION && h.window.FCTReportEngine.VERSION === 2);
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
      && run.body.date_from === '2026-10-01' && run.body.date_to === '2026-10-31' && run.body.definition.v === 2);
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
        && em.customReport.date_from === '2026-10-01' && em.customReport.definition.v === 2 && em.customReport.included_internal === false
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
  // v2 — the report-wide sub code / cost code filter (step ①)
  section('v2 · Filter by sub code / cost code (step ①)');
  {
    const h = boot({ server: seed(makeServer()) });
    const E = h.window.FCTReportEngine;
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    assert('with no jobs picked the filter says to pick jobs first', /Pick jobs above to filter/.test(h.$('.cr-filters').textContent),
      h.$('.cr-filters').textContent.slice(0, 120));
    h.$$('.cr-job input')[0].click();   // Route 30 (p1)
    const p1 = h.data.projects[0];
    const subs = h.$$('[data-bind="filter-sc"]').map(b => b.value);
    assert('it lists the picked job\'s sub codes — E.subCodesFor', typeof E.subCodesFor === 'function'
      && JSON.stringify(subs) === JSON.stringify(E.subCodesFor([p1]).map(x => x.code)) && subs.includes('Base Course'), subs.join());
    assert('…each as "code — description (unit)"', /Base Course — Aggregate base \(TON\)/.test(h.$('.cr-flist').textContent), h.$('.cr-flist').textContent);
    assert('…and the cost codes — E.costCodesFor', h.$$('[data-bind="filter-cc"]').map(b => b.value).join() === E.costCodesFor([p1]).join());
    const search = h.$('[data-bind="filter-search"]');
    h.type(search, 'surf');
    assert('searching narrows the list to matching codes', h.$$('[data-bind="filter-sc"]').map(b => b.value).join() === 'Surface Course'
      && h.$$('[data-bind="filter-cc"]').length === 0);
    assert('…and the search box keeps focus', h.document.activeElement === h.$('[data-bind="filter-search"]'));
    h.type(h.$('[data-bind="filter-search"]'), 'zzz');
    assert('no match says so', /No code matches/.test(h.$('.cr-flist').textContent));
    h.type(h.$('[data-bind="filter-search"]'), '');
    h.$('[data-bind="filter-sc"][value="Base Course"]').click();
    assert('ticking a sub code writes def.filters.subCodes', JSON.stringify(h.S().doc.def.filters.subCodes) === '["Base Course"]');
    assert('…a chip shows it, with its description', /Base Course — Aggregate base/.test(h.$('.cr-chips').textContent));
    assert('…and "Clear" appears', !!h.act('filters-clear'));
    await sleep(PREVIEW_WAIT);
    let doc = h.srcdoc();
    assert('the preview keeps only that sub code in the data sections', /Base Course/.test(doc) && !/Surface Course/.test(doc) && !/Mill 2in/.test(doc));
    h.$('[data-bind="filter-cc"][value="Paving"]').click();
    assert('ticking a cost code writes def.filters.costCodes', JSON.stringify(h.S().doc.def.filters.costCodes) === '["Paving"]');
    h.click(h.$('[data-act="filter-remove"][data-kind="cc"][data-value="Paving"]'));
    assert('a chip\'s ✕ takes that code off', h.S().doc.def.filters.costCodes.length === 0 && h.S().doc.def.filters.subCodes.length === 1);
    h.click(h.act('filters-clear'));
    assert('Clear empties the filter', h.S().doc.def.filters.subCodes.length === 0 && !h.act('filters-clear'));
    const undo = h.document.querySelector('.cr-toast button');
    assert('…with an Undo that puts it back', undo && (undo.click(), JSON.stringify(h.S().doc.def.filters.subCodes) === '["Base Course"]'));
    await sleep(PREVIEW_WAIT);
    assert('…and the preview follows', !/Surface Course/.test(h.srcdoc()));
    // A chosen code that the picked jobs no longer carry stays listed, so it can be undone.
    h.$$('.cr-job input')[0].click();   // untick p1
    h.$$('.cr-job input')[1].click();   // tick Elm Street (p2): sub code Coat only
    const listed = h.$$('[data-bind="filter-sc"]').map(b => b.value);
    assert('a chosen code the jobs no longer carry is still listed (ticked) to undo', listed.includes('Base Course') && listed.includes('Coat')
      && h.$('[data-bind="filter-sc"][value="Base Course"]').checked, listed.join());
    h.$('[data-bind="filter-sc"][value="Base Course"]').click();
    h.$('[data-bind="filter-sc"][value="Coat"]').click();
    h.click(h.act('save'));
    await tick();
    h.modal().querySelector('#cr-m-name').value = 'Sealcoat only';
    h.modal().querySelector('[data-m="ok"]').click();
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    assert('the filter is saved with the report (v2 definition)', post && post.body.definition.v === 2
      && JSON.stringify(post.body.definition.filters) === '{"costCodes":[],"subCodes":["Coat"]}', post && JSON.stringify(post.body.definition.filters));
    h.click(h.act('print'));
    await tick();
    const run = h.srv.calls('POST', e => e.q.action === 'run').pop();
    assert('…and travels with the run log snapshot', run && JSON.stringify(run.body.definition.filters.subCodes) === '["Coat"]');
    // Escaping: a sub code with markup in it.
    h.data.projects[1].bidItems.push({ id: 'ex', cost_code: 'X<b>', sub_code: '<img src=x onerror="window.__xss=3">', unit: 'EA', quantity: '1' });
    h.click(h.$('#cr-step-2'));
    h.click(h.$('#cr-step-1'));
    assert('a sub code with markup is listed as text, never markup', h.mount.querySelectorAll('.cr-filters img').length === 0
      && /<img src=x onerror/.test(h.$('.cr-flist').textContent) && h.window.__xss === undefined);
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer()) });
    const E = h.window.FCTReportEngine;
    await h.render();
    const st = (E.startersFor ? E.startersFor('paving') : E.STARTERS).find(s => /sub[\s_-]?code/i.test(`${s.id} ${s.name}`));
    assert('there is a "Sub-Code Production" starter', !!st, (E.STARTERS || []).map(s => s.id).join());
    if (st) {
      h.click(h.$(`.cr-card[data-starter="${st.id}"]`));
      assert('it opens on step ① with the sub-code picker focused', h.S().step === 1
        && h.document.activeElement === h.$('[data-bind="filter-search"]'));
      assert('…and says to pick the jobs, then the sub code', /Pick the jobs, then the sub code/.test(h.toast()), h.toast());
    }
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('v2 · Starters by division (E.startersFor)');
  {
    const h = boot({ server: seed(makeServer()) });
    const E = h.window.FCTReportEngine;
    await h.render();
    const pav = E.startersFor('paving'), turf = E.startersFor('turf');
    const tonnage = pav.find(s => s.divisions && s.divisions.length === 1 && s.divisions[0] === 'paving');
    assert('paving offers a paving-only starter (Paving Tonnage) that turf does not', !!tonnage && !turf.some(s => s.id === tonnage.id));
    assert('the paving rail and welcome cards list exactly E.startersFor("paving")',
      h.$$('.cr-card[data-act="starter"]').map(b => b.getAttribute('data-starter')).join() === pav.map(s => s.id).join());
    h.close();
    const t = boot({ server: makeServer({ division: 'turf' }), cfg: { division: 'turf', divisionLabel: 'Turf' } });
    await t.render();
    assert('the turf tab lists turf\'s starters — no Paving Tonnage', !t.$(`.cr-card[data-starter="${tonnage && tonnage.id}"]`)
      && t.$$('.cr-card[data-act="starter"]').length === turf.length);
    t.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('v2 · Section options — sub codes, Planned vs Actual, Chart, Division Rates');
  {
    const h = boot({ server: seed(makeServer()) });
    const E = h.window.FCTReportEngine;
    await h.render();
    h.click(h.act('new'));
    h.$$('.cr-job input')[0].click();
    h.click(h.$('#cr-step-2'));
    const add = type => {
      h.click(h.act('add-menu'));
      const it = h.document.querySelector(`.cr-menu [data-type="${type}"]`);
      if (!it) return null;
      h.click(it);
      return h.S().doc.def.sections[h.S().doc.def.sections.length - 1];
    };
    const opt = (s, key) => h.$(`[data-bind="opt"][data-sec="${s.id}"][data-key="${key}"]`);
    const bp = add('bid_progress');
    const scBoxes = h.$$(`[data-bind="opt-sc"][data-sec="${bp.id}"]`);
    assert('a data section has a Sub codes picker of the picked jobs\' sub codes', scBoxes.length === 3
      && scBoxes.map(b => b.getAttribute('data-value')).join() === E.subCodesFor([h.data.projects[0]]).map(x => x.code).join());
    scBoxes.find(b => b.getAttribute('data-value') === 'Surface Course').click();
    assert('ticking one writes section.options.subCodes', JSON.stringify(bp.options.subCodes) === '["Surface Course"]');
    await sleep(PREVIEW_WAIT);
    assert('…and the section shows only it', /Surface Course/.test(h.srcdoc()) && !/Base Course/.test(h.srcdoc()));
    h.click(h.$(`[data-act="sc-all"][data-sec="${bp.id}"]`));
    assert('"Show all" clears the section\'s sub codes', bp.options.subCodes.length === 0);

    const pva = add('plan_vs_actual');
    assert('Planned vs Actual can be added', !!pva && pva.type === 'plan_vs_actual');
    if (pva) {
      assert('…with Hide unplanned, Hide complete, Totals and Group by', !!opt(pva, 'hideUnplanned') && !!opt(pva, 'hideComplete')
        && !!opt(pva, 'totals') && !!opt(pva, 'groupBy') && opt(pva, 'groupBy').tagName === 'SELECT');
      opt(pva, 'hideUnplanned').click();
      h.change(opt(pva, 'groupBy'), 'none');
      assert('…which write its options', pva.options.hideUnplanned === true && pva.options.groupBy === 'none');
      assert('…plus cost-code and sub-code pickers', !!h.$(`[data-bind="opt-cc"][data-sec="${pva.id}"]`) && !!h.$(`[data-bind="opt-sc"][data-sec="${pva.id}"]`));
      assert('…and its internal Units / Crew-Hour column is locked', !!h.colBox(pva.id, 'units_per_crew_hr') && h.colBox(pva.id, 'units_per_crew_hr').disabled);
    }
    const ch = add('chart');
    assert('a Chart can be added', !!ch && ch.type === 'chart');
    if (ch) {
      assert('…with chart type, basis, show plan and height', opt(ch, 'chart').tagName === 'SELECT' && opt(ch, 'basis').tagName === 'SELECT'
        && !!opt(ch, 'showPlan') && opt(ch, 'height').tagName === 'SELECT');
      h.change(opt(ch, 'chart'), 'daily_bars');
      h.change(opt(ch, 'height'), 'tall');
      opt(ch, 'showPlan').click();
      assert('…which write its options', ch.options.chart === 'daily_bars' && ch.options.height === 'tall' && ch.options.showPlan === false);
      assert('…its measures are listed as "Measures drawn"', /Measures drawn/.test(h.$(`.cr-sec[data-sec="${ch.id}"]`).textContent));
      assert('…the internal Crew hours measure is locked', h.colBox(ch.id, 'crew_hours') && h.colBox(ch.id, 'crew_hours').disabled);
      await sleep(PREVIEW_WAIT);
      assert('…and it reaches the preview as inline SVG', /<svg[^>]*viewBox/.test(h.srcdoc()));
    }
    const rs = add('rate_summary');
    assert('Division Rates can be added', !!rs && rs.type === 'rate_summary');
    if (rs) {
      assert('on paving it offers the paving tiles (Tons / Day, Tons / Load), not turf\'s or Kiewit\'s',
        !!h.colBox(rs.id, 'tons_per_day') && !!h.colBox(rs.id, 'tons_per_load') && !h.colBox(rs.id, 'sf_per_day') && !h.colBox(rs.id, 'homes_per_day'));
      assert('…its internal Tons / Crew-Hour locked while customer-safe', h.colBox(rs.id, 'tons_per_crew_hr') && h.colBox(rs.id, 'tons_per_crew_hr').disabled);
      assert('…and only the code pickers as options', !!h.$(`[data-bind="opt-cc"][data-sec="${rs.id}"]`) && !!h.$(`[data-bind="opt-sc"][data-sec="${rs.id}"]`)
        && !h.$(`[data-bind="opt"][data-sec="${rs.id}"]`));
      // A forged tick of another division's column is refused.
      const fake = h.document.createElement('input');
      fake.type = 'checkbox'; fake.checked = true;
      fake.setAttribute('data-bind', 'col'); fake.setAttribute('data-sec', rs.id); fake.setAttribute('data-key', 'sf_per_day');
      h.$(`.cr-sec[data-sec="${rs.id}"]`).appendChild(fake);
      const colsBefore = JSON.stringify(rs.columns);
      h.colBox(rs.id, 'tons_per_day').click();   // off …
      fake.dispatchEvent(new h.window.Event('change', { bubbles: true }));
      assert('a forged tick of a turf-only column on a paving report changes nothing', JSON.stringify(rs.columns) === JSON.stringify(JSON.parse(colsBefore).filter(k => k !== 'tons_per_day')),
        rs.columns.join());
      h.colBox(rs.id, 'tons_per_day').click();   // … and back on
      await sleep(PREVIEW_WAIT);
      assert('…and a paving preview never prints a turf or Kiewit tile', !/SF \/ Day|Homes \/ Day/.test(h.srcdoc()));
      h.click(h.$(`[data-act="sec-toggle"][data-sec="${rs.id}"]`));
      assert('the folded summary names the paving tiles it will print', /Tons \/ Day/.test(h.$(`.cr-sec[data-sec="${rs.id}"] .cr-sec-sum`).textContent));
    }
    h.close();
    const t = boot({ server: makeServer({ division: 'turf' }), cfg: { division: 'turf', divisionLabel: 'Turf', areaUnit: 'SF' } });
    await t.render();
    t.click(t.act('new'));
    t.click(t.$('#cr-step-2'));
    t.click(t.act('add-menu'));
    t.click(t.document.querySelector('.cr-menu [data-type="rate_summary"]'));
    const trs = t.S().doc.def.sections[0];
    assert('on turf Division Rates offers SF / Day, not tons', !!t.colBox(trs.id, 'sf_per_day') && !t.colBox(trs.id, 'tons_per_day'));
    t.close();
  }
  // ════════════════════════════════════════════════════════════════════
  section('v2 · Branding, the PM line and the report contact (step ③)');
  {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const people = [
      { name: 'Jane Smith', phone: '555-0100', email: 'jane@forcecorp.example', logins: ['jsmith'] },
      { name: 'Pat Quinn', phone: '555-0199', email: 'pat.quinn@forcecorp.example', logins: ['PAT'] },
      { name: 'pat', login: true },
    ];
    const branding = { display_name: 'Force Corp Paving', logo: { mime: 'image/png', base64: PNG, width: 1, height: 1 },
      phone: '724-555-0000', email: 'office@forcecorp.example', website: 'https://forcecorp.example', address: '1 Industrial Way',
      report_footer: 'Licensed & insured', updated_at: '2026-11-01T00:00:00Z', updated_by_username: 'boss' };
    const data = fixture();
    data.projects[0].pm = 'Smith, Jane';     // "Last, First" in the job; "First Last" in the directory
    data.projects[1].pm = 'Nobody Listed';
    const h = boot({ server: seed(makeServer({ people, branding })), data });
    const E = h.window.FCTReportEngine;
    const ctxOpts = [];
    const realMake = E.makeContext;
    E.makeContext = (def, cfg, opts) => { ctxOpts.push(opts); return realMake(def, cfg, opts); };
    await h.render();
    await tick(6);
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$$('.cr-job input')[0].click();
    await sleep(PREVIEW_WAIT);
    const o = ctxOpts[ctxOpts.length - 1] || {};
    assert('makeContext gets the company branding (name, logo, contact line)', o.branding && o.branding.display_name === 'Force Corp Paving'
      && o.branding.logo && o.branding.logo.mime === 'image/png' && o.branding.logo.base64 === PNG && o.branding.address === '1 Industrial Way',
      JSON.stringify(o.branding && Object.keys(o.branding)));
    assert('…the job\'s PM from the Team Directory ("Smith, Jane" = Jane Smith)', o.contacts && o.contacts.p1 && o.contacts.p1.pm
      && o.contacts.p1.pm.name === 'Jane Smith' && o.contacts.p1.pm.phone === '555-0100' && o.contacts.p1.pm.email === 'jane@forcecorp.example',
      JSON.stringify(o.contacts));
    assert('…and the report contact: the one PM on the report', o.reportContact && o.reportContact.name === 'Jane Smith' && o.reportContact.phone === '555-0100');
    let doc = h.srcdoc();
    assert('the preview prints the company name and its logo (a data: URI) in the masthead', /class="mast-co">Force Corp Paving</.test(doc)
      && /<img class="mast-logo" src="data:image\/png;base64,/.test(doc) && (doc.match(/data-dw-brand/g) || []).length === 1);
    assert('…the PM line in the job band', /Project Manager: Jane Smith · 555-0100 · jane@forcecorp\.example/.test(doc), doc.match(/jb-pm[^<]*/));
    assert('…the "Questions?" line', /Questions\? Jane Smith · 555-0100 · jane@forcecorp\.example/.test(doc));
    assert('…and "Prepared by" the real name behind the login (logins match case-blind)', /Prepared by Pat Quinn/.test(doc));
    h.click(h.$('#cr-step-3'));
    assert('step ③ has the masthead choice, Company branding by default', h.$('[data-bind="h-branding"]').value === 'company');
    assert('…says what the branding shows', /Shows Force Corp Paving and its logo/.test(h.$('.cr-panel').textContent));
    assert('…the PM checkbox, on by default, counting the jobs with a PM contact', h.$('[data-bind="h-showPmContact"]').checked
      && /1 job of 1 has a PM phone or email/.test(h.$('.cr-panel').textContent));
    assert('…and the contact fields with the resolved default as placeholders', h.$('[data-bind="h-contactName"]').placeholder === 'Jane Smith (default)'
      && h.$('[data-bind="h-contactPhone"]').placeholder === '555-0100 (default)' && h.$('[data-bind="h-contactEmail"]').placeholder === 'jane@forcecorp.example (default)');
    assert('"Prepared by" suggests the real name', h.$('[data-bind="h-preparedBy"]').placeholder === 'Pat Quinn (you)');
    h.change(h.$('[data-bind="h-branding"]'), 'datawatch');
    assert('"DataWatch only" is stored', h.S().doc.def.header.branding === 'datawatch');
    await sleep(PREVIEW_WAIT);
    doc = h.srcdoc();
    assert('…and the preview drops the logo for the DataWatch masthead', !/<img class="mast-logo"/.test(doc) && !/src="data:/.test(doc)
      && /class="mast-word">DataWatch</.test(doc));
    h.change(h.$('[data-bind="h-branding"]'), 'company');
    h.$('[data-bind="h-showPmContact"]').click();
    assert('unticking the PM line is stored', h.S().doc.def.header.showPmContact === false);
    await sleep(PREVIEW_WAIT);
    assert('…and the line goes', !/Project Manager: Jane/.test(h.srcdoc()));
    h.type(h.$('[data-bind="h-contactName"]'), 'The office');
    h.type(h.$('[data-bind="h-contactPhone"]'), '724-555-0000');
    await sleep(PREVIEW_WAIT);
    doc = h.srcdoc();
    assert('typed contact fields replace the default contact (no stray PM email)', /Questions\? The office · 724-555-0000/.test(doc)
      && !/Questions\?[^<]*jane@/.test(doc), (doc.match(/Questions\?[^<]*/) || [''])[0]);
    const last = ctxOpts[ctxOpts.length - 1];
    assert('…and that is what makeContext is given', last.reportContact.name === 'The office' && last.reportContact.email === '');
    h.click(h.act('save'));
    await tick();
    h.modal().querySelector('#cr-m-name').value = 'Branded update';
    h.modal().querySelector('[data-m="ok"]').click();
    await tick();
    const post = h.srv.calls('POST', e => !e.q.action).pop();
    const hd = post.body.definition.header;
    assert('the header choices are saved; the logo and the directory lookups are not', hd.branding === 'company' && hd.showPmContact === false
      && hd.contactName === 'The office' && hd.contactPhone === '724-555-0000' && !/base64|iVBOR/.test(JSON.stringify(post.body)));
    // Two jobs, two PMs: no single PM, so the default contact is the sender.
    h.click(h.$('#cr-step-1'));
    h.$$('.cr-job input')[1].click();
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="h-contactName"]'), '');
    h.type(h.$('[data-bind="h-contactPhone"]'), '');
    assert('with two PMs the default contact is the person sending it', h.$('[data-bind="h-contactName"]').placeholder === 'Pat Quinn (default)');
    // The branding is fetched once per visit, again after five minutes away.
    const n0 = h.srv.callsTo('/api/company/branding').length;
    await h.render();
    assert('opening the tab again within five minutes does not refetch the branding', h.srv.callsTo('/api/company/branding').length === n0);
    h.S().brandingAt -= 6 * 60 * 1000;
    await h.render();
    assert('…after five minutes it does', h.srv.callsTo('/api/company/branding').length === n0 + 1);
    assert('the Team Directory is fetched only once', h.srv.callsTo('/api/employees').length === 1);
    E.makeContext = realMake;
    h.close();
  }
  {
    // A logo that is not a PNG/JPEG data payload never reaches the engine.
    const srv = seed(makeServer({ branding: { display_name: 'Evil Co', logo: { mime: 'image/svg+xml', base64: 'PHN2Zz4=' } } }));
    const h = boot({ server: srv });
    const E = h.window.FCTReportEngine;
    const seen = [];
    const realMake = E.makeContext;
    E.makeContext = (def, cfg, opts) => { seen.push(opts); return realMake(def, cfg, opts); };
    await h.render();
    await tick(6);
    h.click(h.$('.cr-card[data-starter="haul_log"]'));
    h.$$('.cr-job input')[0].click();
    await sleep(PREVIEW_WAIT);
    const b = seen[seen.length - 1].branding;
    assert('an SVG "logo" is dropped before the engine; the name still shows', b && b.logo === null && b.display_name === 'Evil Co'
      && !/svg\+xml/.test(h.srcdoc()) && /Evil Co/.test(h.srcdoc()));
    E.makeContext = realMake;
    h.close();
  }
  {
    // Both lookups failing: an unbranded report, no error, no sign-out.
    const srv = seed(makeServer());
    srv.brandingFail = true;
    srv.peopleFail = true;
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$$('.cr-job input')[0].click();
    await sleep(PREVIEW_WAIT);
    const doc = h.srcdoc();
    assert('when branding and the directory fail, the report is plain DataWatch, prepared by the login', /class="mast-word">DataWatch</.test(doc)
      && /Prepared by pat/.test(doc) && !/Questions\?/.test(doc));
    assert('…quietly: no toast, no sign-out, no console error', !h.document.querySelector('.cr-toast.err') && h.authErrors === 0 && h.consoleErrors.length === 0,
      h.consoleErrors.join('; '));
    h.close();
  }
  {
    // A 401 on a side fetch must not sign the user out on its own.
    const srv = seed(makeServer());
    srv.next.push({ status: 401, body: { error: 'Unauthorized' }, match: e => e.path === '/api/company/branding' });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    assert('a 401 from the branding fetch alone does not sign the user out', h.authErrors === 0);
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('v2 · Email — saved contacts fill in the recipients');
  {
    const srv = seed(makeServer());
    srv.contacts = [
      { id: 1, project_id: 'p1', email: 'owner@acme.com', name: 'Olivia Owner', role: 'owner', auto_add: true },
      { id: 2, project_id: 'p1', email: 'quiet@acme.com', name: 'Not Auto', auto_add: false },
      { id: 3, project_id: null, client_key: 'acme township', client_name: 'Acme Township', email: 'eng@acme.com', name: 'Ed Engineer', auto_add: true },
      { id: 4, project_id: 'p2', email: 'owner@acme.com', name: 'Same Person', auto_add: true },
      { id: 5, project_id: 'p2', email: 'bea@beta.example', name: 'Bea <b>Beta</b>', auto_add: true },
      { id: 6, project_id: 'p3', email: 'other@job.example', auto_add: true },
    ];
    const h = boot({ server: srv });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$$('.cr-job input')[0].click();
    h.$$('.cr-job input')[1].click();
    h.click(h.act('email'));
    await tick(8);
    const get = h.srv.callsTo('/api/report-contacts', 'GET', e => e.q.project_ids).pop();
    assert('Email asks for the picked jobs\' contacts and their clients\' (by client key)', get && get.q.project_ids === 'p1,p2'
      && get.q.client_keys === 'acme township,beta corp' && get.q.division === 'paving', get && JSON.stringify(get.q));
    const em = h.email[0];
    assert('the modal opens', !!em);
    // Route 30 is Acme Township's, Elm Street Beta Corp's: two customers.
    const list = (em && em.suggestedContacts) || [];
    assert('two customers\' jobs: nothing is filled in — each owner would be sent the other\'s job',
      em && Array.isArray(em.contacts) && em.contacts.length === 0, em && JSON.stringify(em.contacts));
    assert('…the saved contacts are offered instead: each job\'s auto-add contacts, then the client\'s, one per address',
      JSON.stringify(list.map(c => c.email)) === '["owner@acme.com","bea@beta.example","eng@acme.com"]', JSON.stringify(list));
    assert('…with a note saying why', /These jobs belong to 2 different customers — each recipient would see the others' jobs/.test(em.suggestedNote || ''), em.suggestedNote);
    assert('…labelled with where they came from', list[0] && list[0].source === 'job' && list[0].label === 'Job contact — Route 30 Resurfacing'
      && list[0].name === 'Olivia Owner' && list[2].source === 'client' && list[2].label === 'Client contact — Acme Township');
    assert('…never a contact set not to auto-add, nor one for a job not on the report', !list.some(c => c.email === 'quiet@acme.com' || c.email === 'other@job.example'));
    const cc = em && em.contactContext;
    assert('contactContext lets the modal save a typed address as a contact, and says the jobs are more than one customer\'s', cc && cc.division === 'paving'
      && JSON.stringify(cc.projectIds) === '["p1","p2"]' && JSON.stringify(cc.clients) === '[{"key":"acme township","name":"Acme Township"},{"key":"beta corp","name":"Beta Corp"}]'
      && cc.mixed === true && cc.canEdit === true && cc.apiBase === '/api' && typeof cc.getToken === 'function' && cc.getToken() === 'tok-123', JSON.stringify(cc));
    assert('the other modal options are as before (customReport, no project name)', em.projectName === null && em.customReport && !('recipients' in em.customReport));
    h.close();
  }
  {
    // Two jobs of ONE customer (Acme Township's Route 30 and its other job): filled in.
    const srv = seed(makeServer());
    srv.contacts = [
      { id: 1, project_id: 'p1', email: 'owner@acme.com', name: 'Olivia Owner', auto_add: true },
      { id: 2, project_id: 'p3', email: 'site@acme.com', name: 'Site Lead', auto_add: true },
      { id: 3, project_id: null, client_key: 'acme township', client_name: 'Acme Township', email: 'eng@acme.com', auto_add: true },
    ];
    const h = boot({ server: srv });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$('.cr-job input[value="p1"]').click();
    h.$('.cr-job input[value="p3"]').click();
    h.click(h.act('email'));
    await tick(8);
    const em = h.email[0];
    assert('two jobs of one customer: their saved contacts are filled in, as before, with no warning',
      em && JSON.stringify((em.contacts || []).map(c => c.email).sort()) === '["eng@acme.com","owner@acme.com","site@acme.com"]'
        && (em.suggestedContacts || []).length === 0 && !em.suggestedNote && em.contactContext.mixed === false,
      em && JSON.stringify({ picked: h.S().doc.picked, c: em.contacts, s: em.suggestedContacts }));
    h.close();
  }
  {
    const srv = seed(makeServer({ contactsCanEdit: false }));
    srv.contacts = [{ id: 1, project_id: 'p1', email: 'owner@acme.com', auto_add: true }];
    const h = boot({ server: srv, cfg: { perm: { role: 'level1', canSeeCosts: false, canSeeFinancials: false } } });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$$('.cr-job input')[0].click();
    h.click(h.act('email'));
    await tick(8);
    assert('a read-only (level 1) user still gets the contacts, but contactContext.canEdit is false',
      h.email[0] && h.email[0].contacts.length === 1 && h.email[0].contactContext.canEdit === false);
    h.close();
  }
  {
    const srv = seed(makeServer());
    srv.next.push({ status: 500, body: { error: 'Database error' }, match: e => e.path === '/api/report-contacts' && !!e.q.project_ids });
    const h = boot({ server: srv });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$$('.cr-job input')[0].click();
    h.click(h.act('email'));
    await tick(8);
    assert('a failed contacts lookup still opens the modal, with no contacts', h.email.length === 1 && h.email[0].contacts.length === 0
      && h.email[0].contactContext.canEdit === false);
    h.close();
  }
  {
    // A client name with a comma cannot ride in the comma list: the whole
    // division list is read and matched in the browser.
    const data = fixture();
    data.projects[0].client = 'Smith, Jones & Co';
    const srv = seed(makeServer());
    srv.contacts = [{ id: 9, project_id: null, client_key: 'smith, jones & co', client_name: 'Smith, Jones & Co', email: 'sj@law.example', auto_add: true },
      { id: 10, project_id: null, client_key: 'jones & co', client_name: 'Jones & Co', email: 'wrong@law.example', auto_add: true }];
    const h = boot({ server: srv, data });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    h.$$('.cr-job input')[0].click();
    h.click(h.act('email'));
    await tick(8);
    const gets = h.srv.callsTo('/api/report-contacts', 'GET');
    assert('a client with a comma in its name is matched whole, not split', h.email[0] && JSON.stringify(h.email[0].contacts.map(c => c.email)) === '["sj@law.example"]'
      && !gets[gets.length - 1].q.client_keys, JSON.stringify(h.email[0] && h.email[0].contacts));
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('v2 · Contacts manager');
  {
    const srv = seed(makeServer());
    srv.contacts = [
      { id: 1, project_id: 'p1', email: 'owner@acme.com', name: 'Olivia Owner', title: 'Owner rep', organization: 'Acme Township', role: 'owner', auto_add: true },
      { id: 3, project_id: null, client_key: 'acme township', client_name: 'Acme Township', email: 'eng@acme.com', name: '<i>Ed</i>', role: 'engineer', auto_add: true },
      { id: 5, project_id: 'p2', email: 'bea@beta.example', name: 'Bea', role: 'gc', auto_add: false },
    ];
    const h = boot({ server: srv });
    await h.render();
    h.click(h.$('.cr-card[data-starter="customer_progress"]'));
    const badge = h.$('.cr-job-ct[data-id="p1"]');
    assert('step ① shows "N contacts" on a job with saved contacts (its own + its client\'s)', badge && badge.textContent === '2 contacts'
      && h.$('.cr-job-ct[data-id="p2"]').textContent === '1 contact', badge && badge.textContent);
    h.click(badge);
    await tick();
    assert('the badge does not tick the job', h.S().doc.picked.length === 0);
    assert('…it opens Contacts on that job', h.S().view === 'contacts' && h.$('[data-bind="ct-job"]').value === 'p1');
    let text = h.$('.cr-ct-list').textContent;
    assert('…showing the job\'s contacts and its client\'s, grouped', /Route 30 Resurfacing/.test(text) && /Client: Acme Township/.test(text)
      && /Olivia Owner/.test(text) && !/Bea/.test(text));
    assert('…names as text, never markup', /<i>Ed<\/i>/.test(text) && !h.$('.cr-ct-list i'));
    h.change(h.$('[data-bind="ct-job"]'), '');
    assert('"Every job and client" lists them all', /Bea/.test(h.$('.cr-ct-list').textContent) && /Elm Street Lot/.test(h.$('.cr-ct-list').textContent));
    h.type(h.$('[data-bind="ct-search"]'), 'bea');
    assert('search narrows the list (and keeps focus)', !/Olivia/.test(h.$('.cr-ct-list').textContent) && /Bea/.test(h.$('.cr-ct-list').textContent)
      && h.document.activeElement === h.$('[data-bind="ct-search"]'));
    h.type(h.$('[data-bind="ct-search"]'), '');
    // Add
    h.click(h.act('ct-add'));
    assert('+ Add contact opens the form, email focused', !!h.$('.cr-form') && h.document.activeElement === h.$('[data-field="email"]'));
    h.change(h.$('[data-field="project_id"]'), 'p2');
    h.type(h.$('[data-field="email"]'), 'not-an-email');
    h.click(h.act('ct-save'));
    await tick();
    assert('a bad address is caught before the server', /valid email/.test(h.$('.cr-form-err').textContent) && h.srv.callsTo('/api/report-contacts', 'POST').length === 0);
    h.type(h.$('[data-field="email"]'), 'New.Person@Beta.example');
    h.type(h.$('[data-field="name"]'), 'New Person');
    h.type(h.$('[data-field="phone"]'), '(412) 555-0101 ext 4');
    h.change(h.$('[data-field="role"]'), 'inspector');
    h.click(h.act('ct-save'));
    await tick(6);
    let post = h.srv.callsTo('/api/report-contacts', 'POST').pop();
    assert('it POSTs the contact for the job, email lower-cased', post && post.body.project_id === 'p2' && post.body.email === 'new.person@beta.example'
      && post.body.name === 'New Person' && post.body.role === 'inspector' && post.body.auto_add === true && post.body.phone === '(412) 555-0101 ext 4'
      && post.q.division === 'paving', post && JSON.stringify(post.body));
    assert('…and it is listed', !h.$('.cr-form') && /New Person/.test(h.$('.cr-ct-list').textContent));
    // Duplicate
    h.click(h.act('ct-add'));
    h.change(h.$('[data-field="scope"]'), 'client');
    assert('switching to "Every job for a client" offers the clients', !!h.$('[data-field="client_name"]') && !h.$('[data-field="project_id"]'));
    h.change(h.$('[data-field="client_name"]'), 'Acme Township');
    h.type(h.$('[data-field="email"]'), 'eng@acme.com');
    h.click(h.act('ct-save'));
    await tick(6);
    post = h.srv.callsTo('/api/report-contacts', 'POST').pop();
    assert('a client contact is sent with its client name and key', post.body.project_id === null && post.body.client_name === 'Acme Township'
      && post.body.client_key === 'acme township');
    assert('the server\'s duplicate refusal is explained in the form', /already saved for this client/.test(h.$('.cr-form-err').textContent));
    h.click(h.act('ct-cancel'));
    // Edit
    h.click(h.$('[data-act="ct-edit"][data-id="1"]'));
    assert('Edit opens the form filled in', h.$('[data-field="email"]').value === 'owner@acme.com' && h.$('[data-field="title"]').value === 'Owner rep');
    h.type(h.$('[data-field="title"]'), 'Township manager');
    h.$('[data-field="email"]').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(6);
    const put = h.srv.callsTo('/api/report-contacts', 'PUT').pop();
    assert('Enter saves an edit with a PUT ?id=', put && put.q.id === '1' && put.body.title === 'Township manager' && put.body.project_id === 'p1');
    assert('…and the card shows it', /Township manager/.test(h.$('.cr-ct-list').textContent));
    // Auto-add toggle
    const auto = h.$('[data-bind="ct-auto"][data-id="5"]');
    assert('the auto-add box shows the saved value', auto && !auto.checked);
    auto.click();
    await tick(6);
    const put2 = h.srv.callsTo('/api/report-contacts', 'PUT').pop();
    assert('ticking auto-add PUTs just that', put2.q.id === '5' && JSON.stringify(put2.body) === '{"auto_add":true}');
    // Delete
    h.answers.push(false);
    h.click(h.$('[data-act="ct-delete"][data-id="5"]'));
    await tick();
    assert('Delete asks first', /Delete the contact Bea/.test(h.confirms.pop()) && h.srv.callsTo('/api/report-contacts', 'DELETE').length === 0);
    h.click(h.$('[data-act="ct-delete"][data-id="5"]'));
    await tick(6);
    assert('…then DELETEs ?id= and drops it', h.srv.callsTo('/api/report-contacts', 'DELETE').pop().q.id === '5' && !/Bea/.test(h.$('.cr-ct-list').textContent));
    h.click(h.act('back'));
    assert('Back returns to the open report', h.S().view === 'edit');
    assert('…where the job badges count the new contact', h.$('.cr-job-ct[data-id="p2"]') && h.$('.cr-job-ct[data-id="p2"]').textContent === '1 contact');
    h.close();
  }
  {
    const srv = seed(makeServer({ contactsCanEdit: false }));
    srv.contacts = [{ id: 1, project_id: 'p1', email: 'owner@acme.com', name: 'Olivia', auto_add: true }];
    const h = boot({ server: srv, cfg: { perm: { role: 'level1', canSeeCosts: false, canSeeFinancials: false } } });
    await h.render();
    h.click(h.act('contacts'));
    await tick(6);
    assert('level 1: Contacts lists but cannot change — no Add, Edit or Delete, auto-add disabled',
      /Olivia/.test(h.$('.cr-ct-list').textContent) && !h.act('ct-add') && !h.$('[data-act="ct-edit"]') && !h.$('[data-act="ct-delete"]')
        && h.$('[data-bind="ct-auto"]').disabled && /Only level 2 users and up/.test(h.mount.textContent));
    h.close();
  }
  {
    // A Contacts load or Refresh that fails says so — even with a list from
    // an earlier load still on screen — and the next good one clears it.
    const srv = seed(makeServer());
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    srv.contacts.push({ id: 9, project_id: 'p1', email: 'new@acme.com', name: 'Added Elsewhere', role: 'owner', auto_add: true });
    srv.contactsFail = true;
    h.click(h.act('contacts'));
    await tick(6);
    const alertText = () => { const a = h.mount.querySelector('.cr-alert'); return a ? a.textContent : ''; };
    assert('the Contacts view, its load failing after an earlier one worked: says it could not load them, with Retry — not just "No contacts saved yet"',
      /Couldn’t load contacts/.test(alertText()) && !!h.mount.querySelector('.cr-alert [data-act="ct-refresh"]'), h.mount.textContent.replace(/\s+/g, ' ').slice(0, 400));
    h.click(h.act('ct-refresh'));
    await tick(6);
    assert('…and so does a Refresh that fails', /Couldn’t load contacts/.test(alertText()));
    srv.contactsFail = false;
    h.click(h.act('ct-refresh'));
    await tick(6);
    assert('…the next Refresh that works clears it and shows the list', !alertText() && /Added Elsewhere/.test(h.$('.cr-ct-list').textContent));
    h.close();
  }
  // ════════════════════════════════════════════════════════════════════
  section('v2 · Customer History — open or resend exactly what was sent');
  const ARCHIVED = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Weekly</title></head>'
    + '<body><div class="masthead" data-dw-brand>Force Corp</div><h1>ARCHIVED COPY — Route 30 — Week 44</h1><p>Installed 550 TON</p></body></html>';
  const histServer = o => {
    const srv = seed(makeServer(o));
    const def = { v: 2, title: 'Weekly Update', jobs: { mode: 'pick', ids: ['p1'] }, dates: { preset: 'last_week', from: '', to: '' },
      header: { preparedFor: 'Acme Township', preparedBy: 'Pat Quinn' }, sections: [{ type: 'job_info' }, { type: 'bid_progress' }] };
    const base = { report_id: 1, report_name: 'Acme weekly update', project_ids: ['p1'], project_names: ['Route 30 Resurfacing'],
      date_from: '2026-10-26', date_to: '2026-11-01', definition: def };
    srv.addRun(Object.assign({}, base, { id: 1, created_at: '2026-10-20T13:00:00Z', subject: 'Week 42', recipients: ['owner@acme.com'] }));
    srv.addRun(Object.assign({}, base, { id: 2, created_at: '2026-10-27T13:00:00Z', subject: 'Week 43', recipients: ['owner@acme.com', 'eng@acme.com'],
      run_kind: 'schedule', run_by_username: 'robot', run_by_user_id: 3, schedule_id: 77 }));
    srv.addRun(Object.assign({}, base, { id: 3, created_at: '2026-11-02T13:00:00Z', subject: 'Costs', recipients: ['boss@forcecorp.example'],
      included_internal: true, run_by_username: 'sam', run_by_user_id: 9 }));
    srv.addRun(Object.assign({}, base, { id: 4, created_at: '2026-11-03T13:00:00Z', action: 'print', subject: null }));
    srv.addRun(Object.assign({}, base, { id: 5, created_at: '2026-11-04T13:00:00Z', subject: 'Week 44 <b>again</b>', recipients: ['owner@acme.com'],
      run_kind: 'resend', resent_from_run_id: 1 }));
    srv.addRun(Object.assign({}, base, { id: 6, created_at: '2026-11-04T14:00:00Z', project_ids: ['p2'], project_names: ['Elm Street Lot'], subject: 'Elm' }));
    srv.archives[1] = ARCHIVED;
    srv.archives[3] = ARCHIVED.replace('ARCHIVED COPY', 'INTERNAL COPY');
    srv.archives[5] = ARCHIVED;
    return srv;
  };
  {
    const h = boot({ server: histServer({ runPage: 2 }) });
    const E = h.window.FCTReportEngine;
    await h.render();
    h.click(h.act('customer'));
    await tick();
    assert('the rail opens Customer History, asking for a job', h.S().view === 'customer' && /Pick a job to see what its customer was sent/.test(h.mount.textContent));
    h.type(h.$('[data-bind="cust-search"]'), 'route');
    assert('the job picker is searchable', h.$$('[data-bind="cust-job"] option').length === 2 && /Route 30/.test(h.$('[data-bind="cust-job"]').textContent));
    h.change(h.$('[data-bind="cust-client"]'), 'acme township');
    h.change(h.$('[data-bind="cust-job"]'), 'p1');
    await tick(6);
    let get = h.srv.calls('GET', e => e.q.runs === '1').pop();
    assert('picking a job asks for its emails only: ?runs=1&project_id=p1&action=email', get && get.q.project_id === 'p1' && get.q.action === 'email'
      && !get.q.before_id, get && JSON.stringify(get.q));
    let rows = h.$$('.cr-cust tbody tr');
    assert('newest first, a page at a time', rows.length === 2 && /Week 44/.test(rows[0].textContent) && /Costs/.test(rows[1].textContent));
    assert('each row: date, report, subject, recipients, sent by, kind, data', /Acme weekly update/.test(rows[0].textContent) && /owner@acme\.com/.test(rows[0].textContent)
      && /Resent/.test(rows[0].textContent) && /Customer-safe/.test(rows[0].textContent) && /sam/.test(rows[1].textContent) && /Internal/.test(rows[1].textContent));
    assert('subjects are text, never markup', /Week 44 <b>again<\/b>/.test(rows[0].textContent) && !h.$('.cr-cust b'));
    h.click(h.act('cust-more'));
    await tick(6);
    get = h.srv.calls('GET', e => e.q.runs === '1').pop();
    assert('"Load more" asks for the next page with before_id', get.q.before_id === '3', JSON.stringify(get.q));
    rows = h.$$('.cr-cust tbody tr');
    assert('…and appends it: the print run is not there (emails only), the other job\'s neither', rows.length === 4
      && /Scheduled/.test(rows[2].textContent) && /robot/.test(rows[2].textContent) && /Week 42/.test(rows[3].textContent)
      && !h.$$('.cr-cust tbody tr').some(r => /Elm/.test(r.textContent)), rows.map(r => r.textContent.replace(/\s+/g, ' ').slice(0, 60)).join(' | '));
    assert('…and "Load more" goes when there is no more', !h.act('cust-more'));

    // Open: the archived copy.
    h.click(h.$('[data-act="cust-open"][data-id="1"]'));
    assert('Open opens the window inside the click', h.opened.length === 1);
    await tick(6);
    let w = h.opened[0];
    // The shell, parsed as a browser would (no script runs here).
    const shellOf = written => new JSDOM(written).window.document;
    let sd = shellOf(w.written);
    let fr = sd.querySelectorAll('iframe');
    assert('…and shows the archived HTML exactly — as the srcdoc of a sandboxed frame, not through dwWrite — with no "rebuilt" banner',
      fr.length === 1 && fr[0].getAttribute('srcdoc') === ARCHIVED && !h.dwCalls.some(c => /ARCHIVED COPY/.test(c))
        && !/Rebuilt from current data/.test(w.written), w.written.slice(0, 300));
    assert('…locked down: the policy is the first thing in the head, and the frame may run no script',
      w.written.indexOf('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'') === 0
        && sd.head.firstElementChild.getAttribute('http-equiv') === 'Content-Security-Policy'
        && /form-action 'none'/.test(sd.head.firstElementChild.getAttribute('content'))
        && fr[0].hasAttribute('sandbox') && !/allow-scripts/.test(fr[0].getAttribute('sandbox'))
        && !sd.querySelector('[data-dw-brand]'), w.written.slice(0, 300));
    assert('…and the archive was fetched with ?run=1&archive=1', h.srv.calls('GET', e => e.q.run === '1' && e.q.archive === '1').length === 1);
    assert('opening is not logged as a send', h.srv.calls('POST', e => e.q.action === 'run').length === 0);
    // Whatever the archive holds — markup that moves <head>, a bare fragment,
    // a script closed with a space — it is only ever the frame's srcdoc.
    const HOSTILE = ['<!--<head>--><img src="x"/onerror="window.opener.__pw=1"><p>A</p>',
      '<p>x</p><img src="x"/onerror="window.opener.__pw=1">',
      '<script>window.opener.__pw=1</script ><head></head><p>B</p>'];
    for (const [i, bad] of HOSTILE.entries()) {
      h.srv.archives[1] = bad;
      const before = h.opened.length;
      h.click(h.$('[data-act="cust-open"][data-id="1"]'));
      await tick(6);
      const hw = h.opened[before];
      const hd = hw ? shellOf(hw.written) : null;
      const hf = hd ? hd.querySelectorAll('iframe') : [];
      // The window's one script is its own: the nonce its policy names, none of the archive in it.
      const own = hd ? [...hd.querySelectorAll('script')] : [];
      const nonce = hd ? ((hd.head.firstElementChild.getAttribute('content') || '').match(/script-src 'nonce-([0-9a-f]{32})'/) || [])[1] : null;
      assert(`hostile archive ${i + 1}: written only inside the sandboxed frame — no element of it in the window's own document, the policy still first in the head`,
        hd && hf.length === 1 && hf[0].getAttribute('srcdoc') === bad && !hd.querySelector('img, p')
          && own.length === 1 && !!nonce && own[0].getAttribute('nonce') === nonce && !/__pw/.test(own[0].textContent)
          && hd.head.firstElementChild.getAttribute('http-equiv') === 'Content-Security-Policy' && !/allow-scripts/.test(hf[0].getAttribute('sandbox'))
          && h.window.__pw === undefined, hw && hw.written.slice(0, 400));
    }
    {
      const nonces = h.opened.slice(-3).map(x => (x.written.match(/script-src 'nonce-([0-9a-f]{32})'/) || [])[1]);
      assert('…its script allowed by a nonce made fresh for each open, and by nothing else',
        nonces.every(Boolean) && new Set(nonces).size === nonces.length
          && h.opened.slice(-3).every(x => !/script-src[^;]*('unsafe-inline'|\*|https?:|data:)/.test(x.written)),
        JSON.stringify(nonces));
    }
    h.srv.archives[1] = ARCHIVED;

    // Open: no archive → rebuilt, dates and "today" pinned, with the banner.
    const seen = [];
    const realMake = E.makeContext;
    E.makeContext = (def, cfg, opts) => { seen.push({ def, opts }); return realMake(def, cfg, opts); };
    h.click(h.$('[data-act="cust-open"][data-id="2"]'));
    await tick(8);
    w = h.opened[h.opened.length - 1];
    const last = seen[seen.length - 1];
    assert('a send with no archived copy is fetched (?run=2) and rebuilt', h.srv.calls('GET', e => e.q.run === '2' && !e.q.archive).length === 1
      && h.srv.calls('GET', e => e.q.run === '2' && e.q.archive).length === 0, 'has_archive false skips the archive call');
    assert('…with its jobs, its dates pinned (custom) and "today"/"now" the moment it went',
      last && JSON.stringify(last.opts.pickedIds) === '["p1"]' && last.def.dates.preset === 'custom' && last.def.dates.from === '2026-10-26'
        && last.def.dates.to === '2026-11-01' && last.opts.today === '2026-10-27' && last.opts.now === '2026-10-27T13:00:00Z',
      last && JSON.stringify({ d: last.def.dates, t: last.opts.today, n: last.opts.now }));
    sd = shellOf(w.written);
    fr = sd.querySelectorAll('iframe');
    const rebuilt = fr.length === 1 ? fr[0].getAttribute('srcdoc') : '';
    assert('…under a yellow banner saying it was rebuilt — in the same sandboxed frame, behind the same policy',
      /Rebuilt from current data — the original was not archived/.test(rebuilt) && /background:#fef3c7/.test(rebuilt) && /Route 30 Resurfacing/.test(rebuilt)
        && sd.head.firstElementChild.getAttribute('http-equiv') === 'Content-Security-Policy' && !/allow-scripts/.test(fr[0].getAttribute('sandbox')));
    E.makeContext = realMake;

    // Resend: the archived copy, to the same people, same subject.
    h.click(h.$('[data-act="cust-resend"][data-id="1"]'));
    await tick(8);
    const em = h.email[0];
    assert('Resend opens the email modal', !!em);
    assert('…with the exact archived HTML', em && em.getHTML() === ARCHIVED);
    assert('…the same recipients and subject', em && JSON.stringify(em.defaultRecipients) === '["owner@acme.com"]' && em.defaultSubject === 'Week 42');
    assert('…as a resend of run 1, against the same report and jobs', em && em.reportType === 'paving_custom_report' && em.customReport.run_kind === 'resend'
      && em.customReport.resent_from_run_id === 1 && em.customReport.report_id === 1 && JSON.stringify(em.customReport.project_ids) === '["p1"]'
      && em.customReport.included_internal === false && em.customReport.definition.v === 2 && em.projectId === 'p1' && em.projectName === null,
      em && JSON.stringify(em.customReport).slice(0, 300));
    await em.onSent({ recipients: ['owner@acme.com'], subject: 'Week 42', recipientCount: 1 });
    const logged = h.srv.calls('POST', e => e.q.action === 'run').pop();
    assert('a resend the server did not log is logged as run_kind resend', logged && logged.body.action === 'email' && logged.body.run_kind === 'resend'
      && logged.body.resent_from_run_id === 1 && logged.body.recipients[0] === 'owner@acme.com');
    await tick(8);
    // The list reloads to its first page (the resend is now on top): page down to the older rows again.
    const showRun = async id => {
      for (let i = 0; i < 6 && !h.$(`[data-act="cust-resend"][data-id="${id}"]`) && h.act('cust-more'); i++) { h.click(h.act('cust-more')); await tick(6); }
    };
    assert('after a resend the list reloads, the new send on top', /Week 42/.test((h.$$('.cr-cust tbody tr')[0] || {}).textContent || '')
      && /Resent/.test((h.$$('.cr-cust tbody tr')[0] || {}).textContent || ''));
    await showRun(2);
    // Resend with no archive: the rebuild, without the banner.
    h.click(h.$('[data-act="cust-resend"][data-id="2"]'));
    await tick(8);
    const em2 = h.email[1];
    assert('resending a send with no archive mails the rebuild, without the banner', em2 && /Route 30 Resurfacing/.test(em2.getHTML())
      && !/Rebuilt from current data/.test(em2.getHTML()) && JSON.stringify(em2.defaultRecipients) === '["owner@acme.com","eng@acme.com"]');
    // Internal: confirm first (admin may open it).
    h.answers.push(false);
    h.click(h.$('[data-act="cust-resend"][data-id="3"]'));
    await tick(8);
    assert('resending an internal send asks first, and "no" opens nothing', /includes internal data/.test(h.confirms.pop() || '') && h.email.length === 2);
    // Size check.
    h.srv.archives[5] = ARCHIVED.replace('</body>', '<p>' + 'x'.repeat(1500000) + '</p></body>');
    h.click(h.$('[data-act="cust-resend"][data-id="5"]'));
    await tick(8);
    assert('an archived copy over the email limit is refused before the modal', h.email.length === 2 && /too big to email/.test(h.toast()));

    // A scheduled send to more addresses than one email can carry.
    h.srv.addRun(Object.assign({}, h.srv.runs.find(r => r.id === 1), { id: 9, created_at: '2026-11-05T13:00:00Z', subject: 'Big list',
      run_kind: 'schedule', recipients: Array.from({ length: 60 }, (_, i) => `r${i}@acme.com`) }));
    h.srv.archives[9] = ARCHIVED;
    h.click(h.act('cust-refresh'));
    await tick(8);
    h.click(h.$('[data-act="cust-resend"][data-id="9"]'));
    await tick(8);
    const em3 = h.email[h.email.length - 1];
    assert('resending a send to 60 addresses fills in the first 50 (one email\'s limit) and says the other 10 need another send',
      h.email.length === 3 && em3.defaultRecipients.length === 50 && em3.defaultRecipients[0] === 'r0@acme.com'
        && em3.defaultRecipients[49] === 'r49@acme.com' && /went to 60 addresses/.test(h.toast()) && /other 10/.test(h.toast()),
      em3 && em3.defaultRecipients.length + ' ' + h.toast());
    await showRun(2);

    // Open in builder.
    h.click(h.$('[data-act="cust-builder"][data-id="2"]'));
    await tick(8);
    const d = h.S().doc;
    assert('Open in builder makes a new, unsaved report from what was sent', h.S().view === 'edit' && d && d.id === null && d.touched
      && d.name === 'Acme weekly update' && JSON.stringify(d.picked) === '["p1"]' && d.def.sections.map(s => s.type).join() === 'job_info,bid_progress');
    assert('…with the send\'s dates', d.def.dates.preset === 'custom' && d.def.dates.from === '2026-10-26' && d.def.dates.to === '2026-11-01');
    h.close();
  }
  {
    // Not the sender, not admin / level 3: an internal send is not opened.
    const h = boot({ server: histServer({ canShare: false }), cfg: { perm: { role: 'level2', canSeeCosts: true, canSeeFinancials: true, canShare: false } } });
    await h.render();
    h.click(h.act('customer'));
    h.change(h.$('[data-bind="cust-job"]'), 'p1');
    await tick(6);
    h.click(h.$('[data-act="cust-open"][data-id="3"]'));
    await tick(6);
    assert('a level 2 who did not send an internal report gets the toast, and no window', h.opened.length === 0
      && /Only the sender or an admin\/level 3 can open internal reports\./.test(h.toast()), h.toast());
    h.click(h.$('[data-act="cust-resend"][data-id="3"]'));
    await tick(6);
    assert('…nor can resend it', h.email.length === 0);
    // The server has the last word: a row without a sender goes to it, and its 403 closes the window.
    h.S().cust.runs.find(r => r.id === 3).run_by_user_id = null;
    h.S().cust.runs.find(r => r.id === 3).run_by_username = null;
    h.click(h.$('[data-act="cust-open"][data-id="3"]'));
    await tick(8);
    assert('a 403 internal_archive from the server closes the window and says why', h.opened.length === 1 && h.opened[0].closed
      && /Only the sender or an admin\/level 3/.test(h.toast()) && !/INTERNAL COPY/.test(h.opened[0].written));
    // Open in builder: an internal send reopens customer-safe for them.
    h.click(h.$('[data-act="cust-builder"][data-id="3"]'));
    await tick(8);
    assert('…and Open in builder starts it customer-safe', h.S().doc && h.S().doc.def.includeInternal === false);
    h.close();
  }
  {
    // An expired session on Open: the archive GET 401s (which, in the app,
    // signs the tab out). The placeholder window must be closed, not left
    // orphaned reading "Opening the report…", and no toast piles on the
    // sign-out. Also for the rebuild path (no archived copy).
    for (const [id, label] of [[1, 'the archived copy'], [2, 'the rebuild (no archive)']]) {
      const h = boot({ server: histServer() });
      await h.render();
      h.click(h.act('customer'));
      h.change(h.$('[data-bind="cust-job"]'), 'p1');
      await tick(6);
      h.srv.next.push({ status: 401, body: { error: 'Unauthorized' },
        match: e => e.path === '/api/custom-reports' && (id === 1 ? !!e.q.archive : e.q.run === String(id)) });
      const before = h.opened.length;
      h.click(h.$(`[data-act="cust-open"][data-id="${id}"]`));
      await tick(8);
      assert(`Open with an expired session (${label}): the placeholder window is closed, not orphaned, with no toast`,
        h.opened.length === before + 1 && h.opened[before].closed === true && h.authErrors === 1
          && !h.document.querySelector('.cr-toast.err'),
        JSON.stringify({ opened: h.opened.length - before, closed: h.opened[before] && h.opened[before].closed, auth: h.authErrors, toast: h.toast() }));
      h.close();
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('v2 · Schedules — Schedule… dialog, the rail list, Send now');
  {
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com', 'b@acme.com'] }, { id: 42, name: '<b>Office</b>', emails: ['o@fc.example'] }] }));
    srv.add({ id: 20, name: 'Fixed dates report', definition: { v: 2, dates: { preset: 'custom', from: '2026-10-01', to: '2026-10-31' },
      jobs: { mode: 'saved', ids: ['p1'] }, sections: [{ type: 'job_info' }] } });
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.reports.find(r => r.id === 2).definition.dates = { preset: 'last_week' };
    srv.seq = 100;
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    assert('admin / level 3: the rail has a Schedules section', /Schedules/.test(h.$('.cr-rail').textContent)
      && h.srv.callsTo('/api/custom-report-schedules', 'GET').length === 1 && h.srv.callsTo('/api/custom-report-schedules')[0].q.division === 'paving');
    h.click(h.act('new'));
    assert('Schedule… is off on an unsaved report, saying why', h.act('schedule').disabled && /Save the report first/.test(h.act('schedule').title));
    h.click(h.$('[data-act="open"][data-id="3"]'));
    assert('…and on an internal report', h.act('schedule').disabled && /customer-safe/.test(h.act('schedule').title));
    h.click(h.$('[data-act="open"][data-id="20"]'));
    h.click(h.act('schedule'));
    await tick(4);
    assert('a report with fixed (custom) dates is refused with the reason', /relative date range like Last week/.test((h.modal() || {}).textContent || '')
      && h.srv.callsTo('/api/custom-report-schedules', 'POST').length === 0);
    h.modal().querySelector('[data-choice]').click();
    h.click(h.$('[data-act="open"][data-id="1"]'));
    assert('a saved, customer-safe report can be scheduled', !h.act('schedule').disabled);
    h.click(h.act('schedule'));
    await tick(6);
    let m = h.modal();
    assert('Schedule… opens the dialog', m && /Schedule this report/.test(m.textContent));
    assert('…every field is there: frequency, 5-minute times, time zone, jobs, recipients, subject, note, PDF, on',
      !!m.querySelector('#cr-s-freq') && m.querySelectorAll('#cr-s-time option').length === 288 && !!m.querySelector('#cr-s-tz')
        && !!m.querySelector('#cr-s-contacts') && m.querySelectorAll('[data-group]').length === 2 && !!m.querySelector('#cr-s-email')
        && !!m.querySelector('#cr-s-subject') && !!m.querySelector('#cr-s-note') && !!m.querySelector('#cr-s-pdf') && !!m.querySelector('#cr-s-enabled'));
    assert('…time zones Eastern / Central / Mountain / Pacific and Other', [...m.querySelectorAll('#cr-s-tz option')].map(o => o.textContent).join() === 'Eastern,Central,Mountain,Pacific,Other…');
    assert('…a saved-jobs report sends its saved jobs (no job choice)', /The report’s saved jobs/.test(m.textContent) && !m.querySelector('input[name="cr-s-mode"]'));
    assert('…group names are text', /<b>Office<\/b>/.test(m.textContent) && !m.querySelector('[data-group] + b'));
    const ch = (sel, v) => { const el = m.querySelector(sel); el.value = v; el.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
    ch('#cr-s-freq', 'monthly');
    assert('Monthly shows the day of the month, with "Last day"', !m.querySelector('#cr-s-dom-row').hidden && m.querySelector('#cr-s-days').hidden
      && /Last day/.test(m.querySelector('#cr-s-dom').textContent));
    ch('#cr-s-freq', 'weekly');
    assert('Weekly shows the day checkboxes', !m.querySelector('#cr-s-days').hidden && m.querySelector('#cr-s-dom-row').hidden);
    m.querySelector('[data-dow="1"]').checked = false;
    m.querySelector('#cr-s-contacts').checked = false;
    m.querySelector('[data-s="save"]').click();
    await tick(4);
    assert('no day and no recipient: said before any request', /at least one day/.test(m.querySelector('.cr-m-errs').textContent)
      && /someone to send it to/.test(m.querySelector('.cr-m-errs').textContent) && h.srv.callsTo('/api/custom-report-schedules', 'POST').length === 0);
    m.querySelector('[data-dow="1"]').checked = true;
    m.querySelector('[data-dow="3"]').checked = true;
    ch('#cr-s-time', '06:30');
    ch('#cr-s-tz', 'America/Chicago');
    m.querySelector('[data-group="41"]').checked = true;
    m.querySelector('#cr-s-email').value = 'PM@Acme.com, not-valid';
    m.querySelector('[data-s="add-email"]').click();
    assert('typed addresses become chips; a bad one stays, named', /pm@acme\.com/.test(m.querySelector('#cr-s-chips').textContent)
      && m.querySelector('#cr-s-email').value === 'not-valid' && /Not an email address: not-valid/.test(m.querySelector('.cr-m-errs').textContent));
    m.querySelector('#cr-s-email').value = '';
    m.querySelector('#cr-s-subject').value = 'Weekly progress';
    m.querySelector('#cr-s-note').value = 'Have a good week.';
    m.querySelector('#cr-s-pdf').checked = false;
    srv.rejectNext = 'Pick a time on a five-minute mark — the server checks every five minutes.';
    m.querySelector('[data-s="save"]').click();
    await tick(6);
    assert('the server\'s validation message is shown in the dialog, which stays open', !!h.modal()
      && /five-minute mark/.test(m.querySelector('.cr-m-errs').textContent) && !m.querySelector('[data-s="save"]').disabled);
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    const post = h.srv.callsTo('/api/custom-report-schedules', 'POST').pop();
    const b = post && post.body;
    assert('Create POSTs the schedule for the saved report', b && b.custom_report_id === 1 && b.jobs_mode === 'saved' && b.frequency === 'weekly'
      && JSON.stringify(b.days_of_week) === '[1,3]' && b.day_of_month === null && b.send_time === '06:30' && b.timezone === 'America/Chicago'
      && JSON.stringify(b.group_ids) === '[41]' && JSON.stringify(b.emails) === '["pm@acme.com"]' && b.use_job_contacts === false
      && b.subject === 'Weekly progress' && b.note === 'Have a good week.' && b.attach_pdf === false && b.enabled === true && b.picked_jobs === null
      && post.q.division === 'paving', JSON.stringify(b));
    assert('…closes, and the rail lists it: report, cadence, next send', !h.modal() && /Acme weekly update/.test(h.$('.cr-rail').textContent)
      && /Weekly Mon, Wed at 6:30 AM Central/.test(h.$('.cr-rail').textContent) && /Next /.test(h.$('.cr-rail').textContent), h.$('.cr-rail').textContent.slice(-300));
    const sid = srv.schedules[0].id;
    // A template: once per job, the picked jobs, or one report of all In Progress jobs.
    h.click(h.$('[data-act="open"][data-id="2"]'));
    h.click(h.act('schedule'));
    await tick(6);
    m = h.modal();
    const modes = [...m.querySelectorAll('input[name="cr-s-mode"]')].map(r => r.value);
    assert('a template offers: each In Progress job, picked jobs, all In Progress jobs as one report', modes.join() === 'each,picked,all_in_progress'
      && /one email per job/.test(m.textContent) && /one report/.test(m.textContent));
    const mode = v => { const r = m.querySelector(`input[name="cr-s-mode"][value="${v}"]`); r.checked = true; r.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
    mode('picked');
    assert('"Picked jobs" shows the job picker', !m.querySelector('#cr-s-pick').hidden && m.querySelectorAll('[data-job]').length === 3);
    m.querySelector('[data-job="p2"]').checked = true;
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    const tb = h.srv.callsTo('/api/custom-report-schedules', 'POST').pop().body;
    assert('…which sends jobs_mode each with picked_jobs [{id, name}] (job contacts on by default)', tb.custom_report_id === 2 && tb.jobs_mode === 'each'
      && JSON.stringify(tb.picked_jobs) === '[{"id":"p2","name":"Elm Street Lot"}]' && tb.use_job_contacts === true, JSON.stringify(tb));
    h.click(h.act('schedule'));
    await tick(6);
    m = h.modal();
    mode('all_in_progress');
    m.querySelector('#cr-s-email').value = 'office@forcecorp.example';
    m.querySelector('[data-s="add-email"]').click();
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    const aip = h.srv.callsTo('/api/custom-report-schedules', 'POST').pop().body;
    assert('"All In Progress jobs — one report" sends jobs_mode all_in_progress', aip.jobs_mode === 'all_in_progress');
    assert('…without job contacts (one report of every customer\'s jobs never goes to each job\'s contacts)', aip.use_job_contacts === false, JSON.stringify(aip));
    h.click(h.act('schedule'));
    await tick(6);
    m = h.modal();
    const box = () => m.querySelector('#cr-s-contacts'), why = () => m.querySelector('#cr-s-contacts-why');
    assert('the dialog opens with job contacts on for "each job"', box().checked && !box().disabled && why().hidden);
    mode('all_in_progress');
    assert('choosing "All In Progress jobs — one report" takes the contacts tick away, and says why',
      !box().checked && box().disabled && !why().hidden && /each customer would be sent the others/.test(why().textContent));
    mode('each');
    assert('…back to one email per job, the box can be ticked again', !box().disabled && why().hidden);
    // A mistyped address left in the box stops the save — it is not dropped.
    const posts = () => h.srv.callsTo('/api/custom-report-schedules', 'POST').length;
    let nPosts = posts();
    m.querySelector('#cr-s-email').value = 'pm@forcecorp.example';
    m.querySelector('[data-s="add-email"]').click();
    m.querySelector('#cr-s-email').value = 'owner@acme';
    const toastBefore = h.toast();
    m.querySelector('[data-s="save"]').click();
    await tick(6);
    assert('Save with a mistyped address still in the box: nothing is sent, the dialog stays, the address is still there with its message',
      posts() === nPosts && !!h.modal() && m.querySelector('#cr-s-email').value === 'owner@acme'
        && /Not an email address: owner@acme/.test(m.querySelector('.cr-m-errs').textContent) && h.toast() === toastBefore,
      `${posts() - nPosts} posts; box "${m.querySelector('#cr-s-email').value}"; errs "${m.querySelector('.cr-m-errs').textContent}"`);
    m.querySelector('#cr-s-email').value = 'owner@acme.com';
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    const fixed = h.srv.callsTo('/api/custom-report-schedules', 'POST').pop();
    assert('…corrected, Save sends both addresses', posts() === nPosts + 1 && !h.modal()
      && JSON.stringify(fixed.body.emails) === '["pm@forcecorp.example","owner@acme.com"]', JSON.stringify(fixed && fixed.body.emails));
    // The 51st address the same way.
    h.click(h.act('schedule'));
    await tick(6);
    m = h.modal();
    nPosts = posts();
    m.querySelector('#cr-s-email').value = Array.from({ length: 50 }, (_, i) => `r${i}@acme.com`).join(', ');
    m.querySelector('[data-s="add-email"]').click();
    m.querySelector('#cr-s-email').value = 'one-more@acme.com';
    m.querySelector('[data-s="save"]').click();
    await tick(6);
    assert('…and a 51st address left in the box stops the save too, saying the limit',
      m.querySelectorAll('#cr-s-chips .cr-chip').length === 50 && posts() === nPosts && !!h.modal()
        && m.querySelector('#cr-s-email').value === 'one-more@acme.com' && /Up to 50 addresses/.test(m.querySelector('.cr-m-errs').textContent),
      `${posts() - nPosts} posts; errs "${m.querySelector('.cr-m-errs').textContent}"`);
    m.querySelector('[data-s="cancel"]').click();
    await tick(2);
    // Rail actions.
    const more = () => h.$(`[data-act="sched-menu"][data-id="${sid}"]`);
    h.click(more());
    const items = [...h.document.querySelectorAll('.cr-menu [role="menuitem"]')].map(i => i.getAttribute('data-act'));
    assert('each schedule has Pause, Edit…, Send now and Delete', items.join() === 'sched-toggle,sched-edit,sched-send,sched-delete');
    h.click(h.document.querySelector('.cr-menu [data-act="sched-toggle"]'));
    await tick(8);
    let put = h.srv.callsTo('/api/custom-report-schedules', 'PUT').pop();
    assert('Pause PUTs { enabled: false } alone — a switch, not a save that would re-check it and run it as whoever paused it',
      put && put.q.id === String(sid) && JSON.stringify(put.body) === '{"enabled":false}', put && JSON.stringify(put.body));
    assert('…and the rail says Paused', /Paused/.test(h.$('.cr-rail').textContent));
    h.click(more());
    h.click(h.document.querySelector('.cr-menu [data-act="sched-toggle"]'));
    await tick(8);
    assert('Resume PUTs { enabled: true } alone', JSON.stringify(h.srv.callsTo('/api/custom-report-schedules', 'PUT').pop().body) === '{"enabled":true}');
    h.click(more());
    h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]'));
    await tick(6);
    m = h.modal();
    assert('Edit… opens the dialog filled in from the schedule', m && /Edit schedule/.test(m.textContent) && m.querySelector('#cr-s-freq').value === 'weekly'
      && m.querySelector('[data-dow="3"]').checked && m.querySelector('#cr-s-time').value === '06:30' && m.querySelector('#cr-s-tz').value === 'America/Chicago'
      && m.querySelector('[data-group="41"]').checked && /pm@acme\.com/.test(m.querySelector('#cr-s-chips').textContent));
    m.querySelector('#cr-s-subject').value = 'New subject';
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    put = h.srv.callsTo('/api/custom-report-schedules', 'PUT').pop();
    assert('…and Save PUTs it', put.q.id === String(sid) && put.body.subject === 'New subject' && !h.modal());
    let release;
    srv.sendNowGate = new Promise(r => { release = r; });
    h.answers.push(false);
    h.click(more());
    h.click(h.document.querySelector('.cr-menu [data-act="sched-send"]'));
    assert('Send now asks first; "no" sends nothing', /Send “Acme weekly update” to its recipients now/.test(h.confirms.pop() || '')
      && h.srv.callsTo('/api/custom-report-schedules', 'POST', e => e.q.action === 'run').length === 0);
    h.click(more());
    h.click(h.document.querySelector('.cr-menu [data-act="sched-send"]'));
    await tick(4);
    assert('"yes" POSTs ?id=&action=run and shows a spinner while it works', h.srv.callsTo('/api/custom-report-schedules', 'POST', e => e.q.action === 'run' && e.q.id === String(sid)).length === 1
      && /Sending…/.test(h.$('.cr-rail').textContent) && !!h.$('.cr-rail .cr-spin'));
    release();
    await tick(8);
    assert('…then says what happened', /Sent 2 emails/.test(h.toast()) && !h.$('.cr-rail .cr-spin'), h.toast());
    // Turning internal data on for a scheduled report says the sends will stop.
    h.click(h.$('[data-act="open"][data-id="1"]'));
    h.click(h.$('#cr-step-2'));
    h.answers.push(false);
    h.$('[data-bind="internal"]').click();
    assert('switching internal data on for a scheduled report warns the scheduled sends stop', /This report is scheduled — scheduled sends will stop until it is customer-safe again\./.test(h.confirms.pop() || ''));
    h.answers.push(false);
    h.click(more());
    h.click(h.document.querySelector('.cr-menu [data-act="sched-delete"]'));
    assert('Delete asks first', /Delete the schedule/.test(h.confirms.pop() || '') && h.srv.callsTo('/api/custom-report-schedules', 'DELETE').length === 0);
    h.click(more());
    h.click(h.document.querySelector('.cr-menu [data-act="sched-delete"]'));
    await tick(8);
    assert('…then DELETEs it', h.srv.callsTo('/api/custom-report-schedules', 'DELETE').pop().q.id === String(sid) && !h.$(`[data-act="sched-menu"][data-id="${sid}"]`));
    h.click(h.$('[data-act="item-menu"][data-id="2"]'));
    assert('the report ⋯ menu has Schedule… too', !!h.document.querySelector('.cr-menu [data-act="menu-schedule"]'));
    h.close();
  }
  {
    // Recipient groups: asked afresh at every Schedule…, and an edit never
    // drops a group the dialog was not offered. Job contacts: the person's
    // tick comes back when the reason it was taken away goes. A schedule
    // whose report was deleted says so.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com', 'b@acme.com'] },
      { id: 99, name: 'Turf bid owners', emails: ['t@turf.example'], report_type: 'turf_bid_items' }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.reports.find(r => r.id === 2).definition.dates = { preset: 'last_week' };
    const schedRow = (over) => Object.assign({ custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: 'Old subject', note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true }, over);
    // Sends to group 99 too — another report type's group, attached through the API: offered only because it sends to it.
    srv.schedules.push(schedRow({ id: 950, group_ids: [41, 99] }));
    // Its report deleted since (in Recently Deleted).
    srv.schedules.push(schedRow({ id: 951, custom_report_id: 777, report_name: 'Gone weekly', report_visible: false, report_deleted: true }));
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    h.click(h.$('[data-act="open"][data-id="1"]'));
    h.click(h.act('schedule'));
    await tick(6);
    let m = h.modal();
    assert('the dialog offers the saved group', m && !!m.querySelector('[data-group="41"]') && !m.querySelector('[data-group="43"]'));
    m.querySelector('[data-s="cancel"]').click();
    await tick(2);
    // Saved from the email window meanwhile ("Save as group").
    srv.groups.push({ id: 43, name: 'Maple owners', emails: ['o@maple.example'] });
    h.click(h.act('schedule'));
    await tick(6);
    m = h.modal();
    assert('a group saved since the dialog was last open is offered the next time, no reload', m && !!m.querySelector('[data-group="43"]'),
      m && [...m.querySelectorAll('[data-group]')].map(b => b.getAttribute('data-group')).join());
    m.querySelector('[data-s="cancel"]').click();
    await tick(2);
    h.click(h.$('[data-act="sched-menu"][data-id="950"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]'));
    await tick(6);
    m = h.modal();
    const g99 = m && m.querySelector('[data-group="99"]');
    assert('Edit… shows every group the schedule sends to, ticked — one neither list offers too', m && m.querySelector('[data-group="41"]').checked
      && !!g99 && g99.checked, m && [...m.querySelectorAll('[data-group]')].map(b => b.getAttribute('data-group') + ':' + b.checked).join());
    m.querySelector('#cr-s-subject').value = 'New subject';
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    const put = h.srv.callsTo('/api/custom-report-schedules', 'PUT').pop();
    assert('…and saving it with only the subject changed keeps that group', put && put.q.id === '950' && put.body.subject === 'New subject'
      && JSON.stringify(put.body.group_ids.map(Number).sort((a, b) => a - b)) === '[41,99]', put && JSON.stringify(put.body.group_ids));

    // Job contacts on a template: the tick taken away for "All In Progress
    // jobs — one report" comes back with one email per job.
    h.click(h.$('[data-act="open"][data-id="2"]'));
    h.click(h.act('schedule'));
    await tick(6);
    m = h.modal();
    const box = () => m.querySelector('#cr-s-contacts');
    const mode = v => { const r = m.querySelector(`input[name="cr-s-mode"][value="${v}"]`); r.checked = true; r.dispatchEvent(new h.window.Event('change', { bubbles: true })); };
    const startTicked = box().checked;
    mode('all_in_progress');
    const offThere = !box().checked && box().disabled;
    mode('each');
    const backEach = box().checked;
    mode('all_in_progress');
    mode('picked');
    assert('switching to "All In Progress jobs" and back: "Send to each job’s saved contacts" is ticked again, as it was (each and picked)',
      startTicked && offThere && backEach && box().checked && !box().disabled, JSON.stringify({ startTicked, offThere, backEach, picked: box().checked }));
    box().checked = false;
    box().dispatchEvent(new h.window.Event('change', { bubbles: true }));
    mode('all_in_progress');
    mode('each');
    assert('…and one the person unticked stays unticked', !box().checked && !box().disabled);
    m.querySelector('[data-s="cancel"]').click();
    await tick(2);

    // The schedule whose report was deleted.
    const goneItem = h.$('[data-act="sched-menu"][data-id="951"]').closest('.cr-item');
    assert('the rail says a schedule\'s report was deleted, and what to do', /deleted/i.test(goneItem.textContent) && /Recently Deleted/.test(goneItem.textContent),
      goneItem.textContent.replace(/\s+/g, ' '));
    h.click(h.$('[data-act="sched-menu"][data-id="951"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]'));
    await tick(4);
    assert('…and its Edit… says the report was deleted, not that it isn\'t shared', /Recently Deleted/.test(h.toast()) && !/isn’t shared/.test(h.toast()), h.toast());
    // Deleting a report a schedule sends: the question says the schedule stops, and the rail is asked again.
    const schedGets = h.srv.callsTo('/api/custom-report-schedules', 'GET').length;
    h.click(h.$('[data-act="item-menu"][data-id="1"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-delete"]'));
    await tick(8);
    assert('deleting a scheduled report says its schedule will stop sending', /schedule/i.test(h.confirms[h.confirms.length - 1] || ''),
      h.confirms[h.confirms.length - 1]);
    assert('…and the schedules are asked for again after the delete', h.srv.callsTo('/api/custom-report-schedules', 'GET').length > schedGets);
    h.close();
  }
  {
    // A recipient group deleted since: one the schedule sends to (99, gone
    // before the page loaded) and one the schedules list still names (42,
    // deleted from the email window since). Edit… offers neither, ticks
    // neither, says one was taken off, and Save sends the groups that exist.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }, { id: 42, name: 'Owner Reps', emails: ['r@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 960, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41, 99], emails: [],
      use_job_contacts: false, subject: 'Weekly', note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    srv.groups = srv.groups.filter(g => g.id !== 42);
    h.click(h.$('[data-act="sched-menu"][data-id="960"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]'));
    await tick(6);
    const m = h.modal();
    const boxes = m ? [...m.querySelectorAll('[data-group]')].map(b => b.getAttribute('data-group') + ':' + b.checked) : [];
    assert('Edit… on a schedule naming deleted groups: only the group that exists is offered, ticked — no "Group #99", no "Owner Reps"',
      m && boxes.join() === '41:true' && !/Owner Reps|Group #99/.test(m.textContent), boxes.join());
    assert('…and it says a deleted group was taken off the schedule', m && /deleted/i.test(m.querySelector('#cr-s-gone') ? m.querySelector('#cr-s-gone').textContent : ''),
      m && m.textContent.replace(/\s+/g, ' ').slice(0, 400));
    m.querySelector('#cr-s-time').value = '08:00';
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    const put = h.srv.callsTo('/api/custom-report-schedules', 'PUT').pop();
    assert('…Save PUTs the groups that exist ([41]) and the dialog closes', put && put.q.id === '960' && JSON.stringify(put.body.group_ids) === '[41]' && !h.modal(),
      put && JSON.stringify(put.body.group_ids));
    // The groups list cannot be had: the schedules list's groups stand in,
    // and a group the schedule names that neither shows is kept, not dropped.
    srv.groupsFail = true;
    srv.schedules.find(x => x.id === 960).group_ids = [41, 77];
    h.S().scheds.find(x => x.id === 960).group_ids = [41, 77];   // the list already says so: the page holds a copy
    h.click(h.$('[data-act="sched-menu"][data-id="960"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]'));
    await tick(6);
    const m2 = h.modal();
    const b2 = m2 ? [...m2.querySelectorAll('[data-group]')].map(b => b.getAttribute('data-group') + ':' + b.checked) : [];
    assert('…with the groups list unavailable, Edit… keeps every group the schedule sends to (the server drops any deleted)',
      m2 && b2.includes('41:true') && b2.includes('77:true'), b2.join());
    if (m2) m2.querySelector('[data-s="cancel"]').click();
    await tick(2);
    h.close();
  }
  {
    // A slow groups list: the dialog opens at the click, naming its report,
    // with the groups loading into it — not after a wait with nothing on
    // screen, during which a second Edit… would open the first schedule.
    // Saved before they arrive, it keeps the groups the schedule sends to.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }, { id: 44, name: 'Bravo owners', emails: ['b@b.example'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.reports.find(r => r.id === 2).definition.dates = { preset: 'last_week' };
    const sched = (id, rid, name, groupIds, mode) => ({ id, custom_report_id: rid, report_name: name, jobs_mode: mode, picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: groupIds, emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    srv.schedules.push(sched(970, 1, 'Acme weekly update', [41], 'saved'), sched(971, 2, 'Bravo template', [44], 'each'));
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const releases = [];
    srv.groupsGate = () => new Promise(res => releases.push(res));
    const edit = id => { h.click(h.$(`[data-act="sched-menu"][data-id="${id}"]`)); h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]')); };
    const nameOf = id => srv.reports.find(r => r.id === id).name;
    edit(970);
    await tick(3);
    const modals = () => h.document.querySelectorAll('.cr-modal');
    let m = h.modal();
    assert('Edit… with the groups list slow to answer: the dialog is up at once, naming its report, saying the groups are loading',
      modals().length === 1 && m.textContent.includes(nameOf(1)) && /Loading recipient groups/.test(m.textContent) && !m.querySelector('[data-group]'),
      m ? m.textContent.replace(/\s+/g, ' ').slice(0, 300) : 'no dialog');
    edit(971);
    await tick(3);
    releases.splice(0).forEach(f => f());
    await tick(6);
    m = h.modal();
    const ticked = m ? [...m.querySelectorAll('[data-group]')].map(b => b.getAttribute('data-group') + ':' + b.checked).join() : '';
    assert('…one dialog, still the one the click opened; the groups fill in when they come, its own ticked',
      modals().length === 1 && m.textContent.includes(nameOf(1)) && !m.textContent.includes(nameOf(2)) && !/Loading recipient groups/.test(m.textContent)
        && ticked === '41:true,44:false', ticked);
    // A group ticked here, deleted before Save: the refusal names it.
    m.querySelector('[data-group="44"]').checked = true;
    srv.next.push({ match: e => e.path === '/api/custom-report-schedules' && e.method === 'PUT', status: 400,
      body: { error: 'groups', message: 'One of those recipient groups no longer exists.', missing: [44] } });
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    assert('…a group deleted after it was ticked: Save says which one, by name, and the dialog stays open',
      h.modal() && /“Bravo owners” was deleted — untick it/.test(m.querySelector('.cr-m-errs').textContent), m.querySelector('.cr-m-errs').textContent);
    m.querySelector('[data-s="cancel"]').click();
    await tick(2);
    // Saved while still loading: the schedule's own groups go back unchanged.
    edit(970);
    await tick(3);
    m = h.modal();
    m.querySelector('#cr-s-subject').value = 'Saved early';
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    const put = h.srv.callsTo('/api/custom-report-schedules', 'PUT').pop();
    assert('…and saved before the groups arrive, it keeps the groups the schedule sends to',
      put && put.q.id === '970' && put.body.subject === 'Saved early' && JSON.stringify(put.body.group_ids) === '[41]', put && JSON.stringify(put.body));
    releases.splice(0).forEach(f => f());
    srv.groupsGate = null;
    await tick(4);
    assert('…and the late answer does not reopen anything', modals().length === 0);
    h.close();
  }
  {
    // A scheduled report saved with internal data switched on, then off: the
    // rail's line about whether its schedule will send follows each save.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 980, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const line = () => { const b = h.$('[data-act="sched-menu"][data-id="980"]'); return b ? b.closest('.cr-item').textContent.replace(/\s+/g, ' ') : ''; };
    const gets = () => h.srv.callsTo('/api/custom-report-schedules', 'GET').length;
    assert('a customer-safe scheduled report: its schedule has no "won’t send" line', !/won’t send/.test(line()), line());
    h.click(h.$('[data-act="open"][data-id="1"]'));
    h.click(h.$('#cr-step-2'));
    h.$('[data-bind="internal"]').click();
    h.confirms.splice(0);
    const before = gets();
    h.click(h.act('save'));
    await tick(10);
    assert('saved with internal data on: the schedules are asked for again and the rail says it won’t send',
      srv.find(1).customer_safe === false && gets() > before && /won’t send until it’s customer-safe again/.test(line()), `${gets()} ${line()}`);
    h.click(h.act('internal-off'));
    const before2 = gets();
    h.click(h.act('save'));
    await tick(10);
    assert('…saved customer-safe again: the line goes', srv.find(1).customer_safe === true && gets() > before2 && !/won’t send/.test(line()), line());
    h.close();
  }
  {
    // A schedules refresh already in flight must not swallow the refresh a
    // later save asks for, and its older answer must not overwrite
    // upsertReport's correct local copy: saving internal-on then internal-off
    // while the first GET is held must still leave the rail customer-safe.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 980, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const line = () => { const b = h.$('[data-act="sched-menu"][data-id="980"]'); return b ? b.closest('.cr-item').textContent.replace(/\s+/g, ' ') : ''; };
    const gets = () => h.srv.callsTo('/api/custom-report-schedules', 'GET').length;
    const releases = [];
    h.click(h.$('[data-act="open"][data-id="1"]'));
    h.click(h.$('#cr-step-2'));
    // Save #1: internal on, and hold the schedules GET it triggers — it
    // snapshots customer_safe:false now and answers later.
    srv.schedsLateGate = () => new Promise(r => releases.push(r));
    h.$('[data-bind="internal"]').click();
    h.confirms.splice(0);
    h.click(h.act('save'));
    await tick(10);
    assert('internal-on save: the schedules GET it asked for is in flight (held), one request out', releases.length === 1, `releases=${releases.length}`);
    // Save #2: internal off, while GET #1 is still held. No new GET yet.
    srv.schedsLateGate = null;
    h.click(h.act('internal-off'));
    h.click(h.act('save'));
    await tick(10);
    assert('internal-off save while the first GET is held: still only the one held request, report customer-safe again',
      releases.length === 1 && srv.find(1).customer_safe === true, `releases=${releases.length}`);
    const g0 = gets();
    // Release the held (stale) answer: it must be discarded and a fresh
    // refresh must run, so the rail is not left reading "won’t send".
    releases.splice(0).forEach(f => f());
    await tick(12);
    assert('the stale answer is dropped, a fresh refresh runs, and the rail stays customer-safe (no "won’t send")',
      gets() > g0 && srv.find(1).customer_safe === true && !/won’t send/.test(line()), `${gets()} vs ${g0} · ${line()}`);
    h.close();
  }
  {
    // Round 5: the rail and Edit… follow what a Pause or a Save just did,
    // from the PUT's own answer, without waiting for the list to come back —
    // so an Edit… opened meanwhile cannot save the old settings back over it.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 985, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41],
      emails: ['keep@acme.com', 'drop@acme.com'], use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true,
      next_run_at: '2026-11-09T12:00:00Z', last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat',
      created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z', report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const releases = [];
    const hold = () => { srv.schedsLateGate = () => new Promise(r => releases.push(r)); };
    const letGo = async () => { srv.schedsLateGate = null; releases.splice(0).forEach(f => f()); await tick(12); };
    const more = () => h.$('[data-act="sched-menu"][data-id="985"]');
    const line = () => (more() ? more().closest('.cr-item').textContent.replace(/\s+/g, ' ') : '');
    const menu = act => { h.click(more()); h.click(h.document.querySelector(`.cr-menu [data-act="${act}"]`)); };
    hold();
    menu('sched-toggle');
    await tick(8);
    assert('Pause with the list refresh still out: the rail already says Paused (from the PUT\'s answer)',
      releases.length === 1 && /Paused/.test(line()) && !/ On /.test(' ' + line() + ' '), line());
    menu('sched-edit');
    await tick(6);
    let m = h.modal();
    assert('…and Edit… opened before the refresh lands shows it switched off, so Save keeps it paused',
      m && m.querySelector('#cr-s-enabled').checked === false, m && String(m.querySelector('#cr-s-enabled').checked));
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    assert('…Save PUTs enabled:false', srv.schedules[0].enabled === false
      && h.srv.callsTo('/api/custom-report-schedules', 'PUT').pop().body.enabled === false);
    await letGo();
    // Edit… → take an address off → Save, with the refresh held: Edit… again
    // must not bring it back.
    hold();
    menu('sched-edit');
    await tick(6);
    m = h.modal();
    const chipIdx = [...m.querySelectorAll('#cr-s-chips [data-s="rm-email"]')].findIndex(b => /drop@acme\.com/.test(b.closest('.cr-chip').textContent));
    m.querySelectorAll('#cr-s-chips [data-s="rm-email"]')[chipIdx].click();
    m.querySelector('[data-s="save"]').click();
    await tick(8);
    assert('an address taken off and saved: gone on the server', JSON.stringify(srv.schedules[0].emails) === '["keep@acme.com"]', JSON.stringify(srv.schedules[0].emails));
    menu('sched-edit');
    await tick(6);
    m = h.modal();
    assert('…and Edit… again before the refresh lands does not bring it back', m && !/drop@acme\.com/.test(m.querySelector('#cr-s-chips').textContent)
      && /keep@acme\.com/.test(m.querySelector('#cr-s-chips').textContent), m && m.querySelector('#cr-s-chips').textContent);
    m.querySelector('[data-s="cancel"]').click();
    await letGo();
    // While a Pause is out, the row's ⋯ is off: nothing can be opened from the old copy.
    let putRelease;
    const putGate = new Promise(r => { putRelease = r; });
    const realHandle = srv.handle;
    srv.handle = async (url, init) => { if (init && init.method === 'PUT' && /custom-report-schedules/.test(url)) await putGate; return realHandle(url, init); };
    menu('sched-toggle');
    await tick(4);
    assert('while a Resume is out, the schedule\'s ⋯ is off', more() && more().disabled === true);
    putRelease();
    await tick(10);
    srv.handle = realHandle;
    assert('…and on again once it has landed, reading On', more() && more().disabled === false && /On/.test(line()), line());
    h.close();
  }
  {
    // Round 5: a schedule blocked for a reason other than deleted / internal
    // (fixed dates, saved jobs vs once per job) says so on the rail; and
    // saving a scheduled report into one of those asks first.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.reports.find(r => r.id === 2).definition.dates = { preset: 'last_week' };
    const base = { jobs_mode: 'saved', picked_jobs: null, frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00',
      timezone: 'America/New_York', group_ids: [41], emails: [], use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true,
      next_run_at: '2026-11-09T12:00:00Z', last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat',
      created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z', report_visible: true, report_deleted: false, report_customer_safe: true };
    srv.schedules.push(Object.assign({}, base, { id: 986, custom_report_id: 1, report_name: 'Acme weekly update',
      report_blocked: '“Acme weekly update” is set to fixed dates now, so every email would show the same days. Give it a relative date range like Last week and save it.' }));
    srv.schedules.push(Object.assign({}, base, { id: 987, custom_report_id: 2, report_name: 'Owner template', jobs_mode: 'each', report_blocked: null }));
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const line = id => { const b = h.$(`[data-act="sched-menu"][data-id="${id}"]`); return b ? b.closest('.cr-item').textContent.replace(/\s+/g, ' ') : ''; };
    assert('the rail shows the server\'s report_blocked line for a schedule that will not send', /set to fixed dates now/.test(line(986)), line(986));
    assert('…and none for one that will', !/fixed dates|saves its own jobs|won’t send/.test(line(987)), line(987));
    // Report 2 (a template, scheduled once per job): saved with its jobs kept.
    h.click(h.$('[data-act="open"][data-id="2"]'));
    h.$$('.cr-job input')[0].click();
    h.$('[data-bind="save-jobs"]').click();
    const puts0 = h.srv.calls('PUT').length;
    h.answers.push(false);
    h.click(h.act('save'));
    await tick(8);
    const asked = h.confirms.pop() || '';
    assert('saving a template scheduled once per job with its jobs kept asks first, saying the scheduled sends stop; "no" saves nothing',
      /This report is scheduled/.test(asked) && /once per job/.test(asked) && h.srv.calls('PUT').length === puts0, asked);
    h.$('[data-bind="save-jobs"]').click();
    // Fixed dates on a scheduled report.
    h.change(h.$('[data-bind="preset"]'), 'custom');
    h.answers.push(false);
    h.click(h.act('save'));
    await tick(8);
    const asked2 = h.confirms.pop() || '';
    assert('…and saving it with fixed dates asks first too', /This report is scheduled/.test(asked2) && /fixed dates/.test(asked2)
      && h.srv.calls('PUT').length === puts0, asked2);
    // Round 6: both in one save — its jobs kept and fixed dates — names both,
    // and does not promise the sends come back with relative dates alone.
    h.$('[data-bind="save-jobs"]').click();
    h.answers.push(false);
    h.click(h.act('save'));
    await tick(8);
    const asked3 = h.confirms.pop() || '';
    assert('…and saving it with its jobs kept AND fixed dates names both stops in one ask ("no" saves nothing)',
      /fixed dates/.test(asked3) && /once per job/.test(asked3) && /schedule is opened and saved again/.test(asked3)
        && !/until it has a relative date range like Last week again\. Save anyway/.test(asked3) && h.srv.calls('PUT').length === puts0, asked3);
    h.close();
  }
  {
    // Round 5: while one schedule is sending, Send now on another is not a
    // silent no-op — it asks and sends that one too, and each result names
    // its report.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.reports.find(r => r.id === 2).definition.dates = { preset: 'last_week' };
    const base = { jobs_mode: 'saved', picked_jobs: null, frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00',
      timezone: 'America/New_York', group_ids: [41], emails: [], use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true,
      next_run_at: '2026-11-09T12:00:00Z', last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat',
      created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z', report_visible: true, report_deleted: false, report_customer_safe: true };
    srv.schedules.push(Object.assign({}, base, { id: 988, custom_report_id: 1, report_name: 'Acme weekly update' }));
    srv.schedules.push(Object.assign({}, base, { id: 989, custom_report_id: 2, report_name: 'Division progress template', jobs_mode: 'each' }));
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    let release;
    srv.sendNowGate = new Promise(r => { release = r; });
    const send = id => { h.click(h.$(`[data-act="sched-menu"][data-id="${id}"]`)); h.click(h.document.querySelector('.cr-menu [data-act="sched-send"]')); };
    const runs = () => h.srv.callsTo('/api/custom-report-schedules', 'POST', e => e.q.action === 'run').map(e => e.q.id);
    h.confirms.splice(0);
    send(988);
    await tick(4);
    assert('Send now on A: asked, sending', h.confirms.length === 1 && JSON.stringify(runs()) === '["988"]');
    assert('…B\'s ⋯ stays on while A sends', h.$('[data-act="sched-menu"][data-id="989"]').disabled === false
      && h.$('[data-act="sched-menu"][data-id="988"]').disabled === true);
    send(989);
    await tick(4);
    assert('Send now on B meanwhile: asked and sent too — not silently dropped', h.confirms.length === 2 && /Division progress template/.test(h.confirms[1])
      && JSON.stringify(runs()) === '["988","989"]', `${h.confirms.length} confirms; runs ${JSON.stringify(runs())}`);
    const toasts = [];
    const seen = new h.window.MutationObserver(recs => recs.forEach(r => [...r.addedNodes].forEach(n => {
      if (n.classList && n.classList.contains('cr-toast')) toasts.push(n.textContent);
    })));
    seen.observe(h.document.body, { childList: true, subtree: true });
    release();
    await tick(12);
    seen.disconnect();
    assert('…and each result names its report', toasts.some(t => /Acme weekly update/.test(t) && /Sent 2 emails/.test(t))
      && toasts.some(t => /Division progress template/.test(t) && /Sent 2 emails/.test(t)), JSON.stringify(toasts));
    h.close();
  }
  {
    // Round 5: a dialog closed (Escape) while it reads "Saving…" still says
    // when the save fails.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 991, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const esc = () => h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    h.click(h.$('[data-act="sched-menu"][data-id="991"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]'));
    await tick(6);
    const m = h.modal();
    m.querySelector('#cr-s-subject').value = 'Changed';
    srv.next.push({ match: e => e.path === '/api/custom-report-schedules' && e.method === 'PUT', status: 500, body: { error: 'database', message: 'Database error' } });
    m.querySelector('[data-s="save"]').click();
    esc();
    await tick(10);
    const t = h.document.querySelector('.cr-toast');
    assert('Escape during the schedule\'s "Saving…", then the save fails: the dialog is gone and an error toast says it was not saved',
      !h.modal() && t && t.classList.contains('err') && /Couldn’t save the schedule/.test(t.textContent) && /Database error/.test(t.textContent),
      t ? t.className + ' ' + t.textContent : 'no toast');
    // The same for Rename.
    h.click(h.$('[data-act="item-menu"][data-id="1"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-rename"]'));
    const rm = h.modal();
    rm.querySelector('#cr-m-name').value = 'Renamed meanwhile';
    srv.next.push({ status: 500, body: { error: 'Database error' } });
    rm.querySelector('[data-m="ok"]').click();
    esc();
    await tick(10);
    const t2 = h.document.querySelector('.cr-toast');
    assert('…and Escape during Rename\'s "Saving…", then a failure: an error toast says so',
      !h.modal() && t2 && t2.classList.contains('err') && /Couldn’t rename/.test(t2.textContent), t2 ? t2.className + ' ' + t2.textContent : 'no toast');
    h.close();
  }
  {
    // Round 5: renaming a scheduled report while a schedules refresh is out
    // asks for the list again, so the older answer cannot put the old name
    // back on the rail.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 992, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const name = () => { const b = h.$('[data-act="sched-menu"][data-id="992"]'); return b ? b.closest('.cr-item').querySelector('.cr-item-name').textContent : ''; };
    const gets = () => h.srv.callsTo('/api/custom-report-schedules', 'GET').length;
    const releases = [];
    srv.schedsLateGate = () => new Promise(r => releases.push(r));
    h.click(h.$('[data-act="sched-menu"][data-id="992"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="sched-toggle"]'));
    await tick(8);
    srv.schedsLateGate = null;
    const g0 = gets();
    h.click(h.$('[data-act="item-menu"][data-id="1"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-rename"]'));
    const rm = h.modal();
    rm.querySelector('#cr-m-name').value = 'Maple Ave — owner weekly update';
    rm.querySelector('[data-m="ok"]').click();
    await tick(8);
    assert('renamed with a schedules refresh out: the rail shows the new name', releases.length === 1 && name() === 'Maple Ave — owner weekly update', name());
    releases.splice(0).forEach(f => f());
    await tick(12);
    assert('…and after the older refresh lands it still does — the list was asked for again',
      name() === 'Maple Ave — owner weekly update' && gets() > g0, `${name()} · gets ${gets()} vs ${g0}`);
    h.close();
  }
  {
    // Round 6: an Edit… closed (Escape) while it reads "Saving…" keeps that
    // schedule's ⋯ off until the save lands, so Edit… cannot reopen the copy
    // from before and save it back over the new settings.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 993, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const esc = () => h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const more = () => h.$('[data-act="sched-menu"][data-id="993"]');
    const edit = () => { h.click(more()); h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]')); };
    let putRelease;
    const putGate = new Promise(r => { putRelease = r; });
    const realHandle = srv.handle;
    srv.handle = async (url, init) => { if (init && init.method === 'PUT' && /custom-report-schedules/.test(url)) await putGate; return realHandle(url, init); };
    edit();
    await tick(6);
    let m = h.modal();
    m.querySelector('#cr-s-time').value = '06:30';
    m.querySelector('[data-s="save"]').click();
    esc();
    await tick(6);
    assert('Escape during an Edit…\'s "Saving…": the dialog is gone, and that schedule\'s ⋯ is off while the save is out',
      !h.modal() && more() && more().disabled === true && /Saving…/.test(more().closest('.cr-item').textContent), more() && more().outerHTML);
    // An Edit… that reaches the page anyway (a menu opened before) opens nothing.
    const stray = h.document.createElement('button');
    stray.setAttribute('data-act', 'sched-edit');
    stray.setAttribute('data-id', '993');
    h.$('.cr-root').appendChild(stray);
    h.click(stray);
    await tick(4);
    assert('…and Edit… on it meanwhile opens nothing', !h.modal());
    stray.remove();
    putRelease();
    await tick(12);
    srv.handle = realHandle;
    assert('…on again once the save has landed', more() && more().disabled === false && !/Saving…/.test(more().closest('.cr-item').textContent));
    edit();
    await tick(6);
    m = h.modal();
    assert('…and Edit… then shows the saved 06:30', m && m.querySelector('#cr-s-time').value === '06:30', m && m.querySelector('#cr-s-time').value);
    if (m) m.querySelector('[data-s="save"]').click();
    await tick(10);
    const puts = h.srv.callsTo('/api/custom-report-schedules', 'PUT').map(e => e.body.send_time);
    assert('…so saving it sends 06:30 again, never the old 07:00', JSON.stringify(puts) === '["06:30","06:30"]'
      && srv.schedules.find(x => x.id === 993).send_time === '06:30', JSON.stringify(puts));
    h.close();
  }
  {
    // Round 6: Make private on a scheduled report whose schedule runs as
    // someone other than its owner stops those sends — so it asks first, as
    // deleting it or switching internal data on does. One whose schedules all
    // run as the owner keeps sending, so it does not ask.
    const privateWith = async runAs => {
      const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
      srv.reports.find(r => r.id === 2).definition.dates = { preset: 'last_week' };
      srv.schedules.push({ id: 994, custom_report_id: 2, report_name: 'Division progress template', jobs_mode: 'each', picked_jobs: null,
        frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
        use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
        last_run_at: null, last_status: null, last_message: null, run_as_username: runAs, created_by_username: runAs, updated_at: '2026-11-01T12:00:00Z',
        report_visible: true, report_deleted: false, report_customer_safe: true });
      const h = boot({ server: srv });
      await h.render();
      await tick(6);
      h.click(h.$('[data-act="open"][data-id="2"]'));
      await tick(4);
      const puts0 = h.srv.calls('PUT').length;
      h.confirms.splice(0);
      h.answers.push(false);
      h.click(h.act('doc-menu'));
      h.click(h.document.querySelector('.cr-menu [data-act="make-private"]'));
      await tick(8);
      const out = { asked: h.confirms.slice(), puts: h.srv.calls('PUT').length - puts0, vis: srv.find(2).visibility };
      h.close();
      return out;
    };
    const other = await privateWith('other.admin');
    assert('Make private on a shared report scheduled to run as other.admin (owner boss) asks first, naming who it runs as; "no" changes nothing',
      other.asked.length === 1 && /schedule/i.test(other.asked[0]) && /other\.admin/.test(other.asked[0]) && other.puts === 0 && other.vis === 'shared',
      JSON.stringify(other));
    const own = await privateWith('boss');
    assert('…while one whose schedule runs as its owner makes it private without asking',
      own.asked.length === 0 && own.puts === 1 && own.vis === 'private', JSON.stringify(own));
  }
  {
    // Round 6: a scheduled report renamed while the first schedules load is
    // still out (the list not known yet) asks for the list again, so that
    // answer — read before the rename — cannot leave the old name on the rail.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 995, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const releases = [];
    srv.schedsLateGate = () => new Promise(r => releases.push(r));
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    srv.schedsLateGate = null;
    const gets = () => h.srv.callsTo('/api/custom-report-schedules', 'GET').length;
    const name = () => { const b = h.$('[data-act="sched-menu"][data-id="995"]'); return b ? b.closest('.cr-item').querySelector('.cr-item-name').textContent : ''; };
    assert('the first schedules load is out (held)', releases.length === 1 && h.S().scheds === null && gets() === 1, `${releases.length} ${gets()}`);
    h.click(h.$('[data-act="item-menu"][data-id="1"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-rename"]'));
    const rm = h.modal();
    rm.querySelector('#cr-m-name').value = 'Maple Ave — owner weekly update';
    rm.querySelector('[data-m="ok"]').click();
    await tick(8);
    releases.splice(0).forEach(f => f());
    await tick(12);
    assert('renamed while it was out: the list is asked for again and the rail shows the new name',
      gets() === 2 && name() === 'Maple Ave — owner weekly update', `${name()} · gets ${gets()}`);
    h.close();
  }
  {
    // Round 7: while the schedules list is not in — its first load still out,
    // or failed — a change that would stop a scheduled send still asks first:
    // it waits for the list (asking for it again after a failure), and if the
    // list still cannot be had it asks in general terms. Before, Save into
    // fixed dates, Make private, Delete and internal-on asked nothing.
    const sched7 = (id, reportId, runAs, extra) => Object.assign({ id, custom_report_id: reportId, report_name: 'x', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: runAs || 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true }, extra || {});
    const mk7 = () => {
      const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
      srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
      srv.reports.find(r => r.id === 2).definition.dates = { preset: 'last_week' };
      srv.schedules.push(sched7(996, 1), sched7(997, 2, 'other.admin', { jobs_mode: 'each' }));
      return srv;
    };
    const failGet = srv => srv.next.push({ match: e => e.path === '/api/custom-report-schedules' && e.method === 'GET', status: 500, body: { error: 'Database error' } });
    const gets7 = h => h.srv.callsTo('/api/custom-report-schedules', 'GET').length;
    const fixedSave = async (h, answer) => {
      h.click(h.$('[data-act="open"][data-id="1"]'));
      await tick(4);
      h.change(h.$('[data-bind="preset"]'), 'custom');
      h.confirms.splice(0);
      h.answers.push(answer);
      h.click(h.act('save'));
    };
    // (a) The first load still out (held).
    {
      const srv = mk7();
      const releases = [];
      srv.schedsLateGate = () => new Promise(r => releases.push(r));
      const h = boot({ server: srv });
      await h.render();
      await tick(6);
      srv.schedsLateGate = null;
      const puts0 = h.srv.calls('PUT').length;
      await fixedSave(h, false);
      await tick(8);
      const before = h.confirms.length;
      releases.splice(0).forEach(f => f());
      await tick(12);
      const asked = h.confirms.slice();
      assert('round 7: Save into fixed dates while the first schedules load is still out waits for it, then asks (fixed dates); "no" saves nothing (was saved without asking)',
        before === 0 && asked.length === 1 && /This report is scheduled/.test(asked[0]) && /fixed dates/.test(asked[0])
          && h.srv.calls('PUT').length === puts0 && srv.find(1).definition.dates.preset === 'last_week', JSON.stringify({ before, asked }));
      h.close();
    }
    // (b) The first load failed: Save asks for the list again, then asks.
    {
      const srv = mk7();
      failGet(srv);
      const h = boot({ server: srv });
      await h.render();
      await tick(6);
      const g0 = gets7(h), err0 = h.S().schedsError, puts0 = h.srv.calls('PUT').length;
      await fixedSave(h, false);
      await tick(12);
      const asked = h.confirms.slice();
      assert('round 7: after a failed first schedules load, Save into fixed dates asks for the list again and asks (fixed dates); "no" saves nothing',
        err0 === 'Database error' && gets7(h) === g0 + 1 && asked.length === 1 && /This report is scheduled/.test(asked[0])
          && /fixed dates/.test(asked[0]) && h.srv.calls('PUT').length === puts0, JSON.stringify({ err0, g0, gets: gets7(h), asked }));
      h.close();
    }
    // (b′, d) …and when that fails too: a general ask; "yes" saves, and the
    // save asks for the list again.
    {
      const srv = mk7();
      failGet(srv); failGet(srv); failGet(srv);
      const h = boot({ server: srv });
      await h.render();
      await tick(6);
      const puts0 = h.srv.calls('PUT').length;
      await fixedSave(h, false);
      await tick(12);
      const asked = h.confirms.slice();
      assert('round 7: with the schedules list failing again, Save into fixed dates asks in general terms (naming the error); "no" saves nothing',
        asked.length === 1 && /Couldn’t check whether a schedule sends this report \(Database error\)/.test(asked[0]) && /fixed dates/.test(asked[0])
          && h.srv.calls('PUT').length === puts0, JSON.stringify(asked));
      const g1 = gets7(h);
      h.confirms.splice(0);
      h.answers.push(true);
      h.click(h.act('save'));
      await tick(14);
      assert('…"yes" saves it, and the list is asked for again after the save (was never retried by a save)',
        h.srv.calls('PUT').length === puts0 + 1 && srv.find(1).definition.dates.preset === 'custom' && gets7(h) >= g1 + 2,
        JSON.stringify({ puts: h.srv.calls('PUT').length - puts0, g1, gets: gets7(h) }));
      h.close();
    }
    // (c) Make private, Delete and internal-on with the list not to be had.
    {
      const srv = mk7();
      for (let i = 0; i < 6; i++) failGet(srv);
      const h = boot({ server: srv });
      await h.render();
      await tick(6);
      h.click(h.$('[data-act="open"][data-id="2"]'));
      await tick(4);
      const puts0 = h.srv.calls('PUT').length;
      h.confirms.splice(0);
      h.answers.push(false);
      h.click(h.act('doc-menu'));
      h.click(h.document.querySelector('.cr-menu [data-act="make-private"]'));
      await tick(12);
      const asked = h.confirms.slice();
      assert('round 7: Make private with the schedules list not to be had asks first, in general terms; "no" changes nothing (was made private without asking)',
        asked.length === 1 && /Couldn’t check whether a schedule sends this report/.test(asked[0]) && /private/.test(asked[0])
          && h.srv.calls('PUT').length === puts0 && srv.find(2).visibility === 'shared', JSON.stringify(asked));
      h.click(h.$('[data-act="open"][data-id="1"]'));
      await tick(4);
      h.click(h.$('#cr-step-2'));
      h.confirms.splice(0);
      h.answers.push(false);
      h.$('[data-bind="internal"]').click();
      await tick(2);
      const askedI = h.confirms.slice();
      assert('…switching internal data on says a schedule may stop sending it (was no word of schedules)',
        askedI.length === 1 && /If a schedule sends this report/.test(askedI[0]) && h.S().doc.def.includeInternal !== true, JSON.stringify(askedI));
      h.confirms.splice(0);
      h.answers.push(false);
      h.click(h.$('[data-act="item-menu"][data-id="1"]'));
      h.click(h.document.querySelector('.cr-menu [data-act="menu-delete"]'));
      await tick(12);
      const askedD = h.confirms.slice();
      assert('…and Delete\'s confirm says a schedule may stop sending it', askedD.length === 1 && /Couldn’t check whether a schedule sends this report/.test(askedD[0])
        && !!srv.find(1) && !srv.find(1).deleted_at, JSON.stringify(askedD));
      h.close();
    }
    // (c′) Make private with the first load out: waits, then names who it runs as.
    {
      const srv = mk7();
      const releases = [];
      srv.schedsLateGate = () => new Promise(r => releases.push(r));
      const h = boot({ server: srv });
      await h.render();
      await tick(6);
      srv.schedsLateGate = null;
      h.click(h.$('[data-act="open"][data-id="2"]'));
      await tick(4);
      h.confirms.splice(0);
      h.answers.push(false);
      h.click(h.act('doc-menu'));
      h.click(h.document.querySelector('.cr-menu [data-act="make-private"]'));
      await tick(8);
      const before = h.confirms.length;
      releases.splice(0).forEach(f => f());
      await tick(12);
      const asked = h.confirms.slice();
      assert('…and Make private while the first load is out waits for it, then asks naming who the schedule runs as',
        before === 0 && asked.length === 1 && /other\.admin/.test(asked[0]) && srv.find(2).visibility === 'shared', JSON.stringify({ before, asked }));
      h.close();
    }
  }
  {
    // Round 7: the open report's own Save is out (the server has committed
    // it, its answer is held): a rename from the rail is refused rather than
    // racing it — and a late Save answer never puts an older copy back over a
    // newer one in the list (here, a list reload that read someone's rename).
    const srv = seed(makeServer());
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    let release = null;
    const realHandle = srv.handle;
    srv.handle = async (url, init) => {
      const r = await realHandle(url, init);
      if (init && init.method === 'PUT' && /\/api\/custom-reports\?/.test(url) && /id=1\b/.test(url) && JSON.parse(init.body).definition) {
        await new Promise(res => { release = res; });
      }
      return r;
    };
    h.click(h.$('[data-act="open"][data-id="1"]'));
    await tick(4);
    h.change(h.$('[data-bind="preset"]'), 'last_month');
    h.click(h.act('save'));
    await tick(6);
    assert('round 7: the open report\'s Save is out (committed, answer held)', !!release && srv.find(1).version === 2 && h.S().saving === true,
      JSON.stringify({ held: !!release, v: srv.find(1).version }));
    const renames0 = h.srv.calls('PUT').length;
    h.click(h.$('[data-act="item-menu"][data-id="1"]'));
    h.click(h.document.querySelector('.cr-menu [data-act="menu-rename"]'));
    await tick(4);
    assert('…a rename of it from the rail is refused while that Save is out, saying why (no dialog, no PUT)',
      !h.modal() && /Wait for the save to finish/.test(h.toast()) && h.srv.calls('PUT').length === renames0, h.toast());
    // Someone renames it on the server; a list reload reads that (version 3).
    Object.assign(srv.find(1), { name: 'Maple Ave owner update', version: 3, updated_by_username: 'boss' });
    h.window.FCTCustomReports.renderTab(h.mount);
    await tick(8);
    srv.handle = realHandle;
    release();
    await tick(10);
    const listed = h.S().reports.find(r => r.id === 1), d = h.S().doc;
    assert('…and the held Save answer (version 2) leaves the list\'s newer copy (version 3, its name) and the editor\'s saved name alone (was rolled back to version 2 and the old name)',
      listed && listed.version === 3 && listed.name === 'Maple Ave owner update' && d && d.savedName === 'Maple Ave owner update' && d.version === 2,
      JSON.stringify({ listed: listed && [listed.name, listed.version], doc: d && [d.savedName, d.version] }));
    h.close();
  }
  {
    // Round 7: a schedule save that fails with its dialog still open — no
    // answer, or the server's own failure, which may follow a committed
    // change — asks for the schedules list again, so after Cancel the rail
    // and the next Edit… read what the server holds.
    const srv = seed(makeServer({ groups: [{ id: 41, name: 'Acme owners', emails: ['a@acme.com'] }] }));
    srv.reports.find(r => r.id === 1).definition.dates = { preset: 'last_week' };
    srv.schedules.push({ id: 998, custom_report_id: 1, report_name: 'Acme weekly update', jobs_mode: 'saved', picked_jobs: null,
      frequency: 'weekly', days_of_week: [1], day_of_month: null, send_time: '07:00', timezone: 'America/New_York', group_ids: [41], emails: [],
      use_job_contacts: false, subject: null, note: null, attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:00:00Z',
      last_run_at: null, last_status: null, last_message: null, run_as_username: 'pat', created_by_username: 'pat', updated_at: '2026-11-01T12:00:00Z',
      report_visible: true, report_deleted: false, report_customer_safe: true });
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const realHandle = srv.handle;
    let failNext = true;
    srv.handle = async (url, init) => {
      const r = await realHandle(url, init);
      if (failNext && init && init.method === 'PUT' && /custom-report-schedules/.test(url)) { failNext = false; return { ok: false, status: 500, json: async () => ({ error: 'Database error' }) }; }
      return r;
    };
    const line = () => { const b = h.$('[data-act="sched-menu"][data-id="998"]'); return b ? b.closest('.cr-item').textContent.replace(/\s+/g, ' ') : ''; };
    const edit = () => { h.click(h.$('[data-act="sched-menu"][data-id="998"]')); h.click(h.document.querySelector('.cr-menu [data-act="sched-edit"]')); };
    edit();
    await tick(6);
    let m = h.modal();
    m.querySelector('#cr-s-time').value = '06:30';
    const g0 = h.srv.callsTo('/api/custom-report-schedules', 'GET').length;
    m.querySelector('[data-s="save"]').click();
    await tick(10);
    assert('round 7: a schedule save the server committed but answered 500, dialog still open: it says so, and the list is asked for again',
      !!h.modal() && /Database error/.test(m.querySelector('.cr-m-errs').textContent) && srv.schedules[0].send_time === '06:30'
        && h.srv.callsTo('/api/custom-report-schedules', 'GET').length > g0, `${m.querySelector('.cr-m-errs').textContent} · gets ${h.srv.callsTo('/api/custom-report-schedules', 'GET').length - g0}`);
    m.querySelector('[data-s="cancel"]').click();
    await tick(6);
    assert('…after Cancel the rail shows 6:30 AM, what the server holds (was 7:00 AM)', /6:30/.test(line()) && !/7:00/.test(line()), line());
    edit();
    await tick(6);
    m = h.modal();
    assert('…and Edit… reopens at 06:30 (was 07:00, which a later save wrote back)', m && m.querySelector('#cr-s-time').value === '06:30', m && m.querySelector('#cr-s-time').value);
    if (m) m.querySelector('[data-s="cancel"]').click();
    srv.handle = realHandle;
    h.close();
  }
  {
    // Round 6: after a rename's version_conflict, "Try the rename again" in
    // the same dialog renames against the version the conflict sent back —
    // for a report that is not open, and for the open one, whose own next
    // Save still meets the other person's save (never quietly overwrites it).
    const srv = seed(makeServer());
    const h = boot({ server: srv });
    await h.render();
    await tick(6);
    const renameTo = async (id, name) => {
      h.click(h.$(`[data-act="item-menu"][data-id="${id}"]`));
      h.click(h.document.querySelector('.cr-menu [data-act="menu-rename"]'));
      const rm = h.modal();
      rm.querySelector('#cr-m-name').value = name;
      rm.querySelector('[data-m="ok"]').click();
      await tick(8);
      return rm;
    };
    const puts = id => h.srv.calls('PUT', e => e.q.id === String(id));
    // Report 2, not open: someone else saves it (version 2) behind our back.
    Object.assign(srv.find(2), { version: 2, updated_by_username: 'boss' });
    let rm = await renameTo(2, 'Division progress — renamed');
    const err1 = rm.isConnected ? rm.textContent : '';
    assert('a report that is not open, saved by someone else meanwhile: the rename meets the conflict and says so', /Try the rename again/.test(err1)
      && puts(2).length === 1 && puts(2)[0].body.version === 1, err1);
    rm.querySelector('[data-m="ok"]').click();
    await tick(8);
    assert('…and OK again in the same dialog renames it, against the version the conflict sent back (was the same conflict again)',
      !rm.isConnected && puts(2).length === 2 && puts(2)[1].body.version === 2 && srv.find(2).name === 'Division progress — renamed' && srv.find(2).version === 3,
      JSON.stringify(puts(2).map(e => e.body)));
    if (rm.isConnected) rm.querySelector('[data-m="cancel"]').click();
    // Report 1, open, unedited; someone else saves it.
    h.click(h.$('[data-act="open"][data-id="1"]'));
    await tick(4);
    Object.assign(srv.find(1), { version: 2, updated_by_username: 'boss', description: 'Changed by boss' });
    rm = await renameTo(1, 'Acme — renamed');
    assert('the open report, saved by someone else meanwhile: the rename meets the conflict', rm.isConnected && /Try the rename again/.test(rm.textContent)
      && puts(1).length === 1, rm.textContent);
    rm.querySelector('[data-m="ok"]').click();
    await tick(8);
    assert('…and OK again renames it (was the same conflict again, and again on every rename until reloaded)',
      !rm.isConnected && puts(1).length === 2 && puts(1)[1].body.version === 2 && srv.find(1).name === 'Acme — renamed', JSON.stringify(puts(1).map(e => e.body)));
    assert('…the open report shows the new name', h.S().doc.savedName === 'Acme — renamed' && h.$('[data-bind="name"]').value === 'Acme — renamed', h.S().doc.savedName);
    if (rm.isConnected) rm.querySelector('[data-m="cancel"]').click();
    // Its own next Save still meets boss's save, rather than writing over it.
    if (h.$('#cr-step-3')) h.click(h.$('#cr-step-3'));
    if (h.$('[data-bind="title"]')) h.type(h.$('[data-bind="title"]'), 'My edit');
    await tick(2);
    h.click(h.act('save'));
    await tick(8);
    const conflictBox = h.modal();
    assert('…and its next Save still meets the other person\'s save (Load their version / Save mine as a copy), not a quiet overwrite',
      conflictBox && /Someone else saved this report/.test(conflictBox.textContent) && srv.find(1).description === 'Changed by boss' && srv.find(1).version === 3,
      conflictBox ? conflictBox.textContent : 'no dialog; version ' + srv.find(1).version);
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer({ canShare: false })), cfg: { perm: { role: 'level2', canSeeCosts: true, canSeeFinancials: true, canShare: false } } });
    await h.render();
    await tick(6);
    assert('level 1/2: no Schedules in the rail, no schedules fetched', !/Schedules/.test(h.$('.cr-rail').textContent)
      && h.srv.callsTo('/api/custom-report-schedules').length === 0);
    h.click(h.$('[data-act="open"][data-id="1"]'));
    assert('…and Schedule… is off, saying who may', h.act('schedule').disabled && /Only an admin or level 3/.test(h.act('schedule').title));
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('v2 · AI Builder drawer — the adapter, apply, undo, never internal');
  {
    const h = boot({ server: seed(makeServer({ canShare: false })) });
    const E = h.window.FCTReportEngine;
    const mounts = [];
    let destroyed = 0;
    h.window.FCTReportAI = {
      mount(el, adapter) {
        mounts.push({ el, adapter });
        el.innerHTML = '<div class="ai-stub"><textarea aria-label="Ask"></textarea><button type="button" data-act="close">x</button>'
          + '<button type="button" data-act="save">s</button></div>';
        return { destroy() { destroyed++; } };
      },
    };
    await h.render();
    const drawer = () => h.mount.querySelector('.cr-ai-drawer');
    assert('the drawer is there, closed', drawer() && drawer().hidden && mounts.length === 0);
    h.click(h.act('ai-toggle'));
    assert('"✨ AI Builder" opens the drawer and mounts the AI panel once', !drawer().hidden && mounts.length === 1
      && drawer().contains(mounts[0].el) && h.act('ai-toggle').getAttribute('aria-pressed') === 'true');
    const a = mounts[0].adapter;
    const keys = ['getDefinition', 'applyDefinition', 'undo', 'getJobs', 'getCodes', 'division', 'divisionLabel', 'apiBase', 'getToken',
      'onAuthError', 'requestInternal', 'isReadOnly'];
    assert('the adapter has exactly the spec\'s members', JSON.stringify(Object.keys(a).sort()) === JSON.stringify(keys.slice().sort()), Object.keys(a).join());
    assert('…division, label, API base and token', a.division === 'paving' && a.divisionLabel === 'Paving' && a.apiBase === '/api' && a.getToken() === 'tok-123');
    const jobs = a.getJobs();
    assert('getJobs gives id, name, number, client, status — and nothing else (no contract or money)', jobs.length === 3
      && jobs.every(j => JSON.stringify(Object.keys(j)) === '["id","name","number","client","status"]')
      && JSON.stringify(jobs[0]) === '{"id":"p1","name":"Route 30 Resurfacing","number":"26101","client":"Acme Township","status":"In Progress"}'
      && !/250000|80000|contract/.test(JSON.stringify(jobs)));
    const codes = a.getCodes();
    assert('getCodes gives the division\'s cost codes and sub codes', codes.costCodes.includes('Paving') && codes.costCodes.includes('Sealcoat')
      && codes.subCodes.some(x => x.code === 'Coat') && codes.subCodes.every(x => JSON.stringify(Object.keys(x)) === '["code","description","unit"]'));
    assert('with no report open, getDefinition is an empty v2 definition and nothing is read-only', a.getDefinition().v === 2
      && a.getDefinition().sections.length === 0 && a.isReadOnly() === false);
    // Apply with nothing open: a new unsaved report.
    const ok = a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'Turf Install — last week', includeInternal: true,
      jobs: { mode: 'pick', ids: ['p1', 'nope', 'p2'] }, dates: { preset: 'last_week' },
      sections: [{ type: 'job_info' }, { type: 'bid_progress', columns: ['cost_code', 'actual_cost'] }] }), { changes: ['Added job info', 'Added progress'] });
    let d = h.S().doc;
    assert('applying with no report open creates a new, unsaved report', ok === true && d && d.id === null && d.touched && h.S().view === 'edit'
      && d.def.title === 'Turf Install — last week' && d.name === 'Turf Install — last week' && !h.$('.cr-dirty').hidden);
    assert('…with only the jobs that exist', JSON.stringify(d.picked) === '["p1","p2"]');
    assert('…and internal data still OFF, whatever the definition said', d.def.includeInternal === false && !h.$('.cr-banner-int'));
    assert('the drawer kept its conversation (no remount)', mounts.length === 1 && destroyed === 0 && !drawer().hidden);
    await sleep(PREVIEW_WAIT);
    assert('…the preview shows it, customer-safe', /Route 30 Resurfacing/.test(h.srcdoc()) && !/Actual Cost/.test(h.srcdoc()) && !/INTERNAL/.test(h.srcdoc()));
    assert('getDefinition now reads the open report, jobs included', a.getDefinition().title === 'Turf Install — last week'
      && JSON.stringify(a.getDefinition().jobs.ids) === '["p1","p2"]');
    // Apply again → undoable.
    a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'Second try', jobs: { mode: 'pick', ids: ['p2'] }, sections: [{ type: 'notes', text: 'AI note' }] }), { changes: ['x'] });
    d = h.S().doc;
    assert('a second apply changes the open report in place', h.S().doc === d && d.def.title === 'Second try' && JSON.stringify(d.picked) === '["p2"]');
    // The person turns internal data on — only through the confirm.
    h.answers.push(false);
    assert('requestInternal opens the internal-data confirm; "no" leaves it off', a.requestInternal() === false
      && h.confirms.pop() === 'This report will be able to show costs, rates, hours, employee names and profit. Don\'t send it to a customer. Continue?'
      && d.def.includeInternal === false);
    assert('requestInternal with "yes" turns it on', a.requestInternal() === true && d.def.includeInternal === true && !!h.$('.cr-banner-int'));
    a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'Third', sections: [{ type: 'bid_progress' }] }), {});
    assert('an apply keeps internal data as the person set it (on stays on)', h.S().doc.def.includeInternal === true);
    h.click(h.act('internal-off'));
    assert('…off by the person', h.S().doc.def.includeInternal === false);
    assert('undo puts back the previous definition', a.undo() === true && h.S().doc.def.title === 'Second try');
    assert('…but never switches internal data back on', h.S().doc.def.includeInternal === false && !h.$('.cr-banner-int'));
    assert('undo again goes back to the first apply', a.undo() === true && h.S().doc.def.title === 'Turf Install — last week' && JSON.stringify(h.S().doc.picked) === '["p1","p2"]');
    const nConfirms = h.confirms.length;
    assert('undoing the apply that made the report closes it — with nothing changed by hand since, without asking',
      a.undo() === true && h.S().doc === null && h.S().view === 'home' && h.confirms.length === nConfirms);
    assert('…and there is nothing more to undo', a.undo() === false);
    // Hand edits after an AI change: Undo asks first, and "no" keeps them.
    {
      // A report the AI built from nothing, then named by hand.
      a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'Built by AI', jobs: { mode: 'pick', ids: ['p2'] }, sections: [{ type: 'job_info' }] }), {});
      const built = h.S().doc;
      h.type(h.$('[data-bind="name"]'), 'Named by hand');
      const c1 = h.confirms.length;
      h.answers.push(false);
      const r3 = a.undo();
      assert('undoing an AI-built report that was then named by hand asks before closing it; "no" leaves it open, as it is',
        r3 === 'declined' && h.S().doc === built && built.name === 'Named by hand' && h.confirms.length === c1 + 1
          && /closes the report/.test(h.confirms[h.confirms.length - 1]), JSON.stringify({ r3, open: !!h.S().doc, c: h.confirms.slice(c1) }));
      h.answers.push(true);
      assert('…"yes" closes it', a.undo() === true && h.S().doc === null);
      h.click(h.$('[data-act="open"][data-id="1"]'));
      await tick();
      const od = h.S().doc;
      const preTitle = od.def.title, preName = od.name, preSecs = od.def.sections.length;
      a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'AI weekly', jobs: { mode: 'pick', ids: ['p1'] }, sections: [{ type: 'job_info' }, { type: 'bid_progress' }] }), {});
      h.click(h.$('#cr-step-2'));
      h.click(h.act('add-menu'));
      h.click(h.document.querySelector('.cr-menu [data-type="notes"]'));
      h.type(h.$('[data-bind="name"]'), 'Renamed by hand');
      const hand = JSON.stringify(h.S().doc.def.sections.map(x => x.type));
      const c0 = h.confirms.length;
      h.answers.push(false);
      const r1 = a.undo();
      assert('Undo after hand edits (a section added, a rename) asks first; "no" keeps every edit and reports it did not undo',
        r1 === 'declined' && h.confirms.length === c0 + 1 && /Edits you made since then will be lost/.test(h.confirms[h.confirms.length - 1])
          && h.S().doc === od && od.name === 'Renamed by hand' && JSON.stringify(od.def.sections.map(x => x.type)) === hand && /notes/.test(hand),
        JSON.stringify({ r1, name: od.name, hand, c: h.confirms.slice(c0) }));
      h.answers.push(true);
      const r2 = a.undo();
      assert('…"yes" puts back the report as it was before the AI change', r2 === true && od.def.title === preTitle && od.name === preName
        && od.def.sections.length === preSecs, JSON.stringify({ r2, t: od.def.title, n: od.name }));
    }
    // Clicks inside the drawer are the AI panel's, not the builder's.
    h.click(h.$('[data-act="new"]'));
    const before = h.S().doc;
    h.click(mounts[0].el.querySelector('[data-act="close"]'));
    h.click(mounts[0].el.querySelector('[data-act="save"]'));
    await tick();
    assert('a data-act="close" / "save" inside the drawer does not close or save the report', h.S().doc === before && h.S().view === 'edit' && !h.modal());
    // Redraws keep the panel; switching report remounts it.
    const nRedraw = mounts.length;
    h.click(h.$('#cr-step-2'));
    h.click(h.act('history'));
    h.click(h.act('back'));
    assert('redraws (steps, history, back) keep the same panel, not remounted', mounts.length === nRedraw
      && drawer().contains(mounts[mounts.length - 1].el) && !drawer().hidden && !!drawer().querySelector('.ai-stub'), `mounts ${mounts.length}`);
    const nBefore = mounts.length;
    h.click(h.$('[data-act="open"][data-id="2"]'));   // the shared template, read-only here (canShare false)
    await tick();
    assert('opening another report starts a fresh conversation (old one destroyed, remounted)', mounts.length === nBefore + 1 && destroyed >= 1);
    assert('isReadOnly is true on a shared template the user cannot save', mounts[mounts.length - 1].adapter.isReadOnly() === true);
    assert('…and apply refuses to change it', mounts[mounts.length - 1].adapter.applyDefinition(E.defaultDefinition(), {}) === false
      && h.S().doc.def.sections.length === 2);
    // Closing.
    drawer().querySelector('.cr-ai-x').click();
    assert('the × closes the drawer', drawer().hidden && h.act('ai-toggle').getAttribute('aria-pressed') === 'false');
    h.click(h.act('ai-toggle'));
    drawer().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert('Escape closes it too', drawer().hidden);
    h.close();
  }
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    h.click(h.act('ai-toggle'));
    assert('without custom-reports-ai.js loaded the drawer says it is still loading', /still loading/.test(h.mount.querySelector('.cr-ai-drawer').textContent));
    h.close();
  }
  {
    // The real AI panel: an AI change, then a hand edit; Undo → the builder's
    // "Undo the AI change? Edits you made since then will be lost." → Cancel.
    // Nothing failed, so the panel says nothing failed, and Undo stays live.
    const h = boot({ server: seed(makeServer()) });
    h.window.eval(fs.readFileSync(path.join(ROOT, 'custom-reports-ai.js'), 'utf8'));
    const realFetch = h.window.fetch;
    h.window.fetch = (url, init) => (/\/ai\/report-builder/.test(String(url))
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, reply: 'Retitled it.', changes: ['Changed the title'],
        needs_internal: false, clarifying_question: null, dropped: { jobs: 0, codes: 0, sections: 0 },
        definition: Object.assign(JSON.parse(JSON.stringify(h.S().doc.def)), { title: 'Retitled by AI' }) }) })
      : realFetch(url, init));
    await h.render();
    await tick(4);
    h.click(h.$('[data-act="open"][data-id="1"]'));
    await tick();
    h.click(h.act('ai-toggle'));
    await tick();
    const drawer = h.mount.querySelector('.cr-ai-drawer');
    await h.S().ai.handle.send('Retitle it');
    await tick(4);
    const undoBtn = () => drawer.querySelector('[data-crai-act="undo"]');
    assert('the real panel applies an AI change and offers its Undo', h.S().doc.def.title === 'Retitled by AI' && !!undoBtn() && !undoBtn().disabled,
      h.S().doc.def.title);
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="title"]'), 'Retitled by hand');
    const c0 = h.confirms.length;
    h.answers.push(false);
    h.click(undoBtn());
    await tick();
    const notes = [...drawer.querySelectorAll('.crai-note')].map(n => n.textContent);
    assert('declining "Undo the AI change?" in the panel: no "Could not undo" note, the hand edit kept, and Undo still live',
      h.confirms.length === c0 + 1 && /Edits you made since then will be lost/.test(h.confirms[c0] || '')
        && !notes.some(n => /Could not undo/.test(n)) && h.S().doc.def.title === 'Retitled by hand' && !!undoBtn() && !undoBtn().disabled
        && !/Undone/.test(drawer.textContent), JSON.stringify({ notes, title: h.S().doc.def.title, c: h.confirms.slice(c0) }));
    h.answers.push(true);
    h.click(undoBtn());
    await tick();
    assert('…and "yes" on a second Undo undoes it', /Undone/.test(drawer.textContent) && h.S().doc.def.title !== 'Retitled by hand'
      && ![...drawer.querySelectorAll('.crai-note')].some(n => /Could not undo/.test(n.textContent)), h.S().doc.def.title);
    h.close();
  }
  {
    // The real AI panel on a shared template this user cannot change: locked,
    // with its "use Save As" note — until a Save As makes it their own copy.
    const h = boot({ server: seed(makeServer({ canShare: false })) });
    h.window.eval(fs.readFileSync(path.join(ROOT, 'custom-reports-ai.js'), 'utf8'));
    await h.render();
    await tick(4);
    h.click(h.$('[data-act="open"][data-id="2"]'));
    await tick();
    h.click(h.act('ai-toggle'));
    await tick();
    const drawer = h.mount.querySelector('.cr-ai-drawer');
    const q = sel => drawer.querySelector(sel);
    assert('the real AI panel on a read-only shared template: input and Send off, the "use Save As" note shown',
      h.S().doc.readOnly === true && q('.crai-in').disabled && q('.crai-send').disabled && !q('.crai-ro').hidden);
    h.click(h.act('save-as'));
    await tick(4);
    const m = h.modal();
    h.type(m.querySelector('#cr-m-name'), 'My copy of the template');
    m.querySelector('[data-m="ok"]').click();
    await tick(10);
    assert('after Save As the copy is the user\'s own, and the panel follows: input and Send on, the note gone',
      !h.modal() && h.S().doc.readOnly === false && !q('.crai-in').disabled && !q('.crai-send').disabled && q('.crai-ro').hidden,
      JSON.stringify({ ro: h.S().doc.readOnly, input: q('.crai-in').disabled, note: q('.crai-ro').hidden }));
    h.close();
  }

  {
    // Round 5: "save the jobs with the report" from the AI builder reaches
    // the report — the step ① box, getDefinition and the saved copy — and
    // its Undo takes it back.
    const srv = seed(makeServer({ canShare: false }));
    srv.add({ id: 30, name: 'My private template', definition: { v: 2, dates: { preset: 'last_week' }, jobs: { mode: 'pick', ids: [] }, sections: [{ type: 'job_info' }] } });
    const h = boot({ server: srv });
    const E = h.window.FCTReportEngine;
    const mounts = [];
    h.window.FCTReportAI = { mount(el, adapter) { mounts.push(adapter); el.innerHTML = '<div class="ai-stub"></div>'; return { destroy() {} }; } };
    await h.render();
    h.click(h.act('ai-toggle'));
    const a = mounts[0];
    a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'Maple weekly', jobs: { mode: 'saved', ids: ['p1'] }, sections: [{ type: 'job_info' }] }), { changes: ['Saved the jobs with the report'] });
    assert('an AI apply with jobs saved, on a new report: the jobs are kept with it (step ① box ticked, getDefinition says saved)',
      h.S().doc.saveJobs === true && h.$('[data-bind="save-jobs"]').checked && a.getDefinition().jobs.mode === 'saved'
        && JSON.stringify(a.getDefinition().jobs.ids) === '["p1"]', JSON.stringify({ saveJobs: h.S().doc.saveJobs, def: a.getDefinition().jobs }));
    // An existing private template: open it, the AI saves the jobs with it, Save.
    h.click(h.$('[data-act="open"][data-id="30"]'));
    await tick(2);
    const puts0 = h.srv.calls('PUT').length;
    a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'My private template', dates: { preset: 'last_week' }, jobs: { mode: 'saved', ids: ['p1'] },
      sections: [{ type: 'job_info' }] }), { changes: ['Saved the jobs with the report'] });
    assert('…on an open template: the box is ticked and the report is unsaved', h.S().doc.saveJobs === true && h.$('[data-bind="save-jobs"]').checked
      && !h.$('.cr-dirty').hidden);
    h.click(h.act('save'));
    await tick(8);
    const put = h.srv.calls('PUT').slice(puts0).pop();
    assert('…and Save PUTs the jobs with it', put && put.body.definition.jobs.mode === 'saved' && JSON.stringify(put.body.definition.jobs.ids) === '["p1"]'
      && srv.find(30).kind === 'report', put ? JSON.stringify(put.body.definition.jobs) : 'no PUT');
    // Undo of an AI change brings the box back.
    a.applyDefinition(E.normalizeDefinition({ v: 2, title: 'My private template', dates: { preset: 'last_week' }, jobs: { mode: 'pick', ids: ['p1'] },
      sections: [{ type: 'job_info' }] }), { changes: ['Jobs picked each time'] });
    assert('an AI apply back to "pick each time" unticks it', h.S().doc.saveJobs === false && !h.$('[data-bind="save-jobs"]').checked);
    assert('…and AI Undo ticks it again', a.undo() === true && h.S().doc.saveJobs === true && h.$('[data-bind="save-jobs"]').checked);
    h.close();
  }

  // ════════════════════════════════════════════════════════════════════
  section('v2 · 409 client_outdated — reload, the work kept');
  {
    const h = boot({ server: seed(makeServer()) });
    await h.render();
    h.click(h.$('[data-act="open"][data-id="1"]'));
    h.click(h.$('#cr-step-3'));
    h.type(h.$('[data-bind="title"]'), 'Edited in a stale tab');
    // The stored report is v2; this tab sends a v1 definition (an old builder).
    h.srv.find(1).definition.v = 2;
    const E = h.window.FCTReportEngine;
    const realNorm = E.normalizeDefinition;
    E.normalizeDefinition = x => Object.assign(realNorm(x), { v: 1 });
    h.click(h.act('save'));
    await tick(6);
    E.normalizeDefinition = realNorm;
    const put = h.srv.calls('PUT').pop();
    assert('the stand-in refuses a v1 save over a v2 report with 409 client_outdated', put && put.body.definition.v === 1);
    const m = h.modal();
    assert('the UI says DataWatch was updated and offers Reload', m && /DataWatch was updated/.test(m.textContent) && /reload the page to keep editing/.test(m.textContent)
      && !!m.querySelector('[data-m="reload"]'));
    assert('…no error toast on top', !h.document.querySelector('.cr-toast.err'));
    const kept = h.window.sessionStorage.getItem('fct_cr_draft_paving');
    assert('…and the work is kept in the draft', kept && /Edited in a stale tab/.test(kept));
    m.querySelector('[data-m="reload"]').click();
    const e = new h.window.Event('beforeunload', { cancelable: true });
    h.window.dispatchEvent(e);
    assert('Reload leaves without the "unsaved changes" question', h.S().reloading === true && !e.defaultPrevented);
    const h2 = boot({ server: h.srv });
    h2.window.sessionStorage.setItem('fct_cr_draft_paving', kept);
    await h2.render();
    await tick(6);
    const m2 = h2.modal();
    assert('after the reload the draft is offered back', m2 && /Restore your unsaved report/.test(m2.textContent));
    [...m2.querySelectorAll('[data-choice]')].find(b => /Restore/.test(b.textContent)).click();
    await tick();
    h2.click(h2.act('save'));
    await tick(6);
    const put2 = h2.srv.calls('PUT').pop();
    assert('…and saves as v2 this time', put2 && put2.body.definition.v === 2 && put2.body.definition.title === 'Edited in a stale tab' && h2.$('.cr-dirty').hidden);
    h.close(); h2.close();
  }

  section('v2 · Send History names scheduled and resent emails');
  {
    const srv = seed(makeServer());
    srv.addRun({ id: 1, report_name: 'R', action: 'email', run_kind: 'schedule', recipients: ['a@b.co'], created_at: '2026-11-04T15:00:00Z' });
    srv.addRun({ id: 2, report_name: 'R', action: 'email', run_kind: 'resend', recipients: ['a@b.co'], created_at: '2026-11-04T16:00:00Z' });
    const h = boot({ server: srv });
    await h.render();
    h.click(h.act('history'));
    await tick();
    const rows = h.$$('.cr-table tbody tr').map(r => r.textContent);
    assert('the Action cell says Scheduled / Resent', rows.some(t => /Scheduled/.test(t)) && rows.some(t => /Resent/.test(t)));
    h.close();
  }
  {
    // The server pages the history (100 at a time): "Load more" fetches the rest.
    const srv = seed(makeServer({ runPage: 2 }));
    for (let i = 1; i <= 5; i++) srv.addRun({ id: i, report_name: 'Run ' + i, action: 'print', created_at: '2026-11-0' + i + 'T15:00:00Z' });
    const h = boot({ server: srv });
    await h.render();
    h.click(h.act('history'));
    await tick(4);
    assert('Send History shows the first page, newest first, with "Load more"', h.$$('.cr-table tbody tr').length === 2
      && /Run 5/.test(h.$$('.cr-table tbody tr')[0].textContent) && !!h.act('history-more'));
    h.click(h.act('history-more'));
    await tick(4);
    const get = h.srv.calls('GET', e => e.q.runs === '1').pop();
    assert('…which asks for the page before the last row shown (before_id) and appends it', get && get.q.before_id === '4'
      && h.$$('.cr-table tbody tr').length === 4 && /Run 2/.test(h.$$('.cr-table tbody tr')[3].textContent), get && JSON.stringify(get.q));
    h.click(h.act('history-more'));
    await tick(4);
    assert('…until there is no more: all five, and the button gone', h.$$('.cr-table tbody tr').length === 5 && !h.act('history-more'));
    h.click(h.act('history-refresh'));
    await tick(4);
    assert('Refresh starts again from the newest page', h.$$('.cr-table tbody tr').length === 2 && !!h.act('history-more')
      && !h.srv.calls('GET', e => e.q.runs === '1').pop().q.before_id);
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
  if (process.env.CR_SKIP_BROWSER) console.log('  - skipped: CR_SKIP_BROWSER is set');
  else await browserCheck();

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
      const RUNS = [{ id: 1, report_name: 'Owner update', action: 'email', subject: 'Weekly progress for the owner', project_ids: ['p1'], run_kind: 'schedule',
        project_names: ['Route 30 Resurfacing', 'Elm Street Lot', 'Maple Avenue Reconstruction Phase Two', 'Borough Garage Lot'],
        date_from: '2026-10-27', date_to: '2026-11-02', included_internal: true, run_by_username: 'pat', created_at: '2026-11-04T15:00:00Z',
        recipients: ['project.manager.longname@acme-township.example.com', 'township.engineer@acme-township.example.com',
          'construction.inspector@acme-township.example.com', 'accounts.payable@acme-township.example.com', 'owner.representative@acme-township.example.com'] }];
      const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const REPORTS = window.__REPORTS || [];
      const CONTACTS = [
        { id: 1, project_id: 'p1', email: 'project.manager.with.a.very.long.address@acme-township.example.com', name: 'Olivia Owner-Representative',
          title: 'Owner representative for the township', organization: 'Acme Township Department of Public Works', role: 'owner', auto_add: true },
        { id: 2, project_id: null, client_key: 'acme township', client_name: 'Acme Township', email: 'eng@acme.example', name: 'Ed Engineer', role: 'engineer', auto_add: false },
      ];
      const SCHEDS = [{ id: 901, custom_report_id: 1, report_name: 'Acme weekly owner update with a long name', jobs_mode: 'saved', frequency: 'weekly',
        days_of_week: [1, 3, 5], send_time: '06:30', timezone: 'America/Chicago', group_ids: [41], emails: ['pm@acme.example'], use_job_contacts: true,
        subject: 'Weekly', note: '', attach_pdf: true, enabled: true, next_run_at: '2026-11-09T12:30:00Z', last_status: 'failed',
        last_message: 'No saved contacts for Route 30 Resurfacing — the job has no contacts to send to', last_run_at: '2026-11-02T12:30:00Z' }];
      const GROUPS = [{ id: 41, name: 'Acme owners and engineers distribution list', emails: ['a@acme.example', 'b@acme.example'] }];
      const route = url => {
        const u = String(url);
        if (u.includes('/company/branding')) return { ok: true, branding: { display_name: 'Force Corp Paving & Sealcoating', logo: { mime: 'image/png', base64: PNG, width: 1, height: 1 },
          phone: '724-555-0000', address: '1 Industrial Way, Greensburg PA' }, canEdit: false };
        if (u.includes('/employees')) return { employees: [{ name: 'Pat Quinn', phone: '555-0199', email: 'pat@fc.example', logins: ['pat'] }] };
        if (u.includes('/report-contacts')) return { ok: true, contacts: CONTACTS, canEdit: true };
        if (u.includes('/custom-report-schedules')) return { schedules: SCHEDS, canSchedule: true, groups: [{ id: 41, name: GROUPS[0].name, count: 2 }] };
        if (u.includes('/recipient-groups')) return { ok: true, groups: GROUPS };
        if (/archive=1/.test(u)) return { html: '<!DOCTYPE html><html><head></head><body><h1>Archived</h1></body></html>' };
        if (/runs=1/.test(u)) return { runs: RUNS, next_before_id: /project_id/.test(u) ? 1 : null };
        return { reports: REPORTS, canShare: true, me: { userId: 7, username: 'pat' } };
      };
      window.fetch = async (url) => ({ ok: true, status: 200, json: async () => route(url) });
      // A stand-in AI panel: a message list and a box, as wide as it is given.
      window.FCTReportAI = { mount(el, adapter) {
        el.innerHTML = '<div style="padding:12px;display:flex;flex-direction:column;gap:8px"><div class="ai-msgs">Ask for a report in plain words.</div>'
          + '<textarea style="width:100%;min-height:80px"></textarea><button type="button">Send</button></div>';
        window.__aiAdapter = adapter;
        return {};
      } };
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
    await browserCheckV2(browser, page);
  } finally {
    await browser.close();
  }
}

// The v2 views at 390 px and 1440 px: Customer History, Contacts (with the
// form open), the step ① filter and step ③ fields, the Schedule… dialog and
// the AI drawer (a full-width sheet on a phone, a side drawer that pushes the
// builder over on a wide screen). Nothing scrolls sideways anywhere.
async function browserCheckV2(browser, basePage) {
  const saved = [{ id: 1, name: 'Acme weekly owner update', description: null, visibility: 'private', version: 1, can_edit: true, kind: 'report',
    customer_safe: true, owner_username: 'pat', updated_by_username: 'pat', updated_at: '2026-11-04T15:00:00Z',
    definition: { v: 2, title: 'Weekly', jobs: { mode: 'saved', ids: ['p1'] }, dates: { preset: 'last_week' }, sections: [{ type: 'job_info' }, { type: 'bid_progress' }] } }];
  const page = basePage.replace('<script>' + BRANDING + '</script>', `<script>window.__REPORTS = ${JSON.stringify(saved)};</script><script>${BRANDING}</script>`);
  for (const [w, hgt] of [[390, 844], [1440, 900]]) {
    const p = await browser.newPage({ viewport: { width: w, height: hgt } });
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.setContent(page);
    await p.waitForSelector('.cr-card');
    const wide = () => p.evaluate(() => document.documentElement.scrollWidth);
    const rail = async () => { if (w === 390) await p.click('.cr-railbtn'); };
    // Customer History
    await rail();
    await p.click('[data-act="customer"]');
    await p.selectOption('[data-bind="cust-job"]', 'p1');
    await p.waitForSelector('.cr-cust tbody tr');
    assert(`${w}px: Customer History, with a page of sends, does not scroll sideways`, await wide() <= w, await wide());
    const acts = await p.locator('.cr-cust [data-act="cust-open"]').first().boundingBox();
    assert(`${w}px: …its Open button is on screen`, acts && acts.x >= 0 && acts.x + acts.width <= w + 1, JSON.stringify(acts));
    // Contacts, form open
    await rail();
    await p.click('[data-act="contacts"]');
    await p.waitForSelector('.cr-ct-card');
    await p.click('[data-act="ct-add"]');
    assert(`${w}px: Contacts, with the add form open, does not scroll sideways`, await wide() <= w, await wide());
    // The builder: step ① filter, step ③ branding fields
    await rail();
    await p.click('[data-act="open"][data-id="1"]');
    await p.waitForSelector('.cr-filters [data-bind="filter-sc"]');
    assert(`${w}px: step ① with the sub-code filter does not scroll sideways`, await wide() <= w, await wide());
    await p.check('.cr-filters [data-bind="filter-sc"] >> nth=0');
    await p.waitForSelector('.cr-chip');
    assert(`${w}px: …nor with a filter chip`, await wide() <= w, await wide());
    await p.click('#cr-step-3');
    await p.waitForSelector('[data-bind="h-branding"]');
    assert(`${w}px: step ③ with branding and contact fields does not scroll sideways`, await wide() <= w, await wide());
    await p.waitForTimeout(400);
    const brand = await p.evaluate(() => { const f = document.querySelector('.cr-frame'); return f ? (f.getAttribute('srcdoc') || '') : ''; });
    assert(`${w}px: the preview carries the company name and logo`, /Force Corp Paving &amp; Sealcoating/.test(brand) && /<img class="mast-logo" src="data:image\/png/.test(brand));
    // Schedule… dialog
    await p.click('[data-act="schedule"]');
    await p.waitForSelector('#cr-s-freq');
    const dlg = await p.locator('.cr-modal-box').boundingBox();
    assert(`${w}px: the Schedule dialog fits the screen`, dlg && dlg.x >= 0 && dlg.x + dlg.width <= w + 1 && await wide() <= w, JSON.stringify(dlg));
    await p.click('[data-s="cancel"]');
    // AI drawer
    await p.click('[data-act="ai-toggle"] >> visible=true');
    await p.waitForSelector('.cr-ai-drawer:not([hidden]) textarea');
    const dr = await p.locator('.cr-ai-drawer').boundingBox();
    if (w === 390) {
      assert('390px: the AI builder is a full-width sheet', dr && Math.round(dr.x) === 0 && Math.round(dr.width) === 390, JSON.stringify(dr));
    } else {
      const pv = await p.locator('.cr-preview').boundingBox();
      assert('1440px: the AI builder is a 400 px drawer on the right', dr && Math.round(dr.width) === 400 && Math.round(dr.x + dr.width) === 1440, JSON.stringify(dr));
      assert('1440px: …and the builder moves over so the drawer covers none of it', pv && pv.x + pv.width <= dr.x + 1, JSON.stringify({ pv, dr }));
    }
    assert(`${w}px: with the AI drawer open nothing scrolls sideways`, await wide() <= w, await wide());
    await p.click('.cr-ai-x');
    assert(`${w}px: the × closes the drawer`, await p.isHidden('.cr-ai-drawer'));
    // The rail's schedules
    if (w === 1440) {
      const sch = await p.evaluate(() => {
        const r = document.querySelector('.cr-rail'), it = [...r.querySelectorAll('.cr-item')].find(x => /Acme weekly owner update with a long name/.test(x.textContent));
        return it ? { right: it.getBoundingClientRect().right, railRight: r.getBoundingClientRect().right, sw: r.scrollWidth, cw: r.clientWidth, text: it.textContent } : null;
      });
      assert('1440px: the rail lists the schedule — cadence, status and its failure — inside the rail', sch && sch.right <= sch.railRight + 1 && sch.sw <= sch.cw + 1
        && /Weekly Mon, Wed, Fri at 6:30 AM Central/.test(sch.text) && /No saved contacts/.test(sch.text), JSON.stringify(sch));
    }
    assert(`${w}px: v2 views raise no script errors`, errors.length === 0, errors.join('; '));
    await p.close();
  }
}
