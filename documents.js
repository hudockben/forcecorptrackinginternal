/* eslint-disable no-undef */
/* DataWatch — Job Document Vault
 *
 * The folder browser behind the Documents tab, and the attach flow behind the
 * paperclip on a purchase order. Shared by the division pages the same way
 * report-email.js is: one <script src>, no bundler, all styling inline off the
 * host page's CSS variables so it inherits whatever theme that page uses.
 *
 * The host page configures it once:
 *
 *   FCTDocuments.configure({
 *     division:          'turf',
 *     getProjectId:      () => activeProjectId,       // null = General / Non-Job
 *     getProjectName:    id => 'Route 30 Resurfacing',
 *     getCostCodes:      id => [{ code: '420', label: 'Paving' }],
 *     getPurchaseOrders: () => [{ id, po_number, supplier, project_id }],
 *     perm:              { canUpload, canManage, canDelete },
 *     getUserName:       () => 'ben',   // optional — who the server records as uploaded_by
 *   });
 *
 * then calls FCTDocuments.renderTab(mountEl) when the tab opens,
 * FCTDocuments.openAttach(po) from a PO row, and
 * FCTDocuments.openProcurementAttach(line) from the paperclip on a line of the
 * Procurement sheet.
 *
 * File bytes go straight from the browser to object storage with a presigned
 * URL — see api/lib/storage.js for why they cannot go through the API.
 */
