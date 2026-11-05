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
  const READY_WAIT_MS = 20000;    // longest a print / email / download waits for old daily rows
  const ENGINE_TRIES  = 50;       // × 200 ms — the deferred engine normally arrives first
  const MAX_JOBS      = 500;      // what the API will log against one run
  const MAX_SECTIONS  = 20;       // what normalizeDefinition keeps
  const SHEET_PX      = { portrait: 816, landscape: 1056 };   // a letter sheet, 96 px to the inch
  const MIN_FIT       = 0.55;     // below this a scaled page is too small to read

  const INTERNAL_CONFIRM = 'This report will be able to show costs, rates, hours, employee names and profit. '
    + "Don't send it to a customer. Continue?";

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
    view: 'home',                 // 'home' | 'edit' | 'history'
    reports: [], loaded: false, loading: false, loadError: '', loadP: null,
    canShare: false, me: null,
    deleted: null, deletedOpen: false, deletedLoading: false, deletedError: '',
    runs: null, runsLoading: false, runsError: '',
    search: '', railOpen: false,
    doc: null,                    // the report in the builder — see blankDoc()
    step: 1,
    collapsed: new Set(),         // section ids folded shut in step 2
    jobSearch: '',
    editLabel: null,              // { sec, key, orig } while a column label is being renamed
    saving: false,
    readyP: null, readyDone: false,
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
  async function request(method, params, body) {
    const qs = new URLSearchParams();
    qs.set('division', cfg.division);
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
    let r;
    try { r = await fetch(`${base}/custom-reports?${qs.toString()}`, init); }
    catch (_) { throw failure('Could not reach the server — check the connection and try again.', 0, null); }
    let data = null;
    try { data = await r.json(); } catch (_) { data = null; }
    if (r.status === 401) {
      try { if (typeof cfg.onAuthError === 'function') cfg.onAuthError(); } catch (_) { /* the page's problem */ }
      throw failure('Your session has expired. Please sign in again.', 401, data);
    }
    if (!r.ok) throw failure((data && data.error) || `Request failed (${r.status})`, r.status, data);
    return data || {};
  }
  const api = {
    request,
    list:    () => request('GET'),
    deleted: () => request('GET', { deleted: 1 }),
    runs:    reportId => request('GET', { runs: 1, report_id: reportId }),
    create:  body => request('POST', null, body),
    update:  (id, body) => request('PUT', { id }, body),
    remove:  id => request('DELETE', { id }),
    restore: id => request('POST', { action: 'restore', id }),
    run:     body => request('POST', { action: 'run' }, body),
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
        if (S.doc && S.view === 'edit') schedulePreview(true);
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
  function okToLeave() {
    if (!hasUnsavedWork()) return true;
    const name = S.doc.name.trim() || S.doc.savedName || 'this report';
    return window.confirm(`You have unsaved changes to "${name}". Discard them?`);
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
    if (!txt(d.header.preparedBy)) d.header.preparedBy = userName();
    return d;
  }
  function buildCurrent(opts) {
    const def = renderDefinition();
    const ctx = E.makeContext(def, cfg, {
      pickedIds: S.doc.picked.slice(0, MAX_JOBS),
      reportName: S.doc.name.trim() || S.doc.savedName || '',
      userName: userName(),
    });
    const html = opts && opts.html === false ? '' : E.buildReportHtml(def, ctx);
    return { def, ctx, html };
  }

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
.cr-menu{position:fixed;z-index:${Z - 10};min-width:13rem;max-width:min(24rem,calc(100vw - 1.5rem));max-height:min(70vh,30rem);overflow-y:auto;background:var(--surface2,#1a1a26);border:1px solid var(--border,#2a2a3a);border-radius:6px;box-shadow:0 12px 32px rgba(0,0,0,.6);padding:.3rem;display:flex;flex-direction:column}
.cr-menu-item{display:flex;flex-direction:column;gap:.12rem;text-align:left;background:none;border:0;color:var(--text,#e0e0e0);font:inherit;font-size:.8rem;padding:.45rem .6rem;border-radius:4px;cursor:pointer}
.cr-menu-item:hover,.cr-menu-item:focus{background:var(--border,#2a2a3a);outline:none}
.cr-menu-item.danger{color:#fca5a5}
.cr-menu-item b{font-weight:600}
.cr-menu-item small{font-size:.7rem;opacity:.65;line-height:1.35}
/* send history */
.cr-hist-head{display:flex;align-items:center;gap:.7rem;flex-wrap:wrap;margin-bottom:.4rem}
.cr-tablewrap{overflow-x:auto;border:1px solid var(--crb);border-radius:6px;background:var(--crs);margin-top:.6rem}
.cr-table{width:100%;border-collapse:collapse;font-size:.78rem}
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

  function render() {
    if (!S.mount || !E) return;
    closeMenu();
    withFocus(S.mount, () => {
      S.mount.innerHTML = `<div class="cr-root">
        <button type="button" class="btn btn-ghost cr-railbtn" data-act="toggle-rail" data-fk="toggle-rail" aria-controls="cr-rail" aria-expanded="${S.railOpen}">${railBtnText()}</button>
        <aside class="cr-rail${S.railOpen ? ' open' : ''}" id="cr-rail" aria-label="Saved reports">${railHtml()}</aside>
        <div class="cr-main"><div class="cr-view">${viewHtml()}</div></div>
      </div>`;
    });
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
    const starters = E.STARTERS.filter(s => hit(s.name, s.blurb));
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
        <h3 class="cr-group-h"><span>Starter Templates</span><span>${starters.length}</span></h3>
        ${starters.length ? starters.map(starterItemHtml).join('') : none('No match.')}
      </div>
      <div class="cr-group">
        <button type="button" class="cr-group-toggle" data-act="toggle-deleted" data-fk="toggle-deleted"
          aria-expanded="${S.deletedOpen}" aria-controls="cr-deleted">${S.deletedOpen ? '&#9662;' : '&#9656;'} Recently Deleted</button>
        <div id="cr-deleted"${S.deletedOpen ? '' : ' hidden'}>${S.deletedOpen ? deletedHtml() : ''}</div>
      </div>
      <button type="button" class="btn btn-ghost cr-histlink" data-act="history" data-fk="history">&#128337; Send History</button>`;
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
    const cards = E.STARTERS.map(st => {
      const secs = st.definition.sections.map(s => (E.CATALOG[s.type] || {}).label).filter(Boolean).join(' · ');
      return `<button type="button" class="cr-card" data-act="starter" data-starter="${esc(st.id)}" data-fk="card-${esc(st.id)}">
        <span class="cr-card-name">${esc(st.name)}${st.internal ? badge('&#128274; Internal', 'internal') : ''}</span>
        <span class="cr-card-blurb">${esc(st.blurb)}</span>
        <span class="cr-card-secs">${esc(secs)}</span>
      </button>`;
    }).join('');
    return `<div class="cr-home">
      <h2 class="cr-h2">Custom Reporting</h2>
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
          <div class="cr-preview-head"><span class="cr-preview-title">Live preview</span><span class="cr-preview-note" aria-live="polite"></span></div>
          <div class="cr-preview-hint" hidden></div>
          <div class="cr-frame-wrap"><iframe class="cr-frame" sandbox="allow-same-origin" title="Report preview — exactly what will print"></iframe></div>
        </section>
      </div>
    </div>`;
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
        <button type="button" class="btn btn-ghost" data-act="doc-menu" data-fk="doc-menu" aria-haspopup="menu" aria-expanded="false" aria-label="More actions" title="More actions">&#8943;</button>
      </div>`;
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
    const hidden = E.hiddenFinancialCount(d.def, perm());
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
      save.disabled = S.saving || d.readOnly || !dirty;
      save.textContent = S.saving ? 'Saving…' : 'Save';
      save.title = d.readOnly ? 'Only an admin or level 3 user can change a shared template — use Save As'
        : !dirty ? 'No changes to save'
        : d.visibility === 'shared' ? 'Save — updates the template for everyone in the division (Ctrl+S)'
        : 'Save (Ctrl+S)';
    }
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
      </fieldset>
      <label class="cr-check cr-savejobs"><input type="checkbox" data-bind="save-jobs" data-fk="save-jobs"${d.saveJobs ? ' checked' : ''}>
        <span><b>Save these jobs with the report</b>
        <span class="cr-hint">Leave it off to keep the report a template — it opens with no jobs and you pick them each time you run it.</span></span></label>`;
  }
  function jobCountHtml() {
    const n = currentJobs().length;
    return n ? `${plural(n, 'job')} selected` : 'No jobs selected';
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
    if (!all.length) return '<p class="cr-empty" style="padding:.7rem">No jobs in this division yet.</p>';
    const q = S.jobSearch.trim().toLowerCase();
    const picked = new Set(S.doc.picked.map(String));
    const shown = all.filter(p => matchJob(p, q));
    if (!shown.length) return `<p class="cr-empty" style="padding:.7rem">No jobs match “${esc(S.jobSearch.trim())}”.</p>`;
    return shown.map(p => {
      const id = String(p.id), on = picked.has(id);
      const meta = [txt(p['job-number']) ? '#' + txt(p['job-number']) : '', txt(p.status), txt(p.client)].filter(Boolean).join(' · ');
      return `<label class="cr-job${on ? ' on' : ''}">
        <input type="checkbox" data-bind="job" value="${esc(id)}"${on ? ' checked' : ''}>
        <span class="cr-job-name">${esc(jobName(p))}</span>${meta ? `<span class="cr-job-meta">${esc(meta)}</span>` : ''}
      </label>`;
    }).join('');
  }
  function renderJobList() {
    if (!S.mount) return;
    const list = S.mount.querySelector('.cr-joblist');
    if (list) list.innerHTML = jobListHtml();
    refreshJobCount();
  }
  function refreshJobCount() {
    const c = S.mount && S.mount.querySelector('.cr-count');
    if (c) c.textContent = jobCountHtml();
    const w = S.mount && S.mount.querySelector('.cr-jobwarn');
    if (w) w.innerHTML = clientWarnHtml();
    const call = S.mount && S.mount.querySelector('.cr-callout');
    if (call && S.doc && S.doc.picked.length) call.hidden = true;
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
    const cols = E.effectiveColumns(s, S.doc.def, perm());
    if (!cols.length) return 'No columns that can print — expand to choose some';
    return `${plural(cols.length, 'column')}: ${cols.map(c => c.label).join(', ')}`;
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
    const def = S.doc.def, p = perm();
    const cat = E.CATALOG[s.type];
    const byKey = {};
    cat.columns.forEach(c => { byKey[c.key] = c; });
    const st = k => E.columnState(s.type, k, def, p);
    const chosen = s.columns.filter(k => byKey[k] && st(k) === 'available');
    const more = cat.columns.filter(c => !s.columns.includes(c.key) && st(c.key) === 'available');
    const locked = cat.columns.filter(c => st(c.key) === 'locked');
    let html = '<div class="cr-cols" role="group" aria-label="Columns">';
    html += `<div class="cr-subhead">${s.type === 'job_info' || s.type === 'summary_kpis' ? 'Showing' : 'Columns, in printed order'}</div>`;
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
    if (sp.kind === 'costCodes') return costCodesHtml(s, sp);
    return '';
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
    const me = userName();
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
          placeholder="e.g. Questions? Call the office."></div>
      <label class="cr-check"><input type="checkbox" data-bind="h-showGenerated" data-fk="h-showGenerated"${h.showGenerated ? ' checked' : ''}>
        <span>Show when the report was generated</span></label>
      <h3 class="cr-h3">Notes sections</h3>
      ${notes.length ? notes.map(s => `<div class="cr-field">${notesEditorHtml(s, true)}</div>`).join('')
        : '<p class="cr-empty">No notes yet. A note prints as its own section, in the order set in step &#9313;.</p>'}
      <button type="button" class="btn btn-ghost cr-sm" data-act="add-section" data-type="notes" data-fk="add-note"${full ? ' disabled' : ''}>+ Add a note</button>`;
  }

  // ── Live preview ────────────────────────────────────────────────────
  // The exact print document in a sandboxed frame (no scripts run in it).
  // Redrawn a beat after the last change so typing does not rebuild a
  // twenty-job report on every keystroke.
  function schedulePreview(now) {
    if (!S.doc) return;
    clearTimeout(S.pvTimer);
    S.pvTimer = setTimeout(renderPreview, now ? 0 : PREVIEW_DELAY);
  }
  function renderPreview() {
    clearTimeout(S.pvTimer);
    S.pvTimer = 0;
    if (!S.mount || !S.doc || S.view !== 'edit') return;
    const frame = S.mount.querySelector('.cr-frame');
    const hint = S.mount.querySelector('.cr-preview-hint');
    const note = S.mount.querySelector('.cr-preview-note');
    if (!frame) return;
    let built;
    try { built = buildCurrent(); }
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
     the pane (its own small-screen rule) and a wide table scrolls inside it. */
  function fitPreview() {
    const frame = S.mount && S.mount.querySelector('.cr-frame');
    const wrap = frame && frame.parentElement;
    if (!frame || !wrap || !S.doc) return;
    const sheet = SHEET_PX[S.doc.def.orientation === 'landscape' ? 'landscape' : 'portrait'];
    const avail = wrap.clientWidth, tall = wrap.clientHeight;
    const k = avail / sheet;
    if (!avail || !tall || k >= 1 || k < MIN_FIT) {
      frame.classList.remove('paged');
      frame.style.width = frame.style.height = frame.style.transform = '';
      return;
    }
    frame.classList.add('paged');
    frame.style.width = sheet + 'px';
    frame.style.height = Math.ceil(tall / k) + 'px';
    frame.style.transform = `scale(${k.toFixed(4)})`;
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
    if (h && top + h > vh - 8 && r.top - h - 4 > 8) top = r.top - h - 4;
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
  function modal(title, bodyHtml, onDismiss) {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'cr-modal';
    back.innerHTML = `<div class="cr-modal-box" role="dialog" aria-modal="true" aria-labelledby="cr-modal-title">
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
    // selection dragged out of the name box does not dismiss the dialog.
    let pressedBack = false;
    back.addEventListener('mousedown', e => { pressedBack = e.target === back; });
    back.addEventListener('click', e => { if (e.target === back && pressedBack) close(); });
    return { el: back, body: back.querySelector('.cr-modal-body'), close };
  }

  /* Ask for a report name (and, for an admin / level 3, whether to share it).
     o.onSubmit({ name, shared }) does the save and returns an error message
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
        <p class="cr-m-err" role="alert" hidden></p>
        <div class="cr-m-btns">
          <button type="button" class="btn btn-ghost" data-m="cancel">Cancel</button>
          <button type="button" class="btn btn-green" data-m="ok">${esc(o.confirmLabel || 'Save')}</button>
        </div>`, () => resolve(false));
      const input = m.body.querySelector('#cr-m-name');
      const share = m.body.querySelector('#cr-m-share');
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
        try { msg = await o.onSubmit({ name, shared: !!(share && share.checked) }); }
        catch (e) { msg = e && e.message ? e.message : 'Something went wrong.'; }
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
    if (i >= 0) S.reports[i] = r; else S.reports.unshift(r);
    sortReports();
  }
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
  function loadRuns() {
    S.runsLoading = true;
    S.runsError = '';
    if (S.view === 'history') renderView();
    return api.runs().then(data => {
      S.runs = Array.isArray(data.runs) ? data.runs : [];
    }, err => {
      S.runsError = err.message;
    }).then(() => {
      S.runsLoading = false;
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
    render();
    const name = S.mount && S.mount.querySelector('.cr-edit');
    if (name && typeof name.scrollIntoView === 'function' && (window.innerWidth || 1200) < 900) {
      try { name.scrollIntoView({ block: 'start' }); } catch (_) { /* fine */ }
    }
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
  function openStarter(id) {
    const st = E.STARTERS.find(s => s.id === id);
    if (!st) return;
    if (S.doc && !S.doc.id && S.doc.starterId === id && !S.doc.touched && S.view === 'edit') { S.railOpen = false; render(); return; }
    if (!okToLeave()) return;
    startEditing(blankDoc(JSON.parse(JSON.stringify(st.definition)), { starterId: st.id, name: st.name }));
  }
  function newReport() {
    if (!okToLeave()) return;
    startEditing(blankDoc(E.defaultDefinition()));
  }
  function closeDoc() {
    if (!okToLeave()) return;
    S.doc = null;
    S.view = 'home';
    render();
  }

  // ── Saving ──────────────────────────────────────────────────────────
  // The server's copy is now the clean one; the editor carries on with the
  // same definition and the list shows the new name, badges and time.
  function adoptSaved(report) {
    const d = S.doc;
    d.id = report.id;
    d.starterId = null;
    d.version = report.version;
    d.visibility = report.visibility;
    d.can_edit = !!report.can_edit;
    d.readOnly = !report.can_edit;
    d.owner_username = report.owner_username || d.owner_username;
    d.updated_by_username = report.updated_by_username || '';
    d.updated_at = report.updated_at || null;
    d.name = report.name;
    d.description = report.description || '';
    d.missing = 0;
    markClean(d);
    upsertReport(report);
    const input = S.mount && S.mount.querySelector('[data-bind="name"]');
    if (input && input.value !== d.name) input.value = d.name;
    renderRail();
    updateChrome();
  }

  async function save() {
    const d = S.doc;
    if (!d || S.saving) return;
    if (!d.id) { await saveAs(true); return; }
    if (d.readOnly) {
      toast('Only an admin or level 3 user can change a shared template — Save As to make your own copy.', 'error');
      return;
    }
    if (!isDirty()) return;
    const name = d.name.trim() || d.savedName;
    S.saving = true;
    updateChrome();
    let err = null;
    try {
      const res = await api.update(d.id, { name, description: txt(d.description) || null, definition: defForSave(), version: d.version });
      if (S.doc === d) { adoptSaved(res.report); toast(`Saved “${res.report.name}”.`); }
    } catch (e) { err = e; }
    S.saving = false;
    updateChrome();
    if (!err || S.doc !== d) return;
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
    if (!d) return false;
    const def = defForSave();
    const current = d.name.trim() || txt(E.normalizeDefinition(d.def).title);
    // A name already typed into the bar is the name they want; otherwise a
    // copy of a saved report is offered as "… (copy)".
    const retyped = d.id && d.name.trim() && d.name.trim() !== d.savedName;
    const name = defaultName || (fresh || !d.id || retyped ? (current || 'Untitled report') : copyName(current || d.savedName || 'Untitled report', 1));
    return askName({
      title: fresh || !d.id ? 'Save report' : 'Save as a new report',
      name,
      offerShare: S.canShare,
      shared: false,
      onSubmit: async ({ name: chosen, shared }) => {
        try {
          const res = await api.create({ name: chosen, description: txt(d.description) || null, visibility: shared ? 'shared' : 'private', definition: def });
          if (S.doc === d) adoptSaved(res.report); else upsertReport(res.report);
          toast(shared ? `Saved “${res.report.name}” and shared it with the division.` : `Saved “${res.report.name}”.`);
          return null;
        } catch (e) {
          if (e.status === 409 && code(e) === 'name_taken') {
            return shared ? `There is already a shared template called “${chosen}”. Pick a different name.`
              : `You already have a report called “${chosen}”. Pick a different name.`;
          }
          if (e.status === 403) return 'Only an admin or level 3 user can share a report with the division. Untick “Share with division” to save it for yourself.';
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

  async function setVisibility(vis) {
    const d = S.doc;
    if (!d || !d.id) return;
    if (vis === 'shared' && !window.confirm(`Share “${d.savedName}” with everyone in ${divLabel()}? They will be able to run it; only admins and level 3 users can change it.`)) return;
    try {
      const res = await api.update(d.id, { visibility: vis, version: d.version });
      if (S.doc !== d) { upsertReport(res.report); return; }
      // Only the visibility changed on the server; any unsaved edits stay
      // unsaved, against the new version.
      d.version = res.report.version;
      d.visibility = res.report.visibility;
      d.can_edit = !!res.report.can_edit;
      d.readOnly = !res.report.can_edit;
      upsertReport(res.report);
      renderRail();
      updateChrome();
      toast(vis === 'shared' ? 'Shared with the division.' : 'Made private.');
    } catch (e) {
      if (e.status === 409 && code(e) === 'version_conflict') { await onConflict(e.data && e.data.report); return; }
      if (e.status === 409 && code(e) === 'name_taken') {
        toast(vis === 'shared' ? 'There is already a shared template with this name. Rename it first.' : 'The owner already has a private report with this name. Rename it first.', 'error');
        return;
      }
      if (e.status !== 401) toast(`Couldn’t change sharing: ${e.message}`, 'error');
    }
  }

  async function renameReport(r) {
    const open = S.doc && S.doc.id != null && sameId(S.doc.id, r.id) ? S.doc : null;
    await askName({
      title: 'Rename report', name: r.name, confirmLabel: 'Rename',
      onSubmit: async ({ name }) => {
        if (name === r.name) return null;
        try {
          const res = await api.update(r.id, { name, version: open ? open.version : r.version });
          upsertReport(res.report);
          if (open && S.doc === open) {
            // Keep any unsaved edits; only the stored name and version moved.
            const typed = open.name.trim() !== open.savedName;
            open.version = res.report.version;
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
            if (e.data && e.data.report) upsertReport(e.data.report);
            renderRail();
            return 'Someone else changed this report a moment ago. Try the rename again.';
          }
          return `Couldn’t rename: ${e.message}`;
        }
      },
    });
  }

  async function duplicateReport(r) {
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

  async function deleteReport(r) {
    if (!window.confirm(`Delete “${r.name}”?\n\nYou can restore it from Recently Deleted for 30 days.`)) return;
    try { await api.remove(r.id); }
    catch (e) { if (e.status !== 401) toast(`Couldn’t delete: ${e.message}`, 'error'); return; }
    S.reports = S.reports.filter(x => !sameId(x.id, r.id));
    if (S.doc && S.doc.id != null && sameId(S.doc.id, r.id)) { S.doc = null; S.view = 'home'; }
    S.deleted = null;
    render();
    if (S.deletedOpen) loadDeleted();
    toast(`Deleted “${r.name}”. It is in Recently Deleted for 30 days.`);
  }

  async function restoreReport(id) {
    const r = (S.deleted || []).find(x => sameId(x.id, id));
    try {
      const res = await api.restore(id);
      upsertReport(res.report);
      if (S.deleted) S.deleted = S.deleted.filter(x => !sameId(x.id, id));
      renderRail();
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
  // and a failed log must never look like a failed send.
  function logRun(action, built, info) {
    const d = S.doc;
    const jobs = built.ctx.jobs.slice(0, MAX_JOBS);
    const body = {
      report_id: d && d.id != null ? d.id : null,
      report_name: ((d && (d.savedName || d.name.trim())) || built.ctx.title || 'Untitled report').slice(0, 200),
      action,
      project_ids: jobs.map(p => String(p.id)),
      project_names: jobs.map(p => jobName(p)),
      date_from: built.ctx.range.from || null,
      date_to: built.ctx.range.to || null,
      recipients: info && Array.isArray(info.recipients) ? info.recipients.slice(0, 50) : [],
      subject: (info && info.subject) || null,
      included_internal: E.hasInternal(built.def, perm()),
      definition: built.def,
    };
    return api.run(body).then(res => {
      const r = d && d.id != null ? S.reports.find(x => sameId(x.id, d.id)) : null;
      if (r && res && res.run) { r.last_run_at = res.run.created_at; r.run_count = (Number(r.run_count) || 0) + 1; }
      if (S.view === 'history') loadRuns();
    }).catch(e => console.warn('[custom-reports] could not log the run:', e && e.message));
  }

  // Print / PDF. The window has to be opened inside the click itself or the
  // browser calls it a pop-up, so it opens first and the report is written
  // into it once the full daily-row history is in.
  function doPrint() {
    if (!S.doc || !requireJobs()) return;
    const win = window.open('', '_blank');
    if (!win) { alert('Your browser blocked the print window. Allow pop-ups for this site and try again.'); return; }
    const go = () => {
      let built;
      try { built = buildCurrent(); }
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
      try { win.document.open(); } catch (_) { /* written fresh below */ }
      go();
    });
  }

  async function doEmail() {
    if (!S.doc || !requireJobs()) return;
    if (typeof window.openReportEmailModal !== 'function') {
      alert('Email module is still loading — please try again in a moment.');
      return;
    }
    const d = S.doc;
    await whenReady();
    if (S.doc !== d) return;
    let built;
    try { built = buildCurrent(); }
    catch (err) { toast('Couldn’t build the report: ' + err.message, 'error'); return; }
    // The one place a customer is most likely on the other end.
    if (E.hasInternal(built.def, perm())
      && !window.confirm('This report includes internal data — costs, rates, hours, employee names or profit. Email it anyway? Only send it inside the company.')) return;
    const jobs = built.ctx.jobs;
    const one = jobs.length === 1 ? jobs[0] : null;
    const jobLabel = one ? jobName(one) : `${jobs.length} jobs`;
    window.openReportEmailModal({
      reportType: `${cfg.division}_custom_report`,
      projectId: one ? one.id : null,
      projectName: jobLabel,
      defaultSubject: `${built.ctx.title} — ${jobLabel}`,
      getHTML: () => built.html,
      onSent: info => logRun('email', built, info),
    });
  }

  async function doExcel() {
    if (!S.doc || !requireJobs()) return;
    const d = S.doc;
    await whenReady();
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
        <td data-label="Action" class="cr-nowrap">${ACTION_LABEL[r.action] || esc(r.action)}</td>
        <td data-label="Jobs" title="${esc(names.join(', '))}">${esc(jobs || '—')}</td>
        <td data-label="Dates" class="cr-nowrap">${esc(range)}</td>
        <td data-label="Recipients">${esc(to)}</td>
        <td data-label="Data">${r.included_internal ? badge('&#128274; Internal', 'internal') : badge('Customer-safe', 'safe')}</td>
      </tr>`;
    }).join('');
    return head + `<div class="cr-tablewrap"><table class="cr-table">
      <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Report</th><th scope="col">Action</th>
        <th scope="col">Jobs</th><th scope="col">Dates</th><th scope="col">Recipients</th><th scope="col">Data</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
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
    if (on && E.columnState(s.type, key, S.doc.def, perm()) !== 'available') { if (el) el.checked = false; return; }
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
    const shown = s.columns.filter(k => E.columnState(s.type, k, S.doc.def, perm()) === 'available');
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
      if (perm().canSeeCosts === false) { if (el) el.checked = false; return; }
      if (!window.confirm(INTERNAL_CONFIRM)) { if (el) el.checked = false; return; }
      def.includeInternal = true;
    } else {
      def.includeInternal = false;
    }
    changed({ panel: S.step === 2 });
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

  // ── Event wiring ────────────────────────────────────────────────────
  function onClick(e) {
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
      case 'jobs-shown': selectJobs(projects().filter(p => matchJob(p, S.jobSearch.trim().toLowerCase())), false); break;
      case 'jobs-clear': selectJobs([], true); break;
      case 'jobs-active': {
        const list = projects().filter(p => txt(p.status) === 'In Progress');
        if (!list.length) { toast('No jobs are In Progress.', 'error'); break; }
        selectJobs(list, true);
        break;
      }
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
      default: break;
    }
  }

  function onChange(e) {
    const el = e.target;
    const bind = el && el.getAttribute && el.getAttribute('data-bind');
    if (!bind || !S.doc) return;
    const def = S.doc.def;
    const sec = el.getAttribute('data-sec');
    switch (bind) {
      case 'job': toggleJob(el.value, el.checked, el.closest('.cr-job')); break;
      case 'jobs-client': {
        const c = el.value;
        el.value = '';
        if (!c) break;
        const list = projects().filter(p => txt(p.client) === c);
        selectJobs(list, true);
        toast(`Selected ${plural(list.length, 'job')} for ${c}.`);
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
      case 'save-jobs': S.doc.saveJobs = !!el.checked; changed({ preview: false }); break;
      case 'internal': setInternal(!!el.checked, el); break;
      case 'col': toggleColumn(sec, el.getAttribute('data-key'), !!el.checked, el); break;
      case 'opt': setOption(sec, el.getAttribute('data-key'), el); break;
      case 'opt-kind': toggleListOption(sec, 'kinds', el.getAttribute('data-value'), !!el.checked); break;
      case 'opt-cc': toggleListOption(sec, 'costCodes', el.getAttribute('data-value'), !!el.checked); break;
      case 'h-showGenerated': def.header.showGenerated = !!el.checked; changed(); break;
      default: break;
    }
  }

  function onInput(e) {
    const el = e.target;
    const bind = el && el.getAttribute && el.getAttribute('data-bind');
    if (!bind) return;
    if (bind === 'rail-search') { S.search = el.value; renderRail(); return; }
    if (!S.doc) return;
    const def = S.doc.def;
    const sec = el.getAttribute('data-sec');
    switch (bind) {
      case 'job-search': S.jobSearch = el.value; renderJobList(); break;
      case 'name': S.doc.name = el.value; changed(); break;
      case 'title': def.title = el.value; changed(); break;
      case 'description': S.doc.description = el.value; changed({ preview: false }); break;
      case 'h-preparedFor': case 'h-preparedBy': case 'h-intro': case 'h-footer':
        def.header[bind.slice(2)] = el.value;
        changed();
        break;
      case 'sec-title': { const s = findSec(sec); if (s) { s.title = el.value; changed(); } break; }
      case 'sec-text': { const s = findSec(sec); if (s) { s.text = el.value; changed(); } break; }
      case 'col-label': setLabel(sec, el.getAttribute('data-key'), el.value); changed(); break;
      default: break;
    }
  }

  function onKeydown(e) {
    const el = e.target;
    const bind = el && el.getAttribute && el.getAttribute('data-bind');
    if (bind === 'col-label') {
      if (e.key === 'Enter') { e.preventDefault(); endLabelEdit(true, true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endLabelEdit(false, true); }
      return;
    }
    if (bind === 'name' && e.key === 'Enter') { e.preventDefault(); el.blur(); return; }
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
      // Another division's reports and open report do not belong here.
      Object.assign(S, { reports: [], loaded: false, loadError: '', deleted: null, runs: null, doc: null, view: 'home', me: null });
    }
    if (!S.loaded) S.canShare = cfg.perm.canShare === true;
    if (!S.readyDone) S.readyP = null;
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
    loadList();
  }

  window.FCTCustomReports = {
    configure,
    renderTab,
    _internals: { state: () => S, api },
  };
})();
