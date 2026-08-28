/* eslint-disable no-undef */
/* DataWatch — report branding
 * Puts the DataWatch wordmark on the top left of every printed / emailed report.
 *
 *   dwBrand(html)      -> html with the header injected after <body>
 *   dwWrite(win, html) -> the same, written into a popup print window
 *
 * The reports are standalone print documents built as strings by ~50 report
 * builders across the division pages, each with its own header markup. Rather
 * than edit every one of them, this injects a common band just inside <body>,
 * above whatever title the report draws for itself.
 *
 * The band is text only — no image. That keeps it weightless (the HTML is
 * POSTed to /api/email/send-report under a 1.5MB cap) and sidesteps the three
 * places this markup renders that can't fetch from our origin: the about:blank
 * print window, the headless-Chrome PDF renderer (which aborts every non-data:
 * request), and an email client.
 *
 * The print path calls dwWrite() where it used to call win.document.write();
 * report-email.js calls dwBrand() before sending, guarded as
 * `(window.dwBrand||String)(html)` since an email is worth sending unbranded.
 * scripts/test-report-branding.js asserts every page that calls dwWrite also
 * loads this file, so the print path can rely on it being here.
 */
(function () {
  if (window.dwBrand) return; // already loaded

  // --green-dim from the app palette; the brighter --green (#22c55e) is thin
  // on paper. Set in the header's own style so report CSS can't restyle it.
  const GREEN = '#16a34a';

  // Inline styles only: report stylesheets routinely reset `*` and style bare
  // element selectors, so anything class-based here would get overridden.
  // Letter-spaced uppercase matches the app's own header .brand treatment.
  function headerHtml() {
    return '<div data-dw-brand style="'
      + 'border-bottom:2px solid #111;padding-bottom:6px;margin-bottom:10px;'
      + 'font-family:system-ui,-apple-system,\'Segoe UI\',sans-serif;'
      + 'font-size:13px;font-weight:700;line-height:1;'
      + 'letter-spacing:0.3em;text-transform:uppercase;color:' + GREEN + ';'
      + '">DataWatch</div>';
  }

  // Put the band at the top of the HTML: just inside <body> for a full print
  // document, or in front of the markup for a fragment — the Scheduler and
  // Trucking dispatch emails send a bare fragment for the server to wrap.
  // Idempotent, so HTML that passes through twice doesn't get two headers.
  function dwBrand(html) {
    if (typeof html !== 'string' || !html) return html;
    if (html.indexOf('data-dw-brand') !== -1) return html;
    const m = /<body\b[^>]*>/i.exec(html);
    if (!m) return headerHtml() + html;
    const at = m.index + m[0].length;
    return html.slice(0, at) + headerHtml() + html.slice(at);
  }

  // Write a report document into a print window, branded. Report builders call
  // this instead of win.document.write(...), so the header lands on the print
  // path the same way it lands on the emailed one.
  function dwWrite(win, ...chunks) {
    if (!win || !win.document) return;
    win.document.write(...chunks.map(c => dwBrand(String(c))));
  }

  window.dwBrand           = dwBrand;
  window.dwWrite           = dwWrite;
  window.dwBrandHeaderHtml = headerHtml;
})();
