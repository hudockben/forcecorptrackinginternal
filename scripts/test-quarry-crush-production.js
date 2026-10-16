'use strict';

/**
 * Analytics → Crushing Production: cost / ton, loads, tons and the notes,
 * by month and by product.
 *
 * The section charts the crushing plant from the Crushing Tracking rows, and
 * pins every comment typed on those rows to the point it explains — a red
 * point, with the note in the hover. "pully belts broke for 206 conveyor" is
 * why that day's rate is out of range; it has to be on the dip.
 *
 * The figures follow the Crushing tab's own rule: a DAY at a pit is the unit,
 * because the crew's labour and the loads that went to the crusher sit on
 * different rows. A day's cost is split across its products by tons, and a
 * row with no product counts toward the day's main product.
 *
 * Fixture (2026 unless noted):
 *   03-12 McGees Mills  2B   crew 260 + 260 (one untagged), operator 260 + 464 gal × 5.5
 *                            35 loads × 28 = 980 t, 5.5 hrs  — "pully belts broke for 206 conveyor"
 *                            day cost 3,332.00 ÷ 980 = $3.40/ton
 *   03-13 McGees Mills  2B   1,135.00 + 253.50 = 1,388.50 ÷ 572 t
 *   04-02 Homer City    2A 600 t (6 hrs typed here) + 2B 300 t (no hours) + untagged crew 260
 *                            day 676.00 ÷ 900 t → 2A gets 2/3, 2B 1/3; hours split 4 / 2
 *   04-03 Homer City    2A   208.00, nothing crushed — "Crusher down — rain <screens flooded>"
 *   05-06 McGees Mills  Mike's Mix  260 ÷ 200 t
 *   2025-06-01          2B   (other year — must not count)
 *
 * Run: node scripts/test-quarry-crush-production.js   (needs jsdom: npm i --no-save jsdom)
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'quarry.html');

const PULLEY = 'pully belts broke for 206 conveyor';
const RAIN   = 'Crusher down — rain <screens flooded>';

const CRUSH = [
  { id: 'a1', date: '2026-03-12', locationName: 'McGees Mills', employeeName: 'Jeff Riffer', productName: '2B',
    hourlyRate: 26, hours: 10 },
  { id: 'a2', date: '2026-03-12', locationName: 'McGees Mills', employeeName: 'thomasjason',
    hourlyRate: 26, hours: 10 },
  { id: 'tsq-9001-1', date: '2026-03-12', locationName: 'McGees Mills', employeeName: 'boringjamey', productName: '2B',
    hourlyRate: 26, hours: 10, fuelGallons: 464, fuelCost: 5.5, loadsToCrusher: 35, tonsPerLoad: 28, hoursCrushing: 5.5,
    comments: PULLEY },
  { id: 'b1', date: '2026-03-13', locationName: 'McGees Mills', employeeName: 'boringjamey', productName: '2B',
    hourlyRate: 26, hours: 10, fuelGallons: 175, fuelCost: 5, loadsToCrusher: 22, tonsPerLoad: 26, hoursCrushing: 2.5 },
  { id: 'b2', date: '2026-03-13', locationName: 'McGees Mills', employeeName: 'Glattshane', productName: '2b',
    hourlyRate: 26, hours: 9.75 },
  { id: 'c1', date: '2026-04-02', locationName: 'Homer City', employeeName: 'Steve Travis', productName: '2A',
    hourlyRate: 26, hours: 8, loadsToCrusher: 20, tonsPerLoad: 30, hoursCrushing: 6 },
  { id: 'c2', date: '2026-04-02', locationName: 'Homer City', employeeName: 'Nick Detwiler', productName: '2B',
    hourlyRate: 26, hours: 8, loadsToCrusher: 10, tonsPerLoad: 30 },
  { id: 'c3', date: '2026-04-02', locationName: 'Homer City', employeeName: 'Jacob Himes',
    hourlyRate: 26, hours: 10 },
  { id: 'd1', date: '2026-04-03', locationName: 'Homer City', employeeName: 'Jacob Himes', productName: '2A',
    hourlyRate: 26, hours: 8, comments: RAIN },
  { id: 'e1', date: '2026-05-06', locationName: 'McGees Mills', employeeName: 'boringjamey', productName: "Mike's Mix",
    hourlyRate: 26, hours: 10, loadsToCrusher: 10, tonsPerLoad: 20, hoursCrushing: 2 },
  { id: 'z1', date: '2025-06-01', locationName: 'McGees Mills', employeeName: 'boringjamey', productName: '2B',
    hourlyRate: 26, hours: 10, loadsToCrusher: 99, tonsPerLoad: 30, hoursCrushing: 9, comments: 'last year' },
];
const LISTS = {
  location: [{ id: 'l1', name: 'Homer City' }, { id: 'l2', name: 'McGees Mills' }],
  product:  [{ id: 'p1', name: '2A' }, { id: 'p2', name: '2B' }, { id: 'p3', name: "Mike's Mix" }],
  customer: [], equipment: [], tasks: [], employees: [],
};
const BLOBS = {
  fct_quarry_lists:     LISTS,
  fct_quarry_crushing:  CRUSH,
  fct_quarry_sales:     [],
  fct_quarry_daily:     [],
  fct_quarry_inventory: {},
  fct_quarry_loss_pct:  {},
  fct_presence:         {},
};

// The numbers the fixture has to come to.
const D0312 = 260 + 260 + (260 + 464 * 5.5);      // 3,332.00
const D0313 = (260 + 175 * 5) + 26 * 9.75;        // 1,388.50
const D0402 = 208 + 208 + 260;                    //   676.00
const D0403 = 208;
const D0506 = 260;
const MAR_COST = D0312 + D0313, MAR_TONS = 980 + 572;
const APR_COST = D0402 + D0403, APR_TONS = 900;
const TOT_COST = MAR_COST + APR_COST + D0506, TOT_TONS = MAR_TONS + APR_TONS + 200;
const B2_COST = D0312 + D0313 + D0402 / 3, B2_TONS = 980 + 572 + 300;
const A2_COST = D0402 * 2 / 3 + D0403;

// ── Harness ────────────────────────────────────────────────────────────────
let failures = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function stubFetch(blobs) {
  return async (url, init) => {
    const m = /\/api\/data\/([^?]+)/.exec(String(url));
    const key = m ? decodeURIComponent(m[1]) : '';
    if (m && (!init || !init.method || init.method === 'GET')) {
      return {
        ok: true, status: 200,
        json: async () => ({ value: Object.prototype.hasOwnProperty.call(blobs, key) ? blobs[key] : null }),
        text: async () => '',
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
}

function loadPage(blobs) {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/quarry.html',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', name: 'Test User', companyCode: 'TEST', companyName: 'Test Co',
      }));
      win.fetch = stubFetch(blobs);
      win.alert = (msg) => console.log('  [alert suppressed]', String(msg).slice(0, 120));
      win.print = () => {};
      const errs = [];
      win.__errors = errs;
      win.addEventListener('error', e => errs.push(e.message || String(e.error)));
    },
  });
}

async function main() {
  const dom = loadPage(BLOBS);
  const win = dom.window;
  const doc = win.document;

  for (let i = 0; i < 80 && !/Rows/i.test(doc.getElementById('crushSummary')?.textContent || ''); i++) await sleep(25);
  win.switchTab('analytics');
  await sleep(80);
  win.setYearFilter('analytics', '2026');
  await sleep(30);

  const scriptErrors = (win.__errors || []).filter(Boolean);
  check('no uncaught script errors on load', scriptErrors.length ? scriptErrors.join(' | ') : 0, 0);

  const txt = (id) => (doc.getElementById(id)?.textContent || '').trim();
  const rowsOf = (sel) => [...doc.querySelectorAll(`${sel} tbody tr`)];
  const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim());
  const redDots = () => [...doc.querySelectorAll('#cpChartWrap svg circle')]
    .filter(c => c.getAttribute('fill') === '#ef4444');
  const hollowRed = () => [...doc.querySelectorAll('#cpChartWrap svg circle')]
    .filter(c => c.getAttribute('stroke') === '#ef4444' && c.getAttribute('fill') !== '#ef4444'
      && !c.closest('.cp-hover-marks'));

  // ── KPIs ──
  console.log('\n— KPI tiles (2026, all pits, all products) —');
  check('cost / ton is all crushing cost ÷ all tons', txt('cpKpiCpt'), money(TOT_COST / TOT_TONS));
  check('tons crushed', txt('cpKpiTons'), TOT_TONS.toLocaleString('en-US'));
  check('loads to crusher', txt('cpKpiLoads'), String(35 + 22 + 30 + 10));
  check('total cost', txt('cpKpiCost'), money(TOT_COST));
  check('crushing days (date + pit), 2025 excluded', txt('cpKpiDays'), '5');
  check('days with notes', txt('cpKpiDaysSub'), '2 with notes');

  // ── By Month ──
  console.log('\n— By Month —');
  const monthRows = rowsOf('#analyticsCrushMonthTable');
  check('one row per month crushed + total', monthRows.map(tr => cells(tr)[0]).join(','), 'Mar,Apr,May,Total');
  const mar = cells(monthRows[0]);
  check('March products', mar[1], '2B');
  check('March days', mar[2], '2');
  check('March tons', mar[4], MAR_TONS.toLocaleString('en-US'));
  check('March tons / hr', mar[7], (MAR_TONS / 8).toLocaleString('en-US', { maximumFractionDigits: 2 }));
  check('March cost / ton is the month blend', mar[11], money(MAR_COST / MAR_TONS));
  check('March notes count', mar[12], '1');
  check('March note hover text', monthRows[0].querySelector('.cp-note-count').getAttribute('title'), `Mar 12: ${PULLEY}`);
  const apr = cells(monthRows[1]);
  check('April lists both products, most tons first', apr[1], '2A, 2B');
  check('April cost / ton', apr[11], money(APR_COST / APR_TONS));
  check('total row foots', cells(monthRows[3])[10], money(TOT_COST));

  // Lines: All products + 2B + 2A + Mike's Mix. Notes: Mar (All, 2B), Apr (All, 2A).
  const legendNames = [...doc.querySelectorAll('#cpLegend .cp-leg:not(.is-static)')].map(b => b.textContent.trim());
  check('legend leads with All products, then first-crushed order', legendNames.join(' | '), "All products | 2B | 2A | Mike's Mix");
  check('a red point on every series in a month with a note', redDots().length, 4);
  check('12 month labels for a single year', [...doc.querySelectorAll('#cpChartWrap svg text')]
    .filter(t => /^[A-Z][a-z]{2}$/.test(t.textContent)).length, 12);

  // Hover March — the note shows.
  const svg = doc.querySelector('#cpChartWrap svg');
  const W = Number(svg.getAttribute('width'));
  const plotW = W - 62 - 18;
  const xOf = (i, n) => 62 + (i + 0.5) * (plotW / n);
  svg.dispatchEvent(new win.MouseEvent('pointermove', { clientX: xOf(2, 12), clientY: 100, bubbles: true }));
  const tip = doc.querySelector('#cpChartWrap .cp-tip');
  check('hovering March opens the tooltip', tip.classList.contains('is-on'), true);
  check('tooltip names the month', tip.querySelector('.cp-tip-head').textContent.startsWith('March 2026'), true);
  check('tooltip carries the note', [...tip.querySelectorAll('.cp-tip-note')].map(n => n.lastChild.textContent).join('|'), PULLEY);
  check('note is labelled with its day, product and pit', tip.querySelector('.cp-tip-note .when').textContent, '📝 Mar 12 · 2B · McGees Mills');
  check('crosshair is shown', svg.querySelector('.cp-xhair').getAttribute('visibility'), 'visible');
  svg.dispatchEvent(new win.MouseEvent('pointerdown', { clientX: xOf(1, 12), clientY: 100, bubbles: true }));
  check('an empty month says so', tip.textContent.includes('No crushing this month'), true);
  doc.body.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }));
  check('tapping outside closes it', tip.classList.contains('is-on'), false);

  // Keyboard: same readout, arrows skip empty months.
  svg.dispatchEvent(new win.FocusEvent('focus'));
  check('focus opens the first month with crushing', tip.querySelector('.cp-tip-head').textContent.startsWith('March'), true);
  svg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  check('ArrowRight steps to April', tip.querySelector('.cp-tip-head').textContent.startsWith('April'), true);
  svg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  // Metric switch.
  win.setCrushProdMetric('tonsPerHour');
  check('metric changes the title', txt('cpChartTitle'), 'Tons / Hour by Month · All Products · All Locations');

  // Legend toggles a line off, and the colours of the rest stay put.
  const colorOf = name => [...doc.querySelectorAll('#cpLegend .cp-leg')].find(b => b.textContent.trim() === name)?.style.color;
  const twoAColor = colorOf('2A');
  win.toggleCrushProdSeries(0);
  check('legend toggle hides All products', doc.querySelector('#cpLegend .cp-leg').classList.contains('is-off'), true);
  check('…and 2A keeps its colour', colorOf('2A'), twoAColor);
  win.toggleCrushProdSeries(0);
  win.setCrushProdMetric('costPerTon');

  // Location pick.
  win.setCrushProdLocation('homer city');
  check('location narrows the KPIs', txt('cpKpiTons'), '900');
  check('…and the colours do not repaint', colorOf('2A'), twoAColor);
  win.setCrushProdLocation('');

  // ── By Product ──
  console.log('\n— By Product —');
  win.setCrushProdView('product');
  check('month table hides, product table shows',
    `${doc.getElementById('cpMonthPanel').style.display}|${doc.getElementById('cpProductPanel').style.display}`, 'none|');
  const prodRows = rowsOf('#analyticsCrushProductTable');
  check('one row per product, most tons first, + total', prodRows.map(tr => cells(tr)[0]).join(','), "2B,2A,Mike's Mix,Total");
  const b2 = cells(prodRows[0]);
  check('2B and 2b are one product', b2[1], '3');
  check('2B tons include its share of the mixed day', b2[3], B2_TONS.toLocaleString('en-US'));
  check('2B cost / ton carries 1/3 of the mixed day', b2[9], money(B2_COST / B2_TONS));
  check('2B hours: row-level, plus the mixed day split by tons', b2[6], String(5.5 + 2.5 + 2));
  const a2 = cells(prodRows[1]);
  check('2A cost / ton: 2/3 of the mixed day + its no-tons day', a2[9], money(A2_COST / 600));
  check('2A hours: the mixed day split by tons', a2[6], '4');
  check('2A notes', a2[10], '1');

  // Click the apostrophe product — index-based handler, no broken JS string.
  prodRows[2].click();
  check("clicking Mike's Mix picks it", doc.getElementById('cpProduct').selectedOptions[0].textContent, "Mike's Mix");
  check('…and charts it by day', txt('cpChartTitle'), "Cost / Ton by Crushing Day · Mike's Mix · All Locations");

  win.setCrushProdProduct('2b');
  check('2B by day: one point per crushing day', [...doc.querySelectorAll('#cpChartWrap svg text')]
    .filter(t => /^(Mar|Apr) \d+$/.test(t.textContent)).map(t => t.textContent).join(','), 'Mar 12,Mar 13,Apr 2');
  check('2B by day: the pulley-belt day is red', redDots().length, 1);
  check('a single line shows its average', [...doc.querySelectorAll('#cpChartWrap svg text')]
    .some(t => t.textContent === `Avg ${money(B2_COST / B2_TONS)}/ton`), true);
  check('KPIs follow the product pick', txt('cpKpiTons'), B2_TONS.toLocaleString('en-US'));

  win.setCrushProdProduct('2a');
  check('a note on a day with no tons still shows (hollow, on the baseline)', hollowRed().length, 1);
  const svg2 = doc.querySelector('#cpChartWrap svg');
  const W2 = Number(svg2.getAttribute('width'));
  svg2.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 62 + 1.5 * ((W2 - 80) / 2), clientY: 100, bubbles: true }));
  const tip2 = doc.querySelector('#cpChartWrap .cp-tip');
  check('hovering the no-tons day explains it', tip2.querySelector('.cp-tip-stats').textContent.includes('no tons crushed'), true);
  check('…and shows its note, escaped', tip2.querySelector('.cp-tip-note').lastChild.textContent, RAIN);
  check('…without creating markup from it', tip2.querySelector('screens'), null);

  // ── Notes table ──
  console.log('\n— Crushing Notes —');
  win.setCrushProdProduct('');
  const noteRows = rowsOf('#analyticsCrushNotesTable');
  check('one row per noted day, newest first', noteRows.map(tr => cells(tr)[0]).join(','), 'Apr 3, 2026,Mar 12, 2026');
  check('the pulley note with its day numbers', cells(noteRows[1]).slice(1).join(' | '),
    `McGees Mills | 2B | ${PULLEY}boringjamey’s row | 980 | ${(980 / 5.5).toLocaleString('en-US', { maximumFractionDigits: 2 })} | ${money(D0312 / 980)}`);
  check('note text is escaped', noteRows[0].querySelector('.cp-note-text screens'), null);

  // ── PDF ──
  console.log('\n— PDF —');
  win.setCrushProdView('month');
  const pdf = win.crushProdPdfSection();
  check('PDF section draws the chart', /<svg[\s\S]*<\/svg>/.test(pdf), true);
  check('PDF chart keeps the red note points', (pdf.match(/fill="#ef4444"/g) || []).length, 4);
  check('PDF uses print colours', pdf.includes('#2a78d6') && !pdf.includes('#3987e5'), true);

  // ── All Years ──
  win.setYearFilter('analytics', 'all');
  await sleep(10);
  check('All Years brings 2025 back in', txt('cpKpiDays'), '6');
  check('All Years months carry the year', rowsOf('#analyticsCrushMonthTable').map(tr => cells(tr)[0])[0], 'Jun 2025');

  const lateErrors = (win.__errors || []).filter(Boolean);
  check('no script errors after interacting', lateErrors.length ? lateErrors.join(' | ') : 0, 0);

  // ── Past five products, the rest share one line — until one is picked ──
  console.log('\n— More products than colours —');
  const many = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'].map((p, i) => ({
    id: 'm' + i, date: `2026-06-0${i + 1}`, locationName: 'Homer City', employeeName: 'x', productName: p,
    hourlyRate: 26, hours: 8, loadsToCrusher: 10, tonsPerLoad: 20, hoursCrushing: 4,
  }));
  const dom2 = loadPage({ ...BLOBS, fct_quarry_crushing: many });
  const win2 = dom2.window, doc2 = win2.document;
  for (let i = 0; i < 80 && !/Rows/i.test(doc2.getElementById('crushSummary')?.textContent || ''); i++) await sleep(25);
  win2.switchTab('analytics');
  await sleep(80);
  win2.setYearFilter('analytics', '2026');
  const legend2 = () => [...doc2.querySelectorAll('#cpLegend .cp-leg:not(.is-static)')].map(b => b.textContent.trim()).join(' | ');
  check('first five get colours, the rest fold into Other', legend2(), 'All products | P1 | P2 | P3 | P4 | P5 | Other products');
  win2.setCrushProdProduct('p7');
  check('a picked sixth-or-later product is named, not "Other"', legend2(), 'P7');

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
