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
// A handler after a "/" (the parser reads <img/onerror=...> as an
// attribute), a closing tag with a space before its ">", a stray opening
// tag, and markup a removal splices back together.
{
  const cases = {
    'a handler after "/"': '<img src="x"/onerror="alert(1)"><p>keep</p>',
    'a handler after "/" with no quotes on the source': '<img src=x/onerror=alert(1)><p>keep</p>',
    '</script > with a space': '<script>alert(1)</script ><p>keep</p>',
    'a stray <script> with no close': '<p>keep</p><script>alert(1)',
    'tags a removal splices back': '<scr<script>x</script>ipt>alert(1)</script><p>keep</p>',
    'a handler spliced back': '<img src=x o<script></script>nerror=alert(1)><p>keep</p>',
    '</iframe > with a space': '<iframe srcdoc="x"></iframe ><p>keep</p>',
    // A ">" inside a quoted attribute does not end the tag: a rule scoped to
    // "<tag ...>" spans would stop there and let the handler through.
    'a handler after a quoted ">"': '<img alt="a>b" onerror=alert(1) src=x><p>keep</p>',
    // A quote only opens a value right after "=": a stray one in an
    // unquoted value must not make a tag reader stop short of the handler.
    'a handler after a stray quote in an unquoted value': '<img alt=a"b title=">" onerror=alert(1)><p>keep</p>',
    // A quoted value may run straight into the next attribute.
    'a handler right after a quoted value': '<img src="x"onerror=alert(1)><p>keep</p>',
    // A comment, or an svg <title>, can put a tag reader out of step with
    // the browser: the handler is the browser's, whatever the reader thinks.
    'a handler a comment hides from a tag reader': '<!--<x a="--><img src=1 b=\'">\' onerror=alert(1)><p>keep</p>',
    'a handler after "/" a comment hides from a tag reader': '<!--<x a="--><img src=1 b=\'">\'/onerror=alert(1)><p>keep</p>',
    'a handler after "/" behind an svg <title>': '<svg><title><img src=1 b=\'</title>\'/onerror=alert(1)></svg><p>keep</p>',
    'a handler left in a tag the report never closes': '<p>keep</p><img src=x onerror="alert(1)',
    // A raw-text / RCDATA element, a comment, or a CDATA section can end at a
    // terminator a tag reader does not see inside a faked attribute value, so
    // the browser parses the <img> and its handler on the far side. Each of
    // these fires in a real browser unless the sanitizer skips the span to its
    // real terminator; the pattern is `<RAW><b c='</RAW><img …onerror=…>'`.
    'a handler a <style> span hides from a tag reader': '<style><b c=\'</style><img src="x"onerror=alert(1)>\'</style><p>keep</p>',
    'a handler a <title> span hides from a tag reader': '<title><b c=\'</title><img src="x"onerror=alert(1)>\'</title><p>keep</p>',
    'a handler a <textarea> span hides from a tag reader': '<textarea><b c=\'</textarea><img src="x"onerror=alert(1)>\'</textarea><p>keep</p>',
    'a handler an <xmp> span hides from a tag reader': '<xmp><b c=\'</xmp><img src="x"onerror=alert(1)>\'</xmp><p>keep</p>',
    'a handler a <noembed> span hides from a tag reader': '<noembed><b c=\'</noembed><img src="x"onerror=alert(1)>\'</noembed><p>keep</p>',
    'a handler a <noframes> span hides from a tag reader': '<noframes><b c=\'</noframes><img src="x"onerror=alert(1)>\'</noframes><p>keep</p>',
    'a handler an svg CDATA span hides from a tag reader': '<svg><![CDATA[<b c=\']]><img src="x"onerror=alert(1)>\']]></svg><p>keep</p>',
    'a handler straight after a comment that spans a quote': '<!--<b c=\'--><img src="x"onerror=alert(1)>\'--><p>keep</p>',
    // …and the reverse: a span the reader keeps whole that the browser reads
    // as markup. "<!-->" and "<!--->" close at once; an HTML "<![CDATA[" is a
    // bogus comment that ends at its first ">"; inside svg/math a <style>,
    // <title> or <textarea> is an ordinary element and an <img> breaks out of
    // it as a live HTML element.
    'a handler after an empty comment "<!-->"': '<!--><img src=x onerror=alert(1)>--><p>keep</p>',
    'a handler after an empty comment "<!--->"': '<!---><img src=x onerror=alert(1)>--><p>keep</p>',
    'a handler after an HTML-context CDATA (a bogus comment)': '<![CDATA[x><img src=x onerror=alert(1)>]]><p>keep</p>',
    'a handler inside an svg <style>': '<svg><style><img src=x onerror=alert(1)></style></svg><p>keep</p>',
    'a handler inside an svg <title>': '<svg><title><img src=x onerror=alert(1)></title></svg><p>keep</p>',
    'a handler inside a math <style>': '<math><style><img src=x onerror=alert(1)></style></math><p>keep</p>',
    'a handler inside an svg <textarea>': '<svg><textarea><img src=x onerror=alert(1)></textarea></svg><p>keep</p>',
    'a handler past a faked </style> inside an svg <style>': '<svg><style><img src=x a=\'</style>\' onerror=alert(1)></svg><p>keep</p>',
    // Inside an svg <style> a comment or CDATA is the browser's own, so a tag
    // read from the first "<" + letter can swallow the live <img> in a value.
    'a handler a comment inside an svg <style> hides from a tag reader': '<svg><style><!--<a title="--><img src=x onerror=alert(1)>"></style></svg><p>keep</p>',
    'a handler a CDATA inside an svg <style> hides from a tag reader': '<svg><style><![CDATA[<a title="]]><img src=x onerror=alert(1)>"></style></svg><p>keep</p>',
    // A faked </style> inside an svg <style> ends the reader's span while the
    // browser is still in the <img>, so a comment or CDATA the reader then
    // keeps whole is that tag's attributes to the browser.
    'a handler in a "comment" read past a faked </style> in svg': '<svg><style><img src=x a=\'</style>\' <!-- \' onerror=alert(1) --></svg><p>keep</p>',
    'a handler in a "CDATA" read past a faked </style> in svg': '<svg><style><img src=x a=\'</style>\' <![CDATA[ \' onerror=alert(1) ]]></svg><p>keep</p>',
    'a handler straight after a quoted value inside an svg <style>': '<svg><style><img src="x"onerror=alert(1)></style></svg><p>keep</p>',
  };
  // The browser's own reading is the judge: parsed as a document, and as the
  // email shell's body (where markup after it can close an open tag), no
  // element carries an event handler (an attribute named on + letters — one
  // a defused "onerror&#61;…" leaves behind is named that, and runs nothing).
  const handlerAttrs = h => [h, `<div>${h}</div><p title="x">y</p>`].flatMap(doc =>
    [...new JSDOM(doc).window.document.querySelectorAll('*')].flatMap(el => [...el.attributes].map(a => a.name).filter(n => /^on[a-z]+$/i.test(n))));
  for (const [what, html] of Object.entries(cases)) {
    const out = sanitizeReportHtml(html);
    const left = handlerAttrs(out);
    assert(`sanitizeReportHtml strips ${what}`, !/<script|onerror\s*=|<iframe/i.test(out) && out.includes('<p>keep</p>') && !left.length,
      out + (left.length ? '  (handlers: ' + left.join(', ') + ')' : ''));
  }
  const plain = '<table><tr><td>Tons / Day</td><td>a/b</td></tr></table><br/><img src="data:image/png;base64,AAAA"/>';
  assert('…and leaves ordinary report markup alone (slashes, self-closing tags)', sanitizeReportHtml(plain) === plain, sanitizeReportHtml(plain));
  // Report text that only looks like a handler — a sub code "Curb w/one =
  // 6in", a note "w/onsite = 200 CY" — is the report's own words: it reads
  // the same after sanitizing (at most its "=" is written &#61;), in a cell,
  // in a paragraph and in an attribute value.
  const words = '<table><tr><td class="sub">Curb w/one = 6in</td><td>1,200</td></tr></table><p>Topsoil w/onsite = 200 CY</p><p>Phase one = 1,200</p>';
  const wOut = sanitizeReportHtml(words);
  const textOf = h => new JSDOM(h).window.document.body.textContent;
  assert('report text that only looks like a handler ("Curb w/one = 6in", "w/onsite = 200 CY", "Phase one = 1,200") reads the same after sanitizing',
    textOf(wOut) === textOf(words) && wOut.replace(/&#61;/g, '=') === words && !handlerAttrs(wOut).length, wOut);
  // The spans the sanitizer keeps (a <title>, CSS, an svg <title>/<style>, a
  // comment) come through byte for byte: report words there are not defused.
  const realDoc = '<!DOCTYPE html><html><head><title>Maple Ave — Conditions = dry</title>'
    + '<style>body{font:12px system-ui}@page{size:letter landscape;margin:0.45in}.t td[data-k="a"]{color:#111}.x:not(.y)>b{content:"a/b"}</style></head>'
    + '<body><!-- report body: Conditions = dry --><h1>Weekly update</h1>'
    + '<svg viewBox="0 0 10 10" role="img"><title>Earned vs plan — Conditions = dry</title><style>.ln{stroke:#0a0;stroke-width:2}</style>'
    + '<path class="ln" d="M0 10L10 0"/></svg><table><tr><td>Tons / Day</td><td>a/b</td></tr></table></body></html>';
  const realOut = sanitizeReportHtml(realDoc);
  assert('a real report document (a <title> and svg <title> with "Conditions = …", CSS with @page, a comment) comes through byte for byte',
    realOut === realDoc, realOut);
  // Words in such a span that do sit where an attribute could start ("Phase
  // one = 1,200") may have their "=" written &#61; — a <title> decodes it, in
  // HTML and in svg alike, so the title reads the same.
  const titled = '<html><head><title>Phase one = 1,200</title></head><body><svg><title>Phase one = 1,200</title></svg></body></html>';
  const tDoc = new JSDOM(sanitizeReportHtml(titled)).window.document;
  assert('…and a <title> holding "Phase one = 1,200" reads the same after sanitizing (HTML and svg)',
    tDoc.title === 'Phase one = 1,200' && tDoc.querySelector('svg title').textContent === 'Phase one = 1,200', sanitizeReportHtml(titled));
  const inAttr = '<table><tr><td class="sub" title="Curb w/one = 6in">x</td></tr></table>';
  const aOut = sanitizeReportHtml(inAttr), aTd = new JSDOM(aOut).window.document.querySelector('td');
  assert('…and so does an attribute value holding such text, with the tag around it intact',
    aTd && aTd.getAttribute('title') === 'Curb w/one = 6in' && aTd.className === 'sub' && aTd.textContent === 'x', aOut);
  // Round 6: the sanitizer runs on every email (and twice per scheduled
  // send), so crafted text must not make it quadratic: a long run of letters
  // full of "on" (a bid description, a cell, a title), and many comments.
  let t0 = Date.now();
  sanitizeReportHtml('<td>' + 'on'.repeat(100000) + '</td>');
  sanitizeReportHtml('<td title="' + 'on'.repeat(100000) + '">x</td>');
  const tLetters = Date.now() - t0;
  assert('a long run of letters full of "on" (200 KB, in a cell and in a title) is sanitized in linear time', tLetters < 500, `${tLetters} ms`);
  t0 = Date.now();
  sanitizeReportHtml('<!---->'.repeat(20000));
  sanitizeReportHtml('<!--x--><p>y</p>'.repeat(20000));
  const tComments = Date.now() - t0;
  assert('many comments (20,000) are sanitized in linear time', tComments < 500, `${tComments} ms`);
  // …with handlers still defused wherever an attribute name could start.
  const anchored = { '"onerror=': '<p title="a">"onerror=x</p>', '/onerror=': '<p>a/onerror=x</p>', ' onerror =': '<p>a onerror =x</p>', 'ONERROR=': '<p>ONERROR=x</p>' };
  for (const [what, h] of Object.entries(anchored)) {
    const o = sanitizeReportHtml(h);
    assert(`…and text "${what}" is still defused`, /&#61;/.test(o) && !/onerror\s*=/i.test(o), o);
  }
  const pass = '<p>Conditions = dry</p>';
  assert('…while "Conditions = dry" (an "on" inside a word) comes through as written', sanitizeReportHtml(pass) === pass, sanitizeReportHtml(pass));
  const cmts = { '<!--a-->': '<!--a--><p>k</p>', '<!--a--!>': '<!--a--!><p>k</p>', '<!--a--->': '<!--a---><p>k</p>', '<!--a---!>': '<!--a---!><p>k</p>',
    'both, --!> first': '<!--a--!>b--><p>k</p>', 'unclosed': '<!--a<p>k</p>' };
  for (const [what, h] of Object.entries(cmts)) {
    const o = sanitizeReportHtml(h), d = new JSDOM(o).window.document, d0 = new JSDOM(h).window.document;
    assert(`…and a comment ending ${what} ends where the browser ends it`, d.body.innerHTML === d0.body.innerHTML, o);
  }
}

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
  // ── 2b. The division pages' own report builders, through the sanitizer ──
  // Bid items, the daily summary and the daily PM report print a person's
  // text with only its double quotes escaped, so "Curb w/one = 6in" reaches
  // the sanitizer with a bare "=". What the page built is what must arrive.
  console.log('\npage-built reports keep their text through sanitizeReportHtml');
  {
    const { VirtualConsole } = require('jsdom');
    const SESSION = { fct_token: 'harness', fct_division: 'paving', fct_user: JSON.stringify({ userId: 1, username: 'harness', companyCode: 'FCT',
      isPlatformAdmin: true, divisionRoles: { turf: 'level5', paving: 'level5', kiewit: 'level5' } }) };
    const bootPage = file => new JSDOM(fs.readFileSync(path.join(ROOT, file), 'utf8'), {
      runScripts: 'dangerously', url: 'https://datawatch.app/' + file, virtualConsole: new VirtualConsole(),
      beforeParse(w) {
        Object.entries(SESSION).forEach(([k, v]) => w.localStorage.setItem(k, v));
        w.fetch = () => Promise.resolve({ ok: true, status: 200, text: async () => '',
          json: async () => ({ ok: true, value: null, user: null, employees: [], jobs: [], entries: [], rows: [], groups: [] }) });
        w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
        w.scrollTo = () => {}; w.alert = () => {}; w.confirm = () => true; w.prompt = () => null;
        w.HTMLCanvasElement.prototype.getContext = () => null;
      } });
    const WORDS = ['Curb w/one = 6in', 'Topsoil w/onsite = 200 CY', 'Walk/only = 4in'];
    const count = (h, wd) => {
      const d = new JSDOM(h).window.document;
      d.querySelectorAll('script').forEach(x => x.remove());
      return d.body.textContent.split(wd).length - 1;
    };
    for (const file of ['paving.html', 'tracker.html', 'kiewit-pinetree.html']) {
      const dom = bootPage(file);
      await new Promise(res => setTimeout(res, 300));
      const w = dom.window;
      w.eval(`projectsList.push({ id: 'p1', 'project-name': 'Maple Ave', 'job-number': '26001', client: 'Acme', status: 'In Progress',
        'start-date': '2026-10-01', 'end-date': '2026-12-18',
        bidItems: [
          { id: 'b1', cost_code: 'Concrete', sub_code: 'Curb w/one = 6in', description: 'Topsoil w/onsite = 200 CY', unit: 'LF', quantity: '1200', unit_cost: '10' },
          { id: 'b2', cost_code: 'Concrete', sub_code: 'Walk/only = 4in', description: '', unit: 'SF', quantity: '500', unit_cost: '5' }],
        dailyRows: [{ id: 'r1', date: '2026-11-02', employee: 'A', cost_code: 'Concrete', sub_code: 'Curb w/one = 6in', quantity: '100',
          labor_hours: '8', material: 'Topsoil w/onsite = 200 CY' }] }); _pmrProjId = 'p1';`);
      const built = {
        'bid items': w.eval(`exportBidPDF('p1', null, { returnHtml: true })`),
        'daily summary': w.eval(`exportDailySummaryPDF('all', '2026-11-01', '2026-11-06', { returnHtml: true })`),
        'daily PM report': w.eval(`printDailyPMReport({ returnHtml: true })`),
      };
      for (const [what, b] of Object.entries(built)) {
        const html = b && (typeof b === 'string' ? b : b.html);
        if (!html) { assert(`${file} ${what}: the page builds it`, false, 'no html'); continue; }
        const lost = WORDS.filter(wd => count(html, wd) && count(sanitizeReportHtml(html), wd) !== count(html, wd));
        const shown = WORDS.filter(wd => count(html, wd));
        assert(`${file} ${what}: ${shown.map(x => `"${x}"`).join(', ')} read the same after sanitizing`, shown.length && !lost.length,
          'lost: ' + lost.join(' | '));
      }
      w.close();
    }
  }

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

    // JavaScript must be OFF in the render page: reports are static print
    // markup, and a handler the pattern sanitizer missed (a comment/raw-text/
    // CDATA confusion) would otherwise run in this server-side renderer and
    // make blind outbound connections that request interception can't see.
    // A script that would rewrite visible text proves it: the PDF must still
    // read "before", never "after".
    const scripted = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
      <p id="m">before</p>
      <script>document.getElementById('m').textContent='after';<\/script>
      <img src="x" onerror="document.getElementById('m').textContent='after'">
    </body></html>`;
    const r3 = await renderHtmlToPdf(scripted);
    assert('a scripted report still renders', r3.ok, r3.error);
    if (r3.ok) {
      const { execFileSync } = require('child_process');
      const os = require('os');
      const tmp = path.join(os.tmpdir(), `js-off-${process.pid}.pdf`);
      fs.writeFileSync(tmp, r3.buffer);
      let text = '';
      try { text = execFileSync('pdftotext', ['-q', tmp, '-'], { encoding: 'utf8' }); }
      catch { text = ''; }
      finally { try { fs.unlinkSync(tmp); } catch {} }
      if (text) {
        assert('JavaScript is disabled in the PDF renderer (text stays "before")',
          /before/.test(text) && !/after/.test(text), JSON.stringify(text.trim().slice(0, 60)));
      } else {
        skip('JavaScript is disabled in the PDF renderer', 'pdftotext unavailable');
      }
    }
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
  // MAILS.failAt = n: the n-th send is refused (a bad moment at the mail service).
  const MAILS = { failAt: 0, tries: 0, to: [] };
  const resendPath = require.resolve('resend');
  require.cache[resendPath] = {
    id: resendPath, filename: resendPath, loaded: true, exports: {
      Resend: class {
        constructor() {
          this.emails = { send: async opts => {
            MAILS.tries++;
            if (MAILS.failAt && MAILS.tries === MAILS.failAt) return { data: null, error: { message: 'Resend 500: internal error' } };
            sentPayload = opts; MAILS.to.push([].concat(opts.to));
            return { data: { id: 'stub-id-' + MAILS.tries }, error: null };
          } };
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

  // — a long list goes in batches of 50; the third batch refused: the two
  //   that went are reported (who has it, their ids), not lost in "failed" —
  {
    const { deliverReport } = require(path.join(ROOT, 'api/lib/report-delivery.js'));
    const many = Array.from({ length: 120 }, (_, i) => `r${i}@example.com`);
    Object.assign(MAILS, { failAt: 3, tries: 0, to: [] });
    let out;
    try { out = await deliverReport({ label: 'Custom Report', recipients: many, subject: 'Weekly', html: '<p>x</p>', attachments: [], attachPdf: false }); }
    finally { Object.assign(MAILS, { failAt: 0, tries: 0, to: [] }); }
    assert('deliverReport: a third batch refused → not ok, but it says the first 100 have it (2 emails) and who was not reached',
      out && out.ok === false && out.status === 502 && out.partial === true && out.deliveredTo.length === 100 && out.ids.length === 2
        && out.deliveredTo[0] === 'r0@example.com' && out.deliveredTo[99] === 'r99@example.com' && out.notReached.length === 20
        && /after it had gone to 100 of 120 recipients/.test(out.error) && out.subject === 'Weekly',
      JSON.stringify(out && { ...out, deliveredTo: out.deliveredTo && out.deliveredTo.length, notReached: out.notReached && out.notReached.length }));
    Object.assign(MAILS, { failAt: 1, tries: 0, to: [] });
    try { out = await deliverReport({ label: 'Custom Report', recipients: many.slice(0, 3), subject: 'Weekly', html: '<p>x</p>', attachments: [], attachPdf: false }); }
    finally { Object.assign(MAILS, { failAt: 0, tries: 0, to: [] }); }
    assert('…the first batch refused: nothing went, and it says no more than that', out && out.ok === false && !out.partial && !out.deliveredTo, JSON.stringify(out));
  }

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
