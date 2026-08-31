'use strict';

/**
 * Crushing Tracking — the day group and its blended Cost / Ton.
 *
 * A day of crushing is entered as several rows: one per person for their
 * hours, and one of them also carrying the loads that went to the crusher.
 * Per-row, that made the tons-carrying row look absurdly cheap (its own
 * $238.51 over the day's 810 tons = $0.29/ton) while the rest of the crew's
 * labor was divided by no tons at all. The grid now groups by date + pit and
 * shows the day's blend — day cost ÷ day tons — on the group header and on
 * every row of that day.
 *
 * The fixture is 2026-08-27 at Homer City, exactly as reported:
 *   Shane Glatt   26 × 8.5 = 221.00
 *   Jacob Himes   26 × 8.5 = 221.00
 *   Nick Detwiler 26 × 8   = 208.00
 *   boringjamey   26 × 9   = 234.00  + 184 gal × 0.0245 = 4.508  → 238.508
 *                 27 loads × 30 t/load = 810 tons
 *   day cost 888.508 ÷ 810 tons = $1.0969… → $1.10/ton
 *
 * Run: node scripts/test-crush-day-grouping.js   (needs jsdom: npm i --no-save jsdom)
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'quarry.html');

// ── Fixture ────────────────────────────────────────────────────────────────
const CRUSH = [
  // The reported day: three labor-only rows and one that ran the crusher.
  { id: 'c1', date: '2026-08-27', locationName: 'Homer City', employeeName: 'Shane Glatt',
    hourlyRate: 26, hours: 8.5 },
  { id: 'c2', date: '2026-08-27', locationName: 'Homer City', employeeName: 'Jacob Himes',
    hourlyRate: 26, hours: 8.5 },
  { id: 'c3', date: '2026-08-27', locationName: 'Homer City', employeeName: 'Nick Detwiler',
    hourlyRate: 26, hours: 8 },
  // The one row with a product on it — the crew's rows carry none, which is
  // what lets the Product filter cut a day in half.
  { id: 'c4', date: '2026-08-27', locationName: 'Homer City', employeeName: 'boringjamey',
    productName: '2A Modified', hourlyRate: 26, hours: 9, fuelGallons: 184, fuelCost: 0.0245,
    loadsToCrusher: 27, tonsPerLoad: 30, hoursCrushing: 6,
    comments: 'The Cone broke down first thing in the morning' },
  // Same DAY, other pit — must be its own group, never blended with Homer City.
  { id: 'c5', date: '2026-08-27', locationName: 'McGees Mills', employeeName: 'Steve Travis',
    hourlyRate: 26, hours: 10, loadsToCrusher: 10, tonsPerLoad: 20 },
  // A day that crushed nothing: cost, no tons → no cost per ton to show.
  { id: 'c6', date: '2026-08-20', locationName: 'Homer City', employeeName: 'Shane Glatt',
    hourlyRate: 26, hours: 8 },
  // An older single-row day, the shape that was already right.
  { id: 'c7', date: '2026-07-22', locationName: 'Homer City', employeeName: 'Steve Travis',
    hourlyRate: 26, hours: 36, fuelGallons: 286, fuelCost: 4.5,
    loadsToCrusher: 16, tonsPerLoad: 30, hoursCrushing: 4 },
];
const LISTS = {
  location: [{ id: 'l1', name: 'Homer City' }, { id: 'l2', name: 'McGees Mills' }],
  product:  [{ id: 'p1', name: '2A Modified' }],
  customer: [], equipment: [], tasks: [],
  employees: [{ id: 'e1', name: 'Shane Glatt', rate: 26 }],
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

// The numbers the day has to come to.
const HC_PAYROLL = 26 * 8.5 + 26 * 8.5 + 26 * 8 + 26 * 9;   // 884.00
const HC_FUEL    = 184 * 0.0245;                            //   4.508
const HC_COST    = HC_PAYROLL + HC_FUEL;                    // 888.508
const HC_TONS    = 27 * 30;                                 // 810
const HC_CPT     = HC_COST / HC_TONS;                       // 1.0969…

// ── Harness ────────────────────────────────────────────────────────────────
let failures = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function stubFetch(blobs, writes) {
  return async (url, init) => {
    const u = String(url);
    const m = /\/api\/data\/([^?]+)/.exec(u);
    const key = m ? decodeURIComponent(m[1]) : '';
    if (m && (!init || !init.method || init.method === 'GET')) {
      return {
        ok: true, status: 200,
        json: async () => ({ value: Object.prototype.hasOwnProperty.call(blobs, key) ? blobs[key] : null }),
        text: async () => '',
      };
    }
    if (m && init && init.method === 'PUT') {
      let body = null;
      try { body = JSON.parse(init.body).value; } catch { /* ignore */ }
      writes.push({ key, value: body });
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  };
}

