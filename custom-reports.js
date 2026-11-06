/* eslint-disable no-undef */
/* DataWatch — Custom Reporting: the report builder
 *
 * Analytics → Custom Reporting. A PM picks some jobs, picks the sections and
 * columns a customer should see, and prints, emails or downloads the result —
 * then saves it by name, so next week's update for the same owner is one
 * click instead of an afternoon in a spreadsheet. This file is the screen and
 * the plumbing around it: the list of saved reports, the three-step builder,
 * the live preview, saving to /api/custom-reports, and the Print / Email /
 * Excel buttons with the send history behind them.
 *
 * It decides nothing about what a report says. Every catalog lookup, every
 * figure, the printable page and the workbook come from window.FCTReportEngine
 * (custom-reports-engine.js, loaded just before this file), so the preview,
 * the printout, the email and the spreadsheet are the same calls and cannot
 * disagree with each other.
 *
 * The host page configures it and renders it whenever the sub-tab opens:
 *
 *   FCTCustomReports.configure({ division, divisionLabel, apiBase, getToken,
 *     user, perm, areaUnit, ready, getProjects, getPurchaseOrders,
 *     getTruckingEntries, helpers, onAuthError });
 *   FCTCustomReports.renderTab(mountEl);   // safe to call again and again
 *
 * Customer-safe is the default, and the point of the feature. A report cannot
 * show a cost, rate, hour, employee name or contract figure until someone
 * switches "Include internal data" on and confirms it; while it is on, a red
 * banner sits over the builder and the printed report carries an INTERNAL
 * tag. The engine applies the same rule to its output, so a locked column
 * cannot leak even when a saved definition names one — this file's job is to
 * make the rule visible, so nobody is surprised by what went to a customer.
 *
 * Around the builder (definition v2): a report-wide sub code / cost code
 * filter, the company's branding and each job's project manager fed into the
 * engine, saved customer contacts that pre-fill the email, a per-job
 * Customer History that can reopen or resend exactly what a customer was
 * sent, scheduled sends of a saved customer-safe report, and a drawer for the
 * AI report builder (custom-reports-ai.js). The AI and the schedules can
 * never switch internal data on: only the same confirm a person answers can.
 *
 * Like documents.js it brings no stylesheet to the page: one injected
 * <style id="cr-styles"> scoped under .cr-root, built on the host page's CSS
 * variables, so the tab takes each division's accent colour. Every click,
 * change and keystroke is handled by listeners delegated from the mount, and
 * every piece of user text goes through the engine's escHtml on its way into
 * markup — no handler string ever carries a report, job or client name, so a
 * name can never turn into script.
 */
