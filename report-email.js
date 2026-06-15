/* eslint-disable no-undef */
/* DataWatch — Report Email modal
 * Shared by the Executive, Turf, and Paving "Email Report" buttons.
 * Exposes one entry point on `window`:
 *
 *   openReportEmailModal({
 *     reportType,        // 'executive' | 'turf_daily_pm' | 'turf_daily_summary' | 'paving_daily_pm'
 *     projectId,         // optional — for project-scoped reports
 *     projectName,       // optional — used in default subject + group filtering
 *     defaultSubject,    // optional — fallback "Report — <project>"
 *     getHTML,           // () => string  — caller renders the report HTML on demand
 *   });
 *
 * The modal is appended to <body> on demand, fetches saved recipient
 * groups from /api/email/recipient-groups, and POSTs to
 * /api/email/send-report. All visual styling is inline so this file can
 * be dropped into any of the existing pages without touching their CSS.
 */
(function () {
  if (window.openReportEmailModal) return; // already loaded

  const MODAL_ID = 'report-email-modal';
  const Z = 10050; // above all existing overlays (gantt/sched are 9999)

  function token() { return localStorage.getItem('fct_token') || ''; }
  function user()  { try { return JSON.parse(localStorage.getItem('fct_user') || '{}'); } catch { return {}; } }

  function isAdmin() {
    const u = user();
    if (!u) return false;
    if (u.isPlatformAdmin) return true;
    if (u.role === 'admin') return true;
    const dr = u.divisionRoles;
    if (dr && typeof dr === 'object') {
      for (const v of Object.values(dr)) if (v === 'admin') return true;
    }
    return false;
  }

  const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
  function isValidEmail(e) { return typeof e === 'string' && EMAIL_RE.test(e.trim()); }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
    ));
  }

  // ── State (one modal at a time) ─────────────────────────────────────
  let state = null;
  function resetState() { state = null; }

  function close() {
    const el = document.getElementById(MODAL_ID);
    if (el) el.remove();
    resetState();
  }

  // ── Recipient chips ─────────────────────────────────────────────────
  function renderChips() {
    const wrap = document.getElementById('rem-chips');
    if (!wrap) return;
    wrap.innerHTML = state.recipients.map((e, i) => `
      <span style="display:inline-flex;align-items:center;gap:0.35rem;background:#1f2937;color:#f3f4f6;border:1px solid #374151;border-radius:12px;padding:0.18rem 0.55rem;font-size:0.75rem;margin:0.12rem;">
        ${esc(e)}
        <span data-i="${i}" class="rem-chip-x" style="cursor:pointer;color:#9ca3af;font-weight:700;font-size:0.85rem;line-height:1;">&times;</span>
      </span>
    `).join('');
    wrap.querySelectorAll('.rem-chip-x').forEach(x => {
      x.onclick = () => {
        const i = parseInt(x.getAttribute('data-i'), 10);
        if (!Number.isFinite(i)) return;
        state.recipients.splice(i, 1);
        renderChips();
      };
    });
  }

  function addEmail(raw) {
    if (!raw) return;
    const parts = String(raw).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    for (const p of parts) {
      const lc = p.toLowerCase();
      if (!isValidEmail(lc)) continue;
      if (state.recipients.includes(lc)) continue;
      state.recipients.push(lc);
      added++;
    }
    if (added) renderChips();
    return added;
  }

  // ── Saved groups ────────────────────────────────────────────────────
  async function loadGroups() {
    const list = document.getElementById('rem-groups-list');
    if (!list) return;
    list.innerHTML = '<div style="padding:0.5rem;color:#9ca3af;font-size:0.75rem">Loading saved groups…</div>';

    const params = new URLSearchParams();
    params.set('report_type', state.reportType);
    if (state.projectId) params.set('project_id', state.projectId);

    try {
      const r = await fetch('/api/email/recipient-groups?' + params.toString(), {
        headers: { Authorization: 'Bearer ' + token() },
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      state.groups = Array.isArray(j.groups) ? j.groups : [];
      state.serverIsAdmin = Boolean(j.isAdmin);
      renderGroups();
      // On first load only, auto-populate recipients from any saved group
      // tied to this project so users don't hit "Add at least one recipient"
      // when a project group is clearly intended for the send.
      if (!state.didAutoAdd) {
        state.didAutoAdd = true;
        if (state.projectId && !state.recipients.length) {
          const matched = state.groups.filter(g => g.project_id === state.projectId);
          let added = 0;
          for (const g of matched) {
            for (const e of (g.emails || [])) {
              const lc = String(e || '').trim().toLowerCase();
              if (!isValidEmail(lc)) continue;
              if (state.recipients.includes(lc)) continue;
              state.recipients.push(lc);
              added++;
            }
          }
          if (added) renderChips();
        }
      }
    } catch (err) {
      list.innerHTML = `<div style="padding:0.5rem;color:#f87171;font-size:0.75rem">Couldn't load groups: ${esc(err.message)}</div>`;
    }
  }

  function renderGroups() {
    const list = document.getElementById('rem-groups-list');
    if (!list) return;
    if (!state.groups.length) {
      list.innerHTML = `<div style="padding:0.5rem 0.25rem;color:#9ca3af;font-size:0.75rem">No saved groups yet.${state.serverIsAdmin ? ' Use “Save current as new group” below.' : ''}</div>`;
      return;
    }

    // Group by project-match first.
    const matchPid = state.projectId || '';
    const matched   = state.groups.filter(g => matchPid && g.project_id === matchPid);
    const unmatched = state.groups.filter(g => !matchPid || g.project_id !== matchPid);

    function rowHtml(g) {
      const count = Array.isArray(g.emails) ? g.emails.length : 0;
      const adminControls = state.serverIsAdmin ? `
        <button data-act="edit"   data-id="${g.id}" class="rem-group-act" title="Edit"
                style="background:transparent;border:1px solid #374151;color:#9ca3af;border-radius:4px;font-size:0.7rem;padding:0.18rem 0.5rem;cursor:pointer;">Edit</button>
        <button data-act="delete" data-id="${g.id}" class="rem-group-act" title="Delete"
                style="background:transparent;border:1px solid #7f1d1d;color:#f87171;border-radius:4px;font-size:0.7rem;padding:0.18rem 0.5rem;cursor:pointer;">Delete</button>
      ` : '';
      return `
        <div style="display:flex;align-items:center;gap:0.45rem;padding:0.4rem 0.5rem;border-bottom:1px solid #1f2937;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:0.82rem;color:#e5e7eb;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(g.name)}</div>
            <div style="font-size:0.7rem;color:#9ca3af;">${count} recipient${count === 1 ? '' : 's'}${g.project_id ? ' · project-tied' : ''}</div>
          </div>
          <button data-act="add" data-id="${g.id}" class="rem-group-act"
                  style="background:#065f46;border:1px solid #047857;color:#d1fae5;border-radius:4px;font-size:0.72rem;padding:0.22rem 0.6rem;cursor:pointer;font-weight:600;">+ Add</button>
          ${adminControls}
        </div>
      `;
    }

    list.innerHTML = (matched.length ? `
      <div style="font-size:0.68rem;color:#9ca3af;letter-spacing:0.06em;text-transform:uppercase;padding:0.4rem 0.5rem 0.25rem;">For this project</div>
      ${matched.map(rowHtml).join('')}
    ` : '') + (unmatched.length ? `
      <div style="font-size:0.68rem;color:#9ca3af;letter-spacing:0.06em;text-transform:uppercase;padding:0.4rem 0.5rem 0.25rem;">${matched.length ? 'Other groups' : 'All groups'}</div>
      ${unmatched.map(rowHtml).join('')}
    ` : '');

    list.querySelectorAll('.rem-group-act').forEach(btn => {
      btn.onclick = () => {
        const id  = parseInt(btn.getAttribute('data-id'), 10);
        const act = btn.getAttribute('data-act');
        const g = state.groups.find(x => x.id === id);
        if (!g) return;
        if (act === 'add')    return onAddGroup(g);
        if (act === 'edit')   return onEditGroup(g);
        if (act === 'delete') return onDeleteGroup(g);
      };
    });
  }

  function onAddGroup(g) {
    const before = state.recipients.length;
    (g.emails || []).forEach(addEmail);
    if (state.recipients.length === before) {
      setStatus('Those addresses were already added.');
    } else {
      setStatus('');
    }
  }

  async function onDeleteGroup(g) {
    if (!confirm(`Delete group "${g.name}"? This cannot be undone.`)) return;
    try {
      const r = await fetch('/api/email/recipient-groups?id=' + g.id, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token() },
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      await loadGroups();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  function onEditGroup(g) {
    const newName = prompt('Group name:', g.name);
    if (newName === null) return;
    const tied = g.project_id
      ? confirm(`Keep this group tied to the current project (${g.project_id})?\nOK = tied, Cancel = make it global.`)
      : (state.projectId ? confirm(`Tie this group to the current project (${state.projectId})?\nOK = tied, Cancel = stay global.`) : false);
    const projectId = tied ? (g.project_id || state.projectId || null) : null;
    const emailsCsv = prompt('Recipient emails (comma-separated):', (g.emails || []).join(', '));
    if (emailsCsv === null) return;
    const emails = emailsCsv.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const bad = emails.filter(e => !isValidEmail(e));
    if (bad.length) { alert('Invalid email(s): ' + bad.join(', ')); return; }
    if (!emails.length) { alert('Group must have at least one email.'); return; }

    fetch('/api/email/recipient-groups?id=' + g.id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ name: newName.trim() || g.name, emails, project_id: projectId }),
    }).then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok || !j.ok) throw new Error(j.error || 'Update failed');
        loadGroups();
      })
      .catch(err => alert('Update failed: ' + err.message));
  }

  async function onSaveAsGroup() {
    if (!state.serverIsAdmin) {
      alert('Only admins can save recipient groups.');
      return;
    }
    if (!state.recipients.length) {
      alert('Add at least one recipient before saving as a group.');
      return;
    }
    const name = prompt('Name this group (e.g. "Maple Ave Stakeholders"):', '');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { alert('Name is required.'); return; }
    const tieToProject = state.projectId
      ? confirm(`Tie this group to the current project (${state.projectId})?\nOK = project-tied, Cancel = global.`)
      : false;

    try {
      const r = await fetch('/api/email/recipient-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify({
          name:        trimmed,
          emails:      state.recipients.slice(),
          project_id:  tieToProject ? state.projectId : null,
          report_type: state.reportType,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setStatus(`Saved as group "${trimmed}".`);
      await loadGroups();
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  }

  // ── Status row + Send ───────────────────────────────────────────────
  function setStatus(msg, kind) {
    const el = document.getElementById('rem-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'error' ? '#fca5a5'
                   : kind === 'ok'    ? '#86efac'
                   : '#9ca3af';
  }

  async function onSend() {
    if (state.sending) return;
    if (!state.recipients.length) {
      setStatus('Add at least one recipient.', 'error'); return;
    }
    const subject = (document.getElementById('rem-subject')?.value || '').trim();
    const note    = (document.getElementById('rem-note')?.value    || '').trim();

    let html = '';
    try { html = state.getHTML ? state.getHTML() : ''; }
    catch (err) { setStatus('Couldn’t build report HTML: ' + err.message, 'error'); return; }
    if (!html) { setStatus('Report HTML is empty — try regenerating the report.', 'error'); return; }

    state.sending = true;
    setStatus('Sending…');
    const sendBtn = document.getElementById('rem-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.6'; }

    try {
      const r = await fetch('/api/email/send-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
        body: JSON.stringify({
          report_type:  state.reportType,
          project_id:   state.projectId || null,
          project_name: state.projectName || null,
          recipients:   state.recipients,
          subject,
          note,
          html,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
      setStatus(`Sent to ${j.recipientCount} recipient${j.recipientCount === 1 ? '' : 's'}.`, 'ok');
      setTimeout(close, 1100);
    } catch (err) {
      setStatus('Send failed: ' + err.message, 'error');
      state.sending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = '1'; }
    }
  }

  // ── Modal markup ────────────────────────────────────────────────────
  function buildModal() {
    const subj = state.defaultSubject || 'Report';
    const wrap = document.createElement('div');
    wrap.id = MODAL_ID;
    wrap.style.cssText = `
      position:fixed;inset:0;z-index:${Z};
      background:rgba(0,0,0,0.72);
      display:flex;align-items:center;justify-content:center;
      font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
    `;
    wrap.innerHTML = `
      <div role="dialog" aria-modal="true" style="
        background:#0b1220;color:#e5e7eb;
        border:1px solid #1f2937;border-radius:10px;
        width:min(620px, calc(100vw - 32px));
        max-height:calc(100vh - 48px);
        display:flex;flex-direction:column;
        box-shadow:0 20px 40px rgba(0,0,0,0.45);
      ">
        <div style="padding:0.85rem 1.1rem;border-bottom:1px solid #1f2937;display:flex;align-items:center;gap:0.6rem;">
          <div style="font-size:0.95rem;font-weight:700;color:#f3f4f6;">Email Report</div>
          <div style="font-size:0.72rem;color:#9ca3af;">${esc(state.reportLabel || '')}</div>
          <button id="rem-close" style="margin-left:auto;background:transparent;border:0;color:#9ca3af;font-size:1.2rem;cursor:pointer;line-height:1;">&times;</button>
        </div>

        <div style="padding:0.85rem 1.1rem;overflow-y:auto;flex:1;">
          <label style="display:block;font-size:0.72rem;color:#9ca3af;margin-bottom:0.25rem;">Recipients</label>
          <div id="rem-chips" style="border:1px solid #1f2937;border-radius:6px;background:#020617;padding:0.35rem;min-height:2rem;"></div>
          <div style="display:flex;gap:0.4rem;margin-top:0.35rem;">
            <input id="rem-input" type="text" placeholder="Type an email and press Enter…" autocomplete="off"
              style="flex:1;background:#020617;color:#e5e7eb;border:1px solid #1f2937;border-radius:6px;padding:0.45rem 0.6rem;font-size:0.85rem;outline:none;">
            <button id="rem-add" style="background:#1e3a8a;color:#dbeafe;border:1px solid #1e40af;border-radius:6px;font-size:0.75rem;font-weight:600;padding:0 0.85rem;cursor:pointer;">Add</button>
          </div>

          <div style="margin-top:0.9rem;">
            <div style="display:flex;align-items:center;gap:0.45rem;margin-bottom:0.3rem;">
              <label style="font-size:0.72rem;color:#9ca3af;">Saved groups</label>
              <button id="rem-save-group" style="margin-left:auto;background:transparent;color:#86efac;border:1px solid #14532d;border-radius:4px;font-size:0.72rem;font-weight:600;padding:0.2rem 0.55rem;cursor:pointer;">+ Save current as new group</button>
            </div>
            <div id="rem-groups-list" style="border:1px solid #1f2937;border-radius:6px;background:#020617;max-height:200px;overflow-y:auto;"></div>
          </div>

          <label style="display:block;font-size:0.72rem;color:#9ca3af;margin-top:0.85rem;margin-bottom:0.25rem;">Subject</label>
          <input id="rem-subject" type="text" value="${esc(subj)}"
            style="width:100%;background:#020617;color:#e5e7eb;border:1px solid #1f2937;border-radius:6px;padding:0.45rem 0.6rem;font-size:0.85rem;outline:none;">

          <label style="display:block;font-size:0.72rem;color:#9ca3af;margin-top:0.85rem;margin-bottom:0.25rem;">Note (optional)</label>
          <textarea id="rem-note" rows="3" placeholder="Optional message prepended above the report…"
            style="width:100%;background:#020617;color:#e5e7eb;border:1px solid #1f2937;border-radius:6px;padding:0.45rem 0.6rem;font-size:0.85rem;outline:none;resize:vertical;font-family:inherit;"></textarea>
        </div>

        <div style="padding:0.7rem 1.1rem;border-top:1px solid #1f2937;display:flex;align-items:center;gap:0.6rem;">
          <div id="rem-status" style="flex:1;font-size:0.75rem;color:#9ca3af;min-height:1em;"></div>
          <button id="rem-cancel" style="background:transparent;color:#9ca3af;border:1px solid #374151;border-radius:6px;font-size:0.78rem;padding:0.4rem 0.85rem;cursor:pointer;">Cancel</button>
          <button id="rem-send" style="background:#065f46;color:#d1fae5;border:1px solid #047857;border-radius:6px;font-size:0.82rem;font-weight:700;padding:0.45rem 1rem;cursor:pointer;">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    // Wire interactions
    document.getElementById('rem-close').onclick  = close;
    document.getElementById('rem-cancel').onclick = close;
    document.getElementById('rem-send').onclick   = onSend;
    document.getElementById('rem-save-group').onclick = onSaveAsGroup;
    document.getElementById('rem-add').onclick = () => {
      const inp = document.getElementById('rem-input');
      const v = inp.value;
      const added = addEmail(v);
      if (added > 0) { inp.value = ''; setStatus(''); }
      else if (v) setStatus('No valid emails to add.', 'error');
    };
    const inp = document.getElementById('rem-input');
    inp.onkeydown = ev => {
      if (ev.key === 'Enter' || ev.key === ',') {
        ev.preventDefault();
        const v = inp.value;
        const added = addEmail(v);
        if (added > 0) { inp.value = ''; setStatus(''); }
      }
    };
    // Click outside to close (but only if click is on the dim backdrop, not the dialog).
    wrap.addEventListener('click', ev => { if (ev.target === wrap) close(); });
    // Escape closes.
    const onEsc = ev => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);

    renderChips();
    loadGroups();
    setTimeout(() => inp.focus(), 30);
  }

  // ── Public entry point ──────────────────────────────────────────────
  const REPORT_LABELS = {
    executive:            'Executive Report',
    turf_daily_pm:        'Daily PM Report — Turf',
    turf_daily_summary:   'Daily Summary — Turf',
    turf_bid_items:       'Bid Line Items vs Actuals — Turf',
    paving_daily_pm:      'Daily PM Report — Paving',
    paving_daily_summary: 'Daily Summary — Paving',
    paving_bid_items:     'Bid Line Items vs Actuals — Paving',
    dust_tracking_summary:'Dust Control Tracking Report',
  };

  function openReportEmailModal(opts) {
    if (!opts || !opts.reportType) { console.error('openReportEmailModal: reportType required'); return; }
    if (!token()) { alert('Please log in again.'); return; }
    if (document.getElementById(MODAL_ID)) return; // already open

    state = {
      reportType:     opts.reportType,
      reportLabel:    REPORT_LABELS[opts.reportType] || '',
      projectId:      opts.projectId || null,
      projectName:    opts.projectName || null,
      defaultSubject: opts.defaultSubject || REPORT_LABELS[opts.reportType] || 'Report',
      getHTML:        typeof opts.getHTML === 'function' ? opts.getHTML : null,
      recipients:     [],
      groups:         [],
      serverIsAdmin:  false,
      sending:        false,
      didAutoAdd:     false,
    };
    buildModal();
  }

  window.openReportEmailModal = openReportEmailModal;
})();
