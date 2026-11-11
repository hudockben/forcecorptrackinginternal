/* eslint-disable no-undef */
/* DataWatch — a printed report in a tab of its own
 *
 *   const tab = dwReportTab({ title, waiting, onBlocked });
 *   tab.fill(html)      // the report: branded, written in, prints itself
 *   tab.fail(message)   // the build failed: the tab says so
 *
 * Call it inside the click that asked for the report — that is the only time
 * a browser allows a pop-up — then fill the tab whenever the report is built.
 *
 * Why not window.open('') and write into it, as the other print paths do: a
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
 * when it lands. That same null is returned for a blocked pop-up, so a
 * blocked one shows up as a tab that never asks for its report.
 *
 * Load after report-branding.js: the report is branded the way dwWrite brands
 * it. scripts/test-report-tab.js holds every page that calls dwReportTab to
 * loading this file.
 */
(function () {
  if (window.dwReportTab) return; // already loaded

  const CHANNEL  = 'dw-report-tab';
  const READY_MS = 8000;     // a tab that has not asked by now never opened
  const HOLD_MS  = 120000;   // how long a built report waits on a late tab

  const brand = html => (window.dwBrand || String)(String(html));

  function escText(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function placeholder(title, text) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + escText(title) + '</title></head>'
      + '<body style="font:13px/1.5 system-ui,sans-serif;color:#475569;padding:26px">'
      + '<p id="dw-wait">' + escText(text) + '</p>';
  }

  // Runs in the report tab, not here: it is stringified into the loader page,
  // so it has to stand alone — nothing from this file is in scope there.
  function loader(channel, id) {
    var ch = new BroadcastChannel(channel), done = false;
    ch.onmessage = function (e) {
      var m = e.data || {};
      if (done || m.id !== id || (m.type !== 'html' && m.type !== 'error')) return;
      done = true;
      ch.close();
      if (m.type === 'html') {
        // The report's own onload calls print(), as it did in the old window.
        document.open();
        document.write(m.html);
        document.close();
      } else {
        var el = document.getElementById('dw-wait');
        if (el) { el.textContent = m.message; el.style.color = '#991b1b'; }
      }
    };
    ch.postMessage({ type: 'ready', id: id });
  }

  // A browser with no BroadcastChannel (Safari before 15.4) gets the old
  // window. Its print dialog holds the app up, but the report still prints.
  function openerTab(title, waiting, onBlocked) {
    const win = window.open('', '_blank');
    if (!win) { if (onBlocked) onBlocked(); }
    else { try { win.document.write(placeholder(title, waiting)); } catch (e) { /* the real write still lands */ } }
    const put = html => {
      if (!win || win.closed) return;
      try { win.document.open(); win.document.write(html); win.document.close(); } catch (e) { /* closed meanwhile */ }
    };
    return {
      fill: html => put(brand(html)),
      fail: message => put(placeholder(title, message)),
    };
  }

  function dwReportTab(opts) {
    opts = opts || {};
    const title     = opts.title || 'Report';
    const waiting   = opts.waiting || 'Building the report…';
    const onBlocked = typeof opts.onBlocked === 'function' ? opts.onBlocked : null;
    if (typeof BroadcastChannel !== 'function' || typeof URL.createObjectURL !== 'function') {
      return openerTab(title, waiting, onBlocked);
    }

    const id  = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const ch  = new BroadcastChannel(CHANNEL);
    const url = URL.createObjectURL(new Blob([
      placeholder(title, waiting)
      + '<script>(' + loader + ')(' + JSON.stringify(CHANNEL) + ',' + JSON.stringify(id) + ');<\/script>'
      + '</body></html>',
    ], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');

    let ready = false, msg = null, over = false, readyTimer = 0, holdTimer = 0;
    const end = () => {
      if (over) return;
      over = true;
      clearTimeout(readyTimer); clearTimeout(holdTimer);
      try { ch.close(); } catch (e) { /* already closed */ }
      // The tab has read the loader by now; nothing else will ask for it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const deliver = () => {
      if (!ready || !msg || over) return;
      ch.postMessage(msg);
      end();
    };
    ch.onmessage = e => {
      const m = e.data || {};
      if (m.type === 'ready' && m.id === id) { ready = true; deliver(); }
    };
    // Only worth a word if they are still looking at this page: an opened
    // report tab has the screen, and a blocked one left them here.
    readyTimer = setTimeout(() => {
      if (!ready && onBlocked && document.visibilityState === 'visible') onBlocked();
    }, READY_MS);
    holdTimer = setTimeout(end, HOLD_MS);

    return {
      fill(html) {
        if (msg) return;
        msg = { type: 'html', id, html: brand(html) };
        deliver();
      },
      fail(message) {
        if (msg) return;
        msg = { type: 'error', id, message: String(message || 'The report could not be built.') };
        deliver();
      },
    };
  }

  window.dwReportTab = dwReportTab;
})();
