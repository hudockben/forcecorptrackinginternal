#!/usr/bin/env node
'use strict';
/**
 * The Dust page never saves a config it has not loaded.
 *
 * Run: node scripts/test-dust-config-load-guard.js
 *
 * The incident this guards: a Dust tab hidden (or closed, or redirected) while
 * the page was still loading — or after GET /api/dust-config had failed — sent
 * the page's blank starting state to PUT /api/dust-config: ub_rate 0, every
 * list empty, no employee rates, no cost codes, a blank profit margin. The UB
 * Gallon Rate read $0 afterwards, every UB gallon priced at nothing, and the
 * Intercompany mirror voided the billing of every UB-only row.
 *
 * This loads the real dust.html in jsdom over a fake API and asserts:
 *   - with the config GET failing or hanging, a hide and an unload send no
 *     config PUT, and nothing else a person can do (a row edit, the UB box,
 *     Manage Lists, Repair, the profit margin, an import) sends one either;
 *     the Intercompany mirror stands down; init() does not "repair" the lists;
 *   - the page says the config did not load, and locks its editors;
 *   - a later poll or retry applies ALL of the config, and the next UB edit
 *     goes out with ub_rate_base set to the rate it loaded;
 *   - once loaded, the hide flush carries the real lists and ub_rate_base,
 *     and still saves a UB edit caught in its debounce;
 *   - a brand-new company, whose config loads empty, still gets its lists
 *     built from its rows;
 *   - a 409 from the server is not retried and its reason is on screen, while
 *     a 5xx is still retried;
 *   - a save answered with a different stored rate is taken up — unless the
 *     box was changed again while the save was out;
 *   - Other Billing and Product Cost refuse to add (and save) rows after a
 *     failed load;
 *   - a page being redirected away (another division picked) writes nothing;
 *   - the profit margin's local-cache rescue still pushes, once loaded.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.resolve(__dirname, '../dust.html');
const OB_KEY    = 'dust_other_billing_rows';
const PC_KEY    = 'dust_product_cost_rows';
const IC_KEY    = 'fct_intercompany_billing_entries';
const PM_LS_KEY = 'fct_dust_pm:TEST';

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else      { failed++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const unhandled = [];
process.on('unhandledRejection', err => unhandled.push(String(err && err.stack || err)));

// ── Fixture ────────────────────────────────────────────────────────────────
const UB_RATE = 0.35;
const PM = { base_gal: 275, base_rate: 4.1, soap_gal: 5, soap_rate: 22, water_gal: 2000,
             water_rate: 0.01, mix_parts: 8, charge_basis: 'ub', charge: null };
const LISTS = {
  equipment: [{ id: 'eq-1', name: 'Distributor Truck 4000', unit_number: '4000', vehicle_rate: 120 },
              { id: 'eq-2', name: 'Water Truck 12', unit_number: '12', vehicle_rate: 95 }],
  employees: ['John Doe', 'Pat Reilly'],
  materials: ['ClearFrac', 'Calcium Chloride'],
  states:    ['PA', 'WV'],
  mu:        ['GAL', 'BAG'],
  companies: [
    { id: 'co-1', name: 'CNX', tier: '', v1_rate: 130, v2_rate: 65, ub_rate: null,
      locations: [{ id: 'l-1', name: 'Bear Hollow', state: 'PA' }], men: [{ id: 'm-1', name: 'Bill Reed' }] },
    { id: 'co-2', name: 'Antero', tier: '', v1_rate: 125, v2_rate: 60, ub_rate: null,
      locations: [{ id: 'l-2', name: 'Shale Run', state: 'WV' }], men: [] },
  ],
  employee_rates: { 'John Doe': 31.5, 'Pat Reilly': 28 },
  cost_codes: [{ id: 'cc-1', name: '100 Dust', sub_codes: [{ id: 'sc-1', name: '100.1 Spray' }] }],
};
const CONFIG = () => JSON.parse(JSON.stringify({ settings: { ub_rate: UB_RATE, profit_margin: PM }, lists: LISTS }));

// A UB-only row (no vehicles): at the real rate it bills 1,200 gal × $0.35;
// at the unloaded $0 its total is zero, which is what used to void its entry.
const ROWS = [
  { id: 'r-ub', date: '2026-09-30', start_time: '07:00', end_time: '09:00', company: 'CNX',
    company_man: 'Bill Reed', location: 'Bear Hollow', state: 'PA', vehicle1: '', v1_unit: '',
    v1_rate: '', vehicle2: '', v2_unit: '', v2_rate: '', gallons_ub: '1200', inv_number: '',
    inv_status: '' },
  { id: 'r-veh', date: '2026-09-29', start_time: '06:00', end_time: '10:00', company: 'Antero',
    company_man: '', location: 'Shale Run', state: 'WV', vehicle1: 'Distributor Truck 4000',
    v1_unit: '4000', v1_rate: '125', vehicle2: '', v2_unit: '', v2_rate: '', gallons_ub: '',
    inv_number: '', inv_status: '' },
  // A vehicle with no rate typed: init() back-fills Antero's V1 rate and saves
  // the row — a write, so a page on its way out must skip it.
  { id: 'r-blank', date: '2026-09-28', start_time: '06:00', end_time: '08:00', company: 'Antero',
    company_man: '', location: 'Shale Run', state: 'WV', vehicle1: 'Water Truck 12',
    v1_unit: '12', v1_rate: '', vehicle2: '', v2_unit: '', v2_rate: '', gallons_ub: '',
    inv_number: '', inv_status: '' },
];
const IC_COMPANIES = [{ id: 'ic-1', name: 'CNX', divisions: ['dust'] },
                      { id: 'ic-2', name: 'Antero', divisions: ['dust'] }];
const IC_ENTRIES = [{
  id: 'e-ub', source: 'dust', source_id: 'r-ub', company_id: 'ic-1', company_name: 'CNX',
  actual_date: '2026-09-30', actual_start: '07:00', actual_end: '09:00', total_hours: 2,
  total: 420, gallons_ub: '1200', ub_total: 420, location: 'Bear Hollow', vehicle1: '',
  sent_at: '2026-09-30T15:00:00.000Z', sent_by: 'tester',
}];
const OB_ROWS = [{ id: 'ob-1', date: '2026-09-28', inv_number: '', driver: 'Pat Reilly', truck_number: '12',
  trailer_number: '', customer: 'CNX', destination: 'Bear Hollow', state: 'PA', material: 'ClearFrac',
  gallons_bags: '500', mu: 'GAL', price_per_unit: '0.42', trucking_hrs: '2', trucking_rate: '95', comments: '' }];
const PC_ROWS = [{ id: 'pc-1', date: '2026-09-27', hours: '3', mix_type: '8', cost_code: '', sub_code: '',
  employee: 'John Doe', rate: '31.5', material: 'ClearFrac', supplier: '', units: '275', unit_cost: '4.1' }];

// ── The fake API ───────────────────────────────────────────────────────────
// `ctl` is the switchboard each case flips: what the config GET does, how the
// config PUT answers, and whether Other Billing / Product Cost can be read.
// The config PUT plays the server's UB rule: when ub_rate equals ub_rate_base
// the tab did not change the rate, so the stored one stands.
function makeCtl(over = {}) {
  return Object.assign({
    cfgGet: 'ok',        // 'ok' | 'hang' | <status>
    cfgBody: null,       // what a good config GET answers, when not the fixture
    cfgPut: 'ok',        // 'ok' | 'defer' | <status>
    refusal: null,       // body for a 4xx config PUT
    storedUb: UB_RATE,
    obGet: 'ok', pcGet: 'ok',
    deferred: [],        // resolvers for cfgPut 'defer'
    log: [],             // every request: { method, url, body, keepalive }
  }, over);
}

function stubFetch(ctl) {
  const res = (status, body) => {
    const r = {
      ok: status >= 200 && status < 300, status,
      json: async () => JSON.parse(JSON.stringify(body)),
      text: async () => JSON.stringify(body),
    };
    r.clone = () => r;
    return r;
  };
  const cfgAnswer = (body) => {
    const s = (body && body.settings) || {};
    const ub = parseFloat(s.ub_rate) || 0;
    const base = typeof s.ub_rate_base === 'number' ? s.ub_rate_base : null;
    if (!(base != null && Math.abs(ub - base) <= 1e-9)) ctl.storedUb = ub;
    return res(200, { ok: true, settings: { ub_rate: ctl.storedUb } });
  };
  return async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* not JSON */ }
    ctl.log.push({ method, url: u, body, keepalive: !!init.keepalive });

    if (u.includes('/api/dust-config')) {
      if (method === 'GET') {
        if (ctl.cfgGet === 'hang') return new Promise(() => {});
        if (ctl.cfgGet !== 'ok') return res(ctl.cfgGet, { error: 'boom' });
        if (ctl.cfgBody) return res(200, ctl.cfgBody);
        return res(200, { ...CONFIG(), settings: { ...CONFIG().settings, ub_rate: ctl.storedUb } });
      }
      if (ctl.cfgPut === 'defer') return new Promise(done => ctl.deferred.push(() => done(cfgAnswer(body))));
      if (ctl.cfgPut !== 'ok') return res(ctl.cfgPut, ctl.refusal || { error: 'boom' });
      return cfgAnswer(body);
    }
    if (u.includes('/api/dust-rows')) {
      if (method === 'GET') return res(200, { dustRows: JSON.parse(JSON.stringify(ROWS)) });
      return res(200, { ok: true });
    }
    if (u.includes('/api/dust-audit')) return res(200, { events: [] });
    const m = /\/api\/data\/([^?]+)/.exec(u);
    if (m) {
      const key = decodeURIComponent(m[1]);
      if (method !== 'GET') return res(200, { ok: true });
      if (key === OB_KEY && ctl.obGet !== 'ok') return res(500, { error: 'boom' });
      if (key === PC_KEY && ctl.pcGet !== 'ok') return res(500, { error: 'boom' });
      const value = {
        [OB_KEY]: OB_ROWS, [PC_KEY]: PC_ROWS,
        fct_intercompany_companies: IC_COMPANIES, [IC_KEY]: IC_ENTRIES,
      }[key];
      return res(200, { value: value === undefined ? null : JSON.parse(JSON.stringify(value)),
                        updated_at: '2026-10-01T00:00:00.000Z' });
    }
    return res(200, {});
  };
}

