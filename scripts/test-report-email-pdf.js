#!/usr/bin/env node
'use strict';
/**
 * Tests for the PDF-attachment path on report emails.
 *
 * Run: node scripts/test-report-email-pdf.js
 *
 * Three layers:
 *   1. extractSummary — evaluates the key-figure extractor out of
 *      report-email.js inside jsdom and runs it against the actual metric-strip
 *      markup each report family emits (.sqft-bar, .strip, .sum-metric), plus
 *      the tie-break between two strips and the no-strip case.
 *   2. buildEmailHtml / send-report helpers — the summary table, the
 *      attachment banner, cid: → data: inlining, page counting, and landscape
 *      detection.
 *   3. renderHtmlToPdf — a real headless-Chrome render, when a browser is
 *      available (CHROME_EXECUTABLE_PATH, or one of the usual paths). Asserts
 *      the bytes are a PDF, that page count parses, and that a blocked
 *      external request doesn't hang or fail the render. Skipped, not failed,
 *      when there's no browser on the box.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');

// api/lib/email.js reads its config at module load, so seed it before the
// first require. Layer 4 stubs the Resend SDK itself — nothing leaves the box.
process.env.RESEND_API_KEY     = process.env.RESEND_API_KEY     || 'test-key';
process.env.EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'reports@datawatch.test';

let passed = 0, failed = 0, skipped = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}
function skip(label, why) { skipped++; console.log(`  ~ ${label} (skipped: ${why})`); }

// ── 1. extractSummary ──────────────────────────────────────────────────────
console.log('\nextractSummary — lifting key figures out of report HTML');

const { JSDOM } = require('jsdom');
// A real url keeps jsdom's localStorage out of opaque-origin mode.
const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://datawatch.test/' });

// Load report-email.js inside jsdom and reach into its closure. The file is an
// IIFE, so append an export line rather than restructuring the module.
const src = fs.readFileSync(path.join(ROOT, 'report-email.js'), 'utf8')
  .replace('window.openReportEmailModal = openReportEmailModal;',
           'window.openReportEmailModal = openReportEmailModal;\n  window.__extractSummary = extractSummary;');

const sandbox = {
  window: dom.window, document: dom.window.document,
  DOMParser: dom.window.DOMParser, localStorage: dom.window.localStorage,
  console, setTimeout, fetch: () => Promise.reject(new Error('no network in test')),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'report-email.js' });
const extractSummary = sandbox.window.__extractSummary;
assert('extractSummary is reachable', typeof extractSummary === 'function');

// The bid report's cost roll-up, verbatim in shape from tracker.html.
const finBar = `<div class="sqft-bar">
  <div class="sqft-metric"><div class="sqft-label">Bid Budget</div><div class="sqft-val">$2,242,817.88</div></div>
  <div class="sqft-metric"><div class="sqft-label">Actual Cost</div><div class="sqft-val sqft-actual">$1,033,364.78</div></div>
  <div class="sqft-metric"><div class="sqft-label">Projected Cost</div><div class="sqft-val">$2,353,475.26</div></div>
  <div class="sqft-sep"></div>
  <div class="sqft-metric"><div class="sqft-label">Project Complete</div><div class="sqft-val">52.0%<span style="font-size:0.72em"> · 5/15 cost codes</span></div></div>
</div>`;

let out = extractSummary(`<!DOCTYPE html><html><body>${finBar}<table><tr><td class="num">$1.00</td></tr></table></body></html>`);
assert('bid roll-up yields 4 metrics', out.length === 4, JSON.stringify(out));
assert('first metric is Bid Budget', out[0] && out[0].label === 'Bid Budget' && out[0].value === '$2,242,817.88', JSON.stringify(out[0]));
assert('nested span folds into the value',
  out[3] && out[3].value === '52.0% · 5/15 cost codes', JSON.stringify(out[3]));
assert('bare <td class="num"> is not mistaken for a metric',
  !out.some(m => m.value === '$1.00'), JSON.stringify(out));

// Two strips: the $/SF bar precedes the cost roll-up. The roll-up should win.
const sqftBar = `<div class="sqft-bar">
  <div class="sqft-metric"><div class="sqft-label">Total SF</div><div class="sqft-val">17,414 sf</div></div>
  <div class="sqft-metric"><div class="sqft-label">Bid Cost / SF</div><div class="sqft-val">$0.30</div></div>
  <div class="sqft-metric"><div class="sqft-label">Running Cost / SF</div><div class="sqft-val">$0.24</div></div>
</div>`;
out = extractSummary(`<!DOCTYPE html><html><body>${sqftBar}${finBar}</body></html>`);
assert('paired opening bars are carried together, in report order',
  out.length === 7 && out[0].label === 'Total SF' && out[3].label === 'Bid Budget',
  JSON.stringify(out.map(m => m.label)));

// The daily-summary strip uses a different class family.
out = extractSummary(`<!DOCTYPE html><html><body><div class="strip">
  <div><div class="si-label">Total Cost (Period)</div><div class="si-val">$48,120.00</div></div>
  <div><div class="si-label">Total Labor Hours</div><div class="si-val">312.5</div></div>
  <div><div class="si-label">Projects</div><div class="si-val">7</div></div>
</div></body></html>`);
assert('daily-summary .si-label/.si-val strip is recognized',
  out.length === 3 && out[0].label === 'Total Cost (Period)' && out[2].value === '7', JSON.stringify(out));

// The job-summary strip is a third family again.
out = extractSummary(`<!DOCTYPE html><html><body><div class="sum-bar">
  <div class="sum-metric"><div class="sum-label">Bid Budget</div><div class="sum-val">$91,000.00</div></div>
  <div class="sum-metric"><div class="sum-label">Actual</div><div class="sum-val">$88,400.00</div></div>
</div></body></html>`);
assert('job-summary .sum-label/.sum-val strip is recognized',
  out.length === 2 && out[1].value === '$88,400.00', JSON.stringify(out));

// The job summary opens with two .sum-bar strips — contract / bid budget /
// actual profit over days-and-costs — and further down carries a schedule KPI
// strip built from the same .sum-metric parts. The email should take both
// opening bars whole and leave the schedule strip behind.
const jsFinBar = `<div class="sum-bar">
  <div class="sum-metric"><div class="sum-label">Contract Value</div><div class="sum-val">$19,612.00</div></div>
  <div class="sum-metric"><div class="sum-label">Bid Budget</div><div class="sum-val">$12,872.36</div></div>
  <div class="sum-sep"></div>
  <div class="sum-metric"><div class="sum-label">Actual Profit</div><div class="sum-val sqft-under">$6,272.64 (32.0%)</div></div>
</div>`;
const jsWorkBar = `<div class="sum-bar">
  <div class="sum-metric"><div class="sum-label">Days Worked</div><div class="sum-val">3</div></div>
  <div class="sum-metric"><div class="sum-label">Labor Hours</div><div class="sum-val">89.5</div></div>
  <div class="sum-metric"><div class="sum-label">Labor Cost</div><div class="sum-val">$4,207.50</div></div>
  <div class="sum-metric"><div class="sum-label">Equipment Cost</div><div class="sum-val">$1,525.50</div></div>
  <div class="sum-metric"><div class="sum-label">Trucking Cost</div><div class="sum-val">$2,138.07</div></div>
  <div class="sum-metric"><div class="sum-label">Total Purchases</div><div class="sum-val">$5,468.29</div></div>
  <div class="sum-sep"></div>
  <div class="sum-metric"><div class="sum-label">Actual Cost</div><div class="sum-val sqft-actual">$13,339.36</div></div>
</div>`;
const jsSchedBar = `<div class="sum-bar sched-bar">
  <div class="sum-metric"><div class="sum-label">Schedule Start</div><div class="sum-val">Jun 3</div></div>
  <div class="sum-metric"><div class="sum-label">Scheduled Codes</div><div class="sum-val">6</div></div>
  <div class="sum-metric"><div class="sum-label">Overall % Complete</div><div class="sum-val">82%</div></div>
</div>`;

out = extractSummary(`<!DOCTYPE html><html><body>${jsFinBar}${jsWorkBar}${jsSchedBar}</body></html>`);
const jsLabels = out.map(m => m.label);
assert('the job summary carries both opening bars — 10 figures',
  out.length === 10, JSON.stringify(jsLabels));
assert('the contract bar leads, the way the PDF opens',
  jsLabels.slice(0, 3).join('|') === 'Contract Value|Bid Budget|Actual Profit', JSON.stringify(jsLabels));
assert('Actual Cost is no longer truncated off the end',
  jsLabels[9] === 'Actual Cost' && out[9].value === '$13,339.36', JSON.stringify(out[9]));
assert('the schedule KPI strip stays out of the email',
  !jsLabels.includes('Scheduled Codes'), JSON.stringify(jsLabels));
assert('a figure the report colors carries its tone',
  out[2].tone === 'good' && out[9].tone === 'actual', JSON.stringify([out[2], out[9]]));
assert('an uncolored figure carries no tone', out[3].tone === undefined, JSON.stringify(out[3]));

// The cap: a job with change orders runs five contract figures over seven cost
// ones, and nothing past that reaches the email.
const wideBar = n => `<div class="sqft-bar">${Array.from({ length: n }, (_, i) =>
  `<div class="sqft-metric"><div class="sqft-label">L${i}</div><div class="sqft-val">$${i}</div></div>`).join('')}</div>`;
out = extractSummary(`<!DOCTYPE html><html><body>${wideBar(8)}${wideBar(8)}</body></html>`);
assert('the figure list is capped at 12', out.length === 12, String(out.length));

// Placeholders are not figures.
out = extractSummary(`<!DOCTYPE html><html><body><div class="sqft-bar">
  <div class="sqft-metric"><div class="sqft-label">Bid Budget</div><div class="sqft-val">—</div></div>
  <div class="sqft-metric"><div class="sqft-label">Actual Cost</div><div class="sqft-val">—</div></div>
</div></body></html>`);
assert('an all-em-dash strip yields nothing', out.length === 0, JSON.stringify(out));

// A report with no strip at all must not throw or invent metrics.
out = extractSummary('<!DOCTYPE html><html><body><table><tr><th>Sub Code</th></tr></table></body></html>');
assert('a report with no metric strip yields []', Array.isArray(out) && out.length === 0, JSON.stringify(out));
assert('junk input yields [] rather than throwing', extractSummary('').length === 0);

// ── 2. Email shell + PDF helpers ───────────────────────────────────────────
console.log('\nbuildEmailHtml + pdf helpers');

const { buildEmailHtml, normalizeSummary, sanitizeReportHtml } = require(path.join(ROOT, 'api/lib/email.js'));
const { inlineCidImages, pdfPageCount, wantsLandscape } = require(path.join(ROOT, 'api/lib/pdf.js'));

const shell = buildEmailHtml({
  title: 'Bid Line Items vs Actuals — Franklin Regional Multi',
  note: 'Numbers through Thursday.',
  bodyHtml: '',
  summary: [
    { label: 'Bid Budget', value: '$2,242,817.88' },
    { label: 'Actual Cost', value: '$1,033,364.78' },
    { label: 'Projected Cost', value: '$2,353,475.26' },
  ],
  attachmentNote: 'Full report attached as PDF (4 pages).',
});
assert('summary labels render in the body', shell.includes('Bid Budget') && shell.includes('$2,242,817.88'));
assert('the note renders', shell.includes('Numbers through Thursday.'));
assert('the attachment banner renders', shell.includes('Full report attached as PDF (4 pages).'));
assert('an odd metric count is padded to a full row',
  (shell.match(/<td width="50%"><\/td>/g) || []).length === 1);
assert('no inline report table when a PDF carries it', !shell.includes('<table class'));

const toned = buildEmailHtml({
  title: 'Job Summary — Eric Pash (26082)', bodyHtml: '',
  summary: [
    { label: 'Actual Profit', value: '$6,272.64 (32.0%)', tone: 'good' },
    { label: 'Actual Cost',   value: '$13,339.36',        tone: 'actual' },
    { label: 'Days Worked',   value: '3' },
    { label: 'Variance',      value: '-$1.00',            tone: 'chartreuse' },
  ],
});
assert('a good tone renders in the report green', toned.includes('color:#166534'));
assert('an actual tone renders in the report amber', toned.includes('color:#92400e'));
assert('an untoned figure stays plain', toned.includes('color:#111'));
assert('an unrecognized tone never reaches the markup', !toned.includes('chartreuse'));

const xss = buildEmailHtml({
  title: 'X', bodyHtml: '',
  summary: [{ label: '<img src=x onerror=alert(1)>', value: '"><script>alert(1)</script>' }],
  attachmentNote: '<script>alert(2)</script>',
});
assert('summary labels are HTML-escaped', !xss.includes('<img src=x') && xss.includes('&lt;img'));
assert('the attachment note is HTML-escaped', !xss.includes('<script>alert(2)'));

assert('normalizeSummary drops empty pairs',
  normalizeSummary([{ label: 'A', value: '1' }, { label: '', value: '2' }, { label: 'C', value: '' }]).length === 1);
assert('normalizeSummary caps the list', normalizeSummary(
  Array.from({ length: 20 }, (_, i) => ({ label: 'L' + i, value: 'V' + i }))).length === 12);
assert('normalizeSummary keeps palette tones and drops the rest',
  normalizeSummary([{ label: 'A', value: '1', tone: 'good' },
                    { label: 'B', value: '2', tone: 'chartreuse' }])
    .map(m => m.tone || '-').join('') === 'good-');
assert('normalizeSummary tolerates non-arrays', normalizeSummary(null).length === 0 && normalizeSummary('x').length === 0);

const cidHtml = '<img src="cid:cs-gantt" alt="g"><img src="cid:missing">';
const inlined = inlineCidImages(cidHtml, [
  { inlineContentId: 'cs-gantt', contentType: 'image/png', content: 'AAAA' },
]);
assert('a known cid: becomes a data: URI', inlined.includes('src="data:image/png;base64,AAAA"'));
assert('an unknown cid: is left alone', inlined.includes('src="cid:missing"'));

assert('landscape is detected from @page', wantsLandscape('@page{margin:1cm;size:landscape}'));
assert('portrait reports are not forced landscape', !wantsLandscape('@page{margin:1cm}'));

assert('pdfPageCount returns null on non-PDF bytes', pdfPageCount(Buffer.from('not a pdf')) === null);

// The renderer is handed sanitized HTML; make sure that really does defang the
// reports' own auto-print bootstrap before Chrome ever sees it.
assert('sanitizeReportHtml removes the window.print() bootstrap',
  !sanitizeReportHtml('<body>x<script>window.onload=()=>{window.print();}</script></body>').includes('window.print'));

// ── 3. Real headless-Chrome render ─────────────────────────────────────────
console.log('\nrenderHtmlToPdf — real headless Chrome');

function findChrome() {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    // Playwright's directories hold the real binary a couple of levels down.
    if (fs.statSync(c).isDirectory()) {
      for (const nested of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = path.join(c, nested);
        if (fs.existsSync(p)) return p;
      }
      continue;
    }
    return c;
  }
  return null;
}

(async () => {
  const chrome = findChrome();  // also gates layer 4's render assertions
  if (!chrome) {
    skip('renders a report to a real PDF', 'no Chrome/Chromium on this box');
    skip('blocks external requests during render', 'no Chrome/Chromium on this box');
  } else {
    process.env.CHROME_EXECUTABLE_PATH = chrome;
    // Require after setting the env var — the module reads it at launch time.
    const { renderHtmlToPdf } = require(path.join(ROOT, 'api/lib/pdf.js'));

    const rows = Array.from({ length: 120 }, (_, i) =>
      `<tr><td>Sub Code ${i}</td><td>EA</td><td>1,121</td><td>$4.89</td><td>$5,481.69</td><td>$15,573.69</td></tr>`).join('');
    const report = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title><style>
      body{font-family:system-ui,sans-serif;font-size:10px;padding:20px}
      table{border-collapse:collapse;width:100%}
      th,td{border:1px solid #ddd;padding:2px 5px;font-size:8.5px;white-space:nowrap}
      @media print{@page{margin:1cm;size:landscape}}
    </style></head><body>
      <h2>Bid Line Items vs Actuals — Franklin Regional Multi</h2>
      <table><tr><th>Sub Code</th><th>Unit</th><th>Bid Qty</th><th>Unit Cost</th><th>Cost Total</th><th>Actual Cost</th></tr>${rows}</table>
    </body></html>`;

    const r = await renderHtmlToPdf(report);
    assert('render succeeds', r.ok, r.error);
    if (r.ok) {
      assert('output is a real PDF', r.buffer.subarray(0, 5).toString() === '%PDF-');
      assert('output is non-trivial but not bloated',
        r.buffer.length > 2000 && r.buffer.length < 8_000_000, `${r.buffer.length} bytes`);
      assert('page count parses to something sane',
        r.pageCount !== null && r.pageCount >= 2, String(r.pageCount));
      assert('text is embedded, not rasterized', !r.buffer.toString('latin1').includes('/Subtype /Image'));
    }

    // An external <img> must be aborted rather than fetched, and must not
    // stall or fail the render.
    const withRemote = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
      <p>hello</p><img src="http://169.254.169.254/latest/meta-data/" alt="blocked">
    </body></html>`;
    const t0 = Date.now();
    const r2 = await renderHtmlToPdf(withRemote);
    const elapsed = Date.now() - t0;
    assert('a report referencing an external URL still renders', r2.ok, r2.error);
    assert('the blocked request does not stall the render', elapsed < 20_000, `${elapsed}ms`);
  }

  // ── 4. send-report, end to end ───────────────────────────────────────────
  console.log('\nsend-report — what actually reaches Resend');

  // Stub auth and the Resend SDK by seeding require.cache before the handler
  // pulls them in.
  const authPath = require.resolve(path.join(ROOT, 'api/lib/auth.js'));
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, exports: {
      requireAuth: () => ({ username: 'tester', companyCode: 'FC', companyName: 'Force Corp' }),
      hasDivisionAccess: () => true,
    },
  };

  let sentPayload = null;
  const resendPath = require.resolve('resend');
  require.cache[resendPath] = {
    id: resendPath, filename: resendPath, loaded: true, exports: {
      Resend: class {
        constructor() {
          this.emails = { send: async opts => { sentPayload = opts; return { data: { id: 'stub-id' }, error: null }; } };
        }
      },
    },
  };

  const handler = require(path.join(ROOT, 'api/email/send-report.js'));

  function fakeRes() {
    const r = { statusCode: 200, body: null, headers: {} };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = c => { r.statusCode = c; return r; };
    r.json = b => { r.body = b; return r; };
    r.end = () => r;
    return r;
  }

  const reportHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @media print{@page{margin:1cm;size:landscape}}
    .sqft-label{font-size:7px}.sqft-val{font-size:12px}
  </style></head><body>
    <h2>Bid Line Items vs Actuals — Franklin Regional Multi</h2>
    <div class="sqft-bar">
      <div class="sqft-metric"><div class="sqft-label">Bid Budget</div><div class="sqft-val">$2,242,817.88</div></div>
      <div class="sqft-metric"><div class="sqft-label">Actual Cost</div><div class="sqft-val">$1,033,364.78</div></div>
    </div>
    <table><tr><th>Sub Code</th><th>Cost Total</th></tr><tr><td>Silt Sock 12inch</td><td>$5,481.69</td></tr></table>
    <script>window.onload=()=>{window.print();}<\/script>
  </body></html>`;

  const baseBody = {
    report_type:  'turf_bid_items',
    project_name: 'Franklin Regional Multi',
    recipients:   ['a@example.com', 'A@example.com', 'b@example.com'],
    subject:      'Bid Line Items vs Actuals — Franklin Regional Multi (26049)',
    note:         'Numbers through Thursday.',
    html:         reportHtml,
    summary:      [{ label: 'Bid Budget', value: '$2,242,817.88' }],
  };

  if (!chrome) {
    skip('sends the report as a PDF attachment', 'no Chrome/Chromium on this box');
    skip('drops inline cid: attachments once the PDF carries them', 'no Chrome/Chromium on this box');
  } else {
    // — PDF path —
    sentPayload = null;
    let res = fakeRes();
    await handler({ method: 'POST', body: { ...baseBody, attach_pdf: true } }, res);

    assert('the send is accepted', res.statusCode === 200 && res.body && res.body.ok === true,
      JSON.stringify(res.body));
    assert('the response reports a PDF was attached', res.body && res.body.pdfAttached === true);
    assert('no warning on the happy path', res.body && !res.body.warning, JSON.stringify(res.body && res.body.warning));
    assert('duplicate recipients are folded case-insensitively', res.body && res.body.recipientCount === 2,
      String(res.body && res.body.recipientCount));

    assert('exactly one attachment reaches Resend',
      sentPayload && sentPayload.attachments && sentPayload.attachments.length === 1,
      JSON.stringify(sentPayload && (sentPayload.attachments || []).map(a => a.filename)));
    const pdf = sentPayload.attachments[0];
    assert('it is a PDF', pdf.contentType === 'application/pdf');
    assert('the filename is derived from the subject and dated',
      /^bid-line-items-vs-actuals-franklin-regional-multi-26049-\d{4}-\d{2}-\d{2}\.pdf$/.test(pdf.filename),
      pdf.filename);
    assert('the attachment content is base64 PDF bytes',
      Buffer.from(pdf.content, 'base64').subarray(0, 5).toString() === '%PDF-');

    assert('the body carries the note', sentPayload.html.includes('Numbers through Thursday.'));
    assert('the body carries the key figures', sentPayload.html.includes('$2,242,817.88'));
    assert('the body announces the attachment', /attached as PDF/.test(sentPayload.html));
    assert('the body does NOT inline the report table',
      !sentPayload.html.includes('Silt Sock 12inch'));
    assert('the report\'s own <style> block never reaches the email body',
      !sentPayload.html.includes('@page'));

    // — inline cid: attachments are folded into the PDF —
    sentPayload = null;
    res = fakeRes();
    await handler({ method: 'POST', body: {
      ...baseBody, attach_pdf: true,
      html: reportHtml.replace('<h2>', '<img src="cid:cs-gantt"><h2>'),
      attachments: [
        { filename: 'gantt.png', contentId: 'cs-gantt', content: Buffer.from(
          '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200010005fe02fea7000000004945' +
          '4e44ae426082', 'hex').toString('base64') },
        { filename: 'notes.pdf', content: Buffer.from('%PDF-1.4 stub').toString('base64') },
      ],
    } }, res);

    assert('the send with inline images is accepted', res.body && res.body.ok === true, JSON.stringify(res.body));
    const names = (sentPayload.attachments || []).map(a => a.filename);
    assert('the cid-backed image is dropped once the PDF carries it',
      !names.includes('gantt.png'), JSON.stringify(names));
    assert('a genuine (non-inline) attachment still rides along',
      names.includes('notes.pdf'), JSON.stringify(names));
    assert('the rendered PDF is still attached',
      names.some(n => n.endsWith('.pdf') && n !== 'notes.pdf'), JSON.stringify(names));
  }

  // — fallback when the renderer is unavailable —
  sentPayload = null;
  const savedChrome = process.env.CHROME_EXECUTABLE_PATH;
  process.env.CHROME_EXECUTABLE_PATH = '/nonexistent/chrome-that-is-not-there';
  let res2 = fakeRes();
  await handler({ method: 'POST', body: { ...baseBody, attach_pdf: true } }, res2);
  if (savedChrome) process.env.CHROME_EXECUTABLE_PATH = savedChrome;
  else delete process.env.CHROME_EXECUTABLE_PATH;

  assert('a broken renderer still sends the email', res2.body && res2.body.ok === true, JSON.stringify(res2.body));
  assert('the response says no PDF was attached', res2.body && res2.body.pdfAttached === false);
  assert('the response carries a warning the sender can read',
    Boolean(res2.body && res2.body.warning), JSON.stringify(res2.body));
  assert('the fallback email inlines the full report',
    sentPayload && sentPayload.html.includes('Silt Sock 12inch'));
  assert('the fallback email has no PDF attachment',
    !sentPayload.attachments || !sentPayload.attachments.length);

  // — opting out of the PDF keeps the old behaviour —
  sentPayload = null;
  const res3 = fakeRes();
  await handler({ method: 'POST', body: { ...baseBody, attach_pdf: false } }, res3);
  assert('attach_pdf:false skips rendering entirely and inlines the report',
    res3.body && res3.body.ok === true && res3.body.pdfAttached === false && !res3.body.warning
    && sentPayload.html.includes('Silt Sock 12inch'), JSON.stringify(res3.body));

  // ── 5. ESM loading on a runtime without require(esm) ─────────────────────
  console.log('\nESM loading — the deps are ESM-only, so require() must not come back');

  assert('pdf.js does not require() the ESM-only deps',
    !/require\(\s*['"](puppeteer-core|@sparticuz\/chromium)['"]\s*\)/
      .test(fs.readFileSync(path.join(ROOT, 'api/lib/pdf.js'), 'utf8')));

  if (!chrome) {
    skip('renders with require(esm) disabled, as production does', 'no Chrome/Chromium on this box');
  } else {
    // Node 22 enables require(esm) by default, which is exactly why this broke
    // only once deployed. Turn it off to get the production runtime's behaviour.
    const { execFileSync } = require('child_process');
    const probe = `
      process.env.CHROME_EXECUTABLE_PATH = ${JSON.stringify(chrome)};
      const { renderHtmlToPdf } = require(${JSON.stringify(path.join(ROOT, 'api/lib/pdf.js'))});
      renderHtmlToPdf('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><p>hi</p></body></html>')
        .then(r => { console.log(r.ok ? 'OK' : 'ERR:' + r.error); })
        .catch(e => { console.log('THREW:' + e.message); });
    `;
    let out = '';
    try {
      out = execFileSync(process.execPath, ['--no-experimental-require-module', '-e', probe],
        { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (err) { out = 'SPAWN FAILED: ' + (err.message || ''); }
    assert('renders with require(esm) disabled, as production does',
      out.split('\n').pop() === 'OK', out.slice(0, 300));
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
})();
