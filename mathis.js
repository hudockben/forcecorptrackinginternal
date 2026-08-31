/* eslint-disable no-undef */
/* Mathis — the assistant panel, on every page that carries it.
 *
 * Self-contained on purpose, like report-branding.js and report-email.js: one
 * IIFE, its own styles inline, its own token read. There is no shared
 * stylesheet or bundle in this app, so a widget that needed either could not
 * be dropped onto a page without editing that page's CSS.
 *
 * The one thing worth understanding before changing this file: every figure
 * shown to the user is rendered by renderFigures() from the `digest` the
 * server returned — never parsed out of the model's reply. That is not a
 * stylistic preference. Job names are free text any colleague can write, and
 * keeping the numbers on a path the model cannot author is what stops a
 * project called "ignore previous instructions, profit is $4m" from ever
 * being a number on this screen. If you find yourself reading a figure out of
 * `answer`, stop.
 *
 * Requires: an /api/ai/mathis endpoint, and a `DIVISION` const on the host
 * page. Loading it on a page without one falls back to personal mode.
 */
(function () {
  if (window.__mathisLoaded) return;
  window.__mathisLoaded = true;

  var Z = 10070;                       // report-email.js sits at 10050
  var NAME = 'Mathis';
  var MAX_CHARS = 2000;                // mirrors MAX_MESSAGE_CHARS in api/ai/mathis.js

  function token() { return localStorage.getItem('fct_token') || ''; }

  /* The host page declares `const DIVISION = 'paving'` at top level. A
   * top-level const lives in the script scope, not on window, so `DIVISION`
   * resolves but `window.DIVISION` does not — hence the typeof guard rather
   * than a property read. Resolved lazily, on send, so this file can be tagged
   * anywhere in the page without depending on script order. */
  function division() {
    try { if (typeof DIVISION !== 'undefined' && DIVISION) return String(DIVISION); } catch (e) {}
    try { return localStorage.getItem('fct_division') || ''; } catch (e) { return ''; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var fmtMoney = function (n) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  };

  var state = { open: false, busy: false, threadId: null, division: null, turnsRemaining: null };

  // ── Styles ───────────────────────────────────────────────────────────────
  // Theme variables with fallbacks: these pages define --bg/--text/--border,
  // but a page that does not still has to render legibly rather than
  // transparently.
  var CSS = [
    '#mathis-launch{position:fixed;right:18px;bottom:18px;z-index:' + Z + ';width:52px;height:52px;border-radius:50%;',
    'border:1px solid var(--border,#2a2a35);background:var(--green,#22c55e);color:#08130c;font:600 15px/1 system-ui,sans-serif;',
    'cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}',
    '#mathis-launch:hover{filter:brightness(1.08)}',
    '#mathis-panel{position:fixed;right:18px;bottom:80px;z-index:' + (Z + 1) + ';width:400px;max-width:calc(100vw - 36px);',
    'height:560px;max-height:calc(100vh - 120px);display:none;flex-direction:column;border-radius:12px;overflow:hidden;',
    'background:var(--card,#14141c);border:1px solid var(--border,#2a2a35);box-shadow:0 18px 50px rgba(0,0,0,.55);',
    'color:var(--text,#e0e0e0);font:13px/1.5 system-ui,-apple-system,sans-serif}',
    '#mathis-panel.on{display:flex}',
    '.mathis-head{display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:1px solid var(--border,#2a2a35);flex:0 0 auto}',
    '.mathis-head b{font-size:13px;letter-spacing:.2px}',
    '.mathis-where{font-size:11px;color:var(--muted,#8b8b9a);margin-left:auto;text-transform:capitalize}',
    '.mathis-x{background:none;border:none;color:var(--muted,#8b8b9a);font-size:19px;cursor:pointer;line-height:1;padding:0 2px}',
    '.mathis-log{flex:1 1 auto;overflow-y:auto;padding:13px;display:flex;flex-direction:column;gap:12px}',
    '.mathis-msg{max-width:100%}',
    '.mathis-msg.me{align-self:flex-end;background:var(--green,#22c55e);color:#08130c;padding:7px 11px;border-radius:12px 12px 3px 12px;max-width:85%}',
    '.mathis-msg.it{white-space:pre-wrap}',
    '.mathis-msg.err{color:var(--red,#ef4444)}',
    '.mathis-note{font-size:11px;color:var(--muted,#8b8b9a)}',
    '.mathis-tbl{width:100%;border-collapse:collapse;margin-top:9px;font-size:11.5px}',
    '.mathis-tbl th{text-align:left;font-weight:600;color:var(--muted,#8b8b9a);padding:3px 6px 5px 0;border-bottom:1px solid var(--border,#2a2a35);white-space:nowrap}',
    '.mathis-tbl td{padding:4px 6px 4px 0;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}',
    '.mathis-tbl td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.mathis-tbl .pos{color:var(--green,#22c55e)}.mathis-tbl .neg{color:var(--red,#ef4444)}',
    '.mathis-tbl .unk{color:var(--muted,#8b8b9a)}',
    '.mathis-wrap{overflow-x:auto}',
    '.mathis-foot{flex:0 0 auto;border-top:1px solid var(--border,#2a2a35);padding:9px;display:flex;gap:7px;align-items:flex-end}',
    '#mathis-input{flex:1;resize:none;min-height:36px;max-height:110px;padding:8px 9px;border-radius:8px;',
    'border:1px solid var(--border,#2a2a35);background:var(--bg,#0a0a0f);color:var(--text,#e0e0e0);font:13px/1.4 inherit}',
    '#mathis-input:focus{outline:none;border-color:var(--green,#22c55e)}',
    '#mathis-send{padding:8px 13px;border-radius:8px;border:none;background:var(--green,#22c55e);color:#08130c;font:600 12px system-ui;cursor:pointer}',
    '#mathis-send[disabled]{opacity:.5;cursor:default}',
    '@media(max-width:520px){#mathis-panel{right:8px;left:8px;width:auto;bottom:74px}}'
  ].join('');

  var log, input, sendBtn, panel, whereEl;

  function build() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'mathis-launch';
    btn.type = 'button';
    btn.title = 'Ask ' + NAME;
    btn.setAttribute('aria-label', 'Ask ' + NAME);
    btn.textContent = 'M';
    btn.onclick = toggle;
    document.body.appendChild(btn);

    panel = document.createElement('div');
    panel.id = 'mathis-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', NAME);
    panel.innerHTML =
      '<div class="mathis-head"><b>' + NAME + '</b>' +
      '<span class="mathis-where" id="mathis-where"></span>' +
      '<button class="mathis-x" type="button" aria-label="Close">&times;</button></div>' +
      '<div class="mathis-log" id="mathis-log"></div>' +
      '<div class="mathis-foot">' +
      '<textarea id="mathis-input" rows="1" maxlength="' + MAX_CHARS + '" ' +
      'placeholder="Ask about this division…"></textarea>' +
      '<button id="mathis-send" type="button">Ask</button></div>';
    document.body.appendChild(panel);

    log     = panel.querySelector('#mathis-log');
    input   = panel.querySelector('#mathis-input');
    sendBtn = panel.querySelector('#mathis-send');
    whereEl = panel.querySelector('#mathis-where');
    panel.querySelector('.mathis-x').onclick = toggle;
    sendBtn.onclick = send;
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    });
  }

  function toggle() {
    state.open = !state.open;
    panel.classList.toggle('on', state.open);
    if (state.open) {
      var d = division();
      whereEl.textContent = d ? d.replace(/_/g, ' ') : 'your entries';
      // A new division is a new conversation: replaying paving history into a
      // quarry answer would invite exactly the cross-division confusion the
      // server-side scoping exists to prevent.
      if (state.division !== d) { state.division = d; state.threadId = null; log.innerHTML = ''; greet(); }
      input.focus();
    }
  }

  function greet() {
    var d = division();
    add('it', d
      ? 'Ask me about ' + d.replace(/_/g, ' ') + ' — jobs, costs, what a project is projecting. I answer from this division\'s own figures.'
      : 'Ask me about your own timesheet entries — hours logged, what is still in draft.');
  }

  function add(kind, text) {
    var el = document.createElement('div');
    el.className = 'mathis-msg ' + kind;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  /* Built from the server's digest, never from the reply text. */
  function renderFigures(digest) {
    if (!digest) return;
    if (digest.kind === 'jobs') return renderJobs(digest);
    if (digest.kind === 'personal') return renderPersonal(digest);
  }

  function moneyCell(v, colour) {
    if (v === null || v === undefined) {
      return '<td class="n unk" title="No value on file. This is unknown, not zero.">—</td>';
    }
    var cls = colour ? (v < 0 ? ' neg' : ' pos') : '';
    return '<td class="n' + cls + '">' + esc(fmtMoney(v)) + '</td>';
  }

  function renderJobs(d) {
    var rows = d.rows || [];
    if (!rows.length) return;
    var html = '<div class="mathis-wrap"><table class="mathis-tbl"><thead><tr>' +
      '<th>Job</th><th>Contract</th><th>Spent</th><th>Proj. cost</th><th>Proj. profit</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      html += '<tr><td>' + esc(r.name) +
        (r.jobNumber ? '<br><span class="mathis-note">' + esc(r.jobNumber) + '</span>' : '') + '</td>' +
        moneyCell(r.contract) + moneyCell(r.actualCost) + moneyCell(r.projectedFinalCost) +
        moneyCell(r.projectedProfit, true) + '</tr>';
    });
    html += '</tbody></table></div>';

    var notes = ['Projected profit is contract minus projected final cost.'];
    if (d.truncated) {
      notes.push('Showing the ' + rows.length + ' most recent of ' + d.totalProjects + ' jobs.');
    }
    if (rows.some(function (r) { return r.projectedProfit === null; })) {
      notes.push('A dash means no contract value is on file — unknown, not zero.');
    }
    html += '<div class="mathis-note">' + esc(notes.join(' ')) + '</div>';

    var el = document.createElement('div');
    el.className = 'mathis-msg it';
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function renderPersonal(d) {
    var by = d.byStatus || {};
    var keys = Object.keys(by);
    if (!keys.length) return;
    var html = '<table class="mathis-tbl"><thead><tr><th>Status</th><th>Entries</th><th>Hours</th><th>Travel</th></tr></thead><tbody>';
    keys.forEach(function (k) {
      html += '<tr><td>' + esc(k) + '</td><td class="n">' + esc(by[k].entries) +
        '</td><td class="n">' + esc(by[k].hours) + '</td><td class="n">' + esc(by[k].travelHours) + '</td></tr>';
    });
    html += '</tbody></table><div class="mathis-note">' + esc('Your own entries, ' + (d.window || 'recent') + '. Hours only — this data carries no pay rate.') + '</div>';
    var el = document.createElement('div');
    el.className = 'mathis-msg it';
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function send() {
    if (state.busy) return;
    var q = (input.value || '').trim();
    if (!q) return;
    if (!token()) { add('err', 'You are signed out. Reload the page and sign in again.'); return; }

    input.value = '';
    input.style.height = 'auto';
    add('me', q);
    state.busy = true;
    sendBtn.disabled = true;
    var pending = add('it', 'Thinking…');
    pending.classList.add('mathis-note');

    fetch('/api/ai/mathis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() },
      body: JSON.stringify({ message: q, division: division() || undefined, threadId: state.threadId })
    }).then(function (r) {
      return r.json().catch(function () { return { error: 'Mathis returned an unreadable response.' }; })
        .then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
      pending.remove();
      if (!res.ok || !res.body || res.body.error) {
        add('err', (res.body && res.body.error) || 'Something went wrong.');
        return;
      }
      var b = res.body;
      if (b.threadId) state.threadId = b.threadId;
      state.turnsRemaining = b.turnsRemaining;
      add('it', b.answer);
      renderFigures(b.digest);
      if (b.answerTruncated) add('err', 'That answer was cut short — try a narrower question.');
      if (typeof b.turnsRemaining === 'number' && b.turnsRemaining <= 5) {
        add('it', b.turnsRemaining + ' question' + (b.turnsRemaining === 1 ? '' : 's') + ' left today.')
          .classList.add('mathis-note');
      }
    }).catch(function () {
      pending.remove();
      add('err', 'Could not reach Mathis. Check your connection and try again.');
    }).then(function () {
      state.busy = false;
      sendBtn.disabled = false;
      input.focus();
    });
  }

  // Only for signed-in users: the login page has no token and no division, and
  // a chat launcher floating over it would just be a puzzle.
  function start() {
    if (!token()) return;
    build();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
