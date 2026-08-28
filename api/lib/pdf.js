'use strict';

// Headless-Chrome HTML → PDF rendering for report emails.
//
// Every report page already builds a complete print document — inline
// <style>, @page rules, page-break hints — and hands that same string to
// both window.print() and the email modal. Email clients throw most of it
// away (no <style> blocks, no @page), which is why a wide landscape table
// arrives clipped. So for the email we run that HTML back through Chrome's
// own print engine and attach the result: the recipient gets exactly what
// the sender would have gotten from Print → Save as PDF.
//
// On Vercel the browser comes from @sparticuz/chromium, a Lambda-friendly
// Chromium build. Locally, point CHROME_EXECUTABLE_PATH at any Chrome or
// Chromium binary. Neither module is required at load time — a box without
// them reports a clean error and the caller falls back to the old inline
// HTML email instead of failing the send.

// These have to sum to less than the function's maxDuration in vercel.json
// (60s), or Vercel kills the invocation before the renderer can time out and
// hand back the inline-HTML fallback. Cold launch is ~5s, so: 5 + 15 + 30 = 50s,
// leaving room for the Resend call.
const NAV_TIMEOUT_MS    = 15_000;  // waiting for the document to settle
const RENDER_TIMEOUT_MS = 30_000;  // Chrome's own print step
const MAX_PDF_BYTES     = 8_000_000;

// Letter with a hair under a half-inch of margin. Only used for reports that
// don't declare their own @page box — preferCSSPageSize lets the ones that do
// (most of them: `@page{margin:1cm;size:landscape}`) keep their own geometry.
const DEFAULT_MARGIN = { top: '0.45in', right: '0.35in', bottom: '0.45in', left: '0.35in' };

// A report that asks for landscape in CSS gets it from preferCSSPageSize.
// This is the fallback for ones that only imply it by being very wide.
function wantsLandscape(html) {
  return /@page[^{]*\{[^}]*\blandscape\b/i.test(html) || /\bsize\s*:\s*landscape\b/i.test(html);
}

// Chrome resolves <img src="cid:...">/URLs against the network, and the HTML
// here is caller-supplied. Rather than trust it, we let through only what can
// carry no request: the inline document and data: URIs. Anything else — an
// http(s) tracking pixel, a link-local metadata address — is aborted, so the
// renderer can't be used to make the server fetch things on someone's behalf.
function isSafeRequestUrl(url) {
  return url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:');
}

// Chrome (Skia) writes page objects as plain uncompressed dictionaries, so the
// count is greedily readable without a PDF parser. Used only to say "(4 pages)"
// in the email body — every caller treats null as "just don't mention it".
function pdfPageCount(buf) {
  try {
    const matches = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
    if (matches && matches.length > 0 && matches.length <= 2000) return matches.length;
  } catch { /* fall through */ }
  return null;
}

// Rewrite <img src="cid:foo"> to a data: URI using a matching attachment, so
// the same HTML that renders inline images in the email also renders them in
// the PDF (Chrome has no notion of cid:). Attachments are in the Resend shape
// produced by normalizeAttachments: { content (base64), contentType,
// inlineContentId }.
function inlineCidImages(html, attachments) {
  if (typeof html !== 'string' || !Array.isArray(attachments) || !attachments.length) return html;
  const byCid = new Map();
  for (const a of attachments) {
    if (a && a.inlineContentId && a.content) {
      byCid.set(a.inlineContentId, `data:${a.contentType || 'application/octet-stream'};base64,${a.content}`);
    }
  }
  if (!byCid.size) return html;
  return html.replace(/(\bsrc\s*=\s*)(["'])\s*cid:([^"']+?)\s*\2/gi, (m, pre, q, cid) => {
    const url = byCid.get(String(cid).trim());
    return url ? `${pre}${q}${url}${q}` : m;
  });
}

function launchBrowser() {
  const puppeteer = require('puppeteer-core');

  // Local dev / self-hosted: use whatever Chrome the box already has.
  const localPath = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || '';
  if (localPath) {
    return puppeteer.launch({
      executablePath: localPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    });
  }

  // Serverless: the bundled Chromium build.
  const chromium = require('@sparticuz/chromium');
  // Reports are text and tables — no WebGL, no canvas compositing. Skipping
  // the software GL stack cuts a noticeable chunk off cold start.
  chromium.setGraphicsMode = false;
  return chromium.executablePath().then(executablePath => puppeteer.launch({
    executablePath,
    args: chromium.args,
    headless: chromium.headless ?? true,
    defaultViewport: { width: 1280, height: 1696, deviceScaleFactor: 1 },
  }));
}

// Render a full HTML document to a PDF buffer.
//
//   renderHtmlToPdf(html) -> { ok: true, buffer, pageCount }
//                          | { ok: false, error }
//
// Never throws — the email path treats a failure as "send it inline instead",
// so a broken renderer degrades the email rather than dropping it.
async function renderHtmlToPdf(html, opts = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, error: 'No HTML to render' };
  }

  let browser = null;
  try {
    try {
      browser = await launchBrowser();
    } catch (err) {
      return { ok: false, error: `Could not start the PDF renderer: ${err.message}` };
    }

    const page = await browser.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    await page.setRequestInterception(true);
    page.on('request', req => {
      try {
        if (isSafeRequestUrl(req.url())) req.continue();
        else req.abort();
      } catch { /* request already handled */ }
    });

    // sanitizeReportHtml strips <meta>, so re-declare the encoding: the
    // reports are full of em dashes, middots and ✓/✗ glyphs.
    const doc = html.replace(/<head(\s[^>]*)?>/i, m => `${m}<meta charset="utf-8">`);

    // A blocked image leaves 'load' unreachable in some cases; render what we
    // have rather than failing the whole send over a decorative asset.
    try {
      await page.setContent(doc, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    } catch { /* proceed with whatever rendered */ }

    // page.pdf() waits for document.fonts.ready on its own (waitForFonts
    // defaults true), so there's no separate font settle to do here.
    const raw = await page.pdf({
      printBackground:    true,
      preferCSSPageSize:  true,
      format:             'Letter',
      landscape:          opts.landscape ?? wantsLandscape(html),
      margin:             DEFAULT_MARGIN,
      timeout:            RENDER_TIMEOUT_MS,
    });

    const buffer = Buffer.from(raw);
    if (!buffer.length) return { ok: false, error: 'The renderer produced an empty PDF' };
    if (buffer.length > MAX_PDF_BYTES) {
      return { ok: false, error: 'The rendered PDF is too large to attach' };
    }

    return { ok: true, buffer, pageCount: pdfPageCount(buffer) };
  } catch (err) {
    return { ok: false, error: err.message || 'PDF rendering failed' };
  } finally {
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  }
}

module.exports = {
  MAX_PDF_BYTES,
  inlineCidImages,
  pdfPageCount,
  renderHtmlToPdf,
  wantsLandscape,
};
