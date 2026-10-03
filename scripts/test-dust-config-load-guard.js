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
 *   - the profit margin's local-cache rescue still pushes, once loaded;
 *   - a tab holding an old UB rate mirrors Intercompany at the stored one
 *     (its row edit waits for the config save's answer; the poll re-mirrors),
 *     and a tab loaded at a stored $0 never voids a UB-only entry;
 *   - an emptied or half-typed UB box is not a $0 rate, and a committed $0
 *     asks first;
 *   - the hide flush, sent while a UB change is still out, still reads as
 *     the change it is; list removals queued behind a slow save reach the
 *     server one step at a time;
 *   - a config that loads late and empty still builds its lists; Other
 *     Billing and Product Cost retry a failed first read; the poller takes
 *     up the profit margin; Print/Email refuse to price UB at $0.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = process.env.DUST_HTML || path.resolve(__dirname, '../dust.html');
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
    storedPm: PM,        // the profit margin a good config GET answers
    obGet: 'ok', pcGet: 'ok',   // 'ok' | 'hold' | <status>
    obMissing: false,    // the Other Billing blob does not exist yet (200, value null)
    held: [],            // releases for Other Billing / Product Cost reads on 'hold'
    deferred: [],        // resolvers for cfgPut 'defer'
    ic: JSON.parse(JSON.stringify(IC_ENTRIES)),   // the Intercompany billing record: writes land here
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
        return res(200, { ...CONFIG(), settings: { ub_rate: ctl.storedUb, profit_margin: ctl.storedPm } });
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
      if (method !== 'GET') {
        if (key === IC_KEY && body && Array.isArray(body.value)) ctl.ic = body.value;
        return res(200, { ok: true });
      }
      if ((key === OB_KEY && ctl.obGet === 'hold') || (key === PC_KEY && ctl.pcGet === 'hold')) {
        const value = JSON.parse(JSON.stringify(key === OB_KEY ? OB_ROWS : PC_ROWS));
        return new Promise(done => ctl.held.push(() => done(res(200, { value, updated_at: '2026-10-01T00:00:00.000Z' }))));
      }
      if (key === OB_KEY && ctl.obGet !== 'ok') return res(500, { error: 'boom' });
      if (key === PC_KEY && ctl.pcGet !== 'ok') return res(500, { error: 'boom' });
      if (key === OB_KEY && ctl.obMissing) return res(200, { value: null, updated_at: null });
      const value = {
        [OB_KEY]: OB_ROWS, [PC_KEY]: PC_ROWS,
        fct_intercompany_companies: IC_COMPANIES, [IC_KEY]: ctl.ic,
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
      [...doc.querySelectorAll('#an-profit .pm-input, #an-profit .pm-card-input, #an-profit .pm-pill')].every(el => el.disabled));
    // Actual Profit Margin reuses .pm-pill for a view toggle saved nowhere.
    assert('  but not the Actual Profit Margin basis toggle',
      [...doc.querySelectorAll('#an-actual .pm-pill')].length === 2
      && [...doc.querySelectorAll('#an-actual .pm-pill')].every(el => !el.disabled));

    console.log('\n[the Print and Email reports refuse to price UB at $0]');
    win.__alerts.length = 0;
    win.open = () => { win.__opened = true; return null; };
    win.openReportEmailModal = () => { win.__emailed = true; };
    ev('generateDustReport()');
    ev('emailDustReport()');
    assert('neither the PDF nor the email went out', !win.__opened && !win.__emailed);
    assert('  and both say why', win.__alerts.length === 2 && win.__alerts.every(a => /have not loaded/.test(a)),
      win.__alerts.join(' | '));
    win.__alerts.length = 0;

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
    ev('refreshHomeDashboard()');
    const home = doc.getElementById('home-content').textContent;
    assert('  nor does the home dashboard: it says the rates are still loading',
      /Still loading the dust rates/.test(home) && !/Could not read the dust rates/.test(home), home.slice(0, 300));
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
    el.dispatchEvent(new win.Event('input', { bubbles: true }));   // being typed, not committed yet
    ctl.deferred.shift()();
    await pending;
    assert('the box keeps what is being typed', el.value === '0.60', el.value);
    assert('  the stored 0.55 becomes the rate and the base', ev('ubRate') === 0.55 && ev('ubRateBase') === 0.55,
      `${ev('ubRate')} / ${ev('ubRateBase')}`);
    // Committed, and its save refused: a change of this tab's the server
    // does not have.
    ctl.cfgPut = 409;
    let n2 = cfgPuts(ctl).length;
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    await until(() => cfgPuts(ctl).length > n2 && ev('saveTimer') === null && ev('_configPutInFlight') === 0, 3000);
    const put60 = cfgPuts(ctl)[n2];
    assert('  committed, 0.60 is the rate and goes out as a change against base 0.55', ev('ubRate') === 0.6
      && put60 && put60.body.settings.ub_rate === 0.6 && put60.body.settings.ub_rate_base === 0.55,
      put60 && JSON.stringify(put60.body.settings));
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
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    n2 = cfgPuts(ctl).length;
    await until(() => cfgPuts(ctl).length > n2 && ev('saveTimer') === null && ev('_configPutInFlight') === 0, 3000);
    await sleep(100);
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

  // ── G2. …and when that empty config loads late ───────────────────────────
  {
    const ctl = makeCtl({ cfgGet: 503, cfgBody: { settings: { ub_rate: 0, profit_margin: null },
      lists: { equipment: [], employees: [], companies: [], materials: [], states: [], mu: [],
               employee_rates: {}, cost_codes: [] } } });
    const { dom, ev } = await boot(ctl);
    await until(() => ev('_dustConfigReadFailed'));
    ctl.cfgGet = 'ok';
    await until(() => ev('dustConfigLoaded'), 4000);
    await until(() => cfgPuts(ctl).length > 0, 2000);
    console.log('\n[a company with nothing stored yet, whose first read failed]');
    const put = cfgPuts(ctl)[0];
    assert('the late load builds the lists from the rows too, and saves them',
      put && put.body.lists.companies.map(c => c.name).sort().join() === 'Antero,CNX',
      put ? JSON.stringify(put.body.lists.companies.map(c => c.name)) : 'no config PUT');
    dom.window.close();
  }

  // ── H. A tab holding an old rate mirrors Intercompany at the stored one ────
  {
    const ctl = makeCtl();
    const { dom, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(400);   // init()'s own mirror, at 0.35
    console.log('\n[another tab changed the rate; this one edits a row before its poll]');
    // The other tab's own mirror priced the UB-only row at 0.50 (600). This
    // tab still holds 0.35, and its row edit used to mirror before the
    // config save's answer told it the stored rate — putting 420 back.
    ctl.storedUb = 0.5;
    let n = puts(ctl, new RegExp(IC_KEY)).length;
    // The real config PUT is the slow one (it rewrites every customer), the
    // Intercompany reads are quick GETs: hold its answer back a while.
    ctl.cfgPut = 'defer';
    ev("set(rows.findIndex(r => r.id === 'r-veh'), 'inv_number', 'INV-9')");
    await until(() => ctl.deferred.length === 1, 3000);
    await sleep(400);
    ctl.deferred.shift()();
    ctl.cfgPut = 'ok';
    await until(() => ev('ubRate') === 0.5, 3000);
    await sleep(700);
    const ubTotal = w => ((w.body.value || []).find(e => e.source_id === 'r-ub') || {}).total;
    let totals = puts(ctl, new RegExp(IC_KEY)).slice(n).map(ubTotal);
    assert('the row edit\'s config save took up the stored 0.50', ev('ubRate') === 0.5 && ev('ubRateBase') === 0.5);
    assert('Intercompany was written, never at the old rate: r-ub at 600, not 420',
      totals.length > 0 && totals.every(t => t === 600), JSON.stringify(totals));

    console.log('\n[the poll brings in another rate: Intercompany follows]');
    ctl.storedUb = 0.48;
    n = puts(ctl, new RegExp(IC_KEY)).length;
    ev('_configChangedAt = 0');
    setVisibility('visible');
    await until(() => puts(ctl, new RegExp(IC_KEY)).length > n, 2000);
    totals = puts(ctl, new RegExp(IC_KEY)).slice(n).map(ubTotal);
    assert('the poll took up 0.48 and mirrored at it (r-ub 576)', ev('ubRate') === 0.48
      && totals.length > 0 && totals.every(t => t === 576), `${ev('ubRate')} ${JSON.stringify(totals)}`);
    dom.window.close();
  }

  // ── I. Loaded at a stored $0 (after the blank save, before the restore) ────
  {
    const ctl = makeCtl({ storedUb: 0 });
    const { dom, ev } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(400);
    ev("set(rows.findIndex(r => r.id === 'r-veh'), 'inv_number', 'INV-7')");
    await sleep(1500);
    console.log('\n[a tab loaded at the $0 a blank save left behind]');
    const writes = puts(ctl, new RegExp(IC_KEY));
    assert('the mirror did run and write (the case means something)', writes.length > 0);
    assert('the UB-only row\'s entry is kept as it was: same id, still 420 — not voided at $0',
      writes.every(w => { const e = (w.body.value || []).find(x => x.source_id === 'r-ub');
                          return !!e && e.id === 'e-ub' && e.total === 420 && e.ub_total === 420; }),
      JSON.stringify(writes.map(w => (w.body.value || []).find(x => x.source_id === 'r-ub') || null)));

    console.log('\n[…while the office keeps working on that row]');
    const n = puts(ctl, new RegExp(IC_KEY)).length;
    ev("set(rows.findIndex(r => r.id === 'r-ub'), 'inv_number', 'INV-12')");
    await until(() => puts(ctl, new RegExp(IC_KEY)).length > n, 3000);
    await sleep(300);
    const e = ctl.ic.find(x => x.source_id === 'r-ub');
    assert('its invoice number still reaches Intercompany; only its UB figures stay (e-ub, 1200 gal, 420)',
      !!e && e.id === 'e-ub' && e.inv_number === 'INV-12' && e.total === 420 && e.ub_total === 420
        && e.gallons_ub === '1200', JSON.stringify(e));
    dom.window.close();
  }

  // ── J. An emptied or half-typed UB box is not a rate ──────────────────────
  {
    const ctl = makeCtl();
    const { dom, win, doc, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(400);
    const el = doc.getElementById('ubRateInput');
    const input  = v => { el.value = v; el.dispatchEvent(new win.Event('input',  { bubbles: true })); };
    const change = v => { el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); };
    console.log('\n[the UB box cleared to retype it, inside a row edit\'s debounce]');
    let n = cfgPuts(ctl).length;
    const icBefore = puts(ctl, new RegExp(IC_KEY)).length;
    ev("set(rows.findIndex(r => r.id === 'r-veh'), 'inv_number', 'INV-8')");
    input('');
    assert('an emptied box leaves the rate at 0.35', ev('ubRate') === UB_RATE, String(ev('ubRate')));
    input('0');
    assert('  and so does the "0" on the way to "0.50"', ev('ubRate') === UB_RATE, String(ev('ubRate')));
    await until(() => cfgPuts(ctl).length > n, 3000);
    const p = cfgPuts(ctl)[n];
    assert('the row edit\'s config save carries 0.35 against base 0.35 — not a deliberate $0',
      p && p.body.settings.ub_rate === UB_RATE && p.body.settings.ub_rate_base === UB_RATE,
      p && JSON.stringify(p.body.settings));
    assert('  the server still holds 0.35', ctl.storedUb === UB_RATE, String(ctl.storedUb));
    await sleep(500);
    const ic = puts(ctl, new RegExp(IC_KEY)).slice(icBefore);
    assert('  and Intercompany kept the UB-only row at 420',
      ic.length > 0 && ic.every(w => ((w.body.value || []).find(e => e.source_id === 'r-ub') || {}).total === 420),
      JSON.stringify(ic.map(w => ((w.body.value || []).find(e => e.source_id === 'r-ub') || null))));

    console.log('\n[…or cleared, and the tab hidden to look the new rate up]');
    input('');
    n = cfgPuts(ctl).length;
    setVisibility('hidden');
    await sleep(50);
    const f = cfgPuts(ctl).slice(n).find(q => q.keepalive);
    assert('the hide flush carries 0.35 against base 0.35', f && f.body.settings.ub_rate === UB_RATE
      && f.body.settings.ub_rate_base === UB_RATE, f && JSON.stringify(f.body.settings));
    setVisibility('visible');
    await sleep(100);

    console.log('\n[committing the box]');
    n = cfgPuts(ctl).length;
    change('');
    assert('an empty box committed puts the rate back in it', el.value === '0.35' && ev('ubRate') === UB_RATE, el.value);
    win.confirm = () => false;
    change('0');
    assert('a $0 rate asks first; cancelled, nothing changes', el.value === '0.35' && ev('ubRate') === UB_RATE, el.value);
    await sleep(1200);
    assert('  and nothing was saved', cfgPuts(ctl).length === n, String(cfgPuts(ctl).length - n));
    win.confirm = () => true;
    change('0');
    await until(() => ctl.storedUb === 0, 3000);
    assert('confirmed, $0 is saved as the deliberate change it is', ev('ubRate') === 0 && ctl.storedUb === 0);
    dom.window.close();
  }

  // ── J2. …nor is any step of clearing it one keystroke at a time ──────────
  {
    const ctl = makeCtl();
    const { dom, win, doc, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(400);
    const el = doc.getElementById('ubRateInput');
    const input  = v => { el.value = v; el.dispatchEvent(new win.Event('input',  { bubbles: true })); };
    const change = v => { el.value = v; el.dispatchEvent(new win.Event('change', { bubbles: true })); };
    const ubTot  = () => doc.getElementById('tot-ub').textContent;
    const ubOf   = w => ((w.body.value || []).find(e => e.source_id === 'r-ub') || {}).total;
    console.log('\n[0.35 backspaced empty — 0.3, 0., 0, \'\' — then the tab hidden]');
    for (const v of ['0.3', '0.', '0', '']) input(v);
    assert('the rate is still 0.35: the 0.3 on the way was not one', ev('ubRate') === UB_RATE, String(ev('ubRate')));
    let n = cfgPuts(ctl).length;
    setVisibility('hidden');
    await sleep(50);
    const f = cfgPuts(ctl).slice(n).find(q => q.keepalive);
    assert('the hide flush carries 0.35 against base 0.35', f && f.body.settings.ub_rate === UB_RATE
      && f.body.settings.ub_rate_base === UB_RATE, f && JSON.stringify(f.body.settings));
    assert('  the server still holds 0.35', ctl.storedUb === UB_RATE, String(ctl.storedUb));
    setVisibility('visible');
    await sleep(100);

    console.log('\n[…then left empty]');
    change('');
    assert('the box shows 0.35 again, the rate it still is', el.value === '0.35' && ev('ubRate') === UB_RATE,
      `${el.value} / ${ev('ubRate')}`);
    assert('  and so do the totals (UB $420.00)', ubTot() === '$420.00', ubTot());

    console.log('\n[a rate half-typed while a row edit saves]');
    n = cfgPuts(ctl).length;
    const icN = puts(ctl, new RegExp(IC_KEY)).length;
    ev("set(rows.findIndex(r => r.id === 'r-veh'), 'inv_number', 'INV-8')");
    input('0.3');
    assert('the totals preview it (UB $360.00)', ubTot() === '$360.00', ubTot());
    await until(() => cfgPuts(ctl).length > n, 3000);
    const p = cfgPuts(ctl)[n];
    assert('the row edit\'s config save carries 0.35 against base 0.35', p && p.body.settings.ub_rate === UB_RATE
      && p.body.settings.ub_rate_base === UB_RATE, p && JSON.stringify(p.body.settings));
    await sleep(500);
    const ic = puts(ctl, new RegExp(IC_KEY)).slice(icN);
    assert('  and Intercompany is priced at 0.35 (r-ub 420)', ic.length > 0 && ic.every(w => ubOf(w) === 420),
      JSON.stringify(ic.map(ubOf)));
    assert('  the box keeps what is being typed', el.value === '0.3', el.value);
    el.dispatchEvent(new win.Event('blur'));   // typed back to where it began: no change event
    assert('left with no change, box and totals are back at 0.35', el.value === '0.35' && ubTot() === '$420.00'
      && ev('ubRate') === UB_RATE, `${el.value} / ${ubTot()}`);
    dom.window.close();
  }

  // ── K. The hide flush while a UB change is still on its way ───────────────
  {
    const ctl = makeCtl();
    const { dom, win, doc, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(400);
    ctl.cfgPut = 'defer';
    typeUb(win, doc, '0.50');
    await until(() => ctl.deferred.length === 1, 3000);   // the 0.50 save is out, unanswered
    typeUb(win, doc, '0.35');                              // typed back, then the tab hidden
    setVisibility('hidden');
    await sleep(50);
    console.log('\n[a rate typed back while its change is still out, then the tab hidden]');
    const ka = cfgPuts(ctl).filter(q => q.keepalive).pop();
    assert('the flush carries 0.35', ka && ka.body.settings.ub_rate === UB_RATE, ka && JSON.stringify(ka.body.settings));
    assert('  against the rate of the save still out (0.50), so it reads as the change it is',
      ka && ka.body.settings.ub_rate_base === 0.5, ka && JSON.stringify(ka.body.settings));
    for (let i = 0; i < 20 && ctl.deferred.length; i++) { ctl.deferred.shift()(); await sleep(30); }
    await sleep(100);
    assert('the server takes the 0.50 save, then the flush: it ends on 0.35, the last rate typed',
      ctl.storedUb === UB_RATE, String(ctl.storedUb));
    dom.window.close();
  }

  // ── L. List removals queued behind a config save that is still out ────────
  {
    const ctl = makeCtl();
    const { dom, ev } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(400);
    ctl.cfgPut = 'defer';
    const n = cfgPuts(ctl).length;
    ev('saveLists()');   // any config save already out: a row edit's, a rate's
    await until(() => ctl.deferred.length === 1, 2000);
    ev("removeListItem('materials', 'ClearFrac')");
    ev("removeListItem('materials', 'Calcium Chloride')");
    for (let i = 0; i < 40 && (cfgPuts(ctl).length < n + 3 || ctl.deferred.length); i++) {
      if (ctl.deferred.length) ctl.deferred.shift()();
      await sleep(30);
    }
    console.log('\n[two removals queued behind a save still out]');
    const sent = cfgPuts(ctl).slice(n).map(q => q.body.lists.materials);
    // Sent as the lists stood at send time, both queued saves carried [] —
    // 2 -> 0 in one step, which the server refuses as a stale tab's wipe.
    assert('each reaches the server as its own step: 2, then 1, then 0',
      JSON.stringify(sent) === JSON.stringify([['ClearFrac', 'Calcium Chloride'], ['Calcium Chloride'], []]),
      JSON.stringify(sent));
    // The server lets a save empty every list only when it names each list
    // still holding something — the last entry removed here, not one this
    // tab never saw.
    const named = cfgPuts(ctl).slice(n).map(q => q.body.lists_removed);
    assert('  the removals name the list they removed from', JSON.stringify(named)
      === JSON.stringify([[], ['materials'], ['materials']]), JSON.stringify(named));
    ctl.cfgPut = 'ok';
    await sleep(100);
    let m = cfgPuts(ctl).length;
    ev("removeListItem('employees', 'Pat Reilly')");
    await until(() => cfgPuts(ctl).length > m, 2000);
    const emp = cfgPuts(ctl)[m];
    assert('  an employee\'s removal names the labor rates too',
      emp && JSON.stringify([...(emp.body.lists_removed || [])].sort()) === JSON.stringify(['employee_rates', 'employees']),
      emp && JSON.stringify(emp.body.lists_removed));
    await sleep(200);
    m = cfgPuts(ctl).length;
    ev('saveLists()');
    await until(() => cfgPuts(ctl).length > m, 2000);
    const later = cfgPuts(ctl)[m];
    assert('  once the server has them, a later save names none', later && Array.isArray(later.body.lists_removed)
      && later.body.lists_removed.length === 0, later && JSON.stringify(later.body.lists_removed));
    dom.window.close();
  }

  // ── N. Other Billing and Product Cost: a failed first read is retried ─────
  {
    const ctl = makeCtl({ obGet: 500, pcGet: 500 });
    const { dom, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(300);
    console.log('\n[Other Billing and Product Cost, after a failed first read]');
    assert('neither loaded', ev('obLoaded') === false && ev('pcLoaded') === false);
    ctl.obGet = 'ok'; ctl.obMissing = true;   // and Other Billing has no blob yet: an empty book
    ctl.pcGet = 'ok';
    setVisibility('visible');                  // a returning tab polls at once
    await until(() => ev('obLoaded') && ev('pcLoaded'), 3000);
    assert('the poll loads Other Billing, a book with no blob yet as an empty one',
      ev('obLoaded') === true && ev('obRows.length') === 0);
    assert('  and Product Cost, which nothing read again before', ev('pcLoaded') === true
      && ev('pcRows.length') === PC_ROWS.length);
    dom.window.close();
  }

  // ── N2. …but never alongside the page's own first read ───────────────────
  {
    const ctl = makeCtl({ obGet: 'hold', pcGet: 'hold' });
    const { dom, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await until(() => ctl.held.length === 2, 2000);   // the first reads of both books, still out
    console.log('\n[a returning tab polls while the first reads of Other Billing and Product Cost are out]');
    setVisibility('visible');
    await sleep(300);
    const reads = k => ctl.log.filter(q => q.method === 'GET' && q.url.includes('/api/data/' + k)).length;
    assert('one read of each book is out, not two', reads(OB_KEY) === 1 && reads(PC_KEY) === 1,
      `${reads(OB_KEY)} / ${reads(PC_KEY)}`);
    ctl.held.splice(0, 2).forEach(go => go());        // the first reads land
    await until(() => ev('obLoaded') && ev('pcLoaded'), 2000);
    ev('obAddRow()');
    ev('pcAddRow()');
    const obAdded = ev('obRows[0].id'), pcAdded = ev('pcRows[0].id');
    ctl.held.splice(0).forEach(go => go());           // anything else still out lands after that
    await sleep(1500);                                // past the 900ms save debounce
    const lastPut = k => puts(ctl, new RegExp(k)).pop();
    const has = (w, id) => !!w && (w.body.value || []).some(r => r.id === id);
    assert('a row added once they loaded is still there, and saved',
      ev(`obRows.some(r => r.id === '${obAdded}')`) && ev(`pcRows.some(r => r.id === '${pcAdded}')`)
        && has(lastPut(OB_KEY), obAdded) && has(lastPut(PC_KEY), pcAdded),
      `${ev('obRows.length')} / ${ev('pcRows.length')}`);
    dom.window.close();
  }

  // ── O. The poller refreshes the profit margin ─────────────────────────────
  {
    const BLANK_PM = { base_gal: null, base_rate: null, soap_gal: null, soap_rate: null, water_gal: null,
                       water_rate: null, mix_parts: null, charge_basis: 'invoice', charge: null };
    const ctl = makeCtl({ storedPm: BLANK_PM });
    const { dom, doc, ev, setVisibility } = await boot(ctl);
    await until(() => ev('dustConfigLoaded') && ev('dustLoaded'));
    await sleep(400);
    console.log('\n[a tab that loaded the blank margin, then the margin is restored]');
    assert('loaded blank', ev('profitMargin.base_gal') === null);
    ctl.storedPm = PM;   // recovery.sql — or another tab — sets it
    const poll = async () => { ev('_configChangedAt = 0'); setVisibility('visible'); await sleep(400); };
    await poll();
    assert('the poll takes it up', ev('profitMargin.base_gal') === 275 && ev('profitMargin.charge_basis') === 'ub'
      && doc.getElementById('pm-base-gal').value === '275');
    const actualOn = [...doc.querySelectorAll('#an-actual .pm-pill.active')].map(p => p.dataset.basis);
    assert('  and leaves the Actual Profit Margin toggle as it was', JSON.stringify(actualOn) === JSON.stringify([ev('apmBasis')]),
      `${JSON.stringify(actualOn)} vs ${ev('apmBasis')}`);
    let n = cfgPuts(ctl).length;
    ev("set(rows.findIndex(r => r.id === 'r-veh'), 'inv_number', 'INV-5')");
    await until(() => cfgPuts(ctl).length > n, 3000);
    const p = cfgPuts(ctl)[n];
    assert('  so the next row edit carries it, not the blank one back over it',
      p && p.body.settings.profit_margin.base_gal === 275, p && JSON.stringify(p.body.settings.profit_margin));
    await sleep(300);

    console.log('\n[…but not over a margin edit the server never took]');
    ctl.cfgPut = 500;
    doc.getElementById('pm-base-gal').value = '300';
    ev('pmOnInput()');
    await sleep(1000);
    await until(() => ev('_configPutInFlight') === 0 && ev('pmSaveTimer') === null, 5000);
    ctl.cfgPut = 'ok';
    ctl.storedPm = { ...PM, base_gal: 280 };
    await poll();
    assert('the unsaved 300 stays', ev('profitMargin.base_gal') === 300, String(ev('profitMargin.base_gal')));
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
