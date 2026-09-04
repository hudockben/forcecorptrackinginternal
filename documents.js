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
 *   });
 *
 * then calls FCTDocuments.renderTab(mountEl) when the tab opens, and
 * FCTDocuments.openAttach(po) from a PO row.
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

  // Bumped by every load(). A response whose generation is stale — because the
  // job picker moved on, or because openAttach() started a load for a PO on
  // another job — is dropped instead of overwriting the state behind whatever
  // is currently on screen. Without this the last response to arrive won, and
  // the next click repainted a foreign job's folder tree under the current
  // job's heading.
  let loadGeneration = 0;

  // ── Helpers ─────────────────────────────────────────────────────────
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
      const err = new Error((data && data.error) || `Request failed (${r.status})`);
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
    if (!force && loadedFor === projectId) return true;
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

    folders   = data.folders || [];
    documents = data.documents || [];
    caps      = data.caps || cfg.perm;
    loadedFor = projectId;

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
    return true;
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
  function openUpload({ folderId, files = [], poId = null, lockPo = false, projectId }) {
    // Default to the tab's selection, but let callers override: openAttach()
    // works against the PO's own job, which is not always the one on screen.
    if (projectId === undefined) projectId = cfg.getProjectId();
    if (!folderId) folderId = defaultFolderForPo(poId, projectId);
    const m = modal('Upload documents', `
      <div style="display:flex;flex-direction:column;gap:0.85rem">
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Files</label>
          <input type="file" id="fctdoc-files" multiple style="${S.input};width:100%" />
          <div id="fctdoc-filelist" style="${S.muted};margin-top:0.35rem"></div>
        </div>
        <div>
          <label style="display:block;${S.muted};margin-bottom:0.25rem">Folder <span style="color:var(--red,#ef4444)">*</span></label>
          ${folderPickerHTML('fctdoc-folder', folderId, '— pick a folder —')}
          ${poId ? `<div style="${S.muted};margin-top:0.25rem">Filed under the purchase order as well, whichever folder you pick.</div>` : ''}
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
      for (const file of picked) {
        progress.textContent = `Uploading ${done + failed + 1} of ${picked.length}: ${file.name}`;
        try {
          const chosenPoRow = (cfg.getPurchaseOrders() || []).find(p => p.id === chosenPo);
          await uploadOne(file, {
            folderId: chosenFolder, poId: chosenPo,
            poNumber: chosenPoRow && chosenPoRow.po_number,
            note, projectId,
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
      if (errors.length) toast(`${landed} ${failed} failed — ${errors.join('; ')}`, 'error');
      else toast(landed);

      // The upload is committed; only the refresh can still fail. Left
      // unguarded it rejected, skipped the re-render, and left a green
      // "uploaded" toast above a listing that did not contain the file — so
      // people uploaded it a second time.
      try {
        await load(projectId, { force: true });
        await refreshPoCounts();
        if (cfg.onChange) cfg.onChange();
        render();
      } catch (err) {
        toast(`Uploaded, but the list could not be refreshed: ${err.message}. Reopen the tab to see it.`, 'error');
      }
    });
  }

  async function uploadOne(file, { folderId, poId, poNumber, note, projectId }) {
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
      // A cross-origin PUT with a non-safelisted Content-Type needs a preflight,
      // and a bucket with no CORS rule refuses it — which surfaces as a bare
      // "Failed to fetch" with nothing in any server log, because the request
      // never reached us. It is the first thing that goes wrong on a new
      // deployment, so name it rather than leaving people guessing.
      throw new Error(
        'Could not reach file storage. If this is a new deployment the storage '
        + 'bucket most likely needs a CORS rule allowing PUT from this site — '
        + 'see api/.env.example. (' + err.message + ')'
      );
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
          if (cfg.onChange) cfg.onChange();
          render();
          toast('Unlinked. The file is still in its folder.');
        } catch (err) { toast(err.message, 'error'); }
      });
    });
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
        btn.disabled = true;
        btn.textContent = 'Restoring…';
        try {
          await api('PATCH', `/documents${q({ id: btn.dataset.restore })}`, { restore: true });
          m.close();
          await load(cfg.getProjectId(), { force: true });
          await refreshPoCounts();
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

  // ── Purchase-order side ─────────────────────────────────────────────
  /**
   * The paperclip on a PO row. Lists what is attached, and offers an upload
   * that files the document on the job AND under the PO in one action.
   */
  async function openAttach(po) {
    const projectId = po.project_id || null;

    // A PO can belong to a different job than the one on screen, and a non-job
    // PO belongs to the General area — either way, load that scope's folders
    // so the filing picker offers the right ones.
    if (loadedFor !== projectId) {
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

    // exercised by scripts/test-documents-frontend.js — the upload sequence is
    // the one part of this file a static read cannot confirm.
    _uploadOne: uploadOne,
    _maybeDownscale: maybeDownscale,
  };
})();