// Writes the page made, minus presence (its own heartbeat, not the dust books).
const puts = (ctl, re) => ctl.log.filter(q => q.method !== 'GET' && re.test(q.url) && !/fct_presence/.test(q.url));
const cfgPuts = ctl => puts(ctl, /\/api\/dust-config/);

async function boot(ctl, { division = 'dust', pmCache = null } = {}) {
  const vc = new VirtualConsole();
  const jsdomErrors = [];
  vc.on('jsdomError', e => {
    // A wrong division sends the page to divisions.html; jsdom does not follow.
    if (!/Not implemented: navigation/.test(String(e && e.message))) jsdomErrors.push(String(e && e.message));
  });
  const dom = new JSDOM(fs.readFileSync(HTML_PATH, 'utf8'), {
    runScripts: 'dangerously',
    url: 'https://example.test/dust.html',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.localStorage.setItem('fct_token', 'test-token');
      win.localStorage.setItem('fct_user', JSON.stringify({
        userId: 1, username: 'tester', companyCode: 'TEST', companyName: 'Test Co',
        allowedDivisions: ['dust'],
      }));
      if (division) win.localStorage.setItem('fct_division', division);
      if (pmCache) win.localStorage.setItem(PM_LS_KEY, JSON.stringify(pmCache));
      win.fetch = stubFetch(ctl);
      win.__alerts = [];
      win.alert = msg => win.__alerts.push(String(msg));
      win.confirm = () => true;
      win.print = () => {};
      win.Element.prototype.scrollIntoView = function () {};
      win.__errors = [];
      win.addEventListener('error', e => win.__errors.push(e.message || String(e.error)));
    },
  });
  const win = dom.window, doc = win.document;
  let vis = 'visible';
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => vis });
  const setVisibility = v => { vis = v; doc.dispatchEvent(new win.Event('visibilitychange')); };
  // An expression that throws (a name the page no longer has, say) reads as
  // undefined, so the assertion on it fails rather than ending the run.
  const ev = expr => { try { return win.eval(expr); } catch { return undefined; } };
  return { dom, win, doc, ev, setVisibility, jsdomErrors };
}

