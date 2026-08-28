#!/usr/bin/env node
'use strict';
/**
 * Tests for the DataWatch header stamped on printed / emailed reports.
 *
 * Run: node scripts/test-report-branding.js
 *
 * Four layers:
 *   1. Structural — every page that calls dwWrite() also loads
 *      report-branding.js, and no page still writes a report document
 *      straight to a popup (which would print unbranded).
 *   2. The embedded mark — a real PNG data URI, and small enough to ride
 *      along in every report without eating the send-report HTML budget.
 *   3. dwBrand behaviour in jsdom — injection point, idempotency, the
 *      company line, escaping, and pass-through for non-documents.
 *   4. The header survives the email path: sanitizeReportHtml must not strip
 *      the data: URI, and a real headless-Chrome render must draw it (that
 *      renderer blocks every non-data: request, so a file reference would
 *      silently vanish). Skipped, not failed, with no browser on the box.
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

// ── 2. The embedded mark ───────────────────────────────────────────────────
console.log('\nthe embedded DataWatch mark');

const brandingSrc = fs.readFileSync(path.join(ROOT, 'report-branding.js'), 'utf8');
const logoMatch = brandingSrc.match(/const LOGO = '(data:image\/png;base64,[A-Za-z0-9+/=]+)'/);
assert('the module embeds a PNG data URI', Boolean(logoMatch));
if (logoMatch) {
  const bytes = Buffer.from(logoMatch[1].split(',')[1], 'base64');
  assert('it decodes to a real PNG',
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  // It rides along in every report body, which the send endpoint caps at 1.5MB.
  assert('it stays small enough to embed in every report',
    bytes.length < 40_000, `${(bytes.length / 1024).toFixed(1)}KB`);
  // ~3x the 30px it draws at, so print stays sharp.
  assert('it is rendered at print resolution, not screen',
    bytes.readUInt32BE(20) >= 72, `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`);
}

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

dom.window.localStorage.setItem('fct_user', JSON.stringify({ companyName: 'Force Corp' }));

const report = '<!DOCTYPE html><html><head><style>body{padding:20px}</style></head>'
  + '<body><h2>Bid Line Items vs Actuals</h2><table><tr><td>x</td></tr></table></body></html>';
const branded = dwBrand(report);

assert('the header is injected', branded.includes('data-dw-brand'));
assert('it lands immediately after <body>, above the report title',
  branded.indexOf('data-dw-brand') > branded.indexOf('<body>')
  && branded.indexOf('data-dw-brand') < branded.indexOf('<h2>'));
assert('the wordmark is present', branded.includes('DataWatch'));
assert('the company line comes from the signed-in user', branded.includes('Force Corp'));
assert('the mark is embedded, not linked', branded.includes('src="data:image/png;base64,'));
assert('the report body is otherwise untouched',
  branded.includes('<h2>Bid Line Items vs Actuals</h2>') && branded.includes('<table><tr><td>x</td></tr></table>'));
assert('styling is inline, so report stylesheets cannot override it',
  !/<div data-dw-brand[^>]*class=/.test(branded));

assert('branding twice does not stack two headers', dwBrand(branded) === branded);
assert('a fragment with no <body> passes through', dwBrand('<p>hi</p>') === '<p>hi</p>');
assert('a non-string passes through', dwBrand(null) === null && dwBrand(undefined) === undefined);
assert('an empty string passes through', dwBrand('') === '');

// A company name is user-controlled data reaching a report others receive.
dom.window.localStorage.setItem('fct_user', JSON.stringify({ companyName: '<img src=x onerror=alert(1)>' }));
const xss = dwBrandHeaderHtml();
assert('the company name is HTML-escaped', !xss.includes('<img src=x') && xss.includes('&lt;img'));

// No company on file: show the mark alone rather than inventing a name.
dom.window.localStorage.setItem('fct_user', '{}');
const noCo = dwBrandHeaderHtml();
assert('a missing company leaves the sub-line off',
  noCo.includes('DataWatch') && !/margin-top:3px/.test(noCo));
dom.window.localStorage.removeItem('fct_user');
assert('a missing fct_user does not throw', typeof dwBrandHeaderHtml() === 'string');

// ── 4. The header survives the email path ──────────────────────────────────
console.log('\nthe header survives sanitizing and the PDF renderer');

const { sanitizeReportHtml } = require(path.join(ROOT, 'api/lib/email.js'));
dom.window.localStorage.setItem('fct_user', JSON.stringify({ companyName: 'Force Corp' }));
const brandedAgain = dwBrand(report);
const sanitized = sanitizeReportHtml(brandedAgain);
assert('sanitizeReportHtml keeps the header', sanitized.includes('data-dw-brand'));
assert('sanitizeReportHtml keeps the embedded mark', sanitized.includes('data:image/png;base64,'));

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
    skip('the mark is drawn into the rendered PDF', 'no Chrome/Chromium on this box');
  } else {
    process.env.CHROME_EXECUTABLE_PATH = chrome;
    const { renderHtmlToPdf } = require(path.join(ROOT, 'api/lib/pdf.js'));
    const r = await renderHtmlToPdf(sanitized);
    assert('a branded report still renders', r.ok, r.error);
    if (r.ok) {
      // The renderer aborts every non-data: request, so an image that survives
      // to the PDF proves the mark is genuinely embedded rather than linked.
      assert('the mark is drawn into the rendered PDF',
        r.buffer.toString('latin1').includes('/Subtype /Image'),
        'no image XObject in the output');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