(function () {
  'use strict';
  if (window.FCTCustomReports) return; // already loaded

  const Z = 10070;                // above documents.js (10060) and report-email.js (10050)
  const PREVIEW_DELAY = 250;      // ms of quiet after a change before the preview redraws
  const PREVIEW_MAX_DELAY = 1500; // …stretched to twice a slow build, up to this
  const SLOW_BUILD_MS = 120;      // a build this slow waits for typing to pause
  const TYPING_IDLE   = 800;      // ms without a keystroke that counts as a pause
  const READY_WAIT_MS = 20000;    // longest a print / email / download waits for old daily rows
  const ENGINE_TRIES  = 50;       // × 200 ms — the deferred engine normally arrives first
  const MAX_JOBS      = 500;      // what the API will log against one run
  const MAX_SECTIONS  = 20;       // what normalizeDefinition keeps
  const SHEET_PX      = { portrait: 816, landscape: 1056 };   // a letter sheet, 96 px to the inch
  const MIN_FIT       = 0.55;     // below this a scaled page is too small to read
  const PHONE_BELOW   = 900;      // a viewport narrower than this (a phone: the panes stack) reflows the report
  const ZOOM_KEY      = 'fct_cr_preview_zoom';
  // send-report refuses report HTML over 1.5 MB; the DataWatch band and the
  // JSON around it need some of that.
  const EMAIL_HTML_LIMIT = 1400000;
  const SELECT_ALL_ASK = 50;      // "Select all shown" with no search asks first past this
  const DRAFT_KEY     = 'fct_cr_draft_';  // + division: a report kept over a sign-out
  const SIDE_TTL      = 5 * 60 * 1000;    // branding / contacts are fetched again on a tab visit after this
  const MAX_FILTER    = 200;              // codes in one filter list (normalizeDefinition keeps this many)
  const MAX_CODES_AI  = 500;              // codes handed to the AI builder, of each kind
  const MAX_IDS_CALL  = 200;              // project ids / client keys in one /api/report-contacts call
  const MAX_SCHED_EMAILS = 50;
  const MAX_SEND_TO      = 50;            // addresses one email can go to (send-report's cap)
  const MAX_SCHED_JOBS   = 100;
  const AI_SHEET_BELOW   = 1200;          // the AI drawer is a full-width sheet below this
  const SCHED_TZ = [
    ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'],
    ['America/Denver', 'Mountain'], ['America/Los_Angeles', 'Pacific'],
  ];
  const CONTACT_ROLES = [['owner', 'Owner'], ['gc', 'General contractor'], ['engineer', 'Engineer'],
    ['inspector', 'Inspector'], ['internal', 'Internal'], ['other', 'Other']];
  const RUN_KIND_LABEL = { schedule: 'Scheduled', send_now: 'Scheduled (sent now)', resend: 'Resent' };
  const INTERNAL_MARK = /\bdata-cr-internal\s*=\s*["']?1\b/;

  const INTERNAL_CONFIRM = 'This report will be able to show costs, rates, hours, employee names and profit. '
    + "Don't send it to a customer. Continue?";
  const SCHEDULED_NOTE = 'This report is scheduled — scheduled sends will stop until it is customer-safe again.';
  // The same, said when the schedules list could not be had to check.
  const MAYBE_SCHEDULED_NOTE = 'If a schedule sends this report, its scheduled sends will stop until it is customer-safe again.';
  const OUTDATED_MSG = 'DataWatch was updated — reload the page to keep editing. Your changes are kept and will be offered back after the reload.';
  const INTERNAL_ARCHIVE_MSG = 'Only the sender or an admin/level 3 can open internal reports.';
  const REBUILT_BANNER = 'Rebuilt from current data — the original was not archived';
  const EXCEL_INTERNAL_CONFIRM = 'This workbook includes internal data — costs, rates, hours, employee names or profit. '
    + 'Download it anyway? Do not send it to a customer.';

  let E = null;                   // window.FCTReportEngine, once it has loaded

  function defaults() {
    return {
      division: 'turf', divisionLabel: '', apiBase: '/api', getToken: null, user: null,
      perm: {}, areaUnit: '', ready: null, getProjects: () => [], getPurchaseOrders: () => [],
      getTruckingEntries: () => [], helpers: {}, onAuthError: null,
    };
  }
  let cfg = defaults();

  // ── State ───────────────────────────────────────────────────────────
  // One object, so a test can look at all of it through _internals.state().
  // The open report (`doc`) lives here and nowhere else: if the API is down
  // the user's work stays on screen and in memory until a save gets through.
  const S = {
    mount: null,
    configured: false,
    view: 'home',                 // 'home' | 'edit' | 'history' | 'customer' | 'contacts'
    reports: [], loaded: false, loading: false, loadError: '', loadP: null,
    // Side data the report is dressed with, fetched quietly: a failure just
    // means an unbranded report with no PM line.
    branding: null, brandingAt: 0, brandingP: null, brandingCanEdit: false,
    people: null, peopleP: null,
    // Saved customer contacts for the whole division (the manager, the
    // step ① badges); `contactsAt` 0 = not loaded.
    contacts: null, contactsAt: 0, contactsP: null, contactsError: '', contactsCanEdit: false,
    contactsSearch: '', contactsJob: '', contactEdit: null,   // contactEdit: { id|null, ...form }
    // Customer History: the job chosen and its emails, a page at a time.
    cust: { jobId: '', client: '', search: '', runs: null, loading: false, error: '', next: null, more: false, busy: null },
    // Scheduled sends of saved custom reports (admin / level 3).
    // schedBusy: the schedules a Send now is out for; schedToggling: those a
    // Pause / Resume is out for; schedSaving: those an Edit…'s save is out for
    // (its dialog may be closed meanwhile). Each one's ⋯ is off until its
    // answer lands, so nothing is opened from the copy from before.
    scheds: null, schedsLoading: false, schedsError: '', canSchedule: false, schedGroups: null, schedBusy: new Set(), schedToggling: new Set(),
    schedSaving: new Set(),
    // The report-wide sub code / cost code filter's search box.
    filterSearch: '', focusFilter: false,
    // The AI builder drawer.
    ai: { open: false, el: null, handle: null, docRef: null },
    reloading: false,             // the "DataWatch was updated" Reload: don't ask before leaving
    canShare: false, me: null,
    deleted: null, deletedOpen: false, deletedLoading: false, deletedError: '',
    runs: null, runsLoading: false, runsError: '', runsNext: null, runsMore: false,
    search: '', railOpen: false,
    doc: null,                    // the report in the builder — see blankDoc()
    step: 1,
    collapsed: new Set(),         // section ids folded shut in step 2
    jobSearch: '',
    editLabel: null,              // { sec, key, orig } while a column label is being renamed
    saving: false,                // a Save is out (of any report)
    // What each Save now out sent ({ doc, typedName, typedDesc, key }): one
    // per report at most, so a Save still out for a report left behind never
    // holds up the next one's.
    saves: new Set(),
    visBusy: new Set(),           // report ids a Share / Make private is out for
    deleting: new Set(),          // report ids a Delete is out for (its confirm included)
    busy: { email: false, excel: false },   // an output waiting on the old daily rows
    readyP: null, readyDone: false,
    lastBuildMs: 0, lastTypeAt: 0,
    lastJobCount: -1, jobWatch: 0,
    zoom: 'fit',                  // the preview: 'fit' (scaled to the pane) or '100' (actual size)
    pvTimer: 0, pvScroll: 0,
    menuEl: null, menuTrigger: null,
    lastBanners: null, lastSteps: null,
    engineTries: 0, engineTimer: 0,
    toastEl: null, toastTimer: 0,
  };

  // ── Small helpers ───────────────────────────────────────────────────
  const esc = s => E.escHtml(s);
  const txt = v => (v == null ? '' : String(v)).trim();
  const perm = () => cfg.perm || {};
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const sameId = (a, b) => String(a) === String(b);

  function projects() {
    try {
      const p = typeof cfg.getProjects === 'function' ? cfg.getProjects() : [];
      return Array.isArray(p) ? p.filter(x => x && x.id != null) : [];
    } catch (_) { return []; }
  }
  function userName() {
    const u = cfg.user || {};
    return txt(u.name) || txt(u.username) || txt(S.me && S.me.username);
  }
  function divLabel() { return txt(cfg.divisionLabel) || 'the division'; }
  const jobName = p => txt(p && p['project-name']) || 'Untitled job';
  const projectById = id => projects().find(p => sameId(p.id, id)) || null;
  // The server's client key: lower(btrim(client)).
  const clientKey = c => txt(c).toLowerCase();

  // The starter templates this division offers (Paving Tonnage is paving's).
  function starters() {
    try { if (typeof E.startersFor === 'function') return E.startersFor(cfg.division) || []; } catch (_) { /* fall through */ }
    return (E.STARTERS || []).filter(s => !Array.isArray(s.divisions) || s.divisions.includes(cfg.division));
  }
  /* The distinct sub codes on these jobs' bid items, from the engine. An
     engine that predates the sub-code filter has none to offer, and the
     picker says so rather than inventing its own list. */
  function subCodesFor(jobs) {
    try {
      if (typeof E.subCodesFor === 'function') {
        const out = E.subCodesFor(jobs);
        return Array.isArray(out) ? out.filter(x => x && txt(x.code)) : [];
      }
    } catch (_) { /* fall through */ }
    return [];
  }
  const subCodeText = sc => {
    const desc = txt(sc.description), unit = txt(sc.unit);
    return `${txt(sc.code)}${desc ? ' — ' + desc : ''}${unit ? ` (${unit})` : ''}`;
  };

  // The local calendar day of a timestamp, as the engine's "today".
  function localDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* The Team Directory (GET /api/employees?view=people) names the people
     behind the free-text "PM" on a job and behind the user's login. A name
     matches case-blind, and "Last, First" matches "First Last". */
  function nameKey(n) {
    let s = txt(n).toLowerCase().replace(/\s+/g, ' ');
    const m = /^([^,]+),\s*(.+)$/.exec(s);
    if (m) s = `${m[2].trim()} ${m[1].trim()}`;
    return s;
  }
  function personNamed(name) {
    const k = nameKey(name);
    if (!k || !Array.isArray(S.people)) return null;
    return S.people.find(p => p && !p.login && nameKey(p.name) === k) || null;
  }
  function personForLogin(username) {
    const u = txt(username).toLowerCase();
    if (!u || !Array.isArray(S.people)) return null;
    return S.people.find(p => p && !p.login && Array.isArray(p.logins) && p.logins.some(l => txt(l).toLowerCase() === u)) || null;
  }
  // "Prepared by": the person behind the login, else the login itself.
  function preparerName() {
    const u = cfg.user || {};
    const person = personForLogin(txt(u.username) || txt(S.me && S.me.username));
    return (person && txt(person.name)) || userName();
  }
  // A job's project manager, as the engine takes it — only when the
  // directory has a phone or an email for them.
  function pmContactFor(p) {
    const person = personNamed(p && p.pm);
    if (!person || !(txt(person.phone) || txt(person.email))) return null;
    return { name: txt(person.name), phone: txt(person.phone), email: txt(person.email) };
  }

  /* Internal, by the engine's rule (with the division, so a division-only
     internal column counts) or by the INTERNAL stamp on the built page.
     Belt and braces: the question before an email, a download or a resend is
     the one place a customer may be on the other end. */
  function defIsInternal(def) {
    try { if (E.hasInternal(def, perm(), cfg.division)) return true; } catch (_) { /* fall through */ }
    const d = def || {};
    if (d.includeInternal !== true || !Array.isArray(d.sections)) return false;
    return d.sections.some(s => {
      const cat = E.CATALOG[s.type];
      if (!cat || !Array.isArray(s.columns)) return false;
      return s.columns.some(k => {
        const c = cat.columns.find(x => x.key === k);
        return c && c.internal && E.columnState(s.type, k, d, perm(), cfg.division) === 'available';
      });
    });
  }
  const builtIsInternal = built => defIsInternal(built.def) || INTERNAL_MARK.test(built.html || '');

  // "3 days ago" for the list — the question there is "is this the one I
  // touched last week", which a relative time answers faster than a date.
  function ago(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${plural(h, 'hour')} ago`;
    const d = Math.round(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 30) return `${d} days ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // ── API client ──────────────────────────────────────────────────────
  // Same contract as every other call on the pages: Bearer token, the
  // division on the query string, and a 401 hands back to the page's own
  // logout so an expired session ends cleanly rather than failing in pieces.
  function token() {
    try { if (typeof cfg.getToken === 'function') return cfg.getToken() || ''; } catch (_) { /* fall through */ }
    try { return localStorage.getItem('fct_token') || ''; } catch (_) { return ''; }
  }
  function failure(message, status, data) {
    const e = new Error(message);
    e.status = status;
    e.data = data;
    return e;
  }
  /* One call to /api/<path>. opts.division === false leaves ?division= off
     (company-wide endpoints); opts.quiet leaves a 401 to the caller — the
     side fetches (branding, the directory) must not sign anyone out on their
     own, the report list's own call does that. */
  async function call(path, method, params, body, opts) {
    opts = opts || {};
    const qs = new URLSearchParams();
    if (opts.division !== false) qs.set('division', cfg.division);
    Object.keys(params || {}).forEach(k => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    const init = { method, headers: { Authorization: 'Bearer ' + token() } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const base = String(cfg.apiBase || '/api').replace(/\/+$/, '');
    const q = qs.toString();
    let r;
    try { r = await fetch(`${base}/${path}${q ? '?' + q : ''}`, init); }
    catch (_) { throw failure('Could not reach the server — check the connection and try again.', 0, null); }
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (r.status === 401 && !opts.quiet) {
      // The page's logout leaves the page. Keep the open report first, so it
      // can be offered back after signing in rather than lost with the page.
      saveDraft();
      try { if (typeof cfg.onAuthError === 'function') cfg.onAuthError(); } catch (_) { /* the page's problem */ }
      throw failure('Your session has expired. Please sign in again.', 401, data);
    }
    if (r.status === 409 && data && data.error === 'client_outdated') {
      // This page's copy of the builder is older than the report it is
      // saving over (a v2 report, a v1 save would strip). Keep the work
      // and ask for a reload.
      saveDraft();
      showOutdated();
      throw failure(OUTDATED_MSG, 409, data);
    }
    if (!r.ok) throw failure((data && (data.message || data.error)) || `Request failed (${r.status})`, r.status, data);
    return data || {};
  }
  const request = (method, params, body) => call('custom-reports', method, params, body);
  const api = {
    request,
    call,
    list:    () => request('GET'),
    deleted: () => request('GET', { deleted: 1 }),
    // runs(reportId) as before, or runs({ project_id, action, kind, before_id })
    runs:    p => request('GET', Object.assign({ runs: 1 }, p != null && typeof p === 'object' ? p : { report_id: p })),
    runOne:  id => request('GET', { run: id }),
    archive: id => request('GET', { run: id, archive: 1 }),
    create:  body => request('POST', null, body),
    update:  (id, body) => request('PUT', { id }, body),
    remove:  id => request('DELETE', { id }),
    restore: id => request('POST', { action: 'restore', id }),
    run:     body => request('POST', { action: 'run' }, body),
    branding: () => call('company/branding', 'GET', null, undefined, { division: false, quiet: true }),
    people:   () => call('employees', 'GET', { view: 'people' }, undefined, { division: false, quiet: true }),
    contacts: p => call('report-contacts', 'GET', p || null),
    contactsQuiet: p => call('report-contacts', 'GET', p || null, undefined, { quiet: true }),
    addContact:    body => call('report-contacts', 'POST', null, body),
    updateContact: (id, body) => call('report-contacts', 'PUT', { id }, body),
    removeContact: id => call('report-contacts', 'DELETE', { id }),
    schedules:      () => call('custom-report-schedules', 'GET'),
    scheduleRuns:   id => call('custom-report-schedules', 'GET', { runs: id }),
    createSchedule: body => call('custom-report-schedules', 'POST', null, body),
    updateSchedule: (id, body) => call('custom-report-schedules', 'PUT', { id }, body),
    removeSchedule: id => call('custom-report-schedules', 'DELETE', { id }),
    sendSchedule:   id => call('custom-report-schedules', 'POST', { id, action: 'run' }),
    // Every company group, each with its report type: the dialog keeps the
    // ones it may offer, and can tell a deleted group from one it hides.
    groups: () => call('email/recipient-groups', 'GET', {}, undefined, { division: false, quiet: true }),
  };
  const code = e => (e && e.data && e.data.error) || '';

  // ── Full daily-row history ──────────────────────────────────────────
  // The pages load the last 90 days of daily rows first and backfill the rest
  // in the background; cfg.ready() settles when that is done. The preview
  // draws straight away and redraws when it lands. A print, email or download
  // waits for it, so a job-to-date figure is never short — but not forever: if
  // the backfill hangs, the output goes ahead after READY_WAIT_MS rather than
  // leaving the user staring at a button that does nothing.
  function readyPromise() {
    if (S.readyDone) return Promise.resolve();
    if (!S.readyP) {
      let p;
      try { p = typeof cfg.ready === 'function' ? cfg.ready() : undefined; } catch (_) { p = undefined; }
      S.readyP = Promise.resolve(p).then(() => {}, () => {}).then(() => {
        S.readyDone = true;
        S.readyP = null;
        if (!S.doc || S.view !== 'edit') return;
        // Step ① drawn before the jobs were in ("Loading jobs…") is redrawn.
        const stale = S.mount && (S.mount.querySelector('.cr-jobs-loading') || projects().length !== S.lastJobCount);
        if (stale && S.step === 1) jobsArrived(); else schedulePreview(true);
      });
    }
    return S.readyP;
  }
  function whenReady() {
    if (S.readyDone) return Promise.resolve();
    return Promise.race([readyPromise(), new Promise(r => setTimeout(r, READY_WAIT_MS))]);
  }

  // ── The open report ─────────────────────────────────────────────────
  // `def` is a normalized v1 definition that the builder edits in place. The
  // job picker's selection is kept apart from it in `picked`, because whether
  // those jobs are SAVED with the report is the user's choice (saveJobs): a
  // template saves none and asks again each run.
  function blankDoc(def, extra) {
    const d = E.normalizeDefinition(def);
    return Object.assign({
      id: null, starterId: null, name: '', description: '', visibility: 'private', version: 0,
      can_edit: true, readOnly: false, owner_username: '', updated_by_username: '', updated_at: null,
      def: d, saveJobs: d.jobs.mode === 'saved', picked: [], missing: 0,
      savedName: null, savedDesc: '', savedDefKey: null, touched: false,
    }, extra || {});
  }

  // What gets stored: the definition with the jobs as the user chose to save
  // them. Normalized on the way out so junk never reaches the API.
  function defForSave(doc) {
    doc = doc || S.doc;
    const d = E.normalizeDefinition(doc.def);
    d.jobs = doc.saveJobs ? { mode: 'saved', ids: doc.picked.slice(0, MAX_JOBS) } : { mode: 'pick', ids: [] };
    return d;
  }
  const defKey = doc => JSON.stringify(defForSave(doc));
  function markClean(doc) {
    doc.savedName = doc.name;
    doc.savedDesc = doc.description || '';
    doc.savedDefKey = defKey(doc);
    doc.touched = false;
  }
  // A report that has never been saved is always "unsaved"; a saved one is
  // when its name, description or stored definition would change. Picking
  // jobs on a template changes nothing stored, so it is not a change.
  function isDirty(doc) {
    doc = doc || S.doc;
    if (!doc) return false;
    if (!doc.id) return true;
    return doc.name.trim() !== doc.savedName || txt(doc.description) !== txt(doc.savedDesc)
      || defKey(doc) !== doc.savedDefKey;
  }
  function hasUnsavedWork() {
    const d = S.doc;
    if (!d) return false;
    return d.id ? isDirty(d) : d.touched;
  }
  // The Save of this report now on its way (from its click: it may still be
  // waiting on the schedules list), or null.
  function sentFor(d) {
    for (const s of S.saves) if (s.doc === d) return s;
    return null;
  }
  // Has the open report changed since the save now on its way was sent?
  function changedSinceSent(d) {
    const sent = sentFor(d);
    if (!sent) return true;
    return d.name.trim() !== sent.typedName || txt(d.description) !== sent.typedDesc || defKey(d) !== sent.key;
  }
  function okToLeave() {
    const d = S.doc;
    if (!d) return true;
    const name = d.name.trim() || d.savedName || 'this report';
    // A save on its way finishes whether or not the report stays open, so
    // leaving loses nothing — unless something changed after it was sent.
    if (sentFor(d)) {
      if (!changedSinceSent(d)) return true;
      return window.confirm(`"${name}" is still saving, but the changes you made after clicking Save will be lost. Leave anyway?`);
    }
    if (!hasUnsavedWork()) return true;
    if (!window.confirm(`You have unsaved changes to "${name}". Discard them?`)) return false;
    clearDraft();
    return true;
  }

  // ── A report kept over a sign-out ───────────────────────────────────
  // An expired session hands back to the page's logout, which leaves the
  // page. The open report is kept in this tab's sessionStorage first and
  // offered back the next time the tab opens. Per viewer, per tab, and
  // best-effort: storage can be missing or full, and then it is simply not
  // kept.
  function draftKey() { return DRAFT_KEY + cfg.division; }
  function saveDraft() {
    const d = S.doc;
    if (!d || !hasUnsavedWork()) return;
    try {
      sessionStorage.setItem(draftKey(), JSON.stringify({
        at: Date.now(), id: d.id, starterId: d.starterId, name: d.name, description: d.description || '',
        visibility: d.visibility, version: d.version, def: E.normalizeDefinition(d.def), saveJobs: !!d.saveJobs,
        picked: d.picked.slice(0, MAX_JOBS),
      }));
    } catch (_) { /* not kept — nothing else to do */ }
  }
  function readDraft() {
    try {
      const raw = sessionStorage.getItem(draftKey());
      const o = raw ? JSON.parse(raw) : null;
      return o && typeof o === 'object' && o.def && typeof o.def === 'object' ? o : null;
    } catch (_) { return null; }
  }
  function clearDraft() {
    try { sessionStorage.removeItem(draftKey()); } catch (_) { /* nothing kept */ }
  }
  async function offerDraft() {
    const o = readDraft();
    if (!o || S.doc) return;
    const name = txt(o.name) || 'Untitled report';
    const choice = await choose('Restore your unsaved report?',
      `“${name}” had unsaved changes when your session ended. Restore it, or discard those changes?`,
      [{ label: 'Discard', value: 'discard' }, { label: 'Restore', value: 'restore', primary: true }]);
    if (choice === 'discard') { clearDraft(); return; }
    if (choice !== 'restore' || S.doc) return;
    clearDraft();
    const doc = blankDoc(o.def, {
      id: o.id != null ? o.id : null, starterId: o.starterId || null, name: String(o.name || ''),
      description: String(o.description || ''), visibility: o.visibility === 'shared' ? 'shared' : 'private',
      version: Number(o.version) || 0, saveJobs: !!o.saveJobs,
      picked: Array.isArray(o.picked) ? o.picked.slice(0, MAX_JOBS) : [], touched: true,
    });
    const r = doc.id != null ? S.reports.find(x => sameId(x.id, doc.id)) : null;
    if (doc.id != null) {
      // Against the copy that is saved now, so Save goes where it was going —
      // and a version that has moved on meets the usual conflict question.
      doc.can_edit = r ? !!r.can_edit : true;
      doc.readOnly = !doc.can_edit;
      doc.savedName = r ? r.name : '';
      doc.savedDesc = r ? (r.description || '') : '';
    }
    startEditing(doc);
    toast('Restored your unsaved report. Save it to keep it.');
  }

  function currentJobs() {
    if (!S.doc) return [];
    return E.resolveJobs(S.doc.def, projects(), S.doc.picked).jobs;
  }
  const internalOn = () => !!(S.doc && S.doc.def.includeInternal === true && perm().canSeeCosts !== false);
  const findSec = id => (S.doc ? S.doc.def.sections.find(s => s.id === id) : null);

  /* The definition as it is about to be printed: the picked jobs, and the two
     header lines filled in when left blank — "Prepared for" the job's client
     on a one-job report, "Prepared by" whoever is running it. Filled here
     rather than stored, so a saved template prints the right client for
     whichever job it is run against next week. */
  function renderDefinition() {
    const d = E.normalizeDefinition(S.doc.def);
    d.jobs = { mode: S.doc.saveJobs ? 'saved' : 'pick', ids: S.doc.picked.slice(0, MAX_JOBS) };
    const jobs = currentJobs();
    if (!txt(d.header.preparedFor) && jobs.length === 1) d.header.preparedFor = txt(jobs[0].client);
    if (!txt(d.header.preparedBy)) d.header.preparedBy = preparerName();
    return d;
  }

  /* What the report is dressed with — never stored in the definition (the
     logo alone would blow its 64 KB cap), resolved fresh for each build:
       branding      the company's display name, logo and contact line;
       contacts      { [jobId]: { pm } } from the Team Directory;
       reportContact the "Questions?" line: the header's override when any of
                     its three fields is typed, else the one PM every picked
                     job shares, else the person running the report. */
  function brandingOpt() {
    const b = S.branding;
    if (!b || typeof b !== 'object') return null;
    const logo = b.logo && typeof b.logo === 'object' && /^image\/(png|jpeg)$/.test(String(b.logo.mime || ''))
      && typeof b.logo.base64 === 'string' && b.logo.base64
      ? { mime: b.logo.mime, base64: b.logo.base64, width: Number(b.logo.width) || null, height: Number(b.logo.height) || null } : null;
    return {
      display_name: txt(b.display_name), logo, phone: txt(b.phone), email: txt(b.email),
      website: txt(b.website), address: txt(b.address), report_footer: txt(b.report_footer),
    };
  }
  function contactsOpt(jobs) {
    const out = {};
    (jobs || []).forEach(p => { const pm = pmContactFor(p); if (pm) out[String(p.id)] = { pm }; });
    return out;
  }
  function defaultReportContact(jobs) {
    const pms = (jobs || []).map(pmContactFor);
    if (pms.length && pms.every(Boolean) && pms.every(x => nameKey(x.name) === nameKey(pms[0].name))) return pms[0];
    const u = cfg.user || {};
    const me = personForLogin(txt(u.username) || txt(S.me && S.me.username));
    if (me && (txt(me.phone) || txt(me.email))) return { name: txt(me.name), phone: txt(me.phone), email: txt(me.email) };
    return null;
  }
  function reportContactFor(def, jobs) {
    const h = (def && def.header) || {};
    const typed = { name: txt(h.contactName), phone: txt(h.contactPhone), email: txt(h.contactEmail) };
    if (typed.name || typed.phone || typed.email) return typed;
    return defaultReportContact(jobs);
  }
  function dressing(def, jobs) {
    return { branding: brandingOpt(), contacts: contactsOpt(jobs), reportContact: reportContactFor(def, jobs) };
  }

  /* What the open report is right now, frozen: the definition to print, the
     picked jobs, and the names it is logged under. An output that has to
     wait (for the older daily rows) builds from this, so the report that
     comes out is the one that was clicked — not whatever is open, or has
     been edited, by the time it is ready. */
  function snapshot() {
    const d = S.doc;
    const def = renderDefinition();
    return {
      doc: d, def, picked: d.picked.slice(0, MAX_JOBS),
      reportName: d.name.trim() || d.savedName || '',
      reportId: d.id != null ? d.id : null,
      logName: d.savedName || d.name.trim(),
      dress: dressing(def, currentJobs()),
    };
  }
  function buildFrom(snap, opts) {
    const dress = snap.dress || {};
    const ctx = E.makeContext(snap.def, cfg, Object.assign({
      pickedIds: snap.picked, reportName: snap.reportName, userName: preparerName(),
      branding: dress.branding || null, contacts: dress.contacts || {}, reportContact: dress.reportContact || null,
    }, snap.ctxOpts || {}));
    const html = opts && opts.html === false ? '' : E.buildReportHtml(snap.def, ctx);
    return { def: snap.def, ctx, html, snap };
  }
  function buildCurrent(opts) { return buildFrom(snapshot(), opts); }

  // ── Styles ──────────────────────────────────────────────────────────
  // Scoped under .cr-root (and .cr-modal / .cr-toast, which live on <body>).
  // Colours are the host page's variables with dark-theme fallbacks, so the
  // tab is green on Turf, blue on Paving and gold on Kiewit without knowing
  // which page it is on. Secondary text dims with opacity rather than
  // --muted, which is too faint for anything a user has to read.
  function injectStyles() {
    if (document.getElementById('cr-styles')) return;
    const el = document.createElement('style');
    el.id = 'cr-styles';
    el.textContent = `
.cr-root{--crb:var(--border,#2a2a3a);--cra:var(--green,#22c55e);--crs:var(--surface,#111118);--crs2:var(--surface2,#1a1a26);--crbg:var(--bg,#0a0a0f);--crt:var(--text,#e0e0e0);
  display:flex;gap:1rem;align-items:flex-start;min-width:0;color:var(--crt);font-size:13px;line-height:1.4}
.cr-root *,.cr-modal *,.cr-toast *{box-sizing:border-box}
.cr-root :focus-visible,.cr-modal :focus-visible{outline:2px solid var(--green,#22c55e);outline-offset:1px}
.cr-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.cr-root .btn,.cr-modal .btn{gap:.35rem;white-space:nowrap;font-size:.76rem;padding:.38rem .75rem;line-height:1.2}
.cr-root .btn:disabled,.cr-modal .btn:disabled{opacity:.42;cursor:not-allowed}
.cr-root .btn.cr-sm{font-size:.72rem;padding:.26rem .55rem}
.cr-input{background:var(--bg,#0a0a0f);border:1px solid var(--border,#2a2a3a);color:var(--text,#e0e0e0);border-radius:4px;padding:.36rem .55rem;font:inherit;font-size:.8rem;min-width:0;max-width:100%}
.cr-input:focus{border-color:var(--green,#22c55e);outline:none}
.cr-input::placeholder{color:var(--text,#e0e0e0);opacity:.38}
textarea.cr-input{width:100%;resize:vertical;line-height:1.45;display:block}
select.cr-input.cr-sm{font-size:.74rem;padding:.26rem .4rem}
.cr-root input[type=checkbox],.cr-root input[type=radio],.cr-modal input[type=checkbox]{accent-color:var(--green,#22c55e);width:15px;height:15px;flex:none;margin:0;cursor:pointer}
.cr-root input:disabled{cursor:not-allowed}
.cr-hint{display:block;font-size:.72rem;opacity:.6;line-height:1.4}
.cr-hint-i{font-size:.72rem;opacity:.6;font-weight:400;text-transform:none;letter-spacing:0}
.cr-empty{font-size:.78rem;opacity:.6;padding:.6rem .2rem;margin:0}
.cr-alert{background:rgba(127,29,29,.3);border:1px solid #7f1d1d;color:#fecaca;border-radius:5px;padding:.5rem .6rem;font-size:.76rem;line-height:1.4;margin:.4rem 0;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.cr-linkbtn{background:none;border:0;padding:0;color:var(--green,#22c55e);font:inherit;font-size:.74rem;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
/* rail */
.cr-rail{flex:0 0 280px;width:280px;background:var(--crs);border:1px solid var(--crb);border-radius:6px;padding:.65rem;position:sticky;top:.5rem;max-height:calc(100vh - 6rem);overflow-y:auto}
.cr-rail-top{display:flex;flex-direction:column;gap:.45rem}
.cr-rail-top .cr-input{width:100%}
.cr-rail-top .btn{justify-content:center}
.cr-group{margin-top:.85rem}
.cr-group-h{display:flex;justify-content:space-between;align-items:baseline;font-size:.64rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;opacity:.6;margin:0 0 .3rem;padding:0 .25rem}
.cr-group-toggle{display:flex;align-items:center;gap:.35rem;width:100%;background:none;border:0;color:var(--crt);font:inherit;font-size:.64rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;opacity:.75;padding:.3rem .25rem;cursor:pointer;border-radius:4px;text-align:left}
.cr-group-toggle:hover{opacity:1;background:var(--crs2)}
.cr-item{position:relative;display:flex;align-items:stretch;border-radius:5px;margin-bottom:2px}
.cr-item:hover{background:var(--crs2)}
.cr-item.active{background:var(--crs2);box-shadow:inset 3px 0 0 var(--cra)}
.cr-item-open{flex:1 1 auto;min-width:0;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:.42rem .5rem .45rem .6rem;cursor:pointer;display:flex;flex-direction:column;gap:.22rem;border-radius:5px}
.cr-item-name{font-weight:600;font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.cr-item-meta{font-size:.68rem;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.cr-item-more{flex:none;width:2rem;background:none;border:0;color:var(--crt);opacity:.55;font-size:1rem;cursor:pointer;border-radius:5px}
.cr-item-more:hover,.cr-item-more[aria-expanded=true]{opacity:1;background:var(--crb)}
.cr-item-act{flex:none;align-self:center;margin-right:.3rem}
.cr-badges{display:flex;flex-wrap:wrap;gap:.25rem}
.cr-badge{font-size:.58rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:.06rem .35rem;border-radius:3px;border:1px solid var(--crb);opacity:.85;white-space:nowrap}
.cr-badge.shared{color:var(--cra);border-color:var(--cra)}
.cr-badge.internal{color:#fca5a5;border-color:#7f1d1d;background:rgba(127,29,29,.35);opacity:1}
.cr-badge.safe{color:#86efac;border-color:#14532d}
.cr-histlink{margin-top:.9rem;width:100%;justify-content:center}
/* main */
.cr-main{flex:1 1 auto;min-width:0}
.cr-root .cr-railbtn{display:none;align-self:flex-start}
.cr-loading{opacity:.7;padding:1rem 0;font-size:.85rem}
.cr-h2{font-size:1rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin:0}
.cr-h3{font-size:.72rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;opacity:.7;margin:1.1rem 0 .55rem}
.cr-home{max-width:64rem}
.cr-lead{opacity:.85;max-width:46rem;margin:.45rem 0 .5rem;font-size:.85rem;line-height:1.5}
.cr-safenote{display:inline-flex;gap:.45rem;align-items:flex-start;font-size:.78rem;line-height:1.45;background:var(--crs);border:1px solid var(--crb);border-radius:5px;padding:.5rem .7rem;max-width:46rem}
.cr-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,225px),1fr));gap:.65rem}
.cr-card{display:flex;flex-direction:column;gap:.35rem;text-align:left;background:var(--crs);border:1px solid var(--crb);border-radius:6px;padding:.8rem .85rem;color:inherit;font:inherit;cursor:pointer;min-height:8rem;transition:border-color .15s,background .15s}
.cr-card:hover{border-color:var(--cra);background:var(--crs2)}
.cr-card-name{font-weight:700;font-size:.88rem;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}
.cr-card-blurb{font-size:.76rem;opacity:.75;line-height:1.45}
.cr-card-secs{font-size:.68rem;opacity:.5;margin-top:auto;line-height:1.4}
.cr-card.blank{border-style:dashed;align-items:center;justify-content:center;text-align:center}
.cr-card.blank .cr-card-name{font-size:.95rem;color:var(--cra)}
/* editor */
.cr-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .7rem;margin-bottom:.6rem}
.cr-name{flex:1 1 15rem;min-width:0;background:transparent;border:1px solid transparent;border-radius:4px;color:var(--crt);font:inherit;font-size:1.05rem;font-weight:700;padding:.28rem .45rem}
.cr-name:hover{border-color:var(--crb)}
.cr-name:focus{border-color:var(--cra);background:var(--crbg);outline:none}
.cr-name::placeholder{color:var(--crt);opacity:.4}
.cr-dirty{font-size:.72rem;font-weight:600;color:var(--yellow,#eab308);white-space:nowrap}
.cr-dirty[hidden]{display:none}
.cr-actions{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.cr-banners{display:flex;flex-direction:column;gap:.4rem;margin-bottom:.6rem}
.cr-banners:empty{display:none}
.cr-banner{border-radius:5px;padding:.55rem .75rem;font-size:.8rem;line-height:1.45;display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .8rem}
.cr-banner-int{background:rgba(153,27,27,.45);border:1px solid #dc2626;color:#fee2e2}
.cr-banner-int strong{color:#fff;letter-spacing:.03em}
.cr-banner-ro{background:var(--crs2);border:1px solid var(--crb)}
.cr-note{font-size:.75rem;opacity:.7;padding:0 .1rem}
.cr-body{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem;align-items:start}
.cr-editor{min-width:0;background:var(--crs);border:1px solid var(--crb);border-radius:6px}
.cr-stepbar{display:flex;align-items:stretch;border-bottom:1px solid var(--crb);background:var(--crbg);border-radius:6px 6px 0 0}
.cr-steps{display:flex;flex:1 1 auto;min-width:0}
.cr-step{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:.5rem;text-align:left;padding:.6rem .7rem;background:none;border:0;border-bottom:2px solid transparent;color:var(--crt);opacity:.6;font:inherit;cursor:pointer}
.cr-step:hover{opacity:.9}
.cr-step.active{opacity:1;border-bottom-color:var(--cra);background:var(--crs)}
.cr-step:first-child{border-top-left-radius:6px}
.cr-step-n{font-size:1.15rem;color:var(--cra);line-height:1;flex:none}
.cr-step-txt{display:flex;flex-direction:column;min-width:0}
.cr-step-label{font-weight:700;font-size:.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cr-step-sub{font-size:.68rem;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cr-jump{flex:none;align-self:center;margin:0 .4rem}
.cr-panel{padding:.9rem .9rem 1rem}
.cr-preview{min-width:0;background:var(--crs);border:1px solid var(--crb);border-radius:6px;padding:.55rem;display:flex;flex-direction:column;gap:.45rem}
.cr-preview-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap;padding:0 .15rem}
.cr-preview-title{font-size:.64rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;opacity:.65}
.cr-preview-note{font-size:.7rem;opacity:.6}
.cr-preview-hint{background:var(--crs2);border:1px dashed var(--crb);border-radius:5px;padding:.6rem .7rem;font-size:.8rem;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
.cr-preview-hint[hidden]{display:none}
.cr-frame-wrap{position:relative;overflow:hidden;height:72vh;min-height:420px;border-radius:4px;background:#fff}
.cr-frame{display:block;width:100%;height:100%;border:0;background:#fff}
.cr-frame.paged{transform-origin:0 0}
.cr-frame-wrap.cr-scroll{overflow:auto}
.cr-frame.actual{max-width:none}
.cr-preview-tools{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap}
.cr-zoom{display:inline-flex;border:1px solid var(--crb);border-radius:4px;overflow:hidden}
.cr-zoom button{background:none;border:0;color:var(--crt);font:inherit;font-size:.68rem;padding:.2rem .5rem;cursor:pointer;opacity:.7}
.cr-zoom button[aria-pressed=true]{background:var(--crs2);opacity:1;font-weight:700;box-shadow:inset 0 -2px 0 var(--cra)}
@media (min-width:1200px){
  .cr-body{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .cr-preview{position:sticky;top:.5rem}
  .cr-frame-wrap{height:calc(100vh - 9rem)}
  .cr-root .cr-jump{display:none}
}
/* step contents */
.cr-field{display:flex;flex-direction:column;gap:.32rem;margin-bottom:1rem;min-width:0}
.cr-field-head{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;flex-wrap:wrap}
.cr-label{font-size:.68rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;opacity:.72}
.cr-count{font-size:.76rem;font-weight:600;color:var(--cra)}
.cr-warn{display:block;font-size:.74rem;color:var(--yellow,#eab308);line-height:1.4}
.cr-callout{background:var(--crs2);border-left:3px solid var(--cra);border-radius:4px;padding:.45rem .65rem;font-size:.8rem;margin:0}
.cr-callout[hidden]{display:none}
.cr-jobtools{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}
.cr-grow{flex:1 1 12rem}
.cr-joblist{max-height:18rem;overflow-y:auto;border:1px solid var(--crb);border-radius:5px;background:var(--crbg)}
.cr-job{display:flex;align-items:center;gap:.55rem;padding:.42rem .6rem;border-bottom:1px solid var(--crb);cursor:pointer;min-width:0}
.cr-job:last-child{border-bottom:0}
.cr-job:hover{background:var(--crs2)}
.cr-job.on{background:var(--crs2);box-shadow:inset 3px 0 0 var(--cra)}
.cr-job-name{font-weight:600;font-size:.8rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.cr-job-meta{font-size:.7rem;opacity:.6;margin-left:auto;padding-left:.5rem;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto}
.cr-inline{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center}
.cr-range{font-size:.8rem;font-weight:600}
.cr-fieldset{border:0;padding:0;margin:0 0 1rem;min-width:0}
.cr-fieldset legend{padding:0;margin-bottom:.3rem}
.cr-radio,.cr-check{display:flex;align-items:flex-start;gap:.5rem;font-size:.8rem;padding:.22rem 0;cursor:pointer;line-height:1.35}
.cr-radio input,.cr-check input{margin-top:.12rem}
.cr-check.disabled{opacity:.5;cursor:not-allowed}
.cr-savejobs{background:var(--crbg);border:1px solid var(--crb);border-radius:5px;padding:.55rem .65rem}
.cr-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));gap:0 1rem}
.cr-safe{display:flex;flex-direction:column;gap:.3rem;padding:.65rem .75rem;border:1px solid var(--crb);border-radius:6px;background:var(--crbg);margin-bottom:.9rem}
.cr-safe.on{border-color:#dc2626;background:rgba(153,27,27,.28)}
.cr-safe-desc{font-size:.76rem;opacity:.8;margin:0;line-height:1.45}
.cr-switch{display:inline-flex;align-items:center;gap:.6rem;cursor:pointer;font-weight:700;font-size:.85rem;position:relative;align-self:flex-start}
.cr-root .cr-switch input{position:absolute;left:0;top:0;opacity:0;width:38px;height:22px;margin:0;cursor:pointer}
.cr-switch-ui{width:38px;height:22px;border-radius:11px;background:var(--crb);position:relative;flex:none;transition:background .15s}
.cr-switch-ui::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.cr-switch input:checked+.cr-switch-ui{background:#dc2626}
.cr-switch input:checked+.cr-switch-ui::after{transform:translateX(16px)}
.cr-switch input:focus-visible+.cr-switch-ui{outline:2px solid var(--green,#22c55e);outline-offset:2px}
.cr-switch input:disabled+.cr-switch-ui{opacity:.4}
.cr-sections{display:flex;flex-direction:column;gap:.55rem;margin-bottom:.8rem}
.cr-sec{border:1px solid var(--crb);border-radius:6px;background:var(--crbg);min-width:0}
.cr-sec-head{display:flex;align-items:center;gap:.45rem;padding:.45rem .5rem}
.cr-sec-names{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:.18rem}
.cr-sec-type{font-size:.6rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--cra)}
.cr-sec-title{width:100%;font-weight:600}
.cr-sec-tools{display:flex;gap:.25rem;flex:none}
.cr-icon{background:var(--crs2);border:1px solid var(--crb);color:var(--crt);border-radius:4px;min-width:1.95rem;height:1.95rem;padding:0 .35rem;font:inherit;font-size:.82rem;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.cr-icon:disabled{opacity:.28;cursor:default}
.cr-icon:hover:not(:disabled){border-color:var(--cra)}
.cr-icon.ghost{background:none;border-color:transparent}
.cr-sec-sum{padding:0 .7rem .55rem 2.9rem;font-size:.72rem;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cr-sec-body{padding:.15rem .65rem .75rem;border-top:1px solid var(--crb)}
.cr-blurb{font-size:.74rem;opacity:.65;margin:.5rem 0 .2rem;line-height:1.4}
.cr-subhead{font-size:.62rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;opacity:.6;margin:.7rem 0 .25rem}
.cr-cols{display:flex;flex-direction:column}
.cr-col{display:flex;align-items:center;gap:.4rem;padding:.12rem .3rem;border-radius:4px;min-height:2.15rem;flex-wrap:wrap}
.cr-col:hover{background:var(--crs2)}
.cr-col-label{display:flex;align-items:center;gap:.5rem;flex:1 1 9rem;min-width:0;cursor:pointer;font-size:.8rem}
.cr-col-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
.cr-col.locked .cr-col-label{cursor:not-allowed;opacity:.5}
.cr-col-orig{font-size:.68rem;opacity:.55;white-space:nowrap}
.cr-col-tools{display:flex;gap:.2rem;flex:none}
.cr-col-tools .cr-icon{min-width:1.75rem;height:1.75rem;font-size:.76rem}
.cr-col-edit{flex:1 1 9rem}
.cr-tag-int{font-size:.56rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#fca5a5;border:1px solid #7f1d1d;border-radius:3px;padding:0 .3rem;flex:none}
.cr-opts{border-top:1px dashed var(--crb);margin-top:.55rem;padding-top:.15rem;display:flex;flex-wrap:wrap;gap:.3rem 1.2rem;align-items:center}
.cr-opts>.cr-subhead{flex-basis:100%}
.cr-opt{font-size:.78rem;display:inline-flex;align-items:center;gap:.45rem}
.cr-fs{flex-basis:100%;border:0;padding:0;margin:0;min-width:0}
.cr-fs legend{font-size:.78rem;padding:0;margin:.2rem 0 .15rem;display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}
.cr-cc-list{display:flex;flex-wrap:wrap;gap:0 1rem;max-height:9.5rem;overflow-y:auto}
.cr-add{display:flex;align-items:center;gap:.6rem;flex-wrap:wrap}
/* menus */
.cr-menu{position:fixed;z-index:${Z - 10};min-width:13rem;max-width:min(24rem,calc(100vw - 1.5rem));max-height:min(70vh,30rem);overflow-y:auto;overscroll-behavior:contain;background:var(--surface2,#1a1a26);border:1px solid var(--border,#2a2a3a);border-radius:6px;box-shadow:0 12px 32px rgba(0,0,0,.6);padding:.3rem;display:flex;flex-direction:column}
.cr-menu-item{display:flex;flex-direction:column;gap:.12rem;text-align:left;background:none;border:0;color:var(--text,#e0e0e0);font:inherit;font-size:.8rem;padding:.45rem .6rem;border-radius:4px;cursor:pointer}
.cr-menu-item:hover,.cr-menu-item:focus{background:var(--border,#2a2a3a);outline:none}
.cr-menu-item.danger{color:#fca5a5}
.cr-menu-item b{font-weight:600}
.cr-menu-item small{font-size:.7rem;opacity:.65;line-height:1.35}
/* send history */
.cr-hist-head{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin-bottom:.4rem}
.cr-tablewrap{overflow-x:auto;border:1px solid var(--crb);border-radius:6px;background:var(--crs);margin-top:.6rem}
/* The pages set table{white-space:nowrap;min-width:100%} for their grids;
   the history's job lists, subjects and recipients have to wrap, or the
   columns that say who it went to and whether it carried our costs end up
   off the side of the pane. */
.cr-table{width:100%;border-collapse:collapse;font-size:.78rem;white-space:normal;min-width:0}
.cr-table td[data-label="Recipients"],.cr-table td[data-label="Jobs"],.cr-table td[data-label="Report"]{overflow-wrap:anywhere;word-break:break-word}
.cr-table th{text-align:left;font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.7;padding:.5rem .6rem;border-bottom:1px solid var(--crb);white-space:nowrap}
.cr-table td{padding:.5rem .6rem;border-bottom:1px solid var(--crb);vertical-align:top}
.cr-table tr:last-child td{border-bottom:0}
.cr-table .cr-nowrap{white-space:nowrap}
/* phones: the rail tucks behind a toggle and everything stacks */
@media (max-width:899px){
  .cr-root{flex-direction:column;gap:.6rem}
  .cr-rail{display:none;position:static;width:100%;flex:none;max-height:none}
  .cr-rail.open{display:block}
  .cr-root .cr-railbtn{display:inline-flex}
}
@media (max-width:640px){
  .cr-actions{width:100%}
  .cr-actions .btn{flex:1 1 auto;justify-content:center}
  .cr-actions .btn[data-act="doc-menu"]{flex:0 0 2.75rem}
  .cr-step{flex-direction:column;align-items:flex-start;gap:.15rem;padding:.5rem .5rem}
  .cr-step-sub{display:none}
  .cr-step-label{white-space:normal;line-height:1.2}
  .cr-root .cr-jump{font-size:.66rem;padding:.22rem .4rem;margin:0 .3rem}
  .cr-panel{padding:.75rem .6rem .9rem}
  .cr-sec-sum{padding-left:.7rem}
  .cr-job{flex-wrap:wrap;row-gap:.1rem}
  .cr-job-meta{flex-basis:100%;margin-left:1.55rem;padding-left:0}
  .cr-table thead{display:none}
  .cr-table,.cr-table tbody,.cr-table tr,.cr-table td{display:block;width:100%}
  .cr-table tr{border-bottom:1px solid var(--crb);padding:.35rem 0}
  .cr-table td{border:0;padding:.18rem .6rem;display:flex;gap:.6rem}
  .cr-table td::before{content:attr(data-label);flex:0 0 6.5rem;font-size:.62rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.6;padding-top:.1rem}
  .cr-table .cr-nowrap{white-space:normal}
}
@media (pointer:coarse){
  .cr-icon{min-width:2.4rem;height:2.4rem}
  .cr-col-tools .cr-icon{min-width:2.2rem;height:2.2rem}
  .cr-col{min-height:2.6rem}
  .cr-job{padding:.6rem}
  .cr-item-more{width:2.6rem}
}
/* v2: filters, contacts, customer history, schedules */
.cr-raillinks{display:flex;flex-direction:column;gap:.35rem;margin-top:.9rem}
.cr-raillinks .btn{width:100%;justify-content:center;margin-top:0}
.cr-chips{display:flex;flex-wrap:wrap;gap:.3rem;align-items:center}
.cr-chips:empty{display:none}
.cr-chip{display:inline-flex;align-items:center;gap:.25rem;max-width:100%;font-size:.72rem;background:var(--crs2);border:1px solid var(--crb);border-radius:999px;padding:.1rem .2rem .1rem .55rem}
.cr-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.cr-chip button{background:none;border:0;color:var(--crt);opacity:.6;cursor:pointer;font:inherit;line-height:1;padding:.1rem .3rem;border-radius:50%}
.cr-chip button:hover{opacity:1;background:var(--crb)}
.cr-chip.sc{border-color:var(--cra)}
.cr-flist{max-height:11rem;overflow-y:auto;border:1px solid var(--crb);border-radius:5px;background:var(--crbg);padding:.25rem .5rem}
.cr-flist .cr-check{overflow-wrap:anywhere}
.cr-flist-h{font-size:.6rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;opacity:.55;margin:.35rem 0 .1rem}
.cr-job-ct{flex:none;background:none;border:1px solid var(--crb);border-radius:999px;color:var(--cra);font:inherit;font-size:.64rem;font-weight:600;padding:.05rem .45rem;cursor:pointer;white-space:nowrap}
.cr-job-ct:hover{border-color:var(--cra)}
.cr-view-head{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin-bottom:.4rem}
.cr-toolrow{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;margin:.5rem 0}
/* A set width, so a long job name in a <select> cannot make the view wider
   than a phone (its intrinsic width ignores a percentage max-width). */
.cr-toolrow .cr-input{flex:1 1 12rem;width:12rem}
.cr-ct-group{margin-top:.8rem}
.cr-ct-group-h{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;flex-wrap:wrap;font-weight:700;font-size:.82rem;margin:0 0 .3rem}
.cr-ct-card{display:flex;gap:.6rem;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;padding:.5rem .6rem;border:1px solid var(--crb);border-radius:5px;background:var(--crs);margin-bottom:.3rem;min-width:0}
.cr-ct-who{min-width:0;flex:1 1 14rem;overflow-wrap:anywhere}
.cr-ct-who b{font-weight:600}
.cr-ct-tools{display:flex;gap:.35rem;align-items:center;flex-wrap:wrap}
.cr-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:.55rem .8rem;padding:.7rem;border:1px solid var(--crb);border-radius:6px;background:var(--crs);margin:.5rem 0}
.cr-form .cr-field{margin:0}
.cr-form .cr-input{width:100%;min-width:0}
.cr-form-btns{grid-column:1/-1;display:flex;gap:.5rem;justify-content:flex-end;flex-wrap:wrap;align-items:center}
.cr-form-err{grid-column:1/-1;color:#fca5a5;font-size:.78rem;margin:0}
.cr-form-err:empty{display:none}
.cr-rowacts{display:flex;gap:.3rem;flex-wrap:wrap}
.cr-more{display:flex;justify-content:center;margin:.7rem 0}
.cr-spin{display:inline-block;width:.8rem;height:.8rem;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cr-spin .8s linear infinite;vertical-align:-.1rem}
@keyframes cr-spin{to{transform:rotate(360deg)}}
.cr-sched-meta{font-size:.68rem;opacity:.6;line-height:1.35;overflow-wrap:anywhere}
.cr-sched-meta.err{color:#fca5a5;opacity:.9}
.cr-badge.paused{color:var(--yellow,#eab308);border-color:var(--yellow,#eab308)}
.cr-modal-box.cr-wide{width:min(40rem,100%)}
/* a row or list the dialog hides (the days of the week off Weekly, the day
   of the month off Monthly) stays hidden over its own display:flex */
.cr-modal [hidden]{display:none!important}
.cr-modal .cr-m-row{display:flex;flex-wrap:wrap;gap:.5rem .9rem;align-items:center}
.cr-modal .cr-m-row .cr-input{width:auto;flex:1 1 10rem}
.cr-modal .cr-m-days{display:flex;flex-wrap:wrap;gap:.25rem .7rem}
.cr-modal .cr-m-list{max-height:9rem;overflow-y:auto;border:1px solid var(--border,#2a2a3a);border-radius:5px;padding:.3rem .5rem;display:flex;flex-direction:column;gap:.1rem}
.cr-modal .cr-m-fs{border:0;padding:0;margin:0;min-width:0;display:flex;flex-direction:column;gap:.3rem}
.cr-modal .cr-m-fs legend{padding:0;margin-bottom:.25rem}
.cr-modal .cr-m-hint{font-size:.74rem;opacity:.65;line-height:1.4}
.cr-modal .cr-m-errs{color:#fca5a5;font-size:.8rem;margin:0;display:flex;flex-direction:column;gap:.15rem}
.cr-modal .cr-m-errs:empty{display:none}
.cr-modal .cr-chips{margin-top:.2rem}
.cr-modal .cr-chip{font-size:.74rem;background:var(--surface2,#1a1a26);border:1px solid var(--border,#2a2a3a);border-radius:999px;display:inline-flex;align-items:center;gap:.25rem;padding:.1rem .2rem .1rem .55rem}
.cr-modal .cr-chip button{background:none;border:0;color:var(--text,#e0e0e0);opacity:.6;cursor:pointer;font:inherit;padding:.1rem .3rem}
/* the AI builder drawer: in the mount, so it hides with the tab */
.cr-ai-drawer{position:fixed;top:0;right:0;bottom:0;width:400px;max-width:100vw;z-index:${Z - 30};background:var(--surface,#111118);color:var(--text,#e0e0e0);
  border-left:1px solid var(--border,#2a2a3a);box-shadow:-12px 0 32px rgba(0,0,0,.5);display:flex;flex-direction:column;font-size:13px;line-height:1.4}
.cr-ai-drawer[hidden]{display:none}
.cr-ai-drawer *{box-sizing:border-box}
.cr-ai-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem;padding:.6rem .8rem;border-bottom:1px solid var(--border,#2a2a3a)}
.cr-ai-head h2{margin:0;font-size:.8rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.cr-ai-x{background:none;border:0;color:var(--text,#e0e0e0);opacity:.65;font-size:1.1rem;cursor:pointer;line-height:1;padding:.2rem .35rem}
.cr-ai-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column}
.cr-ai-missing{padding:1rem;opacity:.75;font-size:.82rem}
/* the pages' floating assistant button (52px, 18px in from the bottom right,
   above this drawer) would sit on the Send button: the composer keeps clear
   of that corner */
.cr-ai-drawer .crai-form{padding-right:calc(.8rem + 66px)}
@media (min-width:${AI_SHEET_BELOW}px){.cr-ai-on>.cr-shell{margin-right:408px}}
@media (max-width:${AI_SHEET_BELOW - 1}px){.cr-ai-drawer{width:100%;left:0;border-left:0}}
/* dialogs and toasts, on <body> */
.cr-modal{position:fixed;inset:0;z-index:${Z};background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:1rem;color:var(--text,#e0e0e0);font-size:13px;line-height:1.45}
.cr-modal-box{background:var(--surface,#111118);border:1px solid var(--border,#2a2a3a);border-radius:8px;width:min(29rem,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.6)}
.cr-modal-head{display:flex;justify-content:space-between;align-items:center;gap:.6rem;padding:.75rem 1rem;border-bottom:1px solid var(--border,#2a2a3a)}
.cr-modal-title{font-weight:700;font-size:.86rem;letter-spacing:.05em;text-transform:uppercase;margin:0}
.cr-modal-x{background:none;border:0;color:var(--text,#e0e0e0);opacity:.6;font-size:1.1rem;cursor:pointer;line-height:1;padding:.2rem .3rem}
.cr-modal-body{padding:1rem;overflow:auto;display:flex;flex-direction:column;gap:.65rem}
.cr-modal-body p{margin:0}
.cr-modal .cr-input{width:100%;font-size:.88rem;padding:.45rem .6rem}
.cr-m-label{font-size:.68rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;opacity:.72}
.cr-m-err{color:#fca5a5;font-size:.8rem;margin:0}
.cr-m-err[hidden]{display:none}
.cr-m-btns{display:flex;justify-content:flex-end;gap:.5rem;flex-wrap:wrap;margin-top:.25rem}
.cr-modal .cr-check{display:flex;align-items:flex-start;gap:.5rem;font-size:.82rem;cursor:pointer}
.cr-modal .cr-check input{margin-top:.15rem}
.cr-toast{position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);z-index:${Z + 20};background:var(--surface2,#1a1a26);color:var(--text,#e0e0e0);border:1px solid var(--green,#22c55e);border-left-width:3px;padding:.6rem .9rem;border-radius:4px;font-size:.84rem;box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:min(92vw,520px);display:flex;gap:.8rem;align-items:center}
.cr-toast.err{border-color:var(--red,#ef4444)}
.cr-toast button{background:none;border:1px solid var(--border,#2a2a3a);color:var(--green,#22c55e);border-radius:4px;padding:.2rem .6rem;cursor:pointer;font:inherit;font-weight:600;flex:none}
`;
    document.head.appendChild(el);
  }

  // ── Rendering: the shell ────────────────────────────────────────────
  // render() rebuilds everything and is kept for view changes (opening a
  // report, the history). Everyday edits redraw only the part they touch —
  // the step panel, the job list, the bar's chips — so a field being typed
  // into is never replaced under the cursor, and focus survives a redraw
  // through the data-fk ("focus key") each control carries.
  function withFocus(region, fn) {
    const a = document.activeElement;
    const inside = region && a && a !== document.body && region.contains(a);
    const fk = inside && a.getAttribute ? a.getAttribute('data-fk') : null;
    let sel = null;
    if (fk) { try { if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd]; } catch (_) { sel = null; } }
    fn();
    if (!fk || !S.mount) return;
    let b = S.mount.querySelector(`[data-fk="${fk}"]`);
    // A ↑ that has just become the top one is disabled: land on its ↓.
    if (b && b.disabled) {
      const alt = /^(col|sec)up-/.test(fk) ? fk.replace(/^(col|sec)up-/, '$1down-') : fk.replace(/^(col|sec)down-/, '$1up-');
      const c = S.mount.querySelector(`[data-fk="${alt}"]`);
      if (c && !c.disabled) b = c;
    }
    if (!b || b.disabled) return;
    try { b.focus({ preventScroll: true }); } catch (_) { b.focus(); }
    if (sel) { try { b.setSelectionRange(sel[0], sel[1]); } catch (_) { /* not a text box */ } }
  }
  function focusFk(fk) {
    const b = S.mount && S.mount.querySelector(`[data-fk="${fk}"]`);
    if (b) { try { b.focus({ preventScroll: true }); } catch (_) { b.focus(); } }
  }

  /* The mount holds the builder (redrawn freely) and, beside it, the AI
     drawer — which keeps its conversation across redraws, and sits inside
     the tab's panel so it hides when another tab is up. */
  function shell() {
    let sh = [...S.mount.children].find(c => c.classList && c.classList.contains('cr-shell'));
    if (!sh) {
      S.mount.innerHTML = '<div class="cr-shell"></div><aside class="cr-ai-drawer" id="cr-ai-drawer" aria-label="AI report builder" hidden></aside>';
      sh = S.mount.firstElementChild;
      S.ai.el = null;
      S.ai.handle = null;
    }
    return sh;
  }
  function render() {
    if (!S.mount || !E) return;
    closeMenu();
    const sh = shell();
    withFocus(sh, () => {
      sh.innerHTML = `<div class="cr-root">
        <button type="button" class="btn btn-ghost cr-railbtn" data-act="toggle-rail" data-fk="toggle-rail" aria-controls="cr-rail" aria-expanded="${S.railOpen}">${railBtnText()}</button>
        <aside class="cr-rail${S.railOpen ? ' open' : ''}" id="cr-rail" aria-label="Saved reports">${railHtml()}</aside>
        <div class="cr-main"><div class="cr-view">${viewHtml()}</div></div>
      </div>`;
    });
    syncAi();
    afterView();
  }
  function renderView() {
    const v = S.mount && S.mount.querySelector('.cr-view');
    if (!v) { render(); return; }
    closeMenu();
    withFocus(v, () => { v.innerHTML = viewHtml(); });
    afterView();
  }
  function afterView() {
    S.lastBanners = null;
    S.lastSteps = null;
    if (S.view === 'edit' && S.doc) {
      const frame = S.mount.querySelector('.cr-frame');
      // Redrawing the preview reloads the frame, which jumps it back to the
      // top. Put the reader back where they were.
      if (frame) frame.addEventListener('load', () => {
        try { if (S.pvScroll) frame.contentWindow.scrollTo(0, S.pvScroll); } catch (_) { /* not ours to scroll */ }
      });
      updateChrome();
      renderPreview();
    }
  }
  function renderRail() {
    const rail = S.mount && S.mount.querySelector('.cr-rail');
    if (!rail) return;
    if (S.menuEl && rail.contains(S.menuEl)) closeMenu();
    withFocus(rail, () => { rail.innerHTML = railHtml(); });
    const btn = S.mount.querySelector('.cr-railbtn');
    if (btn) btn.innerHTML = railBtnText();
  }
  // Phones only (CSS hides it elsewhere): the rail folds away behind this.
  function railBtnText() {
    if (S.railOpen) return '&#10005; Hide reports';
    return `&#9776; Reports${S.loaded ? ` (${S.reports.length})` : ''}`;
  }
  function viewHtml() {
    if (S.view === 'history') return historyHtml();
    if (S.view === 'customer') return customerHtml();
    if (S.view === 'contacts') return contactsHtml();
    if (S.view === 'edit' && S.doc) return editHtml();
    return homeHtml();
  }

  // ── The left rail ───────────────────────────────────────────────────
  const badge = (label, cls) => `<span class="cr-badge${cls ? ' ' + cls : ''}">${label}</span>`;

  function railHtml() {
    const q = S.search.trim().toLowerCase();
    const hit = (...vals) => !q || vals.some(v => txt(v).toLowerCase().includes(q));
    const mine = S.reports.filter(r => r.visibility !== 'shared' && hit(r.name, r.description));
    const shared = S.reports.filter(r => r.visibility === 'shared' && hit(r.name, r.description));
    const starterList = starters().filter(s => hit(s.name, s.blurb));
    const waiting = !S.loaded && S.loading;
    const none = (msg) => `<p class="cr-empty">${msg}</p>`;
    const mineEmpty = waiting ? none('Loading saved reports…')
      : q ? none('No match.')
      : none('Nothing saved yet. Open a starter or <b>+ New Report</b>, then Save.');
    const sharedEmpty = waiting ? '' : q ? none('No match.')
      : none(S.canShare ? 'None yet. Save a report and tick “Share with division”.' : 'None yet. An admin or level 3 user can share one with the division.');
    return `
      <div class="cr-rail-top">
        <label class="cr-sr" for="cr-rail-search">Search reports</label>
        <input id="cr-rail-search" type="search" class="cr-input" data-bind="rail-search" data-fk="rail-search"
          placeholder="&#128269; Search reports…" value="${esc(S.search)}" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-green" data-act="new" data-fk="new">+ New Report</button>
      </div>
      ${S.loadError ? `<div class="cr-alert" role="alert"><span>Couldn’t load saved reports: ${esc(S.loadError)}</span>
        <button type="button" class="btn btn-ghost cr-sm" data-act="reload">Retry</button></div>` : ''}
      <div class="cr-group">
        <h3 class="cr-group-h"><span>My Reports</span><span>${S.loaded ? mine.length : ''}</span></h3>
        ${mine.length ? mine.map(itemHtml).join('') : mineEmpty}
      </div>
      <div class="cr-group">
        <h3 class="cr-group-h"><span>Shared Templates</span><span>${S.loaded ? shared.length : ''}</span></h3>
        ${shared.length ? shared.map(itemHtml).join('') : sharedEmpty}
      </div>
      <div class="cr-group">
        <h3 class="cr-group-h"><span>Starter Templates</span><span>${starterList.length}</span></h3>
        ${starterList.length ? starterList.map(starterItemHtml).join('') : none('No match.')}
      </div>
      ${schedulesRailHtml()}
      <div class="cr-group">
        <button type="button" class="cr-group-toggle" data-act="toggle-deleted" data-fk="toggle-deleted"
          aria-expanded="${S.deletedOpen}" aria-controls="cr-deleted">${S.deletedOpen ? '&#9662;' : '&#9656;'} Recently Deleted</button>
        <div id="cr-deleted"${S.deletedOpen ? '' : ' hidden'}>${S.deletedOpen ? deletedHtml() : ''}</div>
      </div>
      <div class="cr-raillinks">
        <button type="button" class="btn btn-ghost cr-histlink" data-act="history" data-fk="history">&#128337; Send History</button>
        <button type="button" class="btn btn-ghost" data-act="customer" data-fk="customer" title="Every email a job's customer was sent — open or resend exactly what went">&#128231; Customer History</button>
        <button type="button" class="btn btn-ghost" data-act="contacts" data-fk="contacts" title="Saved customer contacts for each job and client">&#128101; Contacts</button>
      </div>`;
  }

  // ── Schedules in the rail (admin / level 3) ─────────────────────────
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function time12(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return '';
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function tzLabel(tz) {
    const hit = SCHED_TZ.find(t => t[0] === tz);
    return hit ? hit[1] : txt(tz);
  }
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function cadenceText(s) {
    const at = `${time12(s.send_time)} ${tzLabel(s.timezone)}`.trim();
    if (s.frequency === 'daily') return `Daily at ${at}`;
    if (s.frequency === 'weekdays') return `Weekdays at ${at}`;
    if (s.frequency === 'weekly') {
      const days = (Array.isArray(s.days_of_week) ? s.days_of_week : []).map(d => DOW[Number(d)]).filter(Boolean);
      return `Weekly ${days.join(', ') || '—'} at ${at}`;
    }
    if (s.frequency === 'monthly') {
      const d = Number(s.day_of_month);
      return `Monthly on the ${d === -1 ? 'last day' : ordinal(d || 1)} at ${at}`;
    }
    return at;
  }
  function schedulesRailHtml() {
    if (!(S.canShare || S.canSchedule)) return '';
    const list = Array.isArray(S.scheds) ? S.scheds : [];
    let body;
    if (S.schedsError) {
      body = `<div class="cr-alert" role="alert"><span>Couldn’t load schedules: ${esc(S.schedsError)}</span>
        <button type="button" class="btn btn-ghost cr-sm" data-act="reload-schedules">Retry</button></div>`;
    } else if (!S.scheds) {
      body = `<p class="cr-empty">${S.schedsLoading ? 'Loading…' : 'None yet.'}</p>`;
    } else if (!list.length) {
      body = '<p class="cr-empty">None yet. Open a saved, customer-safe report and choose <b>Schedule…</b>.</p>';
    } else {
      body = list.map(schedItemHtml).join('');
    }
    return `<div class="cr-group">
        <h3 class="cr-group-h"><span>Schedules</span><span>${S.scheds ? list.length : ''}</span></h3>
        ${body}
      </div>`;
  }
  const schedSavingOut = id => [...S.schedSaving].some(x => sameId(x, id));
  function schedItemHtml(s) {
    const busy = [...S.schedBusy].some(id => sameId(id, s.id));
    const toggling = [...S.schedToggling].some(id => sameId(id, s.id));
    const saving = schedSavingOut(s.id);
    const next = s.enabled && s.next_run_at ? `Next ${fmtWhen(s.next_run_at)}` : (s.enabled ? '' : 'Paused');
    const last = s.last_status ? `Last: ${s.last_status}${s.last_run_at ? ' · ' + ago(s.last_run_at) : ''}` : 'Not sent yet';
    const bad = /fail|skip|partial|missed/i.test(String(s.last_status || ''));
    // What the next send will find, said now (the server sends these so the
    // cases can be told apart): the report gone, or no longer customer-safe.
    // Anything else the next send would refuse on (fixed dates, saved jobs
    // against once per job, no longer shared with who it runs as) comes in
    // the run's own words.
    const blocked = s.report_deleted === true
      ? 'Report deleted — restore it from Recently Deleted, or delete this schedule.'
      : s.report_customer_safe === false ? 'Report now includes internal data — it won’t send until it’s customer-safe again.'
      : txt(s.report_blocked) ? `Won’t send: ${txt(s.report_blocked)}` : '';
    return `<div class="cr-item">
      <div class="cr-item-open" style="cursor:default">
        <span class="cr-item-name">${esc(s.report_name || 'Saved report')}</span>
        <span class="cr-badges">${s.enabled ? badge('On', 'shared') : badge('Paused', 'paused')}${busy ? '<span class="cr-badge"><span class="cr-spin" aria-hidden="true"></span> Sending…</span>' : ''}${saving ? '<span class="cr-badge"><span class="cr-spin" aria-hidden="true"></span> Saving…</span>' : ''}</span>
        <span class="cr-sched-meta">${esc(cadenceText(s))}</span>
        <span class="cr-sched-meta">${esc([next, last].filter(Boolean).join(' · '))}</span>
        ${blocked ? `<span class="cr-sched-meta err">${esc(blocked)}</span>` : ''}
        ${s.last_message && bad ? `<span class="cr-sched-meta err">${esc(String(s.last_message).slice(0, 200))}</span>` : ''}
      </div>
      <button type="button" class="cr-item-more" data-act="sched-menu" data-id="${esc(s.id)}" data-fk="schedmore-${esc(s.id)}"
        aria-haspopup="menu" aria-expanded="false" aria-label="Actions for the schedule of ${esc(s.report_name || 'a report')}" title="Schedule actions"${busy || toggling || saving ? ' disabled' : ''}>&#8943;</button>
    </div>`;
  }

  function itemHtml(r) {
    const active = S.doc && S.doc.id != null && sameId(S.doc.id, r.id);
    const badges = [
      r.visibility === 'shared' ? badge('Shared', 'shared') : badge('Private'),
      r.kind === 'report' ? badge('Saved jobs') : badge('Template'),
      r.customer_safe === false ? badge('&#128274; Internal', 'internal') : '',
    ].join('');
    const who = txt(r.updated_by_username) || txt(r.owner_username);
    const meta = [who ? `updated by ${who}` : '', ago(r.updated_at)].filter(Boolean).join(' · ');
    return `<div class="cr-item${active ? ' active' : ''}">
      <button type="button" class="cr-item-open" data-act="open" data-id="${esc(r.id)}" data-fk="open-${esc(r.id)}"
        ${r.description ? `title="${esc(r.description)}"` : ''}${active ? ' aria-current="true"' : ''}>
        <span class="cr-item-name">${esc(r.name)}</span>
        <span class="cr-badges">${badges}</span>
        ${meta ? `<span class="cr-item-meta">${esc(meta)}</span>` : ''}
      </button>
      <button type="button" class="cr-item-more" data-act="item-menu" data-id="${esc(r.id)}" data-fk="more-${esc(r.id)}"
        aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${esc(r.name)}" title="More actions">&#8943;</button>
    </div>`;
  }
  function starterItemHtml(st) {
    const active = S.doc && !S.doc.id && S.doc.starterId === st.id;
    return `<div class="cr-item${active ? ' active' : ''}">
      <button type="button" class="cr-item-open" data-act="starter" data-starter="${esc(st.id)}" data-fk="starter-${esc(st.id)}" title="${esc(st.blurb)}">
        <span class="cr-item-name">${esc(st.name)}</span>
        <span class="cr-badges">${badge('Starter')}${st.internal ? badge('&#128274; Internal', 'internal') : ''}</span>
        <span class="cr-item-meta">${esc(st.blurb)}</span>
      </button>
    </div>`;
  }
  function deletedHtml() {
    if (S.deletedLoading && !S.deleted) return '<p class="cr-empty">Loading…</p>';
    if (S.deletedError) {
      return `<div class="cr-alert" role="alert"><span>${esc(S.deletedError)}</span>
        <button type="button" class="btn btn-ghost cr-sm" data-act="reload-deleted">Retry</button></div>`;
    }
    const list = S.deleted || [];
    if (!list.length) return '<p class="cr-empty">Nothing deleted in the last 30 days.</p>';
    return list.map(r => {
      const meta = [r.deleted_by_username ? `deleted by ${r.deleted_by_username}` : 'deleted', ago(r.deleted_at)].filter(Boolean).join(' · ');
      return `<div class="cr-item">
        <div class="cr-item-open" style="cursor:default">
          <span class="cr-item-name">${esc(r.name)}</span>
          <span class="cr-badges">${r.visibility === 'shared' ? badge('Shared', 'shared') : badge('Private')}</span>
          <span class="cr-item-meta">${esc(meta)}</span>
        </div>
        <button type="button" class="btn btn-ghost cr-sm cr-item-act" data-act="restore" data-id="${esc(r.id)}"
          data-fk="restore-${esc(r.id)}" aria-label="Restore ${esc(r.name)}">Restore</button>
      </div>`;
    }).join('');
  }

  // ── Welcome (nothing open) ──────────────────────────────────────────
  function homeHtml() {
    const cards = starters().map(st => {
      const secs = st.definition.sections.map(s => (E.CATALOG[s.type] || {}).label).filter(Boolean).join(' · ');
      return `<button type="button" class="cr-card" data-act="starter" data-starter="${esc(st.id)}" data-fk="card-${esc(st.id)}">
        <span class="cr-card-name">${esc(st.name)}${st.internal ? badge('&#128274; Internal', 'internal') : ''}</span>
        <span class="cr-card-blurb">${esc(st.blurb)}</span>
        <span class="cr-card-secs">${esc(secs)}</span>
      </button>`;
    }).join('');
    return `<div class="cr-home">
      <div class="cr-view-head"><h2 class="cr-h2">Custom Reporting</h2>${aiButtonHtml()}</div>
      <p class="cr-lead">Pick jobs, choose exactly what the customer should see, and print it, email it or download it for Excel.
        Save it by name and next time it is one click.</p>
      <p class="cr-safenote"><span aria-hidden="true">&#128737;</span><span>Reports are <b>customer-safe</b> unless you say otherwise —
        costs, rates, hours, employee names, profit and contract dollars stay locked until you switch internal data on.</span></p>
      <h3 class="cr-h3">Start from…</h3>
      <div class="cr-cards">
        ${cards}
        <button type="button" class="cr-card blank" data-act="new" data-fk="card-blank">
          <span class="cr-card-name">+ Blank report</span>
          <span class="cr-card-blurb">Start empty and add the sections you want.</span>
        </button>
      </div>
    </div>`;
  }

  // ── The builder ─────────────────────────────────────────────────────
  function editHtml() {
    return `<div class="cr-edit">
      <div class="cr-bar">${barHtml()}</div>
      <div class="cr-banners"></div>
      <div class="cr-body">
        <div class="cr-editor">
          <div class="cr-stepbar">
            <div class="cr-steps" role="tablist" aria-label="Build the report"></div>
            <button type="button" class="btn btn-ghost cr-sm cr-jump" data-act="jump-preview">Preview &#8595;</button>
          </div>
          <div class="cr-panel" role="tabpanel" id="cr-panel" aria-labelledby="cr-step-${S.step}">${panelHtml()}</div>
        </div>
        <section class="cr-preview" aria-label="Live preview">
          <div class="cr-preview-head"><span class="cr-preview-title">Live preview</span><span class="cr-preview-note" aria-live="polite"></span>
            <span class="cr-preview-tools">${zoomHtml()}
              <button type="button" class="btn btn-ghost cr-sm" data-act="full-preview" data-fk="full-preview" title="Open the report full size in a new tab, without printing">Open full preview</button></span></div>
          <div class="cr-preview-hint" hidden></div>
          <div class="cr-frame-wrap"><iframe class="cr-frame" sandbox="allow-same-origin" title="Report preview — exactly what will print"></iframe></div>
        </section>
      </div>
    </div>`;
  }

  // Fit: the whole sheet scaled into the pane. 100%: the sheet at the size it
  // prints, scrolling — for reading the figures on a laptop screen.
  function zoomHtml() {
    const b = (z, label, tip) => `<button type="button" data-act="zoom" data-zoom="${z}" data-fk="zoom-${z}" aria-pressed="${S.zoom === z}" title="${tip}">${label}</button>`;
    return `<span class="cr-zoom" role="group" aria-label="Preview size">${b('fit', 'Fit', 'Fit the whole page in the pane')}${b('100', '100%', 'Show the page at its printed size')}</span>`;
  }

  function barHtml() {
    const d = S.doc;
    return `<label class="cr-sr" for="cr-name">Report name</label>
      <input id="cr-name" class="cr-name" data-bind="name" data-fk="name" maxlength="120" value="${esc(d.name)}"
        placeholder="Untitled report" autocomplete="off" spellcheck="false">
      <span class="cr-dirty" role="status" hidden>&#9679; Unsaved changes</span>
      <div class="cr-actions">
        <button type="button" class="btn btn-green" data-act="save" data-fk="save">Save</button>
        <button type="button" class="btn btn-ghost" data-act="save-as" data-fk="save-as">Save As…</button>
        <button type="button" class="btn btn-ghost" data-act="print" data-fk="print" title="Open a printable copy — choose Save as PDF in the print dialog for a PDF">&#128424; Print / PDF</button>
        <button type="button" class="btn btn-ghost" data-act="email" data-fk="email" title="Email this report">&#9993; Email</button>
        <button type="button" class="btn btn-ghost" data-act="excel" data-fk="excel" title="Download as an Excel workbook">&#8681; Excel</button>
        <button type="button" class="btn btn-ghost" data-act="schedule" data-fk="schedule">&#128339; Schedule…</button>
        ${aiButtonHtml()}
        <button type="button" class="btn btn-ghost" data-act="doc-menu" data-fk="doc-menu" aria-haspopup="menu" aria-expanded="false" aria-label="More actions" title="More actions">&#8943;</button>
      </div>`;
  }
  function aiButtonHtml() {
    return `<button type="button" class="btn btn-ghost" data-act="ai-toggle" data-fk="ai-toggle" aria-pressed="${S.ai.open}"
      aria-controls="cr-ai-drawer" title="Describe the report you want and let the AI builder draft it">&#10024; AI Builder</button>`;
  }
  /* Schedule… is for a saved report that is customer-safe as saved, and for
     the people who may schedule (admin / level 3). Why not, otherwise. */
  function scheduleBlock(d) {
    if (!S.canShare) return 'Only an admin or level 3 user can schedule reports.';
    if (!d || !d.id) return 'Save the report first — a schedule sends a saved report.';
    const r = S.reports.find(x => sameId(x.id, d.id));
    if ((r && r.customer_safe === false) || internalOn()) return 'Only customer-safe reports can be scheduled — switch internal data off and save.';
    return '';
  }

  function bannersHtml() {
    const d = S.doc;
    const out = [];
    if (d.readOnly) {
      out.push(`<div class="cr-banner cr-banner-ro"><span>&#128065; This is a shared template${d.owner_username ? ` from ${esc(d.owner_username)}` : ''}.
        You can change it for this run, but only an admin or level 3 user can save over it. <strong>Save As to make your own copy.</strong></span></div>`);
    }
    if (internalOn()) {
      out.push(`<div class="cr-banner cr-banner-int" role="alert"><span><strong>INTERNAL DATA IS ON.</strong>
        This report can show costs, rates, hours, employee names and profit. Don’t send it to a customer.</span>
        <button type="button" class="btn btn-ghost cr-sm" data-act="internal-off">Make it customer-safe</button></div>`);
    }
    if (d.missing) {
      out.push(`<div class="cr-note">${plural(d.missing, 'saved job')} no longer ${d.missing === 1 ? 'exists' : 'exist'} and ${d.missing === 1 ? 'was' : 'were'} left out.</div>`);
    }
    const hidden = E.hiddenFinancialCount(d.def, perm(), cfg.division);
    if (hidden) {
      out.push(`<div class="cr-note">${plural(hidden, 'column')} hidden — your role can't see contract or profit figures</div>`);
    }
    return out.join('');
  }

  const STEP_GLYPH = ['&#9312;', '&#9313;', '&#9314;'];   // ① ② ③
  function stepsHtml() {
    const d = S.doc, def = d.def;
    const nJobs = currentJobs().length;
    const range = E.resolveDateRange(def.dates).label;
    const nSec = def.sections.length;
    const steps = [
      [1, 'Jobs & Dates', `${nJobs ? plural(nJobs, 'job') : 'No jobs yet'} · ${range}`],
      [2, 'Sections', `${nSec ? plural(nSec, 'section') : 'None yet'} · ${internalOn() ? 'Internal' : 'Customer-safe'}`],
      [3, 'Header & Notes', txt(def.title) || txt(d.name) || 'Title, intro, notes'],
    ];
    return steps.map(([n, label, sub]) => `<button type="button" role="tab" id="cr-step-${n}" class="cr-step${S.step === n ? ' active' : ''}"
        data-act="step" data-step="${n}" data-fk="step-${n}" aria-selected="${S.step === n}" aria-controls="cr-panel" tabindex="${S.step === n ? 0 : -1}">
        <span class="cr-step-n" aria-hidden="true">${STEP_GLYPH[n - 1]}</span>
        <span class="cr-step-txt"><span class="cr-step-label">${label}</span><span class="cr-step-sub">${esc(sub)}</span></span>
      </button>`).join('');
  }

  // The bar's moving parts, refreshed after every edit without touching the
  // field being typed into: the unsaved chip, Save, the banners, the steps.
  function updateChrome() {
    if (!S.mount || !S.doc || S.view !== 'edit') return;
    const d = S.doc;
    const dirty = isDirty();
    const chip = S.mount.querySelector('.cr-dirty');
    if (chip) chip.hidden = !dirty;
    const save = S.mount.querySelector('[data-act="save"]');
    if (save) {
      const saving = !!sentFor(d);
      save.disabled = saving || d.readOnly || !dirty;
      save.textContent = saving ? 'Saving…' : 'Save';
      save.title = d.readOnly ? 'Only an admin or level 3 user can change a shared template — use Save As'
        : !dirty ? 'No changes to save'
        : d.visibility === 'shared' ? 'Save — updates the template for everyone in the division (Ctrl+S)'
        : 'Save (Ctrl+S)';
    }
    // An output waiting on the older daily rows: its button says so and
    // takes no more clicks, so an impatient second click is not a second file.
    [['email', '&#9993; Email'], ['excel', '&#8681; Excel']].forEach(([k, label]) => {
      const b = S.mount.querySelector(`[data-act="${k}"]`);
      if (!b) return;
      const busy = !!S.busy[k];
      if (busy && b.getAttribute('aria-busy') !== 'true') {
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        b.textContent = 'Preparing…';
      } else if (!busy && b.getAttribute('aria-busy') === 'true') {
        b.disabled = false;
        b.removeAttribute('aria-busy');
        b.innerHTML = label;
      }
    });
    const sch = S.mount.querySelector('[data-act="schedule"]');
    if (sch) {
      const why = scheduleBlock(d);
      sch.disabled = !!why;
      sch.title = why || (isDirty() ? 'Schedule the saved copy of this report — save your changes first if they should go out'
        : 'Email this report on a schedule — customer-safe reports only');
    }
    const ai = S.mount.querySelector('[data-act="ai-toggle"]');
    if (ai) ai.setAttribute('aria-pressed', String(!!S.ai.open));
    const ban = S.mount.querySelector('.cr-banners');
    const bh = bannersHtml();
    if (ban && bh !== S.lastBanners) { withFocus(ban, () => { ban.innerHTML = bh; }); S.lastBanners = bh; }
    const steps = S.mount.querySelector('.cr-steps');
    const sh = stepsHtml();
    if (steps && sh !== S.lastSteps) { withFocus(steps, () => { steps.innerHTML = sh; }); S.lastSteps = sh; }
  }

  function panelHtml() {
    if (S.step === 2) return step2Html();
    if (S.step === 3) return step3Html();
    return step1Html();
  }
  function renderPanel() {
    const p = S.mount && S.mount.querySelector('.cr-panel');
    if (!p) return;
    if (S.menuEl && p.contains(S.menuEl)) closeMenu();
    withFocus(p, () => {
      p.innerHTML = panelHtml();
      p.setAttribute('aria-labelledby', `cr-step-${S.step}`);
    });
  }
  function goStep(n) {
    if (![1, 2, 3].includes(n) || !S.doc) return;
    S.step = n;
    S.editLabel = null;
    updateChrome();
    renderPanel();
  }

  // ── Step ① Jobs & Dates ─────────────────────────────────────────────
  function step1Html() {
    const d = S.doc, def = d.def;
    const range = E.resolveDateRange(def.dates);
    const combined = def.layout === 'combined';
    const custom = def.dates.preset === 'custom';
    const clients = [...new Set(projects().map(p => txt(p.client)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const askForJobs = !d.saveJobs && !d.picked.length && (d.id || d.starterId);
    return `
      <div class="cr-field">
        <div class="cr-field-head"><span class="cr-label" id="cr-jobs-label">Jobs</span><span class="cr-count" aria-live="polite">${jobCountHtml()}</span></div>
        <label class="cr-check cr-savejobs"><input type="checkbox" data-bind="save-jobs" data-fk="save-jobs"${d.saveJobs ? ' checked' : ''}>
          <span><b>Save these jobs with the report</b>
          <span class="cr-hint">Leave it off to keep the report a template — it opens with no jobs and you pick them each time you run it.</span></span></label>
        <p class="cr-callout"${askForJobs ? '' : ' hidden'}>Pick the jobs for this report — as many as you like.</p>
        <div class="cr-jobwarn">${clientWarnHtml()}</div>
        <div class="cr-jobtools">
          <input type="search" class="cr-input cr-grow" data-bind="job-search" data-fk="job-search" value="${esc(S.jobSearch)}"
            placeholder="&#128269; Search jobs…" aria-label="Search jobs by name, job number, client or status" autocomplete="off" spellcheck="false">
          <button type="button" class="btn btn-ghost cr-sm" data-act="jobs-shown" data-fk="jobs-shown" title="Add every job in the list below">Select all shown</button>
          <button type="button" class="btn btn-ghost cr-sm" data-act="jobs-clear" data-fk="jobs-clear">Clear</button>
          <button type="button" class="btn btn-ghost cr-sm" data-act="jobs-active" data-fk="jobs-active" title="Select every job that is In Progress (replaces the current selection)">All In Progress</button>
          ${clients.length ? `<select class="cr-input cr-sm" data-bind="jobs-client" data-fk="jobs-client" aria-label="Select every job for one client (replaces the current selection)">
            <option value="">Client…</option>${clients.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>` : ''}
        </div>
        <div class="cr-joblist" role="group" aria-labelledby="cr-jobs-label">${jobListHtml()}</div>
      </div>
      <div class="cr-field cr-filters">${filtersHtml()}</div>
      <div class="cr-field">
        <label class="cr-label" for="cr-preset">Dates</label>
        <div class="cr-inline">
          <select id="cr-preset" class="cr-input" data-bind="preset" data-fk="preset">
            ${E.DATE_PRESETS.map(p => `<option value="${esc(p.key)}"${def.dates.preset === p.key ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
          </select>
          ${custom ? `<label class="cr-sr" for="cr-from">From</label><input id="cr-from" type="date" class="cr-input" data-bind="from" data-fk="from" value="${esc(def.dates.from)}">
            <span aria-hidden="true">–</span>
            <label class="cr-sr" for="cr-to">To</label><input id="cr-to" type="date" class="cr-input" data-bind="to" data-fk="to" value="${esc(def.dates.to)}">`
          : def.dates.preset !== 'job_to_date' ? `<span class="cr-range">${esc(range.label)}</span>` : ''}
        </div>
        <span class="cr-hint">Job to date shows everything so far. A range limits daily production, deliveries, tickets and change orders to those dates.</span>
      </div>
      <fieldset class="cr-fieldset">
        <legend class="cr-label">Layout <span class="cr-hint-i">— matters when the report covers more than one job</span></legend>
        <label class="cr-radio"><input type="radio" name="cr-layout" value="separate" data-bind="layout" data-fk="layout-separate"${combined ? '' : ' checked'}>
          <span><b>Separate</b> — each job gets its own block</span></label>
        <label class="cr-radio"><input type="radio" name="cr-layout" value="combined" data-bind="layout" data-fk="layout-combined"${combined ? ' checked' : ''}>
          <span><b>Combined</b> — one table per section, with a Job column</span></label>
        <label class="cr-check${combined ? ' disabled' : ''}"><input type="checkbox" data-bind="pagebreak" data-fk="pagebreak"${def.pageBreakPerJob ? ' checked' : ''}${combined ? ' disabled' : ''}>
          <span>Start each job on a new page</span></label>
      </fieldset>
      <fieldset class="cr-fieldset">
        <legend class="cr-label">Orientation</legend>
        <label class="cr-radio"><input type="radio" name="cr-orient" value="portrait" data-bind="orientation" data-fk="orient-portrait"${def.orientation === 'landscape' ? '' : ' checked'}> <span>Portrait</span></label>
        <label class="cr-radio"><input type="radio" name="cr-orient" value="landscape" data-bind="orientation" data-fk="orient-landscape"${def.orientation === 'landscape' ? ' checked' : ''}>
          <span>Landscape <span class="cr-hint-i">— better for wide tables</span></span></label>
      </fieldset>`;
  }
  function jobCountHtml() {
    const n = currentJobs().length;
    return n ? `${plural(n, 'job')} selected` : 'No jobs selected';
  }

  /* The report-wide filter (definition v2 `filters`): every data section
     shows only rows on these sub codes / cost codes, on top of whatever a
     section filters itself. Chips say what is on; the list below is the
     picked jobs' codes, searchable, plus anything already chosen so a saved
     filter can always be undone. */
  function curFilters() {
    const def = S.doc.def;
    if (!def.filters || typeof def.filters !== 'object') def.filters = { costCodes: [], subCodes: [] };
    if (!Array.isArray(def.filters.costCodes)) def.filters.costCodes = [];
    if (!Array.isArray(def.filters.subCodes)) def.filters.subCodes = [];
    return def.filters;
  }
  const fkOf = s => { let h = 7; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
  function filtersHtml() {
    const f = curFilters();
    const n = f.subCodes.length + f.costCodes.length;
    const subs = subCodesFor(currentJobs());
    const subLabel = c => { const hit = subs.find(x => txt(x.code) === c); return hit ? subCodeText(hit) : c; };
    const chip = (kind, value, label) => `<span class="cr-chip${kind === 'sc' ? ' sc' : ''}"><span title="${esc(label)}">${kind === 'cc' ? 'Cost code: ' : ''}${esc(label)}</span><button type="button"
      data-act="filter-remove" data-kind="${kind}" data-value="${esc(value)}" data-fk="frm-${kind}-${fkOf(value)}" aria-label="Remove ${esc(label)} from the filter">&#10005;</button></span>`;
    return `<div class="cr-field-head"><span class="cr-label" id="cr-filter-label">Filter by sub code / cost code</span>
        <span class="cr-inline"><span class="cr-count">${n ? `${plural(n, 'code')} — every section` : 'Off'}</span>
        ${n ? '<button type="button" class="btn btn-ghost cr-sm" data-act="filters-clear" data-fk="filters-clear">Clear</button>' : ''}</span></div>
      <div class="cr-chips">${f.subCodes.map(c => chip('sc', c, subLabel(c))).join('')}${f.costCodes.map(c => chip('cc', c, c)).join('')}</div>
      <input type="search" class="cr-input" data-bind="filter-search" data-fk="filter-search" value="${esc(S.filterSearch)}"
        placeholder="&#128269; Search sub codes and cost codes…" aria-label="Search the sub codes and cost codes on the picked jobs" autocomplete="off" spellcheck="false">
      <div class="cr-flist" role="group" aria-labelledby="cr-filter-label">${filterListHtml()}</div>
      <span class="cr-hint">Tick a sub code (e.g. Turf Install) to report only on it, on every picked job. Nothing ticked shows everything; a section can narrow it further in step &#9313;.</span>`;
  }
  function filterListHtml() {
    const f = curFilters();
    const jobs = currentJobs();
    const q = S.filterSearch.trim().toLowerCase();
    const subs = subCodesFor(jobs);
    const subCodes = subs.map(x => txt(x.code));
    const subRows = subs.map(x => ({ code: txt(x.code), label: subCodeText(x) }))
      .concat(f.subCodes.filter(c => !subCodes.includes(c)).map(c => ({ code: c, label: c })));
    const ccs = E.costCodesFor(jobs);
    const ccRows = ccs.concat(f.costCodes.filter(c => !ccs.includes(c))).map(c => ({ code: c, label: c }));
    const hit = r => !q || r.label.toLowerCase().includes(q);
    const LIMIT = 150;
    const list = (rows, kind, sel) => {
      const shown = rows.filter(hit);
      const html = shown.slice(0, LIMIT).map(r => `<label class="cr-check"><input type="checkbox" data-bind="filter-${kind}" value="${esc(r.code)}"
        data-fk="f${kind}-${fkOf(r.code)}"${sel.includes(r.code) ? ' checked' : ''}> <span>${esc(r.label)}</span></label>`).join('');
      return html + (shown.length > LIMIT ? `<p class="cr-hint">${shown.length - LIMIT} more — search to narrow the list.</p>` : '');
    };
    if (!subRows.length && !ccRows.length) {
      return `<p class="cr-empty">${jobs.length ? 'These jobs have no sub codes or cost codes on their bid items.' : 'Pick jobs above to filter by their sub codes.'}</p>`;
    }
    const subHtml = list(subRows, 'sc', f.subCodes), ccHtml = list(ccRows, 'cc', f.costCodes);
    if (!subHtml && !ccHtml) return `<p class="cr-empty">No code matches “${esc(S.filterSearch.trim())}”.</p>`;
    return (subHtml ? `<div class="cr-flist-h">Sub codes</div>${subHtml}` : '')
      + (ccHtml ? `<div class="cr-flist-h">Cost codes</div>${ccHtml}` : '');
  }
  function renderFilters(listOnly) {
    const box = S.mount && S.mount.querySelector(listOnly ? '.cr-flist' : '.cr-filters');
    if (!box || !S.doc) return;
    withFocus(box, () => { box.innerHTML = listOnly ? filterListHtml() : filtersHtml(); });
  }
  function toggleFilter(kind, value, on) {
    const f = curFilters();
    const key = kind === 'sc' ? 'subCodes' : 'costCodes';
    const list = f[key].slice();
    const at = list.indexOf(value);
    if (on && at < 0) {
      if (list.length >= MAX_FILTER) { toast(`A filter can hold up to ${MAX_FILTER} codes.`, 'error'); renderFilters(); return; }
      list.push(value);
    }
    if (!on && at >= 0) list.splice(at, 1);
    f[key] = list;
    renderFilters();
    changed();
  }
  // A customer report spanning several clients is the one way to send one
  // owner another owner's job by accident. Say so while it can be fixed.
  function clientWarnHtml() {
    const clients = new Set(currentJobs().map(p => txt(p.client).toLowerCase()).filter(Boolean));
    if (clients.size < 2) return '';
    return `<span class="cr-warn">&#9888; These jobs are for ${clients.size} different clients — check before sending this to a customer.</span>`;
  }
  function matchJob(p, q) {
    if (!q) return true;
    return [p['project-name'], p['job-number'], p.client, p.status].some(v => txt(v).toLowerCase().includes(q));
  }
  function jobListHtml() {
    const all = projects();
    S.lastJobCount = all.length;
    if (!all.length) {
      // Opened before the page has its job list: say so, and redraw when the
      // jobs arrive, rather than tell the user the division has none.
      if (!S.readyDone) { watchJobs(); return '<p class="cr-empty cr-jobs-loading" style="padding:.7rem">Loading jobs…</p>'; }
      return '<p class="cr-empty" style="padding:.7rem">No jobs in this division yet.</p>';
    }
    const q = S.jobSearch.trim().toLowerCase();
    const picked = new Set(S.doc.picked.map(String));
    const shown = all.filter(p => matchJob(p, q));
    if (!shown.length) return `<p class="cr-empty" style="padding:.7rem">No jobs match “${esc(S.jobSearch.trim())}”.</p>`;
    const counts = contactCounts();
    return shown.map(p => {
      const id = String(p.id), on = picked.has(id);
      const meta = [txt(p['job-number']) ? '#' + txt(p['job-number']) : '', txt(p.status), txt(p.client)].filter(Boolean).join(' · ');
      const nc = counts(p);
      return `<label class="cr-job${on ? ' on' : ''}">
        <input type="checkbox" data-bind="job" value="${esc(id)}"${on ? ' checked' : ''}>
        <span class="cr-job-name">${esc(jobName(p))}</span>${meta ? `<span class="cr-job-meta">${esc(meta)}</span>` : ''}
        ${nc ? `<button type="button" class="cr-job-ct" data-act="job-contacts" data-id="${esc(id)}" title="Saved contacts for this job and its client — they fill in the email">${plural(nc, 'contact')}</button>` : ''}
      </label>`;
    }).join('');
  }
  function watchJobs() {
    if (S.jobWatch) return;
    S.jobWatch = setInterval(() => {
      const n = projects().length;
      if (!S.doc || S.view !== 'edit' || !S.mount || !S.mount.isConnected) { clearInterval(S.jobWatch); S.jobWatch = 0; return; }
      if (!n && !S.readyDone) return;
      clearInterval(S.jobWatch);
      S.jobWatch = 0;
      jobsArrived();
    }, 500);
  }
  // The job list has changed size since step ① was drawn: redraw it (the
  // Client picker with it), the step strip and the preview.
  function jobsArrived() {
    if (!S.doc || S.view !== 'edit') return;
    if (S.step === 1) renderPanel();
    updateChrome();
    schedulePreview(true);
  }
  function renderJobList() {
    if (!S.mount) return;
    const list = S.mount.querySelector('.cr-joblist');
    if (list) list.innerHTML = jobListHtml();
    refreshJobCount();
  }
  /* Saved contacts a job's email would pre-fill: its own and its client's.
     Counted once per draw (by job, by client key), so a long job list
     against a long contact list stays a single pass over each. */
  function contactCounts() {
    const byJob = new Map(), byClient = new Map();
    (Array.isArray(S.contacts) ? S.contacts : []).forEach(c => {
      if (!c) return;
      if (c.project_id != null) byJob.set(String(c.project_id), (byJob.get(String(c.project_id)) || 0) + 1);
      else if (c.client_key) byClient.set(c.client_key, (byClient.get(c.client_key) || 0) + 1);
    });
    return p => (byJob.get(String(p.id)) || 0) + (byClient.get(clientKey(p.client)) || 0);
  }
  function refreshJobCount() {
    const c = S.mount && S.mount.querySelector('.cr-count');
    if (c) c.textContent = jobCountHtml();
    const w = S.mount && S.mount.querySelector('.cr-jobwarn');
    if (w) w.innerHTML = clientWarnHtml();
    const call = S.mount && S.mount.querySelector('.cr-callout');
    if (call && S.doc && S.doc.picked.length) call.hidden = true;
    // The filter offers the picked jobs' codes.
    if (S.mount && S.mount.querySelector('.cr-filters')) renderFilters();
  }

  // ── Step ② Sections ─────────────────────────────────────────────────
  function step2Html() {
    const def = S.doc.def;
    const noCosts = perm().canSeeCosts === false;
    const on = internalOn();
    const n = def.sections.length;
    return `
      <div class="cr-safe${on ? ' on' : ''}">
        <label class="cr-switch"><input type="checkbox" role="switch" data-bind="internal" data-fk="internal"
          aria-describedby="cr-safe-desc"${on ? ' checked' : ''}${noCosts ? ' disabled' : ''}><span class="cr-switch-ui" aria-hidden="true"></span>
          <span>Include internal data</span></label>
        <p class="cr-safe-desc" id="cr-safe-desc">${noCosts ? 'Your role can’t add internal data to a report — every report you make is customer-safe.'
          : on ? 'Internal columns are unlocked. Costs, rates, hours, employee names and profit can print on this report.'
          : '<b>Customer-safe.</b> Costs, rates, wages, hours, employee names, profit and contract dollars are locked &#128274;.'}</p>
      </div>
      <div class="cr-sections">${n ? def.sections.map((s, i) => secHtml(s, i, n)).join('')
        : '<p class="cr-empty">No sections yet. <b>Job Information</b> and <b>Bid Item Progress</b> make a good customer update — or start from a starter template.</p>'}</div>
      <div class="cr-add">
        <button type="button" class="btn btn-green" data-act="add-menu" data-fk="add-menu" aria-haspopup="menu" aria-expanded="false"${n >= MAX_SECTIONS ? ' disabled' : ''}>+ Add section</button>
        <span class="cr-hint-i">${n} of ${MAX_SECTIONS}</span>
      </div>`;
  }

  function secSummary(s) {
    if (s.type === 'notes') {
      const t = txt(s.text);
      return t ? t.split(/\r?\n/)[0].slice(0, 120) : 'No text yet';
    }
    const cols = shownColumns(s);
    if (!cols.length) return 'No columns that can print — expand to choose some';
    const noun = s.type === 'chart' ? 'measure' : (E.CATALOG[s.type] || {}).table === false ? 'figure' : 'column';
    return `${plural(cols.length, noun)}: ${cols.map(c => c.label).join(', ')}`;
  }
  // The chosen columns that can print here (this role, this division, the
  // customer-safe switch), with their printed labels.
  const colState = (type, key) => E.columnState(type, key, S.doc.def, perm(), cfg.division);
  function shownColumns(s) {
    const cat = E.CATALOG[s.type];
    if (!cat || !Array.isArray(s.columns)) return [];
    return s.columns.map(k => cat.columns.find(c => c.key === k)).filter(c => c && colState(s.type, c.key) === 'available')
      .map(c => ({ key: c.key, label: (s.labels && s.labels[c.key]) || c.label }));
  }
  function secHtml(s, i, n) {
    const cat = E.CATALOG[s.type];
    const open = !S.collapsed.has(s.id);
    const title = txt(s.title) || cat.label;
    return `<div class="cr-sec" data-sec="${s.id}">
      <div class="cr-sec-head">
        <button type="button" class="cr-icon ghost" data-act="sec-toggle" data-sec="${s.id}" data-fk="sectoggle-${s.id}"
          aria-expanded="${open}" aria-controls="cr-secbody-${s.id}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(title)}">${open ? '&#9662;' : '&#9656;'}</button>
        <div class="cr-sec-names">
          <span class="cr-sec-type">${esc(cat.label)}</span>
          <input class="cr-input cr-sec-title" data-bind="sec-title" data-sec="${s.id}" data-fk="sectitle-${s.id}" value="${esc(s.title)}"
            placeholder="${esc(cat.label)}" maxlength="120" aria-label="Printed heading for this ${esc(cat.label)} section">
        </div>
        <div class="cr-sec-tools">
          <button type="button" class="cr-icon" data-act="sec-up" data-sec="${s.id}" data-fk="secup-${s.id}" aria-label="Move ${esc(title)} up" title="Move up"${i === 0 ? ' disabled' : ''}>&#8593;</button>
          <button type="button" class="cr-icon" data-act="sec-down" data-sec="${s.id}" data-fk="secdown-${s.id}" aria-label="Move ${esc(title)} down" title="Move down"${i === n - 1 ? ' disabled' : ''}>&#8595;</button>
          <button type="button" class="cr-icon" data-act="sec-remove" data-sec="${s.id}" data-fk="secremove-${s.id}" aria-label="Remove ${esc(title)}" title="Remove section">&#10005;</button>
        </div>
      </div>
      ${open ? `<div class="cr-sec-body" id="cr-secbody-${s.id}">
          <p class="cr-blurb">${esc(cat.blurb)}</p>
          ${s.type === 'notes' ? notesEditorHtml(s, false) : colsHtml(s) + optsHtml(s)}
        </div>`
        : `<div class="cr-sec-sum" id="cr-secbody-${s.id}">${esc(secSummary(s))}</div>`}
    </div>`;
  }

  /* The column list: the chosen columns first in their printed order (with
     ↑ ↓ and ✎), then the rest of what this report may show, then — while the
     report is customer-safe — the internal ones, greyed with a lock. A
     column the role may never see (contract and profit for level 1 / 2) is
     not listed at all; the engine drops it from output either way. */
  function colsHtml(s) {
    const cat = E.CATALOG[s.type];
    const byKey = {};
    cat.columns.forEach(c => { byKey[c.key] = c; });
    // A column scoped to another division (paving's tons per load on a turf
    // report) is 'hidden' and never listed.
    const st = k => colState(s.type, k);
    const chosen = s.columns.filter(k => byKey[k] && st(k) === 'available');
    const more = cat.columns.filter(c => !s.columns.includes(c.key) && st(c.key) === 'available');
    const locked = cat.columns.filter(c => st(c.key) === 'locked');
    let html = '<div class="cr-cols" role="group" aria-label="Columns">';
    html += `<div class="cr-subhead">${s.type === 'chart' ? 'Measures drawn' : cat.table === false ? 'Showing' : 'Columns, in printed order'}</div>`;
    html += chosen.length ? chosen.map((k, i) => colRowHtml(s, byKey[k], true, i === 0, i === chosen.length - 1)).join('')
      : '<p class="cr-empty">Nothing chosen — tick some below.</p>';
    if (more.length) html += '<div class="cr-subhead">More</div>' + more.map(c => colRowHtml(s, c, false)).join('');
    if (locked.length) {
      html += '<div class="cr-subhead">Internal — locked while customer-safe</div>'
        + locked.map(c => lockedRowHtml(s, c, s.columns.includes(c.key))).join('');
    }
    return html + '</div>';
  }
  function colRowHtml(s, c, on, first, last) {
    const custom = s.labels[c.key];
    const fk = `${s.id}-${c.key}`;
    const editing = on && S.editLabel && S.editLabel.sec === s.id && S.editLabel.key === c.key;
    const shown = custom || c.label;
    return `<div class="cr-col${on ? ' on' : ''}">
      <label class="cr-col-label"><input type="checkbox" data-bind="col" data-sec="${s.id}" data-key="${esc(c.key)}" data-fk="col-${fk}"${on ? ' checked' : ''}>
        ${editing ? `<span class="cr-sr">${esc(c.label)}</span>` : `<span class="cr-col-name">${esc(shown)}</span>${custom ? `<span class="cr-col-orig">(${esc(c.label)})</span>` : ''}`}
        ${c.internal ? '<span class="cr-tag-int">Internal</span>' : ''}</label>
      ${editing ? `<input class="cr-input cr-col-edit" data-bind="col-label" data-sec="${s.id}" data-key="${esc(c.key)}" data-fk="collabel-${fk}"
          value="${esc(custom || '')}" placeholder="${esc(c.label)}" maxlength="60" aria-label="Printed label for ${esc(c.label)} — leave blank for the standard label">` : ''}
      ${on ? `<span class="cr-col-tools">
          <button type="button" class="cr-icon" data-act="col-up" data-sec="${s.id}" data-key="${esc(c.key)}" data-fk="colup-${fk}" aria-label="Move ${esc(shown)} earlier" title="Move earlier"${first ? ' disabled' : ''}>&#8593;</button>
          <button type="button" class="cr-icon" data-act="col-down" data-sec="${s.id}" data-key="${esc(c.key)}" data-fk="coldown-${fk}" aria-label="Move ${esc(shown)} later" title="Move later"${last ? ' disabled' : ''}>&#8595;</button>
          <button type="button" class="cr-icon" data-act="col-label" data-sec="${s.id}" data-key="${esc(c.key)}" data-fk="colrename-${fk}" aria-label="Rename the printed label for ${esc(shown)}" title="Rename the printed label" aria-pressed="${editing ? 'true' : 'false'}">&#9998;</button>
        </span>` : ''}
    </div>`;
  }
  function lockedRowHtml(s, c, chosen) {
    const tip = 'Internal — switch on “Include internal data” to use this column';
    return `<div class="cr-col locked" title="${tip}">
      <label class="cr-col-label"><input type="checkbox" disabled data-bind="col" data-sec="${s.id}" data-key="${esc(c.key)}" aria-describedby="cr-safe-desc">
        <span aria-hidden="true">&#128274;</span><span class="cr-col-name">${esc(s.labels[c.key] || c.label)}</span>
        ${chosen ? '<span class="cr-col-orig">kept for when internal data is on</span>' : ''}<span class="cr-sr">${tip}</span></label>
    </div>`;
  }

  function optsHtml(s) {
    const specs = E.CATALOG[s.type].optionSpec || [];
    if (!specs.length) return '';
    return `<div class="cr-opts"><div class="cr-subhead">Options</div>${specs.map(sp => optHtml(s, sp)).join('')}</div>`;
  }
  function optHtml(s, sp) {
    const v = s.options[sp.key];
    const fk = `opt-${s.id}-${sp.key}`;
    if (sp.kind === 'select') {
      return `<label class="cr-opt">${esc(sp.label)}
        <select class="cr-input cr-sm" data-bind="opt" data-sec="${s.id}" data-key="${esc(sp.key)}" data-fk="${fk}">
          ${sp.choices.map(([val, label]) => `<option value="${esc(val)}"${v === val ? ' selected' : ''}>${esc(label)}</option>`).join('')}
        </select></label>`;
    }
    if (sp.kind === 'bool') {
      return `<label class="cr-check cr-opt"><input type="checkbox" data-bind="opt" data-sec="${s.id}" data-key="${esc(sp.key)}" data-fk="${fk}"${v ? ' checked' : ''}> ${esc(sp.label)}</label>`;
    }
    if (sp.kind === 'kinds') {
      const list = Array.isArray(v) ? v : [];
      return `<fieldset class="cr-fs"><legend>${esc(sp.label)}</legend><div class="cr-inline">
        ${sp.choices.map(([val, label]) => `<label class="cr-check"><input type="checkbox" data-bind="opt-kind" data-sec="${s.id}" data-value="${esc(val)}"
          data-fk="${fk}-${esc(val)}"${list.includes(val) ? ' checked' : ''}> ${esc(label)}</label>`).join('')}
      </div></fieldset>`;
    }
    // The sub-code picker, whatever kind name the catalog gives it.
    if (sp.key === 'subCodes' || sp.kind === 'subCodes') return subCodesHtml(s, sp);
    if (sp.kind === 'costCodes') return costCodesHtml(s, sp);
    return '';
  }
  // Like the cost-code picker: the picked jobs' sub codes, plus any the
  // section already filters on.
  function subCodesHtml(s, sp) {
    const sel = Array.isArray(s.options[sp.key]) ? s.options[sp.key] : [];
    const jobs = currentJobs();
    const subs = subCodesFor(jobs);
    const codes = subs.map(x => txt(x.code));
    const rows = subs.map(x => ({ code: txt(x.code), label: subCodeText(x) }))
      .concat(sel.filter(c => !codes.includes(c)).map(c => ({ code: c, label: c })));
    if (!rows.length) {
      return `<div class="cr-fs"><span class="cr-opt">${esc(sp.label || 'Sub codes')}:</span>
        <span class="cr-hint-i">${jobs.length ? 'these jobs have no sub codes on their bid items' : 'pick jobs in step &#9312; to filter by sub code'}</span></div>`;
    }
    return `<fieldset class="cr-fs"><legend>${esc(sp.label || 'Sub codes')} <span class="cr-hint-i">${sel.length ? `${sel.length} of ${rows.length} shown` : 'all shown'}</span>
        ${sel.length ? `<button type="button" class="cr-linkbtn" data-act="sc-all" data-sec="${s.id}" data-key="${esc(sp.key)}" data-fk="scall-${s.id}">Show all</button>` : ''}</legend>
      <div class="cr-cc-list">${rows.map(r => `<label class="cr-check"><input type="checkbox" data-bind="opt-sc" data-sec="${s.id}" data-key="${esc(sp.key)}" data-value="${esc(r.code)}"
        data-fk="sc-${s.id}-${fkOf(r.code)}"${sel.includes(r.code) ? ' checked' : ''}> ${esc(r.label)}</label>`).join('')}</div>
      <span class="cr-hint">Tick sub codes to show only those in this section. None ticked shows every sub code the report filter allows.</span></fieldset>`;
  }
  // Built from the bid items of the jobs picked in step ①, plus any code the
  // section already filters on, so a saved filter can always be undone.
  function costCodesHtml(s, sp) {
    const sel = Array.isArray(s.options[sp.key]) ? s.options[sp.key] : [];
    const jobs = currentJobs();
    const codes = E.costCodesFor(jobs);
    const all = codes.concat(sel.filter(c => !codes.includes(c)));
    if (!all.length) {
      return `<div class="cr-fs"><span class="cr-opt">${esc(sp.label)}:</span>
        <span class="cr-hint-i">${jobs.length ? 'these jobs have no cost codes on their bid items' : 'pick jobs in step &#9312; to filter by cost code'}</span></div>`;
    }
    return `<fieldset class="cr-fs"><legend>${esc(sp.label)} <span class="cr-hint-i">${sel.length ? `${sel.length} of ${all.length} shown` : 'all shown'}</span>
        ${sel.length ? `<button type="button" class="cr-linkbtn" data-act="cc-all" data-sec="${s.id}" data-fk="ccall-${s.id}">Show all</button>` : ''}</legend>
      <div class="cr-cc-list">${all.map((c, i) => `<label class="cr-check"><input type="checkbox" data-bind="opt-cc" data-sec="${s.id}" data-value="${esc(c)}"
        data-fk="cc-${s.id}-${i}"${sel.includes(c) ? ' checked' : ''}> ${esc(c)}</label>`).join('')}</div>
      <span class="cr-hint">Tick codes to show only those. None ticked shows every code.</span></fieldset>`;
  }
  function notesEditorHtml(s, withTitle) {
    return `${withTitle ? `<label class="cr-label" for="cr-ntitle-${s.id}">Heading</label>
        <input id="cr-ntitle-${s.id}" class="cr-input" data-bind="sec-title" data-sec="${s.id}" data-fk="ntitle-${s.id}" value="${esc(s.title)}" placeholder="Notes" maxlength="120">` : ''}
      <label class="${withTitle ? 'cr-label' : 'cr-sr'}" for="cr-ntext-${s.id}">Text</label>
      <textarea id="cr-ntext-${s.id}" class="cr-input" data-bind="sec-text" data-sec="${s.id}" data-fk="ntext-${s.id}" rows="5" maxlength="5000"
        placeholder="Write it as you want the customer to read it. A blank line starts a new paragraph.">${esc(s.text || '')}</textarea>`;
  }

  // ── Step ③ Header & Notes ───────────────────────────────────────────
  function step3Html() {
    const d = S.doc, def = d.def, h = def.header;
    const jobs = currentJobs();
    const client = jobs.length === 1 ? txt(jobs[0].client) : '';
    const me = preparerName();
    const notes = def.sections.filter(s => s.type === 'notes');
    const full = def.sections.length >= MAX_SECTIONS;
    return `
      <div class="cr-grid2">
        <div class="cr-field"><label class="cr-label" for="cr-title">Report title</label>
          <input id="cr-title" class="cr-input" data-bind="title" data-fk="title" value="${esc(def.title)}" maxlength="120"
            placeholder="${esc(txt(d.name) || 'Custom Report')}">
          <span class="cr-hint">Printed at the top. Blank uses the report name.</span></div>
        <div class="cr-field"><label class="cr-label" for="cr-desc">Description</label>
          <input id="cr-desc" class="cr-input" data-bind="description" data-fk="description" value="${esc(d.description)}" maxlength="500"
            placeholder="What it is for">
          <span class="cr-hint">Shown in the report list. Not printed.</span></div>
        <div class="cr-field"><label class="cr-label" for="cr-pfor">Prepared for</label>
          <input id="cr-pfor" class="cr-input" data-bind="h-preparedFor" data-fk="h-preparedFor" value="${esc(h.preparedFor)}" maxlength="200"
            placeholder="${esc(client ? `${client} (the job’s client)` : 'Customer name')}">
          <span class="cr-hint">Blank uses the job’s client when the report covers one job.</span></div>
        <div class="cr-field"><label class="cr-label" for="cr-pby">Prepared by</label>
          <input id="cr-pby" class="cr-input" data-bind="h-preparedBy" data-fk="h-preparedBy" value="${esc(h.preparedBy)}" maxlength="200"
            placeholder="${esc(me ? `${me} (you)` : 'Your name')}">
          <span class="cr-hint">Blank uses your name.</span></div>
      </div>
      <div class="cr-field"><label class="cr-label" for="cr-intro">Intro message</label>
        <textarea id="cr-intro" class="cr-input" data-bind="h-intro" data-fk="h-intro" rows="4" maxlength="4000"
          placeholder="A few lines under the title — what was done, what’s next.">${esc(h.intro)}</textarea></div>
      <div class="cr-field"><label class="cr-label" for="cr-footer">Footer note</label>
        <input id="cr-footer" class="cr-input" data-bind="h-footer" data-fk="h-footer" value="${esc(h.footer)}" maxlength="300"
          placeholder="e.g. Thank you for your business."></div>
      <label class="cr-check"><input type="checkbox" data-bind="h-showGenerated" data-fk="h-showGenerated"${h.showGenerated ? ' checked' : ''}>
        <span>Show when the report was generated</span></label>
      ${brandingFieldsHtml()}
      <h3 class="cr-h3">Notes sections</h3>
      ${notes.length ? notes.map(s => `<div class="cr-field">${notesEditorHtml(s, true)}</div>`).join('')
        : '<p class="cr-empty">No notes yet. A note prints as its own section, in the order set in step &#9313;.</p>'}
      <button type="button" class="btn btn-ghost cr-sm" data-act="add-section" data-type="notes" data-fk="add-note"${full ? ' disabled' : ''}>+ Add a note</button>`;
  }
  /* Branding (the company's name and logo, or plain DataWatch), the PM line
     on each job and the footer's "Questions?" contact. The placeholders show
     what prints when a field is left blank. */
  function brandingFieldsHtml() {
    const h = S.doc.def.header;
    const jobs = currentJobs();
    const b = brandingOpt();
    const hasBrand = !!(b && (b.display_name || b.logo));
    const brandMode = h.branding === 'datawatch' ? 'datawatch' : 'company';
    const dflt = defaultReportContact(jobs) || {};
    const pmShown = jobs.filter(p => pmContactFor(p)).length;
    const ph = (v, fallback) => esc(v ? `${v} (default)` : fallback);
    return `
      <h3 class="cr-h3">Branding &amp; contacts</h3>
      <div class="cr-grid2">
        <div class="cr-field"><label class="cr-label" for="cr-brand">Masthead</label>
          <select id="cr-brand" class="cr-input" data-bind="h-branding" data-fk="h-branding">
            <option value="company"${brandMode === 'company' ? ' selected' : ''}>Company branding</option>
            <option value="datawatch"${brandMode === 'datawatch' ? ' selected' : ''}>DataWatch only</option>
          </select>
          <span class="cr-hint">${hasBrand ? `Shows ${esc(b.display_name || 'your company')}${b.logo ? ' and its logo' : ''} at the top.`
            : 'No company branding is set up yet — an admin can add the name and logo in Manage System → Branding. Until then the DataWatch masthead prints.'}</span></div>
        <div class="cr-field"><span class="cr-label">Project manager</span>
          <label class="cr-check"><input type="checkbox" data-bind="h-showPmContact" data-fk="h-showPmContact"${h.showPmContact !== false ? ' checked' : ''}>
            <span>Show project manager contact on each job</span></label>
          <span class="cr-hint">${jobs.length ? (pmShown ? `${plural(pmShown, 'job')} of ${jobs.length} ${pmShown === 1 ? 'has' : 'have'} a PM phone or email in the Team Directory.`
            : 'None of these jobs’ PMs has a phone or email in the Team Directory yet.') : 'The PM’s phone and email come from the Team Directory.'}</span></div>
      </div>
      <fieldset class="cr-fieldset">
        <legend class="cr-label">Report contact <span class="cr-hint-i">— the “Questions?” line in the footer</span></legend>
        <div class="cr-grid2">
          <div class="cr-field"><label class="cr-sr" for="cr-cname">Contact name</label>
            <input id="cr-cname" class="cr-input" data-bind="h-contactName" data-fk="h-contactName" value="${esc(h.contactName || '')}" maxlength="120"
              placeholder="${ph(dflt.name, 'Contact name')}" autocomplete="off"></div>
          <div class="cr-field"><label class="cr-sr" for="cr-cphone">Contact phone</label>
            <input id="cr-cphone" class="cr-input" data-bind="h-contactPhone" data-fk="h-contactPhone" value="${esc(h.contactPhone || '')}" maxlength="120"
              placeholder="${ph(dflt.phone, 'Phone')}" autocomplete="off" inputmode="tel"></div>
          <div class="cr-field"><label class="cr-sr" for="cr-cemail">Contact email</label>
            <input id="cr-cemail" class="cr-input" data-bind="h-contactEmail" data-fk="h-contactEmail" value="${esc(h.contactEmail || '')}" maxlength="120"
              placeholder="${ph(dflt.email, 'Email')}" autocomplete="off" inputmode="email"></div>
        </div>
        <span class="cr-hint">${dflt.name || dflt.phone || dflt.email ? 'Leave all three blank to use the default shown.' : 'Leave blank for no contact line.'} Typing any of them replaces the default.</span>
      </fieldset>`;
  }

  // ── Live preview ────────────────────────────────────────────────────
  // The exact print document in a sandboxed frame (no scripts run in it).
  // Redrawn a beat after the last change so typing does not rebuild a
  // twenty-job report on every keystroke. The beat stretches with the report:
  // a build that takes 400 ms waits twice that, and while someone is typing
  // into a text box a slow build waits for them to pause — a full rebuild on
  // the main thread is a frozen text box.
  function schedulePreview(now) {
    if (!S.doc) return;
    clearTimeout(S.pvTimer);
    const delay = now ? 0 : Math.max(PREVIEW_DELAY, Math.min(PREVIEW_MAX_DELAY, 2 * S.lastBuildMs));
    S.pvTimer = setTimeout(previewDue, delay);
  }
  function typingInBuilder() {
    const a = document.activeElement;
    return !!(a && S.mount && S.mount.contains(a) && (a.tagName === 'TEXTAREA'
      || (a.tagName === 'INPUT' && /^(text|search|)$/.test(a.getAttribute('type') || ''))));
  }
  function previewDue() {
    const since = Date.now() - S.lastTypeAt;
    if (S.lastBuildMs >= SLOW_BUILD_MS && since < TYPING_IDLE && typingInBuilder()) {
      clearTimeout(S.pvTimer);
      S.pvTimer = setTimeout(previewDue, TYPING_IDLE - since);
      return;
    }
    renderPreview();
  }
  const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  function renderPreview() {
    clearTimeout(S.pvTimer);
    S.pvTimer = 0;
    if (!S.mount || !S.doc || S.view !== 'edit') return;
    const frame = S.mount.querySelector('.cr-frame');
    const hint = S.mount.querySelector('.cr-preview-hint');
    const note = S.mount.querySelector('.cr-preview-note');
    if (!frame) return;
    let built;
    const t0 = clock();
    try { built = buildCurrent(); S.lastBuildMs = clock() - t0; }
    catch (err) {
      console.error('[custom-reports] preview failed:', err);
      if (hint) { hint.hidden = false; hint.textContent = 'The preview could not be drawn: ' + err.message; }
      return;
    }
    const nJobs = built.ctx.jobs.length, nSec = built.def.sections.length;
    if (hint) {
      const msg = !nJobs
        ? '<span>Pick one or more jobs to see the report.</span><button type="button" class="btn btn-ghost cr-sm" data-act="step" data-step="1">Pick jobs</button>'
        : !nSec ? '<span>The report has no sections yet.</span><button type="button" class="btn btn-ghost cr-sm" data-act="step" data-step="2">Add a section</button>'
        : '';
      hint.hidden = !msg;
      hint.innerHTML = msg;
    }
    if (note) note.textContent = S.readyDone ? '' : 'Loading older daily entries…';
    try {
      const w = frame.contentWindow;
      if (w && w.document && w.document.documentElement) S.pvScroll = w.scrollY || w.document.documentElement.scrollTop || 0;
    } catch (_) { /* nothing to remember */ }
    if (frame.getAttribute('srcdoc') !== built.html) frame.setAttribute('srcdoc', built.html);
    fitPreview();
  }

  /* The preview is the printed page, so it is drawn at the width of the
     sheet and scaled down to the pane — a wide table then sits where it will
     on paper instead of running off the side of a narrow frame. On a phone a
     whole sheet would shrink past reading, so there the report reflows to
     the pane (its own small-screen rule) and a wide table scrolls inside it.
     100% — or a desktop pane too narrow for a readable Fit, like a 1280 px
     laptop's — shows the sheet at its printed width and scrolls both ways, so
     every column the user ticked is on the page, at a size they can read. */
  function fitPreview() {
    const frame = S.mount && S.mount.querySelector('.cr-frame');
    const wrap = frame && frame.parentElement;
    if (!frame || !wrap || !S.doc) return;
    const sheet = SHEET_PX[S.doc.def.orientation === 'landscape' ? 'landscape' : 'portrait'];
    const avail = wrap.clientWidth, tall = wrap.clientHeight;
    const k = avail / sheet;
    const natural = () => {
      frame.classList.remove('paged', 'actual');
      wrap.classList.remove('cr-scroll');
      frame.style.width = frame.style.height = frame.style.transform = '';
    };
    const actual = () => {
      frame.classList.remove('paged');
      frame.classList.add('actual');
      wrap.classList.add('cr-scroll');
      frame.style.transform = '';
      frame.style.width = sheet + 'px';
      frame.style.height = '100%';
    };
    if (S.zoom === '100') { actual(); return; }
    const phone = (window.innerWidth || document.documentElement.clientWidth || 1024) < PHONE_BELOW;
    if (!avail || !tall || phone || k >= 1) { natural(); return; }
    if (k < MIN_FIT) { actual(); return; }
    frame.classList.remove('actual');
    wrap.classList.remove('cr-scroll');
    frame.classList.add('paged');
    frame.style.width = sheet + 'px';
    frame.style.height = Math.ceil(tall / k) + 'px';
    frame.style.transform = `scale(${k.toFixed(4)})`;
  }
  function setZoom(z) {
    S.zoom = z === '100' ? '100' : 'fit';
    try { localStorage.setItem(ZOOM_KEY, S.zoom); } catch (_) { /* a convenience only */ }
    if (S.mount) S.mount.querySelectorAll('[data-act="zoom"]').forEach(b => b.setAttribute('aria-pressed', String(b.getAttribute('data-zoom') === S.zoom)));
    fitPreview();
  }
  // The same report, full size in its own tab — no print dialog.
  function openFullPreview() {
    if (!S.doc) return;
    const win = window.open('', '_blank');
    if (!win) { alert('Your browser blocked the preview window. Allow pop-ups for this site and try again.'); return; }
    let built;
    try { built = buildCurrent(); }
    catch (err) { try { win.close(); } catch (_) { /* fine */ } toast('Couldn’t build the report: ' + err.message, 'error'); return; }
    const write = window.dwWrite || ((w, h) => w.document.write(h));
    write(win, built.html);
    win.document.close();
  }

  // Every edit ends here: remember the report was touched, then redraw what
  // the edit affects. The preview is debounced; the bar is cheap.
  function changed(o) {
    o = o || {};
    if (!S.doc) return;
    S.doc.touched = true;
    if (o.panel) renderPanel();
    updateChrome();
    if (o.preview !== false) schedulePreview();
  }

  // ── Menus ───────────────────────────────────────────────────────────
  // Opened on demand next to their button and positioned fixed, so the
  // scrolling rail cannot clip a menu at its bottom edge. They live inside
  // the mount, which means their buttons go through the same delegated
  // click handler as everything else.
  function openMenu(trigger, items, align) {
    const again = S.menuTrigger === trigger;
    closeMenu();
    if (again) return; // second click on the same button closes it
    const m = document.createElement('div');
    m.className = 'cr-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = items.map(it => `<button type="button" role="menuitem" class="cr-menu-item${it.danger ? ' danger' : ''}"
      data-act="${it.act}"${it.id != null ? ` data-id="${esc(it.id)}"` : ''}${it.type ? ` data-type="${esc(it.type)}"` : ''}>
      <b>${esc(it.label)}</b>${it.blurb ? `<small>${esc(it.blurb)}</small>` : ''}</button>`).join('');
    S.mount.querySelector('.cr-root').appendChild(m);
    const r = trigger.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const vh = window.innerHeight || document.documentElement.clientHeight || 768;
    const w = Math.min(m.offsetWidth || 240, vw - 16);
    let left = align === 'left' ? r.left : r.right - w;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const h = m.offsetHeight || 0;
    let top = r.bottom + 4;
    if (h && top + h > vh - 8) {
      const below = vh - 8 - (r.bottom + 4), above = r.top - 4 - 8;
      if (h <= above) top = r.top - h - 4;
      else {
        // Fits neither side (a long menu on a phone): the side with more
        // room, the menu cut to it and scrolling inside — never running off
        // the screen with its last items out of reach.
        const room = Math.max(120, below, above);
        m.style.maxHeight = `${Math.floor(room)}px`;
        const mh = m.offsetHeight || room;
        top = below >= above ? r.bottom + 4 : r.top - 4 - mh;
      }
    }
    top = Math.max(8, Math.min(top, vh - (m.offsetHeight || h) - 8));
    m.style.left = `${Math.round(left)}px`;
    m.style.top = `${Math.round(top)}px`;
    trigger.setAttribute('aria-expanded', 'true');
    S.menuEl = m;
    S.menuTrigger = trigger;
    const first = m.querySelector('button');
    if (first) first.focus();
  }
  function closeMenu(refocus) {
    if (!S.menuEl) return;
    const t = S.menuTrigger;
    S.menuEl.remove();
    S.menuEl = null;
    S.menuTrigger = null;
    if (t) {
      t.setAttribute('aria-expanded', 'false');
      if (refocus && t.isConnected) t.focus();
    }
  }
  function itemMenu(trigger, id) {
    const r = S.reports.find(x => sameId(x.id, id));
    if (!r) return;
    const items = [{ act: 'menu-open', id: r.id, label: 'Open' }, { act: 'menu-duplicate', id: r.id, label: 'Duplicate', blurb: 'A private copy you can change' }];
    if (S.canShare) {
      items.push({ act: 'menu-schedule', id: r.id, label: 'Schedule…',
        blurb: r.customer_safe === false ? 'Customer-safe reports only — switch internal data off first' : 'Email it on a schedule' });
    }
    if (r.can_edit) {
      items.push({ act: 'menu-rename', id: r.id, label: 'Rename' });
      items.push({ act: 'menu-delete', id: r.id, label: 'Delete', danger: true, blurb: 'Restorable for 30 days' });
    }
    openMenu(trigger, items, 'right');
  }
  function docMenu(trigger) {
    const d = S.doc;
    const items = [];
    if (d.id && S.canShare) {
      items.push(d.visibility === 'shared'
        ? { act: 'make-private', label: 'Make private', blurb: 'Only its owner will see it' }
        : { act: 'share', label: 'Share with division', blurb: `Everyone in ${divLabel()} can run it` });
    }
    items.push({ act: 'duplicate', label: 'Duplicate', blurb: 'Save a copy, with your changes' });
    if (S.canShare) items.push({ act: 'schedule', label: 'Schedule…', blurb: scheduleBlock(d) || 'Email the saved report on a schedule' });
    if (d.picked.length === 1) items.push({ act: 'customer', id: d.picked[0], label: 'Customer History', blurb: 'What this job’s customer has been sent' });
    if (d.id && d.can_edit) items.push({ act: 'delete', label: 'Delete', danger: true, blurb: 'Restorable for 30 days' });
    items.push({ act: 'close', label: 'Close report' });
    openMenu(trigger, items, 'right');
  }
  function addMenu(trigger) {
    openMenu(trigger, E.SECTION_ORDER.filter(t => E.CATALOG[t]).map(t => ({
      act: 'add-section', type: t, label: E.CATALOG[t].label, blurb: E.CATALOG[t].blurb,
    })), 'left');
  }

  // ── Dialogs and toasts ──────────────────────────────────────────────
  function modal(title, bodyHtml, onDismiss, o) {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'cr-modal';
    back.innerHTML = `<div class="cr-modal-box${o && o.wide ? ' cr-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="cr-modal-title">
      <div class="cr-modal-head"><h2 class="cr-modal-title" id="cr-modal-title">${esc(title)}</h2>
        <button type="button" class="cr-modal-x" data-m="x" aria-label="Close">&#10005;</button></div>
      <div class="cr-modal-body">${bodyHtml}</div></div>`;
    document.body.appendChild(back);
    let open = true;
    function close(silent) {
      if (!open) return;
      open = false;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus(); } catch (_) { /* gone */ } }
      if (!silent && onDismiss) onDismiss();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      // Keep Tab inside the dialog.
      const f = [...back.querySelectorAll('button,input,select,textarea,[tabindex]')].filter(x => !x.disabled && x.tabIndex !== -1);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    back.querySelector('[data-m="x"]').addEventListener('click', () => close());
    // Close on the backdrop only when the press started there, so a text
    // selection dragged out of the name box does not dismiss the dialog —
    // and not in the first half second, nor on the second click of a
    // double-click: the dialog opens under the pointer on the first click
    // of a double-clicked Save, and the second would land on the backdrop.
    const openedAt = Date.now();
    let pressedBack = false;
    back.addEventListener('mousedown', e => { pressedBack = e.target === back && (e.detail || 1) <= 1 && Date.now() - openedAt > 500; });
    back.addEventListener('click', e => {
      if (e.target === back && pressedBack && (e.detail || 1) <= 1 && Date.now() - openedAt > 500) close();
    });
    return { el: back, body: back.querySelector('.cr-modal-body'), close };
  }

  const modalOpen = () => !!document.querySelector('.cr-modal');

  /* Ask for a report name (and, for an admin / level 3, whether to share it;
     and, when jobs are picked, whether to keep them with the report).
     o.onSubmit({ name, shared, saveJobs }) does the save and returns an error message
     to show — the dialog stays open on it, which is how a taken name gets
     re-prompted — or null when done. Resolves true once saved. */
  function askName(o) {
    return new Promise(resolve => {
      const m = modal(o.title, `
        ${o.intro ? `<p>${esc(o.intro)}</p>` : ''}
        <label class="cr-m-label" for="cr-m-name">Report name</label>
        <input id="cr-m-name" class="cr-input" maxlength="120" value="${esc(o.name || '')}" autocomplete="off" spellcheck="false">
        ${o.offerShare ? `<label class="cr-check"><input type="checkbox" id="cr-m-share"${o.shared ? ' checked' : ''}>
          <span><b>Share with division</b><span class="cr-hint">Everyone in ${esc(divLabel())} can run it. Only admins and level 3 users can change it.</span></span></label>` : ''}
        ${o.jobsOffer ? `<label class="cr-check"><input type="checkbox" id="cr-m-savejobs"${o.jobsOffer.checked ? ' checked' : ''}>
          <span><b>Keep ${o.jobsOffer.count === 1 ? 'this job' : `these ${o.jobsOffer.count} jobs`} with the report</b><span class="cr-hint">Otherwise it opens with no jobs and asks for them each time it is run.</span></span></label>` : ''}
        <p class="cr-m-err" role="alert" hidden></p>
        <div class="cr-m-btns">
          <button type="button" class="btn btn-ghost" data-m="cancel">Cancel</button>
          <button type="button" class="btn btn-green" data-m="ok">${esc(o.confirmLabel || 'Save')}</button>
        </div>`, () => resolve(false));
      const input = m.body.querySelector('#cr-m-name');
      const share = m.body.querySelector('#cr-m-share');
      const keepJobs = m.body.querySelector('#cr-m-savejobs');
      const err = m.body.querySelector('.cr-m-err');
      const ok = m.body.querySelector('[data-m="ok"]');
      const show = msg => { err.textContent = msg; err.hidden = false; input.focus(); try { input.select(); } catch (_) { /* fine */ } };
      let busy = false;
      async function submit() {
        if (busy) return;
        const name = input.value.replace(/\s+/g, ' ').trim();
        if (!name) { show('Give the report a name.'); return; }
        if (name.length > 120) { show('Report names are limited to 120 characters.'); return; }
        busy = true;
        ok.disabled = true;
        ok.textContent = 'Saving…';
        let msg = null;
        try { msg = await o.onSubmit({ name, shared: !!(share && share.checked), saveJobs: keepJobs ? keepJobs.checked : null }); }
        catch (e) { msg = e && e.message ? e.message : 'Something went wrong.'; }
        // Closed (Escape, ✕) while it read "Saving…": the dialog is gone, so a
        // failure is said in a toast rather than into a detached dialog.
        if (!m.el.isConnected) { if (msg) toast(msg, 'error'); return; }
        busy = false;
        ok.disabled = false;
        ok.textContent = o.confirmLabel || 'Save';
        if (msg) { show(msg); return; }
        m.close(true);
        resolve(true);
      }
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      m.body.querySelector('[data-m="cancel"]').addEventListener('click', () => m.close());
      input.focus();
      try { input.select(); } catch (_) { /* fine */ }
    });
  }

  // A question with a few labelled answers. Resolves the chosen value, or
  // null when dismissed.
  function choose(title, message, buttons) {
    return new Promise(resolve => {
      const m = modal(title, `<p>${esc(message)}</p>
        <div class="cr-m-btns">${buttons.map((b, i) => `<button type="button" class="btn ${b.primary ? 'btn-green' : 'btn-ghost'}" data-choice="${i}">${esc(b.label)}</button>`).join('')}</div>`,
        () => resolve(null));
      m.body.querySelectorAll('[data-choice]').forEach(btn => btn.addEventListener('click', () => {
        const b = buttons[Number(btn.getAttribute('data-choice'))];
        m.close(true);
        resolve(b ? b.value : null);
      }));
      const primary = m.body.querySelector('.btn-green') || m.body.querySelector('[data-choice]');
      if (primary) primary.focus();
    });
  }

  /* 409 client_outdated: this tab runs an older builder than the report it
     tried to save over. The open report is already in the draft, which the
     tab offers back after the reload. */
  let outdatedOpen = false;
  function showOutdated() {
    if (outdatedOpen) return;
    outdatedOpen = true;
    const m = modal('DataWatch was updated', `<p>${esc(OUTDATED_MSG)}</p>
      <div class="cr-m-btns"><button type="button" class="btn btn-ghost" data-m="later">Not now</button>
        <button type="button" class="btn btn-green" data-m="reload">Reload</button></div>`, () => { outdatedOpen = false; });
    m.body.querySelector('[data-m="later"]').addEventListener('click', () => { outdatedOpen = false; m.close(true); });
    const go = m.body.querySelector('[data-m="reload"]');
    go.addEventListener('click', () => {
      saveDraft();
      S.reloading = true;
      outdatedOpen = false;
      m.close(true);
      try { window.location.reload(); } catch (_) { /* nothing to do */ }
    });
    go.focus();
  }

  function toast(message, kind, action) {
    if (S.toastEl) S.toastEl.remove();
    clearTimeout(S.toastTimer);
    const el = document.createElement('div');
    el.className = 'cr-toast' + (kind === 'error' ? ' err' : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => { el.remove(); action.run(); });
      el.appendChild(b);
    }
    document.body.appendChild(el);
    S.toastEl = el;
    S.toastTimer = setTimeout(() => { el.remove(); if (S.toastEl === el) S.toastEl = null; },
      kind === 'error' ? 7000 : action ? 6500 : 3200);
  }

  // ── Loading lists ───────────────────────────────────────────────────
  function sortReports() {
    S.reports.sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
  }
  function upsertReport(r) {
    if (!r || r.id == null) return;
    const i = S.reports.findIndex(x => sameId(x.id, r.id));
    // An answer that arrives late (a save's, behind a rename that landed
    // after it) never puts an older copy back over a newer one.
    if (i >= 0 && Number(S.reports[i].version) > Number(r.version)) return;
    if (i >= 0) S.reports[i] = r; else S.reports.unshift(r);
    sortReports();
    // The schedules that send it read its name and whether it is still
    // customer-safe ("won’t send until…") from this copy at once.
    (Array.isArray(S.scheds) ? S.scheds : []).forEach(x => {
      if (!sameId(x.custom_report_id, r.id)) return;
      if (typeof r.customer_safe === 'boolean') x.report_customer_safe = r.customer_safe;
      if (txt(r.name)) x.report_name = r.name;
    });
  }
  // A save of a report a schedule sends: the schedules list asked for again,
  // so the rail says what its next send will find (what the server says).
  // While a load is out (the first one, when which reports are scheduled is
  // not known yet) it is asked for again too: that answer may predate this
  // save. So it is after a load that failed: which reports are scheduled is
  // still not known.
  function schedsAfterSave(r) {
    if (r && (isScheduled({ id: r.id }) || S.schedsP || schedsUnknown())) loadSchedules();
  }
  // Which saved reports a schedule sends is known only once the schedules
  // list is in (admin / level 3; nobody else sees schedules). A change that
  // would stop a send — a save into fixed dates or another kind, Make
  // private, Delete — waits for it first: the first load still out, or a
  // fresh one after a failed load, for a bounded time. If it still cannot be
  // had, the change asks in general terms rather than not at all. Any other
  // save cannot stop a send, and does not wait.
  const SCHEDS_WAIT_MS = 10000;
  function schedsUnknown() { return !!(S.canShare || S.canSchedule) && !Array.isArray(S.scheds); }
  async function waitForScheds() {
    if (!schedsUnknown()) return;
    let timer = 0;
    await Promise.race([Promise.resolve(S.schedsP || loadSchedules()).catch(() => {}),
      new Promise(r => { timer = setTimeout(r, SCHEDS_WAIT_MS); })]);
    clearTimeout(timer);
  }
  function schedsUnknownLead() {
    return `Couldn’t check whether a schedule sends this report${S.schedsError ? ` (${S.schedsError})` : ''}.`;
  }
  const CHECKING_SCHEDS = name => `Checking whether a schedule sends “${name}”…`;
  function loadList() {
    if (S.loading) return S.loadP;
    S.loading = true;
    if (!S.loaded) renderRail();
    S.loadP = api.list().then(data => {
      S.reports = Array.isArray(data.reports) ? data.reports : [];
      sortReports();
      S.canShare = data.canShare === true;
      S.me = data.me || null;
      S.loaded = true;
      S.loadError = '';
      // The server is the word on who may edit what.
      if (S.doc && S.doc.id) {
        const r = S.reports.find(x => sameId(x.id, S.doc.id));
        if (r) { S.doc.can_edit = !!r.can_edit; S.doc.readOnly = !r.can_edit; }
      }
    }, err => {
      S.loadError = err.message;
    }).then(() => {
      S.loading = false;
      S.loadP = null;
      renderRail();
      updateChrome();
    });
    return S.loadP;
  }
  function loadDeleted() {
    S.deletedLoading = true;
    S.deletedError = '';
    renderRail();
    return api.deleted().then(data => {
      S.deleted = Array.isArray(data.reports) ? data.reports : [];
    }, err => {
      S.deletedError = 'Couldn’t load deleted reports: ' + err.message;
    }).then(() => {
      S.deletedLoading = false;
      renderRail();
    });
  }
  /* Branding, once per tab visit (again after five minutes away), and the
     Team Directory once: quiet, so a failure is just an unbranded report
     with no PM line. Either landing redraws what it dresses. */
  function sideArrived() {
    if (S.view === 'edit' && S.doc) {
      if (S.step === 3) renderPanel();
      schedulePreview(true);
    }
  }
  function loadBranding(force) {
    if (S.brandingP) return S.brandingP;
    if (!force && S.brandingAt && Date.now() - S.brandingAt < SIDE_TTL) return Promise.resolve();
    S.brandingP = api.branding().then(data => {
      S.branding = data && data.branding && typeof data.branding === 'object' ? data.branding : null;
      S.brandingCanEdit = !!(data && data.canEdit);
    }, () => { /* unbranded */ }).then(() => {
      S.brandingAt = Date.now();
      S.brandingP = null;
      sideArrived();
    });
    return S.brandingP;
  }
  function loadPeople() {
    if (S.people || S.peopleP) return S.peopleP || Promise.resolve();
    S.peopleP = api.people().then(data => {
      const list = data && (Array.isArray(data.employees) ? data.employees : Array.isArray(data.people) ? data.people : null);
      S.people = Array.isArray(list) ? list.filter(p => p && typeof p.name === 'string') : [];
    }, () => { S.people = []; }).then(() => {
      S.peopleP = null;
      sideArrived();
    });
    return S.peopleP;
  }
  // Every live contact in the division: the Contacts view and the step ①
  // badges. Quiet for the badges; the Contacts view shows its error.
  function loadContacts(force) {
    if (S.contactsP) return S.contactsP;
    if (!force && S.contactsAt && Date.now() - S.contactsAt < SIDE_TTL) return Promise.resolve();
    S.contactsP = api.contactsQuiet().then(data => {
      S.contacts = Array.isArray(data.contacts) ? data.contacts : [];
      S.contactsCanEdit = data.canEdit === true;
      S.contactsError = '';
    }, err => {
      S.contactsError = err.message;
    }).then(() => {
      S.contactsAt = Date.now();
      S.contactsP = null;
      if (S.view === 'contacts') renderView();
      else if (S.view === 'edit' && S.step === 1 && S.mount && S.mount.querySelector('.cr-joblist')) renderJobList();
    });
    return S.contactsP;
  }
  // A schedule as a save, Pause or Resume just answered with it: into the
  // list and the rail at once, so the row (and an Edit… opened from it)
  // reads what the server now holds, not the copy from before — the list's
  // own refresh can be a moment behind.
  function applySched(row) {
    if (!row || row.id == null || !Array.isArray(S.scheds)) return;
    const i = S.scheds.findIndex(x => sameId(x.id, row.id));
    if (i >= 0) S.scheds[i] = row; else S.scheds.push(row);
    renderRail();
  }
  function loadSchedules() {
    if (!S.canShare && !S.canSchedule) return Promise.resolve();
    // A refresh asked for while one is already in flight is queued, not
    // dropped, and an answer older than the newest ask is not applied:
    // otherwise a later save's refresh is swallowed, and the in-flight
    // answer — read before that save committed — overwrites upsertReport's
    // correct local copy, leaving the rail's "won't send" line or the report
    // name stale. At most one request runs with one more queued behind it.
    if (S.schedsP) { S.schedsAgain = true; return S.schedsP; }
    S.schedsLoading = true;
    S.schedsError = '';
    S.schedsP = api.schedules().then(data => {
      if (S.schedsAgain) return;        // a later ask is queued; this answer may predate it
      S.scheds = Array.isArray(data.schedules) ? data.schedules : [];
      S.canSchedule = data.canSchedule === true;
      if (Array.isArray(data.groups)) S.schedGroups = data.groups;
    }, err => {
      if (S.schedsAgain) return;
      if (err.status === 404 || err.status === 403) { S.scheds = []; S.canSchedule = false; return; }
      S.schedsError = err.message;
    }).then(() => {
      S.schedsP = null;
      if (S.schedsAgain) { S.schedsAgain = false; return loadSchedules(); }
      S.schedsLoading = false;
      renderRail();
      updateChrome();
    });
    return S.schedsP;
  }

  // The server sends the history 100 runs at a time, newest first; "Load
  // more" asks for the page before the last one shown (next_before_id).
  function loadRuns(more) {
    if (more) {
      if (S.runsNext == null || S.runsMore) return Promise.resolve();
      S.runsMore = true;
    } else {
      S.runsLoading = true;
    }
    S.runsError = '';
    if (S.view === 'history') renderView();
    return api.runs(more ? { before_id: S.runsNext } : {}).then(data => {
      const rows = Array.isArray(data.runs) ? data.runs : [];
      const had = more ? (S.runs || []) : [];
      S.runs = had.concat(rows.filter(r => !had.some(x => sameId(x.id, r.id))));
      S.runsNext = data.next_before_id != null && rows.length ? data.next_before_id : null;
    }, err => {
      S.runsError = err.message;
    }).then(() => {
      S.runsLoading = false;
      S.runsMore = false;
      if (S.view === 'history') renderView();
    });
  }

  // ── Opening reports ─────────────────────────────────────────────────
  function startEditing(doc) {
    S.doc = doc;
    S.view = 'edit';
    S.step = 1;
    S.collapsed = new Set(doc.def.sections.map(s => s.id));
    S.jobSearch = '';
    S.editLabel = null;
    S.railOpen = false;
    S.pvScroll = 0;
    S.filterSearch = '';
    aiDocChanged();
    render();
    const name = S.mount && S.mount.querySelector('.cr-edit');
    if (name && typeof name.scrollIntoView === 'function' && (window.innerWidth || 1200) < 900) {
      try { name.scrollIntoView({ block: 'start' }); } catch (_) { /* fine */ }
    }
    // A starter built around a sub code opens on the sub-code picker.
    if (S.focusFilter) { S.focusFilter = false; focusFk('filter-search'); }
  }

  function openSaved(r, force) {
    if (!force && !okToLeave()) return;
    const def = E.normalizeDefinition(r.definition);
    const saveJobs = def.jobs.mode === 'saved';
    let picked = [], missing = 0;
    if (saveJobs) {
      const all = projects();
      // Before the page has its job list there is nothing to check against;
      // keep the ids rather than call every one of them missing.
      if (all.length) {
        const res = E.resolveJobs(def, all);
        picked = res.jobs.map(p => p.id);
        missing = res.missing.length;
      } else {
        picked = def.jobs.ids.slice();
      }
    }
    const doc = blankDoc(def, {
      id: r.id, name: r.name || '', description: r.description || '', visibility: r.visibility || 'private',
      version: r.version, can_edit: !!r.can_edit, readOnly: !r.can_edit, owner_username: r.owner_username || '',
      updated_by_username: r.updated_by_username || '', updated_at: r.updated_at || null,
      saveJobs, picked, missing,
    });
    markClean(doc);
    startEditing(doc);
  }
  // The "Sub-Code Production" starter asks for a sub code first.
  const asksForSubCode = st => /sub[\s_-]?code/i.test(`${st.id} ${st.name}`);
  function openStarter(id) {
    const st = starters().find(s => s.id === id);
    if (!st) return;
    if (S.doc && !S.doc.id && S.doc.starterId === id && !S.doc.touched && S.view === 'edit') { S.railOpen = false; render(); return; }
    if (!okToLeave()) return;
    S.focusFilter = asksForSubCode(st);
    startEditing(blankDoc(JSON.parse(JSON.stringify(st.definition)), { starterId: st.id, name: st.name }));
    if (asksForSubCode(st)) toast('Pick the jobs, then the sub code to report on.');
  }
  function newReport() {
    if (!okToLeave()) return;
    startEditing(blankDoc(E.defaultDefinition()));
  }
  function closeDoc() {
    if (!okToLeave()) return;
    S.doc = null;
    S.view = 'home';
    aiDocChanged();
    render();
  }

  // ── Saving ──────────────────────────────────────────────────────────
  // What a save is about to send, taken before the request goes: the editor
  // stays live while it is out, and only what was sent becomes "saved".
  function sentSnapshot(d, def) {
    return { doc: d, typedName: d.name.trim(), typedDesc: txt(d.description), key: JSON.stringify(def) };
  }

  // The server's copy is now the clean one; the editor carries on with the
  // same definition and the list shows the new name, badges and time. Only
  // what the save sent is clean: a field typed into while it was out keeps
  // what was typed and stays unsaved, rather than being marked saved — or
  // overwritten with the old name — and lost on the next click away.
  function adoptSaved(report, sent) {
    const d = S.doc;
    // A newer copy already in the list (a rename that landed after this
    // save): its name stands, and the list is not put back to this one.
    // The doc keeps this save's version, so its next Save still meets
    // whatever else that newer copy changed.
    const listed = S.reports.find(x => sameId(x.id, report.id));
    const named = listed && Number(listed.version) > Number(report.version) ? listed : report;
    d.id = report.id;
    d.starterId = null;
    d.version = report.version;
    d.visibility = report.visibility;
    d.can_edit = !!report.can_edit;
    d.readOnly = !report.can_edit;
    d.owner_username = report.owner_username || d.owner_username;
    d.updated_by_username = report.updated_by_username || '';
    d.updated_at = report.updated_at || null;
    d.missing = 0;
    if (sent) {
      if (d.name.trim() === sent.typedName) d.name = named.name;
      if (txt(d.description) === sent.typedDesc) d.description = report.description || '';
      d.savedName = named.name;
      d.savedDesc = report.description || '';
      d.savedDefKey = sent.key;
      d.touched = false;
    } else {
      d.name = named.name;
      d.description = report.description || '';
      markClean(d);
    }
    upsertReport(report);
    clearDraft();
    const input = S.mount && S.mount.querySelector('[data-bind="name"]');
    if (input && input.value !== d.name) input.value = d.name;
    const desc = S.mount && S.mount.querySelector('[data-bind="description"]');
    if (desc && desc.value !== d.description) desc.value = d.description;
    const keep = S.mount && S.mount.querySelector('[data-bind="save-jobs"]');
    if (keep) keep.checked = !!d.saveJobs;
    renderRail();
    schedsAfterSave(report);
    updateChrome();
    aiSync();
  }

  const SAVE_WHILE_SHARING = 'Wait for the sharing change to finish, then save.';
  async function save() {
    const d = S.doc;
    if (!d || sentFor(d) || modalOpen()) return;
    if (!d.id) { await saveAs(true); return; }
    if (d.readOnly) {
      toast('Only an admin or level 3 user can change a shared template — Save As to make your own copy.', 'error');
      return;
    }
    if (!isDirty()) return;
    // Not while its Share / Make private is out: both would be sent against
    // one version, and the second would meet the first as someone else's.
    if (S.visBusy.has(String(d.id))) { toast(SAVE_WHILE_SHARING, 'error'); return; }
    // What is saved is what is there at the click — the report, its version,
    // the name — and from the click it is on its way: leaving the report or
    // opening a dialog meanwhile does not drop it, and what is typed or
    // applied while it reads "Saving…" stays unsaved.
    const id = d.id, version = d.version;
    const name = d.name.trim() || d.savedName;
    const def = defForSave();
    const sent = sentSnapshot(d, def);
    S.saves.add(sent);
    S.saving = true;
    updateChrome();
    const settle = () => { S.saves.delete(sent); S.saving = S.saves.size > 0; updateChrome(); };
    // Whether a schedule sends it, before saving what could stop that —
    // only a save into fixed dates or another kind could.
    if (schedsUnknown() && couldStopSend(id, def)) await waitForScheds();
    const stops = scheduledStops(id, def);
    // The editor may have moved on by now: the question then names the report.
    if (stops && !window.confirm(S.doc === d ? stops : `“${name}”: ${stops}`)) { settle(); return; }
    let err = null;
    try {
      const res = await api.update(id, { name, description: sent.typedDesc || null, definition: def, version });
      if (S.doc === d && sameId(d.id, id)) { adoptSaved(res.report, sent); toast(`Saved “${res.report.name}”.`); }
      else {
        // They moved on while it was out (or saved it as a new report). It
        // saved all the same: put the new copy in the list, so reopening it
        // shows what was saved (and its version), not the old copy and a
        // false "someone else saved" later.
        upsertReport(res.report);
        renderRail();
        schedsAfterSave(res.report);
        toast(`Saved “${res.report.name}”.`);
      }
    } catch (e) { err = e; }
    settle();
    if (!err || S.doc !== d || !sameId(d.id, id)) return;
    // An older copy of the builder than the report it was saving over: the
    // reload question is already up and the work is in the draft.
    if (err.status === 409 && code(err) === 'client_outdated') return;
    if (err.status === 409 && code(err) === 'version_conflict') { await onConflict(err.data && err.data.report); return; }
    if (err.status === 409 && code(err) === 'name_taken') {
      toast(`You already have a report called “${name}”. Change the name and save again.`, 'error');
      focusFk('name');
      return;
    }
    if (err.status === 404) {
      const go = window.confirm('This report has been deleted by someone else. Save your version as a new report?');
      if (go) await saveAs(true);
      return;
    }
    if (err.status === 401) return;
    toast(`Couldn’t save: ${err.message}. Your changes are still here.`, 'error');
  }

  /* Save the builder's report as a new one. fresh = it has never been saved
     (the first Save), so the name defaults to what it is called now rather
     than "… (copy)". */
  async function saveAs(fresh, defaultName) {
    const d = S.doc;
    if (!d || modalOpen()) return false;
    const current = d.name.trim() || txt(E.normalizeDefinition(d.def).title);
    // A name already typed into the bar is the name they want; otherwise a
    // copy of a saved report is offered as "… (copy)".
    const retyped = d.id && d.name.trim() && d.name.trim() !== d.savedName;
    const name = defaultName || (fresh || !d.id || retyped ? (current || 'Untitled report') : copyName(current || d.savedName || 'Untitled report', 1));
    // Jobs are picked: the save itself asks whether to keep them, so "pick a
    // job, Save" does not quietly store a template that reopens with none.
    // Ticked for a report about one to three jobs — a report for one owner —
    // unless the user has already said otherwise in step ①.
    const nPicked = currentJobs().length;
    const jobsOffer = nPicked ? { count: nPicked, checked: d.saveJobsSet ? !!d.saveJobs : (d.saveJobs || nPicked <= 3) } : null;
    return askName({
      title: fresh || !d.id ? 'Save report' : 'Save as a new report',
      name,
      offerShare: S.canShare,
      shared: false,
      jobsOffer,
      onSubmit: async ({ name: chosen, shared, saveJobs }) => {
        if (jobsOffer && saveJobs !== null && S.doc === d) d.saveJobs = !!saveJobs;
        const def = defForSave(d);
        const sent = sentSnapshot(d, def);
        try {
          const res = await api.create({ name: chosen, description: sent.typedDesc || null, visibility: shared ? 'shared' : 'private', definition: def });
          if (S.doc === d) adoptSaved(res.report, sent); else upsertReport(res.report);
          toast(shared ? `Saved “${res.report.name}” and shared it with the division.` : `Saved “${res.report.name}”.`);
          return null;
        } catch (e) {
          if (e.status === 409 && code(e) === 'name_taken') {
            return shared ? `There is already a shared template called “${chosen}”. Pick a different name.`
              : `You already have a report called “${chosen}”. Pick a different name.`;
          }
          if (e.status === 403) return 'Only an admin or level 3 user can share a report with the division. Untick “Share with division” to save it for yourself.';
          if (e.status === 409 && code(e) === 'client_outdated') return OUTDATED_MSG;
          return `Couldn’t save: ${e.message}`;
        }
      },
    });
  }

  function copyName(name, i) {
    const suffix = i === 1 ? ' (copy)' : ` (copy ${i})`;
    return name.slice(0, 120 - suffix.length) + suffix;
  }

  async function onConflict(theirs) {
    const d = S.doc;
    const who = theirs && txt(theirs.updated_by_username);
    const choice = await choose('Someone else saved this report',
      `Someone else saved this report while you had it open${who ? ` (${who}, ${ago(theirs.updated_at)})` : ''}. `
      + 'Load their version (your changes are dropped), or save yours as a separate copy?',
      [{ label: 'Cancel', value: null }, { label: 'Load their version', value: 'reload' }, { label: 'Save mine as a copy', value: 'copy', primary: true }]);
    if (S.doc !== d) return;
    if (choice === 'reload' && theirs) { upsertReport(theirs); openSaved(theirs, true); toast('Loaded the latest saved version.'); }
    else if (choice === 'copy') await saveAs(false);
  }

  // One Share / Make private at a time per report, and never on top of a
  // Save of it: each is sent against the report's version, and a second sent
  // against the same one meets the first as "someone else saved this".
  async function setVisibility(vis) {
    const d = S.doc;
    if (!d || !d.id) return;
    const key = String(d.id);
    if (S.visBusy.has(key)) return;
    if (sentFor(d)) { toast(`Wait for the save to finish, then ${vis === 'shared' ? 'share it' : 'make it private'}.`, 'error'); return; }
    if (vis === 'shared' && !window.confirm(`Share “${d.savedName}” with everyone in ${divLabel()}? They will be able to run it; only admins and level 3 users can change it.`)) return;
    S.visBusy.add(key);
    try { await sendVisibility(d, vis); } finally { S.visBusy.delete(key); }
  }
  async function sendVisibility(d, vis) {
    // Private, only its owner can open it (the server keeps the author while
    // they still can), so a schedule that runs as anyone else stops: said
    // before, as deleting it or switching internal data on is.
    if (vis === 'private' && schedsUnknown()) {
      toast(CHECKING_SCHEDS(d.savedName || d.name.trim() || 'this report'));
      await waitForScheds();
      if (S.doc !== d) return;
      if (schedsUnknown() && !window.confirm(`${schedsUnknownLead()} If one sends it as someone other than ${txt(d.owner_username) || 'its owner'}, `
        + 'made private those scheduled sends stop until it is shared again. Make it private anyway?')) return;
    }
    if (vis === 'private' && isScheduled(d)) {
      const owner = txt(d.owner_username);
      const others = [...new Set(S.scheds.filter(x => sameId(x.custom_report_id, d.id)).map(x => txt(x.run_as_username))
        .filter(u => u && u !== owner))];
      const who = others.length > 1 ? `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}` : others[0];
      if (others.length && !window.confirm(`A schedule sends this report as ${who}. Made private, only ${owner || 'its owner'} can open it, `
        + 'so those scheduled sends stop until it is shared again. Make it private anyway?')) return;
    }
    try {
      const res = await api.update(d.id, { visibility: vis, version: d.version });
      if (S.doc !== d) { upsertReport(res.report); schedsAfterSave(res.report); return; }
      // Only the visibility changed on the server; any unsaved edits stay
      // unsaved, against the new version.
      d.version = res.report.version;
      d.visibility = res.report.visibility;
      d.can_edit = !!res.report.can_edit;
      d.readOnly = !res.report.can_edit;
      upsertReport(res.report);
      renderRail();
      updateChrome();
      // Who may open it changed: what its schedules will find, and a list
      // answer already on its way (read before this) is not applied.
      schedsAfterSave(res.report);
      toast(vis === 'shared' ? 'Shared with the division.' : 'Made private.');
    } catch (e) {
      if (e.status === 409 && code(e) === 'client_outdated') return;
      if (e.status === 409 && code(e) === 'version_conflict') { await onConflict(e.data && e.data.report); return; }
      if (e.status === 409 && code(e) === 'name_taken') {
        toast(vis === 'shared' ? 'There is already a shared template with this name. Rename it first.' : 'The owner already has a private report with this name. Rename it first.', 'error');
        return;
      }
      if (e.status !== 401) toast(`Couldn’t change sharing: ${e.message}`, 'error');
    }
  }

  const RENAME_WHILE_SAVING = 'Wait for the save to finish, then rename it.';
  async function renameReport(r) {
    if (modalOpen()) return;
    const open = S.doc && S.doc.id != null && sameId(S.doc.id, r.id) ? S.doc : null;
    // Not while the open report's own Save is out: a rename that lands after
    // it (or a retry after the conflict it meets) would race that Save's
    // answer for the name and version the list and the editor keep.
    if (open && sentFor(open)) { toast(RENAME_WHILE_SAVING, 'error'); return; }
    // What the rename is made against: the list's copy — after a
    // version_conflict, the one the server sent back, so "Try the rename
    // again" can work. The open report renames against its own version until
    // someone else's save is known (a conflict, or a newer copy in the list);
    // from then on against theirs, and its own version is not moved, so its
    // next Save still meets their save rather than quietly writing over it.
    let base = r;
    let behind = !!open && Number(r.version) > Number(open.version);
    await askName({
      title: 'Rename report', name: r.name, confirmLabel: 'Rename',
      onSubmit: async ({ name }) => {
        if (name === base.name) return null;
        if (open && sentFor(open)) return RENAME_WHILE_SAVING;
        const version = open && !behind ? open.version : base.version;
        try {
          const res = await api.update(r.id, { name, version });
          upsertReport(res.report);
          // Its schedules carry the name too: a list answer already on its
          // way, read before the rename, must not put the old one back.
          schedsAfterSave(res.report);
          if (open && S.doc === open) {
            // Keep any unsaved edits; only the stored name and version moved
            // (the version only when it was the open copy's own).
            const typed = open.name.trim() !== open.savedName;
            if (version === open.version) open.version = res.report.version;
            open.savedName = res.report.name;
            if (!typed) {
              open.name = res.report.name;
              const input = S.mount.querySelector('[data-bind="name"]');
              if (input) input.value = open.name;
            }
            updateChrome();
          }
          renderRail();
          return null;
        } catch (e) {
          if (e.status === 409 && code(e) === 'name_taken') return `There is already a report called “${name}”. Pick a different name.`;
          if (e.status === 409 && code(e) === 'version_conflict') {
            if (e.data && e.data.report) {
              upsertReport(e.data.report); schedsAfterSave(e.data.report);
              base = e.data.report;
              behind = true;
            }
            renderRail();
            return 'Someone else changed this report a moment ago. Try the rename again.';
          }
          return `Couldn’t rename: ${e.message}`;
        }
      },
    });
  }

  async function duplicateReport(r) {
    if (modalOpen()) return;
    for (let i = 1; i <= 6; i++) {
      const name = copyName(r.name, i);
      try {
        const res = await api.create({ name, description: r.description || null, visibility: 'private', definition: E.normalizeDefinition(r.definition) });
        upsertReport(res.report);
        renderRail();
        toast(`Made a private copy: “${res.report.name}”.`);
        if (okToLeave()) openSaved(res.report, true);
        return;
      } catch (e) {
        if (!(e.status === 409 && code(e) === 'name_taken')) {
          if (e.status !== 401) toast(`Couldn’t duplicate: ${e.message}`, 'error');
          return;
        }
      }
    }
    toast('Couldn’t find a free name for the copy — rename an older copy first.', 'error');
  }

  // One Delete at a time per report: picked again while the first waits on
  // the schedules list (or its confirm is up), it is ignored, so a report is
  // never asked about, and deleted, twice.
  async function deleteReport(r) {
    const key = String(r.id);
    if (S.deleting.has(key)) return;
    S.deleting.add(key);
    try { await removeReport(r); } finally { S.deleting.delete(key); }
  }
  async function removeReport(r) {
    const listed = () => S.reports.some(x => sameId(x.id, r.id));
    const wasListed = listed();
    if (schedsUnknown()) {
      toast(CHECKING_SCHEDS(r.name));
      await waitForScheds();
      // Gone from the list meanwhile (deleted elsewhere): nothing to ask.
      if (wasListed && !listed()) return;
    }
    const scheduled = isScheduled(r), unknown = schedsUnknown();
    const note = scheduled ? 'A schedule sends this report — it will stop sending until the report is restored.\n\n'
      : unknown ? `${schedsUnknownLead()} If one does, it will stop sending until the report is restored.\n\n` : '';
    if (!window.confirm(`Delete “${r.name}”?\n\n${note}You can restore it from Recently Deleted for 30 days.`)) return;
    try { await api.remove(r.id); }
    catch (e) { if (e.status !== 401) toast(`Couldn’t delete: ${e.message}`, 'error'); return; }
    S.reports = S.reports.filter(x => !sameId(x.id, r.id));
    if (S.doc && S.doc.id != null && sameId(S.doc.id, r.id)) { S.doc = null; S.view = 'home'; aiDocChanged(); }
    S.deleted = null;
    render();
    if (S.deletedOpen) loadDeleted();
    // The rail's schedules say what their next send will find.
    if (scheduled || unknown) loadSchedules();
    toast(`Deleted “${r.name}”. It is in Recently Deleted for 30 days.`);
  }

  async function restoreReport(id) {
    const r = (S.deleted || []).find(x => sameId(x.id, id));
    try {
      const res = await api.restore(id);
      upsertReport(res.report);
      if (S.deleted) S.deleted = S.deleted.filter(x => !sameId(x.id, id));
      renderRail();
      // A schedule that sends it is live again: the rail says so.
      if (Array.isArray(S.scheds) && S.scheds.some(x => sameId(x.custom_report_id, id))) loadSchedules();
      toast(`Restored “${res.report.name}”.`);
    } catch (e) {
      if (e.status === 409 && code(e) === 'name_taken') {
        toast(`A report called “${r ? r.name : 'that'}” exists now. Rename it, then restore this one.`, 'error');
      } else if (e.status !== 401) {
        toast(`Couldn’t restore: ${e.message}`, 'error');
      }
    }
  }

  // ── Outputs ─────────────────────────────────────────────────────────
  function requireJobs() {
    if (currentJobs().length) return true;
    toast('Pick at least one job first.', 'error');
    if (S.step !== 1) goStep(1);
    focusFk('job-search');
    return false;
  }

  // The send history: what went out, to whom, with or without our costs on
  // it. Fire-and-forget — the print / email / download has already happened
  // and a failed log must never look like a failed send. Everything is read
  // off the build (and the snapshot it was built from), never off whatever
  // report is open by the time the log goes.
  function runBody(action, built, info) {
    const snap = built.snap || {};
    const jobs = built.ctx.jobs.slice(0, MAX_JOBS);
    return {
      report_id: snap.reportId != null ? snap.reportId : null,
      report_name: (snap.logName || built.ctx.title || 'Untitled report').slice(0, 200),
      action,
      project_ids: jobs.map(p => String(p.id)),
      project_names: jobs.map(p => jobName(p)),
      date_from: built.ctx.range.from || null,
      date_to: built.ctx.range.to || null,
      recipients: info && Array.isArray(info.recipients) ? info.recipients.slice(0, 50) : [],
      subject: (info && info.subject) || null,
      included_internal: builtIsInternal(built),
      definition: built.def,
    };
  }
  // A run is on the record: move the list's counters, refresh the history.
  function noteRun(built, createdAt) {
    const id = built.snap && built.snap.reportId;
    const r = id != null ? S.reports.find(x => sameId(x.id, id)) : null;
    if (r) { r.last_run_at = createdAt || new Date().toISOString(); r.run_count = (Number(r.run_count) || 0) + 1; }
    if (S.view === 'history') loadRuns();
  }
  function logRun(action, built, info, extra) {
    return api.run(Object.assign(runBody(action, built, info), extra || {})).then(res => {
      if (res && res.run) noteRun(built, res.run.created_at);
    }).catch(e => console.warn('[custom-reports] could not log the run:', e && e.message));
  }

  // Print / PDF. The window has to be opened inside the click itself or the
  // browser calls it a pop-up, so it opens first and the report is written
  // into it once the full daily-row history is in. What it prints is fixed at
  // the click: if the report is closed or another opened in the meantime the
  // window closes and says so, rather than print a different report into a
  // tab the user believes holds the one they clicked.
  function doPrint() {
    if (!S.doc || !requireJobs()) return;
    const d = S.doc;
    let snap;
    try { snap = snapshot(); }
    catch (err) { toast('Couldn’t build the report: ' + err.message, 'error'); return; }
    const win = window.open('', '_blank');
    if (!win) { alert('Your browser blocked the print window. Allow pop-ups for this site and try again.'); return; }
    const go = () => {
      let built;
      try { built = buildFrom(snap); }
      catch (err) { try { win.close(); } catch (_) { /* fine */ } toast('Couldn’t build the report: ' + err.message, 'error'); return; }
      const write = window.dwWrite || ((w, h) => w.document.write(h));
      write(win, built.html + '<script>window.onload=()=>{window.print()}<\/script>');
      win.document.close();
      logRun('print', built);
    };
    if (S.readyDone) { go(); return; }
    try {
      win.document.write('<!DOCTYPE html><title>Preparing report…</title><p style="font:14px system-ui,sans-serif;padding:2rem;color:#444">Preparing your report…</p>');
      win.document.close();
    } catch (_) { /* the real write follows */ }
    whenReady().then(() => {
      if (win.closed) return;
      if (S.doc !== d) {
        try { win.close(); } catch (_) { /* fine */ }
        toast('The report changed while it was being prepared — click Print again.', 'error');
        return;
      }
      try { win.document.open(); } catch (_) { /* written fresh below */ }
      go();
    });
  }

  function htmlBytes(html) {
    try { if (typeof Blob === 'function') return new Blob([html]).size; } catch (_) { /* fall through */ }
    try { return unescape(encodeURIComponent(html)).length; } catch (_) { return html.length * 3; }
  }

  // Email and Excel wait for the older daily rows like Print does, but have
  // no window to show it in: the button says "Preparing…" and takes no more
  // clicks until the file is ready, and a toast says why.
  async function whenReadyFor(kind) {
    if (S.readyDone) return;
    S.busy[kind] = true;
    updateChrome();
    toast('Waiting for older daily entries — your report will be ready in a moment.');
    try { await whenReady(); }
    finally { S.busy[kind] = false; updateChrome(); }
  }

  async function doEmail() {
    if (!S.doc || S.busy.email || !requireJobs()) return;
    if (typeof window.openReportEmailModal !== 'function') {
      alert('Email module is still loading — please try again in a moment.');
      return;
    }
    const d = S.doc;
    // The saved contacts for these jobs are fetched while the report builds.
    const contactsP = emailContacts(currentJobs());
    await whenReadyFor('email');
    if (S.doc !== d) return;
    let built;
    try { built = buildCurrent(); }
    catch (err) { toast('Couldn’t build the report: ' + err.message, 'error'); return; }
    if (!emailSizeOk(built.html)) return;
    // The one place a customer is most likely on the other end.
    if (builtIsInternal(built)
      && !window.confirm('This report includes internal data — costs, rates, hours, employee names or profit. Email it anyway? Only send it inside the company.')) return;
    const jobs = built.ctx.jobs;
    const one = jobs.length === 1 ? jobs[0] : null;
    const jobLabel = one ? jobName(one) : `${jobs.length} jobs`;
    const record = runBody('email', built);
    delete record.action; delete record.recipients; delete record.subject;
    const pre = await contactsP;
    if (typeof window.openReportEmailModal !== 'function') return;
    window.openReportEmailModal({
      reportType: `${cfg.division}_custom_report`,
      projectId: one ? one.id : null,
      // No project name: the server swaps any subject that does not contain
      // it for "<label> — <name>", which would throw away the subject the
      // user wrote for the customer. The default subject already names the jobs.
      projectName: null,
      defaultSubject: `${built.ctx.title} — ${jobLabel}`,
      getHTML: () => built.html,
      // Each picked job's (and its client's) saved contacts, pre-filled, and
      // what the modal needs to save a typed address as a new one. Jobs of
      // more than one customer: listed to add by hand, under a warning, not
      // filled in — each would be sent the others' jobs.
      contacts: pre.contacts,
      suggestedContacts: pre.suggested,
      suggestedNote: pre.note,
      contactContext: pre.context,
      // send-report records the send itself; the browser logs it only when
      // the server could not, so it is on the record once either way.
      customReport: record,
      onSent: info => {
        // The modal may have saved a typed address as a contact: the job
        // badges count it next time step ① draws.
        loadContacts(true);
        if (info && info.logged) { noteRun(built); return undefined; }
        return logRun('email', built, info);
      },
    });
  }

  // send-report refuses anything bigger, and would say so only after the
  // recipients are filled in. Say it now, with what to do instead.
  function emailSizeOk(html, noPrint) {
    const bytes = htmlBytes(html);
    if (bytes <= EMAIL_HTML_LIMIT) return true;
    toast(`This report is ${(bytes / 1e6).toFixed(1)} MB — too big to email (the limit is 1.5 MB). Pick fewer jobs, set a shorter date range, `
      + 'turn on “One row per day and sub code”, or use Print / PDF and attach the PDF.', 'error',
    noPrint ? null : { label: 'Print / PDF instead', run: () => doPrint() });
    return false;
  }

  /* The saved contacts an email to these jobs starts with: each job's own,
     then each job's client's, auto-add ones only, one per address, labelled
     with where they came from. Never holds the email up for long, and a
     failure is an empty list — the modal still works by hand.
     Jobs of more than one customer — by the schedule runner's rule, where a
     job that names no client among several is a customer of its own — are
     not filled in: one owner's contact would be sent another owner's job.
     They come back as suggestions, with the note the modal shows above them,
     and the modal is told (context.mixed) so "Save as contact" never files a
     typed address on every picked job. */
  async function emailContacts(jobs) {
    jobs = (jobs || []).slice(0, MAX_JOBS);
    const projectIds = jobs.map(p => String(p.id));
    const clients = [];
    jobs.forEach(p => {
      const key = clientKey(p.client);
      if (key && !clients.some(c => c.key === key)) clients.push({ key, name: txt(p.client) });
    });
    const unnamed = jobs.some(p => !clientKey(p.client));
    const mixed = jobs.length > 1 && (clients.length > 1 || unnamed);
    const note = !mixed ? ''
      : clients.length > 1
        ? `These jobs belong to ${clients.length}${unnamed ? ' or more' : ''} different customers — each recipient would see the others' jobs. Their saved contacts are not filled in.`
        : 'Not every one of these jobs names its customer, so they may belong to different customers — each recipient would see every job. Their saved contacts are not filled in.';
    const context = { division: cfg.division, projectIds, clients, mixed, canEdit: false, apiBase: cfg.apiBase, getToken: () => token() };
    const done = list => (mixed ? { contacts: [], suggested: list, note, context } : { contacts: list, suggested: [], note: '', context });
    if (!jobs.length) return done([]);
    // A client name with a comma cannot ride in the comma-separated list:
    // then the division's whole list is read and matched here.
    const commas = clients.some(c => c.key.includes(','));
    const params = commas || projectIds.length > MAX_IDS_CALL || clients.length > MAX_IDS_CALL ? null
      : { project_ids: projectIds.join(','), client_keys: clients.map(c => c.key).join(',') };
    let data = null;
    try {
      data = await Promise.race([api.contactsQuiet(params), new Promise(r => setTimeout(() => r(null), 5000))]);
    } catch (_) { data = null; }
    if (!data || !Array.isArray(data.contacts)) return done([]);
    context.canEdit = data.canEdit === true;
    const byJob = new Map(jobs.map(p => [String(p.id), p]));
    const byClient = new Map(clients.map(c => [c.key, c]));
    const out = [], seen = new Set();
    const add = (c, source, label) => {
      const email = txt(c.email).toLowerCase();
      if (!email || seen.has(email) || c.auto_add === false) return;
      seen.add(email);
      out.push({ email, name: txt(c.name), source, label });
    };
    data.contacts.forEach(c => {
      if (c && c.project_id != null && byJob.has(String(c.project_id))) add(c, 'job', `Job contact — ${jobName(byJob.get(String(c.project_id)))}`);
    });
    data.contacts.forEach(c => {
      if (c && c.project_id == null && c.client_key && byClient.has(c.client_key)) {
        add(c, 'client', `Client contact — ${txt(c.client_name) || byClient.get(c.client_key).name}`);
      }
    });
    return done(out);
  }

  async function doExcel() {
    if (!S.doc || S.busy.excel || !requireJobs()) return;
    const d = S.doc;
    await whenReadyFor('excel');
    if (S.doc !== d) return;
    let built, bytes;
    try {
      built = buildCurrent({ html: false });
      bytes = E.buildXlsx(built.def, built.ctx);
    } catch (err) { toast('Couldn’t build the workbook: ' + err.message, 'error'); return; }
    if (typeof Blob !== 'function' || !window.URL || typeof URL.createObjectURL !== 'function') {
      toast('This browser can’t download files from here.', 'error');
      return;
    }
    // A workbook is the file most often attached to an email by hand, out of
    // reach of the Email button's question — so it asks here too.
    if (builtIsInternal(built) && !window.confirm(EXCEL_INTERNAL_CONFIRM)) return;
    const blob = new Blob([bytes], { type: E.XLSX_MIME || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = E.xlsxFileName(built.def, built.ctx);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) { /* fine */ } a.remove(); }, 2000);
    logRun('excel', built);
  }

  // ── Send history ────────────────────────────────────────────────────
  const ACTION_LABEL = { print: '&#128424; Print / PDF', email: '&#9993; Email', excel: '&#8681; Excel' };
  function historyHtml() {
    const head = `<div class="cr-hist-head">
        <button type="button" class="btn btn-ghost cr-sm" data-act="back" data-fk="back">&#8592; ${S.doc ? 'Back to the report' : 'Back'}</button>
        <h2 class="cr-h2">Send History</h2>
        <button type="button" class="btn btn-ghost cr-sm" data-act="history-refresh" data-fk="history-refresh"${S.runsLoading ? ' disabled' : ''}>&#8635; Refresh</button>
      </div>
      <p class="cr-hint">${S.canShare ? 'Every print, email and Excel download of a custom report in the division, newest first.'
        : 'Your prints, emails and Excel downloads of custom reports, newest first.'}</p>`;
    if (S.runsError) {
      return head + `<div class="cr-alert" role="alert"><span>Couldn’t load the history: ${esc(S.runsError)}</span>
        <button type="button" class="btn btn-ghost cr-sm" data-act="history-refresh">Retry</button></div>`;
    }
    if (!S.runs) return head + '<p class="cr-loading">Loading…</p>';
    if (!S.runs.length) return head + '<p class="cr-empty">Nothing sent yet. Print, email or download a report and it will show up here.</p>';
    const rows = S.runs.map(r => {
      const names = Array.isArray(r.project_names) ? r.project_names.filter(Boolean) : [];
      const jobs = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3} more`;
      const range = E.resolveDateRange({ preset: 'custom', from: r.date_from || '', to: r.date_to || '' }).label;
      const to = Array.isArray(r.recipients) && r.recipients.length ? r.recipients.join(', ') : '—';
      return `<tr>
        <td data-label="When" class="cr-nowrap">${esc(fmtWhen(r.created_at))}</td>
        <td data-label="Who">${esc(r.run_by_username || '—')}</td>
        <td data-label="Report"><div>${esc(r.report_name || '')}${r.subject ? `<span class="cr-hint">${esc(r.subject)}</span>` : ''}</div></td>
        <td data-label="Action" class="cr-nowrap">${ACTION_LABEL[r.action] || esc(r.action)}${RUN_KIND_LABEL[r.run_kind] ? `<span class="cr-hint">${esc(RUN_KIND_LABEL[r.run_kind])}</span>` : ''}</td>
        <td data-label="Data">${r.included_internal ? badge('&#128274; Internal', 'internal') : badge('Customer-safe', 'safe')}</td>
        <td data-label="Jobs" title="${esc(names.join(', '))}">${esc(jobs || '—')}</td>
        <td data-label="Dates" class="cr-nowrap">${esc(range)}</td>
        <td data-label="Recipients">${esc(to)}</td>
      </tr>`;
    }).join('');
    return head + `<div class="cr-tablewrap"><table class="cr-table">
      <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Report</th><th scope="col">Action</th>
        <th scope="col">Data</th><th scope="col">Jobs</th><th scope="col">Dates</th><th scope="col">Recipients</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      ${S.runsNext != null ? `<div class="cr-more"><button type="button" class="btn btn-ghost" data-act="history-more" data-fk="history-more"${S.runsMore ? ' disabled' : ''}>${S.runsMore ? 'Loading…' : 'Load more'}</button></div>` : ''}`;
  }

  // ── Customer History ────────────────────────────────────────────────
  /* Every email a job's customer was sent — by anyone in the division, not
     only the user — newest first, a page at a time. Open shows the copy
     that was archived at send time (exactly what went), or, for an older
     send with no copy, a rebuild from today's data under a yellow banner
     that says so. Resend mails the same copy again. */
  // The server's rule for an internal send's copy: its sender, or an admin /
  // level 3. Unknown (no sender on the row) is the server's call, except
  // where `strict` asks for a sure yes.
  function mayOpenInternal(run, strict) {
    if (S.canShare) return true;
    if (!S.me) return !strict;
    if (run.run_by_user_id != null) return sameId(run.run_by_user_id, S.me.userId);
    if (run.run_by_username) return run.run_by_username === S.me.username;
    return !strict;
  }
  function clientList() {
    const seen = new Map();
    projects().forEach(p => { const k = clientKey(p.client); if (k && !seen.has(k)) seen.set(k, txt(p.client)); });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }));
  }
  function customerJobOptions() {
    const q = S.cust.search.trim().toLowerCase();
    const c = S.cust.client;
    const list = projects().filter(p => (!c || clientKey(p.client) === c) && matchJob(p, q));
    const sel = S.cust.jobId ? projectById(S.cust.jobId) : null;
    if (sel && !list.includes(sel)) list.unshift(sel);
    const shown = list.slice(0, 300);
    return `<option value="">${list.length ? 'Pick a job…' : 'No job matches'}</option>`
      + shown.map(p => {
        const meta = [txt(p['job-number']) ? '#' + txt(p['job-number']) : '', txt(p.client)].filter(Boolean).join(' · ');
        return `<option value="${esc(String(p.id))}"${S.cust.jobId && sameId(S.cust.jobId, p.id) ? ' selected' : ''}>${esc(jobName(p))}${meta ? ' — ' + esc(meta) : ''}</option>`;
      }).join('');
  }
  function customerHtml() {
    const c = S.cust;
    const job = c.jobId ? projectById(c.jobId) : null;
    const clients = clientList();
    const head = `<div class="cr-view-head">
        <button type="button" class="btn btn-ghost cr-sm" data-act="back" data-fk="back">&#8592; ${S.doc ? 'Back to the report' : 'Back'}</button>
        <h2 class="cr-h2">Customer History</h2>
        ${job ? `<button type="button" class="btn btn-ghost cr-sm" data-act="cust-refresh" data-fk="cust-refresh"${c.loading ? ' disabled' : ''}>&#8635; Refresh</button>` : ''}
      </div>
      <p class="cr-hint">What each job’s customer was emailed, newest first — by anyone in ${esc(divLabel())}. <b>Open</b> shows exactly what was sent; <b>Resend</b> mails the same copy again.</p>
      <div class="cr-toolrow">
        <input type="search" class="cr-input" data-bind="cust-search" data-fk="cust-search" value="${esc(c.search)}" placeholder="&#128269; Find a job…"
          aria-label="Find a job by name, number, client or status" autocomplete="off" spellcheck="false">
        ${clients.length ? `<select class="cr-input" data-bind="cust-client" data-fk="cust-client" aria-label="Only this client's jobs">
          <option value="">All clients</option>${clients.map(([k, n]) => `<option value="${esc(k)}"${c.client === k ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
        <select class="cr-input" data-bind="cust-job" data-fk="cust-job" aria-label="Job">${customerJobOptions()}</select>
      </div>`;
    if (!job) return head + `<p class="cr-empty">${projects().length ? 'Pick a job to see what its customer was sent.' : (S.readyDone ? 'No jobs in this division yet.' : 'Loading jobs…')}</p>`;
    if (c.error) {
      return head + `<div class="cr-alert" role="alert"><span>Couldn’t load the history: ${esc(c.error)}</span>
        <button type="button" class="btn btn-ghost cr-sm" data-act="cust-refresh">Retry</button></div>`;
    }
    if (!c.runs) return head + '<p class="cr-loading">Loading…</p>';
    if (!c.runs.length) return head + `<p class="cr-empty">No custom report has been emailed for ${esc(jobName(job))} yet.</p>`;
    const rows = c.runs.map(r => {
      const to = Array.isArray(r.recipients) && r.recipients.length ? r.recipients.join(', ') : '—';
      const kind = RUN_KIND_LABEL[r.run_kind] || '—';
      const busy = c.busy != null && sameId(c.busy, r.id);
      const locked = r.included_internal && !mayOpenInternal(r);
      const tip = locked ? ` title="${esc(INTERNAL_ARCHIVE_MSG)}"` : '';
      return `<tr>
        <td data-label="Date" class="cr-nowrap">${esc(fmtWhen(r.created_at))}</td>
        <td data-label="Report">${esc(r.report_name || '')}</td>
        <td data-label="Subject">${esc(r.subject || '—')}</td>
        <td data-label="Recipients">${esc(to)}</td>
        <td data-label="Sent by">${esc(r.run_by_username || '—')}</td>
        <td data-label="Kind">${esc(kind)}</td>
        <td data-label="Data">${r.included_internal ? badge('&#128274; Internal', 'internal') : badge('Customer-safe', 'safe')}</td>
        <td data-label="Actions"><span class="cr-rowacts">
          <button type="button" class="btn btn-ghost cr-sm" data-act="cust-open" data-id="${esc(r.id)}" data-fk="cust-open-${esc(r.id)}"${busy ? ' disabled' : ''}${tip}
            aria-label="Open what was sent on ${esc(fmtWhen(r.created_at))}">Open</button>
          <button type="button" class="btn btn-ghost cr-sm" data-act="cust-resend" data-id="${esc(r.id)}" data-fk="cust-resend-${esc(r.id)}"${busy ? ' disabled' : ''}${tip}
            aria-label="Resend what was sent on ${esc(fmtWhen(r.created_at))}">${busy ? '<span class="cr-spin" aria-hidden="true"></span> ' : ''}Resend</button>
          <button type="button" class="btn btn-ghost cr-sm" data-act="cust-builder" data-id="${esc(r.id)}" data-fk="cust-builder-${esc(r.id)}"${busy ? ' disabled' : ''}
            title="Open this report as a new, unsaved report with the same jobs and dates">Open in builder</button>
        </span></td>
      </tr>`;
    }).join('');
    return head + `<div class="cr-tablewrap"><table class="cr-table cr-cust">
      <thead><tr><th scope="col">Date</th><th scope="col">Report</th><th scope="col">Subject</th><th scope="col">Recipients</th>
        <th scope="col">Sent by</th><th scope="col">Kind</th><th scope="col">Data</th><th scope="col"><span class="cr-sr">Actions</span></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      ${c.next != null ? `<div class="cr-more"><button type="button" class="btn btn-ghost" data-act="cust-more" data-fk="cust-more"${c.more ? ' disabled' : ''}>${c.more ? 'Loading…' : 'Load more'}</button></div>` : ''}`;
  }
  function openCustomer(jobId) {
    S.view = 'customer';
    S.railOpen = false;
    if (jobId != null && !sameId(jobId, S.cust.jobId)) { S.cust.jobId = String(jobId); S.cust.runs = null; S.cust.next = null; }
    // From an open one-job report, start on that job.
    if (!S.cust.jobId && S.doc && S.doc.picked.length === 1) S.cust.jobId = String(S.doc.picked[0]);
    render();
    if (S.cust.jobId) loadCustomer(false);
  }
  function loadCustomer(more) {
    const c = S.cust;
    const id = c.jobId;
    if (!id) return Promise.resolve();
    const params = { project_id: id, action: 'email' };
    if (more) {
      if (c.next == null || c.more) return Promise.resolve();
      params.before_id = c.next;
      c.more = true;
    } else {
      c.runs = null;
      c.next = null;
      c.loading = true;
    }
    c.error = '';
    if (S.view === 'customer') renderView();
    return api.runs(params).then(data => {
      if (!sameId(S.cust.jobId, id)) return;
      const rows = Array.isArray(data.runs) ? data.runs : [];
      S.cust.runs = more ? (S.cust.runs || []).concat(rows.filter(r => !(S.cust.runs || []).some(x => sameId(x.id, r.id)))) : rows;
      S.cust.next = data.next_before_id != null && rows.length ? data.next_before_id : null;
    }, err => {
      if (sameId(S.cust.jobId, id)) S.cust.error = err.message;
    }).then(() => {
      if (sameId(S.cust.jobId, id)) { S.cust.loading = false; S.cust.more = false; }
      if (S.view === 'customer') renderView();
    });
  }
  const custRun = id => (S.cust.runs || []).find(r => sameId(r.id, id)) || null;
  // The full run (definition, recipients) — the list rows may not carry it.
  async function runDetail(run) {
    if (run.definition && typeof run.definition === 'object' && Array.isArray(run.definition.sections)) return run;
    const data = await api.runOne(run.id);
    const full = Object.assign({}, run, (data && (data.run || data)) || {});
    const i = (S.cust.runs || []).indexOf(run);
    if (i >= 0) S.cust.runs[i] = full;
    return full;
  }
  // The copy archived at send time: its HTML, or null when there is none.
  async function archivedHtml(run) {
    if (run.has_archive === false) return null;
    try {
      const data = await api.archive(run.id);
      return data && typeof data.html === 'string' && data.html ? data.html : null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  /* A send with no archived copy, rebuilt from today's data as it was set up
     then: its definition, its jobs, its dates pinned, "today" and "now" the
     moment it went. Throws when the definition is gone (pruned after two
     years). */
  function rebuildRun(full, withBanner) {
    const def = E.normalizeDefinition(full.definition);
    if (!def.sections.length) throw failure('This send is too old to rebuild — its report layout was not kept.', 0, null);
    const ids = (Array.isArray(full.project_ids) ? full.project_ids : []).map(String);
    def.dates = { preset: 'custom', from: full.date_from || '', to: full.date_to || '' };
    def.jobs = { mode: 'pick', ids };
    const jobs = ids.map(projectById).filter(Boolean);
    if (!jobs.length) throw failure('The jobs this went out for no longer exist, so it cannot be rebuilt.', 0, null);
    const snap = { def, picked: ids, reportName: txt(full.report_name), dress: dressing(def, jobs),
      ctxOpts: { today: localDate(full.created_at) || undefined, now: full.created_at || undefined } };
    const built = buildFrom(snap);
    return { built, html: withBanner ? withRebuiltBanner(built.html) : built.html };
  }
  function withRebuiltBanner(html) {
    const bar = `<div role="note" style="background:#fef3c7;color:#713f12;border:1px solid #f59e0b;border-radius:4px;padding:8px 12px;margin:0 0 12px;font:600 13px/1.4 system-ui,sans-serif">&#9888; ${esc(REBUILT_BANNER)}</div>`;
    return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, m => m + bar) : bar + html;
  }
  /* A copy opened from the history is shown, never run. What was archived is
     whatever the sender's browser sent, sanitized by a pattern-matcher that
     is hygiene, not a wall — so it is never parsed as a document of this
     origin. The window gets a shell whose first bytes are a policy allowing
     no form, no outside load and no script but the shell's own (one inline
     script, carrying a nonce made fresh for each open), and the copy goes in
     an iframe sandboxed WITHOUT allow-scripts: no <script>, no handler, no
     markup trick in it can run, wherever it puts a <head>. allow-same-origin
     (still no scripts) only lets the shell size the frame to the report, so
     the window scrolls and prints it whole, and copy its page size across;
     allow-modals lets the Print button print the copy itself, with its own
     page setup. The shell's script is its own, not this page's, so the Print
     button and the fitting keep working after this tab moves on or reloads.
     Nothing goes through dwWrite: an archive carries its own brand band, and
     anything added in front of the shell would push the policy out of the
     head, where browsers ignore it. */
  const lockedCsp = nonce => "default-src 'none'; script-src 'nonce-" + nonce + "'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";
  /* The copy window's own script: static code, nothing of the archive in it.
     It fits the frame to the copy on screen. Keyboard print (Ctrl/Cmd+P,
     Save as PDF) and the Print button print the copy's own frame directly, so
     it paginates exactly as printing the copy does — table header repeating,
     rows kept whole — rather than the browser slicing a single tall iframe box
     at the page edges. The browser-menu Print cannot be intercepted; for that
     path only, the frame is sized to the copy's print width (the page's, or
     wider where its tables need more) so the window overflows and the browser
     shrinks it to fit, keeping every column. */
  const COPY_WINDOW_JS = `(function () {
  var fr = document.querySelector('iframe');
  if (!fr) return;
  var inner = function () { try { var d = fr.contentDocument; return d && d.documentElement ? d : null; } catch (e) { return null; } };
  var tall = function (d) { return Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0); };
  var wide = function (d) { return Math.max(d.documentElement.scrollWidth, d.body ? d.body.scrollWidth : 0); };
  var fit = function () { var d = inner(); if (d) fr.style.height = tall(d) + 'px'; };
  var pageW = 729;
  var printCss = document.createElement('style');
  document.head.appendChild(printCss);
  /* The copy laid out as it prints while it is measured: its print rules on
     and its screen rules off (the words swapped in each @media rule), put
     back straight after, before anything is drawn. */
  var mediaSwap = function (d) {
    var done = [];
    try { if (fr.contentWindow.matchMedia('print').matches) return done; } catch (e) { }
    [].forEach.call(d.styleSheets, function (sh) {
      var rules;
      try { rules = sh.cssRules; } catch (e) { return; }
      [].forEach.call(rules, function (r) {
        if (r.type !== 4 || !r.media) return;
        var t = r.media.mediaText;
        if (!/\\b(print|screen)\\b/i.test(t)) return;
        try {
          r.media.mediaText = t.replace(/\\b(print|screen)\\b/gi, function (w) { return /print/i.test(w) ? 'screen' : 'print'; });
          done.push([r, t]);
        } catch (e) { }
      });
    });
    return done;
  };
  var sizeForPrint = function () {
    var d = inner();
    if (!d) return;
    var w0 = fr.style.width, h0 = fr.style.height, x0 = window.scrollX, y0 = window.scrollY;
    var swapped = [];
    try {
      swapped = mediaSwap(d);
      fr.style.height = '10px';
      fr.style.width = '320px';
      // Never wider than the browser will shrink a page to fit (one and a
      // half pages): past that it clips, and a frame that wide would take
      // every table's right edge with it, where printing the copy itself
      // clips only the table too wide to fit.
      var w = Math.max(pageW, Math.min(wide(d), Math.floor(pageW * 1.5)));
      fr.style.width = w + 'px';
      var h = tall(d);
      printCss.textContent = '@media print{iframe{width:' + w + 'px!important;height:' + h + 'px!important}}';
    } catch (e) {
    } finally {
      swapped.forEach(function (s) { try { s[0].media.mediaText = s[1]; } catch (e) { } });
      fr.style.width = w0;
      fr.style.height = h0;
      try { window.scrollTo(x0, y0); } catch (e) { }
    }
  };
  /* Keyboard print prints the copy itself, never the sized-iframe shell:
     a single tall iframe box cannot break inside, so the browser would slice
     rows at each page edge and drop the repeating header. Attached to the
     shell and, after every frame load, to the frame document, so it fires
     wherever focus sits. The browser's menu Print cannot be reached this way;
     sizeForPrint still handles that path. */
  var printFrame = function (e) {
    if (e.altKey || !(e.ctrlKey || e.metaKey) || (e.key || '').toLowerCase() !== 'p') return;
    e.preventDefault();
    try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e2) { try { window.print(); } catch (e3) { } }
  };
  window.addEventListener('keydown', printFrame);
  var loaded = function () {
    fit();
    try { var kd = fr.contentDocument; if (kd) { kd.removeEventListener('keydown', printFrame); kd.addEventListener('keydown', printFrame); } } catch (e) { }
    var size = '';
    try {
      [].forEach.call(fr.contentDocument.styleSheets, function (sh) {
        try { [].forEach.call(sh.cssRules, function (r) { if (r.type === 6 && r.style) size = r.style.getPropertyValue('size') || size; }); } catch (e) { }
      });
    } catch (e) { }
    if (/^[a-z0-9 .]{1,40}$/i.test(size)) {
      var st = document.createElement('style');
      st.textContent = '@page{size:' + size + ';margin:0.45in}';
      document.head.appendChild(st);
      if (/landscape/i.test(size)) pageW = 969;
    }
    sizeForPrint();
  };
  fr.addEventListener('load', loaded);
  var d0 = inner();
  if (d0 && d0.readyState === 'complete' && d0.body && d0.body.childNodes.length) loaded();
  window.addEventListener('resize', fit);
  window.addEventListener('beforeprint', sizeForPrint);
  var btn = document.querySelector('[data-copy="print"]');
  if (btn) btn.addEventListener('click', function () {
    try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { try { window.print(); } catch (e2) { } }
  });
})();`;
  function copyNonce() {
    const b = new Uint8Array(16);
    try { window.crypto.getRandomValues(b); } catch (_) { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }
    return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  function lockedShell(html, title, nonce) {
    return '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="' + lockedCsp(nonce) + '">'
      + '<meta charset="utf-8"><title>' + esc(title) + '</title><style>'
      + 'html,body{margin:0;padding:0;background:#fff}'
      + '.cr-copy-bar{display:flex;align-items:center;gap:12px;padding:8px 14px;background:#f1f5f9;border-bottom:1px solid #cbd5e1;font:13px/1.4 system-ui,sans-serif;color:#334155}'
      + '.cr-copy-bar button{font:600 13px system-ui,sans-serif;padding:4px 12px;border:1px solid #94a3b8;border-radius:4px;background:#fff;cursor:pointer}'
      + 'iframe{display:block;border:0;width:100%;height:calc(100vh - 42px)}'
      + '@media print{.cr-copy-bar{display:none}}'
      + '</style></head><body><div class="cr-copy-bar"><span>' + esc(title) + '</span><button type="button" data-copy="print">Print</button></div>'
      + '<iframe sandbox="allow-same-origin allow-modals" title="' + esc(title) + '" srcdoc="' + esc(html) + '"></iframe>'
      + '<script nonce="' + nonce + '">' + COPY_WINDOW_JS + '</' + 'script></body></html>';
  }
  function writeLockedDown(win, html, title) {
    try { win.document.open(); } catch (_) { /* written fresh below */ }
    win.document.write(lockedShell(html, title, copyNonce()));
    try { win.document.close(); } catch (_) { /* fine */ }
    // Nothing in that window needs this one.
    try { win.opener = null; } catch (_) { /* fine */ }
  }
  async function custOpen(id) {
    const run = custRun(id);
    if (!run) return;
    if (run.included_internal && !mayOpenInternal(run)) { toast(INTERNAL_ARCHIVE_MSG, 'error'); return; }
    // Opened inside the click (the pop-up rule), filled once the copy is in.
    const win = window.open('', '_blank');
    if (!win) { alert('Your browser blocked the window. Allow pop-ups for this site and try again.'); return; }
    try {
      win.document.write('<!DOCTYPE html><title>Opening report…</title><p style="font:14px system-ui,sans-serif;padding:2rem;color:#444">Opening the report…</p>');
      win.document.close();
    } catch (_) { /* the real write follows */ }
    const fail = msg => { try { win.close(); } catch (_) { /* fine */ } toast(msg, 'error'); };
    let html = null;
    try { html = await archivedHtml(run); }
    catch (e) {
      if (e.status === 403 && code(e) === 'internal_archive') { fail(INTERNAL_ARCHIVE_MSG); return; }
      // A 401 signs the app tab out (call() → onAuthError → logout navigates
      // away); close the placeholder so it is not left orphaned, with no toast
      // on top of the sign-out.
      if (e.status === 401) { try { win.close(); } catch (_) { /* fine */ } return; }
      fail(`Couldn’t open it: ${e.message}`);
      return;
    }
    if (html == null) {
      try { html = rebuildRun(await runDetail(run), true).html; }
      catch (e) {
        if (e.status === 401) { try { win.close(); } catch (_) { /* fine */ } }
        else fail(`Couldn’t open it: ${e.message}`);
        return;
      }
    }
    if (win.closed) return;
    writeLockedDown(win, html, `Sent copy — ${txt(run.subject) || txt(run.report_name) || 'Report'}`);
  }
  async function custResend(id) {
    const run = custRun(id);
    if (!run || S.cust.busy != null) return;
    if (typeof window.openReportEmailModal !== 'function') { alert('Email module is still loading — please try again in a moment.'); return; }
    if (run.included_internal && !mayOpenInternal(run)) { toast(INTERNAL_ARCHIVE_MSG, 'error'); return; }
    S.cust.busy = run.id;
    renderView();
    let full, html;
    try {
      full = await runDetail(run);
      html = await archivedHtml(full);
      // No archived copy: the rebuild, without the "rebuilt" banner — it is
      // going to the customer.
      if (html == null) html = rebuildRun(full, false).html;
    } catch (e) {
      if (e.status === 403 && code(e) === 'internal_archive') toast(INTERNAL_ARCHIVE_MSG, 'error');
      else if (e.status !== 401) toast(`Couldn’t resend it: ${e.message}`, 'error');
      return;
    } finally {
      S.cust.busy = null;
      if (S.view === 'customer') renderView();
    }
    if (!emailSizeOk(html, true)) return;
    const internal = full.included_internal === true || INTERNAL_MARK.test(html);
    if (internal && !window.confirm('This report includes internal data — costs, rates, hours, employee names or profit. Resend it anyway? Only send it inside the company.')) return;
    const ids = (Array.isArray(full.project_ids) ? full.project_ids : []).map(String);
    // A scheduled send can have gone to more addresses than one email may
    // carry: the first ones are filled in, and the rest are named as left off.
    const sentTo = Array.isArray(full.recipients) ? full.recipients.filter(x => typeof x === 'string') : [];
    if (sentTo.length > MAX_SEND_TO) {
      toast(`This went to ${sentTo.length} addresses; one email can go to ${MAX_SEND_TO}, so the first ${MAX_SEND_TO} are filled in. `
        + `Send it again for the other ${sentTo.length - MAX_SEND_TO}.`, 'error');
    }
    const record = {
      report_id: full.report_id != null ? full.report_id : null,
      report_name: txt(full.report_name).slice(0, 200) || 'Untitled report',
      project_ids: ids.slice(0, MAX_JOBS),
      project_names: (Array.isArray(full.project_names) ? full.project_names : []).slice(0, MAX_JOBS),
      date_from: full.date_from || null, date_to: full.date_to || null,
      included_internal: internal,
      definition: full.definition && typeof full.definition === 'object' ? full.definition : {},
      run_kind: 'resend', resent_from_run_id: full.id,
    };
    window.openReportEmailModal({
      reportType: `${cfg.division}_custom_report`,
      projectId: ids.length === 1 ? ids[0] : null,
      projectName: null,
      defaultSubject: txt(full.subject) || txt(full.report_name) || 'Report',
      defaultRecipients: sentTo.slice(0, MAX_SEND_TO),
      getHTML: () => html,
      customReport: record,
      onSent: info => {
        const again = () => { if (S.view === 'customer') loadCustomer(false); };
        if (info && info.logged) { again(); return undefined; }
        return api.run(Object.assign({}, record, {
          action: 'email', recipients: info && Array.isArray(info.recipients) ? info.recipients.slice(0, 50) : [],
          subject: (info && info.subject) || null,
        })).then(again).catch(e => console.warn('[custom-reports] could not log the resend:', e && e.message));
      },
    });
  }
  // The send as a new, unsaved report: same sections, jobs and dates.
  async function custBuilder(id) {
    const run = custRun(id);
    if (!run) return;
    let full;
    try { full = await runDetail(run); }
    catch (e) { if (e.status !== 401) toast(`Couldn’t open it: ${e.message}`, 'error'); return; }
    const def = E.normalizeDefinition(full.definition);
    if (!def.sections.length) { toast('This send is too old to reopen — its report layout was not kept.', 'error'); return; }
    if (full.date_from || full.date_to) def.dates = { preset: 'custom', from: full.date_from || '', to: full.date_to || '' };
    // An internal send reopens internal only for someone who may open it;
    // anyone else starts customer-safe.
    if (def.includeInternal && !mayOpenInternal(full, true)) def.includeInternal = false;
    const ids = (Array.isArray(full.project_ids) ? full.project_ids : []).map(String);
    const live = ids.filter(x => projectById(x));
    def.jobs = { mode: 'pick', ids: [] };
    if (!okToLeave()) return;
    startEditing(blankDoc(def, { name: txt(full.report_name), picked: live.map(x => projectById(x).id), missing: ids.length - live.length, touched: true }));
    toast('Opened what was sent as a new, unsaved report.');
  }

  // ── Contacts ────────────────────────────────────────────────────────
  /* The customer contacts saved per job and per client. "Auto-add" ones fill
     in the email for a report on their job (or any job for their client).
     level 2 and up can change them; level 1 can look. */
  const roleLabel = r => (CONTACT_ROLES.find(x => x[0] === r) || CONTACT_ROLES[CONTACT_ROLES.length - 1])[1];
  function openContacts(jobId) {
    S.view = 'contacts';
    S.railOpen = false;
    if (jobId !== undefined) S.contactsJob = jobId == null ? '' : String(jobId);
    S.contactEdit = null;
    render();
    loadContacts(true);
  }
  function contactMatches(c, q, byId) {
    if (!q) return true;
    const p = c.project_id != null ? byId.get(String(c.project_id)) : null;
    return [c.name, c.title, c.organization, c.email, c.phone, c.client_name, p && jobName(p)].some(v => txt(v).toLowerCase().includes(q));
  }
  function contactsHtml() {
    const can = S.contactsCanEdit;
    const head = `<div class="cr-view-head">
        <button type="button" class="btn btn-ghost cr-sm" data-act="back" data-fk="back">&#8592; ${S.doc ? 'Back to the report' : 'Back'}</button>
        <h2 class="cr-h2">Contacts</h2>
        <button type="button" class="btn btn-ghost cr-sm" data-act="ct-refresh" data-fk="ct-refresh">&#8635; Refresh</button>
        ${can && !S.contactEdit ? '<button type="button" class="btn btn-green cr-sm" data-act="ct-add" data-fk="ct-add">+ Add contact</button>' : ''}
      </div>
      <p class="cr-hint">Customer contacts for ${esc(divLabel())}, saved per job or per client. Ones set to <b>auto-add</b> fill in the email when you send a report for their job.${can ? '' : ' Only level 2 users and up can change them.'}</p>
      <div class="cr-toolrow">
        <input type="search" class="cr-input" data-bind="ct-search" data-fk="ct-search" value="${esc(S.contactsSearch)}" placeholder="&#128269; Search contacts…"
          aria-label="Search contacts by name, email, organization, job or client" autocomplete="off" spellcheck="false">
        <select class="cr-input" data-bind="ct-job" data-fk="ct-job" aria-label="Only one job's contacts">
          <option value="">Every job and client</option>
          ${projects().map(p => `<option value="${esc(String(p.id))}"${S.contactsJob && sameId(S.contactsJob, p.id) ? ' selected' : ''}>${esc(jobName(p))}</option>`).join('')}
        </select>
      </div>
      ${S.contactEdit ? contactFormHtml() : ''}`;
    // A failed load says so whether or not an earlier list is still kept —
    // that list may be missing contacts added since.
    const failed = S.contactsError
      ? `<div class="cr-alert" role="alert"><span>Couldn’t load contacts: ${esc(S.contactsError)}${S.contacts ? ' — showing the last list loaded.' : ''}</span>
        <button type="button" class="btn btn-ghost cr-sm" data-act="ct-refresh">Retry</button></div>`
      : '';
    if (S.contactsError && !S.contacts) return head + failed;
    if (!S.contacts) return head + '<p class="cr-loading">Loading…</p>';
    return head + failed + `<div class="cr-ct-list">${contactListHtml()}</div>`;
  }
  function contactListHtml() {
    const q = S.contactsSearch.trim().toLowerCase();
    const job = S.contactsJob ? projectById(S.contactsJob) : null;
    const jk = job ? clientKey(job.client) : '';
    const byId = new Map(projects().map(p => [String(p.id), p]));
    let list = (S.contacts || []).filter(c => contactMatches(c, q, byId));
    if (S.contactsJob) list = list.filter(c => (c.project_id != null && sameId(c.project_id, S.contactsJob)) || (jk && c.project_id == null && c.client_key === jk));
    if (!list.length) {
      return `<p class="cr-empty">${(S.contacts || []).length ? 'No contact matches.' : 'No contacts saved yet.'}${S.contactsCanEdit ? ' Use <b>+ Add contact</b>, or “Save as contact” in the email window.' : ''}</p>`;
    }
    const groups = new Map();
    list.forEach(c => {
      const p = c.project_id != null ? byId.get(String(c.project_id)) : null;
      const key = c.project_id != null ? 'j:' + c.project_id : 'c:' + (c.client_key || '');
      const title = c.project_id != null ? (p ? jobName(p) : `Job ${c.project_id} (no longer listed)`) : `Client: ${txt(c.client_name) || c.client_key || '—'}`;
      if (!groups.has(key)) groups.set(key, { title, kind: c.project_id != null ? 'Job' : 'Client', items: [] });
      groups.get(key).items.push(c);
    });
    const sorted = [...groups.values()].sort((a, b) => (a.kind === b.kind ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) : a.kind === 'Job' ? -1 : 1));
    return sorted.map(g => `<div class="cr-ct-group"><h3 class="cr-ct-group-h"><span>${esc(g.title)}</span><span class="cr-hint-i">${esc(g.kind)} · ${plural(g.items.length, 'contact')}</span></h3>
      ${g.items.map(contactCardHtml).join('')}</div>`).join('');
  }
  function contactCardHtml(c) {
    const can = S.contactsCanEdit;
    const line1 = [txt(c.title), txt(c.organization)].filter(Boolean).join(' · ');
    const line2 = [txt(c.email), txt(c.phone)].filter(Boolean).join(' · ');
    return `<div class="cr-ct-card">
      <div class="cr-ct-who"><b>${esc(txt(c.name) || txt(c.email))}</b> <span class="cr-badge">${esc(roleLabel(c.role))}</span>
        ${line1 ? `<span class="cr-hint">${esc(line1)}</span>` : ''}<span class="cr-hint">${esc(line2)}</span></div>
      <div class="cr-ct-tools">
        <label class="cr-check"><input type="checkbox" data-bind="ct-auto" data-id="${esc(c.id)}" data-fk="ct-auto-${esc(c.id)}"${c.auto_add !== false ? ' checked' : ''}${can ? '' : ' disabled'}> Auto-add</label>
        ${can ? `<button type="button" class="btn btn-ghost cr-sm" data-act="ct-edit" data-id="${esc(c.id)}" data-fk="ct-edit-${esc(c.id)}" aria-label="Edit ${esc(txt(c.name) || txt(c.email))}">Edit</button>
        <button type="button" class="btn btn-ghost cr-sm" data-act="ct-delete" data-id="${esc(c.id)}" data-fk="ct-delete-${esc(c.id)}" aria-label="Delete ${esc(txt(c.name) || txt(c.email))}">Delete</button>` : ''}
      </div></div>`;
  }
  function contactFormHtml() {
    const f = S.contactEdit;
    const clients = clientList();
    const v = k => esc(f[k] == null ? '' : String(f[k]));
    const fld = (k, label, extra) => `<div class="cr-field"><label class="cr-label" for="cr-ct-${k}">${label}</label>
      <input id="cr-ct-${k}" class="cr-input" data-bind="ct-field" data-field="${k}" data-fk="ct-f-${k}" value="${v(k)}" maxlength="${k === 'phone' ? 40 : 120}" autocomplete="off"${extra || ''}></div>`;
    return `<div class="cr-form" role="group" aria-label="${f.id != null ? 'Edit contact' : 'New contact'}">
      <div class="cr-field"><label class="cr-label" for="cr-ct-scope">For</label>
        <select id="cr-ct-scope" class="cr-input" data-bind="ct-field" data-field="scope" data-fk="ct-f-scope">
          <option value="job"${f.scope === 'job' ? ' selected' : ''}>One job</option>
          <option value="client"${f.scope === 'client' ? ' selected' : ''}>Every job for a client</option>
        </select></div>
      ${f.scope === 'client'
        ? `<div class="cr-field"><label class="cr-label" for="cr-ct-client">Client</label>
          <select id="cr-ct-client" class="cr-input" data-bind="ct-field" data-field="client_name" data-fk="ct-f-client">
            <option value="">Pick a client…</option>
            ${clients.map(([k, n]) => `<option value="${esc(n)}"${clientKey(f.client_name) === k ? ' selected' : ''}>${esc(n)}</option>`).join('')}
            ${f.client_name && !clients.some(([k]) => k === clientKey(f.client_name)) ? `<option value="${v('client_name')}" selected>${v('client_name')}</option>` : ''}
          </select></div>`
        : `<div class="cr-field"><label class="cr-label" for="cr-ct-job">Job</label>
          <select id="cr-ct-job" class="cr-input" data-bind="ct-field" data-field="project_id" data-fk="ct-f-job">
            <option value="">Pick a job…</option>
            ${projects().map(p => `<option value="${esc(String(p.id))}"${f.project_id && sameId(f.project_id, p.id) ? ' selected' : ''}>${esc(jobName(p))}</option>`).join('')}
          </select></div>`}
      ${fld('email', 'Email', ' type="email" inputmode="email" required')}
      ${fld('name', 'Name')}
      ${fld('title', 'Title')}
      ${fld('organization', 'Organization')}
      ${fld('phone', 'Phone', ' type="tel" inputmode="tel"')}
      <div class="cr-field"><label class="cr-label" for="cr-ct-role">Role</label>
        <select id="cr-ct-role" class="cr-input" data-bind="ct-field" data-field="role" data-fk="ct-f-role">
          ${CONTACT_ROLES.map(([k, n]) => `<option value="${k}"${(f.role || 'other') === k ? ' selected' : ''}>${esc(n)}</option>`).join('')}
        </select></div>
      <label class="cr-check" style="align-self:end"><input type="checkbox" data-bind="ct-field" data-field="auto_add" data-fk="ct-f-auto"${f.auto_add !== false ? ' checked' : ''}>
        <span>Auto-add to emails</span></label>
      <p class="cr-form-err" role="alert">${esc(f.error || '')}</p>
      <div class="cr-form-btns">
        <button type="button" class="btn btn-ghost cr-sm" data-act="ct-cancel" data-fk="ct-cancel">Cancel</button>
        <button type="button" class="btn btn-green cr-sm" data-act="ct-save" data-fk="ct-save"${f.saving ? ' disabled' : ''}>${f.saving ? 'Saving…' : f.id != null ? 'Save changes' : 'Add contact'}</button>
      </div></div>`;
  }
  function editContact(id) {
    if (id == null) {
      const job = S.contactsJob ? projectById(S.contactsJob) : null;
      S.contactEdit = { id: null, scope: 'job', project_id: job ? String(job.id) : '', client_name: '', email: '', name: '', title: '',
        organization: '', phone: '', role: 'other', auto_add: true, error: '' };
    } else {
      const c = (S.contacts || []).find(x => sameId(x.id, id));
      if (!c) return;
      S.contactEdit = { id: c.id, scope: c.project_id != null ? 'job' : 'client', project_id: c.project_id != null ? String(c.project_id) : '',
        client_name: txt(c.client_name), email: txt(c.email), name: txt(c.name), title: txt(c.title), organization: txt(c.organization),
        phone: txt(c.phone), role: c.role || 'other', auto_add: c.auto_add !== false, error: '' };
    }
    renderView();
    focusFk('ct-f-email');
  }
  function setContactField(el) {
    const f = S.contactEdit;
    if (!f) return;
    const k = el.getAttribute('data-field');
    if (k === 'auto_add') f.auto_add = !!el.checked;
    else if (['scope', 'project_id', 'client_name', 'email', 'name', 'title', 'organization', 'phone', 'role'].includes(k)) f[k] = el.value;
    if (k === 'scope') renderView();
  }
  const EMAIL_OK = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;
  const PHONE_OK = /^[0-9+().\-\s xXext]*$/;
  async function saveContact() {
    const f = S.contactEdit;
    if (!f || f.saving) return;
    const email = txt(f.email).toLowerCase();
    const say = msg => { f.error = msg; renderView(); };
    if (!EMAIL_OK.test(email)) { say('Enter a valid email address.'); focusFk('ct-f-email'); return; }
    if (f.scope === 'job' && !f.project_id) { say('Pick the job this contact is for.'); return; }
    if (f.scope === 'client' && !txt(f.client_name)) { say('Pick the client this contact is for.'); return; }
    if (txt(f.phone).length > 40 || !PHONE_OK.test(txt(f.phone))) { say('Phone numbers can use digits, spaces, + ( ) - . and “ext”.'); return; }
    const body = {
      name: txt(f.name).slice(0, 120) || null, title: txt(f.title).slice(0, 120) || null, organization: txt(f.organization).slice(0, 120) || null,
      email, phone: txt(f.phone) || null, role: CONTACT_ROLES.some(r => r[0] === f.role) ? f.role : 'other', auto_add: f.auto_add !== false,
    };
    if (f.scope === 'job') { body.project_id = String(f.project_id); body.client_key = null; body.client_name = null; }
    else { body.project_id = null; body.client_name = txt(f.client_name); body.client_key = clientKey(f.client_name); }
    f.saving = true;
    f.error = '';
    renderView();
    try {
      const res = f.id != null ? await api.updateContact(f.id, body) : await api.addContact(body);
      const c = res && res.contact ? res.contact : Object.assign({ id: f.id }, body);
      const list = (S.contacts || []).slice();
      const i = list.findIndex(x => sameId(x.id, c.id));
      if (i >= 0) list[i] = c; else list.push(c);
      S.contacts = list;
      S.contactEdit = null;
      renderView();
      toast(f.id != null ? 'Contact saved.' : `Added ${txt(c.name) || c.email}.`);
    } catch (e) {
      if (S.contactEdit !== f) return;
      f.saving = false;
      if (e.status === 409 && code(e) === 'duplicate') say(`${email} is already saved for this ${f.scope === 'job' ? 'job' : 'client'}.`);
      else if (e.status === 403) say('Only level 2 users and up can change contacts.');
      else if (e.status !== 401) say(`Couldn’t save: ${e.message}`);
    }
  }
  async function deleteContact(id) {
    const c = (S.contacts || []).find(x => sameId(x.id, id));
    if (!c) return;
    if (!window.confirm(`Delete the contact ${txt(c.name) || c.email}? It stops filling in emails.`)) return;
    try { await api.removeContact(c.id); }
    catch (e) { if (e.status !== 401) toast(`Couldn’t delete: ${e.message}`, 'error'); return; }
    S.contacts = (S.contacts || []).filter(x => !sameId(x.id, c.id));
    if (S.contactEdit && sameId(S.contactEdit.id, c.id)) S.contactEdit = null;
    renderView();
    toast(`Deleted ${txt(c.name) || c.email}.`);
  }
  async function setContactAuto(id, on, el) {
    const c = (S.contacts || []).find(x => sameId(x.id, id));
    if (!c) return;
    const was = c.auto_add !== false;
    c.auto_add = on;
    try {
      const res = await api.updateContact(c.id, { auto_add: on });
      if (res && res.contact) Object.assign(c, res.contact);
    } catch (e) {
      c.auto_add = was;
      if (el) el.checked = was;
      if (e.status !== 401) toast(`Couldn’t change it: ${e.message}`, 'error');
    }
  }

  // ── Schedules ───────────────────────────────────────────────────────
  /* Email a saved, customer-safe report on a schedule. The server keeps the
     rules (customer-safe as saved, a relative date range, someone to send
     to, the cadence) and says what is wrong in words; this dialog shows
     what it says next to the fields. A template can go once per job (each
     In Progress job, or the jobs picked here) or as one report of every In
     Progress job; a report with saved jobs goes as saved. */
  /* The groups the dialog offers: { list, gone }. Asked afresh at every
     open — every company group, so one saved since (from the email window,
     say) is there without a reload, and the list is what exists now: the
     general groups, this division's custom report type's, and any other this
     schedule sends to. A group the schedule sends to that is not in it was
     deleted: it is `gone`, never offered. Only when that list cannot be had
     do the schedules list's groups stand in (as of their load), with every
     group this schedule sends to that they do not name kept as "Group #id",
     so saving never drops a group the dialog could not check — the server
     leaves off any of those deleted since. */
  async function loadGroups(keepIds) {
    const keep = Array.isArray(keepIds) ? keepIds : [];
    const kept = id => keep.some(k => sameId(k, id));
    const type = `${cfg.division}_custom_report`;
    const shape = g => ({ id: g.id, name: txt(g.name) || 'Group', count: Array.isArray(g.emails) ? g.emails.length : Number(g.count) || 0 });
    let all = null;
    try {
      const data = await api.groups();
      if (data && Array.isArray(data.groups)) all = data.groups.filter(g => g && g.id != null);
    } catch (_) { /* the schedules list's, below */ }
    if (all) {
      return {
        list: all.filter(g => !g.report_type || g.report_type === type || kept(g.id)).map(shape),
        gone: keep.filter(id => !all.some(g => sameId(g.id, id))),
      };
    }
    const list = [];
    const add = g => { if (g && g.id != null && !list.some(x => sameId(x.id, g.id))) list.push(g); };
    (Array.isArray(S.schedGroups) ? S.schedGroups : []).forEach(g => add(shape(g)));
    keep.forEach(id => add({ id, name: `Group #${id}`, count: null }));
    return { list, gone: [] };
  }
  function scheduleBody(v) {
    const body = {
      custom_report_id: v.custom_report_id, jobs_mode: v.jobs_mode,
      frequency: v.frequency, send_time: v.send_time, timezone: v.timezone,
      days_of_week: v.frequency === 'weekly' ? v.days_of_week.slice() : null,
      day_of_month: v.frequency === 'monthly' ? Number(v.day_of_month) : null,
      group_ids: v.group_ids.slice(0, 10), emails: v.emails.slice(0, MAX_SCHED_EMAILS), use_job_contacts: !!v.use_job_contacts,
      subject: txt(v.subject).slice(0, 200) || null, note: String(v.note || '').slice(0, 2000) || null,
      attach_pdf: v.attach_pdf !== false, enabled: v.enabled !== false,
    };
    body.picked_jobs = v.jobs_mode === 'each' && v.picked ? v.picked_jobs.slice(0, MAX_SCHED_JOBS) : null;
    return body;
  }
  function scheduleValues(r, row) {
    const isTemplate = r ? r.kind !== 'report' : !(row && row.jobs_mode === 'saved');
    const v = {
      custom_report_id: row ? row.custom_report_id : r.id,
      jobs_mode: isTemplate ? 'each' : 'saved', picked: false, picked_jobs: [],
      frequency: 'weekly', days_of_week: [1], day_of_month: 1, send_time: '07:00', timezone: SCHED_TZ[0][0],
      group_ids: [], emails: [], use_job_contacts: true, subject: '', note: '', attach_pdf: true, enabled: true,
    };
    if (row) {
      Object.assign(v, {
        jobs_mode: row.jobs_mode || v.jobs_mode,
        picked_jobs: Array.isArray(row.picked_jobs) ? row.picked_jobs.filter(j => j && j.id != null).map(j => ({ id: String(j.id), name: txt(j.name) })) : [],
        frequency: row.frequency || v.frequency,
        days_of_week: Array.isArray(row.days_of_week) && row.days_of_week.length ? row.days_of_week.map(Number) : v.days_of_week,
        day_of_month: row.day_of_month != null ? Number(row.day_of_month) : v.day_of_month,
        send_time: row.send_time || v.send_time, timezone: row.timezone || v.timezone,
        group_ids: Array.isArray(row.group_ids) ? row.group_ids.slice() : [],
        emails: Array.isArray(row.emails) ? row.emails.slice() : [],
        use_job_contacts: row.use_job_contacts === true, subject: row.subject || '', note: row.note || '',
        attach_pdf: row.attach_pdf !== false, enabled: row.enabled !== false,
      });
      // The report may have changed kind since: a saved-jobs report sends as
      // saved, a template once per job (or as one report).
      if (!isTemplate) v.jobs_mode = 'saved';
      else if (v.jobs_mode !== 'all_in_progress') v.jobs_mode = 'each';
      v.picked = v.jobs_mode === 'each' && v.picked_jobs.length > 0;
    }
    return { v, isTemplate };
  }
  function scheduleError(e) {
    const d = (e && e.data) || {};
    if (d.error === 'fixed_dates') return d.message || 'Scheduled reports need a relative date range like Last week.';
    const list = Array.isArray(d.errors) ? d.errors.map(x => (x && (x.message || x.error)) || String(x)) : [];
    if (list.length) return list.join('\n');
    return d.message || d.error || (e && e.message) || 'Something went wrong.';
  }
  async function openSchedule(reportId, row) {
    if (modalOpen()) return;
    // Its last Edit… is still saving (that dialog closed meanwhile): the copy
    // here is from before that save, so it is not opened until it lands.
    if (row && schedSavingOut(row.id)) return;
    if (!S.canShare) { toast('Only an admin or level 3 user can schedule reports.', 'error'); return; }
    const r = reportId != null ? S.reports.find(x => sameId(x.id, reportId)) : null;
    if (!r && !row) { toast('Save the report first — a schedule sends a saved report.', 'error'); return; }
    if (!r && row && row.report_deleted === true) {
      toast(`“${txt(row.report_name) || 'This schedule’s report'}” was deleted, so this schedule can’t be edited. Restore the report from Recently Deleted, or delete the schedule.`, 'error');
      return;
    }
    if (!r && row) { toast('This schedule’s report isn’t shared with you, so it can’t be edited here. You can still pause, send or delete it.', 'error'); return; }
    const def = E.normalizeDefinition(r.definition);
    if (def.dates.preset === 'custom') {
      await choose('Pick a relative date range first',
        `“${r.name}” is set to fixed dates (${E.resolveDateRange(def.dates).label || 'a custom range'}), so every scheduled email would show the same days. `
        + 'Scheduled reports need a relative date range like Last week or Last 30 days — change it in step ①, save, then schedule it.',
        [{ label: 'OK', value: 'ok', primary: true }]);
      return;
    }
    if (r.customer_safe === false || def.includeInternal === true) {
      toast('Only customer-safe reports can be scheduled — switch internal data off and save.', 'error');
      return;
    }
    const { v, isTemplate } = scheduleValues(r, row);
    // The dialog opens at once, its groups loading into it: no wait with
    // nothing on screen, in which a second Edit… could open the first one.
    let groups = null;
    const groupsHtml = () => (groups.length ? `<div class="cr-m-list" role="group" aria-label="Saved recipient groups">${groups.map(g => `<label class="cr-check"><input type="checkbox" data-group="${esc(g.id)}"
          ${v.group_ids.some(x => sameId(x, g.id)) ? ' checked' : ''}> ${esc(g.name)}${g.count == null ? '' : ` <span class="cr-m-hint">(${plural(g.count, 'address', 'addresses')})</span>`}</label>`).join('')}</div>`
      : '<p class="cr-m-hint">No saved recipient groups for custom reports. An admin can make one from the email window.</p>');
    const tzKnown = SCHED_TZ.some(t => t[0] === v.timezone);
    const times = [];
    for (let m = 0; m < 24 * 60; m += 5) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0');
      times.push(`${hh}:${mm}`);
    }
    const jobsOpts = () => {
      const inProg = projects().filter(p => txt(p.status) === 'In Progress');
      const rest = projects().filter(p => txt(p.status) !== 'In Progress');
      return inProg.concat(rest).slice(0, 500);
    };
    const radio = (val, label, hint) => `<label class="cr-check"><input type="radio" name="cr-s-mode" value="${val}"${(val === 'picked' ? v.jobs_mode === 'each' && v.picked
      : val === 'each' ? v.jobs_mode === 'each' && !v.picked : v.jobs_mode === val) ? ' checked' : ''}><span><b>${label}</b>${hint ? `<span class="cr-m-hint"> — ${hint}</span>` : ''}</span></label>`;
    const m = modal(row ? 'Edit schedule' : 'Schedule this report', `
      <p class="cr-m-hint">Emails <b>${esc(r.name)}</b> — customer-safe only. It sends the saved copy, with its date range (${esc(E.resolveDateRange(def.dates).label || 'job to date')}) worked out on the day.</p>
      <fieldset class="cr-m-fs"><legend class="cr-m-label">How often</legend>
        <div class="cr-m-row">
          <select class="cr-input" id="cr-s-freq" aria-label="How often">
            ${[['daily', 'Daily'], ['weekdays', 'Weekdays (Mon–Fri)'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].map(([k, n]) => `<option value="${k}"${v.frequency === k ? ' selected' : ''}>${n}</option>`).join('')}
          </select>
          <label class="cr-sr" for="cr-s-time">Time</label>
          <select class="cr-input" id="cr-s-time">${times.map(t => `<option value="${t}"${v.send_time === t ? ' selected' : ''}>${time12(t)}</option>`).join('')}</select>
          <label class="cr-sr" for="cr-s-tz">Time zone</label>
          <select class="cr-input" id="cr-s-tz">${SCHED_TZ.map(([k, n]) => `<option value="${k}"${v.timezone === k ? ' selected' : ''}>${n}</option>`).join('')}
            <option value="other"${tzKnown ? '' : ' selected'}>Other…</option></select>
          <input class="cr-input" id="cr-s-tzother" placeholder="e.g. America/Phoenix" aria-label="Time zone (IANA name)" value="${tzKnown ? '' : esc(v.timezone)}"${tzKnown ? ' hidden' : ''}>
        </div>
        <div class="cr-m-days" id="cr-s-days"${v.frequency === 'weekly' ? '' : ' hidden'} role="group" aria-label="Days of the week">
          ${DOW.map((n, i) => `<label class="cr-check"><input type="checkbox" data-dow="${i}"${v.days_of_week.includes(i) ? ' checked' : ''}> ${n}</label>`).join('')}
        </div>
        <div class="cr-m-row" id="cr-s-dom-row"${v.frequency === 'monthly' ? '' : ' hidden'}>
          <label class="cr-m-label" for="cr-s-dom">Day of the month</label>
          <select class="cr-input" id="cr-s-dom">${Array.from({ length: 31 }, (_, i) => i + 1).map(n => `<option value="${n}"${Number(v.day_of_month) === n ? ' selected' : ''}>${ordinal(n)}</option>`).join('')}
            <option value="-1"${Number(v.day_of_month) === -1 ? ' selected' : ''}>Last day</option></select>
        </div>
      </fieldset>
      <fieldset class="cr-m-fs"><legend class="cr-m-label">Jobs</legend>
        ${isTemplate ? `${radio('each', 'Each In Progress job', 'one email per job')}
          ${radio('picked', 'Picked jobs', 'one email per job')}
          <div id="cr-s-pick"${v.picked && v.jobs_mode === 'each' ? '' : ' hidden'}>
            <input type="search" class="cr-input" id="cr-s-jobq" placeholder="&#128269; Find a job…" aria-label="Find a job" autocomplete="off">
            <div class="cr-m-list" id="cr-s-jobs" role="group" aria-label="Jobs to send">
              ${jobsOpts().map(p => `<label class="cr-check" data-name="${esc(`${jobName(p)} ${txt(p['job-number'])} ${txt(p.client)}`.toLowerCase())}"><input type="checkbox" data-job="${esc(String(p.id))}"
                ${v.picked_jobs.some(j => sameId(j.id, p.id)) ? ' checked' : ''}> ${esc(jobName(p))}${txt(p.status) !== 'In Progress' ? ` <span class="cr-m-hint">(${esc(txt(p.status) || 'no status')})</span>` : ''}</label>`).join('')}
            </div></div>
          ${radio('all_in_progress', 'All In Progress jobs', 'one report')}`
        : `<p>The report’s saved jobs <span class="cr-m-hint">(${plural(Array.isArray(def.jobs.ids) ? def.jobs.ids.length : 0, 'job')})</span></p>`}
      </fieldset>
      <fieldset class="cr-m-fs"><legend class="cr-m-label">Recipients</legend>
        <label class="cr-check"><input type="checkbox" id="cr-s-contacts"${v.use_job_contacts ? ' checked' : ''}>
          <span>Send to each job’s saved contacts<span class="cr-m-hint"> — a job with none is skipped</span></span></label>
        <p class="cr-m-hint" id="cr-s-contacts-why" hidden></p>
        <div id="cr-s-groups" aria-busy="true"><p class="cr-m-hint cr-s-groups-loading">Loading recipient groups…</p></div>
        <p class="cr-m-hint" id="cr-s-gone" role="status" hidden></p>
        <div class="cr-m-row">
          <input class="cr-input" id="cr-s-email" type="email" inputmode="email" placeholder="Add an email address" aria-label="Add an email address" autocomplete="off">
          <button type="button" class="btn btn-ghost cr-sm" data-s="add-email">Add</button>
        </div>
        <div class="cr-chips" id="cr-s-chips"></div>
      </fieldset>
      <label class="cr-m-label" for="cr-s-subject">Subject</label>
      <input class="cr-input" id="cr-s-subject" maxlength="200" value="${esc(v.subject)}" placeholder="${esc(`${txt(def.title) || r.name} — <job name>`)}">
      <label class="cr-m-label" for="cr-s-note">Note</label>
      <textarea class="cr-input" id="cr-s-note" rows="3" maxlength="2000" placeholder="A line above the report in the email (optional)">${esc(v.note)}</textarea>
      <label class="cr-check"><input type="checkbox" id="cr-s-pdf"${v.attach_pdf ? ' checked' : ''}> <span>Attach the report as a PDF</span></label>
      <label class="cr-check"><input type="checkbox" id="cr-s-enabled"${v.enabled ? ' checked' : ''}> <span>On — send on this schedule</span></label>
      <div class="cr-m-errs" role="alert"></div>
      <div class="cr-m-btns">
        <button type="button" class="btn btn-ghost" data-s="cancel">Cancel</button>
        <button type="button" class="btn btn-green" data-s="save">${row ? 'Save schedule' : 'Create schedule'}</button>
      </div>`, () => {
      // Closed (Escape, ✕, Cancel): the rail shows that schedule's ⋯ as it
      // is now — off while an edit's save is still out, on once none is.
      if (row) renderRail();
    }, { wide: true });
    const $ = sel => m.body.querySelector(sel);
    const errs = $('.cr-m-errs');
    loadGroups(v.group_ids).then(res => {
      if (!m.el.isConnected) return;                 // closed meanwhile
      groups = res.list;
      // A deleted group is taken off the schedule, and the dialog says so.
      if (res.gone.length) {
        v.group_ids = v.group_ids.filter(id => !res.gone.some(g => sameId(g, id)));
        const n = res.gone.length;
        $('#cr-s-gone').textContent = `${n === 1 ? 'A recipient group' : `${n} recipient groups`} this schedule sent to ${n === 1 ? 'was' : 'were'} deleted, `
          + `so ${n === 1 ? 'it is' : 'they are'} no longer on it. Save to keep the change.`;
        $('#cr-s-gone').hidden = false;
      }
      const box = $('#cr-s-groups');
      box.innerHTML = groupsHtml();
      box.removeAttribute('aria-busy');
    });
    /* Each job's saved contacts may only be sent a report about their own
       customer's jobs (the server refuses the rest as job_contacts): never
       one report of every In Progress job, and a saved report's jobs only
       when they all belong to one client. Say so, and take the tick away,
       rather than let Save fail on it. */
    const savedIds = Array.isArray(def.jobs.ids) ? def.jobs.ids : [];
    const savedClients = savedIds.map(id => { const p = projectById(id); return p ? clientKey(p.client) : ''; });
    const savedOneCustomer = savedIds.length <= 1 || savedClients.every(k => k && k === savedClients[0]);
    const contactsWhy = mode => (mode === 'all_in_progress'
      ? 'Not with one report of every In Progress job — each customer would be sent the others’ jobs. Send one email per job to use them.'
      : mode === 'saved' && !savedOneCustomer ? 'Not for this report — its jobs belong to more than one customer.' : '');
    // The person's own choice, kept while a mode that cannot use contacts
    // takes the tick away, and put back when that mode is left.
    let wantContacts = !!v.use_job_contacts;
    const syncContacts = () => {
      const mode = isTemplate ? ((m.body.querySelector('input[name="cr-s-mode"]:checked') || {}).value || 'each') : 'saved';
      const box = $('#cr-s-contacts'), note = $('#cr-s-contacts-why'), why = contactsWhy(mode);
      box.disabled = !!why;
      box.checked = why ? false : wantContacts;
      note.textContent = why;
      note.hidden = !why;
    };
    syncContacts();
    const showErr = msg => {
      errs.innerHTML = String(msg).split('\n').filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
      try { errs.scrollIntoView({ block: 'nearest' }); } catch (_) { /* fine */ }
    };
    const emails = v.emails.slice();
    const drawChips = () => {
      $('#cr-s-chips').innerHTML = emails.map((e, i) => `<span class="cr-chip"><span>${esc(e)}</span><button type="button" data-s="rm-email" data-i="${i}" aria-label="Remove ${esc(e)}">&#10005;</button></span>`).join('');
    };
    drawChips();
    const addEmails = () => {
      const box = $('#cr-s-email');
      const bad = [];
      String(box.value).split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean).forEach(x => {
        if (!EMAIL_OK.test(x)) { bad.push(x); return; }
        if (emails.includes(x)) return;
        if (emails.length >= MAX_SCHED_EMAILS) { bad.push(x); return; }
        emails.push(x);
      });
      box.value = bad.join(', ');
      drawChips();
      if (bad.length) showErr(emails.length >= MAX_SCHED_EMAILS ? `Up to ${MAX_SCHED_EMAILS} addresses.` : `Not an email address: ${bad.join(', ')}`);
      else errs.innerHTML = '';
      return bad;
    };
    m.body.addEventListener('change', e => {
      const t = e.target;
      if (t.id === 'cr-s-freq') {
        $('#cr-s-days').hidden = t.value !== 'weekly';
        $('#cr-s-dom-row').hidden = t.value !== 'monthly';
      } else if (t.id === 'cr-s-tz') {
        $('#cr-s-tzother').hidden = t.value !== 'other';
        if (t.value === 'other') $('#cr-s-tzother').focus();
      } else if (t.name === 'cr-s-mode') {
        const pick = $('#cr-s-pick');
        if (pick) pick.hidden = t.value !== 'picked';
        syncContacts();
      } else if (t.id === 'cr-s-contacts' && !t.disabled) {
        wantContacts = t.checked;
      }
    });
    m.body.addEventListener('input', e => {
      if (e.target.id !== 'cr-s-jobq') return;
      const q = e.target.value.trim().toLowerCase();
      m.body.querySelectorAll('#cr-s-jobs label').forEach(l => { l.hidden = !!q && !String(l.getAttribute('data-name')).includes(q); });
    });
    m.body.addEventListener('keydown', e => {
      if (e.target.id === 'cr-s-email' && (e.key === 'Enter' || e.key === ',')) { e.preventDefault(); addEmails(); }
    });
    let busy = false;
    const save = async () => {
      if (busy) return;
      // Whatever is left in the box is someone the sender meant to add: a
      // mistyped address (or one past the limit) stops the save, still in
      // the box with its message, rather than being dropped without a word.
      if (addEmails().length) { $('#cr-s-email').focus(); return; }
      const freq = $('#cr-s-freq').value;
      const tzSel = $('#cr-s-tz').value;
      const mode = isTemplate ? ((m.body.querySelector('input[name="cr-s-mode"]:checked') || {}).value || 'each') : 'saved';
      const val = Object.assign({}, v, {
        frequency: freq, send_time: $('#cr-s-time').value,
        timezone: tzSel === 'other' ? txt($('#cr-s-tzother').value) : tzSel,
        days_of_week: [...m.body.querySelectorAll('[data-dow]')].filter(b => b.checked).map(b => Number(b.getAttribute('data-dow'))),
        day_of_month: Number($('#cr-s-dom').value),
        jobs_mode: mode === 'picked' ? 'each' : mode, picked: mode === 'picked',
        picked_jobs: [...m.body.querySelectorAll('[data-job]')].filter(b => b.checked).map(b => {
          const p = projectById(b.getAttribute('data-job'));
          return { id: String(b.getAttribute('data-job')), name: p ? jobName(p) : '' };
        }),
        // Still loading: the groups the schedule sends to, as they were.
        group_ids: !groups ? v.group_ids.slice() : [...m.body.querySelectorAll('[data-group]')].filter(b => b.checked).map(b => {
          const g = groups.find(x => sameId(x.id, b.getAttribute('data-group')));
          return g ? g.id : b.getAttribute('data-group');
        }),
        emails: emails.slice(), use_job_contacts: $('#cr-s-contacts').checked,
        subject: $('#cr-s-subject').value, note: $('#cr-s-note').value,
        attach_pdf: $('#cr-s-pdf').checked, enabled: $('#cr-s-enabled').checked,
      });
      // What the server would say anyway, said before the round trip.
      const problems = [];
      if (freq === 'weekly' && !val.days_of_week.length) problems.push('Pick at least one day of the week.');
      if (!val.timezone) problems.push('Pick a time zone.');
      if (val.picked && !val.picked_jobs.length) problems.push('Tick the jobs to send, or choose “Each In Progress job”.');
      if (val.picked_jobs.length > MAX_SCHED_JOBS) problems.push(`Pick up to ${MAX_SCHED_JOBS} jobs.`);
      if (!val.use_job_contacts && !val.group_ids.length && !val.emails.length) problems.push('Add someone to send it to: the jobs’ saved contacts, a group or an email address.');
      if (val.group_ids.length > 10) problems.push('Pick up to 10 groups.');
      if (problems.length) { showErr(problems.join('\n')); return; }
      busy = true;
      const ok = $('[data-s="save"]');
      ok.disabled = true;
      ok.textContent = 'Saving…';
      errs.innerHTML = '';
      // An edit's row keeps its ⋯ off while the save is out, even once the
      // dialog is closed (Escape, ✕): an Edit… opened meanwhile would show
      // the settings from before and could save them back over this save.
      const savingId = row ? row.id : null;
      if (row) S.schedSaving.add(savingId);
      const saved = () => { if (row) S.schedSaving.delete(savingId); };
      try {
        const body = scheduleBody(val);
        const res = row ? await api.updateSchedule(row.id, body) : await api.createSchedule(body);
        saved();
        applySched(res && res.schedule);
        m.close(true);
        if (row && !(res && res.schedule)) renderRail();
        toast(row ? 'Schedule saved.' : `Scheduled “${r.name}”: ${cadenceText(val)}.`);
        loadSchedules();
      } catch (e) {
        saved();
        // Closed (Escape, ✕) while it read "Saving…": say so in a toast, not
        // into the detached dialog, and show the schedules as they are.
        if (!m.el.isConnected) {
          if (e.status !== 401) toast(`Couldn’t save the schedule: ${scheduleError(e)}`, 'error');
          if (row) renderRail();
          loadSchedules();
          return;
        }
        busy = false;
        ok.disabled = false;
        ok.textContent = row ? 'Save schedule' : 'Create schedule';
        const d = (e && e.data) || {};
        if (d.error === 'groups' && Array.isArray(d.missing) && d.missing.length) {
          // Deleted while the dialog was open: name them, so they can be unticked.
          const names = d.missing.map(id => { const g = (groups || []).find(x => sameId(x.id, id)); return g ? `“${g.name}”` : `Group #${id}`; });
          showErr(`${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} deleted — untick ${names.length === 1 ? 'it' : 'them'} and save again.`);
        } else if (e.status !== 401) showErr(scheduleError(e));
        // No answer, or the server's own failure: the save may have landed
        // all the same, so the rail (and the next Edit…) reads what the
        // server holds now — the dialog keeps what was typed. A refusal (4xx)
        // changed nothing.
        if (!e.status || e.status >= 500) loadSchedules();
      }
    };
    m.body.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-s]');
      if (!b) return;
      const what = b.getAttribute('data-s');
      if (what === 'cancel') m.close();
      else if (what === 'save') save();
      else if (what === 'add-email') addEmails();
      else if (what === 'rm-email') { emails.splice(Number(b.getAttribute('data-i')), 1); drawChips(); }
    });
    $('#cr-s-freq').focus();
  }
  function schedMenu(trigger, id) {
    const s = (S.scheds || []).find(x => sameId(x.id, id));
    if (!s) return;
    openMenu(trigger, [
      { act: 'sched-toggle', id: s.id, label: s.enabled ? 'Pause' : 'Resume', blurb: s.enabled ? 'Stop sending until resumed' : 'Start sending on its schedule again' },
      { act: 'sched-edit', id: s.id, label: 'Edit…' },
      { act: 'sched-send', id: s.id, label: 'Send now', blurb: 'Send it to its recipients right away' },
      { act: 'sched-delete', id: s.id, label: 'Delete', danger: true },
    ], 'right');
  }
  async function toggleSchedule(id) {
    const s = (S.scheds || []).find(x => sameId(x.id, id));
    if (!s) return;
    // The switch alone: a whole schedule sent back is a save, which would
    // re-check it and make it run as whoever clicked Pause / Resume.
    const v = { enabled: !s.enabled };
    if ([...S.schedToggling].some(x => sameId(x, s.id))) return;
    const key = s.id;
    S.schedToggling.add(key);
    renderRail();
    let res = null;
    try {
      res = await api.updateSchedule(s.id, { enabled: v.enabled });
      toast(v.enabled ? 'Schedule resumed.' : 'Schedule paused.');
    } catch (e) {
      if (e.status !== 401) toast(`Couldn’t ${v.enabled ? 'resume' : 'pause'} it: ${scheduleError(e)}`, 'error');
    }
    S.schedToggling.delete(key);
    if (res && res.schedule) applySched(res.schedule); else renderRail();
    loadSchedules();
  }
  // One Send now per schedule at a time (the server refuses a second of the
  // same schedule); another schedule's can go meanwhile, and each result
  // names its report so two sends cannot be confused.
  async function sendScheduleNow(id) {
    const s = (S.scheds || []).find(x => sameId(x.id, id));
    if (!s || [...S.schedBusy].some(x => sameId(x, s.id))) return;
    const name = txt(s.report_name) || 'this report';
    if (!window.confirm(`Send “${name}” to its recipients now? It can take a few minutes.`)) return;
    const key = s.id;
    S.schedBusy.add(key);
    renderRail();
    toast(`Sending “${name}” — this can take a few minutes. You can keep working.`);
    try {
      const res = await api.sendSchedule(s.id);
      const out = (res && (res.result || res.run)) || res || {};
      const status = String(out.status || '');
      const msg = txt(out.message);
      if (/^(sent|ok)$/i.test(status) || (!status && res && res.ok)) toast(`“${name}”: ${msg || `Sent${out.sent != null ? ` ${plural(Number(out.sent) || 0, 'email')}` : ''}.`}`);
      else toast(`“${name}”: ${msg || `Not sent (${status || 'unknown'}).`}`, /partial/i.test(status) ? null : 'error');
    } catch (e) {
      if (e.status !== 401) toast(`Couldn’t send “${name}”: ${scheduleError(e)}`, 'error');
    } finally {
      S.schedBusy.delete(key);
      loadSchedules();
    }
  }
  async function deleteSchedule(id) {
    const s = (S.scheds || []).find(x => sameId(x.id, id));
    if (!s) return;
    if (!window.confirm(`Delete the schedule for “${s.report_name || 'this report'}”? No more emails will go out on it.`)) return;
    try { await api.removeSchedule(s.id); toast('Schedule deleted.'); }
    catch (e) { if (e.status !== 401) toast(`Couldn’t delete it: ${scheduleError(e)}`, 'error'); }
    loadSchedules();
  }

  // ── The AI builder drawer ───────────────────────────────────────────
  /* custom-reports-ai.js draws the chat; this file gives it the report to
     read and change. Every change it applies is undoable, marks the report
     unsaved and redraws it. It can never switch internal data on: a
     definition it applies keeps the report's own setting, and "Turn on
     internal data…" asks through the same confirm a person answers. */
  function toggleAi(force) {
    S.ai.open = force != null ? !!force : !S.ai.open;
    syncAi();
    if (S.ai.open && S.ai.el) {
      const first = S.ai.el.querySelector('.cr-ai-body textarea, .cr-ai-body input, .cr-ai-x');
      if (first) { try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); } }
    } else if (!S.ai.open) focusFk('ai-toggle');
  }
  function syncAi() {
    if (!S.mount) return;
    const el = [...S.mount.children].find(c => c.classList && c.classList.contains('cr-ai-drawer'));
    if (!el) return;
    el.hidden = !S.ai.open;
    S.mount.classList.toggle('cr-ai-on', !!S.ai.open);
    S.mount.querySelectorAll('[data-act="ai-toggle"]').forEach(b => b.setAttribute('aria-pressed', String(!!S.ai.open)));
    // The drawer takes (or gives back) 408px of the builder: the preview is
    // fitted to its new width, not left scaled for the old one.
    if (S.view === 'edit') fitPreview();
    if (!S.ai.open) return;
    if (S.ai.el !== el) {
      el.innerHTML = `<div class="cr-ai-head"><h2>&#10024; AI Builder</h2>
        <button type="button" class="cr-ai-x" aria-label="Close the AI builder">&#10005;</button></div><div class="cr-ai-body"></div>`;
      el.querySelector('.cr-ai-x').addEventListener('click', () => toggleAi(false));
      el.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('.cr-modal')) { e.stopPropagation(); toggleAi(false); } });
      S.ai.el = el;
      S.ai.handle = null;
    }
    if (!S.ai.handle) mountAi();
    else aiSync();
  }
  // Same report, maybe not the same state: a Save As or Duplicate of a
  // read-only template makes it the user's own copy in place, and the
  // panel's controls follow.
  function aiSync() {
    const hd = S.ai && S.ai.handle;
    if (hd && typeof hd.sync === 'function') { try { hd.sync(); } catch (_) { /* the panel's problem */ } }
  }
  function mountAi() {
    const body = S.ai.el && S.ai.el.querySelector('.cr-ai-body');
    if (!body) return;
    const AI = window.FCTReportAI;
    if (!AI || typeof AI.mount !== 'function') {
      body.innerHTML = '<p class="cr-ai-missing">The AI builder is still loading — close this and try again in a moment.</p>';
      return;
    }
    body.innerHTML = '';
    try {
      S.ai.handle = AI.mount(body, aiAdapter()) || { mounted: true };
      S.ai.docRef = S.doc;
    } catch (err) {
      console.error('[custom-reports] AI builder failed to start:', err);
      body.innerHTML = '<p class="cr-ai-missing">The AI builder could not start. Refresh the page to try again.</p>';
    }
  }
  // Another report is open (or none): the conversation was about the old one.
  function aiDocChanged(force) {
    if (!force && S.ai.docRef === S.doc) return;
    S.ai.docRef = S.doc;
    if (!S.ai.handle) return;
    try { if (typeof S.ai.handle.destroy === 'function') S.ai.handle.destroy(); } catch (_) { /* gone anyway */ }
    S.ai.handle = null;
    const body = S.ai.el && S.ai.el.querySelector('.cr-ai-body');
    if (body) body.innerHTML = '';
    if (S.ai.open) mountAi();
  }
  function aiAdapter() {
    return {
      getDefinition: () => {
        if (!S.doc) return E.defaultDefinition();
        const d = E.normalizeDefinition(S.doc.def);
        d.jobs = { mode: S.doc.saveJobs ? 'saved' : 'pick', ids: S.doc.picked.slice(0, MAX_JOBS).map(String) };
        return d;
      },
      applyDefinition: (def, info) => aiApply(def, info),
      undo: () => aiUndo(),
      // Only what the builder needs to pick jobs: never a contract or cost.
      getJobs: () => projects().map(p => ({ id: String(p.id), name: jobName(p), number: txt(p['job-number']), client: txt(p.client), status: txt(p.status) })),
      getCodes: () => {
        const all = projects();
        return {
          costCodes: E.costCodesFor(all).slice(0, MAX_CODES_AI),
          subCodes: subCodesFor(all).slice(0, MAX_CODES_AI).map(x => ({ code: txt(x.code), description: txt(x.description), unit: txt(x.unit) })),
        };
      },
      get division() { return cfg.division; },
      get divisionLabel() { return txt(cfg.divisionLabel) || divLabel(); },
      get apiBase() { return cfg.apiBase || '/api'; },
      getToken: () => token(),
      onAuthError: () => {
        saveDraft();
        try { if (typeof cfg.onAuthError === 'function') cfg.onAuthError(); } catch (_) { /* the page's problem */ }
      },
      requestInternal: () => aiRequestInternal(),
      isReadOnly: () => !!(S.doc && S.doc.readOnly),
    };
  }
  const cloneJson = v => JSON.parse(JSON.stringify(v));
  // The report as an AI change left it — so Undo can tell whether anything
  // was changed by hand since, which undoing would throw away. Internal data
  // is left out: Undo never switches it back on, so turning it off loses
  // nothing, and turning it on is only ever undone the safe way.
  function aiKey(d) {
    let def;
    try { def = E.normalizeDefinition(d.def); } catch (_) { def = cloneJson(d.def || {}); }
    def.includeInternal = false;
    return JSON.stringify({ def, picked: (d.picked || []).map(String), name: d.name, saveJobs: !!d.saveJobs });
  }
  function aiApply(raw, info) {
    let next;
    try { next = E.normalizeDefinition(raw); } catch (_) { return false; }
    const cur = S.doc;
    if (cur && cur.readOnly) return false;
    // Internal data stays exactly as the person left it.
    next.includeInternal = !!(cur && cur.def.includeInternal === true);
    // Jobs only from this division's list, in the order given.
    const picked = [];
    next.jobs.ids.forEach(id => {
      const p = projectById(id);
      if (p && picked.length < MAX_JOBS && !picked.some(x => sameId(x, p.id))) picked.push(p.id);
    });
    // "Save the jobs with the report" (jobs.mode 'saved') is the step ①
    // box: the definition's mode is that, and nothing reads it but the box.
    const wantSave = next.jobs.mode === 'saved' && picked.length > 0;
    next.jobs = { mode: next.jobs.mode, ids: [] };
    if (!cur) {
      const doc = blankDoc(next, { name: txt(next.title) || 'New report', picked, saveJobs: wantSave, touched: true });
      const made = { none: true };
      doc.aiUndo = [made];
      S.ai.docRef = doc;      // the same conversation carries on with it
      startEditing(doc);
      made.after = aiKey(doc);
      return true;
    }
    cur.aiUndo = cur.aiUndo || [];
    const entry = { def: cloneJson(cur.def), picked: cur.picked.slice(), saveJobs: cur.saveJobs, saveJobsSet: cur.saveJobsSet, name: cur.name };
    cur.aiUndo.push(entry);
    if (cur.aiUndo.length > 30) cur.aiUndo.shift();
    cur.def = next;
    cur.picked = picked;
    if (wantSave !== !!cur.saveJobs) { cur.saveJobs = wantSave; cur.saveJobsSet = true; }
    if (!txt(cur.name) && txt(next.title)) cur.name = txt(next.title);
    cur.touched = true;
    S.collapsed = new Set(next.sections.map(s => s.id));
    S.view = 'edit';
    S.editLabel = null;
    render();
    entry.after = aiKey(cur);
    // Beside the builder, a toast says what happened to it. As a full-width
    // sheet (a narrow window) the panel already shows it, and a toast would
    // sit on its Send button.
    const sheet = (window.innerWidth || document.documentElement.clientWidth || 0) < AI_SHEET_BELOW;
    if (!sheet && info && Array.isArray(info.changes) && info.changes.length) toast(`AI builder: ${plural(info.changes.length, 'change')} applied. Undo is in the AI panel.`);
    return true;
  }
  function aiUndo() {
    const d = S.doc;
    if (!d || !Array.isArray(d.aiUndo) || !d.aiUndo.length) return false;
    const prev = d.aiUndo[d.aiUndo.length - 1];
    // Changed by hand since the AI change: undoing it would throw that work
    // away (there is no redo), so it is asked first — and "no" changes
    // nothing. That is the person's choice, not a failure: the panel is told
    // apart ('declined') so it reports nothing and keeps its Undo live.
    const edited = typeof prev.after === 'string' && prev.after !== aiKey(d);
    if (edited && !window.confirm(prev.none
      ? 'Undo the AI change? It built this report, so undoing it closes the report — and the edits you made since then will be lost.'
      : 'Undo the AI change? Edits you made since then will be lost.')) return 'declined';
    d.aiUndo.pop();
    if (prev.none) {
      // The AI built this report from nothing: undoing it closes it.
      clearDraft();
      S.doc = null;
      S.view = 'home';
      S.ai.docRef = null;
      render();
      return true;
    }
    const wasOn = d.def.includeInternal === true;
    d.def = prev.def;
    // Undo never switches internal data back on.
    d.def.includeInternal = wasOn && prev.def.includeInternal === true;
    d.picked = prev.picked;
    d.saveJobs = prev.saveJobs;
    if ('saveJobsSet' in prev) d.saveJobsSet = prev.saveJobsSet;
    d.name = prev.name;
    d.touched = true;
    S.collapsed = new Set(d.def.sections.map(s => s.id));
    S.view = 'edit';
    S.editLabel = null;
    render();
    return true;
  }
  function aiRequestInternal() {
    if (!S.doc) { toast('Build or open a report first, then switch internal data on.', 'error'); return false; }
    if (internalOn()) return true;
    if (S.view !== 'edit') { S.view = 'edit'; render(); }
    setInternal(true);
    return internalOn();
  }

  // ── Section and column edits ────────────────────────────────────────
  function addSection(type) {
    const def = S.doc.def;
    if (def.sections.length >= MAX_SECTIONS) { toast(`A report can have up to ${MAX_SECTIONS} sections.`, 'error'); return; }
    const s = E.newSection(type);
    if (!s) return;
    def.sections.push(s);
    S.collapsed.delete(s.id);
    changed({ panel: true });
    const el = S.mount.querySelector(`[data-fk="${type === 'notes' ? 'ntext' : 'sectitle'}-${s.id}"]`)
      || S.mount.querySelector(`[data-fk="sectitle-${s.id}"]`);
    if (el) {
      el.focus();
      if (typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ block: 'nearest' }); } catch (_) { /* fine */ } }
    }
  }
  function moveSection(id, dir) {
    const list = S.doc.def.sections;
    const i = list.findIndex(s => s.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const t = list[i]; list[i] = list[j]; list[j] = t;
    changed({ panel: true });
  }
  function removeSection(id) {
    const d = S.doc, list = d.def.sections;
    const i = list.findIndex(s => s.id === id);
    if (i < 0) return;
    const s = list[i];
    const title = txt(s.title) || E.CATALOG[s.type].label;
    list.splice(i, 1);
    changed({ panel: true });
    toast(`Removed “${title}”.`, null, {
      label: 'Undo',
      run: () => {
        if (S.doc !== d || d.def.sections.length >= MAX_SECTIONS || d.def.sections.includes(s)) return;
        d.def.sections.splice(Math.min(i, d.def.sections.length), 0, s);
        if (S.view === 'edit') changed({ panel: true });
      },
    });
  }
  function toggleColumn(secId, key, on, el) {
    const s = findSec(secId);
    if (!s) return;
    // The checkbox is disabled while locked; this is the belt to that brace,
    // for a forged event or a stale control.
    if (on && colState(s.type, key) !== 'available') { if (el) el.checked = false; return; }
    const at = s.columns.indexOf(key);
    if (on && at < 0) {
      // Back where the catalog puts it relative to the others, which is
      // where people look for it, rather than tacked on the end.
      const order = E.CATALOG[s.type].columns.map(c => c.key);
      const rank = order.indexOf(key);
      let pos = s.columns.findIndex(k => order.indexOf(k) > rank);
      if (pos < 0) pos = s.columns.length;
      s.columns.splice(pos, 0, key);
    } else if (!on && at >= 0) {
      s.columns.splice(at, 1);
    }
    changed({ panel: true });
  }
  function moveColumn(secId, key, dir) {
    const s = findSec(secId);
    if (!s) return;
    const shown = s.columns.filter(k => colState(s.type, k) === 'available');
    const i = shown.indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= shown.length) return;
    const a = s.columns.indexOf(key), b = s.columns.indexOf(shown[j]);
    s.columns[a] = shown[j];
    s.columns[b] = key;
    changed({ panel: true });
  }
  function setLabel(secId, key, value) {
    const s = findSec(secId);
    if (!s) return;
    const v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (v) s.labels[key] = v; else delete s.labels[key];
  }
  function startLabelEdit(secId, key) {
    const s = findSec(secId);
    if (!s) return;
    if (S.editLabel && S.editLabel.sec === secId && S.editLabel.key === key) { endLabelEdit(true, true); return; }
    S.editLabel = { sec: secId, key, orig: s.labels[key] || '' };
    renderPanel();
    const input = S.mount.querySelector('[data-bind="col-label"]');
    if (input) { input.focus(); try { input.select(); } catch (_) { /* fine */ } }
  }
  function endLabelEdit(keep, refocus) {
    const ed = S.editLabel;
    if (!ed) return;
    S.editLabel = null;
    if (!keep) setLabel(ed.sec, ed.key, ed.orig);
    changed({ panel: true });
    if (refocus) focusFk(`colrename-${ed.sec}-${ed.key}`);
  }
  function setOption(secId, key, el) {
    const s = findSec(secId);
    if (!s) return;
    const spec = (E.CATALOG[s.type].optionSpec || []).find(sp => sp.key === key);
    if (!spec) return;
    if (spec.kind === 'bool') s.options[key] = !!el.checked;
    else if (spec.kind === 'select' && spec.choices.some(c => c[0] === el.value)) s.options[key] = el.value;
    changed({ panel: true });
  }
  function toggleListOption(secId, key, value, on) {
    const s = findSec(secId);
    if (!s) return;
    const list = Array.isArray(s.options[key]) ? s.options[key].slice() : [];
    const at = list.indexOf(value);
    if (on && at < 0) list.push(value);
    if (!on && at >= 0) list.splice(at, 1);
    if (key === 'kinds') {
      const order = ((E.CATALOG[s.type].optionSpec || []).find(sp => sp.key === 'kinds') || { choices: [] }).choices.map(c => c[0]);
      s.options[key] = order.filter(k => list.includes(k));
    } else {
      s.options[key] = list;
    }
    changed({ panel: true });
  }
  function setInternal(on, el) {
    const def = S.doc.def;
    if (on) {
      if (perm().canSeeCosts === false) { if (el) el.checked = false; return false; }
      const note = isScheduled(S.doc) ? ' ' + SCHEDULED_NOTE : schedsUnknown() && S.doc.id != null ? ' ' + MAYBE_SCHEDULED_NOTE : '';
      if (!window.confirm(INTERNAL_CONFIRM + note)) { if (el) el.checked = false; return false; }
      def.includeInternal = true;
    } else {
      def.includeInternal = false;
    }
    changed({ panel: S.step === 2 });
    return on;
  }
  // Does a schedule send this saved report? (Only admin / level 3 can see
  // the schedules; the server stops an internal report's sends either way.)
  function isScheduled(d) {
    return !!(d && d.id != null && Array.isArray(S.scheds) && S.scheds.some(x => sameId(x.custom_report_id, d.id)));
  }
  /* What saving `def` over saved report `id` changes that a schedule can
     stop on: into fixed dates, and its kind (saved jobs or not) against the
     list's saved copy. A save that changes neither can stop no send. */
  function stopShape(id, def) {
    const saved = S.reports.find(x => sameId(x.id, id));
    let was = null;
    try { was = saved ? E.normalizeDefinition(saved.definition) : null; } catch (_) { was = null; }
    const kindOf = x => (x && x.jobs && x.jobs.mode === 'saved' && Array.isArray(x.jobs.ids) && x.jobs.ids.length ? 'report' : 'template');
    const wasKind = saved && saved.kind ? saved.kind : kindOf(was), kind = kindOf(def);
    const fixedNow = !!(def.dates && def.dates.preset === 'custom'), fixedWas = !!(was && was.dates && was.dates.preset === 'custom');
    return { fixed: fixedNow && !fixedWas, kind, wasKind };
  }
  function couldStopSend(id, def) {
    const s = stopShape(id, def);
    return s.fixed || s.kind !== s.wasKind;
  }
  /* What saving `def` over scheduled report `id` would stop, said before the
     save (as SCHEDULED_NOTE is for internal data) — or null. The run refuses
     a report set to fixed dates, a template scheduled once per job (or as
     one report) that now keeps its own jobs, and a saved-jobs report that no
     longer does. Only a change into one of these asks; one already so does
     not ask at every save. A save that makes two of them at once (fixed
     dates and the jobs) names both, and what undoes each: undoing one alone
     does not start the sends again. */
  function scheduledStops(id, def) {
    // The schedules list could not be had (waitForScheds): any change into
    // fixed dates or another kind asks, in general terms.
    const unknown = schedsUnknown() && id != null;
    if (!unknown && !isScheduled({ id })) return null;
    const scheds = unknown ? [] : S.scheds.filter(x => sameId(x.custom_report_id, id));
    const { fixed, kind, wasKind } = stopShape(id, def);
    if (unknown) {
      const how = [fixed ? 'with fixed dates' : '', kind === wasKind ? '' : kind === 'report' ? 'with its own jobs' : 'without its saved jobs'].filter(Boolean);
      return how.length ? `${schedsUnknownLead()} If one does, saved ${how.join(' and ')} its scheduled sends stop. Save anyway?` : null;
    }
    const toReport = kind !== wasKind && kind === 'report' && scheds.some(x => x.jobs_mode !== 'saved');
    const toTemplate = kind !== wasKind && kind === 'template' && scheds.some(x => x.jobs_mode === 'saved');
    if (fixed && (toReport || toTemplate)) {
      return 'This report is scheduled, and saved like this its scheduled sends stop for two reasons:\n'
        + '• with fixed dates every scheduled email would show the same days;\n'
        + (toReport ? '• saved with its own jobs, it no longer fits a schedule that sends it once per job (or as one report of every In Progress job).\n'
          : '• saved without its jobs, it no longer fits a schedule that sends its saved jobs.\n')
        + 'They start again only once it has a relative date range like Last week again '
        + (toReport ? 'and the schedule is opened and saved again' : 'and the schedule is edited to pick its jobs') + '. Save anyway?';
    }
    if (fixed) {
      return 'This report is scheduled — with fixed dates every scheduled email would show the same days, so scheduled sends will stop until it has a relative date range like Last week again. Save anyway?';
    }
    if (toReport) {
      return 'This report is scheduled to send once per job (or as one report of every In Progress job). Saved with its own jobs, those scheduled sends stop until the schedule is opened and saved again. Save anyway?';
    }
    if (toTemplate) {
      return 'This report is scheduled to send its saved jobs. Saved without them, scheduled sends stop until the schedule is edited to pick its jobs. Save anyway?';
    }
    return null;
  }

  // ── Jobs ────────────────────────────────────────────────────────────
  function jobsChanged(redrawList) {
    if (!S.doc) return;
    S.doc.touched = true;
    if (redrawList) renderJobList(); else refreshJobCount();
    updateChrome();
    schedulePreview();
  }
  function toggleJob(value, on, label) {
    const p = projects().find(x => String(x.id) === value);
    if (!p) return;
    const ids = S.doc.picked;
    const at = ids.findIndex(x => String(x) === value);
    if (on && at < 0) {
      if (ids.length >= MAX_JOBS) { toast(`A report can cover up to ${MAX_JOBS} jobs.`, 'error'); renderJobList(); return; }
      ids.push(p.id);
    } else if (!on && at >= 0) {
      ids.splice(at, 1);
    }
    if (label) label.classList.toggle('on', on);
    jobsChanged(false);
  }
  function selectJobs(list, replace) {
    const ids = replace ? [] : S.doc.picked.slice();
    const have = new Set(ids.map(String));
    list.forEach(p => { if (ids.length < MAX_JOBS && !have.has(String(p.id))) { have.add(String(p.id)); ids.push(p.id); } });
    S.doc.picked = ids;
    jobsChanged(true);
  }
  /* Client…, All In Progress and Clear replace the selection — a customer
     report should not quietly gain another client's jobs — so each says what
     it did and offers to put back the hand-picked list it replaced. */
  function replaceJobs(list, message) {
    const d = S.doc, prev = d.picked.slice();
    selectJobs(list, true);
    if (!message) return;
    toast(message, null, prev.length ? {
      label: 'Undo',
      run: () => {
        if (S.doc !== d) return;
        d.picked = prev;
        jobsChanged(true);   // redraws the list only where step ① is on screen
      },
    } : null);
  }

  // ── Event wiring ────────────────────────────────────────────────────
  // The AI drawer sits in the mount but is custom-reports-ai.js's to handle.
  const inAi = el => !!(el && el.closest && el.closest('.cr-ai-drawer'));
  function onClick(e) {
    if (inAi(e.target)) return;
    const t = e.target.closest && e.target.closest('[data-act]');
    if (!t || !S.mount || !S.mount.contains(t) || t.disabled) return;
    const act = t.getAttribute('data-act');
    const id = t.getAttribute('data-id');
    const sec = t.getAttribute('data-sec');
    const key = t.getAttribute('data-key');
    if (t.tagName === 'A') e.preventDefault();
    // Choosing from a menu hands focus back to the menu's button first, so a
    // dialog the choice opens returns focus there when it closes.
    if (!/-menu$/.test(act)) closeMenu(!!(S.menuEl && S.menuEl.contains(t)));
    const report = () => S.reports.find(x => sameId(x.id, id));
    switch (act) {
      // rail
      case 'toggle-rail': {
        S.railOpen = !S.railOpen;
        const rail = S.mount.querySelector('.cr-rail');
        if (rail) rail.classList.toggle('open', S.railOpen);
        t.setAttribute('aria-expanded', String(S.railOpen));
        t.innerHTML = railBtnText();
        if (S.railOpen) focusFk('rail-search');
        break;
      }
      case 'new': newReport(); break;
      case 'reload': loadList(); break;
      case 'open': case 'menu-open': {
        const r = report();
        if (!r) break;
        if (S.doc && S.doc.id != null && sameId(S.doc.id, r.id)) {
          if (S.view !== 'edit') { S.view = 'edit'; S.railOpen = false; render(); }
          else if (S.railOpen) { S.railOpen = false; render(); }
          break;
        }
        openSaved(r);
        break;
      }
      case 'starter': openStarter(t.getAttribute('data-starter')); break;
      case 'item-menu': itemMenu(t, id); break;
      case 'menu-duplicate': { const r = report(); if (r) duplicateReport(r); break; }
      case 'menu-rename': { const r = report(); if (r) renameReport(r); break; }
      case 'menu-delete': { const r = report(); if (r) deleteReport(r); break; }
      case 'toggle-deleted':
        S.deletedOpen = !S.deletedOpen;
        if (S.deletedOpen) loadDeleted(); else renderRail();
        break;
      case 'reload-deleted': loadDeleted(); break;
      case 'restore': restoreReport(id); break;
      case 'history':
        S.view = 'history';
        S.railOpen = false;
        render();
        loadRuns();
        break;
      case 'history-refresh': loadRuns(); break;
      case 'history-more': loadRuns(true); break;
      case 'back':
        S.view = S.doc ? 'edit' : 'home';
        render();
        break;
      // bar
      case 'save': save(); break;
      case 'save-as': saveAs(!S.doc.id); break;
      case 'print': doPrint(); break;
      case 'email': doEmail(); break;
      case 'excel': doExcel(); break;
      case 'doc-menu': docMenu(t); break;
      case 'share': setVisibility('shared'); break;
      case 'make-private': setVisibility('private'); break;
      case 'duplicate': saveAs(false, copyName(S.doc.name.trim() || S.doc.savedName || 'Untitled report', 1)); break;
      case 'delete': {
        const r = S.reports.find(x => sameId(x.id, S.doc.id)) || { id: S.doc.id, name: S.doc.savedName || S.doc.name };
        deleteReport(r);
        break;
      }
      case 'close': closeDoc(); break;
      case 'internal-off': setInternal(false); break;
      case 'jump-preview': {
        const p = S.mount.querySelector('.cr-preview');
        if (p && typeof p.scrollIntoView === 'function') { try { p.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { p.scrollIntoView(); } }
        break;
      }
      // steps
      case 'step': goStep(Number(t.getAttribute('data-step'))); break;
      case 'jobs-shown': {
        const q = S.jobSearch.trim().toLowerCase();
        const list = projects().filter(p => matchJob(p, q));
        const have = new Set(S.doc.picked.map(String));
        const adding = list.filter(p => !have.has(String(p.id))).length;
        // Every job in the division, by one click on an empty search, is
        // rarely what a customer report wants — and a slow one to preview.
        if (!q && adding > SELECT_ALL_ASK && !window.confirm(`Add all ${adding} jobs in ${divLabel()} to this report?`)) break;
        selectJobs(list, false);
        break;
      }
      case 'jobs-clear': {
        const n = S.doc.picked.length;
        replaceJobs([], n ? `Cleared ${plural(n, 'job')}.` : '');
        break;
      }
      case 'jobs-active': {
        const list = projects().filter(p => txt(p.status) === 'In Progress');
        if (!list.length) { toast('No jobs are In Progress.', 'error'); break; }
        replaceJobs(list, `Selected ${plural(list.length, 'In Progress job')}.`);
        break;
      }
      case 'zoom': setZoom(t.getAttribute('data-zoom')); break;
      case 'full-preview': openFullPreview(); break;
      case 'add-menu': addMenu(t); break;
      case 'add-section': addSection(t.getAttribute('data-type')); break;
      case 'sec-toggle':
        if (S.collapsed.has(sec)) S.collapsed.delete(sec); else S.collapsed.add(sec);
        renderPanel();
        break;
      case 'sec-up': moveSection(sec, -1); break;
      case 'sec-down': moveSection(sec, 1); break;
      case 'sec-remove': {
        const s = findSec(sec);
        if (s && s.type === 'notes' && txt(s.text) && !window.confirm('Remove this note? Its text goes with it.')) break;
        removeSection(sec);
        break;
      }
      case 'col-up': moveColumn(sec, key, -1); break;
      case 'col-down': moveColumn(sec, key, 1); break;
      case 'col-label': startLabelEdit(sec, key); break;
      case 'cc-all': {
        const s = findSec(sec);
        if (s) { s.options.costCodes = []; changed({ panel: true }); }
        break;
      }
      case 'sc-all': {
        const s = findSec(sec);
        if (s) { s.options[key || 'subCodes'] = []; changed({ panel: true }); }
        break;
      }
      // the report-wide filter
      case 'filter-remove': toggleFilter(t.getAttribute('data-kind') === 'cc' ? 'cc' : 'sc', t.getAttribute('data-value'), false); break;
      case 'filters-clear': {
        const f = curFilters();
        const prev = { costCodes: f.costCodes.slice(), subCodes: f.subCodes.slice() };
        const d = S.doc;
        f.costCodes = []; f.subCodes = [];
        renderFilters();
        changed();
        focusFk('filter-search');
        toast('Cleared the code filter.', null, { label: 'Undo', run: () => { if (S.doc !== d) return; d.def.filters = prev; if (S.view === 'edit') { renderFilters(); changed(); } } });
        break;
      }
      // contacts, customer history
      case 'job-contacts': e.preventDefault(); openContacts(id); break;
      case 'contacts': openContacts(); break;
      case 'ct-refresh': loadContacts(true); break;
      case 'ct-add': editContact(null); break;
      case 'ct-edit': editContact(id); break;
      case 'ct-cancel': S.contactEdit = null; renderView(); focusFk('ct-add'); break;
      case 'ct-save': saveContact(); break;
      case 'ct-delete': deleteContact(id); break;
      case 'customer': openCustomer(id != null ? id : undefined); break;
      case 'cust-refresh': loadCustomer(false); break;
      case 'cust-more': loadCustomer(true); break;
      case 'cust-open': custOpen(id); break;
      case 'cust-resend': custResend(id); break;
      case 'cust-builder': custBuilder(id); break;
      // schedules
      case 'schedule': {
        const why = scheduleBlock(S.doc);
        if (why) { toast(why, 'error'); break; }
        openSchedule(S.doc.id);
        break;
      }
      case 'menu-schedule': {
        const r = report();
        if (!r) break;
        if (r.customer_safe === false) { toast('Only customer-safe reports can be scheduled — switch internal data off and save.', 'error'); break; }
        openSchedule(r.id);
        break;
      }
      case 'sched-menu': schedMenu(t, id); break;
      case 'sched-toggle': toggleSchedule(id); break;
      case 'sched-edit': {
        const s = (S.scheds || []).find(x => sameId(x.id, id));
        if (s && !schedSavingOut(s.id)) openSchedule(s.custom_report_id, s);
        break;
      }
      case 'sched-send': sendScheduleNow(id); break;
      case 'sched-delete': deleteSchedule(id); break;
      case 'reload-schedules': loadSchedules(); break;
      // the AI builder
      case 'ai-toggle': toggleAi(); break;
      default: break;
    }
  }

  function onChange(e) {
    const el = e.target;
    if (inAi(el)) return;
    const bind = el && el.getAttribute && el.getAttribute('data-bind');
    if (!bind) return;
    // The history and contacts views work with no report open.
    switch (bind) {
      case 'cust-job': S.cust.jobId = el.value; S.cust.runs = null; S.cust.next = null; S.cust.error = ''; renderView(); if (el.value) loadCustomer(false); return;
      case 'cust-client': S.cust.client = el.value; renderView(); return;
      case 'ct-job': S.contactsJob = el.value; renderView(); return;
      case 'ct-auto': setContactAuto(el.getAttribute('data-id'), !!el.checked, el); return;
      case 'ct-field': setContactField(el); return;
      default: break;
    }
    if (!S.doc) return;
    const def = S.doc.def;
    const sec = el.getAttribute('data-sec');
    switch (bind) {
      case 'job': toggleJob(el.value, el.checked, el.closest('.cr-job')); break;
      case 'jobs-client': {
        const c = el.value;
        el.value = '';
        if (!c) break;
        const list = projects().filter(p => txt(p.client) === c);
        replaceJobs(list, `Selected ${plural(list.length, 'job')} for ${c}.`);
        break;
      }
      case 'preset': {
        // Switching to a custom range starts from the dates just shown, so
        // "last week but one more day" is a nudge rather than two date picks.
        if (el.value === 'custom' && !def.dates.from && !def.dates.to) {
          const r = E.resolveDateRange(def.dates);
          def.dates.from = r.from;
          def.dates.to = r.to;
        }
        def.dates.preset = el.value;
        changed({ panel: true });
        break;
      }
      case 'from': case 'to': def.dates[bind] = el.value; changed(); break;
      case 'layout': def.layout = el.value === 'combined' ? 'combined' : 'separate'; changed({ panel: true }); break;
      case 'pagebreak': def.pageBreakPerJob = !!el.checked; changed(); break;
      case 'orientation': def.orientation = el.value === 'landscape' ? 'landscape' : 'portrait'; changed(); break;
      case 'save-jobs': S.doc.saveJobs = !!el.checked; S.doc.saveJobsSet = true; changed({ preview: false }); break;
      case 'internal': setInternal(!!el.checked, el); break;
      case 'col': toggleColumn(sec, el.getAttribute('data-key'), !!el.checked, el); break;
      case 'opt': setOption(sec, el.getAttribute('data-key'), el); break;
      case 'opt-kind': toggleListOption(sec, 'kinds', el.getAttribute('data-value'), !!el.checked); break;
      case 'opt-cc': toggleListOption(sec, 'costCodes', el.getAttribute('data-value'), !!el.checked); break;
      case 'opt-sc': toggleListOption(sec, el.getAttribute('data-key') || 'subCodes', el.getAttribute('data-value'), !!el.checked); break;
      case 'filter-sc': toggleFilter('sc', el.value, !!el.checked); break;
      case 'filter-cc': toggleFilter('cc', el.value, !!el.checked); break;
      case 'h-showGenerated': def.header.showGenerated = !!el.checked; changed(); break;
      case 'h-showPmContact': def.header.showPmContact = !!el.checked; changed(); break;
      case 'h-branding': def.header.branding = el.value === 'datawatch' ? 'datawatch' : 'company'; changed(); break;
      default: break;
    }
  }

  function onInput(e) {
    const el = e.target;
    if (inAi(el)) return;
    const bind = el && el.getAttribute && el.getAttribute('data-bind');
    if (!bind) return;
    if (bind === 'rail-search') { S.search = el.value; renderRail(); return; }
    if (bind === 'cust-search') {
      S.cust.search = el.value;
      const sel = S.mount.querySelector('[data-bind="cust-job"]');
      if (sel) sel.innerHTML = customerJobOptions();
      return;
    }
    if (bind === 'ct-search') {
      S.contactsSearch = el.value;
      const list = S.mount.querySelector('.cr-ct-list');
      if (list) list.innerHTML = contactListHtml();
      return;
    }
    if (bind === 'ct-field') { if (el.tagName !== 'SELECT' && el.type !== 'checkbox') setContactField(el); return; }
    if (!S.doc) return;
    S.lastTypeAt = Date.now();
    const def = S.doc.def;
    const sec = el.getAttribute('data-sec');
    switch (bind) {
      case 'job-search': S.jobSearch = el.value; renderJobList(); break;
      case 'name': S.doc.name = el.value; changed(); break;
      case 'title': def.title = el.value; changed(); break;
      case 'description': S.doc.description = el.value; changed({ preview: false }); break;
      case 'h-preparedFor': case 'h-preparedBy': case 'h-intro': case 'h-footer':
      case 'h-contactName': case 'h-contactPhone': case 'h-contactEmail':
        def.header[bind.slice(2)] = el.value;
        changed();
        break;
      case 'filter-search': S.filterSearch = el.value; renderFilters(true); break;
      case 'sec-title': { const s = findSec(sec); if (s) { s.title = el.value; changed(); } break; }
      case 'sec-text': { const s = findSec(sec); if (s) { s.text = el.value; changed(); } break; }
      case 'col-label': setLabel(sec, el.getAttribute('data-key'), el.value); changed(); break;
      default: break;
    }
  }

  function onKeydown(e) {
    const el = e.target;
    if (inAi(el)) return;
    const bind = el && el.getAttribute && el.getAttribute('data-bind');
    if (bind === 'col-label') {
      if (e.key === 'Enter') { e.preventDefault(); endLabelEdit(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endLabelEdit(false, true); }
      return;
    }
    if (bind === 'name' && e.key === 'Enter') { e.preventDefault(); el.blur(); return; }
    if (bind === 'ct-field' && e.key === 'Enter' && el.tagName === 'INPUT') { e.preventDefault(); saveContact(); return; }
    if (bind === 'ct-field' && e.key === 'Escape') { e.preventDefault(); S.contactEdit = null; renderView(); return; }
    // Menus: arrows move, Escape closes back onto the button.
    if (S.menuEl && S.menuEl.contains(el)) {
      const items = [...S.menuEl.querySelectorAll('[role="menuitem"]')];
      const i = items.indexOf(el);
      let n = -1;
      if (e.key === 'ArrowDown') n = (i + 1) % items.length;
      else if (e.key === 'ArrowUp') n = (i - 1 + items.length) % items.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = items.length - 1;
      else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); return; }
      else if (e.key === 'Tab') { closeMenu(false); return; }
      if (n >= 0) { e.preventDefault(); items[n].focus(); }
      return;
    }
    if (e.key === 'Escape' && S.menuEl) { e.preventDefault(); closeMenu(true); return; }
    // The step strip is a tab list: arrows move between the steps.
    if (el.classList && el.classList.contains('cr-step') && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) {
      e.preventDefault();
      const n = e.key === 'Home' ? 1 : e.key === 'End' ? 3 : Math.min(3, Math.max(1, S.step + (e.key === 'ArrowRight' ? 1 : -1)));
      goStep(n);
      focusFk(`step-${n}`);
    }
  }

  function onFocusOut(e) {
    const el = e.target;
    if (inAi(el)) return;
    // A slow preview held back while typing draws as soon as the box is left.
    if (S.pvTimer && S.lastBuildMs >= SLOW_BUILD_MS && el && el.getAttribute && el.getAttribute('data-bind')) {
      setTimeout(() => { if (S.pvTimer && !typingInBuilder()) schedulePreview(true); }, 0);
    }
    if (!el || !el.getAttribute || el.getAttribute('data-bind') !== 'col-label' || !S.editLabel) return;
    // Clicking away from the label box keeps what was typed.
    setTimeout(() => {
      const a = document.activeElement;
      if (S.editLabel && !(a && a.getAttribute && a.getAttribute('data-bind') === 'col-label')) endLabelEdit(true, false);
    }, 0);
  }

  const wired = new WeakSet();
  function wire(mount) {
    if (wired.has(mount)) return;
    wired.add(mount);
    mount.addEventListener('click', onClick);
    mount.addEventListener('change', onChange);
    mount.addEventListener('input', onInput);
    mount.addEventListener('keydown', onKeydown);
    mount.addEventListener('focusout', onFocusOut);
  }

  // The tab's panel is display:none while another sub-tab is up; Ctrl+S
  // there belongs to whatever is on screen, not to a hidden report.
  function tabVisible() {
    if (!S.mount || !S.mount.isConnected) return false;
    const panel = S.mount.closest('.tab-panel');
    return panel ? panel.classList.contains('active') : true;
  }
  let globalWired = false;
  function wireGlobal() {
    if (globalWired) return;
    globalWired = true;
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 's') return;
      if (!S.doc || S.view !== 'edit' || !tabVisible() || document.querySelector('.cr-modal')) return;
      e.preventDefault();
      if (S.editLabel) endLabelEdit(true, false);
      save();
    });
    document.addEventListener('click', e => {
      if (!S.menuEl) return;
      if (S.menuEl.contains(e.target) || (S.menuTrigger && S.menuTrigger.contains(e.target))) return;
      closeMenu();
    });
    // Menus are position:fixed, so a page scroll would leave one floating
    // away from its button. Scrolling inside the menu itself is fine.
    window.addEventListener('resize', () => { closeMenu(); if (S.view === 'edit') fitPreview(); });
    // Switch Division, Sign Out, a refresh, closing the tab: the browser asks
    // before an unsaved report goes with the page, as the pages already do
    // for daily rows still being written.
    window.addEventListener('beforeunload', e => {
      if (S.reloading) return;   // the work is in the draft; the reload was asked for
      if (!S.doc || !(hasUnsavedWork() || (S.saving && changedSinceSent(S.doc)))) return;
      e.preventDefault();
      e.returnValue = '';
    });
    document.addEventListener('scroll', e => {
      if (S.menuEl && !(e.target && e.target.nodeType === 1 && S.menuEl.contains(e.target))) closeMenu();
    }, true);
  }

  // ── Public entry points ─────────────────────────────────────────────
  function configure(c) {
    c = c || {};
    const prev = cfg.division;
    cfg = Object.assign(defaults(), c);
    cfg.perm = Object.assign({}, c.perm || {});
    cfg.helpers = Object.assign({}, c.helpers || {});
    if (S.configured && prev !== cfg.division) {
      // Another division's reports, open report, contacts, history and
      // schedules do not belong here.
      Object.assign(S, { reports: [], loaded: false, loadError: '', deleted: null, runs: null, doc: null, view: 'home', me: null,
        contacts: null, contactsAt: 0, contactsCanEdit: false, contactEdit: null, contactsJob: '', contactsSearch: '',
        cust: { jobId: '', client: '', search: '', runs: null, loading: false, error: '', next: null, more: false, busy: null },
        scheds: null, canSchedule: false, schedGroups: null, filterSearch: '' });
      // The AI conversation was about the other division's jobs.
      aiDocChanged(true);
    }
    if (!S.loaded) S.canShare = cfg.perm.canShare === true;
    if (!S.readyDone) S.readyP = null;
    try { S.zoom = localStorage.getItem(ZOOM_KEY) === '100' ? '100' : 'fit'; } catch (_) { S.zoom = 'fit'; }
    S.configured = true;
  }

  function renderTab(mountEl) {
    if (!mountEl) return;
    E = window.FCTReportEngine || null;
    if (!E) {
      // The two files are deferred in order, so this is rare; but a page that
      // opens the tab while the engine is still downloading should wait for
      // it rather than break.
      clearTimeout(S.engineTimer);
      if (S.engineTries++ >= ENGINE_TRIES) {
        S.engineTries = 0;
        mountEl.innerHTML = '<div style="padding:1rem;opacity:.75">Custom Reporting could not load. Refresh the page to try again.</div>';
        return;
      }
      mountEl.innerHTML = '<div style="padding:1rem;opacity:.75">Custom Reporting is still loading…</div>';
      S.engineTimer = setTimeout(() => renderTab(mountEl), 200);
      return;
    }
    clearTimeout(S.engineTimer);
    S.engineTries = 0;
    S.mount = mountEl;
    injectStyles();
    wire(mountEl);
    wireGlobal();
    render();
    readyPromise();
    // What the reports are dressed with, and the contacts behind the badges.
    loadBranding();
    loadPeople();
    loadContacts();
    // A report kept when the last session ended is offered back once the
    // list is in (so a saved one is matched to its saved copy).
    const p = loadList();
    Promise.resolve(p).then(() => { if (S.canShare) loadSchedules(); });
    if (!S.doc && readDraft()) Promise.resolve(p).then(() => { if (!S.doc && S.mount && S.mount.isConnected) offerDraft(); });
  }

  window.FCTCustomReports = {
    configure,
    renderTab,
    _internals: { state: () => S, api },
  };
})();
