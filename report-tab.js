/* eslint-disable no-undef */
/* DataWatch — a printed report in a tab of its own
 *
 *   const tab = dwReportTab({ title, waiting, onBlocked, features, print, brand });
 *   tab.fill(html)        // the report: branded, written in, prints itself.
 *                         // Returns a promise of true once the report is in
 *                         // its tab, false if it never got there
 *   tab.fail(message)     // the build failed: the tab says so
 *   tab.progress(text)    // while it builds: replace the waiting line
 *   tab.close()           // give up on it: the tab closes itself
 *   tab.closed            // true once the tab is known gone — closed by the
 *                         // user before its report came, blocked, or close()d
 *
 *   title     the tab's title until the report (which has its own) arrives
 *   waiting   what the tab says until then
 *   onBlocked called when the browser blocked the pop-up
 *   features  window.open features, e.g. 'width=1100,height=800', for a
 *             report that opens as a sized window rather than a tab
 *   print     true for a report that does not print itself: the tab calls
 *             print() once it is written, as the page used to call w.print()
 *   brand     false to write the HTML exactly as given (default: dwBrand it,
 *             the way dwWrite does)
 *
 * Call it inside the click that asked for the report — that is the only time
 * a browser allows a pop-up — then fill the tab whenever the report is built.
 * A report built in the click itself is just dwReportTab({...}).fill(html).
 *
 * Why not window.open('') and write into it, as the print paths used to: a
 * window this page can script is in this page's browsing context group, and
 * while a print dialog is up Chrome pauses every page in that group. So the
 * app froze behind the report — go back to it with the report's Print / Save
 * as PDF dialog open and nothing on it answered a click until the report tab
 * was closed.
 *
 * A tab opened with noopener is a group of its own; its dialog pauses only
 * itself. What noopener costs is the handle — window.open returns null — so
 * the tab opens on a small loader page (a blob: URL, so this page's origin)
 * that asks for its report over a BroadcastChannel and writes it into itself
 * when it lands, the same document.write the old window got. That same null
 * comes back for a blocked pop-up, so a blocked one shows up as a tab that
 * never asks for its report while this page keeps the screen.
 *
 * Everything is read off `window`, nothing off bare globals, so a test that
 * runs this against a stand-in window with no BroadcastChannel gets the old
 * window.open('') protocol below — the one its stand-in records.
 *
 * Load after report-branding.js. scripts/test-report-tab.js holds every page
 * that calls dwReportTab to loading this file.
 */
