'use strict';

/**
 * Executive report — "Generate Report (PDF)" section picker.
 *
 * The purple button no longer prints straight away: it opens a checklist of
 * every section the report rendered, all of them checked, so a division that
 * isn't wanted in the printout can be dropped before the browser's print
 * dialog opens. This test loads executive.html in jsdom against a stubbed
 * /api/executive/report, works the picker, and asserts the two things that
 * decide what actually lands in the PDF:
 *
 *   · the default is the whole report — every box checked, every section in
 *   · the sections left unchecked are the ones marked .print-omit, and the
 *     scope classes are gone again once the print dialog closes
 *
 * The hiding itself is CSS, which jsdom does not apply, so the @media print
 * rules that consume those classes are checked as text.
 *
 * Run: node scripts/test-executive-pdf-sections.js   (needs jsdom: npm i --no-save jsdom)
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', 'executive.html');
const HTML      = fs.readFileSync(HTML_PATH, 'utf8');

// ── Fixture ────────────────────────────────────────────────────────────────
// Eight sections, which is what the report renders when every division has
// data: three job-running portfolios, then the service divisions, then Payroll.
const portfolio = (key, name, accent) => ({
  key, name, accent, status: 'On Track', statusKind: 'green',
  metrics: [{ label: 'Active Projects', value: '10', tone: 'blue', sub: '8 in progress' }],
  rows: [{
    name: `${name} Job A`, jobNumber: 'J-1', client: 'Acme', pm: 'Pat', status: 'In Progress',
    progressPct: 40, progressTone: 'green', contract: 100000, bid: 90000, actual: 40000,
    variance: 50000, projected: 88000, projectedTone: 'green', profit: 12000, profitPct: 12,
    actProfit: 60000, actProfitPct: 60, pinned: true, atRisk: 0, onHold: 0, offBid: 0, daysLeft: null,
  }],
  total: 25, pinned: 6, recent: 0, hidden: 19,
});

const REPORT = {
  ok: true,
  generatedAt: '2026-08-24T12:00:00Z',
  portfolios: [
    portfolio('turf',   'Turf Management', '#22c55e'),
    portfolio('paving', 'Paving',          '#f97316'),
    portfolio('kiewit', 'Kiewit Pinetree', '#60a5fa'),
  ],
  inventory: [{ rubber_type: '5050-R', in_stock: 15, produced: 100, used: 85, lbs_total: 3000 }],
  quarry: {
    key: 'quarry', name: 'Quarry', accent: '#a78bfa', status: 'On Track', statusKind: 'green',
    year: 2026, entryCount: 12, metrics: [{ label: 'Sales', value: '$1,000', tone: 'green', sub: '' }],
    rows: [{ name: 'Pit 1', sales: 1000, cost: 400, margin: 600, marginPct: 60, tonsSold: 200,
             costPerTonSold: 2, costPerTon: 1.5, tonsCrushed: 250, lossPct: 5, finalScreenTons: 240, hours: 30 }],
  },
  dust: {
    key: 'dust', name: 'Dust Control', accent: '#fbbf24', status: 'On Track', statusKind: 'green',
    year: 2026, metrics: [{ label: 'Revenue', value: '$500', tone: 'green', sub: '' }],
    books: [{ label: 'Dust Control Tracking', available: true, lines: 5, revenue: 500,
              volume: '1,000 gal', hoursText: '10', ar: 'Invoiced' }],
    rows: [{ name: 'Customer A', visits: 3, gallons: 1000, hours: 10, revenue: 500,
             revenueTracking: 500, avgPerVisit: 167, overdue: 0, unpaid: 0, paid: 500, untracked: 0 }],
  },
  trucking: {
    key: 'trucking', name: 'Trucking', accent: '#ef4444', status: 'On Track', statusKind: 'green',
    year: 2026, entryCount: 4, metrics: [{ label: 'Revenue', value: '$800', tone: 'green', sub: '' }],
    rows: [{ name: 'Customer B', entries: 4, hours: 20, revenue: 800, avgHaulFee: 40,
             uninvoiced: 0, awaiting: 0, paid: 800 }],
  },
  intercompany: {
    key: 'intercompany', name: 'Intercompany Billing', accent: '#34d399', status: 'On Track',
    statusKind: 'green', year: 2026, entryCount: 2, duplicates: 0,
    metrics: [{ label: 'Total IC', value: '$300', tone: 'green', sub: '' }],
    rows: [{ name: 'Force Corp', hours: 5, truckIc: 100, dustIc: 200, ic: 300, revenue: 400,
             notInvoiced: 0, awaitingPayment: 0, paid: 300 }],
  },
  payroll: {
    key: 'payroll', name: 'Payroll', accent: '#666', status: 'Open', statusKind: 'amber',
    periodStart: '2026-08-03', periodEnd: '2026-08-16',
    metrics: [{ label: 'Total Hours', value: '80.00', tone: 'plain', sub: '' }],
    rows: [{ name: 'Jane Doe', workHours: 70, travelToSite: 5, travelToShop: 5, travelHours: 10,
             totalHours: 80, pwHours: 0, stdHours: 80, pendingHours: 0, approvedHours: 80,
             pendingOff: 0, approvedOff: 0, hasPending: false }],
  },
};

const SECTION_NAMES = [
  'Turf Management', 'Paving', 'Kiewit Pinetree', 'Quarry',
  'Dust Control', 'Trucking', 'Intercompany Billing', 'Payroll',
];

// ── Harness ────────────────────────────────────────────────────────────────
let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}
function checkIncludes(label, haystack, needle) {
  const ok = String(haystack).includes(needle);
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `: missing ${JSON.stringify(needle)}`}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// `report: null` holds the fetch open, so the page stays on its loading state.
function loadPage(report) {
  return new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'https://example.test/executive.html',
    pretendToBeVisual: true,
    resources: undefined,          // report-email.js is not needed for the picker
    beforeParse(win) {
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', isPlatformAdmin: true, divisionRoles: { executive: 'admin' },
      }));
      win.fetch = async url => {
        if (!String(url).includes('/api/executive/report')) throw new Error('unexpected fetch ' + url);
        if (!report) return new Promise(() => {});   // never resolves
        return { ok: true, status: 200, json: async () => report, text: async () => '' };
      };
      win.__alerts = [];
      win.alert = msg => win.__alerts.push(String(msg));
      // jsdom implements no matchMedia; the print-scope cleanup listens on it
      // for the browsers that don't fire afterprint.
      win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      // window.print() would block; record the call and what the DOM looked
      // like at the moment it fired — that is what the browser would render.
      win.__prints = [];
      win.print = () => win.__prints.push({
        bodyClass:  win.document.body.className,
        omitted:    [...win.document.querySelectorAll('.print-omit')].map(e => e.dataset.sectionName),
        first:      [...win.document.querySelectorAll('.print-first')].map(e => e.dataset.sectionName),
        pickerOpen: Boolean(win.document.getElementById('pdfPicker')),
      });
      const errs = [];
      win.__errors = errs;
      win.addEventListener('error', e => errs.push(e.message || String(e.error)));
    },
  });
}

const openPicker = doc => {
  doc.querySelector('.action-btns .btn.primary').click();
  return doc.getElementById('pdfPicker');
};
const boxesOf = doc => [...doc.querySelectorAll('#pdfPicker .picker-list input')];
// jsdom does not fire change from a programmatic .checked assignment.
const toggle = box => { box.checked = !box.checked; box.dispatchEvent(new box.ownerDocument.defaultView.Event('change')); };

async function main() {
  const dom = loadPage(REPORT);
  const win = dom.window;
  const doc = win.document;

  for (let i = 0; i < 80 && !doc.querySelector('#reportBody .section'); i++) await sleep(25);

  console.log('\n[the report renders]');
  check('no uncaught script errors on load', (win.__errors || []).filter(Boolean), []);
  const sections = [...doc.querySelectorAll('#reportBody .section')];
  check('every section is named on the element', sections.map(s => s.dataset.sectionName), SECTION_NAMES);

  // ── The picker itself ──
  console.log('\n[the button opens a section picker, everything included]');
  check('the button opens the picker rather than printing',
    HTML.includes('class="btn primary" onclick="openReportPicker()"'), true);
  const picker = openPicker(doc);
  check('the picker opens', Boolean(picker), true);
  check('nothing has printed yet', win.__prints.length, 0);

  const rows = [...doc.querySelectorAll('#pdfPicker .picker-row')];
  check('one row per section', rows.map(r => r.querySelector('.picker-name').textContent.trim()), SECTION_NAMES);
  check('every box is checked by default', boxesOf(doc).every(b => b.checked), true);
  check('the count says so', doc.getElementById('pickerCount').textContent, '8 of 8 sections included');
  checkIncludes('the row carries the section\'s own sub-line',
    rows[0].querySelector('.picker-meta').textContent, '6 pinned of 25 projects');
  check('a second click does not stack a second picker',
    (openPicker(doc), doc.querySelectorAll('#pdfPicker').length), 1);

  // ── Unchecking drops exactly those sections ──
  console.log('\n[unchecking a section drops it from the printout]');
  const boxes = boxesOf(doc);
  toggle(boxes[1]);   // Paving
  toggle(boxes[4]);   // Dust Control
  check('the count follows', doc.getElementById('pickerCount').textContent, '6 of 8 sections included');
  check('the unchecked row reads as off', rows[1].classList.contains('off'), true);
  check('a checked row does not', rows[0].classList.contains('off'), false);

  doc.getElementById('pickerGo').click();
  check('printed once', win.__prints.length, 1);
  const run = win.__prints[0];
  check('the picker is gone before the print dialog opens', run.pickerOpen, false);
  checkIncludes('the body is scoped for print', run.bodyClass, 'printing-picked');
  check('exactly the unchecked sections are omitted', run.omitted, ['Paving', 'Dust Control']);
  check('the section that leads the printout clears its forced page break',
    run.first, ['Turf Management']);

  console.log('\n[the scope does not survive the print dialog]');
  win.dispatchEvent(new win.Event('afterprint'));
  check('body class cleared', doc.body.className.trim(), '');
  check('.print-omit cleared', doc.querySelectorAll('.print-omit').length, 0);
  check('.print-first cleared', doc.querySelectorAll('.print-first').length, 0);

  // ── The default path is untouched ──
  console.log('\n[the whole report still prints as the whole report]');
  openPicker(doc);
  doc.getElementById('pickerGo').click();
  const full = win.__prints[1];
  check('printed again', win.__prints.length, 2);
  check('no scoping when every section is included',
    [full.bodyClass.trim(), full.omitted.length, full.first.length], ['', 0, 0]);

  // ── Select all / clear all ──
  console.log('\n[select all / clear all]');
  openPicker(doc);
  doc.getElementById('pickerNone').click();
  check('clear all unchecks everything', boxesOf(doc).some(b => b.checked), false);
  check('and disables Generate', doc.getElementById('pickerGo').disabled, true);
  check('the count reads zero', doc.getElementById('pickerCount').textContent, '0 of 8 sections included');
  doc.getElementById('pickerGo').click();
  check('an empty report cannot be generated', win.__prints.length, 2);
  doc.getElementById('pickerAll').click();
  check('select all re-checks everything', boxesOf(doc).every(b => b.checked), true);
  check('and re-enables Generate', doc.getElementById('pickerGo').disabled, false);

  // ── Backing out ──
  console.log('\n[backing out]');
  doc.getElementById('pickerCancel').click();
  check('cancel closes the picker', doc.getElementById('pdfPicker'), null);
  check('and prints nothing', win.__prints.length, 2);
  openPicker(doc);
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  check('escape closes the picker', doc.getElementById('pdfPicker'), null);
  openPicker(doc);
  doc.getElementById('pickerClose').click();
  check('the × closes the picker', doc.getElementById('pdfPicker'), null);

  console.log('\n[the choice starts over each time]');
  openPicker(doc);
  const reopened = boxesOf(doc);
  toggle(reopened[0]);
  doc.getElementById('pickerCancel').click();
  openPicker(doc);
  check('a reopened picker is back to the whole report',
    boxesOf(doc).every(b => b.checked), true);
  doc.getElementById('pickerCancel').click();

  // ── The per-division button is untouched ──
  console.log('\n[the per-division PDF buttons still scope to one section]');
  doc.querySelector('#portfolio-paving .section-action-btn').click();
  checkIncludes('a division PDF still uses its own print scope',
    win.__prints[2].bodyClass, 'printing-scoped');
  win.dispatchEvent(new win.Event('afterprint'));

  // ── The CSS that does the hiding ──
  console.log('\n[the print rules consume those classes]');
  checkIncludes('unchecked sections are hidden in print', HTML,
    'body.printing-picked #reportBody > .section.print-omit');
  checkIncludes('nested division sections too', HTML,
    'body.printing-picked #portfolioSections > .section.print-omit');
  checkIncludes('the leading section drops its page break', HTML, 'body.printing-picked .print-first');
  checkIncludes('and the picker itself never prints', HTML, '.picker-backdrop { display: none !important; }');

  // ── A report that has not loaded has nothing to pick from ──
  console.log('\n[a report that has not loaded yet]');
  const pending = loadPage(null);
  await sleep(120);
  pending.window.document.querySelector('.action-btns .btn.primary').click();
  check('the button says so instead of printing a blank page',
    pending.window.__alerts, ['The report is still loading.']);
  check('and nothing printed', pending.window.__prints.length, 0);
  pending.window.close();

  dom.window.close();
  console.log(failures ? `\n❌ ${failures} assertion(s) failed` : '\n✅ all assertions passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
