#!/usr/bin/env node
'use strict';
/**
 * api/lib/dust-metrics is a PORT of dust.html's arithmetic — the executive
 * report exists to agree with the Dust Control home dashboard, so a port that
 * drifts is worse than no port at all.
 *
 * Run: node scripts/test-dust-metrics-port.js
 *
 * The two now roll up THREE billing books rather than one, which is three times
 * the surface for them to disagree over — and the disagreements would all be
 * about money. So this does not compare the port against hand-written expected
 * numbers: it loads dust.html in jsdom over a fixture, reads the figures the
 * page actually paints out of the DOM, runs the SAME fixture through the module
 * in node, and asserts they match. Whatever either side says, they say it
 * together.
 *
 * The fixture exercises what is most likely to drift:
 *   - all three books, for one customer spelled three different ways,
 *   - a second customer billed ONLY off Other Billing (no tracking row at all),
 *   - a per-customer UB rate override against the division default,
 *   - an overnight tracking shift, and an overnight Other Billing haul,
 *   - a Billable EES row, a Non-Billable one, and a Billable one with no rate,
 *   - Other Billing rows measured in two different units,
 *   - a prior-year row in each book, which no year-to-date figure may count.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { dustMetrics } = require('../api/lib/dust-metrics');

const HTML_PATH = path.resolve(__dirname, '../dust.html');
const YEAR      = new Date().getFullYear();
const Y         = String(YEAR);
const PREV      = String(YEAR - 1);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
// Both sides are money or counts formatted for humans; compare on the number.
function same(label, a, b) {
  const na = Number(a), nb = Number(b);
  const ok = Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.005;
  assert(label, ok, `page=${a} lib=${b}`);
}

// ── Fixture ────────────────────────────────────────────────────────────────
// Dates are pinned to the current year so "year to date" means the same thing
// on both sides however long this test lives.
const TRACKING = [
  { id: 'd1', date: `${Y}-02-10`, company: 'CNX', state: 'PA',
    start_time: '06:00', end_time: '16:00',
    v1_rate: 130, v2_rate: 65, gallons_ub: 4000,
    inv_number: 'INV-1', inv_sent: `${Y}-02-12`, inv_received: `${Y}-03-01`, inv_status: 'paid' },
  // Overnight: 22:00 → 02:00 is four hours, not minus twenty.
  { id: 'd2', date: `${Y}-03-04`, company: 'CNX', state: 'WV',
    start_time: '22:00', end_time: '02:00',
    v1_rate: 130, v2_rate: 0, gallons_ub: 1500,
    inv_number: '', inv_sent: '', inv_received: '', inv_status: '' },
  // Prior year — must not reach any YTD figure on either side.
  // No customer on the row. Still money — both surfaces must bucket it rather
  // than drop it, or the customer table stops adding up to the revenue tile.
  { id: 'dX', date: `${Y}-03-20`, company: '', state: 'PA',
    start_time: '08:00', end_time: '10:00',
    v1_rate: 100, v2_rate: 0, gallons_ub: 0,
    inv_number: '', inv_sent: '', inv_received: '', inv_status: '' },
  { id: 'd0', date: `${PREV}-11-01`, company: 'CNX', state: 'PA',
    start_time: '06:00', end_time: '14:00',
    v1_rate: 130, v2_rate: 65, gallons_ub: 9999,
    inv_number: '', inv_sent: '', inv_received: '', inv_status: '' },
];

const OTHER_BILLING = [
  // Same customer as the tracking rows, spelled in upper case — the two must
  // rank as ONE customer, not two.
  { id: 'o1', date: `${Y}-04-02`, customer: 'CNX  ', destination: 'Bear Hollow', state: 'PA',
    driver: 'John Doe', truck_number: '4000', trailer_number: '',
    material: 'ClearFrac', gallons_bags: 4000, mu: 'GAL', price_per_unit: 0.42,
    trucking_hrs: 10, trucking_rate: 95, inv_number: '', comments: '' },
  // A second unit entirely — bags do not add to gallons.
  { id: 'o2', date: `${Y}-04-09`, customer: 'Antero', destination: 'Shale Run', state: 'WV',
    driver: 'Pat Reilly', truck_number: '4000', trailer_number: 'TR-9',
    material: 'Calcium Chloride', gallons_bags: 40, mu: 'BAG', price_per_unit: 12.5,
    trucking_hrs: 4, trucking_rate: 95, inv_number: 'INV-9', comments: '' },
  // Quantity but no price and no trucking rate: work at no price, not $0 of work.
  { id: 'o3', date: `${Y}-05-01`, customer: 'Antero', destination: 'Shale Run', state: 'WV',
    driver: 'Pat Reilly', truck_number: '4000', trailer_number: '',
    material: 'ClearFrac', gallons_bags: 500, mu: 'GAL', price_per_unit: '',
    trucking_hrs: '', trucking_rate: '', inv_number: '', comments: '' },
  // Same, on the other book — and in a state no tracking row visits, so the
  // Coverage figure has to pick it up from here.
  { id: 'oX', date: `${Y}-05-11`, customer: '', destination: '', state: 'OH',
    driver: 'Pat Reilly', truck_number: '4000', trailer_number: '',
    material: 'ClearFrac', gallons_bags: 100, mu: 'GAL', price_per_unit: 2,
    trucking_hrs: 1, trucking_rate: 50, inv_number: '', comments: '' },
  { id: 'o0', date: `${PREV}-12-20`, customer: 'CNX', destination: 'Bear Hollow', state: 'PA',
    driver: 'John Doe', truck_number: '4000', trailer_number: '',
    material: 'ClearFrac', gallons_bags: 9999, mu: 'GAL', price_per_unit: 1,
    trucking_hrs: 9, trucking_rate: 9, inv_number: '', comments: '' },
];

const EES = [
  // Same customer again, this time with a trailing space and lower case.
  { id: 'e1', actual_date: `${Y}-06-03`, customer: 'cnx', actual_hours: 8, rate: 75,
    billing: 'Billable', activity: 'Pre Loading', driver: 'John Doe' },
  { id: 'e2', actual_date: `${Y}-06-04`, customer: 'CNX', actual_hours: 5, rate: 75,
    billing: 'Non-Billable', activity: 'Washing', driver: 'John Doe' },
  // Billable but unpriced: real hours, no rate — $0, and counted as a gap.
  { id: 'e3', actual_date: `${Y}-06-05`, customer: 'CNX', actual_hours: 3, rate: '',
    billing: 'Billable', activity: 'Washing', driver: 'John Doe' },
  { id: 'e0', actual_date: `${PREV}-06-05`, customer: 'CNX', actual_hours: 40, rate: 75,
    billing: 'Billable', activity: 'Washing', driver: 'John Doe' },
];

const UB_RATE   = 1.5;
const COMPANIES = [
  { id: 'co-1', name: 'CNX',    ub_rate: 2, v1_rate: 130, v2_rate: 65,
    locations: [{ id: 1, name: 'Bear Hollow', state: 'PA' }], men: [] },
  // No ub_rate override — falls back to the division default.
  { id: 'co-2', name: 'Antero', ub_rate: null, v1_rate: 140, v2_rate: null,
    locations: [{ id: 2, name: 'Shale Run', state: 'WV' }], men: [] },
];

const DUST_CONFIG = {
  settings: { ub_rate: UB_RATE },
  lists: {
    equipment: [{ id: 1, name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 120 }],
    employees: ['John Doe', 'Pat Reilly'],
    materials: ['ClearFrac', 'Calcium Chloride'],
    states:    ['PA', 'WV'],
    mu:        ['GAL', 'BAG'],
    companies: COMPANIES,
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function stubFetch() {
  return async (url, init) => {
    const u  = String(url);
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (init && init.method && init.method !== 'GET') return ok({ ok: true });
    if (u.includes('/api/dust-config')) return ok(DUST_CONFIG);
    if (u.includes('/api/dust-rows'))   return ok({ dustRows: TRACKING });
    if (u.includes('/api/dust-audit'))  return ok({ events: [] });
    const m = /\/api\/data\/([^?]+)/.exec(u);
    if (m) {
      const key = decodeURIComponent(m[1]).split('?')[0];
      const v = key === 'dust_other_billing_rows' ? OTHER_BILLING
              : key === 'dust_ees_other_rows'     ? EES
              : null;
      return ok({ value: v, updated_at: `${Y}-08-04T00:00:00.000Z` });
    }
    return ok({});
  };
}

// The figures the page paints, read back out of the DOM by their labels.
function readStrip(doc) {
  const out = {};
  for (const item of doc.querySelectorAll('#home-content .home-metric-item')) {
    const label = item.querySelector('.home-metric-label')?.textContent.trim();
    const value = item.querySelector('.home-metric-value')?.textContent.trim();
    const sub   = item.querySelector('.home-metric-sub')?.textContent.trim();
    if (label && !(label in out)) out[label] = { value, sub };
  }
  return out;
}
const unmoney = v => Number(String(v == null ? '' : v).replace(/[$,]/g, ''));

async function main() {
  const dom = new JSDOM(fs.readFileSync(HTML_PATH, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/dust.html',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', companyCode: 'TEST', companyName: 'Test Co',
        allowedDivisions: ['dust'],
      }));
      win.fetch = stubFetch();
      win.alert = () => {}; win.confirm = () => true; win.print = () => {};
      win.__errors = [];
      win.addEventListener('error', e => win.__errors.push(e.message || String(e.error)));
    },
  });
  const win = dom.window, doc = win.document;

  // Wait for all three books to land, then force one final paint so we are
  // reading a dashboard built from every one of them.
  for (let i = 0; i < 200; i++) {
    let ready = false;
    try {
      ready = win.eval('Array.isArray(rows) && rows.length > 0 && obLoaded && eeLoaded');
    } catch (_) { /* still evaluating */ }
    if (ready) break;
    await sleep(25);
  }
  win.eval('renderHomeDashboard()');

  console.log('dust-metrics port — the module and dust.html over one fixture\n');

  console.log('[the page loaded all three books]');
  const errs = (win.__errors || []).filter(Boolean);
  assert('no uncaught script errors', errs.length === 0, errs.join(' | '));
  assert('Other Billing read', win.eval('obLoaded') === true);
  assert('EES Other read',     win.eval('eeLoaded') === true);
  assert('tracking rows read', win.eval('rows.length') === TRACKING.length);

  const strip = readStrip(doc);
  const m = dustMetrics({
    rows: TRACKING, obRows: OTHER_BILLING, eesRows: EES,
    companies: COMPANIES, ubRate: UB_RATE, today: new Date(),
  });

  console.log('\n[the KPI strip agrees with the module]');
  assert('the strip rendered', Object.keys(strip).length >= 6, JSON.stringify(Object.keys(strip)));
  same('YTD Revenue',        unmoney(strip['YTD Revenue']?.value),   m.revenueYtd);
  same('Gallons YTD',        unmoney(strip['Gallons YTD']?.value),   m.gallonsYtd);
  same('Active Customers',   unmoney(strip['Active Customers']?.value), m.activeCustomers);
  same('Avg Rev / Job',      unmoney(strip['Avg Rev / Job']?.value), m.avgRevenuePerJob);
  same('Service Hours YTD',  unmoney(strip['Service Hours YTD']?.value), m.hoursYtd);
  same('Jobs This Month',    unmoney(strip['Jobs This Month']?.value), m.jobsThisMonth);

  console.log('\n[and so does the composition it reports]');
  const page = {
    tracking: win.eval('(function(){var c=rows.map(r=>({...r,...calc(r)})).filter(r=>(r.date||"").startsWith("' + Y + '"));return c.reduce((s,r)=>s+r.invTotal,0)})()'),
    other:    win.eval('obRows.map(r=>obCalc(r)).filter((_,i)=>(obRows[i].date||"").startsWith("' + Y + '")).reduce((s,c)=>s+c.total,0)'),
    ees:      win.eval('eeRows.filter(r=>(r.actual_date||"").startsWith("' + Y + '")).map(r=>eeCalc(r)).reduce((s,c)=>s+c.total,0)'),
  };
  same('tracking revenue',      page.tracking, m.revenue.tracking);
  same('Other Billing revenue', page.other,    m.revenue.other);
  same('EES Other revenue',     page.ees,      m.revenue.ees);
  same('and they sum to the headline', page.tracking + page.other + page.ees, m.revenueYtd);

  console.log('\n[the by-book table on the page matches the module\'s books]');
  const bookRows = [...doc.querySelectorAll('#home-content .dash-books tbody tr')];
  assert('one row per book', bookRows.length === m.books.length, String(bookRows.length));
  m.books.forEach((b, i) => {
    const cells = bookRows[i] ? [...bookRows[i].children].map(td => td.textContent.trim()) : [];
    assert(`book ${i + 1} is ${b.label}`, cells[0] === b.label, cells[0]);
    same(`  ${b.label} lines`,   unmoney(cells[1]), b.lines);
    same(`  ${b.label} revenue`, unmoney(cells[2]), b.revenue);
    // The volume and hours cells are STRINGS carrying their own units, written
    // by two formatters that cannot share code. Comparing the numbers behind
    // them would miss exactly the drift that matters: "4,501 GAL" and
    // "4,500.5 GAL" are the same number and two different answers.
    assert(`  ${b.label} volume string matches`,
      (cells[4] || '') === (b.volume || '—'),
      `page="${cells[4]}" lib="${b.volume}"`);
    assert(`  ${b.label} hours string matches`,
      (cells[5] || '') === (b.hoursText || '—'),
      `page="${cells[5]}" lib="${b.hoursText}"`);
    assert(`  ${b.label} states its invoicing regime identically`,
      (cells[6] || '') === b.ar, `page="${cells[6]}" lib="${b.ar}"`);
  });

  console.log('\n[the customer table agrees, across all three books]');
  const custRows = [...doc.querySelectorAll('#home-content .proj-table')]
    // The by-book table shares the class; the customer one is the other.
    .filter(t => !t.classList.contains('dash-books'))
    .flatMap(t => [...t.querySelectorAll('tbody tr')]);
  assert('one row per customer', custRows.length === m.customers.length,
    `page=${custRows.length} lib=${m.customers.length}`);
  m.customers.forEach((c, i) => {
    const cells = custRows[i] ? [...custRows[i].children].map(td => td.textContent.trim()) : [];
    assert(`customer ${i + 1} is ${c.name}`, cells[0]?.startsWith(c.name), cells[0]);
    same(`  ${c.name} visits`,    unmoney(cells[1]), c.visits);
    same(`  ${c.name} gallons`,   unmoney(cells[2]), c.gallons);
    same(`  ${c.name} hours`,     unmoney(cells[3]), c.hours);
    same(`  ${c.name} revenue`,   unmoney(cells[4]), c.revenue);
    same(`  ${c.name} untracked`, unmoney(cells[9]), c.untracked);
  });

  console.log('\n[the things that must NOT be folded stayed unfolded]');
  assert('one customer, not three, despite three spellings',
    m.customers.filter(c => /cnx/i.test(c.name)).length === 1,
    m.customers.map(c => c.name).join(' | '));
  assert('a customer billed only off Other Billing still appears',
    m.customers.some(c => c.name === 'Antero' && c.visits === 0 && c.revenueOther > 0));
  // Derived from the fixture rather than hard-coded. Pinning these as literals
  // meant every added row silently made the test wrong about what it was
  // asserting — twice — while the page-vs-module comparisons above stayed green.
  const thisYear = r => String(r.date || r.actual_date || '').startsWith(Y);
  const trackYtd = TRACKING.filter(thisYear);
  const obYtdFx  = OTHER_BILLING.filter(thisYear);
  const eesYtdFx = EES.filter(thisYear);
  const fxHours = r => {
    const mins = t => { const x = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return x ? +x[1] * 60 + +x[2] : null; };
    const a = mins(r.start_time), b = mins(r.end_time);
    if (a == null || b == null) return 0;
    return ((b - a + 1440) % 1440) / 60;
  };
  const expGallons = trackYtd.reduce((n, r) => n + (Number(r.gallons_ub) || 0), 0);
  const expField   = trackYtd.reduce((n, r) => n + fxHours(r), 0);
  const expTruck   = obYtdFx.reduce((n, r) => n + (Number(r.trucking_hrs) || 0), 0);
  const expEesBill = eesYtdFx.filter(r => /^billable$/i.test(String(r.billing).trim()))
                             .reduce((n, r) => n + (Number(r.actual_hours) || 0), 0);
  const expEesNon  = eesYtdFx.filter(r => !/^billable$/i.test(String(r.billing).trim()))
                             .reduce((n, r) => n + (Number(r.actual_hours) || 0), 0);
  const expUnits   = (() => {
    const by = new Map();
    for (const r of obYtdFx) {
      const q = Number(r.gallons_bags) || 0;
      if (!q) continue;
      const u = String(r.mu || '').trim() || '(no unit)';
      by.set(u, (by.get(u) || 0) + q);
    }
    return [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([u, q]) => `${q} ${u}`).join(' · ');
  })();

  assert('gallons are UB only — bags never joined them',
    Math.abs(m.gallonsYtd - expGallons) < 0.005, `${m.gallonsYtd} vs ${expGallons}`);
  assert('delivered quantity is reported per unit, not totalled',
    m.deliveredQuantity.map(q => `${q.quantity} ${q.unit}`).join(' · ') === expUnits,
    `${JSON.stringify(m.deliveredQuantity)} vs ${expUnits}`);
  assert('field hours exclude trucking and EES hours',
    Math.abs(m.hoursYtd - expField) < 0.005, `${m.hoursYtd} vs ${expField}`);
  assert('trucking hours are their own figure, and a different number',
    Math.abs(m.otherHoursYtd - expTruck) < 0.005 && expTruck !== expField,
    `${m.otherHoursYtd} vs ${expTruck} (field ${expField})`);
  assert('EES hours split billable from non-billable',
    Math.abs(m.eesHoursYtd.billable - expEesBill) < 0.005
    && Math.abs(m.eesHoursYtd.nonBillable - expEesNon) < 0.005,
    JSON.stringify(m.eesHoursYtd));
  assert('pad visits count tracking rows only',
    m.jobsYtd === trackYtd.length && m.jobsYtd !== trackYtd.length + obYtdFx.length,
    `${m.jobsYtd} vs ${trackYtd.length} tracking rows`);
  assert('Avg Rev / Job divides tracking revenue by pad visits',
    Math.abs(m.avgRevenuePerJob - m.revenue.tracking / trackYtd.length) < 0.005,
    `${m.avgRevenuePerJob} vs ${m.revenue.tracking / trackYtd.length}`);
  assert('a Non-Billable EES row is worth nothing',
    m.revenue.ees === 600, String(m.revenue.ees));
  assert('unpriced work is counted, not billed',
    m.unpriced.count === 2 && m.unpriced.ees === 1 && m.unpriced.other === 1,
    JSON.stringify(m.unpriced));
  // 11 rows across the fixture, 3 of them in the prior year. Every book must
  // drop exactly its own one — and the gallons and revenue assertions above
  // would also move if any prior-year row leaked into a YTD figure.
  const TOTAL_ROWS   = TRACKING.length + OTHER_BILLING.length + EES.length;
  const PRIOR_ROWS   = [...TRACKING, ...OTHER_BILLING, ...EES]
    .filter(r => String(r.date || r.actual_date || '').startsWith(PREV)).length;
  assert('prior-year rows reach no YTD figure',
    m.books.reduce((n, b) => n + b.lines, 0) === TOTAL_ROWS - PRIOR_ROWS
    && PRIOR_ROWS === 3,
    `lines=${JSON.stringify(m.books.map(b => b.lines))} of ${TOTAL_ROWS} rows, ${PRIOR_ROWS} prior-year`);

  console.log('\n[a row with no customer is bucketed, not dropped]');
  {
    const bucket = m.customers.find(c => /No customer/.test(c.name));
    assert('the module has a no-customer bucket', !!bucket,
      m.customers.map(c => c.name).join(' | '));
    const pageNames = custRows.map(tr => tr.children[0].textContent.trim());
    assert('and so does the page', pageNames.some(n => /No customer/.test(n)),
      pageNames.join(' | '));
    assert('it carries money from both books',
      !!bucket && bucket.revenueTracking > 0 && bucket.revenueOther > 0,
      JSON.stringify(bucket && { t: bucket.revenueTracking, o: bucket.revenueOther }));
    // The whole reason to bucket rather than drop: the footer has to add up.
    const custTotal = m.customers.reduce((n, c) => n + c.revenue, 0);
    assert('so the customer table totals the division\'s revenue',
      Math.abs(custTotal - m.revenueYtd) < 0.005, `${custTotal} vs ${m.revenueYtd}`);
  }

  console.log('\n[Coverage counts states from both books that have one]');
  {
    const pageStates = [...doc.querySelectorAll('#home-content .dash-state-badge')]
      .map(b => b.textContent.trim()).sort();
    assert('the page and the module list the same states',
      pageStates.join(',') === m.states.join(','),
      `page=${pageStates.join(',')} lib=${m.states.join(',')}`);
    assert('including one only Other Billing visited',
      m.states.includes('OH'), m.states.join(','));
  }

  console.log('\n[the invoice buckets stayed on the one book that has invoices]');
  const trackingEra = m.invoices.overdue.count + m.invoices.outstanding.count + m.invoices.paid.count;
  assert('every aged invoice is a tracking row', trackingEra <= TRACKING.length, String(trackingEra));
  assert('Other Billing and EES money is reported as untracked instead',
    Math.abs(m.invoices.untracked.amount - (m.revenue.other + m.revenue.ees)) < 0.005,
    `${m.invoices.untracked.amount} vs ${m.revenue.other + m.revenue.ees}`);
  assert('and it is broken out by book',
    Math.abs(m.invoices.untracked.byBook.other - m.revenue.other) < 0.005
    && Math.abs(m.invoices.untracked.byBook.ees - m.revenue.ees) < 0.005);
  assert('per customer, the four money columns reconcile to revenue',
    m.customers.every(c =>
      Math.abs((c.overdue + c.unpaid + c.paidAmt + c.untracked) - c.revenue) < 0.005),
    JSON.stringify(m.customers.map(c => ({
      n: c.name, r: c.revenue, sum: c.overdue + c.unpaid + c.paidAmt + c.untracked }))));

  console.log(`\n${passed} passed, ${failed} failed`);
  dom.window.close();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