(function () {
  if (window.dwReportTab) return; // already loaded

  const CHANNEL  = 'dw-report-tab';
  const READY_MS = 3000;     // a tab that has not asked by now, with this page
                             // still in front, never opened
  const HOLD_MS  = 120000;   // how long a tab that has not asked for its report
                             // is waited on — before and after the report is
                             // built; a tab that has asked waits as long as
                             // the build takes
  const PRINT_MS = 350;      // let a report lay out before print: true prints it

  const later = (fn, ms) => setTimeout(fn, ms);
  const brandOf = (brand, html) => (brand && window.dwBrand ? window.dwBrand(String(html)) : String(html));

  function escText(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function placeholder(title, text, failed) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escText(title) + '</title></head>'
      + '<body style="font:13px/1.5 system-ui,sans-serif;color:#475569;padding:26px">'
      + '<p id="dw-wait"' + (failed ? ' style="color:#991b1b"' : '') + '>' + escText(text) + '</p>';
  }

  // Runs in the report tab, not here: it is stringified into the loader page,
  // so it has to stand alone — nothing from this file is in scope there.
  function loader(channel, id, printMs) {
    var ch = new BroadcastChannel(channel), done = false;
    var say = function (text, failed) {
      var el = document.getElementById('dw-wait');
      if (el) { el.textContent = text; if (failed) el.style.color = '#991b1b'; }
    };
    var finish = function () { done = true; try { ch.close(); } catch (e) { /* closed */ } };
    ch.onmessage = function (e) {
      var m = e.data || {};
      if (done || m.id !== id) return;
      if (m.type === 'progress') { say(m.text); return; }
      if (m.type === 'html') {
        finish();
        document.open();
        document.write(m.html);
        document.close();
        if (m.print) setTimeout(function () { try { window.print(); } catch (e) { /* they can still print */ } }, printMs);
      } else if (m.type === 'error') {
        finish();
        say(m.message, true);
      } else if (m.type === 'close') {
        finish();
        say('This report was cancelled. You can close this tab.');
        window.close();
      }
    };
    // Closed before its report came: the page can stop building it.
    window.addEventListener('pagehide', function () {
      if (!done) { try { ch.postMessage({ type: 'gone', id: id }); } catch (e) { /* closing */ } }
    });
    ch.postMessage({ type: 'ready', id: id });
  }

  /* No BroadcastChannel (Safari before 15.4, or a test's stand-in window):
     the old window, opened and written the way the print paths always did.
     Its print dialog holds the app up, but the report still prints. The
     placeholder waits a tick, so a report filled in the click itself goes in
     exactly as before — one write, then close. */
  function openerTab(o) {
    const win = window.open('', '_blank', o.features || undefined);
    let placed = false, settled = false, cancelled = false, waiting = o.waiting;
    if (!win && o.onBlocked) o.onBlocked();
    // Nothing in the report needs this page; this page keeps its own handle.
    if (win) { try { win.opener = null; } catch (e) { /* not ours to clear */ } }
    const place = () => {
      if (placed || settled || !win || win.closed) return;
      placed = true;
      try { win.document.write(placeholder(o.title, waiting)); } catch (e) { /* the real write still lands */ }
    };
    if (win) later(place, 0);
    const put = (html, raw) => {
      if (settled || cancelled || !win || win.closed) return false;
      settled = true;
      try {
        const d = win.document;
        if (placed && typeof d.open === 'function') d.open();
        if (!raw && o.brand && typeof window.dwWrite === 'function') window.dwWrite(win, html);
        else d.write(raw ? html : brandOf(o.brand, html));
        d.close();
        return true;
      } catch (e) { return false; /* closed meanwhile */ }
    };
    return {
      fill(html) {
        const ok = put(html);
        if (ok && o.print) later(() => { try { win.focus(); win.print(); } catch (e) { /* they can still print */ } }, PRINT_MS);
        return Promise.resolve(ok);
      },
      fail(message) { put(placeholder(o.title, String(message || 'The report could not be built.'), true), true); },
      progress(text) {
        waiting = String(text);
        if (!placed) { place(); return; }
        try { const el = win.document.getElementById('dw-wait'); if (el) el.textContent = waiting; } catch (e) { /* between documents */ }
      },
      close() { cancelled = true; try { if (win && !win.closed) win.close(); } catch (e) { /* already gone */ } },
      get closed() { return cancelled || !win || !!win.closed; },
    };
  }

  function dwReportTab(opts) {
    opts = opts || {};
    const o = {
      title:     opts.title || 'Report',
      waiting:   opts.waiting || 'Building the report…',
      onBlocked: typeof opts.onBlocked === 'function' ? opts.onBlocked : null,
      features:  opts.features ? String(opts.features) : '',
      print:     !!opts.print,
      brand:     opts.brand !== false,
    };
    const BC = window.BroadcastChannel, U = window.URL, B = window.Blob, doc = window.document;
    if (typeof BC !== 'function' || typeof B !== 'function' || !U || typeof U.createObjectURL !== 'function') {
      return openerTab(o);
    }

    const id  = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const ch  = new BC(CHANNEL);
    const url = U.createObjectURL(new B([
      placeholder(o.title, o.waiting)
      + '<script>(' + loader + ')(' + JSON.stringify(CHANNEL) + ',' + JSON.stringify(id) + ',' + PRINT_MS + ');<\/script>'
      + '</body></html>',
    ], { type: 'text/html;charset=utf-8' }));
    window.open(url, '_blank', o.features ? 'noopener,' + o.features : 'noopener');

    let ready = false, gone = false, blocked = false, over = false;
    let msg = null, note = null, readyTimer = 0, holdTimer = 0;
    let delivered = null;
    const landed = new Promise(r => { delivered = r; });
    const end = () => {
      if (over) return;
      over = true;
      delivered(false); // no-op once the report has landed
      clearTimeout(readyTimer); clearTimeout(holdTimer);
      try { ch.close(); } catch (e) { /* already closed */ }
      // The tab has read the loader by now; nothing else will ask for it.
      later(() => { try { U.revokeObjectURL(url); } catch (e) { /* gone */ } }, 1000);
    };
    const deliver = () => {
      if (!ready || over) return;
      if (msg) { ch.postMessage(msg); if (msg.type === 'html') delivered(true); end(); return; }
      if (note) { ch.postMessage(note); note = null; }
    };
    ch.onmessage = e => {
      const m = e.data || {};
      if (m.id !== id) return;
      // The tab is there, so its report can take as long as it takes: a
      // long build (Safety's Print all over a wide range) still lands, and
      // 'gone' covers the tab being closed while it waits.
      if (m.type === 'ready') { ready = true; clearTimeout(holdTimer); deliver(); }
      else if (m.type === 'gone') { gone = true; end(); }
    };
    // Only worth a word if they are still looking at this page: an opened tab
    // takes the screen (and a sized window the focus); a blocked one left them
    // here.
    readyTimer = later(() => {
      if (ready || over) return;
      const here = !doc || ((doc.visibilityState || 'visible') === 'visible'
        && (typeof doc.hasFocus !== 'function' || doc.hasFocus()));
      if (!here) return;
      blocked = true;
      if (o.onBlocked) o.onBlocked();
    }, READY_MS);
    const hold = () => { clearTimeout(holdTimer); holdTimer = later(end, HOLD_MS); };
    hold();

    const settle = m => {
      if (msg || over) return;
      msg = Object.assign({ id }, m);
      if (!ready) hold(); // built: wait a while longer on a tab still to ask
      deliver();
    };
    return {
      fill(html) { settle({ type: 'html', html: brandOf(o.brand, html), print: o.print }); return landed; },
      fail(message) { settle({ type: 'error', message: String(message || 'The report could not be built.') }); },
      progress(text) {
        if (msg || over) return;
        note = { type: 'progress', id, text: String(text) };
        deliver();
      },
      close() {
        if (over) return;
        // Replaces a report not yet handed over: nothing is printed.
        msg = { type: 'close', id };
        deliver();
      },
      // over && !ready: the tab never asked, and no longer can.
      get closed() { return gone || (blocked && !ready) || (over && !ready) || (!!msg && msg.type === 'close'); },
    };
  }

  window.dwReportTab = dwReportTab;
})();
