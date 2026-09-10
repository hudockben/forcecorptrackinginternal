#!/usr/bin/env node
'use strict';
/**
 * The Hours Report has to FIT. Measured in a real browser, not asserted in CSS.
 *
 * Run: node scripts/test-report-width.js
 *      (skips cleanly when the bundled Chromium is not present)
 *
 * The report grew from twelve columns to fifteen when the overtime split was
 * added, and the Status column fell off the right edge of the card — on screen
 * and on paper both. Nothing caught it, because column width is not a property
 * of the markup or of any one rule: it is what the browser works out from the
 * headings, the figures, the padding and the space the card allows.
 *
 * What made it fit again is worth knowing before touching this file: THE
 * HEADINGS WERE SETTING THE COLUMN WIDTHS. "Travel to Shop" claimed 122px to
 * print "0.00" underneath it, and together the headings wanted 1420px of a
 * 1184px table. They wrap to two lines now and the figures decide. So if a
 * later column makes this test fail, the first question is whether its heading
 * is wider than its numbers, not whether the table needs to shrink.
 *
 * The four things measured here are the four ways it broke:
 *   · the table fits the Reports tab without clipping a column
 *   · the printed sheet fits a landscape page
 *   · when it does scroll, the employee column stays put and stays opaque
 *   · and on paper that sticky column is not a black bar down the page
 */

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let puppeteer;
try { puppeteer = require(path.join(ROOT, 'node_modules/puppeteer-core')); }
catch { console.log('puppeteer-core not installed — skipping width checks'); process.exit(0); }
if (!fs.existsSync(CHROME)) {
  console.log(`no browser at ${CHROME} — skipping width checks`);
  process.exit(0);
}

const { JSDOM }    = require(path.join(ROOT, 'node_modules/jsdom'));
const { requireFn } = require(path.resolve(__dirname, 'lib/fn-source.js'));
const PAGE = fs.readFileSync(path.join(ROOT, 'payroll.html'), 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? '  — ' + detail : ''}`); }
}

// ── Render the report with the page's OWN renderer ──────────────────────────
// Hand-built rows would measure a table nobody ships. Every class and every
// figure below was put there by renderReport.
const RENDER_FNS = ['escapeHtml', 'prettyDate', 'prettyDateShort', 'prettyDiv', 'prettyOff',
  'dayFlagHtml', 'isOffSiteHaul', 'offSiteHaulWork', 'weekStartOf', 'weekEndOf',
  'weeklyOvertime', 'weekBandHtml', 'reportDetailHtml', 'buildReportModel', 'renderReport'];

const FROM = '2026-08-27', TO = '2026-09-10';
const dom = new JSDOM(`<!doctype html><body>
  <input id="flt-from" value="${FROM}"><input id="flt-to" value="${TO}">
  <select id="flt-division"><option value="" selected></option></select>
  <input id="flt-user" value=""><input id="flt-supervisor" value="">
  <div id="reportWrap"></div></body>`);

// A fortnight with the widest content the columns realistically carry: a long
// username, a long project label, a division that spells out, and figures in
// the hundreds so no column is measured on a narrow number.
const day = (work_date, computed_hours, job_label, division, prevailing_wage) => ({
  id: work_date + job_label, username: 'shuffstallmatt', entry_type: 'daily',
  status: 'approved', division: division || 'dust', work_date,
  computed_hours, travel_hours: 2, travel_to_site_hours: 1, travel_to_shop_hours: 1,
  job_label, prevailing_wage: !!prevailing_wage, haul_type: null,
  lunch_break: false, operated_equipment: true, created_at: work_date + 'T12:00:00Z',
});
const filtered = [
  day('2026-08-27', 11.00, 'Northeast Natural Energy'),
  day('2026-08-28',  6.50, 'Penn Energy'),
  day('2026-08-31',  8.00, 'Cowanshnock Twp'),
  day('2026-09-01', 10.50, 'Franklin Regional Softball · 26049', 'turf', true),
  day('2026-09-02',  8.50, 'Penn Energy'),
  day('2026-09-03', 10.00, 'Northeast Natural Energy'),
  day('2026-09-04',  7.25, 'XTO Impoundment · 26025', 'paving', true),
  day('2026-09-05',  1.00, 'Ox Hill'),
  { id: 'off1', username: 'shuffstallmatt', entry_type: 'time_off', status: 'submitted',
    time_off_type: 'bereavement', work_date: '2026-09-07' },
  day('2026-09-08', 12.00, 'CNX Fern/Graham · 26011', 'kiewit'),
  day('2026-09-09', 10.50, 'Northeast Natural Energy'),
];

const api = new Function('document', 'filtered', 'user', 'expandedReportUsers', 'loadedScope', `
  const OT_WEEKLY_THRESHOLD = 40;
  ${RENDER_FNS.map(n => requireFn(PAGE, n, 'payroll.html')).join('\n')}
  return { renderReport };
