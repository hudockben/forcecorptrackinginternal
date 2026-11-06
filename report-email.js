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
 *     getAttachments,    // optional () => [{filename, content(base64), contentId}]
 *                        //   inline images referenced from HTML via <img src="cid:contentId">
 *     onSent,            // optional (info) => void — called once the server says the
 *                        //   email went out (with or without a warning), with
 *                        //   { recipients: [...], subject, recipientCount, pdfAttached,
 *                        //     logged, runId } — subject is the one the server
 *                        //   actually sent (an empty one becomes the report's
 *                        //   label), falling back to what was typed; logged is
 *                        //   true when the server wrote the send history itself
 *     customReport,      // optional object — sent as `custom_report`: what a
 *                        //   *_custom_report send records in the history
 *                        //   (run_kind: 'resend' and resent_from_run_id ride
 *                        //   along with it untouched)
 *     defaultRecipients, // optional [emails] — filled in when the modal opens,
 *                        //   ahead of the project-group auto-add, which still
 *                        //   runs and merges (Customer History's Resend)
 *     contacts,          // optional [{ email, name?, source?: 'job'|'client', label? }]
 *                        //   — saved customer contacts, filled in too; a chip
 *                        //   shows the name, its tooltip the label ("Job
 *                        //   contact — Maple Ave")
 *     suggestedContacts, // optional — the same shape as contacts, NOT filled in:
 *                        //   listed under the recipients to add by hand (a
 *                        //   report about several customers' jobs, whose
 *                        //   contacts would each see the others' jobs)
 *     suggestedNote,     // optional string — the warning shown above them
 *     contactContext,    // optional { division, projectIds:[...], clients:[{key,name}],
 *                        //   mixed?, canEdit, apiBase?, getToken? } — with canEdit,
 *                        //   every address that is not a saved contact offers
 *                        //   "☆ Save as contact" for this job / this client /
 *                        //   each picked job (POST /api/report-contacts). mixed
 *                        //   (or more than one client): the jobs are more than
 *                        //   one customer's, so "each picked job" is not offered
 *                        //   and the client must be chosen, not defaulted
 *   });
 *
 * onSent's info also carries `archived`: true when the server kept a copy of
 * the HTML it sent (Custom Reporting's "open exactly what was sent").
 *
 * onSent exists for Custom Reporting, which keeps a history of what was sent
 * to whom. It is told only about a send that really happened, and anything it
 * throws (or rejects with) is caught and logged: the email has already gone,
 * and a broken history write must not leave the modal stuck mid-send with a
 * live Send button inviting a duplicate.
 *
 * Pairs with report-branding.js, which stamps the DataWatch header on the
 * report before it is sent — the same header the print path uses.
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

  // The server's check (api/lib/email.js), so an address the send would be
  // refused over is caught here, by name.
  const EMAIL_RE = /^(?=.{1,254}$)(?=[^@]{1,64}@)[A-Za-z0-9_%+\-]+(?:\.[A-Za-z0-9_%+\-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
  function isValidEmail(e) { return typeof e === 'string' && EMAIL_RE.test(e.trim()); }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
    ));
  }

  // ── Key figures ─────────────────────────────────────────────────────
  // Every report opens with a strip of headline numbers — Bid Budget / Actual
  // Cost / Projected Cost / Project Complete on the bid reports, Total Cost /
  // Labor Hours / Projects on the dailies, and on the job summary two stacked
  // bars, contract and budget over days and costs. The markup differs per
  // report but the shape doesn't: a label element next to a value element, both
  // inside a per-metric wrapper, all inside one strip. Rather than make all 17
  // call sites pass the figures down, lift them back out of the HTML they
  // already built.
  const LABEL_RE = /(?:^|[-_])(?:label|lbl)$/;
  const VALUE_RE = /(?:^|[-_])(?:val|value|num)$/;

  // How many figures ride in the email body. A job summary with change orders
  // on it runs the full twelve — five contract/budget figures over the seven
  // days-and-costs ones.
  const MAX_METRICS = 12;

  // The reports color their headline figures: green under bid or in the black,
  // red over, amber for cost booked so far. Carry that through so the email
  // reads like the report's own header rather than a flat column of numbers.
  const TONE_CLASSES = {
    'under':  'good',   'sqft-under':  'good',   'green': 'good',
    'over':   'bad',    'sqft-over':   'bad',    'red':   'bad',
    'actual': 'actual', 'sqft-actual': 'actual',
  };

  function toneOf(el) {
    if (!el || !el.classList) return null;
    for (const c of el.classList) {
      if (Object.prototype.hasOwnProperty.call(TONE_CLASSES, c)) return TONE_CLASSES[c];
    }
    return null;
  }

  function classMatches(el, re) {
    if (!el || !el.classList) return false;
    for (const c of el.classList) if (re.test(c)) return true;
    return false;
  }

  function metricText(el) {
    return String(el && el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Find the value element paired with a label: usually the next sibling,
  // sometimes the previous one (value-above-label layouts), otherwise any
  // other child of the shared per-metric wrapper.
  function valueFor(lab) {
    if (classMatches(lab.nextElementSibling, VALUE_RE))     return lab.nextElementSibling;
    if (classMatches(lab.previousElementSibling, VALUE_RE)) return lab.previousElementSibling;
    const par = lab.parentElement;
    if (par) for (const c of par.children) if (c !== lab && classMatches(c, VALUE_RE)) return c;
    return null;
  }

  function extractSummary(html) {
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch { return []; }
    if (!doc || !doc.body) return [];

    // Bucket metrics by their strip (the wrapper's wrapper), preserving order.
    const groups = new Map();
    let labels;
    try { labels = doc.body.querySelectorAll('[class*="label"],[class*="lbl"]'); }
    catch { return []; }

    for (const lab of labels) {
      if (!classMatches(lab, LABEL_RE)) continue;
      const val = valueFor(lab);
      if (!val) continue;
      const label = metricText(lab);
      const value = metricText(val);
      if (!label || !value) continue;
      if (value === '—' || value === '-') continue;   // an em-dash placeholder is not a figure
      const strip = (lab.parentElement && lab.parentElement.parentElement) || lab.parentElement;
      if (!strip) continue;
      if (!groups.has(strip)) groups.set(strip, []);
      const tone = toneOf(val);
      groups.get(strip).push(tone ? { label, value, tone } : { label, value });
    }

    // A report can open with more than one strip: the job summary stacks a
    // contract / bid budget / actual profit bar above the days-and-costs bar,
    // and the bid report a $/SY bar above the cost roll-up. Anchor on the
    // strongest strip — most metrics, weighted toward the ones carrying dollars
    // and percentages — and then carry its companions with it, so the email
    // opens with the same headline block the PDF does instead of a fragment of
    // one bar.
    let best = null;
    for (const [strip, list] of groups) {
      if (list.length < 2) continue;
      const score = list.length + list.filter(m => /[$%]/.test(m.value)).length * 2;
      if (!best || score > best.score) best = { score, strip, list };
    }
    if (!best) return [];

    // A companion is a strip sitting beside the anchor under the same parent
    // wearing the same classes. That picks up the paired opening bars and
    // nothing further down the report — the job summary's schedule KPI strip is
    // built from the same .sum-metric parts but wears .sched-bar as well, so it
    // stays out rather than crowding out the figures that matter. With no
    // classes to match on there is nothing to tell a companion from any other
    // sibling, so the anchor goes alone.
    const classesOf = el => Array.from(el.classList || []).sort().join('.');
    const anchorCls = classesOf(best.strip);
    const anchorPar = best.strip.parentElement;
    const isCompanion = strip => Boolean(anchorCls)
      && strip.parentElement === anchorPar
      && strip.tagName === best.strip.tagName
      && classesOf(strip) === anchorCls;

    const out = [];
    for (const [strip, list] of groups) {   // Map order is document order
      if (strip !== best.strip && !isCompanion(strip)) continue;
      for (const m of list) {
        if (out.length >= MAX_METRICS) return out;
        out.push(m);
      }
    }
    return out;
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
  // A saved contact's chip shows the person's name with the address beside it
  // and says where the contact comes from in its tooltip. Any other address
  // offers "Save as contact" when the caller lets this user save them.
  const CHIP_STYLE = 'display:inline-flex;align-items:center;flex-wrap:wrap;gap:0.35rem;background:#1f2937;color:#f3f4f6;border:1px solid #374151;border-radius:12px;padding:0.18rem 0.55rem;font-size:0.75rem;margin:0.12rem;max-width:100%;';
  function canSaveContact(e) {
    const cc = state.contactContext;
    return Boolean(cc && cc.canEdit && cc.scopes.length) && !state.contactMeta.has(e);
  }
  function renderChips() {
    const wrap = document.getElementById('rem-chips');
    if (!wrap) return;
    wrap.innerHTML = state.recipients.map((e, i) => {
      const meta = state.contactMeta.get(e) || null;
      const shown = meta && meta.name ? meta.name : e;
      const tip = meta && meta.title ? ` title="${esc(meta.title)}"` : '';
      const addr = meta && meta.name
        ? `<span class="rem-chip-addr" style="color:#9ca3af;font-size:0.7rem;">${esc(e)}</span>` : '';
      const saved = meta && meta.saved
        ? '<span class="rem-chip-saved" style="color:#fbbf24;font-size:0.68rem;">&#9733; Saved</span>' : '';
      const save = canSaveContact(e)
        ? `<button type="button" class="rem-chip-save" data-i="${i}" title="Save as a contact so it is filled in next time" style="background:transparent;border:0;color:#fbbf24;font-size:0.68rem;cursor:pointer;padding:0;">&#9734; Save as contact</button>`
        : '';
      return `<span class="rem-chip" data-email="${esc(e)}"${tip} style="${CHIP_STYLE}">${esc(shown)}${addr}${saved}${save}<span data-i="${i}" class="rem-chip-x" role="button" aria-label="Remove ${esc(e)}" style="cursor:pointer;color:#9ca3af;font-weight:700;font-size:0.85rem;line-height:1;">&times;</span></span>`;
    }).join('');
    // A suggested contact already on the list (added, or by a group) is not
    // offered again; one removed is.
    renderSuggestions();
  }

  // One listener for every chip, present and future.
  function onChipClick(ev) {
    const t = ev.target;
    if (!t || typeof t.closest !== 'function' || !state) return;
    const x = t.closest('.rem-chip-x');
    if (x) {
      const i = parseInt(x.getAttribute('data-i'), 10);
      if (!Number.isFinite(i) || !state.recipients[i]) return;
      const gone = state.recipients.splice(i, 1)[0];
      state.manualEdit = true;
      if (state.contactForm === gone) closeContactForm();
      renderChips();
      renderSuggestions();
      return;
    }
    const sv = t.closest('.rem-chip-save');
    if (sv) {
      const i = parseInt(sv.getAttribute('data-i'), 10);
      if (Number.isFinite(i) && state.recipients[i]) openContactForm(state.recipients[i]);
    }
  }

  // Adds every valid address in `raw`; returns how many it added and the
  // ones it refused, so a typo in a pasted list is named, not lost.
  function addEmail(raw) {
    const out = { added: 0, bad: [] };
    if (!raw) return out;
    const parts = String(raw).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const lc = p.toLowerCase();
      if (!isValidEmail(lc)) { if (!out.bad.includes(p)) out.bad.push(p); continue; }
      if (state.recipients.includes(lc)) continue;
      state.recipients.push(lc);
      out.added++;
    }
    if (out.added) renderChips();
    return out;
  }

  // A saved group's addresses the send would be refused over are left off —
  // said so, with who can fix them.
  function leftOffNote(bad) {
    const many = bad.length > 1;
    return `Left off ${bad.join(', ')} — ${many ? 'not valid email addresses' : 'not a valid email address'}. `
      + (state.serverIsAdmin ? `Edit the group to fix ${many ? 'them' : 'it'}.` : 'Ask an admin to fix the group.');
  }

  // ── Recipients the caller fills in ──────────────────────────────────
  const SOURCE_LABELS = { job: 'Job contact', client: 'Client contact' };

  // The caller's defaultRecipients, then its saved contacts, each address
  // once. Any the send would be refused over are left off and named, like a
  // group's. Runs as the modal opens, before the project groups load.
  function seedRecipients(defaults, contacts) {
    const badDefault = [], badContact = [];
    const add = (raw, bad) => {
      const lc = String(raw == null ? '' : raw).trim().toLowerCase();
      if (!lc) return;
      if (!isValidEmail(lc)) { if (!bad.includes(lc)) bad.push(lc); return; }
      if (!state.recipients.includes(lc)) state.recipients.push(lc);
    };
    const list = Array.isArray(contacts) ? contacts.filter(c => c && typeof c === 'object') : [];
    for (const c of list) {
      const lc = String(c.email == null ? '' : c.email).trim().toLowerCase();
      if (!isValidEmail(lc) || state.contactMeta.has(lc)) continue;
      const name = typeof c.name === 'string' ? c.name.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      const label = typeof c.label === 'string' && c.label.trim()
        ? c.label.trim().slice(0, 200)
        : (SOURCE_LABELS[c.source] || 'Saved contact');
      state.contactMeta.set(lc, { name, title: label, source: c.source === 'job' || c.source === 'client' ? c.source : null });
    }
    if (Array.isArray(defaults)) for (const e of defaults) add(e, badDefault);
    for (const c of list) add(c.email, badContact);
    const notes = [];
    const note = (bad, tail) => {
      if (!bad.length) return;
      const many = bad.length > 1;
      notes.push(`Left off ${bad.join(', ')} — ${many ? 'not valid email addresses' : 'not a valid email address'}.${tail ? ' ' + tail(many) : ''}`);
    };
    note(badDefault, null);
    note(badContact, many => `Fix ${many ? 'them' : 'it'} in Contacts.`);
    state.seedNote = notes.join(' ');
    if (state.recipients.length) renderChips();
    if (state.seedNote) setStatus(state.seedNote, 'error');
  }

  // ── Suggested contacts ──────────────────────────────────────────────
  // Saved contacts the caller does not fill in — a report about several
  // customers' jobs would show each of them the others' — listed with a
  // warning, each added only by a click.
  function cleanContactList(raw) {
    const out = [];
    for (const c of (Array.isArray(raw) ? raw : []).slice(0, 200)) {
      if (!c || typeof c !== 'object') continue;
      const email = String(c.email == null ? '' : c.email).trim().toLowerCase();
      if (!isValidEmail(email) || out.some(x => x.email === email)) continue;
      const name = typeof c.name === 'string' ? c.name.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      const label = typeof c.label === 'string' && c.label.trim() ? c.label.trim().slice(0, 200) : (SOURCE_LABELS[c.source] || 'Saved contact');
      out.push({ email, name, label, source: c.source === 'job' || c.source === 'client' ? c.source : null });
    }
    return out;
  }
  function renderSuggestions() {
    const box = document.getElementById('rem-suggest');
    if (!box || !state) return;
    const left = state.suggested.filter(c => !state.recipients.includes(c.email));
    if (!left.length && !state.suggestedNote) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    const btn = 'display:inline-flex;align-items:center;gap:0.3rem;background:transparent;color:#e5e7eb;border:1px dashed #4b5563;border-radius:12px;padding:0.15rem 0.55rem;font-size:0.72rem;margin:0.12rem;cursor:pointer;max-width:100%;';
    box.innerHTML = (state.suggestedNote
      ? `<div class="rem-suggest-note" role="note" style="font-size:0.72rem;color:#fcd34d;background:#422006;border:1px solid #92400e;border-radius:6px;padding:0.35rem 0.5rem;">&#9888; ${esc(state.suggestedNote)}</div>` : '')
      + (left.length
        ? `<div style="font-size:0.7rem;color:#9ca3af;margin:0.35rem 0 0.1rem;">Saved contacts, not added — add one only if they should see every job in this report:</div>`
          + left.map(c => `<button type="button" class="rem-suggest-add" data-email="${esc(c.email)}" title="${esc(c.label)}" style="${btn}">+ ${esc(c.name || c.email)}${
            c.name ? `<span style="color:#9ca3af;font-size:0.68rem;">${esc(c.email)}</span>` : ''}</button>`).join('')
        : '');
  }
  function onSuggestClick(ev) {
    const t = ev.target;
    if (!t || typeof t.closest !== 'function' || !state) return;
    const b = t.closest('.rem-suggest-add');
    if (!b) return;
    const c = state.suggested.find(x => x.email === b.getAttribute('data-email'));
    if (!c) return;
    if (!state.contactMeta.has(c.email)) state.contactMeta.set(c.email, { name: c.name, title: c.label, source: c.source });
    if (!state.recipients.includes(c.email)) state.recipients.push(c.email);
    state.manualEdit = true;
    renderChips();
    renderSuggestions();
  }

  // ── Save as contact ─────────────────────────────────────────────────
  // Where an address can be saved: the one job, every picked job, or one of
  // the picked jobs' clients. Jobs of more than one customer: never every
  // picked job (one customer's contact would be filed on — and later sent —
  // the others' jobs), and the client is chosen, not defaulted.
  function contactScopes(cc) {
    const out = [];
    if (cc.projectIds.length === 1) out.push({ value: 'job', label: 'This job', projectIds: cc.projectIds.slice() });
    if (cc.projectIds.length > 1 && !cc.mixed) out.push({ value: 'jobs', label: `Each picked job (${cc.projectIds.length})`, projectIds: cc.projectIds.slice() });
    cc.clients.slice(0, 10).forEach((c, i) => {
      out.push({ value: 'client:' + i, label: `${cc.clients.length > 1 ? 'Client' : 'This client'} — ${c.name}`, client: c });
    });
    return out;
  }

  function readContactContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.division) return null;
    const projectIds = [...new Set((Array.isArray(raw.projectIds) ? raw.projectIds : [])
      .filter(x => x !== null && x !== undefined && String(x).trim()).map(x => String(x).trim()))].slice(0, 200);
    const clients = [];
    for (const c of (Array.isArray(raw.clients) ? raw.clients : [])) {
      if (!c || typeof c !== 'object') continue;
      const name = String(c.name == null ? '' : c.name).trim();
      const key = String(c.key == null ? name : c.key).trim().toLowerCase();
      if (!name || !key || clients.some(x => x.key === key)) continue;
      clients.push({ key, name: name.slice(0, 200) });
    }
    const cc = {
      division:   String(raw.division),
      projectIds, clients,
      mixed:      raw.mixed === true || clients.length > 1,
      canEdit:    raw.canEdit === true,
      apiBase:    typeof raw.apiBase === 'string' && raw.apiBase ? raw.apiBase.replace(/\/+$/, '') : '/api',
      getToken:   typeof raw.getToken === 'function' ? raw.getToken : null,
    };
    cc.scopes = contactScopes(cc);
    return cc;
  }

  function closeContactForm() {
    const box = document.getElementById('rem-contact-form');
    if (box) { box.innerHTML = ''; box.style.display = 'none'; }
    if (state) state.contactForm = null;
  }

  function openContactForm(email) {
    const box = document.getElementById('rem-contact-form');
    const cc = state.contactContext;
    if (!box || !cc || !cc.canEdit || !cc.scopes.length) return;
    state.contactForm = email;
    const field = 'background:#020617;color:#e5e7eb;border:1px solid #1f2937;border-radius:6px;padding:0.35rem 0.5rem;font-size:0.8rem;outline:none;min-width:0;';
    box.innerHTML = `
      <div style="font-size:0.75rem;color:#e5e7eb;margin-bottom:0.35rem;">Save <strong>${esc(email)}</strong> as a contact</div>
      <div style="display:flex;flex-wrap:wrap;gap:0.35rem;align-items:center;">
        <input id="rem-contact-name" type="text" maxlength="120" placeholder="Name (optional)" autocomplete="off" style="${field}flex:1 1 9rem;">
        <select id="rem-contact-role" style="${field}">
          <option value="owner">Owner</option><option value="gc">GC</option><option value="engineer">Engineer</option>
          <option value="inspector">Inspector</option><option value="internal">Internal</option>
          <option value="other" selected>Other</option>
        </select>
        <select id="rem-contact-scope" style="${field}flex:1 1 9rem;">
          ${cc.mixed ? '<option value="" selected>Who is it for? Pick one…</option>' : ''}${cc.scopes.map(sc => `<option value="${esc(sc.value)}">${esc(sc.label)}</option>`).join('')}
        </select>
        <button type="button" id="rem-contact-save" style="background:#065f46;color:#d1fae5;border:1px solid #047857;border-radius:6px;font-size:0.75rem;font-weight:600;padding:0.32rem 0.7rem;cursor:pointer;">Save</button>
        <button type="button" id="rem-contact-cancel" style="background:transparent;color:#9ca3af;border:1px solid #374151;border-radius:6px;font-size:0.75rem;padding:0.32rem 0.7rem;cursor:pointer;">Cancel</button>
      </div>
      <div id="rem-contact-msg" style="font-size:0.72rem;color:#fca5a5;margin-top:0.3rem;min-height:1em;"></div>`;
    box.style.display = 'block';
    document.getElementById('rem-contact-cancel').addEventListener('click', closeContactForm);
    document.getElementById('rem-contact-save').addEventListener('click', () => { saveContact(email); });
    const nameInp = document.getElementById('rem-contact-name');
    nameInp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); saveContact(email); } });
    setTimeout(() => { try { nameInp.focus(); } catch (_) { /* gone already */ } }, 0);
  }

  async function saveContact(email) {
    const cc = state && state.contactContext;
    const btn = document.getElementById('rem-contact-save');
    const msg = document.getElementById('rem-contact-msg');
    if (!cc || !btn || btn.disabled) return;
    const name = (document.getElementById('rem-contact-name')?.value || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const role = document.getElementById('rem-contact-role')?.value || 'other';
    const scope = cc.scopes.find(sc => sc.value === document.getElementById('rem-contact-scope')?.value);
    if (!scope) {
      if (msg) { msg.style.color = '#fca5a5'; msg.textContent = 'Pick who this contact is for — these jobs are for more than one customer.'; }
      return;
    }
    // A client contact is filed under the key the server works out from the
    // client's name — the same trim-and-lower-case the job's own client gets.
    const bodies = scope.client
      ? [{ client_name: scope.client.name }]
      : scope.projectIds.map(id => ({ project_id: id }));
    const live = state;   // closing the modal mid-save clears state
    btn.disabled = true; btn.style.opacity = '0.6';
    if (msg) { msg.style.color = '#9ca3af'; msg.textContent = 'Saving…'; }
    let tok = '';
    try { tok = cc.getToken ? await cc.getToken() : token(); } catch (_) { tok = token(); }
    let saved = 0, already = 0, error = '';
    for (const body of bodies) {
      try {
        const r = await fetch(`${cc.apiBase}/report-contacts?division=${encodeURIComponent(cc.division)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || '') },
          body: JSON.stringify({ ...body, email, name: name || null, role, auto_add: true }),
        });
        const j = (await readJson(r)) || {};
        if (r.ok && j.ok) saved++;
        else if (r.status === 409 && j.error === 'duplicate') already++;
        else { error = j.error || ('HTTP ' + r.status); break; }
      } catch (err) { error = (err && err.message) || 'network error'; break; }
    }
    if (state !== live) return;
    if (error && !saved && !already) {
      btn.disabled = false; btn.style.opacity = '1';
      if (msg) { msg.style.color = '#fca5a5'; msg.textContent = 'Couldn’t save the contact: ' + error; }
      return;
    }
    const jobs = bodies.length > 1 ? `${bodies.length} jobs` : 'this job';
    const where = scope.client ? `client ${scope.client.name}` : jobs;
    state.contactMeta.set(email, { name, title: `Saved contact — ${scope.client ? scope.client.name : jobs}`,
      source: scope.client ? 'client' : 'job', saved: true });
    closeContactForm();
    renderChips();
    if (error) setStatus(`Saved ${email} for ${saved + already} of ${bodies.length} jobs — ${error}`, 'error');
    else if (!saved) setStatus(`${email} was already a saved contact for ${where}.`, 'ok');
    else setStatus(`Saved ${email} as a contact for ${where}.`, 'ok');
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
      // Recipients the caller filled in (defaultRecipients, contacts) do not
      // stop it — the job's group still merges in; ones the user typed or
      // removed before the groups arrived do, as they always have.
      if (!state.didAutoAdd) {
        state.didAutoAdd = true;
        if (state.projectId && (!state.recipients.length || !state.manualEdit)) {
          const matched = state.groups.filter(g => g.project_id === state.projectId);
          let added = 0;
          const bad = [];
          for (const g of matched) {
            for (const e of (g.emails || [])) {
              const lc = String(e || '').trim().toLowerCase();
              if (!lc) continue;
              if (!isValidEmail(lc)) { if (!bad.includes(lc)) bad.push(lc); continue; }
              if (state.recipients.includes(lc)) continue;
              state.recipients.push(lc);
              added++;
            }
          }
          if (added) renderChips();
          if (bad.length) setStatus([state.seedNote, leftOffNote(bad)].filter(Boolean).join(' '), 'error');
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
    state.manualEdit = true;
    const before = state.recipients.length;
    const bad = [];
    for (const e of (g.emails || [])) {
      for (const b of addEmail(String(e || '')).bad) if (!bad.includes(b.toLowerCase())) bad.push(b.toLowerCase());
    }
    if (bad.length) {
      setStatus(leftOffNote(bad), 'error');
    } else if (state.recipients.length === before) {
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
  // The caller's onSent, told what went out. Called inside the send's own
  // try block, so it is wrapped here: an exception escaping it would land in
  // the "Send failed" branch and re-enable Send for an email already sent.
  // `sent` is taken before the request goes, so closing the modal mid-send
  // (which clears state) cannot lose the record of an email that did go.
  function notifySent(sent, j) {
    if (typeof sent.onSent !== 'function') return;
    try {
      const p = sent.onSent({
        recipients:     sent.recipients,
        subject:        (j && typeof j.subject === 'string' && j.subject) || sent.subject,
        recipientCount: j.recipientCount,
        pdfAttached:    !!j.pdfAttached,
        logged:         j.logged === true,
        runId:          j.run_id == null ? null : j.run_id,
        archived:       j.archived === true,
      });
      if (p && typeof p.catch === 'function') p.catch(err => console.warn('[report-email] onSent failed:', err && err.message));
    } catch (err) {
      console.warn('[report-email] onSent failed:', err && err.message);
    }
  }

  const TOO_LARGE = 'The report is too large to email — narrow the date range, pick fewer jobs, or send it as a PDF from Print.';
  // A response's JSON, or null when it has none.
  async function readJson(r) {
    try {
      if (typeof r.text === 'function') { const t = await r.text(); return t ? JSON.parse(t) : null; }
      return await r.json();
    } catch (_) { return null; }
  }

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

    // Same DataWatch header the print path stamps on, so an emailed report and
    // a printed one are the same document. No-ops if report-branding.js is
    // missing, and is idempotent if the builder already applied it.
    html = (window.dwBrand || String)(html);

    // Optional inline attachments (e.g. a rendered Gantt PNG referenced from the
    // HTML via <img src="cid:...">). Non-fatal — send text-only if it throws.
    let attachments = [];
    try {
      const a = state.getAttachments ? state.getAttachments() : null;
      if (Array.isArray(a)) attachments = a.filter(Boolean);
    } catch (err) { attachments = []; }

    const attachPdf = Boolean(document.getElementById('rem-pdf')?.checked);

    // Key figures for the email body. A caller-supplied list wins; otherwise
    // read them back out of the report HTML. Never fatal — an email with no
    // summary strip is still a fine email.
    let summary = [];
    try {
      const s = state.getSummary ? state.getSummary() : null;
      summary = Array.isArray(s) && s.length ? s : extractSummary(html);
    } catch (err) { summary = []; }

    state.sending = true;
    // Chrome has to boot and lay the report out, which on a cold serverless
    // container is a few seconds — say so rather than looking hung.
    setStatus(attachPdf ? 'Rendering PDF and sending…' : 'Sending…');
    const sendBtn = document.getElementById('rem-send');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.6'; }
    const sent = { onSent: state.onSent, recipients: state.recipients.slice(), subject };

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
          attach_pdf:   attachPdf,
          ...(summary.length ? { summary } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(state.customReport ? { custom_report: state.customReport } : {}),
        }),
      });
      // A platform error (a body over the host's size limit, a timeout) comes
      // back as plain text, not JSON: say what happened rather than show a
      // JSON parse error.
      const j = (await readJson(r)) || { ok: false, error: r.status === 413 ? TOO_LARGE : ('HTTP ' + r.status) };
      if (!r.ok || !j.ok) throw new Error((r.status === 413 && j.error === 'Report HTML is too large') ? TOO_LARGE : (j.error || ('HTTP ' + r.status)));
      notifySent(sent, j);
      const who = `${j.recipientCount} recipient${j.recipientCount === 1 ? '' : 's'}`;
      if (j.warning) {
        // The email did go out, just not the way they asked. Leave the warning
        // on screen instead of auto-closing — but keep Send disabled, or a
        // second click sends a duplicate. Cancel becomes the way out.
        setStatus(`Sent to ${who}. ${j.warning}`, 'error');
        const cancelBtn = document.getElementById('rem-cancel');
        if (cancelBtn) cancelBtn.textContent = 'Close';
        return;
      }
      const pdfNote = j.pdfAttached
        ? ` PDF attached${j.pdfPages ? ` (${j.pdfPages} page${j.pdfPages === 1 ? '' : 's'})` : ''}.`
        : '';
      setStatus(`Sent to ${who}.${pdfNote}`, 'ok');
      setTimeout(close, 1400);
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
          <div id="rem-contact-form" style="display:none;margin-top:0.35rem;padding:0.5rem 0.6rem;border:1px solid #374151;border-radius:6px;background:#0f172a;"></div>
          <div id="rem-suggest" style="display:none;margin-top:0.35rem;"></div>
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

          <label for="rem-pdf" style="display:flex;align-items:flex-start;gap:0.5rem;margin-top:0.85rem;padding:0.55rem 0.65rem;background:#020617;border:1px solid #1f2937;border-radius:6px;cursor:pointer;">
            <input id="rem-pdf" type="checkbox" checked style="margin-top:0.15rem;accent-color:#047857;cursor:pointer;">
            <span>
              <span style="display:block;font-size:0.82rem;color:#e5e7eb;font-weight:600;">Attach the report as a PDF</span>
              <span style="display:block;font-size:0.7rem;color:#9ca3af;margin-top:0.12rem;">The email body keeps the note and key figures; the full report rides along as a PDF that reads the same on every device. Uncheck to put the whole report in the body instead.</span>
            </span>
          </label>
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
    // Typed or pasted: the good addresses become chips; any the send would
    // be refused over stay in the box, named, to be corrected.
    const inp = document.getElementById('rem-input');
    const addTyped = quiet => {
      const v = inp.value;
      if (v.trim()) state.manualEdit = true;
      const { added, bad } = addEmail(v);
      if (bad.length) {
        inp.value = bad.join(', ');
        setStatus(`Not added: ${bad.join(', ')} — ${bad.length > 1 ? 'not valid email addresses' : 'not a valid email address'}.`, 'error');
      } else if (added > 0) { inp.value = ''; setStatus(''); }
      else if (v && !quiet) setStatus('No valid emails to add.', 'error');
    };
    document.getElementById('rem-add').onclick = () => addTyped(false);
    inp.onkeydown = ev => {
      if (ev.key === 'Enter' || ev.key === ',') {
        ev.preventDefault();
        addTyped(true);
      }
    };
    // Click outside to close (but only if click is on the dim backdrop, not the dialog).
    wrap.addEventListener('click', ev => { if (ev.target === wrap) close(); });
    // Escape closes.
    const onEsc = ev => { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } };
    document.addEventListener('keydown', onEsc);

    document.getElementById('rem-chips').addEventListener('click', onChipClick);
    document.getElementById('rem-suggest').addEventListener('click', onSuggestClick);

    renderChips();
    seedRecipients(state.defaultRecipients, state.contacts);
    renderSuggestions();
    loadGroups();
    setTimeout(() => inp.focus(), 30);
  }

  // ── Public entry point ──────────────────────────────────────────────
  const REPORT_LABELS = {
    executive:            'Executive Report',
    turf_daily_pm:        'Daily PM Report — Turf',
    turf_daily_summary:   'Daily Summary — Turf',
    turf_bid_items:       'Bid Line Items vs Actuals — Turf',
    turf_job_summary:     'Job Summary — Turf',
    paving_daily_pm:      'Daily PM Report — Paving',
    paving_daily_summary: 'Daily Summary — Paving',
    paving_bid_items:     'Bid Line Items vs Actuals — Paving',
    paving_job_summary:   'Job Summary — Paving',
    kiewit_daily_pm:      'Daily PM Report — Kiewit Pinetree',
    kiewit_daily_summary: 'Daily Summary — Kiewit Pinetree',
    kiewit_bid_items:     'Bid Line Items vs Actuals — Kiewit Pinetree',
    kiewit_job_summary:   'Job Summary — Kiewit Pinetree',
    kiewit_construction_schedule: 'Construction Schedule — Kiewit Pinetree',
    turf_custom_report:   'Custom Report — Turf',
    paving_custom_report: 'Custom Report — Paving',
    kiewit_custom_report: 'Custom Report — Kiewit Pinetree',
    dust_tracking_summary:'Dust Control Tracking Report',
    crm_next_steps:       'Next Steps Due — CRM',
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
      getAttachments: typeof opts.getAttachments === 'function' ? opts.getAttachments : null,
      getSummary:     typeof opts.getSummary === 'function' ? opts.getSummary : null,
      onSent:         typeof opts.onSent === 'function' ? opts.onSent : null,
      customReport:   opts.customReport && typeof opts.customReport === 'object' ? opts.customReport : null,
      defaultRecipients: Array.isArray(opts.defaultRecipients) ? opts.defaultRecipients.slice(0, 200) : [],
      contacts:       Array.isArray(opts.contacts) ? opts.contacts.slice(0, 200) : [],
      suggested:      cleanContactList(opts.suggestedContacts),
      suggestedNote:  typeof opts.suggestedNote === 'string' ? opts.suggestedNote.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
      contactContext: readContactContext(opts.contactContext),
      contactMeta:    new Map(),   // email → { name, title, source, saved? }
      contactForm:    null,        // the address the Save-as-contact form is open for
      seedNote:       '',
      manualEdit:     false,       // the user added or removed a recipient themselves
      recipients:     [],
      groups:         [],
      serverIsAdmin:  false,
      sending:        false,
      didAutoAdd:     false,
    };
    buildModal();
  }

  window.openReportEmailModal = openReportEmailModal;
  // The scheduled sends (auto-report.js) put the same key figures in the email
  // body the modal does, so they read them out the same way.
  window.dwExtractReportSummary = extractSummary;
})();
