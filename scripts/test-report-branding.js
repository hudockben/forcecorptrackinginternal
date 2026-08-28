#!/usr/bin/env node
'use strict';
/**
 * Tests for the DataWatch wordmark stamped on printed / emailed reports.
 *
 * Run: node scripts/test-report-branding.js
 *
 * Four layers:
 *   1. Structural — every page that calls dwWrite() also loads
 *      report-branding.js, and no page still writes a report document
 *      straight to a popup (which would print unbranded).
 *   2. Text only — the band carries no image and nothing user-supplied, so it
 *      costs nothing in the report HTML (which /api/email/send-report caps at
 *      1.5MB) and can't smuggle markup into a report other people receive.
 *   3. dwBrand behaviour in jsdom — injection point, idempotency, and
 *      pass-through for anything that isn't a report document.
 *   4. The header survives the email path: sanitizeReportHtml must not strip
 *      it, and a real headless-Chrome render must still produce a text-only
 *      PDF. Skipped, not failed, with no browser on the box.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0, skipped = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
function skip(label, why) { skipped++; console.log(`  ~ ${label} (skipped: ${why})`); }

// ── 1. Structural ──────────────────────────────────────────────────────────
console.log('\nwiring — every page that brands reports loads the module');

const htmlFiles = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const missingTag = [];
const stillDirect = [];
for (const f of htmlFiles) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (/\bdwWrite\s*\(/.test(s) && !s.includes('report-branding.js')) missingTag.push(f);
  // A leftover `win.document.write(` would print an unbranded report.
  if (/[A-Za-z_$][\w$]*\.document\.write\s*\(/.test(s)) stillDirect.push(f);
}
assert('every page calling dwWrite loads report-branding.js',
  missingTag.length === 0, missingTag.join(', '));
assert('no page writes a report document directly any more',
  stillDirect.length === 0, stillDirect.join(', '));

const pagesWithReports = htmlFiles.filter(f =>
  /\bdwWrite\s*\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
assert('the transform actually reached the report pages',
  pagesWithReports.length >= 7, `${pagesWithReports.length} pages: ${pagesWithReports.join(', ')}`);

// ── 2. Text only ───────────────────────────────────────────────────────────
console.log('\nthe band is text, not an image');

const brandingSrc = fs.readFileSync(path.join(ROOT, 'report-branding.js'), 'utf8');
assert('no image is embedded', !brandingSrc.includes('data:image/'));
assert('no <img> tag is emitted', !/<img\b/i.test(brandingSrc));
// It rides along in every report body; the send endpoint caps HTML at 1.5MB.
assert('the whole module stays tiny', brandingSrc.length < 8_000,
  `${(brandingSrc.length / 1024).toFixed(1)}KB`);

// ── 3. dwBrand in jsdom ────────────────────────────────────────────────────
console.log('\ndwBrand — injecting the header');

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://datawatch.test/' });
const sandbox = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(brandingSrc, sandbox, { filename: 'report-branding.js' });

const { dwBrand, dwBrandHeaderHtml } = sandbox.window;
assert('dwBrand is exported', typeof dwBrand === 'function');
assert('dwWrite is exported', typeof sandbox.window.dwWrite === 'function');

const report = '<!DOCTYPE html><html><head><style>body{padding:20px}</style></head>'
  + '<body><h2>Bid Line Items vs Actuals</h2><table><tr><td>x</td></tr></table></body></html>';
const branded = dwBrand(report);

assert('the header is injected', branded.includes('data-dw-brand'));
assert('it lands immediately after <body>, above the report title',
  branded.indexOf('data-dw-brand') > branded.indexOf('<body>')
  && branded.indexOf('data-dw-brand') < branded.indexOf('<h2>'));
assert('it renders the word DataWatch', />DataWatch</.test(branded));
assert('the report body is otherwise untouched',
  branded.includes('<h2>Bid Line Items vs Actuals</h2>') && branded.includes('<table><tr><td>x</td></tr></table>'));
assert('styling is inline, so report stylesheets cannot override it',
  !/<div data-dw-brand[^>]*class=/.test(branded));

// Nothing user-supplied reaches the band, so a hostile profile can't inject
// markup into a report that goes out to other people.
dom.window.localStorage.setItem('fct_user', JSON.stringify({ companyName: '<img src=x onerror=alert(1)>' }));
assert('the header carries nothing from the signed-in user',
  dwBrandHeaderHtml() === dwBrandHeaderHtml() && !dwBrandHeaderHtml().includes('img src=x'));
dom.window.localStorage.removeItem('fct_user');
assert('a missing fct_user changes nothing', typeof dwBrandHeaderHtml() === 'string');

assert('branding twice does not stack two headers', dwBrand(branded) === branded);
assert('a fragment with no <body> passes through', dwBrand('<p>hi</p>') === '<p>hi</p>');
assert('a non-string passes through', dwBrand(null) === null && dwBrand(undefined) === undefined);
assert('an empty string passes through', dwBrand('') === '');

// ── 4. The header survives the email path ──────────────────────────────────
console.log('\nthe header survives sanitizing and the PDF renderer');

const { sanitizeReportHtml } = require(path.join(ROOT, 'api/lib/email.js'));
const sanitized = sanitizeReportHtml(branded);
assert('sanitizeReportHtml keeps the header', sanitized.includes('data-dw-brand'));
assert('sanitizeReportHtml keeps the wordmark', />DataWatch</.test(sanitized));

function findChrome() {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const c of ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
                   '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    skip('a branded report renders to a text-only PDF', 'no Chrome/Chromium on this box');
  } else {
    process.env.CHROME_EXECUTABLE_PATH = chrome;
    const { renderHtmlToPdf } = require(path.join(ROOT, 'api/lib/pdf.js'));
    const r = await renderHtmlToPdf(sanitized);
    assert('a branded report still renders', r.ok, r.error);
    if (r.ok) {
      assert('a branded report renders to a text-only PDF',
        !r.buffer.toString('latin1').includes('/Subtype /Image'),
        'the band should not put a raster image in the output');
    }

    // The band must actually paint, not just be present in the markup.
    const puppeteer = (await import('puppeteer-core')).default;
    const browser = await puppeteer.launch({
      executablePath: chrome, headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(branded, { waitUntil: 'load' });
      const band = await page.evaluate(() => {
        const el = document.querySelector('[data-dw-brand]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const title = document.querySelector('h2').getBoundingClientRect();
        // The report sets its own body padding, so "top left" means flush with
        // where the report's own content starts, not flush with the page edge.
        const body = document.body.getBoundingClientRect();
        const bs = getComputedStyle(document.body);
        return {
          text: el.textContent.trim(),
          color: getComputedStyle(el).color,
          first: document.body.firstElementChild === el,
          flushLeft: Math.round(r.left) === Math.round(body.left + parseFloat(bs.paddingLeft)),
          aboveTitle: r.bottom <= title.top,
        };
      });
      assert('the band paints the wordmark', band && band.text === 'DataWatch', JSON.stringify(band));
      assert('it is brand green', band && band.color === 'rgb(22, 163, 74)', band && band.color);
      assert('it is the first thing in the report', band && band.first, JSON.stringify(band));
      assert('it is flush with the report\'s left margin', band && band.flushLeft, JSON.stringify(band));
      assert('it sits above the report title', band && band.aboveTitle, JSON.stringify(band));
    } finally { await browser.close(); }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
