#!/usr/bin/env node
'use strict';
/**
 * api/lib/dust-cost-metrics is a PORT of dust.html's Profit Margin panel.
 *
 * Run: node scripts/test-dust-cost-port.js
 *
 * Mathis answers "what is our margin on a gallon of UB" from the module. The
 * dust foreman reads the answer off the page. If those two ever disagree the
 * argument is about money, and both sides will sound certain — so this does
 * not compare the module against hand-written expected numbers. It loads
 * dust.html in jsdom over a fixture, reads the figures the page actually
 * paints, runs the SAME fixture through the module in node, and asserts they
 * match. Whatever either says, they say it together.
 *
 * The fixture exercises what is most likely to drift:
 *   - a three-part batch (base, soap, water) at different rates,
 *   - a mix ratio, so cost-to-make is the diluted figure and not the
 *     concentrate one — the mistake that reports a loss on a good product,
 *   - per-gallon rounding to the cent BEFORE profit is taken, which is what
 *     makes the figures reconcile with a hand calculation,
 *   - a per-customer UB rate override against the division default,
 *   - an overnight shift, whose hours are four and not minus twenty,
 *   - a prior-year row, which the year filter must exclude from the charge,
 *   - and all three charge bases: invoice, UB and custom.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { dustProductMargin } = require('../api/lib/dust-cost-metrics');

const HTML_PATH = path.resolve(__dirname, '../dust.html');
const YEAR = new Date().getFullYear();
const Y    = String(YEAR);
const PREV = String(YEAR - 1);

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function same(label, pageVal, libVal) {
  const a = Number(pageVal), b = Number(libVal);
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
  assert(label, ok, `page=${pageVal} lib=${libVal}`);
}
/** For the two figures the page prints to one decimal. */
function samePct(label, pageVal, libVal) {
  const a = Number(pageVal);
  const b = Number(Number(libVal).toFixed(1));
  const ok = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.005;
  assert(label, ok, `page=${pageVal} lib=${libVal} (page prints one decimal)`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const unmoney = v => Number(String(v == null ? '' : v).replace(/[$,%]/g, '').trim());

// ── Fixture ────────────────────────────────────────────────────────────────
const UB_RATE   = 0.40;
const COMPANIES = [
  { name: 'CNX',        ub_rate: 0.55 },   // override
  { name: 'Range Res',  ub_rate: null },   // falls back to the division rate
];

const TRACKING = [
  { id: 'd1', date: `${Y}-02-10`, company: 'CNX', state: 'PA',
    start_time: '06:00', end_time: '16:00',
    v1_rate: 130, v2_rate: 65, gallons_ub: 4000,
    inv_sent: `${Y}-02-12`, inv_received: `${Y}-03-01`, inv_status: 'paid' },
  // Overnight: 22:00 -> 02:00 is four hours.
  { id: 'd2', date: `${Y}-03-04`, company: 'CNX', state: 'WV',
    start_time: '22:00', end_time: '02:00',
    v1_rate: 130, v2_rate: 0, gallons_ub: 1500,
    inv_sent: null, inv_received: null, inv_status: '' },
  { id: 'd3', date: `${Y}-05-19`, company: 'Range Res', state: 'PA',
    start_time: '07:00', end_time: '15:30',
    v1_rate: 145, v2_rate: 70, gallons_ub: 3200,
    inv_sent: `${Y}-05-21`, inv_received: null, inv_status: '' },
  // Prior year — must not reach a year-filtered charge.
  { id: 'd4', date: `${PREV}-09-02`, company: 'CNX', state: 'PA',
    start_time: '06:00', end_time: '18:00',
    v1_rate: 999, v2_rate: 999, gallons_ub: 9999,
    inv_sent: `${PREV}-09-04`, inv_received: `${PREV}-10-01`, inv_status: 'paid' },
];

// A batch that makes 1,000 gal of concentrate, sprayed at 1:8.
const PM_FIELDS = ['base_gal', 'base_rate', 'soap_gal', 'soap_rate',
                  'water_gal', 'water_rate', 'mix_parts', 'charge'];
const PM_EMPTY = PM_FIELDS.reduce((o, f) => (o[f] = null, o), { charge_basis: 'invoice' });

const PM_BASE = {
  base_gal: 600,  base_rate: 1.85,
  soap_gal: 40,   soap_rate: 12.50,
  water_gal: 360, water_rate: 0.02,
  mix_parts: 8,
  charge: 3.75,
};

const DUST_CONFIG = pm => ({
  settings: { ub_rate: UB_RATE, profit_margin: pm },
  lists: {
    equipment: [{ id: 1, name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 120 }],
    employees: ['John Doe'],
    materials: ['ClearFrac'],
    states: ['PA', 'WV'],
    mu: ['GAL'],
    companies: COMPANIES,
  },
});

function stubFetch(pm) {
  return async (url, init) => {
    const u = String(url);
    const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (init && init.method && init.method !== 'GET') return ok({ ok: true });
    if (u.includes('/api/dust-config')) return ok(DUST_CONFIG(pm));
    if (u.includes('/api/dust-rows'))   return ok({ dustRows: TRACKING });
    if (u.includes('/api/dust-audit'))  return ok({ events: [] });
    if (/\/api\/data\//.test(u))        return ok({ value: null, updated_at: null });
    return ok({});
  };
}

/** The Profit Margin panel, read back out of the DOM by element id. */
function readPanel(doc) {
  const txt = id => (doc.getElementById(id) || {}).textContent;
  return {
    totalCost:   txt('pm-total-cost'),
    totalGal:    txt('pm-total-gal'),
    concPerGal:  txt('pm-conc-per-gal'),
    costToMake:  txt('pm-cost-to-make'),
    charge:      txt('pm-charge-val'),
    profit:      txt('pm-profit-val'),
    margin:      txt('pm-margin-val'),
    markup:      txt('pm-markup-val'),
  };
}

async function boot(pm) {
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
      win.fetch = stubFetch(pm);
      win.alert = () => {}; win.confirm = () => true; win.print = () => {};
      win.__errors = [];
      win.addEventListener('error', e => win.__errors.push(e.message || String(e.error)));
    },
  });
  const win = dom.window;
  for (let i = 0; i < 200; i++) {
    let ready = false;
    try { ready = win.eval('Array.isArray(rows) && rows.length > 0'); } catch { /* still loading */ }
    if (ready) break;
    await sleep(25);
  }
  return { dom, win, doc: win.document };
}