async function until(fn, ms = 4000) {
  for (let t = 0; t < ms; t += 25) {
    let v = false;
    try { v = fn(); } catch { /* not there yet */ }
    if (v) return true;
    await sleep(25);
  }
  return false;
}

function typeUb(win, doc, value) {
  const el = doc.getElementById('ubRateInput');
  el.value = String(value);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
  el.dispatchEvent(new win.Event('change', { bubbles: true }));
}

async function main() {
  console.log('Dust config — nothing is saved until it has loaded\n');

  // ── A. The config GET fails ──────────────────────────────────────────────
  {
    const ctl = makeCtl({ cfgGet: 500, obGet: 500, pcGet: 500 });
    const { dom, win, doc, ev, setVisibility, jsdomErrors } = await boot(ctl);
    await until(() => ev('dustLoaded') && ev('_dustConfigReadFailed'));

    console.log('[the config GET fails — the page]');
    assert('no uncaught script errors', win.__errors.length === 0 && jsdomErrors.length === 0,
      win.__errors.concat(jsdomErrors).join(' | '));
    assert('the rows did load', ev('rows.length') === ROWS.length);
    assert('with no customer list, no vehicle rate was back-filled',
      ev("rows.find(r => r.id === 'r-blank').v1_rate") === '');
    assert('the config is not marked loaded', ev('dustConfigLoaded') === false);
    assert('init() did not "repair" lists it never had',
      ev('dustLists.companies.length') === 0 && ev('dustLists.equipment.length') === 0,
      `${ev('dustLists.companies.length')} companies`);
    assert('the UB-only row prices at $0 without the rate (the fixture means something)',
      ev("calc(rows.find(r => r.id === 'r-ub')).invTotal") === 0);

    console.log('\n[(c) it says so]');
    const banner = doc.getElementById('dustConfigBanner');
    assert('the banner is up', !!banner && !banner.hidden);
    assert('  and says the rates did not load', !!banner && /did not load/.test(banner.textContent),
      banner && banner.textContent);
    ev('refreshHomeDashboard()');
    assert('the home dashboard says the rates and customer list could not be read',
      /Could not read the dust rates and customer list/.test(doc.getElementById('home-content').textContent));
    assert('the UB rate box is disabled', doc.getElementById('ubRateInput').disabled === true);
    assert('Manage Lists is disabled', (doc.getElementById('manageListsBtn') || {}).disabled === true);
    assert('Repair Lists is disabled', doc.getElementById('repairBtn').disabled === true);
    assert('the profit margin inputs are disabled',
      [...doc.querySelectorAll('.pm-input, .pm-card-input, .pm-pill')].every(el => el.disabled));

    console.log('\n[(a) a hide and an unload send no config]');
    setVisibility('hidden');
    win.dispatchEvent(new win.Event('beforeunload'));
    await sleep(50);
    assert('no PUT /api/dust-config', cfgPuts(ctl).length === 0, JSON.stringify(cfgPuts(ctl)));
    assert('  (the row flush still went — rows did load)', puts(ctl, /\/api\/dust-rows/).length > 0);
    setVisibility('visible');
    await sleep(50);

    console.log('\n[(b) nothing a person does sends one either]');
    const before = ctl.log.length;
    ev("set(rows.findIndex(r => r.id === 'r-ub'), 'gallons_ub', '1300')");
    typeUb(win, doc, '0.50');
    assert('typing in the UB box does not move the rate', ev('ubRate') === 0, String(ev('ubRate')));
    ev('openListsModal()');
    assert('Manage Lists does not open', !doc.getElementById('listsModal').classList.contains('open'));
    ev('repairListsFromRows()');
    assert('Repair refuses, and says why', /not loaded/.test(win.__alerts.join('\n')), win.__alerts.join(' | '));
    assert('  leaving the lists alone', ev('dustLists.companies.length') === 0);
    doc.getElementById('pm-base-gal').value = '300';
    ev('pmOnInput()');
    ev("pmSetBasis('custom')");
    assert('the profit margin is not cached locally while unloaded', win.localStorage.getItem(PM_LS_KEY) === null);
    ev(`importBuffer = [${JSON.stringify({ ...ROWS[1], id: 'imp-1', date: '2026-09-25', company: 'Range' })}]`);
    await ev('confirmImport()');
    assert('an import still brings its rows in', ev("rows.some(r => r.id === 'imp-1')") === true);
    assert('  without rebuilding lists that never loaded', ev('dustLists.companies.length') === 0);
    await ev('autoSyncIntercompanyDust()');
    await sleep(1300);   // past every 900ms debounce
    assert('no PUT /api/dust-config from any of it', cfgPuts(ctl).length === 0, JSON.stringify(cfgPuts(ctl).map(p => p.body)));
    assert('the row edit itself was saved', puts(ctl, /\/api\/dust-rows/).length >= 2);
    assert('no Intercompany billing write — the mirror stood down',
      puts(ctl, new RegExp(IC_KEY)).length === 0);
    assert('a refused save did not start the poll cooldown', ev('_configChangedAt') === 0);
    assert('nothing else wrote to the config either',
      ctl.log.slice(before).every(q => q.method === 'GET' || !/dust-config/.test(q.url)));

    console.log('\n[(h) Other Billing and Product Cost after a failed load]');
    win.__alerts.length = 0;
    ev('obAddRow()');
    ev('pcAddRow()');
    assert('Other Billing refuses the row', ev('obRows.length') === 0);
    assert('Product Cost refuses the row', ev('pcRows.length') === 0);
    assert('  and both say why', win.__alerts.length === 2 && win.__alerts.every(a => /not loaded/.test(a)),
      win.__alerts.join(' | '));
    ev("obRows.push({ id: 'ob-x', date: '2026-10-01' }); pcRows.push({ id: 'pc-x', date: '2026-10-01' })");
    assert('obSave refuses outright', (await ev('obSave()')) === false);
    assert('pcSave refuses outright', (await ev('pcSave()')) === false);
    setVisibility('hidden');
    win.dispatchEvent(new win.Event('beforeunload'));
    await sleep(1000);
    assert('no PUT of the Other Billing blob', puts(ctl, new RegExp(OB_KEY)).length === 0);
    assert('no PUT of the Product Cost blob', puts(ctl, new RegExp(PC_KEY)).length === 0);
    ev("obRows.length = 0; pcRows.length = 0");

    console.log('\n[(d) a later poll applies all of it]');
    ctl.cfgGet = 'ok';
    setVisibility('visible');   // a returning tab polls straight away
    await until(() => ev('dustConfigLoaded'));
    assert('the config is now loaded', ev('dustConfigLoaded') === true);
    assert('  the UB rate', ev('ubRate') === UB_RATE && ev('ubRateBase') === UB_RATE, `${ev('ubRate')} / ${ev('ubRateBase')}`);
    assert('  the UB box shows it', doc.getElementById('ubRateInput').value === '0.35');
    assert('  every list, mu and employee rates and cost codes included',
      ev('JSON.stringify([dustLists.mu, dustLists.employee_rates, dustLists.cost_codes, dustLists.companies.length])')
        === JSON.stringify([LISTS.mu, LISTS.employee_rates, LISTS.cost_codes, 2]));
    assert('  the profit margin', ev('profitMargin.base_gal') === 275 && ev('profitMargin.charge_basis') === 'ub');
    assert('the banner is gone', (doc.getElementById('dustConfigBanner') || {}).hidden === true);
    assert('the editors are unlocked',
      !doc.getElementById('ubRateInput').disabled && !(doc.getElementById('manageListsBtn') || {}).disabled
      && !doc.getElementById('repairBtn').disabled);
    assert('the home dashboard no longer warns',
      !/Could not read the dust rates/.test(doc.getElementById('home-content').textContent));
    assert('the UB-only row bills again', ev("calc(rows.find(r => r.id === 'r-ub')).invTotal") > 0);
    await sleep(300);
    const icWrites = puts(ctl, new RegExp(IC_KEY));
    assert('the mirror that stood down ran — and kept the UB-only row\'s entry',
      icWrites.length > 0
        && icWrites.every(w => (w.body.value || []).some(e => e.source_id === 'r-ub' && e.total > 0)),
      JSON.stringify(icWrites.map(w => w.body.value)));

    const n = cfgPuts(ctl).length;
    typeUb(win, doc, '0.40');
    await until(() => cfgPuts(ctl).length > n, 3000);
    const put = cfgPuts(ctl)[n];
    assert('a UB edit now saves the config', !!put);
    assert('  with the new rate', put && put.body.settings.ub_rate === 0.4, put && JSON.stringify(put.body.settings));
    assert('  and ub_rate_base the rate it loaded', put && put.body.settings.ub_rate_base === UB_RATE);
    assert('  with the real lists', put && put.body.lists.companies.length === 2
      && put.body.lists.cost_codes.length === 1 && Object.keys(put.body.lists.employee_rates).length === 2);
    await until(() => ev('ubRateBase') === 0.4, 2000);
    assert('the server\'s answer becomes the new base', ev('ubRateBase') === 0.4);
    dom.window.close();
  }

  // ── A late retry, not a poll ─────────────────────────────────────────────
  {
    const ctl = makeCtl({ cfgGet: 503 });
    const { dom, ev } = await boot(ctl);
    await until(() => ev('_dustConfigReadFailed'));
    ctl.cfgGet = 'ok';
    console.log('\n[(d) …or init()\'s own retry, a couple of seconds on]');
    const got = await until(() => ev('dustConfigLoaded'), 4000);
    assert('the retry loads it without waiting for the poller', got);
    assert('  all of it', got && ev('ubRate') === UB_RATE && ev('dustLists.cost_codes.length') === 1
      && ev('dustLists.mu.length') === 2);
    dom.window.close();
  }

  // ── B. The config GET never answers ──────────────────────────────────────
  {
    const ctl = makeCtl({ cfgGet: 'hang' });
    const { dom, win, doc, ev, setVisibility } = await boot(ctl);
    await sleep(300);
    console.log('\n[the config GET never answers]');
    assert('still not loaded', ev('dustConfigLoaded') === false);
    assert('the editors are locked while it loads',
      doc.getElementById('ubRateInput').disabled && (doc.getElementById('manageListsBtn') || {}).disabled === true);
    assert('  without crying failure yet', (doc.getElementById('dustConfigBanner') || {}).hidden === true);
    setVisibility('hidden');
    win.dispatchEvent(new win.Event('beforeunload'));
    await sleep(50);
    assert('(a) a hide and an unload send no PUT /api/dust-config', cfgPuts(ctl).length === 0);
    dom.window.close();
  }

  // ── C. Loaded normally ───────────────────────────────────────────────────
  {
    const ctl = makeCtl();
    const { dom, win, doc, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded') && ev('obLoaded') && ev('pcLoaded'));
    await sleep(300);   // let init()'s own mirror settle
    console.log('\n[loaded normally]');
    assert('loaded', ev('dustConfigLoaded') === true && ev('ubRateBase') === UB_RATE);
    assert('the editors are unlocked', !doc.getElementById('ubRateInput').disabled);
    assert('no banner', (doc.getElementById('dustConfigBanner') || {}).hidden === true);
    assert('init() back-filled the blank vehicle rate, and saved the row',
      ev("rows.find(r => r.id === 'r-blank').v1_rate") === 125
      && puts(ctl, /\/api\/dust-rows/).some(p => !p.keepalive));

    console.log('\n[(e) the hide flush carries the real config]');
    setVisibility('hidden');
    await sleep(50);
    const flush = cfgPuts(ctl).filter(p => p.keepalive);
    assert('one keepalive PUT /api/dust-config', flush.length === 1, String(flush.length));
    const fb = flush[0] && flush[0].body;
    assert('  with the real lists', fb && fb.lists.companies.length === 2 && fb.lists.equipment.length === 2
      && fb.lists.mu.length === 2 && fb.lists.cost_codes.length === 1
      && fb.lists.employee_rates['John Doe'] === 31.5, fb && JSON.stringify(fb.lists).slice(0, 200));
    assert('  the rate, and ub_rate_base equal to it', fb && fb.settings.ub_rate === UB_RATE
      && fb.settings.ub_rate_base === UB_RATE);
    assert('  and the profit margin', fb && fb.settings.profit_margin && fb.settings.profit_margin.base_gal === 275);
    setVisibility('visible');
    await sleep(100);

    console.log('\n[(f) a 409 is not retried, and its reason is on screen]');
    const DETAIL = 'This save would have emptied the customer list and zeroed the UB rate. Reload the page.';
    ctl.cfgPut = 409;
    ctl.refusal = { error: 'Refusing to wipe dust config', detail: DETAIL, refused: ['companies', 'ub_rate'] };
    let n = cfgPuts(ctl).length;
    const result = await ev('dustConfigPut()');
    await sleep(1500);   // longer than the retry loop would wait
    assert('the save reads as failed', result === null);
    assert('one attempt, no retries', cfgPuts(ctl).length - n === 1, String(cfgPuts(ctl).length - n));
    const banner = doc.getElementById('dustConfigBanner') || { hidden: true, textContent: '' };
    assert('the banner carries the server\'s reason', !banner.hidden && banner.textContent.includes(DETAIL),
      banner.textContent);
    ev('saveLists()');
    await sleep(100);
    assert('the save dot goes red', doc.getElementById('saveDot').classList.contains('error'));

    console.log('\n[a 5xx is still retried]');
    ctl.cfgPut = 500;
    n = cfgPuts(ctl).length;
    await ev('dustConfigPut()');
    assert('three attempts', cfgPuts(ctl).length - n === 3, String(cfgPuts(ctl).length - n));

    ctl.cfgPut = 'ok';
    await ev('dustConfigPut()');
    assert('a save that goes through clears the refusal', banner.hidden === true);

    console.log('\n[(g) the rate the server kept is taken up]');
    ctl.storedUb = 0.5;   // another tab changed it; this one still holds 0.35
    n = cfgPuts(ctl).length;
    const ok = await ev('dustConfigPut()');
    const sent = (cfgPuts(ctl)[n] || { body: { settings: {} } }).body.settings;
    assert('this tab sent its unchanged rate, with base equal to it',
      sent.ub_rate === UB_RATE && sent.ub_rate_base === UB_RATE, JSON.stringify(sent));
    assert('the server kept its own and said so', ok && ok.settings.ub_rate === 0.5);
    assert('the page takes it up', ev('ubRate') === 0.5 && ev('ubRateBase') === 0.5);
    assert('  the box shows it', doc.getElementById('ubRateInput').value === '0.50');
    assert('  and the totals reprice', doc.getElementById('tot-ub').textContent.includes('600'),
      doc.getElementById('tot-ub').textContent);

    console.log('\n[…unless the box changed again while the save was out]');
    ctl.storedUb = 0.55;
    ctl.cfgPut = 'defer';
    const pending = ev('dustConfigPut()');
    await until(() => ctl.deferred.length === 1, 2000);
    const el = doc.getElementById('ubRateInput');
    el.value = '0.60';
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    ctl.deferred.shift()();
    await pending;
    assert('the box keeps what was typed', ev('ubRate') === 0.6 && el.value === '0.60', `${ev('ubRate')} ${el.value}`);
    assert('  and the base moves to the stored rate, so the next save writes it', ev('ubRateBase') === 0.55);
    ctl.cfgPut = 'ok';

    console.log('\n[the poller refreshes the rate — but not over an unsaved change]');
    // A returning tab polls at once; the cooldown after this tab's own saves
    // is cleared so the poll is not simply skipped.
    const poll = async () => {
      ev('_configChangedAt = 0');
      setVisibility('visible');
      await sleep(400);
    };
    ctl.storedUb = 0.45;
    await poll();
    assert('the 0.60 still in the box is kept', ev('ubRate') === 0.6 && el.value === '0.60', `${ev('ubRate')} ${el.value}`);
    assert('  while the base follows the server', ev('ubRateBase') === 0.45);
    el.value = '0.45';            // typed back to what the server holds: nothing unsaved now
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    ctl.storedUb = 0.48;
    await poll();
    assert('with nothing unsaved, the poll brings in another tab\'s rate',
      ev('ubRate') === 0.48 && ev('ubRateBase') === 0.48 && el.value === '0.48', `${ev('ubRate')} ${el.value}`);
    ev('window.__renders = 0; const _rt = renderTable; renderTable = function () { window.__renders++; return _rt.apply(this, arguments); }');
    await poll();
    assert('a poll that brings nothing new repaints nothing', ev('window.__renders') === 0, String(ev('window.__renders')));

    console.log('\n[Other Billing and Product Cost still save once loaded]');
    ev('obAddRow()');
    ev('pcAddRow()');
    await sleep(1200);
    const obPut = puts(ctl, new RegExp(OB_KEY)).pop();
    const pcPut = puts(ctl, new RegExp(PC_KEY)).pop();
    assert('Other Billing saves the new row with the rest', obPut && obPut.body.value.length === OB_ROWS.length + 1);
    assert('Product Cost saves the new row with the rest', pcPut && pcPut.body.value.length === PC_ROWS.length + 1);
    dom.window.close();
  }

  // ── D. Redirected away: another division was picked ──────────────────────
  {
    const ctl = makeCtl();
    const { dom, win, ev, setVisibility } = await boot(ctl, { division: 'turf' });
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded') && ev('obLoaded') && ev('pcLoaded'));
    await sleep(300);
    setVisibility('hidden');
    win.dispatchEvent(new win.Event('beforeunload'));
    await sleep(100);
    console.log('\n[a page on its way to divisions.html]');
    assert('no PUT /api/dust-config', cfgPuts(ctl).length === 0);
    assert('no PUT /api/dust-rows (not the flush, not the rate back-fill)', puts(ctl, /\/api\/dust-rows/).length === 0);
    assert('no Other Billing or Product Cost flush',
      puts(ctl, new RegExp(OB_KEY)).length === 0 && puts(ctl, new RegExp(PC_KEY)).length === 0);
    // Other Billing's own load-time mirror may still write the shared blob;
    // what must not move is the tracking book's part of it, which only
    // init()'s mirror writes (it would add Antero's row and rewrite CNX's).
    const dustPart = v => JSON.stringify((v || []).filter(e => e.source === 'dust'));
    assert('init()\'s Intercompany mirror stood down — no dust entry added or rewritten',
      puts(ctl, new RegExp(IC_KEY)).every(w => dustPart(w.body.value) === dustPart(IC_ENTRIES)),
      JSON.stringify(puts(ctl, new RegExp(IC_KEY)).map(w => w.body.value)));
    dom.window.close();
  }

  // ── F. A UB edit still in its debounce when the tab is hidden ─────────────
  {
    const ctl = makeCtl();
    const { dom, win, doc, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(300);
    const n = cfgPuts(ctl).length;
    typeUb(win, doc, '0.42');
    setVisibility('hidden');   // inside the 900ms debounce: only the flush can save it
    await sleep(50);
    console.log('\n[a UB edit caught by the hide flush]');
    const put = cfgPuts(ctl).slice(n).find(p => p.keepalive);
    assert('the flush carries it', put && put.body.settings.ub_rate === 0.42, put && JSON.stringify(put.body.settings));
    assert('  as a change: ub_rate_base is still the loaded rate', put && put.body.settings.ub_rate_base === UB_RATE);
    assert('  and the server took it', ctl.storedUb === 0.42);
    dom.window.close();
  }

  // ── G. A brand-new company: the config loads, and is empty ────────────────
  {
    const ctl = makeCtl({ cfgBody: { settings: { ub_rate: 0, profit_margin: null },
      lists: { equipment: [], employees: [], companies: [], materials: [], states: [], mu: [],
               employee_rates: {}, cost_codes: [] } } });
    const { dom, ev } = await boot(ctl);
    await until(() => cfgPuts(ctl).length > 0, 3000);
    console.log('\n[a company with nothing stored yet]');
    assert('the config counts as loaded — it answered', ev('dustConfigLoaded') === true);
    const put = cfgPuts(ctl)[0];
    assert('init() still builds the lists from the rows and saves them',
      put && put.body.lists.companies.map(c => c.name).sort().join() === 'Antero,CNX',
      put && JSON.stringify(put.body.lists.companies.map(c => c.name)));
    dom.window.close();
  }

  // ── E. The profit-margin rescue still works ──────────────────────────────
  {
    const ctl = makeCtl();
    const local = { ...PM, base_gal: 300 };
    const { dom, ev } = await boot(ctl, { pmCache: { pm: local, synced: PM } });
    await until(() => ev('dustConfigLoaded'));
    await until(() => cfgPuts(ctl).length > 0, 2500);
    console.log('\n[the profit-margin rescue is unchanged]');
    assert('the unsaved local edit wins over the server\'s unchanged copy', ev('profitMargin.base_gal') === 300);
    const put = cfgPuts(ctl)[0];
    assert('  and is pushed once the config is loaded', put && put.body.settings.profit_margin.base_gal === 300);
    dom.window.close();
  }

  console.log('\n[the run itself]');
  assert('no unhandled promise rejections', unhandled.length === 0, unhandled.join('\n'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('FATAL', err); process.exit(1); });