`)(dom.window.document, filtered, { companyName: 'Force Corp', companyCode: 'FC' },
   new Set(['shuffstallmatt']), { from: FROM, to: TO, division: '' });

api.renderReport();
const reportHtml = dom.window.document.getElementById('reportWrap').innerHTML;
const css = [...PAGE.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
// main.main-wide is what the Reports tab puts on <main>; measuring without it
// would measure a layout the tab never uses.
const html = `<!doctype html><html><head><style>${css}</style></head>` +
  `<body><main id="mainContent" class="main-wide">${reportHtml}</main></body></html>`;

// A landscape Letter page at the sheet's own 0.4in margins is 10.2in of usable
// width, which is 979px at 96dpi.
const PRINT_PX = 979;

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  const load = async (width, media) => {
    await page.setViewport({ width, height: 900 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMediaType(media);
    // setContent before emulateMediaType, then a reflow read, or the print
    // rules are not yet applied when the measurements are taken.
    return page.evaluate(() => document.body.offsetWidth);
  };

  const measure = () => page.evaluate(() => {
    const scroll = document.querySelector('.report > .report-scroll');
    const table  = scroll.querySelector(':scope > table');
    const detail = document.querySelector('.report-detail-table');
    return {
      // What the card actually gives the table.
      available: Math.round(scroll.clientWidth),
      // What the table needs. At a viewport far narrower than the content this
      // is min-content; at a wide one it is what the table settled at.
      needed:    Math.round(table.scrollWidth),
      detail:    detail ? Math.round(detail.scrollWidth) : 0,
      clipped:   table.scrollWidth - scroll.clientWidth,
      columns:   table.querySelectorAll(':scope > thead th').length,
    };
  });

  // ── The minimum the table can be squeezed to ──
  console.log('\n[how narrow the table can get]');
  await load(400, 'screen');
  const min = await measure();
  console.log(`  fifteen columns want ${min.needed}px at their narrowest`);
  assert('the report is still the fifteen columns this measures',
    min.columns === 15, `got ${min.columns}`);
  // The old reading column: main's 1280px less its padding and the card's.
  const OLD_CARD = 1280 - (24 * 2) - (24 * 2);
  assert(`and fit even the old ${OLD_CARD}px reading column, so no width is load-bearing`,
    min.needed <= OLD_CARD, `${min.needed}px > ${OLD_CARD}px`);

  // ── The screens payroll actually uses ──
  console.log('\n[on the screens payroll uses]');
  for (const width of [1366, 1440, 1600, 1920]) {
    await load(width, 'screen');
    const m = await measure();
    assert(`  ${width}px: nothing is cut off (${m.needed}px into ${m.available}px)`,
      m.clipped <= 1, `${m.clipped}px past the edge`);
  }

  // ── On paper ──
  console.log('\n[on a landscape page]');
  await load(PRINT_PX, 'print');
  const p = await measure();
  console.log(`  the printed table comes in at ${p.needed}px`);
  assert(`the whole table fits ${PRINT_PX}px — the Status column is on the sheet`,
    p.needed <= PRINT_PX, `${p.needed}px > ${PRINT_PX}px`);
  assert(`  and so does the per-employee detail (${p.detail}px)`,
    p.detail <= PRINT_PX, `${p.detail}px > ${PRINT_PX}px`);

  const printCells = await page.evaluate(() => {
    const name = document.querySelector('.report tbody td.name');
    const s = getComputedStyle(name);
    return { position: s.position, background: s.backgroundColor };
  });
  // The sticky employee column carries a dark surface colour for the dark
  // theme. Left in place it printed as a black bar down the whole page.
  assert('the employee column is not sticky on paper',
    printCells.position === 'static', printCells.position);
  assert('  and has no dark fill to print as a bar',
    /rgba\(0, 0, 0, 0\)|transparent/.test(printCells.background), printCells.background);

  // ── When it does have to scroll ──
  console.log('\n[when the window is too narrow for it anyway]');
  await load(900, 'screen');
  const held = await page.evaluate(() => {
    const scroll = document.querySelector('.report > .report-scroll');
    const name   = document.querySelector('.report tbody td.name');
    const left   = () => Math.round(name.getBoundingClientRect().left - scroll.getBoundingClientRect().left);
    const before = left();
    scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
    return {
      scrollable: scroll.scrollWidth - scroll.clientWidth,
      before, after: left(),
      background: getComputedStyle(name).backgroundColor,
    };
  });
  assert('the table scrolls rather than clipping', held.scrollable > 0, JSON.stringify(held));
  assert('  the employee column holds the left edge, so every figure still has a name',
    held.before === held.after, `${held.before} -> ${held.after}`);
  // Transparent, the figures scroll through underneath the names.
  assert('  and is opaque, so nothing scrolls through underneath it',
    !/rgba\(0, 0, 0, 0\)/.test(held.background), held.background);

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('Harness error:', err); process.exit(1); });
