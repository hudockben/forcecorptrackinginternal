/* eslint-disable no-undef */
/* DataWatch — Custom Reporting: the AI report builder panel
 *
 * The chat in the builder's "✨ AI Builder" drawer. The user describes a
 * report — "Turf Install on all active jobs, last week, with a chart" — and
 * the answer from /api/ai/report-builder is a report definition, which this
 * panel checks and hands to the builder as one undoable change.
 *
 *   window.FCTReportAI = { mount(el, adapter) → { destroy, send, reset, refresh }, _internals }
 *
 * custom-reports.js owns the report and supplies the adapter:
 *   getDefinition()            the report on screen, as a definition
 *   applyDefinition(def, info) replace it (pushes an undo step, marks unsaved)
 *   undo()                     take the last applied step back
 *   getJobs()                  [{ id, name, number, client, status }]
 *   getCodes()                 { costCodes: [...], subCodes: [{ code, description, unit }] }
 *   division, divisionLabel, apiBase, getToken(), onAuthError()
 *   requestInternal()          the builder's own "include internal data" confirm
 *   isReadOnly()
 *
 * What the panel will not do, whatever comes back from the server:
 *   - switch internal data on. A definition it applies always says
 *     includeInternal:false, and the builder keeps the report's own setting.
 *     When the user asked for costs or hours the panel offers "Turn on
 *     internal data…", which only asks the builder to show its confirm.
 *   - pick a job that is not in this division's list. Ids are checked against
 *     getJobs() before anything is applied.
 *   - apply anything that has not been through the engine's
 *     normalizeDefinition — the same pass a saved report gets.
 *   - send a job's contract, costs or anything else beyond id, name, number,
 *     client and status to the server (which whitelists them again).
 *
 * The conversation lives in memory for the open report; the builder mounts a
 * fresh panel when another report is opened. At most the last 12 messages go
 * with each request. Everything shown is escaped; there are no inline
 * handlers — every listener is delegated from the panel's root.
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.FCTReportAI) return;

  const MAX_MESSAGE = 2000;
  const MAX_HISTORY = 12;          // messages sent with a request
  const MAX_HISTORY_CHARS = 4000;  // each
  const MAX_JOBS = 1000;
  const MAX_CODES = 500;
  const MAX_FIELD = 120;
  const CLIENT_TIMEOUT_MS = 75000; // the server gives up first, at about 55 s
  const HEADER_KEEP = ['preparedBy', 'contactName', 'contactPhone', 'contactEmail'];
  const INTERNAL_ON_TEXT = 'Internal data is on — don\u2019t send this report to a customer.';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
  const field = (v, n) => {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) : s;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
  const pad = n => String(n).padStart(2, '0');
  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function call(fn, fallback) {
    try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; }
  }

  // ── What goes to the server ─────────────────────────────────────────
  /* The division's jobs, five fields each and nothing else: a job object
     carrying a contract value or costs still sends only these. */
  function jobList(adapter) {
    const raw = call(() => adapter.getJobs(), []);
    const out = [], seen = new Set();
    (Array.isArray(raw) ? raw : []).forEach(j => {
      if (!isObj(j) || out.length >= MAX_JOBS) return;
      const id = field(j.id, MAX_FIELD);
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name: field(j.name, MAX_FIELD), number: field(j.number, MAX_FIELD),
        client: field(j.client, MAX_FIELD), status: field(j.status, MAX_FIELD) });
    });
    return out;
  }
  function codeList(adapter) {
    const raw = call(() => adapter.getCodes(), {});
    const c = isObj(raw) ? raw : {};
    const costCodes = [...new Set((Array.isArray(c.costCodes) ? c.costCodes : [])
      .map(x => field(isObj(x) ? x.code : x, MAX_FIELD)).filter(Boolean))].slice(0, MAX_CODES);
    const seen = new Set();
    const subCodes = [];
    (Array.isArray(c.subCodes) ? c.subCodes : []).forEach(x => {
      const code = field(isObj(x) ? x.code : x, MAX_FIELD);
      if (!code || seen.has(code) || subCodes.length >= MAX_CODES) return;
      seen.add(code);
      subCodes.push({ code, description: isObj(x) ? field(x.description, MAX_FIELD) : '', unit: isObj(x) ? field(x.unit, 20) : '' });
    });
    return { costCodes, subCodes };
  }
  function currentDefinition(adapter) {
    const d = call(() => adapter.getDefinition(), null);
    return isObj(d) ? d : null;
  }
  function buildBody(adapter, message, history) {
    return {
      message,
      history: history.slice(-MAX_HISTORY).map(m => ({ role: m.role, content: String(m.content).slice(0, MAX_HISTORY_CHARS) })),
      definition: currentDefinition(adapter),
      jobs: jobList(adapter),
      codes: codeList(adapter),
      today: localToday(),
    };
  }

  // ── What came back ──────────────────────────────────────────────────
  /* The server's definition, made safe to apply: job ids only from this
     division's list, the header fields the AI is never asked about kept as
     the user left them, run through the engine's normalizeDefinition, and
     includeInternal forced off. → { def, droppedJobs } or { error }. */
  function prepareDefinition(raw, adapter, current) {
    const E = root.FCTReportEngine;
    if (!E || typeof E.normalizeDefinition !== 'function') return { error: 'The report engine has not loaded — refresh the page and try again.' };
    if (!isObj(raw)) return { error: 'The AI builder did not send a report back. Try again.' };
    let src;
    try { src = JSON.parse(JSON.stringify(raw)); } catch (_) { return { error: 'The AI builder sent back a report that could not be read.' }; }
    const known = new Set(jobList(adapter).map(j => j.id));
    const jobsIn = isObj(src.jobs) ? src.jobs : {};
    const ids = Array.isArray(jobsIn.ids) ? jobsIn.ids : [];
    const kept = [];
    let droppedJobs = 0;
    ids.forEach(v => {
      const id = field(v, MAX_FIELD);
      if (known.has(id)) { if (!kept.includes(id)) kept.push(id); } else droppedJobs++;
    });
    src.jobs = { mode: jobsIn.mode === 'saved' ? 'saved' : 'pick', ids: kept };
    const curH = current && isObj(current.header) ? current.header : {};
    src.header = isObj(src.header) ? src.header : {};
    HEADER_KEEP.forEach(k => { if (src.header[k] === undefined && typeof curH[k] === 'string') src.header[k] = curH[k]; });
    delete src.includeInternal;
    let def;
    try { def = E.normalizeDefinition(src); } catch (_) { return { error: 'The AI builder sent back a report that could not be read.' }; }
    def.includeInternal = false;
    return { def, droppedJobs };
  }
  // Same report, ignoring section ids (the engine gives every new section a
  // fresh one) and the internal switch (never the AI's to change).
  function sameDefinition(a, b) {
    const strip = d => {
      const x = JSON.parse(JSON.stringify(d || {}));
      delete x.includeInternal;
      if (isObj(x.jobs) && Array.isArray(x.jobs.ids)) x.jobs.ids = x.jobs.ids.map(String);
      (Array.isArray(x.sections) ? x.sections : []).forEach(s => { if (isObj(s)) delete s.id; });
      return JSON.stringify(x);
    };
    return strip(a) === strip(b);
  }

  /* "Turf Install on all active jobs…" is a turf request; elsewhere the first
     chip names a sub code the division actually uses. */
  function suggestions(adapter) {
    const jobs = jobList(adapter);
    const codes = codeList(adapter);
    const division = call(() => adapter.division, '');
    let work;
    if (division === 'turf') work = 'Turf Install';
    else {
      const s = codes.subCodes[0];
      work = s ? (s.description || s.code) : '';
    }
    const first = jobs.find(j => /^in progress$/i.test(j.status)) || jobs[0];
    return [
      work ? `${work} on all active jobs, last week, with a chart` : 'Daily production on all active jobs, last week, with a chart',
      first ? `Customer progress update for ${first.name || first.number || first.id}` : 'Customer progress update for one job',
      'Planned vs actual for every In Progress job',
    ];
  }

  function errorFor(status, data) {
    const said = data && typeof data.error === 'string' ? data.error : '';
    if (status === 401) return { text: 'Your sign-in has expired. Sign in again, then send that once more.', retry: true };
    if (status === 503) {
      return { text: said === 'AI not configured' || !said
        ? 'The AI builder is not set up on this server yet — an administrator needs to add the AI key. You can still build the report by hand.'
        : said };
    }
    if (status === 429) return { text: said || 'You have reached today\'s limit for the AI builder. It resets tomorrow.' };
    if (status === 400 || status === 403) return { text: said || 'The AI builder could not take that request.' };
    return { text: said || 'The AI builder could not answer just now. Try again in a moment.', retry: true };
  }

  // ── Styles ──────────────────────────────────────────────────────────
  // Host page variables with dark fallbacks, like the builder's own.
  const CSS = `
.crai{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;color:var(--text,#e0e0e0);font-size:13px;line-height:1.45}
.crai *{box-sizing:border-box}
.crai :focus-visible{outline:2px solid var(--green,#22c55e);outline-offset:1px}
.crai-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.crai-log{flex:1 1 auto;min-height:0;overflow-y:auto;padding:.75rem .8rem;display:flex;flex-direction:column;gap:.6rem}
.crai-welcome{font-size:.8rem;opacity:.85}
.crai-welcome p{margin:0 0 .45rem}
.crai-fine{font-size:.74rem;opacity:.7}
.crai-msg{display:flex;min-width:0}
.crai-user{justify-content:flex-end}
.crai-bubble{max-width:92%;min-width:0;padding:.5rem .65rem;border-radius:8px;border:1px solid var(--border,#2a2a3a);background:var(--surface2,#1a1a26);overflow-wrap:anywhere;word-break:break-word}
.crai-user .crai-bubble{background:color-mix(in srgb,var(--green,#22c55e) 16%,transparent);border-color:color-mix(in srgb,var(--green,#22c55e) 45%,transparent);white-space:pre-wrap}
.crai-err .crai-bubble{border-color:#ef4444;background:rgba(239,68,68,.1);color:#fecaca}
.crai-reply{margin:0}
.crai-q{margin:.45rem 0 0;padding:.4rem .5rem;border-left:3px solid var(--yellow,#eab308);background:rgba(234,179,8,.1);border-radius:0 5px 5px 0}
.crai-q-tag{display:block;font-size:.68rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;opacity:.8}
.crai-changes{margin:.45rem 0 0;padding-left:1.1rem;font-size:.78rem}
.crai-changes li{margin:.1rem 0}
.crai-note{margin:.4rem 0 0;font-size:.74rem;opacity:.75}
.crai-acts{display:flex;flex-wrap:wrap;gap:.35rem;margin-top:.5rem}
.crai-acts:empty{display:none}
.crai-btn{font:inherit;font-size:.74rem;padding:.28rem .6rem;border-radius:5px;border:1px solid var(--border,#2a2a3a);background:transparent;color:var(--text,#e0e0e0);cursor:pointer;white-space:nowrap}
.crai-btn:hover:not(:disabled){border-color:var(--green,#22c55e)}
.crai-btn:disabled{opacity:.45;cursor:not-allowed}
.crai-btn-warn{border-color:#ef4444;color:#fca5a5}
.crai-done{font-size:.74rem;opacity:.7;align-self:center}
.crai-typing .crai-bubble{display:inline-flex;align-items:center;gap:.3rem;opacity:.85}
.crai-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.4;animation:crai-b 1.2s infinite ease-in-out}
.crai-dot:nth-child(2){animation-delay:.15s}.crai-dot:nth-child(3){animation-delay:.3s}
@keyframes crai-b{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (prefers-reduced-motion:reduce){.crai-dot{animation:none;opacity:.7}}
.crai-chips{display:flex;flex-wrap:wrap;gap:.35rem;padding:0 .8rem .6rem}
.crai-chips[hidden]{display:none}
.crai-chip{font:inherit;font-size:.74rem;text-align:left;padding:.3rem .6rem;border-radius:999px;border:1px solid var(--border,#2a2a3a);background:var(--surface2,#1a1a26);color:var(--text,#e0e0e0);cursor:pointer;max-width:100%;overflow-wrap:anywhere}
.crai-chip:hover:not(:disabled){border-color:var(--green,#22c55e)}
.crai-chip:disabled{opacity:.45;cursor:not-allowed}
.crai-form{border-top:1px solid var(--border,#2a2a3a);padding:.6rem .8rem .7rem;display:flex;flex-direction:column;gap:.4rem;margin:0}
.crai-in{width:100%;min-height:3.6rem;max-height:12rem;resize:vertical;background:var(--bg,#0a0a0f);border:1px solid var(--border,#2a2a3a);color:var(--text,#e0e0e0);border-radius:5px;padding:.45rem .55rem;font:inherit;font-size:.82rem;line-height:1.45}
.crai-in:focus{border-color:var(--green,#22c55e);outline:none}
.crai-in:disabled{opacity:.5;cursor:not-allowed}
.crai-bar{display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap}
.crai-count{font-size:.7rem;opacity:.6}
.crai-count.crai-over{color:#fca5a5;opacity:1}
.crai-bar-r{display:flex;gap:.35rem;align-items:center;margin-left:auto}
.crai-send{font:inherit;font-size:.78rem;font-weight:600;padding:.36rem .9rem;border-radius:5px;border:0;background:var(--green,#22c55e);color:#04130a;cursor:pointer}
.crai-send:disabled{opacity:.45;cursor:not-allowed}
.crai-link{font:inherit;font-size:.72rem;background:none;border:0;color:var(--text,#e0e0e0);opacity:.65;cursor:pointer;text-decoration:underline;padding:.2rem}
.crai-link[hidden]{display:none}
.crai-ro{margin:0;font-size:.76rem;padding:.45rem .55rem;border-radius:5px;border:1px solid var(--yellow,#eab308);background:rgba(234,179,8,.08)}
.crai-ro[hidden]{display:none}
`;
  function injectStyles(doc) {
    if (!doc || doc.getElementById('crai-styles')) return;
    const el = doc.createElement('style');
    el.id = 'crai-styles';
    el.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(el);
  }

  let mounts = 0;

  // ── The panel ───────────────────────────────────────────────────────
  function mount(el, adapter) {
    if (!el || !adapter) throw new Error('FCTReportAI.mount needs an element and an adapter');
    const doc = el.ownerDocument || root.document;
    injectStyles(doc);
    const uid = ++mounts;
    const st = {
      turns: [],        // what the log shows
      history: [],      // what the server is sent: completed exchanges only
      busy: false,
      destroyed: false,
      ctrl: null,
      chips: suggestions(adapter),
      lastText: '',
      gen: 0,           // bumped by reset(): an answer to a cleared chat is dropped
    };

    el.innerHTML = `<div class="crai" role="region" aria-label="AI report builder">
  <div class="crai-log" role="log" aria-live="polite" aria-relevant="additions"></div>
  <div class="crai-chips" role="group" aria-label="Suggestions"></div>
  <form class="crai-form" novalidate>
    <p class="crai-ro" hidden></p>
    <label class="crai-sr" for="crai-in-${uid}">Describe the report you want</label>
    <textarea class="crai-in" id="crai-in-${uid}" rows="3" maxlength="${MAX_MESSAGE}" placeholder="Describe the report — e.g. Turf Install on all active jobs, last week, with a chart"></textarea>
    <div class="crai-bar"><span class="crai-count" aria-hidden="true"></span>
      <div class="crai-bar-r"><button type="button" class="crai-link" data-crai-act="clear" hidden>Clear chat</button>
      <button type="submit" class="crai-send">Send</button></div></div>
  </form>
</div>`;
    const $ = sel => el.querySelector(sel);
    const panel = $('.crai'), log = $('.crai-log'), chipsEl = $('.crai-chips'), form = $('.crai-form');
    const input = $('.crai-in'), sendBtn = $('.crai-send'), countEl = $('.crai-count'), roEl = $('.crai-ro'), clearBtn = $('[data-crai-act="clear"]');

    const readOnly = () => !!call(() => adapter.isReadOnly(), false);
    const internalOnNow = () => { const d = currentDefinition(adapter); return !!(d && d.includeInternal === true); };
    const latestUndoable = () => { for (let i = st.turns.length - 1; i >= 0; i--) { const t = st.turns[i]; if (t.role === 'assistant' && t.applied && !t.undone) return t; } return null; };

    function syncControls() {
      const ro = readOnly();
      roEl.hidden = !ro;
      roEl.textContent = ro
        ? 'This is a shared template that only an admin or level 3 user can change, so the AI builder cannot edit it. Use Duplicate (or Save As) to make your own copy, then ask again.'
        : '';
      input.disabled = ro;
      sendBtn.disabled = ro || st.busy;
      chipsEl.querySelectorAll('button').forEach(b => { b.disabled = ro || st.busy; });
      clearBtn.hidden = !st.turns.length || st.busy;
      const n = input.value.length;
      countEl.textContent = n > MAX_MESSAGE - 200 ? `${n} / ${MAX_MESSAGE}` : '';
      countEl.classList.toggle('crai-over', n > MAX_MESSAGE);
    }

    function turnHtml(t, i) {
      if (t.role === 'user') return `<div class="crai-msg crai-user"><div class="crai-bubble">${esc(t.text)}</div></div>`;
      if (t.role === 'error') {
        return `<div class="crai-msg crai-err" role="alert"><div class="crai-bubble"><p class="crai-reply">${esc(t.text)}</p>${
          t.retry && i === st.turns.length - 1 ? '<div class="crai-acts"><button type="button" class="crai-btn" data-crai-act="retry">Try again</button></div>' : ''}</div></div>`;
      }
      const parts = [];
      parts.push(`<p class="crai-reply">${esc(t.reply).replace(/\n/g, '<br>')}</p>`);
      if (t.question) parts.push(`<p class="crai-q"><span class="crai-q-tag">Question</span>${esc(t.question)}</p>`);
      if (t.changes.length) parts.push(`<ul class="crai-changes" aria-label="What changed">${t.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`);
      const notes = [];
      if (t.droppedJobs) notes.push(`Left out ${plural(t.droppedJobs, 'job')} that ${t.droppedJobs === 1 ? 'is' : 'are'} not in this division's list.`);
      if (t.droppedCodes) notes.push(`Left out ${plural(t.droppedCodes, 'code')} not found on these jobs.`);
      if (t.unchanged) notes.push('The report is unchanged.');
      if (t.applyError) notes.push(t.applyError);
      if (t.undoError) notes.push(t.undoError);
      notes.forEach(n => parts.push(`<p class="crai-note">${esc(n)}</p>`));
      const acts = [];
      if (t.applied) {
        if (t.undone) acts.push('<span class="crai-done">Undone</span>');
        else {
          const top = latestUndoable() === t;
          acts.push(`<button type="button" class="crai-btn" data-crai-act="undo" data-turn="${i}"${top && !st.busy ? '' : ' disabled'}${top ? '' : ' title="Undo the later change first"'}>Undo</button>`);
        }
      }
      if (t.needsInternal && !t.undone) {
        acts.push(internalOnNow()
          ? `<span class="crai-done">${esc(INTERNAL_ON_TEXT)}</span>`
          : `<button type="button" class="crai-btn crai-btn-warn" data-crai-act="internal" data-turn="${i}">Turn on internal data…</button>`);
      }
      parts.push(`<div class="crai-acts">${acts.join('')}</div>`);
      return `<div class="crai-msg crai-bot"><div class="crai-bubble">${parts.join('')}</div></div>`;
    }

    function render() {
      if (st.destroyed) return;
      const welcome = `<div class="crai-welcome"><p><strong>Describe the report you want.</strong> I'll draft it in the builder for ${esc(call(() => adapter.divisionLabel, '') || 'this division')} — you check it, undo it if it's wrong, and save or send it yourself.</p>
<p class="crai-fine">Customer-safe by default. I can't switch on internal data (costs, hours, pay, names), and I never send anything.</p></div>`;
      const typing = st.busy ? '<div class="crai-msg crai-bot crai-typing" aria-label="The AI builder is working"><div class="crai-bubble"><span class="crai-dot"></span><span class="crai-dot"></span><span class="crai-dot"></span><span>Building…</span></div></div>' : '';
      log.innerHTML = welcome + st.turns.map(turnHtml).join('') + typing;
      log.scrollTop = log.scrollHeight;
      chipsEl.hidden = st.turns.length > 0;
      chipsEl.innerHTML = st.turns.length ? '' : st.chips.map((c, i) => `<button type="button" class="crai-chip" data-crai-act="chip" data-i="${i}">${esc(c)}</button>`).join('');
      syncControls();
    }

    function historyText(t) {
      const bits = [t.reply];
      if (t.question) bits.push(`Question: ${t.question}`);
      if (t.changes.length) bits.push(`Changes: ${t.changes.join('; ')}`);
      if (!t.applied && !t.unchanged) bits.push('(This was not applied to the report.)');
      if (t.undone) bits.push('(The user undid this change.)');
      return bits.join('\n').slice(0, MAX_HISTORY_CHARS);
    }

    async function send(text) {
      if (st.busy || st.destroyed) return false;
      const message = String(text == null ? '' : text).trim();
      if (!message) { input.focus(); return false; }
      if (message.length > MAX_MESSAGE) {
        st.turns.push({ role: 'error', text: `Keep it under ${MAX_MESSAGE} characters — that was ${message.length}.` });
        render();
        return false;
      }
      if (readOnly()) { syncControls(); return false; }

      // Sending a failed message again replaces it and its error.
      const n = st.turns.length;
      if (n >= 2 && st.turns[n - 1].role === 'error' && st.turns[n - 2].role === 'user' && st.turns[n - 2].text === message) st.turns.splice(n - 2, 2);
      st.turns.push({ role: 'user', text: message });
      const gen = st.gen;
      st.lastText = message;
      st.busy = true;
      input.value = '';
      render();

      const body = buildBody(adapter, message, st.history);
      const base = String(call(() => adapter.apiBase, '') || '/api').replace(/\/+$/, '');
      const url = `${base}/ai/report-builder?division=${encodeURIComponent(String(call(() => adapter.division, '') || ''))}`;
      const headers = { 'Content-Type': 'application/json' };
      const token = call(() => adapter.getToken(), null);
      if (token) headers.Authorization = `Bearer ${token}`;

      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      st.ctrl = ctrl;
      let timedOut = false;
      const timer = ctrl ? setTimeout(() => { timedOut = true; ctrl.abort(); }, CLIENT_TIMEOUT_MS) : null;
      let status = 0, data = null;
      try {
        const res = await root.fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
        status = res.status;
        data = await res.json().catch(() => null);
      } catch (_) {
        status = -1;
      } finally {
        if (timer) clearTimeout(timer);
        st.ctrl = null;
      }
      // The report was switched (or the drawer torn down, or the chat
      // cleared) while this was in flight: the answer was about a report or a
      // conversation that is no longer there.
      if (st.destroyed || gen !== st.gen) return false;
      st.busy = false;

      if (status === -1) {
        st.turns.push({ role: 'error', retry: true, text: timedOut
          ? 'The AI builder took too long. Try again, or ask for less at once.'
          : 'Could not reach the AI builder — check your connection and try again.' });
        render();
        return false;
      }
      if (status === 401) call(() => adapter.onAuthError(), null);
      if (status !== 200 || !isObj(data)) {
        const e = errorFor(status, data);
        st.turns.push({ role: 'error', text: e.text, retry: !!e.retry });
        render();
        return false;
      }
      if (data.ok !== true) {
        st.turns.push({ role: 'error', text: typeof data.error === 'string' && data.error ? data.error : 'I can\'t help with that request.' });
        render();
        return false;
      }

      const turn = {
        role: 'assistant',
        reply: typeof data.reply === 'string' && data.reply.trim() ? data.reply.trim() : 'Done.',
        question: typeof data.clarifying_question === 'string' ? data.clarifying_question.trim() : '',
        changes: (Array.isArray(data.changes) ? data.changes : []).filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()).slice(0, 20),
        needsInternal: data.needs_internal === true,
        droppedJobs: Number(data.dropped && data.dropped.jobs) || 0,
        droppedCodes: Number(data.dropped && data.dropped.codes) || 0,
        applied: false, undone: false, unchanged: false, applyError: '', undoError: '',
      };
      const current = currentDefinition(adapter);
      const prep = prepareDefinition(data.definition, adapter, current);
      if (prep.error) turn.applyError = prep.error;
      else {
        turn.droppedJobs += prep.droppedJobs;
        const E = root.FCTReportEngine;
        const curNorm = current ? call(() => E.normalizeDefinition(current), null) : null;
        if (curNorm && sameDefinition(prep.def, curNorm)) turn.unchanged = true;
        else if (readOnly()) turn.applyError = 'Not applied — this report is read-only for you.';
        else {
          let ok;
          try { ok = adapter.applyDefinition(prep.def, { changes: turn.changes.slice() }); } catch (_) { ok = false; }
          if (ok === false) turn.applyError = 'The builder could not take that change.';
          else turn.applied = true;
        }
      }
      st.turns.push(turn);
      st.history.push({ role: 'user', content: message.slice(0, MAX_HISTORY_CHARS) });
      const entry = { role: 'assistant', content: historyText(turn) };
      turn.historyEntry = entry;
      st.history.push(entry);
      if (st.history.length > MAX_HISTORY * 2) st.history.splice(0, st.history.length - MAX_HISTORY * 2);
      render();
      return turn.applied;
    }

    function undo(i) {
      const t = st.turns[i];
      if (!t || t.role !== 'assistant' || !t.applied || t.undone || st.busy) return false;
      if (latestUndoable() !== t) return false;
      let ok;
      try { ok = adapter.undo(); } catch (_) { ok = false; }
      if (ok === false) {
        t.undoError = 'Could not undo — the report may have been changed or closed since.';
        render();
        return false;
      }
      t.undone = true;
      t.undoError = '';
      if (t.historyEntry) t.historyEntry.content = historyText(t);
      render();
      return true;
    }

    // Asks; never sets. The builder's confirm decides, and the panel only
    // reads the answer back off the report.
    function askInternal() {
      let r;
      try { r = adapter.requestInternal(); } catch (_) { r = false; }
      if (r && typeof r.then === 'function') r.then(refreshInternal, refreshInternal);
      else refreshInternal();
      return r;
    }
    // The confirm closes outside this panel, so the button is checked again
    // whenever the user comes back to it — in place, so nothing they are
    // about to click is redrawn under them.
    function refreshInternal() {
      if (st.destroyed || !internalOnNow()) return;
      el.querySelectorAll('[data-crai-act="internal"]').forEach(b => {
        const span = doc.createElement('span');
        span.className = 'crai-done';
        span.textContent = INTERNAL_ON_TEXT;
        b.replaceWith(span);
      });
    }

    function reset() {
      st.gen++;
      if (st.ctrl) { try { st.ctrl.abort(); } catch (_) { /* gone */ } }
      st.turns = [];
      st.history = [];
      st.busy = false;
      st.chips = suggestions(adapter);
      render();
    }

    // ── Events, all delegated from the panel ──────────────────────────
    function onClick(e) {
      const b = e.target && e.target.closest ? e.target.closest('[data-crai-act]') : null;
      if (!b || !el.contains(b) || b.disabled) return;
      const act = b.getAttribute('data-crai-act');
      if (act === 'chip') {
        const c = st.chips[Number(b.getAttribute('data-i'))];
        if (c) { input.value = c; send(c); }
      } else if (act === 'undo') undo(Number(b.getAttribute('data-turn')));
      else if (act === 'internal') askInternal();
      else if (act === 'retry') send(st.lastText);
      else if (act === 'clear') { reset(); input.focus(); }
    }
    function onSubmit(e) { e.preventDefault(); send(input.value); }
    function onKey(e) {
      if (e.target !== input || e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
      e.preventDefault();
      send(input.value);
    }
    function onInput(e) { if (e.target === input) syncControls(); }
    panel.addEventListener('click', onClick);
    form.addEventListener('submit', onSubmit);
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', onInput);
    panel.addEventListener('focusin', refreshInternal);
    panel.addEventListener('pointerenter', refreshInternal);

    render();

    return {
      send: t => send(t),
      reset,
      refresh: () => render(),
      destroy() {
        st.destroyed = true;
        if (st.ctrl) { try { st.ctrl.abort(); } catch (_) { /* gone */ } }
        panel.removeEventListener('click', onClick);
        form.removeEventListener('submit', onSubmit);
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('input', onInput);
        panel.removeEventListener('focusin', refreshInternal);
        panel.removeEventListener('pointerenter', refreshInternal);
        el.innerHTML = '';
      },
      _state: () => st,
    };
  }

  root.FCTReportAI = {
    mount,
    _internals: { esc, jobList, codeList, buildBody, prepareDefinition, sameDefinition, suggestions, errorFor,
      MAX_MESSAGE, MAX_HISTORY, MAX_JOBS, MAX_CODES, CSS },
  };
})();