(function () {
  if (window.FCTDocuments) return; // already loaded

  const API = '/api';
  const Z   = 10060; // above report-email.js (10050)

  // Long edge, in pixels, that photos are resized to before upload. A modern
  // phone camera produces 12 MP files; a delivery ticket is legible at a
  // fraction of that, and the difference is what fills a bucket.
  const PHOTO_MAX_EDGE = 2400;
  const PHOTO_QUALITY  = 0.85;

  let cfg = {
    division: 'turf',
    getProjectId: () => null,
    getProjectName: () => '',
    getCostCodes: () => [],
    getPurchaseOrders: () => [],
    perm: { canUpload: false, canManage: false, canDelete: false },
    // The logged-in username, the same string the server stamps on a file as
    // uploaded_by. Optional: it only decides whether a level2 user is offered
    // Detach on a file they uploaded themselves. Left unset, only managers get
    // that button — the server allows exactly that much either way.
    getUserName: undefined,
  };

  // ── State ───────────────────────────────────────────────────────────
  let folders   = [];
  let documents = [];
  let caps      = { canUpload: false, canManage: false, canDelete: false };
  let currentFolderId = null;   // null = the root listing

  // Folder ids whose children are drawn. The rail opens every branch closed:
  // a job with forty purchase orders gets forty PO subfolders under Purchase
  // Orders, and left open they push the cost-code folders below the fold and
  // turn the rail into a scroll. This is the set the user has opened, plus the
  // branches we open on their behalf when we move them somewhere.
  const expanded = new Set();
  let search    = '';           // the document search in the toolbar
  let folderSearch = '';        // the folder rail's own filter — independent
  let mountEl   = null;
  let loadedFor = undefined;    // project id the current data belongs to
  let poCounts  = {};

  // How many documents sit under each cost code's folder, per job:
  //   ccCounts['<project id>']['420'] = 7
  // This is what the bid page's green cost-code bars draw their folder chip
  // from, and it is deliberately kept OUTSIDE `folders`/`documents`. Those
  // describe the one scope the browser is currently showing; the bid page asks
  // about whatever job the user opened, which is routinely a different one, and
  // counting through load() would have repainted the Documents tab's rail with
  // a foreign job's folders every time someone opened a bid.
  let ccCounts  = {};
  // Bumped by every load() and every count fetch, so a slow count fetch cannot
  // write its stale numbers over fresher ones. Separate from loadGeneration:
  // bumping that one here would make in-flight load() responses think they had
  // lost a race they were never in.
  let ccGeneration = 0;

  // How many documents hang off each line of the Procurement sheet, per job:
  //   procCounts['<project id>']['<procurement row id>'] = 2
  // What the paperclip on each line draws its number from. Kept per job and
  // outside `folders`/`documents` for the same reason ccCounts is: the sheet
  // asks about whatever job it is showing, which is routinely not the one the
  // Documents tab is sitting on.
  let procCounts = {};
  // Stale-answer guard for the counts above. Every count request takes the
  // next ticket; procLanded remembers, per job, the ticket whose answer is in
  // procCounts. An answer is dropped only when a LATER request for the SAME job
  // has already landed — so a slow poll cannot write its older numbers over an
  // upload's fresher ones, while a refresh for one job never throws away an
  // answer for another (the sheet and the Documents tab can each be counting a
  // different job at once).
  let procTicket = 0;
  const procLanded = {};

  // Bumped by every load(). A response whose generation is stale — because the
  // job picker moved on, or because openAttach() started a load for a PO on
  // another job — is dropped instead of overwriting the state behind whatever
  // is currently on screen. Without this the last response to arrive won, and
  // the next click repainted a foreign job's folder tree under the current
  // job's heading.
  let loadGeneration = 0;

  // The copy of the loaded job (loadedFor) is known to be behind the server:
  // a fresh cost-code count (refreshCostCodeCounts) came back with another
  // fingerprint of the job than the copy was loaded with (scopeVersion) — a
  // file attached, swapped, re-filed or renamed, a folder made — or, from a
  // server that sends no fingerprint, with counts the copy does not give.
  // Set only by that comparison, cleared by the next load(). While it is set,
  // nothing reads the copy as if it were current: the next load, folder
  // dialog or attach dialog reads the job again, and a plain count asks the
  // server. The poll that notices costs one small counts request, not the
  // job's whole listing.
  let scopeBehind = false;
  // The fingerprint the server sent with the copy in hand (the listing's
  // `version`), or null when it sent none.
  let scopeVersion = null;

  // ── Helpers ─────────────────────────────────────────────────────────
  // obj[key] only when obj holds it itself. Row ids are free-form enough
  // (^[A-Za-z0-9_-]{1,64}$) that "__proto__" is a legal one, and a plain
  // lookup would answer it with Object.prototype instead of a count.
  function own(obj, key) {
    return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
  }

  function token() { return localStorage.getItem('fct_token') || ''; }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // Escape `text`, wrapping the run that matches `needle` so the eye lands on
  // it. The split happens on the raw string and each piece is escaped after —
  // escaping first and then searching would miss any needle containing a
  // character esc() rewrites, and could match the entity it produced.
  function mark(text, needle) {
    const s = String(text == null ? '' : text);
    if (!needle) return esc(s);
    const at = s.toLowerCase().indexOf(needle);
    if (at < 0) return esc(s);
    return esc(s.slice(0, at))
      + '<mark style="background:var(--green,#22c55e);color:#0a0a0f;border-radius:2px;padding:0 1px">'
      + esc(s.slice(at, at + needle.length)) + '</mark>'
      + esc(s.slice(at + needle.length));
  }

  function fmtBytes(n) {
    if (!n) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function iconFor(doc) {
    const t = doc.content_type || '';
    if (t.startsWith('image/')) return '&#128247;';        // camera
    if (t === 'application/pdf') return '&#128196;';        // page
    if (t.includes('sheet') || t.includes('excel') || t === 'text/csv') return '&#128202;';
    if (t.includes('word')) return '&#128209;';
    return '&#128206;';                                     // paperclip
  }

  async function api(method, path, body) {
    const init = {
      method,
      headers: { 'Authorization': `Bearer ${token()}` },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${API}${path}`, init);
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }

    // An expired token has to end the session, the way every other call in the
    // app does (apiGet/apiPut and the pollers all call logout() on a 401).
    // Without this the Documents tab showed the raw server string as a toast
    // and left the user on a page that looked signed in but could save nothing
    // — which reads as a mysterious "session error" rather than "log in again".
    // logout() is a global on every host page and latches itself, so calling it
    // from several in-flight requests at once is safe.
    if (r.status === 401) {
      if (typeof window.logout === 'function') {
        window.logout();
      } else {
        localStorage.removeItem('fct_token');
        window.location.reload();
      }
      const err = new Error('Your session expired. Please sign in again.');
      err.status = 401;
      throw err;
    }

    if (!r.ok) {
      // Several endpoints carry the underlying cause in `detail` — most usefully
      // the object store's own answer behind a relayed upload. Dropping it left
      // the toast saying only "Storage refused the upload", which is the one
      // thing the browser could already work out for itself.
      const parts = [(data && data.error) || `Request failed (${r.status})`];
      if (data && data.detail) parts.push(String(data.detail));
      const err = new Error(parts.join(' — '));
      err.status = r.status;
      throw err;
    }
    return data;
  }

  function q(params) {
    const parts = [`division=${encodeURIComponent(cfg.division)}`];
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== '') parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    return '?' + parts.join('&');
  }

  // ── Toast ───────────────────────────────────────────────────────────
  function toast(message, kind) {
    const el = document.createElement('div');
    el.textContent = message;
    // Which kind it is, readable without parsing its colours: an error, or
    // the plain notice everything else is.
    el.setAttribute('data-fctdoc-toast', kind === 'error' ? 'error' : 'info');
    el.style.cssText = `
      position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);z-index:${Z + 20};
      background:var(--surface2,#1a1a26);color:var(--text,#e0e0e0);
      border:1px solid ${kind === 'error' ? 'var(--red,#ef4444)' : 'var(--green,#22c55e)'};
      border-left-width:3px;padding:0.6rem 1rem;border-radius:4px;font-size:0.85rem;
      box-shadow:0 8px 24px rgba(0,0,0,0.5);max-width:min(90vw,520px)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
  }

  // ── Photo downscaling ───────────────────────────────────────────────
  /**
   * Shrink a camera photo before it leaves the phone.
   *
   * Returns { blob, filename } — the original untouched when the browser
   * cannot decode the image (HEIC outside Safari is the usual case) or when it
   * is already small. A converted file is renamed to .jpg so it still matches
   * the server's extension allowlist.
   */
  async function maybeDownscale(file) {
    const asIs = { blob: file, filename: file.name };
    if (!file.type.startsWith('image/')) return asIs;
    if (file.size < 400 * 1024) return asIs;
    if (typeof createImageBitmap !== 'function') return asIs;

    try {
      const bitmap = await createImageBitmap(file);
      const longest = Math.max(bitmap.width, bitmap.height);
      if (longest <= PHOTO_MAX_EDGE) { bitmap.close?.(); return asIs; }

      const scale = PHOTO_MAX_EDGE / longest;
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();

      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', PHOTO_QUALITY));
      if (!blob || blob.size >= file.size) return asIs;

      const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
      return { blob, filename: `${base}.jpg` };
    } catch {
      // Undecodable (HEIC in Chrome, a corrupt file) — send the original and
      // let the server's allowlist have the final say.
      return asIs;
    }
  }

  // ── Data ────────────────────────────────────────────────────────────
  async function load(projectId, { force = false } = {}) {
    if (!force && loadedFor === projectId && !scopeBehind) return true;
    const generation = ++loadGeneration;

    // Seed the generated tree first — the six fixed folders, the Purchase
    // Orders root, and one folder per cost code on this job. Idempotent, so
    // this is safe on every open, and it is how a cost code added this morning
    // gets a folder this afternoon.
    //
    // Deliberately NOT gated on cfg.perm: the host page derives that from
    // fctUser.role, which login.js sets from the caller's *turf* role for
    // tracker.html's benefit. On paving and kiewit that can understate what
    // the user may do, and skipping the seed there would leave a job with no
    // folders at all. The server checks properly and 403s if it disagrees,
    // which costs one request and is caught below.
    const costCodes = (cfg.getCostCodes(projectId) || [])
      .map(c => (typeof c === 'string' ? { code: c, label: '' } : c))
      .filter(c => c && c.code);
    try {
      await api('PUT', `/documents${q({ projectId })}`, { costCodes });
    } catch (err) {
      // A failed seed is not fatal — whatever folders exist still list below,
      // and a view-only user is expected to land here.
      if (err.status !== 403) console.warn('[documents] folder seed failed:', err.message);
    }

    const data = await api('GET', `/documents${q({ projectId })}`);

    // A newer load started while this one was in flight — its scope is what the
    // user is looking at, so this response is stale and must not land.
    //
    // Reported to the caller, not swallowed: openAttach() reads folders and
    // caps straight after awaiting this, so a silent early return handed it
    // another job's folder list to build its filing picker from.
    if (generation !== loadGeneration) return false;

    caps      = data.caps || cfg.perm;
    loadedFor = projectId;
    scopeBehind = false;
    scopeVersion = data && typeof data.version === 'string' && data.version ? data.version : null;
    adoptScope(data);

    // Every upload, delete and re-file comes back through here, so recounting
    // off the response we already hold keeps the bid page's folder chips honest
    // for free. Doing it anywhere else meant a file attached from a cost-code
    // bar left the chip beside it still reading the old number.
    ccCounts[projectId || ''] = countByCostCode(folders, documents);
    ccGeneration++;
    return true;
  }

  // Take a listing of the scope just loaded (loadedFor) as the module's
  // folders and documents.
  function adoptScope(data) {
    folders   = (data && data.folders) || [];
    documents = (data && data.documents) || [];

    // The folder that was open may not exist in the scope just loaded.
    if (currentFolderId && !folders.some(f => f.id === currentFolderId)) {
      currentFolderId = null;
    }

    // Drop expansions for folders this scope no longer has — another job, or
    // one deleted since. Pruning rather than clearing is what lets a folder
    // created inside an open branch still show up under it after the reload.
    for (const id of expanded) {
      if (!folders.some(f => f.id === id)) expanded.delete(id);
    }
  }

  async function refreshPoCounts() {
    try {
      const data = await api('GET', `/documents${q({ poCounts: 1 })}`);
      poCounts = data.counts || {};
    } catch (err) {
      // Keep the counts we already had. Zeroing them on a transient failure
      // drew an empty paperclip on every purchase order — including ones with
      // documents attached — and the host fetches counts once per session, so
      // nothing ever corrected it. A stale count beats a wrong one.
      console.warn('[documents] PO counts refresh failed, keeping the last good set:', err.message);
    }
    return poCounts;
  }

  /**
   * Fill in the per-cost-code document counts for one job, for the folder chips
   * on the bid page's green cost-code bars and the Procurement sheet's
   * cost-code sections.
   *
   * Free when the browser is already sitting on that job — load() counts as it
   * goes — and otherwise one small GET (?costCodeCounts=1) that answers with
   * just the numbers, counted on the server by the same rules countByCostCode
   * uses here (api/lib/cost-code-counts.js). It lands ONLY in ccCounts.
   * Routing it through load() instead would have swapped `folders`, `documents`
   * and `caps` over to the bid page's job, and the Documents tab open behind it
   * would have redrawn under a heading for a job the user never picked.
   *
   * Never rejects: a job whose counts could not be fetched draws its chips
   * without a number, which is the same thing an untouched job draws. Failing
   * loudly here would put an error toast on the screen of someone who did
   * nothing but open a bid.
   *
   * `fresh` asks the server even when the browser is sitting on the job. The
   * copy in hand only changes when this browser loads, uploads or detaches,
   * and the server moves files between cost-code folders on its own: a
   * Procurement line re-coded (a Sub Code picked, the bid's cost code
   * renamed) re-files its attachments, and a colleague attaches files. The
   * Procurement sheet's poll asks this way, so its section folder chips keep
   * up with all of that. The bid page does not poll, and keeps the free count.
   *
   * A fresh answer for the job the browser is sitting on that differs from
   * what the copy in hand counts means that copy is behind: it is marked so
   * (scopeBehind), and the next folder or attach dialog reads the job again
   * rather than listing a folder the chip beside it no longer agrees with.
   * Nothing is seeded, and neither the copy nor caps are touched: this is a
   * read, run unprompted on every poll.
   */
  async function refreshCostCodeCounts(projectId, opts) {
    const fresh = Boolean(opts && opts.fresh);
    const key = projectId || '';
    if (!fresh && loadedFor === projectId && folders.length && !scopeBehind) {
      ccCounts[key] = countByCostCode(folders, documents);
      return ccCounts[key];
    }
    const generation = ++ccGeneration;
    const scopeGeneration = loadGeneration;
    let data;
    try {
      data = await api('GET', `/documents${q({ projectId, costCodeCounts: 1 })}`);
    } catch (err) {
      // null, not an empty map: the caller caches "this job is counted" off
      // the result, and a failure that looked like a successful count of zero
      // meant one flaky request left every chip on the job blank for the rest
      // of the session with nothing to retry it.
      console.warn('[documents] cost-code counts refresh failed:', err.message);
      return null;
    }
    // A load(), or a later count fetch, landed while this was in flight. Its
    // numbers describe the job as it is now; ours describe it as it was before
    // whatever that was — writing them back would undo an upload's count.
    if (generation !== ccGeneration) return ccCounts[key] || null;
    const got = data && data.counts;
    const counts = got && typeof got === 'object' && !Array.isArray(got)
      ? { ...got }
      // A server from before the counts endpoint ignores costCodeCounts and
      // answers with the job's whole listing; count that, as this used to.
      : countByCostCode((data && data.folders) || [], (data && data.documents) || []);
    // The job in hand, with no load since this went out: is the copy behind?
    // Another fingerprint says so for any change, counted or not; the counts
    // say so too, and are all an older server leaves to go on.
    if (loadedFor === projectId && scopeGeneration === loadGeneration) {
      const version = data && typeof data.version === 'string' && data.version ? data.version : null;
      if ((version && scopeVersion && version !== scopeVersion) || !sameCounts(counts, countByCostCode(folders, documents))) {
        scopeBehind = true;
      }
    }
    ccCounts[key] = counts;
    return ccCounts[key];
  }

  // Whether two { code: n } maps say the same thing.
  function sameCounts(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && Number(a[k]) === Number(b[k]));
  }

  /**
   * Fill in how many documents are attached to each line of one job's
   * Procurement sheet: { '<row id>': n }. One small GET; the answer lands only
   * in procCounts, so asking never moves the Documents tab onto that job.
   *
   * Never rejects, and resolves null on a failure rather than an empty map —
   * the same contract as refreshCostCodeCounts, for the same reason: a caller
   * that read "{}" as "counted, nothing attached" would blank every paperclip
   * on the sheet over one dropped request. The last good counts are kept.
   */
  async function refreshProcurementCounts(projectId) {
    const key = projectId || '';
    // A procurement line always belongs to a job (project_id is NOT NULL on
    // procurement_items), so the General area has nothing to count and is not
    // worth a request.
    if (!key) {
      procCounts[''] = {};
      return procCounts[''];
    }
    const ticket = ++procTicket;
    let data;
    try {
      data = await api('GET', `/documents${q({ procurementCounts: 1, projectId: key })}`);
    } catch (err) {
      console.warn('[documents] procurement counts refresh failed, keeping the last good set:', err.message);
      return null;
    }
    // A request for this job that went out after ours has already answered.
    // Its numbers include whatever happened in between — an upload, a detach —
    // and ours would quietly undo them.
    if ((own(procLanded, key) || 0) > ticket) return own(procCounts, key) || null;
    procLanded[key] = ticket;
    const raw = data && data.counts && typeof data.counts === 'object' ? data.counts : {};
    const counts = {};
    for (const [rowId, n] of Object.entries(raw)) {
      const v = Number(n);
      if (Number.isFinite(v) && v > 0) counts[rowId] = v;
    }
    procCounts[key] = counts;
    return counts;
  }

  // ── Folder tree ─────────────────────────────────────────────────────
  function childrenOf(parentId) {
    return folders
      .filter(f => (f.parent_id || null) === (parentId || null))
      .sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name));
  }

  function folderById(id) { return folders.find(f => f.id === id) || null; }

  function trail(folderId) {
    const out = [];
    let f = folderById(folderId);
    while (f) { out.unshift(f); f = f.parent_id ? folderById(f.parent_id) : null; }
    return out;
  }

  function docsIn(folderId) {
    return documents.filter(d => d.folder_ids.includes(folderId));
  }

  // ── Cost-code folders ───────────────────────────────────────────────
  // The bid page groups its sub codes under a cost code and wants that cost
  // code's paperwork without leaving the page, so these three helpers answer
  // "which folder is 420's, what is in it, and how much" against any folder
  // list — the one on screen, or one fetched purely to count with.

  /* The cost code a generated folder stands for, or '' if it stands for none.
     The cost_code column is the answer wherever it is filled in; folders seeded
     before that column existed carry only the `cc-<code>` slug, and reading the
     NAME instead would miss every job the master list has since relabelled —
     "420" becomes "420 · Paving" the first time someone fills in a description,
     and a name match then fails on exactly the jobs that are best kept up. */
  function folderCostCode(f) {
    if (!f || f.kind !== 'cost_code') return '';
    // Trimmed, and the lookups trim too. docsCostCodesFor() seeds the folder
    // with the bid item's value verbatim, so a code pasted out of a
    // spreadsheet as "420 " is stored with its space — and every lookup for
    // "420" then missed a folder that was sitting right there.
    if (f.cost_code) return String(f.cost_code).trim();
    const m = /^cc-(.+)$/.exec(f.slug || '');
    return m ? m[1].trim() : '';
  }

  /* A cost code as it reads on screen, for deciding whether two spellings are
     the same code: letter case, spaces at either end or doubled up (the
     non-breaking kind a paste out of Procore or Excel brings included),
     zero-width characters, which dash was typed ("-", "–", "—") and curly or
     straight quotes make no difference. The same normalising as tracker.html's
     _codeKey, which the Procurement sheet groups its sections by, and as
     codeKey in api/lib/procurement-docs.js, which the server files a line's
     attachments by — so the section, the folder its files go into and the
     chip that counts them all agree on which code is which. */
  function codeKey(s) {
    if (s == null || s === '') return '';
    return String(s)
      .replace(/[­​-‍⁠﻿]/g, '')          // soft hyphen, zero-width
      .replace(/[‐-―−﹘﹣－]/g, '-')   // every dash
      .replace(/[‘’‚‛′]/g, "'")          // curly single quotes
      .replace(/[“”„‟″]/g, '"')          // curly double quotes
      .replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /* The folder that holds cost code `code`'s paperwork in `fldrs`, or null.
     An exact match (both sides trimmed) wins; failing that, the first one
     that reads the same on screen (codeKey) — another letter case, a dash
     typed another way. The server files a procurement attachment the same
     way, because a line's code can be typed on the sheet ("stormwater")
     while the bid seeded the folder as "Stormwater". Without the fallback
     the upload dialog opened on "pick a folder" for a file the server was
     about to put in that very folder. */
  function costCodeFolderFor(code, fldrs) {
    const want = String(code == null ? '' : code).trim();
    if (!want) return null;
    const list = fldrs || folders;
    const exact = list.find(f => folderCostCode(f) === want);
    if (exact) return exact;
    const key = codeKey(want);
    if (!key) return null;
    return list.find(f => {
      const c = folderCostCode(f);
      return c !== '' && codeKey(c) === key;
    }) || null;
  }

  /* `folder` and every other cost-code folder in `fldrs` standing for the
     same trimmed code. Normally just the one. Two happen when the bid carries
     a code once as typed and once pasted with a non-breaking space after it:
     the seed makes a folder for each spelling, and both trim to the same
     code. They are one cost code to everyone reading the job, so the chip
     counts them together and the folder dialog lists them together — counting
     one and listing the other had the chip disagree with the dialog it opens. */
  function sameCodeFolders(folder, fldrs) {
    const code = folderCostCode(folder);
    if (!code) return folder ? [folder] : [];
    return (fldrs || folders).filter(f => f === folder || folderCostCode(f) === code);
  }

  /* Every folder id at or under `rootId`. A cost-code folder is a folder like
     any other once it exists, so someone can and does file subfolders inside it
     ("420 / Tickets"); counting only the direct children reported nothing for a
     cost code whose paperwork was one level down. */
  function subtreeIds(rootId, fldrs) {
    const kids = new Map();
    for (const f of fldrs) {
      const p = f.parent_id || null;
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(f.id);
    }
    const ids = new Set([rootId]);
    const stack = [rootId];
    while (stack.length) {
      for (const k of (kids.get(stack.pop()) || [])) {
        if (!ids.has(k)) { ids.add(k); stack.push(k); }
      }
    }
    return ids;
  }

  /* Every folder id at or under any of `roots`. */
  function subtreesOf(roots, fldrs) {
    const ids = new Set();
    for (const r of roots) for (const id of subtreeIds(r.id, fldrs)) ids.add(id);
    return ids;
  }

  /* { '420': 7, '530': 0, ... } for one job's folder and document lists. Every
     cost-code folder is reported, zeroes included — the bid page needs to tell
     "no paperwork" apart from "no folder", and only the second is worth a
     different message.

     Folders whose codes trim to the same code are counted as one, each file
     once however many of them it is in (sameCodeFolders says why there can be
     two). Counting each on its own let the one sorted last overwrite the
     other's number. Codes that differ in more than spaces — "Stormwater" and
     "stormwater" — stay apart: each is its own bar on the bid page. */
  function countByCostCode(fldrs, docs) {
    const counts = {};
    for (const f of fldrs) {
      const code = folderCostCode(f);
      if (!code || Object.prototype.hasOwnProperty.call(counts, code)) continue;
      const ids = subtreesOf(sameCodeFolders(f, fldrs), fldrs);
      counts[code] = docs.filter(d => (d.folder_ids || []).some(id => ids.has(id))).length;
    }
    return counts;
  }

  // Open a folder and every folder above it, so it is on screen rather than
  // behind a closed twisty. Called whenever something other than a twisty
  // click moves the user into a folder — a crumb, Enter in the filter, a
  // folder they just created.
  function expandTrail(folderId) {
    for (const f of trail(folderId)) expanded.add(f.id);
  }

  // Open every branch the rail's filter kept, so its hits are visible instead
  // of hidden under a closed parent. Deliberately driven by the filter box
  // rather than by render(): re-deriving it on every draw would reopen a
  // branch the moment the user closed it, since a toggle redraws.
  function expandForFilter(needle) {
    if (!needle) return;
    for (const f of folders) {
      if ((f.name || '').toLowerCase().includes(needle)) expandTrail(f.id);
    }
  }

  // Every document whose name, note, or uploader matches the search box.
  function searchHits() {
    const needle = search.trim().toLowerCase();
    if (!needle) return null;
    return documents.filter(d =>
      (d.filename || '').toLowerCase().includes(needle)
      || (d.note || '').toLowerCase().includes(needle)
      || (d.uploaded_by || '').toLowerCase().includes(needle));
  }

  // Which folders survive the rail's filter, as a Set of ids; null when the
  // box is empty. A folder is kept when its own name matches, when one of its
  // descendants matches — so the branch leading to a hit still reads — or when
  // one of its ancestors matches. That last case matters more than it looks:
  // the main pane lists documents only, so the rail is the sole way into a
  // subfolder, and dropping a matched folder's children would strand them
  // behind a filter with no way to reach them.
  function visibleFolderIds() { return folderMatchIds(folderSearch.trim().toLowerCase()); }

  function folderMatchIds(needle) {
    if (!needle) return null;
    const hits = folders.filter(f => (f.name || '').toLowerCase().includes(needle));
    const keep = new Set();
    for (const f of hits) for (const a of trail(f.id)) keep.add(a.id);   // hit + ancestors
    // Descend from every hit. The visited set is deliberately separate from
    // keep: a folder already kept as some other hit's ancestor still has to be
    // descended into, or its children go missing from under a match.
    const seen  = new Set();
    const stack = hits.flatMap(f => childrenOf(f.id));
    while (stack.length) {
      const kid = stack.pop();
      if (seen.has(kid.id)) continue;                   // also stops a cyclic parent_id
      seen.add(kid.id);
      keep.add(kid.id);
      stack.push(...childrenOf(kid.id));
    }
    return keep;
  }

  // The first folder the filter matches, in the order the rail draws them —
  // what Enter opens.
  function firstFolderMatch() {
    const needle = folderSearch.trim().toLowerCase();
    if (!needle) return null;
    const walk = parentId => {
      for (const f of childrenOf(parentId)) {
        if ((f.name || '').toLowerCase().includes(needle)) return f;
        const hit = walk(f.id);
        if (hit) return hit;
      }
      return null;
    };
    return walk(null);
  }

  // ── Rendering ───────────────────────────────────────────────────────
  // Inline styles cannot carry a media query, and the phone is the headline
  // case here — a foreman photographing a delivery ticket. Without this the
  // 15rem folder rail does not shrink and leaves ~100px for the file list on a
  // 375px screen. One stylesheet, injected once.
  function injectStyles() {
    if (document.getElementById('fctdoc-styles')) return;
    const el = document.createElement('style');
    el.id = 'fctdoc-styles';
    el.textContent = `
      @media (max-width: 720px) {
        .fctdoc-wrap { flex-direction: column !important; min-height: 0 !important; }
        .fctdoc-side {
          flex: 0 0 auto !important; width: 100% !important;
          max-height: 11rem !important;
          border-right: 0 !important;
          border-bottom: 1px solid var(--border,#2a2a3a) !important;
        }
        .fctdoc-main { max-height: none !important; }
        .fctdoc-bar  { gap: 0.4rem !important; }
        .fctdoc-bar input[type="text"] { flex: 1 1 100% !important; max-width: none !important; }
        .fctdoc-row-actions button { padding: 0.3rem 0.5rem !important; }
      }
      /* Touch targets big enough to hit with a glove on. A 0.85rem twisty is
         a thumb-width miss away from opening the folder instead of the
         branch, so it gets a real target — and the empty slot beside a
         childless folder grows with it, or the two indent differently. */
      @media (pointer: coarse) {
        .fctdoc-side [data-folder] { padding-top: 0.5rem !important; padding-bottom: 0.5rem !important; }
        .fctdoc-side .fctdoc-twisty { min-width: 1.75rem !important; }
        .fctdoc-row-actions button { min-width: 2.25rem; min-height: 2.25rem; }
      }
    `;
    document.head.appendChild(el);
  }

  const S = {
    wrap:  'display:flex;gap:0;border:1px solid var(--border,#2a2a3a);border-radius:6px;overflow:hidden;min-height:26rem;background:var(--surface,#111118)',
    side:  'flex:0 0 15rem;border-right:1px solid var(--border,#2a2a3a);padding:0.6rem;overflow-y:auto;max-height:34rem;background:var(--bg,#0a0a0f)',
    main:  'flex:1 1 auto;padding:0.85rem 1rem;overflow-y:auto;max-height:34rem;min-width:0',
    bar:   'display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;margin-bottom:0.85rem',
    btn:   'padding:0.35rem 0.7rem;border:1px solid var(--border,#2a2a3a);background:var(--surface2,#1a1a26);color:var(--text,#e0e0e0);border-radius:4px;font-size:0.78rem;cursor:pointer',
    green: 'padding:0.35rem 0.7rem;border:1px solid var(--green,#22c55e);background:transparent;color:var(--green,#22c55e);border-radius:4px;font-size:0.78rem;cursor:pointer;font-weight:600',
    input: 'padding:0.35rem 0.6rem;border:1px solid var(--border,#2a2a3a);background:var(--surface2,#1a1a26);color:var(--text,#e0e0e0);border-radius:4px;font-size:0.8rem',
    muted: 'color:var(--muted,#666);font-size:0.78rem',
  };

  function folderNodeHTML(f, depth, visible, needle) {
    if (visible && !visible.has(f.id)) return '';
    // Filtered out early so a branch whose only children the filter dropped
    // does not draw a twisty that opens onto nothing.
    const kids     = childrenOf(f.id).filter(k => !visible || visible.has(k.id));
    const isActive = f.id === currentFolderId;
    const count    = docsIn(f.id).length;
    const icon     = f.kind === 'cost_code' ? '&#128203;' : '&#128193;';
    const open     = kids.length > 0 && expanded.has(f.id);
    // A fixed-width slot either way, so names line up whether or not the
    // folder has anything under it.
    const twisty   = kids.length
      ? `<span class="fctdoc-twisty" data-folder-toggle="${esc(f.id)}" role="button" tabindex="0"
               aria-expanded="${open ? 'true' : 'false'}"
               title="${open ? 'Hide' : 'Show'} the ${kids.length} folder${kids.length === 1 ? '' : 's'} in ${esc(f.name)}"
               style="flex:none;width:0.85rem;text-align:center;line-height:1;font-size:0.62rem;
                      color:${open ? 'var(--text,#e0e0e0)' : 'var(--muted,#666)'};user-select:none">
           ${open ? '&#9660;' : '&#9654;'}
         </span>`
      : '<span class="fctdoc-twisty" style="flex:none;width:0.85rem"></span>';
    return `
      <div>
        <div data-folder="${esc(f.id)}"
             title="${esc(f.name)}"
             style="display:flex;align-items:center;gap:0.35rem;padding:0.28rem 0.4rem;
                    padding-left:${0.4 + depth * 0.8}rem;border-radius:3px;cursor:pointer;font-size:0.8rem;
                    ${isActive ? 'background:var(--surface2,#1a1a26);color:var(--green,#22c55e);font-weight:600' : 'color:var(--text,#e0e0e0)'}">
          ${twisty}
          <span>${icon}</span>
          <span style="flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${mark(f.name, needle)}</span>
          ${!open && kids.length ? `<span title="${kids.length} folder${kids.length === 1 ? '' : 's'} inside"
                 style="${S.muted};font-size:0.7rem">&#128193;${kids.length}</span>` : ''}
          ${count ? `<span style="${S.muted}">${count}</span>` : ''}
        </div>
        ${open ? kids.map(k => folderNodeHTML(k, depth + 1, visible, needle)).join('') : ''}
      </div>`;
  }

  function docRowHTML(d) {
    const pos = (d.po_ids || []).length;
    // Lines of the Procurement sheet the file is attached to. A package, not
    // the paperclip: the paperclip already means "purchase order" on this row,
    // and a file can be on both at once.
    const procs = (d.procurement_ids || []).length;
    return `
      <div data-doc="${esc(d.id)}"
           style="display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0.6rem;
                  border-bottom:1px solid var(--border,#2a2a3a);font-size:0.82rem">
        <span style="font-size:1rem">${iconFor(d)}</span>
        <div style="flex:1 1 auto;min-width:0">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            <a href="#" data-open="${esc(d.id)}" style="color:var(--text,#e0e0e0);text-decoration:none">${esc(d.filename)}</a>
            ${pos ? `<span title="Attached to ${pos} purchase order${pos === 1 ? '' : 's'}"
                           style="margin-left:0.4rem;color:var(--green,#22c55e);font-size:0.72rem">&#128206;${pos}</span>` : ''}
            ${procs ? `<span data-proc-chip title="Attached to ${procs} procurement line${procs === 1 ? '' : 's'}"
                           style="margin-left:0.4rem;color:var(--blue,#60a5fa);font-size:0.72rem">&#128230;${procs}</span>` : ''}
          </div>
          <div style="${S.muted}">
            ${fmtBytes(d.size_bytes)} · ${esc(d.uploaded_by || 'unknown')} · ${fmtDate(d.uploaded_at)}
            ${d.note ? ` · ${esc(d.note)}` : ''}
          </div>
        </div>
        <span class="fctdoc-row-actions" style="display:flex;gap:0.35rem;flex:none">
        <button data-download="${esc(d.id)}" style="${S.btn}" title="Download">&#11015;</button>
        ${caps.canUpload ? `<button data-attach="${esc(d.id)}" style="${S.btn}" title="Attach to a purchase order">&#128206;</button>` : ''}
        ${caps.canDelete ? `<button data-delete="${esc(d.id)}" style="${S.btn}" title="Delete">&#10005;</button>` : ''}
        </span>
      </div>`;
  }

  function render() {
    if (!mountEl) return;

    const projectId = cfg.getProjectId();
    const hits      = searchHits();
    const roots     = childrenOf(null);
    const visible   = visibleFolderIds();
    const needle    = folderSearch.trim().toLowerCase();
    const tree      = roots.map(f => folderNodeHTML(f, 0, visible, needle)).join('');
    const listing   = hits !== null ? hits
                    : currentFolderId ? docsIn(currentFolderId)
                    : [];
    const crumbs    = trail(currentFolderId);

    const heading = projectId
      ? esc(cfg.getProjectName(projectId) || 'Job')
      : 'General / Non-Job';

    injectStyles();

    mountEl.innerHTML = `
      <div class="fctdoc-bar" style="${S.bar}">
        <span style="font-size:1rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase">Documents</span>
        <span style="${S.muted}">${heading}</span>
        <input type="text" id="fctdoc-search" placeholder="&#128269; Search documents…"
               value="${esc(search)}" style="${S.input};flex:1 1 12rem;max-width:22rem" />
        ${caps.canDelete ? `<button id="fctdoc-trash" style="${S.btn}" title="Documents deleted in the last 30 days">&#128465; Deleted</button>` : ''}
        ${caps.canUpload ? `<button id="fctdoc-newfolder" style="${S.btn}">+ New Folder</button>` : ''}
        ${caps.canUpload ? `<button id="fctdoc-upload" style="${S.green}">&#11014; Upload</button>` : ''}
      </div>

      <div class="fctdoc-wrap" style="${S.wrap}">
        <div class="fctdoc-side" style="${S.side}" id="fctdoc-tree">
          ${roots.length ? `
            <div style="position:sticky;top:0;z-index:1;background:var(--bg,#0a0a0f);padding-bottom:0.4rem">
              <input type="text" id="fctdoc-folder-search" placeholder="&#128269; Filter folders…"
                     value="${esc(folderSearch)}" autocomplete="off" spellcheck="false"
                     style="${S.input};width:100%;box-sizing:border-box;font-size:0.76rem;padding:0.25rem 0.45rem" />
            </div>` : ''}
          ${!roots.length
            ? `<div style="${S.muted};padding:0.5rem">No folders yet.</div>`
            : tree || `<div style="${S.muted};padding:0.5rem">No folder matches &ldquo;${esc(folderSearch)}&rdquo;.</div>`}
        </div>
        <div class="fctdoc-main" style="${S.main}" id="fctdoc-main">
          ${hits !== null
            ? `<div style="margin-bottom:0.6rem;${S.muted}">${listing.length} match${listing.length === 1 ? '' : 'es'} for &ldquo;${esc(search)}&rdquo;</div>`
            : `<div style="margin-bottom:0.6rem;font-size:0.8rem">
                 <a href="#" data-folder-crumb="" style="color:var(--muted,#666);text-decoration:none">Home</a>
                 ${crumbs.map(c => ` <span style="${S.muted}">&rsaquo;</span> <a href="#" data-folder-crumb="${esc(c.id)}" style="color:var(--text,#e0e0e0);text-decoration:none">${esc(c.name)}</a>`).join('')}
               </div>`}

          ${hits === null && !currentFolderId
            ? `<div style="${S.muted};padding:1.5rem 0;text-align:center">Pick a folder to see what is filed in it.</div>`
            : listing.length
              ? `<div>${listing.map(docRowHTML).join('')}</div>`
              : `<div style="${S.muted};padding:1.5rem 0;text-align:center">
                   Nothing filed here yet.${caps.canUpload ? ' Drop a file anywhere on this panel to upload it.' : ''}
                 </div>`}

          ${caps.canUpload && hits === null && currentFolderId ? `
            <div id="fctdoc-drop" style="margin-top:0.9rem;border:1px dashed var(--border,#2a2a3a);border-radius:5px;
                                         padding:1rem;text-align:center;${S.muted}">
              Drop files here to file them in <strong style="color:var(--text,#e0e0e0)">${esc(folderById(currentFolderId)?.name || '')}</strong>
            </div>` : ''}
        </div>
      </div>`;

    wireTab();
  }

  // render() rebuilds the whole panel, so the box being typed into is replaced
  // mid-keystroke. Put focus and caret back on whatever took its place.
  function rerenderKeeping(selector, box) {
    const at = box.selectionStart;
    render();
    const again = mountEl.querySelector(selector);
    if (!again) return;
    again.focus();
    again.setSelectionRange(at, at);
  }

  function wireTab() {
    const searchBox = mountEl.querySelector('#fctdoc-search');
    if (searchBox) {
      searchBox.addEventListener('input', e => {
        search = e.target.value;
        rerenderKeeping('#fctdoc-search', e.target);
      });
    }

    const folderBox = mountEl.querySelector('#fctdoc-folder-search');
    if (folderBox) {
      folderBox.addEventListener('input', e => {
        folderSearch = e.target.value;
        expandForFilter(folderSearch.trim().toLowerCase());
        rerenderKeeping('#fctdoc-folder-search', e.target);
      });
      folderBox.addEventListener('keydown', e => {
        // Enter opens the first folder the filter found — type "earthwork",
        // press Enter, you are in it. Escape clears the filter.
        if (e.key === 'Enter') {
          const hit = firstFolderMatch();
          if (!hit) return;
          e.preventDefault();
          currentFolderId = hit.id;
          // Clearing the filter afterwards must not drop the folder back out
          // of sight behind a closed parent.
          expandTrail(hit.id);
          search = '';
          rerenderKeeping('#fctdoc-folder-search', e.target);
        } else if (e.key === 'Escape' && folderSearch) {
          e.preventDefault();
          folderSearch = '';
          rerenderKeeping('#fctdoc-folder-search', e.target);
        }
      });
    }

    mountEl.querySelectorAll('[data-folder]').forEach(el => {
      el.addEventListener('click', () => {
        currentFolderId = el.dataset.folder;
        // Clicking a folder opens it in both senses: its documents list on the
        // right, its subfolders under it in the rail.
        expanded.add(currentFolderId);
        search = '';
        render();
      });
    });

    // The twisty sits inside the folder row, and opening a branch is not the
    // same gesture as opening the folder — so it swallows the click rather
    // than letting it reach the row behind it.
    mountEl.querySelectorAll('[data-folder-toggle]').forEach(el => {
      const toggle = e => {
        e.preventDefault();
        e.stopPropagation();
        const id = el.dataset.folderToggle;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') toggle(e);
      });
    });

    mountEl.querySelectorAll('[data-folder-crumb]').forEach(el => {
      el.addEventListener('click', e => {
        e.preventDefault();
        currentFolderId = el.dataset.folderCrumb || null;
        expandTrail(currentFolderId);
        render();
      });
    });

    mountEl.querySelectorAll('[data-open]').forEach(el => {
      el.addEventListener('click', e => { e.preventDefault(); openPreview(el.dataset.open); });
    });
    mountEl.querySelectorAll('[data-download]').forEach(el => {
      el.addEventListener('click', () => downloadDoc(el.dataset.download));
    });
    mountEl.querySelectorAll('[data-delete]').forEach(el => {
      el.addEventListener('click', () => deleteDoc(el.dataset.delete));
    });
    mountEl.querySelectorAll('[data-attach]').forEach(el => {
      el.addEventListener('click', () => openLinkToPo(el.dataset.attach));
    });

    const up = mountEl.querySelector('#fctdoc-upload');
    if (up) up.addEventListener('click', () => openUpload({ folderId: currentFolderId }));

    const nf = mountEl.querySelector('#fctdoc-newfolder');
    if (nf) nf.addEventListener('click', openNewFolder);

    const tr = mountEl.querySelector('#fctdoc-trash');
    if (tr) tr.addEventListener('click', openTrash);

    const drop = mountEl.querySelector('#fctdoc-main');
    if (drop && caps.canUpload) {
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.outline = '2px dashed var(--green,#22c55e)'; });
      drop.addEventListener('dragleave', () => { drop.style.outline = 'none'; });
      drop.addEventListener('drop', e => {
        e.preventDefault();
        drop.style.outline = 'none';
        const files = [...(e.dataTransfer?.files || [])];
        if (!files.length) return;
        if (!currentFolderId) { toast('Open a folder first — every file has to be filed somewhere.', 'error'); return; }
        openUpload({ folderId: currentFolderId, files });
      });
    }
  }

  // ── Modal shell ─────────────────────────────────────────────────────
  function modal(title, bodyHTML, { wide = false } = {}) {
    const back = document.createElement('div');
    back.style.cssText = `position:fixed;inset:0;z-index:${Z};background:rgba(0,0,0,0.6);
                          display:flex;align-items:center;justify-content:center;padding:1rem`;
    back.innerHTML = `
      <div style="background:var(--surface,#111118);border:1px solid var(--border,#2a2a3a);border-radius:6px;
                  width:${wide ? 'min(60rem,95vw)' : 'min(30rem,95vw)'};max-height:92vh;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem;
                    border-bottom:1px solid var(--border,#2a2a3a)">
          <span style="font-weight:700;font-size:0.9rem;letter-spacing:0.04em;text-transform:uppercase">${esc(title)}</span>
          <button data-close style="background:none;border:none;color:var(--muted,#666);font-size:1.1rem;cursor:pointer">&#10005;</button>
        </div>
        <div style="padding:1rem;overflow:auto" data-body>${bodyHTML}</div>
      </div>`;
    document.body.appendChild(back);

    function onEsc(e) { if (e.key === 'Escape') close(); }
    // Removed by close(), so a dialog opened and shut fifty times does not
    // leave fifty listeners behind waiting on a key.
    const close = () => { document.removeEventListener('keydown', onEsc); back.remove(); };
    document.addEventListener('keydown', onEsc);
    back.querySelector('[data-close]').addEventListener('click', close);

    // Close on the backdrop only when the press STARTED on it. Reading the
    // click alone shut the dialog whenever a drag ENDED outside it — sweeping
    // a selection across the note box and releasing past the edge fires a
    // click whose target is the backdrop — and everything filled in went with
    // it, which reads as the dialog closing for no reason.
    let pressedBack = false;
    back.addEventListener('mousedown', e => { pressedBack = e.target === back; });
    back.addEventListener('click', e => { if (e.target === back && pressedBack) close(); });

    return { el: back, body: back.querySelector('[data-body]'), close };
  }

  // Options for the "file it in" picker — every folder, indented by depth.
  function folderOptionsHTML(selectedId, keep) {
    const out = [];
    (function walk(parentId, depth) {
      for (const f of childrenOf(parentId)) {
        // keep is ancestor-closed — a folder that did not survive the filter
        // cannot have a descendant that did — so the subtree goes with it and
        // the indentation never shows a child under a parent that is gone.
        if (keep && !keep.has(f.id)) continue;
        out.push(`<option value="${esc(f.id)}" ${f.id === selectedId ? 'selected' : ''}>${'&nbsp;'.repeat(depth * 4)}${esc(f.name)}</option>`);
        walk(f.id, depth + 1);
      }
    })(null, 0);
    return out.join('');
  }

  // A <select> of thirty cost-code folders is a scroll on a laptop and a
  // lottery on a phone. Sit a filter box on top of it that narrows the options
  // as you type. The element stays a real <select>, so every reader of its
  // .value — and the native picker a phone puts up — is untouched.
  function folderPickerHTML(id, selectedId, firstLabel) {
    return `
      <input type="text" data-folder-filter="${esc(id)}" placeholder="&#128269; Filter folders…"
             autocomplete="off" spellcheck="false"
             style="${S.input};width:100%;box-sizing:border-box;font-size:0.76rem;margin-bottom:0.3rem" />
      <select id="${esc(id)}" style="${S.input};width:100%">
        <option value="">${firstLabel}</option>
        ${folderOptionsHTML(selectedId, null)}
      </select>`;
  }

  function wireFolderFilter(root, id, firstLabel) {
    const box = root.querySelector(`[data-folder-filter="${id}"]`);
    const sel = root.querySelector('#' + id);
    if (!box || !sel) return;
    box.addEventListener('input', () => {
      const needle = box.value.trim().toLowerCase();
      const held   = sel.value;
      const keep   = folderMatchIds(needle);
      // Whatever is already picked stays in the list even when it does not
      // match — a filter is for finding a folder, not for silently dropping
      // the one already chosen.
      if (keep && held) for (const a of trail(held)) keep.add(a.id);
      sel.innerHTML = `<option value="">${firstLabel}</option>` + folderOptionsHTML(held, keep);
      sel.value = held;
      // Narrowing to exactly one folder picks it, which is the whole point on
      // a phone. Only when nothing is picked yet — never overwrite a choice.
      if (!held && needle) {
        const hits = folders.filter(f => (f.name || '').toLowerCase().includes(needle));
        if (hits.length === 1) sel.value = hits[0].id;
      }
    });
  }

  // The purchase orders this job may link to: its own, plus any that carry no
  // job at all.
  function posFor(projectId) {
    return (cfg.getPurchaseOrders() || [])
      .filter(po => !projectId || !po.project_id || po.project_id === projectId);
  }

  // How a purchase order reads everywhere it is listed, and what the filter
  // box matches against — the number and the supplier, because half the office
  // knows a PO by who it went to.
  function poLabel(po) {
    return `${po.po_number || po.id}${po.supplier ? ` — ${po.supplier}` : ''}`;
  }

  function poOptionsHTML(projectId, selectedId, needle) {
    // A purchase order already picked stays listed even when it does not match
    // — a filter is for finding one, not for dropping the one already chosen.
    const pos = posFor(projectId).filter(po =>
      !needle || po.id === selectedId || poLabel(po).toLowerCase().includes(needle));
    return `<option value="">— none —</option>` + pos.map(po =>
      `<option value="${esc(po.id)}" ${po.id === selectedId ? 'selected' : ''}>${esc(poLabel(po))}</option>`
    ).join('');
  }

  // Same shape as the folder picker: a filter box over a real <select>, so the
  // native picker a phone puts up and every reader of .value are untouched.
  function poPickerHTML(id, projectId, selectedId, locked) {
    const filter = locked ? '' : `
      <input type="text" data-po-filter="${esc(id)}" placeholder="&#128269; Filter purchase orders…"
             autocomplete="off" spellcheck="false"
             style="${S.input};width:100%;box-sizing:border-box;font-size:0.76rem;margin-bottom:0.3rem" />`;
    return `${filter}
      <select id="${esc(id)}" style="${S.input};width:100%" ${locked ? 'disabled' : ''}>
        ${poOptionsHTML(projectId, selectedId)}
      </select>`;
  }

  // Where a document attached from a purchase order files itself when the
  // user has not said otherwise: that order's own subfolder — the server
  // creates one on the first attach — and failing that the Purchase Orders
  // root it lives under. The picker used to open blank on this path, Upload
  // refused with "Pick a folder", and that refusal was a toast at the bottom
  // of the screen while the user was reading the middle of it. Attaching from
  // a PO looked like a dead button.
  function defaultFolderForPo(poId, projectId) {
    if (!poId) return '';
    const bySlug = slug => (folders.find(f => f.slug === slug) || {}).id || '';
    return bySlug(`po-${poId}`) || bySlug(projectId ? 'purchase-orders' : 'unassigned-pos');
  }

  function wirePoFilter(root, id, projectId) {
    const box = root.querySelector(`[data-po-filter="${id}"]`);
    const sel = root.querySelector('#' + id);
    if (!box || !sel) return;
    box.addEventListener('input', () => {
      const needle = box.value.trim().toLowerCase();
      const held   = sel.value;
      sel.innerHTML = poOptionsHTML(projectId, held, needle);
      sel.value = held;
      // Narrowing to exactly one picks it, which is the whole point on a
      // phone. Only when nothing is picked yet — never over a choice made.
      if (!held && needle) {
        const hits = posFor(projectId).filter(po => poLabel(po).toLowerCase().includes(needle));
        if (hits.length === 1) sel.value = hits[0].id;
      }
    });
  }

  // ── Upload ──────────────────────────────────────────────────────────
  /**
   * The upload dialog. Folder is required — a file with nowhere to live is how
   * a document vault turns into a junk drawer. The PO field is optional and is
   * what makes the link work from this side as well as from the PO tab.
   */
  function openUpload({ folderId, files = [], poId = null, lockPo = false, projectId, procurement = null }) {
    // Default to the tab's selection, but let callers override: openAttach()
    // works against the PO's own job, which is not always the one on screen.
    if (projectId === undefined) projectId = cfg.getProjectId();
    // `procurement` is the Procurement sheet line this upload is attached to,
    // { id, label, costCode } — fixed, like a pinned PO, because the paperclip
    // it came from belongs to that one line. A file attached to a line is
    // filed under the line's cost code by the server whatever folder is picked
    // here, so that cost code's folder is the natural place to offer first.
    const procCode = procurement ? String(procurement.costCode == null ? '' : procurement.costCode).trim() : '';
    if (!folderId && procurement) folderId = (costCodeFolderFor(procCode) || {}).id || '';
    if (!folderId) folderId = defaultFolderForPo(poId, projectId);
    const procLine = procurement ? `
        <div id="fctdoc-proc" data-proc-id="${esc(procurement.id)}"
             title="Fixed: this upload is attached to the procurement line it was opened from"
             style="${S.input};width:100%;box-sizing:border-box;opacity:0.85;cursor:default">
          Procurement line: <strong>${esc(procurement.label || 'Procurement line')}</strong>
        </div>` : '';
    const procHint = !procurement ? ''
      : procCode
        ? `<div data-proc-hint style="${S.muted};margin-top:0.25rem">Filed under cost code ${esc(procCode)} as well, whichever folder you pick.</div>`
        : `<div data-proc-hint style="${S.muted};margin-top:0.25rem">This line has no cost code yet, so the file is filed only in the folder you pick.</div>`;
    const m = modal('Upload documents', `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Files</label>
          <input type="file" id="fctdoc-files" multiple style="${S.input};width:100%" />
          <div id="fctdoc-filelist" style="${S.muted};margin-top:0.35rem"></div>
        </div>
        ${procLine}
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Folder <span style="color:var(--red,#ef4444)">*</span></label>
          ${folderPickerHTML('fctdoc-folder', folderId, '— pick a folder —')}
          ${poId ? `<div style="${S.muted};margin-top:0.25rem">Filed under the purchase order as well, whichever folder you pick.</div>` : ''}
          ${procHint}
        </div>
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Link to purchase order <span style="opacity:0.7">(optional)</span></label>
          ${poPickerHTML('fctdoc-po', projectId, poId, lockPo)}
        </div>
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Note <span style="opacity:0.7">(optional)</span></label>
          <input type="text" id="fctdoc-note" placeholder="e.g. 22.14 tons" maxlength="500" style="${S.input};width:100%" />
        </div>
        <div id="fctdoc-progress" style="${S.muted}"></div>
        <div id="fctdoc-err" style="display:none;color:var(--red,#ef4444);font-size:0.78rem;white-space:pre-line"></div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button data-cancel style="${S.btn}">Cancel</button>
          <button id="fctdoc-go" style="${S.green}">Upload</button>
        </div>
      </div>`);

    wireFolderFilter(m.body, 'fctdoc-folder', '— pick a folder —');
    wirePoFilter(m.body, 'fctdoc-po', projectId);

    const fileInput = m.body.querySelector('#fctdoc-files');
    const fileList  = m.body.querySelector('#fctdoc-filelist');
    const progress  = m.body.querySelector('#fctdoc-progress');
    const errBox    = m.body.querySelector('#fctdoc-err');
    let picked = files;

    // Say what went wrong inside the dialog, not only in a toast. The toast
    // prints at the bottom of the window and clears itself after a few
    // seconds; on a tall screen it is nowhere near the middle, where the
    // dialog and the eye both are, so a refused upload read as a button that
    // does nothing.
    function fail(msg) {
      errBox.textContent = msg;
      errBox.style.display = '';
      toast(msg, 'error');
    }
    function clearFail() { errBox.textContent = ''; errBox.style.display = 'none'; }

    function showPicked() {
      fileList.innerHTML = picked.length
        ? picked.map(f => `${esc(f.name)} <span style="opacity:0.7">(${fmtBytes(f.size)})</span>`).join('<br>')
        : '';
    }
    showPicked();
    fileInput.addEventListener('change', () => {
      picked = [...fileInput.files];
      clearFail();
      showPicked();
    });

    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);

    m.body.querySelector('#fctdoc-go').addEventListener('click', async () => {
      clearFail();

      // Read the control itself rather than trusting the change event alone.
      // A change that never landed — the dialog reopened over this one, the
      // file dragged straight onto the field — left `picked` empty with the
      // file plainly sitting there, and Upload answered "pick at least one
      // file" about a file the user could see.
      if (fileInput.files && fileInput.files.length) {
        picked = [...fileInput.files];
        showPicked();
      }

      const chosenFolder = m.body.querySelector('#fctdoc-folder').value;
      const chosenPo     = m.body.querySelector('#fctdoc-po').value || null;
      const note         = m.body.querySelector('#fctdoc-note').value.trim();

      if (!picked.length)   { fail('Pick at least one file.'); return; }
      if (!chosenFolder)    { fail('Pick a folder — every file has to be filed somewhere.'); return; }

      const go = m.body.querySelector('#fctdoc-go');
      go.disabled = true;
      go.textContent = 'Uploading…';

      let done = 0, failed = 0;
      const errors = [];
      relayedThisBatch = false;
      for (const file of picked) {
        progress.textContent = `Uploading ${done + failed + 1} of ${picked.length}: ${file.name}`;
        try {
          const chosenPoRow = (cfg.getPurchaseOrders() || []).find(p => p.id === chosenPo);
          await uploadOne(file, {
            folderId: chosenFolder, poId: chosenPo,
            poNumber: chosenPoRow && chosenPoRow.po_number,
            note, projectId,
            procurementId: procurement ? procurement.id : undefined,
          });
          done++;
        } catch (err) {
          failed++;
          errors.push(`${file.name}: ${err.message}`);
        }
      }

      // Nothing landed, so there is nothing to leave for. Closing on a total
      // failure threw away the file, the folder and the note along with the
      // dialog and left only a toast that timed out — the user had to set the
      // whole thing up again to find out what had gone wrong.
      if (!done) {
        progress.textContent = '';
        go.disabled = false;
        go.textContent = 'Upload';
        fail(errors.join('\n') || 'Nothing was uploaded.');
        return;
      }

      // One toast, not two. They all print at the same spot on the screen, so
      // a success and a failure raised together simply cover each other up.
      m.close();
      const landed = `${done} file${done === 1 ? '' : 's'} uploaded.`;

      // Something in this batch could not be PUT to the bucket and went through
      // the API instead. Say it once per page: the relay is capped at 3 MB, so
      // the next set of drawings fails until the bucket gets its CORS rule.
      let relayNote = '';
      if (relayedThisBatch && !relayWarned) {
        relayWarned = true;
        relayNote = ' Storage refused a direct upload, so the bytes went through the server —'
                  + ' add a CORS rule to the bucket or anything over 3 MB will keep failing.';
      }

      if (errors.length) toast(`${landed} ${failed} failed — ${errors.join('; ')}${relayNote}`, 'error');
      else if (relayNote) toast(landed + relayNote, 'error');
      else toast(landed);

      // The upload is committed; only the refresh can still fail. Left
      // unguarded it rejected, skipped the re-render, and left a green
      // "uploaded" toast above a listing that did not contain the file — so
      // people uploaded it a second time.
      //
      // The procurement counts are refreshed BEFORE onChange fires, because
      // onChange is how the host redraws the sheet's paperclips — firing it
      // first redrew them with the old number.
      try {
        await load(projectId, { force: true });
        await refreshPoCounts();
        await refreshProcurementCounts(projectId);
        if (cfg.onChange) cfg.onChange();
        render();
      } catch (err) {
        toast(`Uploaded, but the list could not be refreshed: ${err.message}. Reopen the tab to see it.`, 'error');
      }
    });
  }

  // Ceiling on the relay below, matched to RELAY_MAX_BYTES in
  // api/document-upload-url.js. The platform caps a serverless request body at
  // 4.5 MB and base64 costs a third on top, so 3 MB of file is about all that
  // fits. Paperwork and a downscaled photo clear it; a drawing set does not.
  const RELAY_MAX_BYTES = 3 * 1024 * 1024;

  // The bucket has to be fixed properly for anything over that ceiling, so say
  // so — but once per page, not once per file in a twenty-file drop, and folded
  // into the toast the batch already raises rather than stacked on top of it.
  // Toasts all print at the same spot and simply cover each other up.
  let relayedThisBatch = false;
  let relayWarned      = false;

  /**
   * Send a file's bytes to the API and let the server put them in the bucket.
   *
   * Strictly a fallback for a direct PUT the browser could not make at all.
   * The direct path is what keeps big files off a 4.5 MB request body, so
   * anything past the ceiling still fails here, with the fix named.
   */
  async function relayThroughApi(prepared, ticket, cause) {
    const advice =
      'Could not reach file storage. If this is a new deployment the storage '
      + 'bucket most likely needs a CORS rule allowing PUT from this site — '
      + 'see api/.env.example. (' + cause.message + ')';

    if (prepared.blob.size > RELAY_MAX_BYTES) throw new Error(advice);

    let relayed;
    try {
      relayed = await api('PUT', `/document-upload-url${q({})}`, {
        storageKey:    ticket.storageKey,
        contentBase64: await blobToBase64(prepared.blob),
      });
    } catch (err) {
      // This one reached the API, so the message is the store's own answer
      // rather than the browser's opaque one — a wrong S3_ENDPOINT, a bucket
      // that does not exist, a key the credentials cannot write. Carry both:
      // what the browser saw first, then what the server saw.
      throw new Error(`${advice} Relaying it through the server failed too: ${err.message}`);
    }
    if (!relayed || !relayed.ok) throw new Error(advice);

    relayedThisBatch = true;
    console.warn('[documents] storage refused a direct upload; the bytes went through '
               + 'the API instead. The bucket needs a CORS rule allowing PUT from this '
               + 'site — see api/.env.example.');
    return { ok: true, status: 200 };
  }

  async function blobToBase64(blob) {
    if (typeof blob.arrayBuffer !== 'function') throw new Error('this browser cannot relay the file');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // btoa needs a binary string. Spreading three million bytes into
    // String.fromCharCode blows the argument limit long before that, so chunk it.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function uploadOne(file, { folderId, poId, poNumber, note, projectId, procurementId }) {
    const prepared = await maybeDownscale(file);

    // 1. Ticket. Nothing is written until step 3, so an abandoned ticket costs
    //    nothing but an unreferenced object.
    const ticket = await api('POST', `/document-upload-url${q({})}`, {
      filename: prepared.filename,
      sizeBytes: prepared.blob.size,
      projectId,
    });

    // 2. Bytes, straight to storage — never through the API.
    let put;
    try {
      put = await fetch(ticket.uploadUrl, {
        method: 'PUT',
        body: prepared.blob,
        headers: { 'Content-Type': ticket.contentType },
      });
    } catch (err) {
      // A cross-origin PUT always needs a preflight — PUT is not a safelisted
      // method — and a bucket with no CORS rule refuses it. That surfaces as a
      // bare "Failed to fetch" with nothing in any server log, because the
      // request never reached anyone. It is the first thing that goes wrong on
      // a new deployment, and nothing on the server side can detect or fix it.
      //
      // Losing the upload over it is the wrong answer when the API itself is
      // same-origin and reachable, so relay small files through that instead.
      put = await relayThroughApi(prepared, ticket, err);
    }
    if (!put.ok) throw new Error(`Upload to storage failed (${put.status})`);

    // 3. Register the metadata. If this fails the bytes are already in the
    //    bucket with nothing pointing at them — the purge sweep only walks
    //    project_documents, so an orphan is invisible and billed forever.
    //    Clean up before surfacing the error.
    try {
      return await api('POST', `/documents${q({ projectId })}`, {
        documentId: ticket.documentId,
        filename:   prepared.filename,
        storageKey: ticket.storageKey,
        sizeBytes:  prepared.blob.size,
        folderId,
        poId,
        poNumber,
        note,
        // The Procurement sheet line this file is attached to, when it came
        // from one. The server links the line and files the document under
        // the line's cost code as well; left undefined, JSON drops the key and
        // every other upload's body is exactly what it was.
        procurementId,
      });
    } catch (err) {
      try {
        await api('DELETE', `/document-upload-url${q({ storageKey: ticket.storageKey })}`);
      } catch (cleanupErr) {
        console.warn('[documents] could not remove the orphaned upload:', cleanupErr.message);
      }
      throw err;
    }
  }

  // ── New folder ──────────────────────────────────────────────────────
  function openNewFolder() {
    const m = modal('New folder', `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Name</label>
          <input type="text" id="fctdoc-fname" maxlength="120" style="${S.input};width:100%" />
        </div>
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Inside</label>
          ${folderPickerHTML('fctdoc-fparent', currentFolderId, '— top level —')}
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button data-cancel style="${S.btn}">Cancel</button>
          <button id="fctdoc-mk" style="${S.green}">Create</button>
        </div>
      </div>`);

    wireFolderFilter(m.body, 'fctdoc-fparent', '— top level —');
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    const nameInput = m.body.querySelector('#fctdoc-fname');
    nameInput.focus();

    let creating = false;
    async function create() {
      if (creating) return;   // Enter and a second click both land here
      const name = nameInput.value.trim();
      if (!name) { toast('Give the folder a name.', 'error'); return; }
      const parentId = m.body.querySelector('#fctdoc-fparent').value || null;
      creating = true;
      const mkBtn = m.body.querySelector('#fctdoc-mk');
      if (mkBtn) { mkBtn.disabled = true; mkBtn.textContent = 'Creating…'; }
      try {
        await api('POST', `/documents${q({ projectId: cfg.getProjectId(), folder: 1 })}`, { name, parentId });
        m.close();
        await load(cfg.getProjectId(), { force: true });
        // Filed inside a closed branch it would be created into thin air.
        expandTrail(parentId);
        render();
        toast('Folder created.');
      } catch (err) {
        toast(err.message, 'error');
        creating = false;
        if (mkBtn) { mkBtn.disabled = false; mkBtn.textContent = 'Create'; }
      }
    }
    m.body.querySelector('#fctdoc-mk').addEventListener('click', create);
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
  }

  // ── Preview / download ──────────────────────────────────────────────
  async function signedUrl(id, inline) {
    return api('GET', `/document-download${q({ id, inline: inline ? 1 : '' })}`);
  }

  async function downloadDoc(id) {
    // Open the tab synchronously, inside the click. Calling window.open after
    // an awaited round trip loses the user-gesture context: iOS Safari blocks
    // it outright and desktop browsers block it whenever the request is slow
    // enough — a cold start or jobsite LTE.
    //
    // NOT 'noopener': per the HTML standard window.open returns null when that
    // feature is set, so the handle is always null, the tab is left blank, and
    // the fallback below navigates the whole app away from the page the user
    // was on. Clearing tab.opener afterwards gives the same isolation while
    // keeping the handle.
    let tab = null;
    try { tab = window.open('', '_blank'); } catch { tab = null; }
    if (tab) { try { tab.opener = null; } catch { /* cross-origin already */ } }

    try {
      const { url } = await signedUrl(id, false);
      if (tab && !tab.closed) {
        tab.location = url;
      } else {
        // The popup blocker won. Don't navigate the app away — hand the user a
        // link they can click, which counts as a fresh gesture.
        toast('Your browser blocked the download tab. Tap the file name again to retry.', 'error');
      }
    } catch (err) {
      if (tab && !tab.closed) tab.close();
      toast(err.message, 'error');
    }
  }

  async function openPreview(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    let info;
    try {
      info = await signedUrl(id, true);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const linkedPos = (doc.po_ids || []).map(poId => {
      const po = (cfg.getPurchaseOrders() || []).find(p => p.id === poId);
      return po ? `${po.po_number || po.id}${po.supplier ? ` — ${po.supplier}` : ''}` : poId;
    });
    // A count rather than names: this module has no copy of the Procurement
    // sheet to name the lines from, and the sheet's own paperclip is where a
    // line's files are listed.
    const procLines = (doc.procurement_ids || []).length;

    const viewer = !info.inline
      ? `<div style="${S.muted};padding:2rem;text-align:center">
           No preview for this file type. Download it to open it.
         </div>`
      : (doc.content_type === 'text/plain' || doc.content_type === 'text/csv')
        // Declared inline-safe by the download route, but the viewer only had
        // an image branch — a .txt preview rendered as a broken image.
        ? `<iframe src="${esc(info.url)}" sandbox=""
                   style="width:100%;height:65vh;border:1px solid var(--border,#2a2a3a);border-radius:4px;background:var(--surface2,#1a1a26)"></iframe>`
      : doc.content_type === 'application/pdf'
        // sandbox with allow-scripts only: a PDF viewer needs script, but the
        // frame gets no same-origin access, no form submission, and crucially
        // no allow-top-navigation, so nothing inside it can move the page the
        // user is on. The download route also pins the served Content-Type, so
        // a file registered as a PDF cannot come back as HTML in the first
        // place — this is the second line of defence.
        ? `<iframe src="${esc(info.url)}" sandbox="allow-scripts"
                   style="width:100%;height:65vh;border:1px solid var(--border,#2a2a3a);border-radius:4px"></iframe>`
        : `<img src="${esc(info.url)}" alt="${esc(doc.filename)}"
                style="max-width:100%;max-height:65vh;display:block;margin:0 auto;border-radius:4px" />`;

    const m = modal(doc.filename, `
      ${viewer}
      <div style="margin-top:0.85rem;display:flex;flex-wrap:wrap;gap:0.6rem;align-items:center;${S.muted}">
        <span>${fmtBytes(doc.size_bytes)}</span>
        <span>·</span>
        <span>Uploaded by ${esc(doc.uploaded_by || 'unknown')} on ${fmtDate(doc.uploaded_at)}</span>
        ${doc.note ? `<span>·</span><span>${esc(doc.note)}</span>` : ''}
      </div>
      ${linkedPos.length ? `<div style="margin-top:0.4rem;font-size:0.8rem;color:var(--green,#22c55e)">
          &#128206; Linked to ${linkedPos.map(esc).join(', ')}
        </div>` : ''}
      ${procLines ? `<div data-proc-linked style="margin-top:0.4rem;font-size:0.8rem;color:var(--blue,#60a5fa)">
          &#128230; On ${procLines} procurement line${procLines === 1 ? '' : 's'}
        </div>` : ''}
      <div style="margin-top:0.4rem;${S.muted}">
        Filed in ${(doc.folder_ids || []).map(fid => esc(folderById(fid)?.name || '—')).join(', ') || '—'}
      </div>
      <div style="margin-top:1rem;display:flex;justify-content:flex-end;gap:0.5rem">
        <button data-dl style="${S.btn}">&#11015; Download</button>
        ${caps.canUpload ? `<button data-link style="${S.btn}">&#128206; Link to PO</button>` : ''}
        ${caps.canDelete ? `<button data-del style="${S.btn};border-color:var(--red,#ef4444);color:var(--red,#ef4444)">Delete</button>` : ''}
      </div>`, { wide: true });

    m.body.querySelector('[data-dl]').addEventListener('click', () => downloadDoc(id));
    m.body.querySelector('[data-link]')?.addEventListener('click', () => { m.close(); openLinkToPo(id); });
    m.body.querySelector('[data-del]')?.addEventListener('click', () => { m.close(); deleteDoc(id); });
  }

  // ── Link an existing document to a PO ───────────────────────────────
  function openLinkToPo(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;
    const projectId = cfg.getProjectId();

    const m = modal('Link to purchase order', `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div style="${S.muted}">${esc(doc.filename)}</div>
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Purchase order</label>
          ${poPickerHTML('fctdoc-linkpo', projectId, null, false)}
        </div>
        ${(doc.po_ids || []).length ? `
          <div>
            <div style="${S.muted};margin-bottom:0.25rem">Already linked to</div>
            ${doc.po_ids.map(poId => {
              const po = (cfg.getPurchaseOrders() || []).find(p => p.id === poId);
              const label = po ? poLabel(po) : poId;
              return `<div style="display:flex;align-items:center;gap:0.5rem;font-size:0.8rem;padding:0.2rem 0">
                        <span style="flex:1 1 auto">${esc(label)}</span>
                        <button data-unlink="${esc(poId)}" style="${S.btn}">Remove</button>
                      </div>`;
            }).join('')}
          </div>` : ''}
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button data-cancel style="${S.btn}">Close</button>
          <button id="fctdoc-dolink" style="${S.green}">Link</button>
        </div>
      </div>`);

    wirePoFilter(m.body, 'fctdoc-linkpo', projectId);
    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);

    m.body.querySelector('#fctdoc-dolink').addEventListener('click', async () => {
      const poId = m.body.querySelector('#fctdoc-linkpo').value;
      if (!poId) { toast('Pick a purchase order.', 'error'); return; }
      try {
        // poNumber names the PO's subfolder. Without it the server fell back to
        // a slice of the internal id — 'PO 8f14e45f' — and because the folder is
        // matched by slug from then on, that placeholder was permanent.
        const poRow = (cfg.getPurchaseOrders() || []).find(p => p.id === poId);
        await api('PATCH', `/documents${q({ id })}`, {
          addPoId: poId,
          poNumber: poRow && poRow.po_number,
        });
        m.close();
        await load(projectId, { force: true });
        await refreshPoCounts();
        await refreshProcurementCounts(projectId);
        if (cfg.onChange) cfg.onChange();
        render();
        toast('Linked.');
      } catch (err) { toast(err.message, 'error'); }
    });

    m.body.querySelectorAll('[data-unlink]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api('PATCH', `/documents${q({ id })}`, { removePoId: btn.dataset.unlink });
          m.close();
          await load(projectId, { force: true });
          await refreshPoCounts();
          await refreshProcurementCounts(projectId);
          if (cfg.onChange) cfg.onChange();
          render();
          toast('Unlinked. The file is still in its folder.');
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  // The job a document belongs to, for recounting the procurement lines on
  // it. Falls back to `otherwise` for a document row that does not say.
  function jobOf(doc, otherwise) {
    return doc && doc.project_id !== undefined ? (doc.project_id || null) : otherwise;
  }

  // ── Delete ──────────────────────────────────────────────────────────
  function deleteDoc(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;
    const m = modal('Delete document', `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div>Delete <strong>${esc(doc.filename)}</strong>?</div>
        <div style="${S.muted}">
          It moves to the deleted bin and can be restored for 30 days. Every delete is
          recorded against your name.
        </div>
        <div style="display:flex;justify-content:flex-end;gap:0.5rem">
          <button data-cancel style="${S.btn}">Cancel</button>
          <button data-yes style="${S.btn};border-color:var(--red,#ef4444);color:var(--red,#ef4444)">Delete</button>
        </div>
      </div>`);

    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.body.querySelector('[data-yes]').addEventListener('click', async () => {
      try {
        await api('DELETE', `/documents${q({ id })}`);
        m.close();
        await load(cfg.getProjectId(), { force: true });
        await refreshPoCounts();
        // A deleted file stops counting on every procurement line it was on —
        // and those lines are on the file's own job.
        await refreshProcurementCounts(jobOf(doc, cfg.getProjectId()));
        if (cfg.onChange) cfg.onChange();
        render();
        toast('Deleted. Recoverable for 30 days.');
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ── Deleted bin ─────────────────────────────────────────────────────
  /**
   * The other half of the soft delete. deleteDoc() has always told the user a
   * file is "recoverable for 30 days" — this is what makes that true. Admin
   * only, matching the API, which gates both the listing and the restore.
   */
  async function openTrash() {
    let deleted = [];
    try {
      deleted = (await api('GET', `/documents${q({ trash: 1 })}`)).documents || [];
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    const rows = deleted.length
      ? deleted.map(d => `
          <div style="display:flex;align-items:center;gap:0.6rem;padding:0.5rem 0;
                      border-bottom:1px solid var(--border,#2a2a3a);font-size:0.82rem">
            <span>${iconFor(d)}</span>
            <div style="flex:1 1 auto;min-width:0">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.filename)}</div>
              <div style="${S.muted}">
                ${fmtBytes(d.size_bytes)} · uploaded by ${esc(d.uploaded_by || 'unknown')}
                · deleted ${fmtDate(d.deleted_at)}
              </div>
            </div>
            <button data-restore="${esc(d.id)}" style="${S.green}">Restore</button>
          </div>`).join('')
      : `<div style="${S.muted};padding:1rem 0;text-align:center">Nothing has been deleted in the last 30 days.</div>`;

    const m = modal('Deleted documents', `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div style="${S.muted}">
          Deleted files stay here for 30 days and are then removed permanently,
          along with the stored file. Everything on this list can still be restored.
        </div>
        <div>${rows}</div>
        <div style="display:flex;justify-content:flex-end">
          <button data-cancel style="${S.btn}">Close</button>
        </div>
      </div>`, { wide: true });

    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.body.querySelectorAll('[data-restore]').forEach(btn => {
      btn.addEventListener('click', async () => {
        // The bin lists every job's files, so the one restored is not
        // necessarily on the job the tab is showing. Note its own job now,
        // while the row is in hand, to recount the procurement lines on it.
        const restoredJob = jobOf(deleted.find(d => d.id === btn.dataset.restore), cfg.getProjectId());
        btn.disabled = true;
        btn.textContent = 'Restoring…';
        try {
          await api('PATCH', `/documents${q({ id: btn.dataset.restore })}`, { restore: true });
          m.close();
          await load(cfg.getProjectId(), { force: true });
          await refreshPoCounts();
          await refreshProcurementCounts(restoredJob);
          if (cfg.onChange) cfg.onChange();
          render();
          toast('Restored.');
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Restore';
          toast(err.message, 'error');
        }
      });
    });
  }

  // ── Bid-page side ───────────────────────────────────────────────────
  /**
   * The folder chip on the bid page's green cost-code bar. Lists everything
   * filed under that cost code — the folder itself and any subfolders someone
   * made inside it — and offers an upload that lands straight in it.
   *
   * A dialog rather than a jump to the Documents tab on purpose: the whole
   * point of the chip is reaching a drawing without losing your place halfway
   * down a two-hundred-line bid, and on tracker.html the bid table is a
   * fullscreen overlay that switching tabs would have had to close.
   */
  // One chip opening at a time. Two clicks on a slow connection used to start
  // two loads, and the first one to come back lost the generation race and
  // toasted "something else loaded while that was opening" — an error, over a
  // dialog that had opened perfectly well from the second click.
  let ccOpening = false;

  /**
   * Opens the folder dialog for one cost code on one job. Resolves true when
   * the dialog opened, 'missing' when the job has no folder for the code (and
   * the user has been told why), and false or undefined when nothing opened
   * for any other reason — already said, or another chip still opening.
   *
   * `fresh` reads the job again even when the browser is already sitting on
   * it. The Procurement sheet asks this way: the server moves a line's files
   * between cost-code folders whenever the line is re-coded, and a colleague
   * attaches files, and neither reaches the copy in hand — trusting it listed
   * "Nothing filed here yet" for files that were in the folder. The bid page
   * keeps the cached copy; its codes only move when this browser moves them.
   */
  async function openCostCodeFolder(opts) {
    if (ccOpening) return undefined;
    ccOpening = true;
    try { return await _openCostCodeFolder(opts || {}); }
    finally { ccOpening = false; }
  }

  // Whether `code` is one of the job's bid cost codes (the ones the folder
  // seed makes folders for), read the way the Procurement sheet reads codes.
  function onJobBid(projectId, code) {
    const key = codeKey(code);
    if (!key) return false;
    let list = [];
    try { list = cfg.getCostCodes(projectId) || []; } catch { list = []; }
    return list.some(c => codeKey(typeof c === 'string' ? c : c && c.code) === key);
  }

  // What to say when a job has no folder for `code`, and whether that is a
  // fault. Run after a load (which seeds the bid's codes), so a code that is
  // not on the bid is simply one nothing has been filed under yet: the server
  // makes its folder when the first file is attached to a line carrying it,
  // and until then there is nothing to show, to anyone. A code that IS on the
  // bid should have been seeded on the way in — that failed, for a user who
  // may not create folders or for some passing reason.
  function missingFolderMessage(projectId, code) {
    if (!onJobBid(projectId, code)) {
      return {
        kind: 'info',
        text: `No document folder for cost code ${code} yet — nothing has been filed under it. `
          + 'Its folder is made when the first file is attached to a line with this code.',
      };
    }
    return {
      kind: 'error',
      text: caps.canUpload
        ? `No document folder for cost code ${code} on this job. It could not be set up just now — try again, or open the job's Documents tab.`
        : `Cost code ${code} has no folder yet, and creating one needs edit access.`,
    };
  }

  async function _openCostCodeFolder({ projectId = null, costCode, label = '', fresh = false }) {
    const code = String(costCode == null ? '' : costCode).trim();
    if (!code) {
      toast('That group has no cost code yet, so there is no folder to open.', 'error');
      return false;
    }

    // The bid page is routinely open on a job the Documents tab is not sitting
    // on, so load that scope first — and honour the same generation guard
    // openAttach() uses. Without it, two chips clicked in quick succession
    // could list the second job's folder under the first job's heading.
    // A fresh open loads even the job in hand (see openCostCodeFolder).
    let loadedNow = false;
    if (fresh || loadedFor !== projectId || scopeBehind) {
      let ok;
      try { ok = await load(projectId, { force: true }); }
      catch (err) { toast(err.message, 'error'); return false; }
      if (!ok) {
        toast('Something else loaded while that was opening. Try the folder again.', 'error');
        return false;
      }
      loadedNow = true;
    }

    // Exact first, then one that reads the same on screen (another letter
    // case, a dash typed another way) — the same rule the server files a
    // procurement attachment by, so the chip on a procurement section headed
    // "stormwater" opens the "Stormwater" folder its files are in.
    let folder = costCodeFolderFor(code);

    // A cost code typed into the green bar since the last load has no folder
    // yet — nothing creates one but the seed that runs on the way into load(),
    // and the browser can have been sitting on this job since before the code
    // existed. One forced reload settles it, rather than telling someone their
    // brand-new cost code has no folder when it is one request from having one.
    if (!folder && !loadedNow) {
      let ok = false;
      try { ok = await load(projectId, { force: true }); } catch { /* keep the message below */ }
      if (ok) { folder = costCodeFolderFor(code); loadedNow = true; }
    }

    if (!folder) {
      // A load ran either way, and its counts are the ones the chip should be
      // drawing from now.
      if (loadedNow && cfg.onChange) cfg.onChange();
      const why = missingFolderMessage(projectId, code);
      toast(why.text, why.kind === 'error' ? 'error' : undefined);
      return 'missing';
    }

    // A load ran, which means the counts the bid page drew its chips from are
    // older than what this dialog is about to list — someone else filed a
    // drawing since. Nudge the host to repaint, so the chip does not still say
    // nothing over a dialog showing three files.
    if (loadedNow && cfg.onChange) cfg.onChange();

    // The folder and any other folder for the same code (sameCodeFolders),
    // with everything under them: exactly what the chip counted.
    const roots = sameCodeFolders(folder, folders);
    const rootIds = new Set(roots.map(f => f.id));
    const ids  = subtreesOf(roots, folders);
    const here = documents
      .filter(d => (d.folder_ids || []).some(id => ids.has(id)))
      .sort((a, b) => String(b.uploaded_at || '').localeCompare(String(a.uploaded_at || '')));

    // Name the subfolder a document actually sits in, but only when it is not
    // the cost-code folder itself — printing "420 · Paving" against every row
    // in the 420 dialog is noise.
    const nameOf = {};
    for (const f of folders) nameOf[f.id] = f.name;
    const subOf = d => {
      const at = (d.folder_ids || []).find(id => ids.has(id) && !rootIds.has(id));
      return at ? nameOf[at] : '';
    };

    const title = folder.name || (label ? `${code} · ${label}` : code);
    const m = modal(title, `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div>
          <div style="${S.muted};margin-bottom:0.35rem">${here.length} document${here.length === 1 ? '' : 's'} filed under this cost code</div>
          ${here.length ? here.map(d => `
            <div style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--border,#2a2a3a);font-size:0.82rem">
              <span>${iconFor(d)}</span>
              <div style="flex:1 1 auto;min-width:0">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.filename)}</div>
                <div style="${S.muted}">${fmtBytes(d.size_bytes)} · ${esc(d.uploaded_by || 'unknown')} · ${fmtDate(d.uploaded_at)}${d.note ? ` · ${esc(d.note)}` : ''}${subOf(d) ? ` · in ${esc(subOf(d))}` : ''}</div>
              </div>
              <button data-ccdl="${esc(d.id)}" style="${S.btn}" title="Download">&#11015;</button>
            </div>`).join('')
            : `<div style="${S.muted};padding:0.75rem 0">Nothing filed here yet.</div>`}
        </div>
        ${caps.canUpload ? `
          <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button data-cancel style="${S.btn}">Close</button>
            <button data-ccnew style="${S.green}">&#11014; Upload to this folder</button>
          </div>`
          : `<div style="display:flex;justify-content:flex-end"><button data-cancel style="${S.btn}">Close</button></div>`}
      </div>`, { wide: true });

    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.body.querySelectorAll('[data-ccdl]').forEach(b =>
      b.addEventListener('click', () => downloadDoc(b.dataset.ccdl)));

    m.body.querySelector('[data-ccnew]')?.addEventListener('click', () => {
      m.close();
      // The folder is the one the chip was clicked on — that is the whole
      // saving over the Upload button in the Documents tab, which opens on a
      // "pick a folder" the user then has to find the cost code in.
      openUpload({ folderId: folder.id, projectId });
    });
    return true;
  }

  // ── Purchase-order side ─────────────────────────────────────────────
  /**
   * The paperclip on a PO row. Lists what is attached, and offers an upload
   * that files the document on the job AND under the PO in one action.
   */
  async function openAttach(po) {
    const projectId = po.project_id || null;

    // A PO can belong to a different job than the one on screen, and a non-job
    // PO belongs to the General area — either way, load that scope's folders
    // so the filing picker offers the right ones. The job in hand is read
    // again too when a poll has found its copy behind (scopeBehind): the
    // picker is built from that copy, and a PO subfolder the server made
    // since would be missing from it, leaving the order's paperwork defaulted
    // into the Purchase Orders root.
    if (loadedFor !== projectId || scopeBehind) {
      let fresh;
      try { fresh = await load(projectId, { force: true }); }
      catch (err) { toast(err.message, 'error'); return; }
      // Something else — the job picker, another paperclip — started a load
      // while this one was in flight and won. The module state now describes a
      // different job, so opening this modal would offer that job's folders as
      // places to file a document against THIS purchase order.
      if (!fresh) {
        toast('Something else loaded while that was opening. Try the paperclip again.', 'error');
        return;
      }
    }

    let attached = [];
    try {
      attached = (await api('GET', `/documents${q({ poId: po.id })}`)).documents || [];
    } catch (err) { toast(err.message, 'error'); return; }

    const title = `PO ${po.po_number || po.id}${po.supplier ? ` — ${po.supplier}` : ''}`;
    const m = modal(title, `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div>
          <div style="${S.muted};margin-bottom:0.35rem">${attached.length} attached document${attached.length === 1 ? '' : 's'}</div>
          ${attached.length ? attached.map(d => `
            <div style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--border,#2a2a3a);font-size:0.82rem">
              <span>${iconFor(d)}</span>
              <div style="flex:1 1 auto;min-width:0">
                <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.filename)}</div>
                <div style="${S.muted}">${fmtBytes(d.size_bytes)} · ${esc(d.uploaded_by || 'unknown')} · ${fmtDate(d.uploaded_at)}${d.note ? ` · ${esc(d.note)}` : ''}</div>
              </div>
              <button data-adl="${esc(d.id)}" style="${S.btn}">&#11015;</button>
            </div>`).join('')
            : `<div style="${S.muted};padding:0.75rem 0">Nothing attached yet.</div>`}
        </div>
        ${caps.canUpload ? `
          <div style="display:flex;justify-content:flex-end;gap:0.5rem">
            <button data-cancel style="${S.btn}">Close</button>
            <button data-attach-new style="${S.green}">&#11014; Attach a document</button>
          </div>`
          : `<div style="display:flex;justify-content:flex-end"><button data-cancel style="${S.btn}">Close</button></div>`}
      </div>`, { wide: true });

    m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
    m.body.querySelectorAll('[data-adl]').forEach(b =>
      b.addEventListener('click', () => downloadDoc(b.dataset.adl)));

    m.body.querySelector('[data-attach-new]')?.addEventListener('click', () => {
      m.close();
      // The PO is fixed; the job folder is the choice the user still has to
      // make, which is what keeps a ticket findable from the job as well.
      openUpload({ folderId: null, poId: po.id, lockPo: true, projectId });
    });
  }

  // ── Procurement-line side ───────────────────────────────────────────
  // Make sure the module state describes `projectId`'s folders. Resolves
  // 'already' when it did, 'loaded' when it does now, and false — after saying
  // why — when it cannot: the load failed, or another load started while this
  // one was in flight and won, so the state now belongs to a different job.
  // `force` reads the job again even when it is the one in hand.
  async function loadScope(projectId, again, { force = false } = {}) {
    if (!force && loadedFor === projectId && !scopeBehind) return 'already';
    let fresh;
    try { fresh = await load(projectId, { force: true }); }
    catch (err) { toast(err.message, 'error'); return false; }
    if (!fresh) {
      toast(`Something else loaded while that was opening. ${again}`, 'error');
      return false;
    }
    return 'loaded';
  }

  // The list a line's dialog just fetched is the freshest count there is for
  // that line. When the paperclip the user clicked was drawing a different
  // number — someone else attached a file since the sheet last counted —
  // correct it. Reports whether anything changed, so the caller knows whether
  // the host has something to redraw.
  function noteProcurementCount(projectId, rowId, n) {
    const key = projectId || '';
    const forJob = own(procCounts, key) || (procCounts[key] = {});
    if ((own(forJob, rowId) || 0) === n) return false;
    if (n > 0) forJob[rowId] = n; else delete forJob[rowId];
    return true;
  }

  /**
   * The paperclip on a line of the Procurement sheet. Lists what is attached
   * to that line and offers an upload that, in one action, files the document
   * on the job, attaches it to the line, and — the server does this part —
   * files it under the line's cost code as well. That last step is what makes
   * a cost code's folder compile every attachment for its section of the
   * sheet without anyone filing anything twice.
   *
   * `line` is { id, project_id, cost_code, sub_code, label }. cost_code is the
   * line's live code as the sheet shows it (the bid line's, when the line is
   * tied to one), already trimmed; label is what the dialog calls the line.
   */
  // One paperclip opening at a time — two clicks on a slow connection started
  // two loads, and the loser toasted an error over a dialog that opened fine.
  let procOpening = false;

  async function openProcurementAttach(line) {
    if (procOpening) return;
    procOpening = true;
    try { return await _openProcurementAttach(line || {}); }
    finally { procOpening = false; }
  }

  async function _openProcurementAttach(line) {
    const rowId     = String(line.id == null ? '' : line.id).trim();
    const projectId = line.project_id || null;
    const code      = String(line.cost_code == null ? '' : line.cost_code).trim();
    const label     = String(line.label == null ? '' : line.label).trim() || 'Procurement line';

    if (!rowId) {
      toast('That line has not been saved yet, so nothing can be attached to it.', 'error');
      return;
    }
    // procurement_items.project_id is NOT NULL, so this is a host bug rather
    // than a user mistake — but listing without a job would have asked the
    // server for the line's files across every job in the division.
    if (!projectId) {
      toast('That line is not on a job, so nothing can be attached to it.', 'error');
      return;
    }

    // The sheet is routinely on a job the Documents tab is not, and the upload
    // dialog builds its folder picker from whatever is loaded — so load the
    // line's job first, under the same generation guard openAttach() uses.
    let scope = await loadScope(projectId, 'Try the paperclip again.');
    if (!scope) return;

    // Scoped to the job as well as the line: a row id is unique on its own,
    // but a file can only ever be attached to a line on its own job, and
    // saying so keeps the server's answer honest if that ever drifts.
    const listAttached = async () =>
      (await api('GET', `/documents${q({ procurementId: rowId, projectId })}`)).documents || [];

    let attached;
    try { attached = await listAttached(); }
    catch (err) { toast(err.message, 'error'); return; }

    // The line holds a file the copy of the job in hand has never seen — a
    // colleague attached it since this browser loaded the job. Whatever else
    // changed with it (which cost-code folder it went into, a folder the
    // server made for a new code) is missing from that copy too, and the
    // upload dialog's folder picker and the cost-code folder are both built
    // from it. Read the job again before offering either. A failed read keeps
    // the copy in hand; the list above is right regardless.
    if (scope === 'already') {
      const known = new Set(documents.map(d => d.id));
      if (attached.some(d => !known.has(d.id))) {
        let ok = null;
        try { ok = await load(projectId, { force: true }); }
        catch (err) { console.warn('[documents] reading the job again failed:', err.message); }
        if (ok === false) {
          toast('Something else loaded while that was opening. Try the paperclip again.', 'error');
          return;
        }
        if (ok) scope = 'loaded';
      }
    }

    // A load ran (the cost-code chips on the sheet's section headers count off
    // what it fetched), or the paperclip was showing a stale number. Either
    // way the host has something to redraw, the same nudge openCostCodeFolder
    // gives the bid page.
    const countMoved = noteProcurementCount(projectId, rowId, attached.length);
    if ((scope === 'loaded' || countMoved) && cfg.onChange) cfg.onChange();

    // The label usually carries the cost code already ("Stormwater /
    // Geofabric"); say it again only when it does not.
    const title = code && !label.toLowerCase().includes(code.toLowerCase())
      ? `${label} · cost code ${code}`
      : label;
    const m = modal(title, '', { wide: true });

    // Detach is the server's rule, mirrored so nobody is offered a button that
    // only answers 403: a manager may detach anything, an uploader only what
    // they uploaded themselves.
    let me = '';
    try { me = typeof cfg.getUserName === 'function' ? String(cfg.getUserName() || '') : ''; }
    catch { me = ''; }
    const mayDetach = d => Boolean(caps.canManage
      || (caps.canUpload && me !== '' && d.uploaded_by === me));

    // Drawn into the dialog's body rather than built once, so a detach can
    // redraw the list in place instead of closing and reopening the dialog.
    function draw(docs) {
      m.body.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:0.85rem">
          <div>
            <div style="${S.muted};margin-bottom:0.35rem">${docs.length} attached document${docs.length === 1 ? '' : 's'}</div>
            <div data-proc-filing style="${S.muted};margin-bottom:0.5rem">${code
              ? `Files attached here are also filed in the ${esc(code)} cost-code folder.`
              : 'This line has no cost code yet, so files attached here are filed only in the folder picked for them.'}</div>
            ${docs.length ? docs.map(d => `
              <div data-proc-doc="${esc(d.id)}" style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--border,#2a2a3a);font-size:0.82rem">
                <span>${iconFor(d)}</span>
                <div style="flex:1 1 auto;min-width:0">
                  <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.filename)}</div>
                  <div style="${S.muted}">${fmtBytes(d.size_bytes)} · ${esc(d.uploaded_by || 'unknown')} · ${fmtDate(d.uploaded_at)}${d.note ? ` · ${esc(d.note)}` : ''}</div>
                </div>
                <button data-pdl="${esc(d.id)}" style="${S.btn}" title="Download">&#11015;</button>
                ${mayDetach(d) ? `<button data-detach="${esc(d.id)}" style="${S.btn}"
                        title="Take this file off this procurement line. The file is not deleted: it stays in the Vault, in every folder it is filed in.">Detach</button>` : ''}
              </div>`).join('')
              : `<div style="${S.muted};padding:0.75rem 0">Nothing attached yet.</div>`}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:0.5rem;flex-wrap:wrap">
            <button data-cancel style="${S.btn}">Close</button>
            ${code ? `<button data-open-folder style="${S.btn}" title="Everything filed under cost code ${esc(code)} on this job">&#128193; Open ${esc(code)} folder</button>` : ''}
            ${caps.canUpload ? `<button data-attach-new style="${S.green}">&#11014; Attach a document</button>` : ''}
          </div>
        </div>`;

      m.body.querySelector('[data-cancel]').addEventListener('click', m.close);
      m.body.querySelectorAll('[data-pdl]').forEach(b =>
        b.addEventListener('click', () => downloadDoc(b.dataset.pdl)));

      // The cost code's whole folder, not just this line's share of it — the
      // other lines in the section file there too.
      //
      // The job is read again first, as the sheet's own folder chip does: the
      // server re-files a line's files when its code changes, and makes a
      // code's folder when the first file is attached, and the copy in hand
      // has neither. This dialog stays up until the folder is known to exist.
      // A code that has none yet — one that is not on the job's bid and has
      // nothing filed under it — has nothing to open, and closing this dialog
      // first left the user with an error message and nothing on screen.
      m.body.querySelector('[data-open-folder]')?.addEventListener('click', async ev => {
        const btn = ev.currentTarget;
        if (btn.disabled) return;
        const was = btn.innerHTML;
        btn.disabled = true;
        btn.textContent = 'Opening…';
        const ok = await loadScope(projectId, 'Try the folder again.', { force: true });
        if (!document.body.contains(m.el)) return;            // closed meanwhile
        btn.disabled = false;
        btn.innerHTML = was;
        if (!ok) return;
        // The load recounted the job; the sheet's chips should hear about it
        // whichever way this goes.
        if (cfg.onChange) cfg.onChange();
        if (!costCodeFolderFor(code)) {
          const note = m.body.querySelector('[data-proc-filing]');
          const why = missingFolderMessage(projectId, code);
          if (why.kind === 'error') { toast(why.text, 'error'); return; }
          if (note) note.textContent = `Nothing is filed under cost code ${code} yet, so it has no folder to open. `
            + 'Its folder is made when the first file is attached to a line with this code.';
          btn.remove();
          return;
        }
        m.close();
        // Just read, so the folder dialog lists from it without a second read.
        openCostCodeFolder({ projectId, costCode: code, label: '' });
      });

      m.body.querySelector('[data-attach-new]')?.addEventListener('click', async () => {
        m.close();
        // Nothing should have moved the browser off this job while the dialog
        // was up, but the upload dialog's folder picker is built from whatever
        // is loaded, and offering another job's folders here would file a
        // document against this line in a folder it can never be found from.
        if (!(await loadScope(projectId, 'Try the paperclip again.'))) return;
        // The line is fixed; the folder is still the user's call, opened on
        // the cost code's own folder because that is where the server is
        // filing the document anyway. No folder for the code (or no code) and
        // the picker opens blank, so the user has to choose one.
        const ccFolder = costCodeFolderFor(code);
        openUpload({
          folderId: ccFolder ? ccFolder.id : null,
          procurement: { id: rowId, label, costCode: code },
          projectId,
        });
      });

      m.body.querySelectorAll('[data-detach]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const d = docs.find(x => x.id === btn.dataset.detach);
          if (!d) return;
          let ok = false;
          try {
            ok = window.confirm(`Detach ${d.filename} from ${label}?\n\n`
              + 'The file is not deleted. It stays in the Vault, in every folder it is filed in.');
          } catch { ok = false; }
          if (!ok) return;

          btn.disabled = true;
          btn.textContent = 'Detaching…';
          try {
            await api('PATCH', `/documents${q({ id: d.id })}`, { removeProcurementId: rowId });
          } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Detach';
            toast(err.message, 'error');
            return;
          }

          // The detach is committed; only the refresh can fail from here. The
          // counts are refreshed before onChange fires, since onChange is how
          // the host redraws the paperclip that is about to read one fewer.
          let fresh = null, stale = null;
          try {
            await load(projectId, { force: true });
            await refreshProcurementCounts(projectId);
            fresh = await listAttached();
          } catch (err) { stale = err; }
          // Failing a fresh list, the best answer left is the one on screen
          // minus the file just detached — never a Detach button on a file
          // that is no longer attached, nor a paperclip one too high.
          const shown = fresh || docs.filter(x => x.id !== d.id);
          noteProcurementCount(projectId, rowId, shown.length);
          // The host is told whatever did or did not refresh: the line
          // really did lose a file, and its paperclip should say so.
          try {
            if (cfg.onChange) cfg.onChange();
            render();
          } catch (err) { stale = stale || err; }
          if (stale) toast(`Detached, but the list could not be refreshed: ${stale.message}`, 'error');
          else toast('Detached. The file is still in the Vault, in every folder it was filed in.');
          // Redraw only a dialog that is still up.
          if (document.body.contains(m.el)) draw(shown);
        });
      });
    }

    draw(attached);
  }

  // ── Public API ──────────────────────────────────────────────────────
  window.FCTDocuments = {
    configure(opts) {
      cfg = { ...cfg, ...opts };
      caps = { ...cfg.perm };
    },

    /** Render the Documents tab into `el` for the currently selected project. */
    async renderTab(el) {
      mountEl = el;
      const projectId = cfg.getProjectId();
      mountEl.innerHTML = `<div style="${S.muted};padding:1.5rem">Loading documents…</div>`;
      try {
        await load(projectId, { force: true });
        currentFolderId = null;
        search = '';
        folderSearch = '';
        expanded.clear();
        render();
      } catch (err) {
        mountEl.innerHTML = `<div style="color:var(--red,#ef4444);padding:1.5rem">
          Could not load documents: ${esc(err.message)}</div>`;
      }
    },

    openAttach,
    openTrash,
    refreshPoCounts,
    poCount(poId) { return poCounts[poId] || 0; },
    get counts() { return poCounts; },

    openCostCodeFolder,
    refreshCostCodeCounts,
    /** Documents filed under one cost code on one job, 0 until counted. */
    costCodeCount(projectId, code) {
      const forJob = ccCounts[projectId || ''];
      if (!forJob) return 0;
      const want = String(code == null ? '' : code).trim();
      if (Object.prototype.hasOwnProperty.call(forJob, want)) return forJob[want] || 0;
      // Then the first code that reads the same on screen (codeKey) — the
      // same fallback, in the same folder order, costCodeFolderFor takes.
      // The server files a procurement line's attachment into its cost
      // code's folder by that rule, so a sheet section headed "stormwater" is
      // counting the "Stormwater" folder its files actually went into.
      const key = codeKey(want);
      const near = key && Object.keys(forJob).find(k => codeKey(k) === key);
      return (near && forJob[near]) || 0;
    },

    openProcurementAttach,
    refreshProcurementCounts,
    /** Documents attached to one Procurement sheet line, 0 until counted. */
    procurementCount(projectId, rowId) {
      const forJob = own(procCounts, projectId || '');
      return (forJob && own(forJob, String(rowId == null ? '' : rowId))) || 0;
    },

    // exercised by scripts/test-documents-frontend.js — the upload sequence is
    // the one part of this file a static read cannot confirm.
    _uploadOne: uploadOne,
    _maybeDownscale: maybeDownscale,
    // …and the cost-code normalising, held to tracker's _codeKey and the
    // server's codeKey character for character.
    _codeKey: codeKey,
    // …and the folder chips' count, held to the server's copy
    // (api/lib/cost-code-counts.js, behind ?costCodeCounts=1).
    _countByCostCode: countByCostCode,
  };
})();