/**
 * Drive the panel for one basis and one year, then read it. The page's own
 * year filter is `_anYear`; setting it and re-rendering is what the user does
 * by picking a year, and it is the only way the charge narrows to one.
 */
async function paint(win, doc, pm, year) {
  win.eval(`Object.assign(profitMargin, ${JSON.stringify(pm)});`);
  win.eval(`_anYear = ${year ? JSON.stringify(String(year)) : 'null'};`);
  win.eval('renderProfitMargin()');
  await sleep(0);
  return readPanel(doc);
}

async function main() {
  console.log('dust-cost-metrics port — the module and dust.html over one fixture\n');

  const { win, doc } = await boot(PM_BASE);

  console.log('[the page loaded]');
  const errs = (win.__errors || []).filter(Boolean);
  assert('no uncaught script errors', errs.length === 0, errs.join(' | '));
  assert('tracking rows read', win.eval('rows.length') === TRACKING.length);
  assert('the Profit Margin panel exists', !!doc.getElementById('pm-margin-val'));

  for (const basis of ['invoice', 'ub', 'custom']) {
    const pm = { ...PM_BASE, charge_basis: basis };
    const page = await paint(win, doc, pm, Y);
    const lib  = dustProductMargin({
      pm, rows: TRACKING, ubRate: UB_RATE, companies: COMPANIES, year: Y,
    });

    console.log(`\n[charge basis: ${basis}]`);
    same('batch total cost',      unmoney(page.totalCost),  lib.batch.totalCost);
    same('  gallons in the batch', unmoney(page.totalGal),  lib.batch.totalGallons);
    same('concentrate per gallon', unmoney(page.concPerGal), lib.concentratePerGal);
    same('cost to make a sprayed gallon', unmoney(page.costToMake), lib.costToMakePerGal);
    same('the charge per gallon', unmoney(page.charge),     lib.chargePerGal);
    same('profit per gallon',     unmoney(page.profit),     lib.profitPerGal);
    samePct('margin %',           unmoney(page.margin),     lib.marginPct);
    samePct('markup %',           unmoney(page.markup),     lib.markupPct);
    assert('  and it has enough entered to be an answer', lib.ready === true);
  }

  console.log('\n[the year filter narrows the charge, on both sides]');
  {
    const pm = { ...PM_BASE, charge_basis: 'invoice' };
    const thisYear = dustProductMargin({ pm, rows: TRACKING, ubRate: UB_RATE, companies: COMPANIES, year: Y });
    const allYears = dustProductMargin({ pm, rows: TRACKING, ubRate: UB_RATE, companies: COMPANIES, year: null });
    assert('a prior-year row is excluded when a year is picked',
      thisYear.tracking.jobs === 3 && allYears.tracking.jobs === 4,
      `${thisYear.tracking.jobs} vs ${allYears.tracking.jobs}`);
    assert('  and it moves the charge',
      Math.abs(thisYear.chargePerGal - allYears.chargePerGal) > 0.005,
      'the fixture prior-year row is priced far off the rest on purpose');

    const page = await paint(win, doc, pm, null);
    same('unfiltered, the page agrees too', unmoney(page.charge), allYears.chargePerGal);
  }

  console.log('\n[the per-customer UB override reaches the charge]');
  {
    const pm = { ...PM_BASE, charge_basis: 'ub' };
    const withOverride = dustProductMargin({ pm, rows: TRACKING, ubRate: UB_RATE, companies: COMPANIES, year: Y });
    const flatRate     = dustProductMargin({ pm, rows: TRACKING, ubRate: UB_RATE, companies: [], year: Y });
    assert('a customer rate override changes UB revenue per gallon',
      Math.abs(withOverride.tracking.perGalUb - flatRate.tracking.perGalUb) > 0.005,
      `${withOverride.tracking.perGalUb} vs ${flatRate.tracking.perGalUb}`);
  }

  console.log('\n[nothing entered is unknown, not zero]');
  {
    const empty = dustProductMargin({ pm: PM_EMPTY, rows: TRACKING, ubRate: UB_RATE, companies: COMPANIES, year: Y });
    assert('with no batch, margin is null rather than 0%',
      empty.ready === false && empty.marginPct === null && empty.profitPerGal === null,
      JSON.stringify({ margin: empty.marginPct, profit: empty.profitPerGal }));
    const page = await paint(win, doc, PM_EMPTY, Y);
    assert('  and the page shows a dash, which is the same claim',
      String(page.margin).trim() === '—', page.margin);

    const noCharge = dustProductMargin({
      pm: { ...PM_BASE, charge_basis: 'custom', charge: 0 },
      rows: TRACKING, ubRate: UB_RATE, companies: COMPANIES, year: Y,
    });
    assert('a batch with nothing charged for it is also unknown',
      noCharge.ready === false && noCharge.marginPct === null);
  }

  console.log('\n[the dilution is not skipped]');
  {
    const lib = dustProductMargin({
      pm: { ...PM_BASE, charge_basis: 'custom' },
      rows: TRACKING, ubRate: UB_RATE, companies: COMPANIES, year: Y,
    });
    assert('cost to make is the concentrate cost divided by the mix ratio',
      Math.abs(lib.costToMakePerGal - Math.round((lib.batch.totalCost / lib.batch.totalGallons) / 8 * 100) / 100) < 0.005,
      `${lib.costToMakePerGal} vs concentrate ${lib.concentratePerGal}`);
    assert('  so it is well under the undiluted figure',
      lib.costToMakePerGal < lib.concentratePerGal,
      'comparing an undiluted cost to a diluted charge reports a loss on a good product');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('\nharness error:', err); process.exit(1); });