function loadPage(blobs, writes) {
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
      win.fetch = stubFetch(blobs, writes);
      win.alert = (msg) => console.log('  [alert suppressed]', String(msg).slice(0, 120));
      win.print = () => {};
      const errs = [];
      win.__errors = errs;
      win.addEventListener('error', e => errs.push(e.message || String(e.error)));
    },
  });
}

async function main() {
  const writes = [];
  const dom = loadPage(BLOBS, writes);
  const win = dom.window;
  const doc = win.document;

  for (let i = 0; i < 80 && !/Rows/i.test(doc.getElementById('crushSummary')?.textContent || ''); i++) await sleep(25);
  win.switchTab('crushing');
  // Every fixture row is 2026, so the tab's default year filter keeps them all.
  win.setYearFilter('crushing', 'all');
  await sleep(60);

  const scriptErrors = (win.__errors || []).filter(Boolean);
  check('no uncaught script errors on load', scriptErrors.length ? scriptErrors.join(' | ') : 0, 0);

  const dayRows   = () => [...doc.querySelectorAll('#crushTbody tr.crush-day')];
  const entryRows = () => [...doc.querySelectorAll('#crushTbody tr:not(.crush-day)')];
  const dayFor = (key) => dayRows().find(tr => tr.dataset.dayKey === key);
  const cellOf = (tr, id) => {
    const el = tr.querySelector(`[id$="-${id}"]`);
    return el ? el.textContent.trim() : null;
  };

  // ── The grouping itself ──
  console.log('\n— Day groups —');
  check('every crushing row still renders', entryRows().length, CRUSH.length);
  // 8/27 Homer City, 8/27 McGees Mills, 8/20 Homer City, 7/22 Homer City.
  check('one group per date + pit', dayRows().length, 4);
  const hc = dayFor('2026-08-27|homer city');
  const mm = dayFor('2026-08-27|mcgees mills');
  check('the reported day has its own group', !!hc, true);
  check('the same date at the other pit is a separate group', !!mm, true);
  check('the group names its date and pit',
    hc.querySelector('.crush-day-title').textContent.trim()
      + hc.querySelector('.crush-day-meta').textContent.replace(/\s+/g, ' ').trim(),
    'Thu, Aug 27, 2026· Homer City · 4 entries');

  // ── The number the whole change is about ──
  console.log('\n— Blended cost per ton —');
  check('day cost is every row of the day', cellOf(hc, 'cost'), money(HC_COST));
  check('day tons are the day\'s tons',     cellOf(hc, 'tons'), '810');
  check('day payroll totals the crew',      cellOf(hc, 'payroll'), money(HC_PAYROLL));
  check('day fuel totals the day',          cellOf(hc, 'fuel'), money(HC_FUEL));
  check('day cost / ton is the blend, not one row\'s',
    hc.querySelector('.crush-day-cpt').textContent.trim(), money(HC_CPT));
  check('and that is $1.10, not the $0.29 a single row showed',
    hc.querySelector('.crush-day-cpt').textContent.trim(), '$1.10');

  // Every row of that day agrees with its day.
  const hcRowCpt = [...doc.querySelectorAll('#crushTbody tr')]
    .reduce((acc, tr) => {
      if (tr.classList.contains('crush-day')) { acc.on = tr.dataset.dayKey === '2026-08-27|homer city'; return acc; }
      if (acc.on) {
        const cpt = tr.querySelector('[id^="crush-costPerTon-"]');
        acc.vals.push(cpt ? cpt.textContent.trim() : null);
      }
      return acc;
    }, { on: false, vals: [] }).vals;
  check('the day\'s rows all carry the day\'s figure', hcRowCpt.join(','), Array(4).fill('$1.10').join(','));
  check('a labor-only row is no longer $0.00 against no tons', hcRowCpt[0], '$1.10');

  // ── A day with cost and no tons ──
  console.log('\n— A day that crushed nothing —');
  const empty = dayFor('2026-08-20|homer city');
  check('a day with no tons shows no cost per ton', empty.querySelector('.crush-day-cpt').textContent.trim(), '—');
  check('and says so rather than reading $0.00',
    /no cost per ton yet/.test(empty.querySelector('.crush-day-cpt').getAttribute('title') || ''), true);

  // ── A single-row day is unchanged ──
  console.log('\n— A day that was already one row —');
  const solo = dayFor('2026-07-22|homer city');
  // 26 × 36 + 286 × 4.5 = 936 + 1287 = 2223 over 16 × 30 = 480 tons.
  check('a one-row day still reads exactly as before',
    solo.querySelector('.crush-day-cpt').textContent.trim(), money(2223 / 480));

  // ── The grid still lines up with its header ──
  console.log('\n— Grid shape —');
  const headers = [...doc.querySelectorAll('.crush-table thead th')].length;
  check('an entry row still has a cell per header', entryRows()[0].children.length, headers);
  const span = (tr) => [...tr.children].reduce((n, td) => n + (Number(td.getAttribute('colspan')) || 1), 0);
  check('a day header spans the same columns', span(hc), headers);
  check('the day\'s totals sit under the columns they total',
    [...hc.children].findIndex(td => td.classList.contains('crush-day-cpt')) >= 0
      && [...doc.querySelectorAll('.crush-table thead th')][16].textContent.trim(), 'Cost / Ton');

  // ── A filter that hides part of a day ──
  // Only the tons-carrying row has a product, so filtering to it hides the
  // crew. The day is still the day: totalling what survived the filter would
  // be the $0.29 all over again.
  console.log('\n— A filter that hides part of a day —');
  win.eval("productFilters.crushing = new Set(['2A Modified']); renderCrush(true);");
  await sleep(30);
  const filtered = dayFor('2026-08-27|homer city');
  check('only the rows carrying that product are printed', entryRows().length, 1);
  check('and only their day opens a group', dayRows().length, 1);
  check('but still blends over the whole day',
    filtered.querySelector('.crush-day-cpt').textContent.trim(), '$1.10');
  check('and says how much of the day is on screen',
    filtered.querySelector('.crush-day-meta').textContent.replace(/\s+/g, ' ').trim(),
    '· Homer City · 4 entries · 1 shown');
  check('the day cost is the whole day\'s', cellOf(filtered, 'cost'), money(HC_COST));
  win.eval("productFilters.crushing = new Set(); renderCrush(true);");
  await sleep(30);
  check('clearing the filter brings the day\'s rows back',
    doc.querySelectorAll('#crushTbody tr:not(.crush-day)').length, CRUSH.length);
  check('and the day reads the same either way',
    dayFor('2026-08-27|homer city').querySelector('.crush-day-cpt').textContent.trim(), '$1.10');

  // ── Typing re-blends the day, without a re-render ──
  console.log('\n— Live update —');
  const idxOf = (id) => win.eval(`crushRows.findIndex(r => r.id === ${JSON.stringify(id)})`);
  const shane = idxOf('c1');
  const beforeInput = doc.querySelectorAll('#crushTbody input').length;
  win.updateCrushNumber(shane, 'hours', '10');           // 8.5 → 10 hrs, +$39
  const NEW_COST = HC_COST + 26 * 1.5;
  check('the day header re-totals on a keystroke',
    dayFor('2026-08-27|homer city').querySelector('.crush-day-cpt').textContent.trim(),
    money(NEW_COST / HC_TONS));
  check('the day\'s other rows follow it',
    doc.getElementById('crush-costPerTon-' + idxOf('c4')).textContent.trim(),
    money(NEW_COST / HC_TONS));
  check('the other pit\'s day is untouched',
    dayFor('2026-08-27|mcgees mills').querySelector('.crush-day-cpt').textContent.trim(),
    money((26 * 10) / 200));
  check('typing did not re-render the grid out from under the cursor',
    doc.querySelectorAll('#crushTbody input').length, beforeInput);

  // ── Re-dating a row moves it between days ──
  console.log('\n— Re-dating a row —');
  win.updateCrushCell(shane, 'date', '2026-08-20');
  await sleep(30);
  check('the row left its old day', dayFor('2026-08-27|homer city')
    .querySelector('.crush-day-meta').textContent.replace(/\s+/g, ' ').trim(), '· Homer City · 3 entries');
  check('and joined the new one', dayFor('2026-08-20|homer city')
    .querySelector('.crush-day-meta').textContent.replace(/\s+/g, ' ').trim(), '· Homer City · 2 entries');
  // Shane's row is at 10 hrs by now (the live-update check above), so the day
  // sheds 26 × 10 from the 927.51 it had climbed to — the same 667.51 either way.
  check('the day it left re-blends without it',
    dayFor('2026-08-27|homer city').querySelector('.crush-day-cpt').textContent.trim(),
    money((NEW_COST - 26 * 10) / HC_TONS));

  // ── The summary bar is unchanged: it blends the whole filtered set ──
  console.log('\n— Summary bar —');
  const summary = doc.getElementById('crushSummary').textContent;
  check('summary still totals every filtered row', /Rows\s*7/.test(summary.replace(/\s+/g, ' ')), true);

  const endErrors = (win.__errors || []).filter(Boolean);
  check('no uncaught script errors after interaction', endErrors.length ? endErrors.join(' | ') : 0, 0);

  await sleep(120);
  dom.window.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
